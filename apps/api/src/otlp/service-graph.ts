import { isBusy, type RawDb } from "@bugtool/db";
import type { FlatSpan } from "./convert.js";
import { BUCKETS, bucketIndex } from "./rollups.js";

// Service map: rollup per service (peer '') dan per panggilan service -> peer, per menit (tabel service_rollups).
// Span server tujuan biasanya datang di request OTLP lain (diekspor service lain), jadi span client ditahan
// sebentar (PENDING_MS) menunggu span server dengan parentSpanId = spanId-nya. Kalau tidak datang,
// panggilan dicatat ke peer eksternal dari atribut (database, API pihak ketiga).

const PENDING_MS = 60_000;
const MAX_PENDING = 100_000;
const UNKNOWN = "(unknown)";

const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const httpStatus = (a: Record<string, unknown>) => Number(a["http.response.status_code"] ?? a["http.status_code"]) || 0;
/** Error = status span ERROR atau HTTP 5xx. */
export const isErrorSpan = (s: FlatSpan) => s.statusCode === 2 || httpStatus(s.attributes) >= 500;

/**
 * Nama tujuan dari atribut span client (semconv baru dan lama). Database dibedakan per nama database
 * (lalu per alamat server), mis. "mssql · MWS-PIS", supaya dua database sejenis tidak jadi satu node.
 */
export function externalPeer(s: FlatSpan): string {
  const a = s.attributes;
  const host = text(a["server.address"]) ?? text(a["net.peer.name"]);
  const db = text(a["db.system.name"]) ?? text(a["db.system"]);
  if (!text(a["peer.service"]) && db) {
    const which = text(a["db.namespace"]) ?? text(a["db.name"]) ?? host;
    return (which ? `${db} · ${which}` : db).slice(0, 200);
  }
  const p = text(a["peer.service"]) ?? text(a["messaging.system"]) ?? host ?? text(a["rpc.service"]);
  return (p ?? UNKNOWN).slice(0, 200);
}

/** Batas tujuan berbeda per project (nama database atau host dinamis tidak boleh membuat node tanpa batas). */
const MAX_PEERS = 200;
const OTHER_PEER = "(other)";

const serviceOf = (s: FlatSpan) => (s.service ?? UNKNOWN).slice(0, 200);
const isInbound = (s: FlatSpan) => s.kind === 2 || s.kind === 5; // SERVER, CONSUMER
// Span client yang bukan panggilan ke service lain: DNS lookup (instrumentation-dns) tidak punya tujuan
// dan akan muncul sebagai "(unknown)" di map.
const NOT_A_CALL = /^dns\./;
const isOutbound = (s: FlatSpan) => (s.kind === 3 || s.kind === 4) && !NOT_A_CALL.test(s.name); // CLIENT, PRODUCER

interface Acc { count: number; errors: number; sum: number; max: number; h: number[]; external: number }
interface PendingClient { projectId: string; service: string; peer: string; durationUs: number; error: boolean; bucket: number; at: number }
const H = Array.from({ length: BUCKETS }, (_, i) => `h${i}`);

export class ServiceGraph {
  private acc = new Map<string, Acc>();
  /** span client yang belum ketemu span server-nya, kunci `${projectId}\0${spanId}`. */
  private clients = new Map<string, PendingClient>();
  /** span server yang belum ketemu span client-nya, kunci `${projectId}\0${parentSpanId}` -> service. */
  private servers = new Map<string, { service: string; at: number }>();
  private failedOnce = false;
  /** Tujuan eksternal yang sudah terlihat per project (untuk MAX_PEERS); kosong lagi saat restart. */
  private peers = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | null = null;
  private upsert;

  constructor(private db: RawDb, private opts: { log?: (m: string, e?: unknown) => void } = {}) {
    this.upsert = db.prepare(`INSERT INTO service_rollups (project_id, granularity, bucket, service, peer, external,
        count, errors, dur_sum_us, dur_max_us, ${H.join(", ")})
      VALUES (?, 'm', ?, ?, ?, ?, ?, ?, ?, ?, ${H.map(() => "?").join(", ")})
      ON CONFLICT (project_id, granularity, bucket, service, peer) DO UPDATE SET
        external = min(external, excluded.external), count = count + excluded.count, errors = errors + excluded.errors,
        dur_sum_us = dur_sum_us + excluded.dur_sum_us, dur_max_us = max(dur_max_us, excluded.dur_max_us),
        ${H.map((h) => `${h} = ${h} + excluded.${h}`).join(", ")}`);
  }

  private record(projectId: string, bucket: number, service: string, peer: string, external: boolean, durationUs: number, error: boolean) {
    const key = JSON.stringify([projectId, bucket, service, peer]);
    let a = this.acc.get(key);
    if (!a) this.acc.set(key, (a = { count: 0, errors: 0, sum: 0, max: 0, h: Array(BUCKETS).fill(0), external: external ? 1 : 0 }));
    if (!external) a.external = 0;
    a.count++;
    if (error) a.errors++;
    a.sum += durationUs;
    a.max = Math.max(a.max, durationUs);
    a.h[bucketIndex(durationUs)]!++;
  }

  private recordCall(c: PendingClient, target: string | undefined) {
    let peer = target ?? c.peer;
    if (target === undefined) {
      let seen = this.peers.get(c.projectId);
      if (!seen) this.peers.set(c.projectId, (seen = new Set()));
      if (!seen.has(peer)) {
        if (seen.size >= MAX_PEERS) peer = OTHER_PEER;
        else seen.add(peer);
      }
    }
    this.record(c.projectId, c.bucket, c.service, peer, target === undefined, c.durationUs, c.error);
  }

  add(projectId: string, spans: FlatSpan[], nowMs = Date.now()) {
    try {
      // Menit dari waktu terima, sama dengan endpoint_rollups.
      const bucket = Math.floor(nowMs / 60_000) * 60;
      for (const s of spans) {
        const service = serviceOf(s);
        if (isInbound(s)) {
          this.record(projectId, bucket, service, "", false, s.durationUs, isErrorSpan(s));
          if (!s.parentSpanId) continue;
          const k = `${projectId}\0${s.parentSpanId}`;
          const c = this.clients.get(k);
          if (c) {
            this.clients.delete(k);
            if (c.service !== service) this.recordCall(c, service);
          } else if (this.servers.size < MAX_PENDING) this.servers.set(k, { service, at: nowMs });
        } else if (isOutbound(s)) {
          const c: PendingClient = { projectId, service, peer: externalPeer(s), durationUs: s.durationUs, error: isErrorSpan(s), bucket, at: nowMs };
          const k = `${projectId}\0${s.spanId}`;
          const srv = this.servers.get(k);
          if (srv) {
            this.servers.delete(k);
            // Panggilan ke diri sendiri (span client dan server di service yang sama) bukan edge.
            if (srv.service !== service) this.recordCall(c, srv.service);
          } else if (this.clients.size < MAX_PENDING) this.clients.set(k, c);
          else this.recordCall(c, undefined);
        }
      }
    } catch (err) {
      this.opts.log?.("service graph add failed", err);
    }
  }

  /** Span client yang menunggu lebih lama dari PENDING_MS dicatat ke peer eksternal. */
  expire(nowMs = Date.now(), all = false) {
    for (const [k, c] of this.clients) {
      if (!all && nowMs - c.at < PENDING_MS) break; // Map urut sisip = urut waktu
      this.clients.delete(k);
      this.recordCall(c, undefined);
    }
    for (const [k, s] of this.servers) {
      if (!all && nowMs - s.at < PENDING_MS) break;
      this.servers.delete(k);
    }
  }

  /** Tulis semua akumulasi; perilaku gagal sama dengan RollupAggregator.flush. */
  flush(nowMs = Date.now(), all = false): number {
    this.expire(nowMs, all);
    if (this.acc.size === 0) return 0;
    const batch = this.acc;
    this.acc = new Map();
    try {
      this.db.transaction(() => {
        for (const [key, a] of batch) {
          const [pid, bucket, service, peer] = JSON.parse(key) as [string, number, string, string];
          this.upsert.run(pid, bucket, service, peer, a.external, a.count, a.errors, a.sum, a.max, ...a.h);
        }
      })();
      this.failedOnce = false;
      return batch.size;
    } catch (err) {
      if (!isBusy(err)) this.opts.log?.("service graph flush failed", err);
      if (!this.failedOnce) {
        this.failedOnce = true;
        for (const [k, a] of batch) {
          const b = this.acc.get(k);
          if (!b) { this.acc.set(k, a); continue; }
          b.count += a.count; b.errors += a.errors; b.sum += a.sum; b.max = Math.max(b.max, a.max);
          b.external = Math.min(b.external, a.external);
          a.h.forEach((n, i) => (b.h[i]! += n));
        }
      } else this.failedOnce = false;
      return 0;
    }
  }

  start(intervalMs = 10_000) {
    this.timer = setInterval(() => this.flush(), intervalMs);
    this.timer.unref();
  }

  /** Saat shutdown: panggilan yang masih menunggu dicatat ke peer eksternal. */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush(Date.now(), true);
  }
}
