import type { FlatSpan } from "./convert.js";
import type { StoredSpan } from "./telemetry-store.js";

// Span satu trace datang dalam beberapa batch (exporter mengirim per interval). Hanya trace yang
// berisi error (atau lambat) yang disimpan, jadi span ditahan sebentar di memori:
//  - trace yang sudah ketahuan error: span langsung disimpan (termasuk yang datang belakangan);
//  - trace lain: ditahan maksimal HOLD_MS, lalu dibuang kalau tidak ada error.
// Memori dibatasi MAX_SPANS; kalau penuh, trace tertua dibuang duluan.
export interface BufferOptions {
  holdMs?: number;
  keepMs?: number;
  maxSpans?: number;
}

export class SpanBuffer {
  private held = new Map<string, { at: number; spans: StoredSpan[] }>(); // key project:trace, urutan = umur
  private keep = new Map<string, number>(); // trace yang berisi error -> kedaluwarsa
  private count = 0;
  private holdMs: number;
  private keepMs: number;
  private maxSpans: number;

  constructor(opts: BufferOptions = {}) {
    this.holdMs = opts.holdMs ?? 30_000;
    this.keepMs = opts.keepMs ?? 120_000;
    this.maxSpans = opts.maxSpans ?? 20_000;
  }

  get size() {
    return this.count;
  }

  // Masukkan span; kembalikan span yang harus disimpan sekarang.
  add(projectId: string, spans: FlatSpan[], isError: (s: FlatSpan) => boolean, now = Date.now()): StoredSpan[] {
    this.expire(now);
    const out: StoredSpan[] = [];
    for (const s of spans) {
      const key = `${projectId}:${s.traceId}`;
      const span: StoredSpan = { ...s, projectId };
      if (isError(s) && !this.keep.has(key)) {
        this.keep.set(key, now + this.keepMs);
        const held = this.held.get(key);
        if (held) {
          out.push(...held.spans);
          this.count -= held.spans.length;
          this.held.delete(key);
        }
      }
      if (this.keep.has(key)) {
        out.push(span);
        continue;
      }
      let h = this.held.get(key);
      if (!h) this.held.set(key, (h = { at: now, spans: [] }));
      h.spans.push(span);
      this.count++;
    }
    while (this.count > this.maxSpans) this.dropOldest();
    return out;
  }

  private expire(now: number) {
    for (const [key, h] of this.held) {
      if (now - h.at < this.holdMs) break; // Map berurutan sesuai waktu masuk
      this.held.delete(key);
      this.count -= h.spans.length;
    }
    for (const [key, until] of this.keep) if (until <= now) this.keep.delete(key);
  }

  private dropOldest() {
    const first = this.held.keys().next();
    if (first.done) return;
    this.count -= this.held.get(first.value)!.spans.length;
    this.held.delete(first.value);
  }
}

// Satu error bisa terekam di beberapa span dalam satu trace (instrumentasi Express merekam di span
// middleware dan handler, lalu error handler aplikasi merekam lagi). Hitung sekali per trace.
export class ExceptionDedupe {
  private seen = new Map<string, number>();

  constructor(private ttlMs = 120_000, private max = 50_000) {}

  firstTime(key: string, now = Date.now()): boolean {
    for (const [k, until] of this.seen) {
      if (until > now && this.seen.size <= this.max) break; // Map berurutan sesuai waktu masuk
      this.seen.delete(k);
    }
    if (this.seen.has(key)) return false;
    this.seen.set(key, now + this.ttlMs);
    return true;
  }
}

// Batas trace yang disimpan per issue (fingerprint) per jam. Error tetap dihitung semua; yang dibatasi
// hanya trace detail untuk tab Trace, supaya bug yang terjadi ribuan kali tidak memenuhi disk.
// Penghitung ada di memori (reset saat restart).
export class TraceQuota {
  private hour = -1;
  private counts = new Map<string, number>();
  private allowed = new Map<string, number>(); // trace yang sudah diizinkan -> kedaluwarsa

  constructor(private perHour = 20, private keepMs = 120_000) {}

  // true kalau trace ini boleh disimpan. Trace yang sudah diizinkan tetap diizinkan (span susulan).
  allow(group: string, traceKey: string, now = Date.now()): boolean {
    const h = Math.floor(now / 3_600_000);
    if (h !== this.hour) {
      this.hour = h;
      this.counts.clear();
    }
    for (const [k, until] of this.allowed) {
      if (until > now) break;
      this.allowed.delete(k);
    }
    if (this.allowed.has(traceKey)) return true;
    const n = this.counts.get(group) ?? 0;
    if (n >= this.perHour) return false;
    this.counts.set(group, n + 1);
    this.allowed.set(traceKey, now + this.keepMs);
    return true;
  }
}
