import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@bugtool/db";
import { requireUser } from "../auth/session.js";
import type { LogStore } from "../otlp/logs.js";
import { SEARCH_RANGES, projectIdFor, searchRange } from "./common.js";

// Halaman Logs, tab Logs di trace, dan log di halaman issue (lewat trace_id event).
const TRACE_LOGS_MAX = 500;

export async function logRoutes(app: FastifyInstance, { prisma, logStore, now: clock = Date.now }: {
  prisma: PrismaClient; logStore?: LogStore | undefined; now?: (() => number) | undefined;
}) {
  app.addHook("preHandler", requireUser);
  const projectId = projectIdFor(prisma);


  app.get("/projects/:id/logs", async (req, reply) => {
    const pid = await projectId(req, reply);
    if (!pid) return reply;
    const q = z.object({
      range: searchRange,
      text: z.string().max(500).optional(),
      service: z.string().max(200).optional(),
      severity: z.coerce.number().int().min(0).max(24).optional(),
      traceId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
      before: z.string().regex(/^\d{1,17}:[0-9a-zA-Z-]{1,64}$/).optional(), // kursor "<timeUs>:<id>"
      // Batas bawah jendela (µs) dari halaman pertama, supaya "load more" tidak menggeser jendela ke depan.
      from: z.coerce.number().int().nonnegative().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ detail: "invalid query" });
    if (!logStore) return { enabled: false, logs: [], nextBefore: null };
    const { range, before, limit, text, service, severity, traceId, from } = q.data;
    const nowUs = clock() * 1000;
    const [bUs, bId] = before ? [Number(before.slice(0, before.indexOf(":"))), before.slice(before.indexOf(":") + 1)] : [];
    // id kursor: angka di SQLite (rowid), UUID di ClickHouse. Format lain akan diam-diam melewatkan baris.
    if (bId !== undefined && !(logStore.kind === "sqlite" ? /^\d+$/ : /^[0-9a-f-]{36}$/).test(bId)) return reply.code(400).send({ detail: "invalid cursor" });
    // from dari halaman sebelumnya dijepit ke rentang terpanjang (7 hari) supaya tidak bisa memindai tanpa batas.
    const fromUs = from !== undefined ? Math.max(from, nowUs - SEARCH_RANGES["7d"] * 1e6) : nowUs - SEARCH_RANGES[range] * 1e6;
    const logs = await logStore.searchLogs(pid, {
      fromUs, toUs: nowUs + 60e6, // +60 s: toleransi jam klien sedikit di depan
      text: text?.trim() || undefined, service: service || undefined, minSeverity: severity || undefined, traceId,
      limit, before: bUs !== undefined ? { timeUs: bUs, id: bId! } : undefined,
    });
    const last = logs.at(-1);
    return { enabled: true, logs, fromUs, nextBefore: logs.length === limit && last ? `${last.timeUs}:${last.id}` : null };
  });

  app.get("/projects/:id/logs/services", async (req, reply) => {
    const pid = await projectId(req, reply);
    if (!pid) return reply;
    const q = z.object({ range: searchRange }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ detail: "invalid query" });
    if (!logStore) return { services: [] };
    const nowUs = clock() * 1000;
    return { services: await logStore.logServices(pid, nowUs - SEARCH_RANGES[q.data.range] * 1e6, nowUs + 60e6) };
  });

  // Semua log satu trace, kronologis (tanpa jendela waktu: dicari lewat indeks trace_id).
  app.get("/projects/:id/traces/:traceId/logs", async (req, reply) => {
    const pid = await projectId(req, reply);
    if (!pid) return reply;
    const traceId = z.string().regex(/^[0-9a-f]{32}$/).safeParse((req.params as { traceId?: string }).traceId);
    if (!traceId.success) return reply.code(400).send({ detail: "invalid trace id" });
    if (!logStore) return { enabled: false, logs: [], truncated: false };
    const logs = await logStore.searchLogs(pid, { traceId: traceId.data, limit: TRACE_LOGS_MAX + 1, order: "asc" });
    return { enabled: true, logs: logs.slice(0, TRACE_LOGS_MAX), truncated: logs.length > TRACE_LOGS_MAX };
  });
}
