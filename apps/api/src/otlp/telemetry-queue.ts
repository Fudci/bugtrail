import { isBusy, type RawDb } from "@bugtool/db";
import type { StoredSpan } from "./telemetry-store.js";

// Mode Scale: span (span_queue) dan log (log_queue) ditulis ke antrian di disk (SQLite) sebelum OTLP dibalas 200,
// lalu proses latar memindahkannya per batch ke penyimpanan (ClickHouse). Kalau ClickHouse mati, data menunggu di
// antrian dan dicoba lagi; kalau antrian penuh, penerima membalas 429 dan exporter mengirim ulang.
// Kolom span_count = jumlah item per baris (span atau log); nama kolom dipertahankan dari versi awal.
export class QueueFullError extends Error {}

export interface TelemetryQueueOptions {
  /** Tabel antrian (kolom id, span_count, payload); default span_queue. log_queue memakai kelas yang sama. */
  table?: "span_queue" | "log_queue";
  /** Nama item di pesan log ("spans" / "logs"). */
  label?: string;
  maxSpans?: number;       // batas span yang menunggu di disk
  batchSpans?: number;     // target span per insert ke penyimpanan
  retryMs?: number;        // jeda sebelum mencoba lagi kalau penyimpanan gagal
  log?: (msg: string, err?: unknown) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Penyimpanan menerima request tapi menolak isinya (mis. error parse dari ClickHouse membawa `type`/`code`),
// berbeda dengan gagal koneksi/timeout yang harus dicoba lagi.
export const isRejected = (err: unknown) =>
  typeof err === "object" && err !== null && ("rejected" in err || (typeof (err as { type?: unknown }).type === "string" && !/TIMEOUT|NETWORK|MEMORY|TOO_MANY/i.test((err as { type: string }).type)));

/** Tujuan antrian: TelemetryStore (span) atau LogStore (log). */
export interface QueueSink<T> {
  writeSpans?(items: T[]): void | Promise<void>;
  writeLogs?(items: T[]): void | Promise<void>;
  encodeSpans?(items: T[]): string;
  writeEncoded?(encoded: string): Promise<void>;
}

export class TelemetryQueue<T = StoredSpan> {
  private insert;
  private select;
  private remove;
  private backlog: number;
  private stopping = false;
  private running: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private busy = false;
  failures = 0;
  written = 0;
  dropped = 0;
  private isolate = 0; // > 0: proses satu baris per batch untuk menemukan baris yang ditolak

  constructor(db: RawDb, private store: QueueSink<T>, private opts: TelemetryQueueOptions = {}) {
    const table = opts.table ?? "span_queue"; // nilai tetap (union), bukan input user
    this.insert = db.prepare(`INSERT INTO ${table} (span_count, payload) VALUES (?, ?)`);
    this.select = db.prepare(`SELECT id, span_count, payload FROM ${table} ORDER BY id LIMIT ?`);
    this.remove = db.prepare(`DELETE FROM ${table} WHERE id <= ?`);
    this.backlog = Number(db.prepare(`SELECT COALESCE(SUM(span_count), 0) FROM ${table}`).pluck().get());
  }

  /** Span yang masih menunggu di disk. */
  get size() {
    return this.backlog;
  }

  /** Tulis span ke disk (sinkron). Lempar QueueFullError kalau antrian penuh. */
  enqueue(spans: T[]) {
    if (!spans.length) return;
    if (this.backlog + spans.length > (this.opts.maxSpans ?? 2_000_000)) throw new QueueFullError(`${this.opts.label ?? "spans"} queue full`);
    for (let attempt = 0; ; attempt++) {
      try {
        // Kalau penyimpanan bisa, simpan langsung dalam format tulisnya (lihat TelemetryStore.encodeSpans).
        this.insert.run(spans.length, this.store.encodeSpans ? this.store.encodeSpans(spans) : JSON.stringify(spans));
        break;
      } catch (err) {
        if (!isBusy(err) || attempt > 200) throw err;
      }
    }
    this.backlog += spans.length;
    this.wake?.();
  }

  start() {
    this.running ??= this.loop();
  }

  async stop() {
    this.stopping = true;
    this.wake?.();
    await this.running;
  }

  /** Tunggu antrian kosong (dipakai test). */
  async drain() {
    while (this.backlog > 0 || this.busy) await sleep(5);
  }

  private async loop() {
    // Batch sedang + jeda antar batch: event loop tetap melayani request HTTP saat antrian panjang.
    const target = this.opts.batchSpans ?? 5_000;
    while (!this.stopping) {
      // Ambil beberapa baris sampai sekitar `target` span (satu baris = satu request OTLP).
      const limit = this.isolate > 0 ? 1 : Math.max(1, Math.ceil(target / 50));
      const rows = this.backlog > 0 ? (this.select.all(limit) as { id: number; span_count: number; payload: string }[]) : [];
      if (!rows.length) {
        this.backlog = 0;
        await new Promise<void>((r) => (this.wake = r));
        this.wake = null;
        continue;
      }
      this.busy = true;
      try {
        if (this.store.writeEncoded && this.store.encodeSpans) await this.store.writeEncoded(rows.map((r) => r.payload).join(""));
        else {
          const items = rows.flatMap((r) => JSON.parse(r.payload) as T[]);
          await (this.store.writeSpans ? this.store.writeSpans(items) : this.store.writeLogs?.(items));
        }
        // Hapus dari antrian hanya setelah penyimpanan menerima batch (at-least-once).
        this.remove.run(rows.at(-1)!.id);
        const n = rows.reduce((s, r) => s + r.span_count, 0);
        this.backlog = Math.max(0, this.backlog - n);
        this.written += n;
        if (this.isolate > 0) this.isolate--;
      } catch (err) {
        this.failures++;
        if (!isRejected(err)) {
          // Koneksi/timeout: penyimpanan sedang tidak bisa dijangkau. Data tetap di disk, coba lagi nanti.
          this.opts.log?.(`${this.opts.label ?? "spans"} write failed, retrying in ${(this.opts.retryMs ?? 5000) / 1000}s`, err);
          await sleep(this.opts.retryMs ?? 5000);
        } else if (rows.length > 1) {
          // Penyimpanan menolak isi batch: pecah supaya baris yang bermasalah ketemu, sisanya tetap terkirim.
          this.isolate = rows.length;
        } else {
          // Satu baris yang selalu ditolak: buang supaya antrian tidak tersumbat.
          this.remove.run(rows[0]!.id);
          this.backlog = Math.max(0, this.backlog - rows[0]!.span_count);
          this.dropped += rows[0]!.span_count;
          if (this.isolate > 0) this.isolate--;
          this.opts.log?.(`dropped ${rows[0]!.span_count} ${this.opts.label ?? "spans"} rejected by the store (queue id ${rows[0]!.id})`, err);
        }
      } finally {
        this.busy = false;
      }
      await new Promise((r) => setImmediate(r));
    }
  }
}
