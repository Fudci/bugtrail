import { isBusy, type RawDb } from "@bugtool/db";
import type { Symbolicator } from "../sourcemaps/symbolicate.js";
import { persistBatch, type BatchResult, type IngestJob, type QueuedJob } from "./persist.js";

export interface StoreOptions {
  /** Event yang belum diproses di disk. Lebih dari ini -> ingest dibalas 429. */
  maxBacklog: number;
  /** Event per transaksi pemrosesan. */
  batchSize: number;
  /** Jeda maksimum mengumpulkan request sebelum ditulis bersama (group commit). */
  flushIntervalMs?: number;
  symbolicator?: Symbolicator;
  onBatch?: (r: BatchResult) => void;
  log?: (msg: string, err?: unknown) => void;
}

export class BacklogFullError extends Error {}

type Pending = { jobs: IngestJob[]; resolve: () => void; reject: (e: unknown) => void };

const STORAGE_CODES = new Set(["SQLITE_FULL", "SQLITE_IOERR", "SQLITE_CANTOPEN", "SQLITE_READONLY", "SQLITE_CORRUPT"]);
const isStorageError = (err: unknown) => {
  const code = (err as { code?: string } | null)?.code ?? "";
  return [...STORAGE_CODES].some((c) => code.startsWith(c));
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Antrian ingest yang tahan crash, disimpan di tabel ingest_queue (SQLite).
 *
 * enqueue(): request dikumpulkan beberapa ms lalu ditulis dalam satu transaksi (group commit);
 *            promise baru resolve SETELAH data ada di disk → aman membalas 200 ke SDK.
 * loop:      ambil batch berurutan dari antrian, simpan issue/event + hapus baris antrian
 *            dalam satu transaksi (persistBatch). Crash di mana pun → tidak ada event hilang.
 */
export class IngestStore {
  private pending: Pending[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private busy = false;
  backlog: number;
  accepted = 0;
  processed = 0;
  failed = 0;

  private insert;
  private select;
  private dropOne;
  /** Setelah error data: proses satu per satu sampai baris bermasalah ketemu. */
  private isolate = 0;

  constructor(private db: RawDb, private opts: StoreOptions) {
    this.insert = db.prepare("INSERT INTO ingest_queue (project_id, received_at, payload) VALUES (?, ?, ?)");
    this.select = db.prepare<[number], { id: number; project_id: string; received_at: string; payload: string }>(
      "SELECT id, project_id, received_at, payload FROM ingest_queue ORDER BY id LIMIT ?",
    );
    this.dropOne = db.prepare("DELETE FROM ingest_queue WHERE id = ?");
    // Sisa antrian dari run sebelumnya (mis. setelah crash) ikut diproses.
    this.backlog = db.prepare("SELECT COUNT(*) FROM ingest_queue").pluck().get() as number;
  }

  get size() {
    return this.backlog + this.pending.reduce((n, p) => n + p.jobs.length, 0);
  }

  /** Resolve setelah tersimpan di disk. Reject BacklogFullError kalau antrian penuh. */
  enqueue(jobs: IngestJob[]): Promise<void> {
    if (this.stopping) return Promise.reject(new BacklogFullError("shutting down"));
    if (this.size + jobs.length > this.opts.maxBacklog) return Promise.reject(new BacklogFullError("backlog full"));
    return new Promise((resolve, reject) => {
      this.pending.push({ jobs, resolve, reject });
      this.flushTimer ??= setTimeout(() => void this.flush(), this.opts.flushIntervalMs ?? 2);
    });
  }

  private async flush() {
    this.flushTimer = null;
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return;
    const write = this.db.transaction(() => {
      for (const p of batch) for (const j of p.jobs) this.insert.run(j.projectId, j.receivedAt, JSON.stringify(j.payload));
    });
    for (let attempt = 0; ; attempt++) {
      try {
        write();
        break;
      } catch (err) {
        // Lock dipegang transaksi Prisma (dashboard) → coba lagi tanpa memblokir event loop.
        if (isBusy(err) && attempt < 500) {
          await sleep(2);
          continue;
        }
        for (const p of batch) p.reject(err);
        return;
      }
    }
    const n = batch.reduce((s, p) => s + p.jobs.length, 0);
    this.backlog += n;
    this.accepted += n;
    for (const p of batch) p.resolve();
    this.wake?.();
  }

  start() {
    this.running ??= this.loop();
  }

  /** Berhenti dengan rapi: tulis request yang sedang dikumpulkan. Sisa antrian aman di disk. */
  async stop() {
    this.stopping = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await this.flush();
    this.wake?.();
    await this.running;
  }

  /** Tunggu antrian di disk habis diproses (dipakai test). */
  async drain() {
    while (this.size > 0 || this.busy) await sleep(5);
  }

  private async loop() {
    while (!this.stopping) {
      const limit = this.isolate > 0 ? 1 : this.opts.batchSize;
      const rows = this.backlog > 0 ? this.select.all(limit) : [];
      if (rows.length === 0) {
        this.backlog = 0;
        await new Promise<void>((r) => (this.wake = r));
        this.wake = null;
        continue;
      }
      this.busy = true;
      const jobs: QueuedJob[] = rows.map((r) => ({
        queueId: r.id,
        projectId: r.project_id,
        receivedAt: r.received_at,
        payload: JSON.parse(r.payload) as Record<string, unknown>,
      }));
      try {
        const res = persistBatch(this.db, jobs, this.opts.symbolicator);
        this.backlog = Math.max(0, this.backlog - rows.length);
        this.processed += res.created;
        if (this.isolate > 0) this.isolate--;
        this.opts.onBatch?.(res);
      } catch (err) {
        if (isBusy(err)) {
          await sleep(2);
        } else if (isStorageError(err)) {
          // Disk penuh / I/O: event tetap di antrian, coba lagi nanti. Jangan dibuang.
          this.failed++;
          this.opts.log?.(`ingest storage error, retrying in 5s`, err);
          await sleep(5000);
        } else if (rows.length > 1) {
          // Error data di salah satu event: pecah batch untuk menemukan yang bermasalah.
          this.isolate = rows.length;
        } else {
          // Satu event yang selalu gagal (mis. project-nya sudah dihapus): buang supaya antrian jalan.
          this.dropOne.run(rows[0]!.id);
          this.backlog = Math.max(0, this.backlog - 1);
          this.failed++;
          if (this.isolate > 0) this.isolate--;
          this.opts.log?.(`dropped unprocessable event (queue id ${rows[0]!.id})`, err);
        }
      } finally {
        this.busy = false;
      }
      // Beri giliran ke request HTTP di antara batch.
      await new Promise((r) => setImmediate(r));
    }
  }
}
