import type { PrismaClient } from "@bugtool/db";
import { keyCache } from "../ingest/key-cache.js";
import type { IngestJob } from "../process/persist.js";
import type { QuotaMeter } from "../process/quota.js";
import { BacklogFullError, type IngestStore } from "../process/store.js";
import { ExceptionDedupe, TraceQuota, type SpanBuffer } from "./buffer.js";
import { computeFingerprint, normalizeEvent } from "../process/normalize.js";
import { exceptionEvents, hasException, type FlatSpan } from "./convert.js";
import { QueueFullError, type TelemetryQueue } from "./telemetry-queue.js";
import { endpointKey, type RollupAggregator } from "./rollups.js";
import type { ServiceGraph } from "./service-graph.js";
import { slowTraceMs } from "./slow-config.js";
import type { TelemetryStore } from "./telemetry-store.js";

// Logika ingest trace OTLP, dipakai bersama oleh OTLP/HTTP (route.ts) dan OTLP/gRPC (grpc.ts).
// Exception di span -> event error di pipeline ingest yang sama dengan Sentry SDK.
// Mode Lite: span dari trace error dan trace lambat (dalam kuota) disimpan untuk tampilan trace; trace lain tidak.

export interface TraceIngestDeps {
  prisma: PrismaClient;
  store: IngestStore;
  telemetry: TelemetryStore;
  buffer: SpanBuffer;
  tracesPerIssueHour?: number | undefined;
  /** Mode Lite: batas trace lambat yang disimpan per endpoint per jam. */
  slowTracesPerEndpointHour?: number | undefined;
  /** Mode Scale: semua span lewat antrian di disk ke penyimpanan (ClickHouse). */
  spanQueue?: TelemetryQueue | undefined;
  /** API Health: rollup request per endpoint. */
  rollups?: RollupAggregator | undefined;
  /** Service map: rollup per service dan panggilan antar service. */
  services?: ServiceGraph | undefined;
  /** Kuota span per project per menit. */
  quota?: QuotaMeter | undefined;
  log: { error: (err: unknown, msg: string) => void };
}

/** Hasil ingest dalam istilah HTTP; transport lain (gRPC) memetakan sendiri. */
export type IngestResult = { ok: true } | { ok: false; status: 401 | 403 | 429 | 503; message: string; retryAfter?: number };

/** Key dari header x-bugtrail-key atau Authorization: Bearer (HTTP header atau metadata gRPC). */
export function publicKeyOf(bugtrailKey: unknown, authorization: unknown): string | undefined {
  const k = typeof bugtrailKey === "string" ? bugtrailKey.trim() : "";
  if (k) return k;
  return typeof authorization === "string" && /^bearer\s+/i.test(authorization) ? authorization.replace(/^bearer\s+/i, "").trim() || undefined : undefined;
}

export function createTraceIngest(deps: TraceIngestDeps) {
  const { prisma, store, telemetry, buffer, spanQueue, rollups, services, quota: projectQuota, log } = deps;
  const dedupe = new ExceptionDedupe();
  const quota = new TraceQuota(deps.tracesPerIssueHour ?? 20);
  const slowQuota = new TraceQuota(deps.slowTracesPerEndpointHour ?? 10);

  async function projectForKey(publicKey: string): Promise<string | null> {
    const k = `otlp:${publicKey}`;
    const hit = keyCache.get(k);
    if (hit !== undefined) return hit;
    const key = await prisma.dsnKey.findFirst({ where: { publicKey, revokedAt: null }, select: { projectId: true } });
    keyCache.set(k, key?.projectId ?? null);
    return key?.projectId ?? null;
  }

  async function ingest(projectId: string, spans: FlatSpan[]): Promise<IngestResult> {
    // Kuota span per menit: request ditolak utuh (tidak diterima sebagian), exporter mengirim ulang
    // setelah Retry-After. Tidak masuk rollup API Health karena keluar sebelum rollups.add.
    const q = projectQuota?.consume(projectId, "spans", spans.length);
    if (q && !q.ok) return { ok: false, status: 429, message: "project quota exceeded", retryAfter: q.retryAfter };

    // Mode Scale: simpan SEMUA span dulu (sebelum error), supaya retry exporter tidak menggandakan issue
    // (error dari trace yang sama sudah di-dedupe) dan span tidak hilang kalau langkah berikutnya gagal.
    if (spanQueue) {
      try {
        spanQueue.enqueue(spans.map((s) => ({ ...s, projectId })));
      } catch (err) {
        projectQuota?.refund(projectId, "spans", spans.length);
        if (err instanceof QueueFullError) return { ok: false, status: 429, message: "span queue full", retryAfter: 10 };
        log.error(err, "otlp span enqueue failed");
        return { ok: false, status: 503, message: "storage unavailable", retryAfter: 10 };
      }
    }

    const receivedAt = new Date().toISOString();
    const servers = new Map(spans.filter((s) => s.kind === 2).map((s) => [s.traceId, s]));
    const jobs: IngestJob[] = [];
    const keepTraces = new Set<string>(); // trace error yang masih dalam kuota penyimpanan
    const now = new Date();
    for (const s of spans) {
      if (!hasException(s)) continue;
      for (const payload of exceptionEvents(s, servers.get(s.traceId))) {
        const v = (payload["exception"] as { values: { type?: string; value?: string }[] }).values[0]!;
        if (dedupe.firstTime(`${projectId}:${s.traceId}:${v.type}:${v.value}`)) jobs.push({ projectId, receivedAt, payload });
        // Kuota per issue: fingerprint sama dengan yang dipakai pipeline untuk mengelompokkan issue.
        const group = `${projectId}:${computeFingerprint(normalizeEvent(payload, now))}`;
        if (quota.allow(group, `${projectId}:${s.traceId}`)) keepTraces.add(s.traceId);
      }
    }
    // Status ERROR tanpa exception (mis. span server dari request yang gagal): kuota per nama span,
    // hanya untuk trace tanpa exception: trace dengan exception diatur kuota issue-nya saja.
    const withException = new Set(spans.filter(hasException).map((s) => s.traceId));
    for (const s of spans) {
      if (s.statusCode !== 2 || withException.has(s.traceId)) continue;
      if (quota.allow(`${projectId}:status:${s.name}`, `${projectId}:${s.traceId}`)) keepTraces.add(s.traceId);
    }
    // Mode Lite: trace lambat (span server >= slow_trace_ms) juga disimpan, kuota terpisah per endpoint per jam.
    // Trace yang sudah disimpan karena error tidak memakai kuota lambat.
    if (!spanQueue) {
      const slowMs = await slowTraceMs(prisma, projectId);
      if (slowMs != null) {
        const failed = new Set(spans.filter((s) => s.statusCode === 2).map((s) => s.traceId));
        for (const s of spans) {
          if (s.kind !== 2 || s.durationUs < slowMs * 1000) continue;
          if (keepTraces.has(s.traceId) || withException.has(s.traceId) || failed.has(s.traceId)) continue;
          const e = endpointKey(s);
          const ep = e ? `${e.method} ${e.route}` : s.name;
          if (slowQuota.allow(`${projectId}:slow:${ep}`, `${projectId}:${s.traceId}`)) keepTraces.add(s.traceId);
        }
      }
    }
    if (jobs.length) {
      try {
        await store.enqueue(jobs);
      } catch (err) {
        projectQuota?.refund(projectId, "spans", spans.length);
        // 429/503 boleh di-retry oleh exporter OTLP (spec), lengkap dengan Retry-After.
        if (err instanceof BacklogFullError) return { ok: false, status: 429, message: "server busy", retryAfter: 5 };
        log.error(err, "otlp enqueue failed");
        return { ok: false, status: 503, message: "storage unavailable", retryAfter: 10 };
      }
    }
    // API Health: semua request server dihitung, termasuk yang sukses (sebelum span disaring).
    // Hanya di jalur sukses: respons 429/503 akan di-retry exporter, jadi tidak boleh terhitung dua kali.
    rollups?.add(projectId, spans);
    services?.add(projectId, spans);
    projectQuota?.recordSpans(projectId, spans.length);
    try {
      // Mode Lite: hanya trace yang berisi error (dalam kuota) yang disimpan, langsung ke SQLite.
      if (!spanQueue) await telemetry.writeSpans(buffer.add(projectId, spans, (s) => keepTraces.has(s.traceId)));
    } catch (err) {
      // Error sudah aman di antrian; gagal simpan span hanya mengurangi tampilan trace.
      log.error(err, "otlp span write failed");
    }
    return { ok: true };
  }

  return { projectForKey, ingest };
}

export type TraceIngest = ReturnType<typeof createTraceIngest>;
