import { isBusy, type RawDb } from "@bugtool/db";
import type { FlatSpan } from "./convert.js";

// API Health: ringkasan request per (service, endpoint) per menit, dari span server OTLP (kind 2).
export const BOUNDS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
export const BUCKETS = BOUNDS_MS.length + 1;

const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Kunci endpoint + status HTTP; null kalau span bukan request server HTTP. */
export function endpointKey(s: FlatSpan): { method: string; route: string; status: number } | null {
  if (s.kind !== 2) return null;
  const a = s.attributes;
  const status = Number(a["http.response.status_code"] ?? a["http.status_code"]);
  if (!Number.isInteger(status) || status < 100 || status > 599) return null;
  const method = (text(a["http.request.method"]) ?? text(a["http.method"]) ?? "*").toUpperCase().slice(0, 16);
  const route = (text(a["http.route"]) ?? s.name).slice(0, 300);
  return { method, route, status };
}

export function bucketIndex(durationUs: number): number {
  const ms = durationUs / 1000;
  const i = BOUNDS_MS.findIndex((b) => ms <= b);
  return i === -1 ? BOUNDS_MS.length : i;
}

/** Perkiraan persentil (ms) = batas atas bucket yang memuat peringkat ke-q. */
export function percentile(hist: number[], q: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const rank = Math.ceil(q * total);
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i]!;
    if (acc >= rank) return BOUNDS_MS[i] ?? Infinity;
  }
  return Infinity;
}

interface Acc { count: number; c2xx: number; c4xx: number; c5xx: number; sum: number; max: number; h: number[] }
const H = Array.from({ length: BUCKETS }, (_, i) => `h${i}`);

/**
 * Kumpulkan span server di memori per (project, menit, endpoint), tulis ke SQLite tiap beberapa detik.
 * Best effort: kalau proses mati, paling banyak satu interval hilang. Tidak pernah throw ke pemanggil.
 */
export class RollupAggregator {
  private acc = new Map<string, Acc>();
  /** Jumlah per kode status, kunci JSON [project, bucket, service, method, route, status]. */
  private statuses = new Map<string, number>();
  private known = new Map<string, { set: Set<string>; at: number }>();
  private timer: NodeJS.Timeout | null = null;
  private failedOnce = false;
  private upsert;
  private upsertStatus;
  private loadKnown;
  private maxEndpoints: number;

  constructor(private db: RawDb, private opts: { maxEndpoints?: number; log?: (m: string, e?: unknown) => void } = {}) {
    this.maxEndpoints = opts.maxEndpoints ?? 500;
    this.upsert = db.prepare(`INSERT INTO endpoint_rollups (project_id, granularity, bucket, service, method, route,
        count, c2xx, c4xx, c5xx, dur_sum_us, dur_max_us, ${H.join(", ")})
      VALUES (?, 'm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${H.map(() => "?").join(", ")})
      ON CONFLICT (project_id, granularity, bucket, service, method, route) DO UPDATE SET
        count = count + excluded.count, c2xx = c2xx + excluded.c2xx, c4xx = c4xx + excluded.c4xx, c5xx = c5xx + excluded.c5xx,
        dur_sum_us = dur_sum_us + excluded.dur_sum_us, dur_max_us = max(dur_max_us, excluded.dur_max_us),
        ${H.map((h) => `${h} = ${h} + excluded.${h}`).join(", ")}`);
    this.upsertStatus = db.prepare(`INSERT INTO endpoint_status_rollups (project_id, bucket, service, method, route, status, count)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, bucket, service, method, route, status) DO UPDATE SET count = count + excluded.count`);
    this.loadKnown = db.prepare("SELECT DISTINCT service || char(0) || method || ' ' || route FROM endpoint_rollups WHERE project_id = ?").pluck();
  }

  private endpoints(projectId: string, nowMs: number) {
    let k = this.known.get(projectId);
    if (!k || nowMs - k.at > 3_600_000) {
      k = { set: new Set(this.loadKnown.all(projectId) as string[]), at: nowMs };
      this.known.set(projectId, k);
    }
    return k.set;
  }

  add(projectId: string, spans: FlatSpan[], nowMs = Date.now()) {
    try {
      for (const s of spans) {
        const e = endpointKey(s);
        if (!e) continue;
        const seen = this.endpoints(projectId, nowMs);
        let { method, route } = e;
        // Batas endpoint per project dihitung per (service, endpoint); kelebihan digabung ke "(other)" tanpa service.
        let service = (s.service ?? "").slice(0, 200);
        const ep = `${service}\0${method} ${route}`;
        if (!seen.has(ep)) {
          if (seen.size >= this.maxEndpoints) { method = "*"; route = "(other)"; service = ""; }
          else seen.add(ep);
        }
        // Menit dihitung dari waktu terima, sama seperti retensi span (bukan jam klien yang bisa meleset).
        const bucket = Math.floor(nowMs / 60_000) * 60;
        const key = JSON.stringify([projectId, bucket, service, method, route]);
        let a = this.acc.get(key);
        if (!a) this.acc.set(key, (a = { count: 0, c2xx: 0, c4xx: 0, c5xx: 0, sum: 0, max: 0, h: Array(BUCKETS).fill(0) }));
        a.count++;
        if (e.status >= 500) a.c5xx++; else if (e.status >= 400) a.c4xx++; else if (e.status >= 200 && e.status < 300) a.c2xx++;
        a.sum += s.durationUs;
        a.max = Math.max(a.max, s.durationUs);
        a.h[bucketIndex(s.durationUs)]!++;
        // Per kode status untuk aturan alert (mis. 403); hanya per menit, dihapus retensi setelah beberapa jam.
        const sk = JSON.stringify([projectId, bucket, service, method, route, e.status]);
        this.statuses.set(sk, (this.statuses.get(sk) ?? 0) + 1);
      }
    } catch (err) {
      this.opts.log?.("rollup add failed", err);
    }
  }

  /** Tulis semua akumulasi. Return jumlah baris. Gagal: simpan untuk satu percobaan lagi, lalu buang. */
  flush(): number {
    if (this.acc.size === 0 && this.statuses.size === 0) return 0;
    const batch = this.acc;
    const statuses = this.statuses;
    this.acc = new Map();
    this.statuses = new Map();
    try {
      this.db.transaction(() => {
        for (const [key, a] of batch) {
          const [pid, bucket, service, method, route] = JSON.parse(key) as [string, number, string, string, string];
          this.upsert.run(pid, bucket, service, method, route, a.count, a.c2xx, a.c4xx, a.c5xx, a.sum, a.max, ...a.h);
        }
        for (const [key, n] of statuses) this.upsertStatus.run(...(JSON.parse(key) as [string, number, string, string, string, number]), n);
      })();
      this.failedOnce = false;
      return batch.size;
    } catch (err) {
      if (!isBusy(err)) this.opts.log?.("rollup flush failed", err);
      if (!this.failedOnce) {
        this.failedOnce = true;
        // Gabungkan dengan akumulasi baru untuk kunci yang sama, supaya tidak ada data yang hilang.
        for (const [k, a] of batch) {
          const b = this.acc.get(k);
          if (!b) { this.acc.set(k, a); continue; }
          b.count += a.count; b.c2xx += a.c2xx; b.c4xx += a.c4xx; b.c5xx += a.c5xx;
          b.sum += a.sum; b.max = Math.max(b.max, a.max);
          a.h.forEach((n, i) => (b.h[i]! += n));
        }
        for (const [k, n] of statuses) this.statuses.set(k, (this.statuses.get(k) ?? 0) + n);
      } else this.failedOnce = false;
      return 0;
    }
  }

  start(intervalMs = 10_000) {
    this.timer = setInterval(() => this.flush(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }
}
