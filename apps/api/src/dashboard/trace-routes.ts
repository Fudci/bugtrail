import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@bugtool/db";
import { isSlow, slowTraceMs } from "../otlp/slow-config.js";
import { requireUser } from "../auth/session.js";
import { BODY_MAX, MAX_PAGE_OFFSET, traceView, type TelemetryStore, type TraceFilter } from "../otlp/telemetry-store.js";
import { OLD_PAGE_MESSAGE, pageQuery } from "./paging.js";
import { parseStatusFilter } from "../otlp/status-filter.js";
import { SEARCH_RANGES, projectIdFor, searchRange } from "./common.js";

// Pencarian trace per project + tampilan satu trace.

// `now` (ms epoch) bisa disuntik agar test deterministik; default Date.now.
export async function traceRoutes(app: FastifyInstance, { prisma, telemetry, now: clock = Date.now }: {
  prisma: PrismaClient; telemetry?: TelemetryStore | undefined; now?: (() => number) | undefined;
}) {
  app.addHook("preHandler", requireUser);
  const projectId = projectIdFor(prisma);


  // Jendela [now - range, now + 60 s] dalam mikrodetik; +60: toleransi jam klien sedikit di depan.
  const window = (r: keyof typeof SEARCH_RANGES) => {
    const nowUs = clock() * 1000;
    return { fromUs: Math.floor(nowUs - SEARCH_RANGES[r] * 1e6), toUs: Math.ceil(nowUs + 60e6) };
  };

  app.get("/projects/:id/traces", async (req, reply) => {
    const pid = await projectId(req, reply);
    if (!pid) return reply;
    const q = z.object({
      range: searchRange,
      service: z.string().min(1).max(200).optional(),
      q: z.string().max(200).optional(),
      status: z.string().max(300).default("all"),
      minMs: z.coerce.number().nonnegative().max(86_400_000).optional(),
      before: z.string().regex(/^\d{1,17}:[0-9a-f]{16}$/).optional(), // kursor "<startUs>:<spanId>"
      limit: z.coerce.number().int().min(1).max(200).default(50),
      ...pageQuery,
    }).safeParse(req.query);
    if (!q.success || (q.data.page && q.data.before)) return reply.code(400).send({ detail: "invalid query" });
    if (!parseStatusFilter(q.data.status, { allowError: true })) return reply.code(400).send({ detail: "invalid status filter" });
    const { range: r, service, q: text, status, minMs, before, page, size } = q.data;
    // Paging bernomor (page/size, OFFSET) atau kursor lama (before/limit).
    const limit = page ? size : q.data.limit;
    const offset = page ? (page - 1) * size : 0;
    if (offset >= MAX_PAGE_OFFSET) return reply.code(400).send({ detail: OLD_PAGE_MESSAGE });
    const filter: TraceFilter = {
      ...window(r), status,
      ...(service ? { service } : {}),
      ...(text ? { text } : {}),
      ...(minMs !== undefined ? { minDurationUs: Math.round(minMs * 1000) } : {}),
    };
    const { status: _s, ...noStatus } = filter;
    const [rows, total, statusCounts] = await Promise.all([
      telemetry?.searchTraces
        ? telemetry.searchTraces(pid, {
          ...filter, limit, offset,
          ...(before ? { beforeUs: Number(before.split(":")[0]), beforeSpanId: before.split(":")[1]! } : {}),
        })
        : [],
      telemetry?.countTraces ? telemetry.countTraces(pid, filter) : 0,
      // Filter sama TANPA filter status, supaya chip menampilkan semua kode yang tersedia.
      telemetry?.traceStatusCounts ? telemetry.traceStatusCounts(pid, noStatus) : [],
    ]);
    // Satu query tambahan per halaman untuk penyebab gagal tiap trace.
    const errs = rows.length && telemetry?.traceErrors
      ? await telemetry.traceErrors(pid, rows.map((t) => t.traceId), { fromUs: rows[rows.length - 1]!.startUs, toUs: rows[0]!.startUs })
      : new Map();
    const slowMs = rows.length ? await slowTraceMs(prisma, pid) : null;
    const traces = rows.map((t) => {
      const error = errs.get(t.traceId) ?? null;
      return { ...t, error, slow: isSlow(t.durationUs, slowMs, t.statusCode === 2 || (t.httpStatus ?? 0) >= 500 || error != null) };
    });
    const last = traces[traces.length - 1];
    return {
      sampled: !(telemetry?.storesAllSpans ?? false),
      traces,
      total,
      statusCounts,
      page: page ?? 1,
      size: limit,
      nextBefore: traces.length === limit && last ? `${last.startUs}:${last.spanId}` : null,
    };
  });

  app.get("/projects/:id/traces/services", async (req, reply) => {
    const pid = await projectId(req, reply);
    if (!pid) return reply;
    const q = z.object({ range: searchRange }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ detail: "invalid query" });
    const { fromUs, toUs } = window(q.data.range);
    return { services: telemetry?.listServices ? await telemetry.listServices(pid, fromUs, toUs) : [] };
  });

  // Trace satu request (dari API Health / pencarian trace); bentuk JSON sama dengan trace issue.
  app.get("/projects/:id/traces/:traceId", async (req, reply) => {
    const pid = await projectId(req, reply);
    if (!pid) return reply;
    const t = z.object({ traceId: z.string().regex(/^[0-9a-f]{32}$/) }).safeParse(req.params);
    if (!t.success) return reply.code(400).send({ detail: "invalid trace id" });
    const spans = (await telemetry?.getTrace(pid, t.data.traceId)) ?? [];
    if (!spans.length) return reply.code(404).send({ detail: "trace not stored (it may have been removed by retention)" });
    return traceView(t.data.traceId, spans);
  });

  // Body request/response satu span server (dimuat saat baris request dibuka, supaya daftar tetap ringan).
  // Tiap body dipotong ke BODY_MAX karakter; truncated = daftar field yang terpotong.
  app.get("/projects/:id/traces/:traceId/server-span", async (req, reply) => {
    const pid = await projectId(req, reply);
    if (!pid) return reply;
    const t = z.object({ traceId: z.string().regex(/^[0-9a-f]{32}$/) }).safeParse(req.params);
    const q = z.object({ spanId: z.string().regex(/^[0-9a-f]{16}$/) }).safeParse(req.query);
    if (!t.success || !q.success) return reply.code(400).send({ detail: "invalid query" });
    const raw = telemetry?.serverSpanBody ? await telemetry.serverSpanBody(pid, t.data.traceId, q.data.spanId) : null;
    if (!raw) return reply.code(404).send({ detail: "span not stored" });
    const body: Record<string, string> = {};
    const truncated: string[] = [];
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined || v === "") continue;
      if (v.length > BODY_MAX) truncated.push(k);
      body[k] = v.slice(0, BODY_MAX);
    }
    if (!Object.keys(body).length) return { body: null };
    return { body: { ...body, ...(truncated.length ? { truncated: true, truncatedFields: truncated } : {}) } };
  });
}
