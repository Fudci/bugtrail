import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@bugtool/db";
import { requireUser } from "../auth/session.js";
import { BUCKETS, percentile } from "../otlp/rollups.js";
import { ROLLUP_RANGES, numRow, projectIdFor, rollupRange } from "./common.js";

// Service map: ringkasan per service dan panggilan antar service dari tabel service_rollups (peer '' = service sendiri).
const HS = Array.from({ length: BUCKETS }, (_, i) => `h${i}`);
const ms = (v: number | null) => (v === null ? null : Number.isFinite(v) ? v : 10_001); // 10001 = > 10 s
const MAX_SERVICES = 200;
const MAX_EDGES = 500;

type Row = { t: number; service: string; peer: string; external: number; count: number; errors: number } & Record<string, number>;

const stats = (count: number, errors: number, h: number[]) => ({
  count, errors, errorRate: count ? errors / count : 0,
  p50: ms(percentile(h, 0.5)), p95: ms(percentile(h, 0.95)), p99: ms(percentile(h, 0.99)),
});

export async function serviceRoutes(app: FastifyInstance, { prisma, now: clock = Date.now }: {
  prisma: PrismaClient; now?: (() => number) | undefined;
}) {
  app.addHook("preHandler", requireUser);
  const projectId = projectIdFor(prisma);

  async function rows(pid: string, r: keyof typeof ROLLUP_RANGES, service?: string) {
    const { s, step } = ROLLUP_RANGES[r];
    const now = Math.floor(clock() / 1000);
    const from = Math.floor((now - s) / step) * step + step;
    const gran = step === 60 ? "('m')" : "('h','m')";
    // Detail satu service: baris service itu sendiri + panggilan keluar dan masuk.
    const where = service !== undefined ? "AND (service = ? OR peer = ?)" : "";
    const sql = `SELECT bucket - bucket % ${step} AS t, service, peer, MIN(external) AS external, SUM(count) AS count, SUM(errors) AS errors,
        ${HS.map((h) => `SUM(${h}) AS ${h}`).join(", ")}
      FROM service_rollups WHERE project_id = ? AND granularity IN ${gran} AND bucket >= ? ${where}
      GROUP BY t, service, peer`;
    const params = [pid, from, ...(service !== undefined ? [service, service] : [])];
    const list = (await prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params)).map(
      (x) => numRow<Row>(x),
    );
    return { list, from, step, n: Math.round(s / step) };
  }
  const hist = (x: Row) => HS.map((h) => Number(x[h] ?? 0));
  const addHist = (into: number[], x: Row) => hist(x).forEach((v, i) => (into[i] = (into[i] ?? 0) + v));

  /** Gabung baris panggilan (peer != '') per pasangan service -> peer. */
  function edgesOf(list: Row[]) {
    const by = new Map<string, { source: string; target: string; external: boolean; count: number; errors: number; h: number[] }>();
    for (const x of list) {
      if (x.peer === "") continue;
      const k = JSON.stringify([x.service, x.peer]);
      let e = by.get(k);
      if (!e) by.set(k, (e = { source: x.service, target: x.peer, external: true, count: 0, errors: 0, h: Array<number>(BUCKETS).fill(0) }));
      if (!x.external) e.external = false;
      e.count += x.count;
      e.errors += x.errors;
      addHist(e.h, x);
    }
    return [...by.values()].sort((a, b) => b.count - a.count).slice(0, MAX_EDGES)
      .map(({ h, source, target, external, count, errors }) => ({ source, target, external, ...stats(count, errors, h) }));
  }


  app.get("/projects/:id/services", async (req, reply) => {
    const pid = await projectId(req, reply);
    if (!pid) return reply;
    const q = z.object({ range: rollupRange }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ detail: "invalid query" });
    const { list, from, step, n } = await rows(pid, q.data.range);
    const by = new Map<string, { name: string; count: number; errors: number; h: number[]; series: number[]; errSeries: number[] }>();
    for (const x of list) {
      if (x.peer !== "") continue;
      let e = by.get(x.service);
      if (!e) by.set(x.service, (e = { name: x.service, count: 0, errors: 0, h: Array<number>(BUCKETS).fill(0), series: Array<number>(n).fill(0), errSeries: Array<number>(n).fill(0) }));
      e.count += x.count;
      e.errors += x.errors;
      addHist(e.h, x);
      const i = (x.t - from) / step;
      if (i >= 0 && i < n) {
        e.series[i] = (e.series[i] ?? 0) + x.count;
        e.errSeries[i] = (e.errSeries[i] ?? 0) + x.errors;
      }
    }
    const edges = edgesOf(list);
    // Service yang hanya memanggil (worker, job) tanpa request masuk tetap tampil sebagai node.
    for (const e of edges) {
      if (by.has(e.source)) continue;
      by.set(e.source, { name: e.source, count: 0, errors: 0, h: Array<number>(BUCKETS).fill(0), series: Array<number>(n).fill(0), errSeries: Array<number>(n).fill(0) });
    }
    const services = [...by.values()].sort((a, b) => b.count - a.count).slice(0, MAX_SERVICES)
      .map(({ h, name, count, errors, series, errSeries }) => ({ name, ...stats(count, errors, h), series, errSeries }));
    return { range: q.data.range, bucketSeconds: step, services, edges };
  });

  app.get("/projects/:id/services/detail", async (req, reply) => {
    const pid = await projectId(req, reply);
    if (!pid) return reply;
    const q = z.object({ range: rollupRange, service: z.string().min(1).max(200) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ detail: "invalid query" });
    const { service } = q.data;
    const { list, from, step, n } = await rows(pid, q.data.range, service);
    const own = new Map(list.filter((x) => x.service === service && x.peer === "").map((x) => [x.t, x]));
    const series = Array.from({ length: n }, (_, i) => {
      const t = from + i * step;
      const x = own.get(t);
      const h = x ? hist(x) : Array<number>(BUCKETS).fill(0);
      return { t, count: x?.count ?? 0, errors: x?.errors ?? 0, p50: ms(percentile(h, 0.5)), p95: ms(percentile(h, 0.95)), p99: ms(percentile(h, 0.99)) };
    });
    const total = Array<number>(BUCKETS).fill(0);
    let count = 0, errors = 0;
    for (const x of own.values()) { count += x.count; errors += x.errors; addHist(total, x); }
    const edges = edgesOf(list);
    // Endpoint HTTP service ini dari endpoint_rollups (kolom service; data sebelum kolom ada = service '').
    const gran = step === 60 ? "('m')" : "('h','m')";
    const eps = (await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT method, route, SUM(count) AS count, SUM(c4xx) AS c4xx, SUM(c5xx) AS c5xx, ${HS.map((h) => `SUM(${h}) AS ${h}`).join(", ")}
        FROM endpoint_rollups WHERE project_id = ? AND granularity IN ${gran} AND bucket >= ? AND service = ?
        GROUP BY method, route ORDER BY count DESC LIMIT 200`, pid, from, service))
      .map((x) => numRow<Row & { method: string; route: string; c4xx: number; c5xx: number }>(x));
    const endpoints = eps.map((x) => {
      const h = hist(x);
      return { method: x.method, route: x.route, count: x.count, c4xx: x.c4xx, c5xx: x.c5xx, errorRate: x.count ? x.c5xx / x.count : 0,
        p50: ms(percentile(h, 0.5)), p95: ms(percentile(h, 0.95)), p99: ms(percentile(h, 0.99)) };
    });
    return {
      bucketSeconds: step,
      service, ...stats(count, errors, total), series, endpoints,
      upstream: edges.filter((e) => e.target === service),
      downstream: edges.filter((e) => e.source === service),
    };
  });
}
