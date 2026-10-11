import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@bugtool/db";
import { isSlow, slowTraceMs } from "../otlp/slow-config.js";
import { requireUser } from "../auth/session.js";
import { BUCKETS, percentile } from "../otlp/rollups.js";
import { parseStatusFilter, type StatusFilter } from "../otlp/status-filter.js";
import { MAX_PAGE_OFFSET, type TelemetryStore } from "../otlp/telemetry-store.js";
import { OLD_PAGE_MESSAGE, pageQuery } from "./paging.js";
import { ROLLUP_RANGES, numRow, projectIdFor, rollupRange } from "./common.js";

// API Health: ringkasan request per endpoint dari tabel endpoint_rollups.
const HS = Array.from({ length: BUCKETS }, (_, i) => `h${i}`);
const ms = (v: number | null) => (v === null ? null : Number.isFinite(v) ? v : 10_001); // 10001 = > 10 s

type Row = { t: number; method: string; route: string; count: number; c4xx: number; c5xx: number } & Record<string, number>;

// `now` (ms epoch) bisa disuntik agar test deterministik di batas menit/jam; default Date.now.
export async function healthRoutes(app: FastifyInstance, { prisma, telemetry, now: clock = Date.now }: {
  prisma: PrismaClient; telemetry?: TelemetryStore | undefined; now?: (() => number) | undefined;
}) {
  app.addHook("preHandler", requireUser);
  const projectId = projectIdFor(prisma);

  async function rows(pid: string, r: keyof typeof ROLLUP_RANGES, filter?: { method: string; route: string }) {
    const { s, step } = ROLLUP_RANGES[r];
    const now = Math.floor(clock() / 1000);
    // Bucket pertama sejajar step; bucket berjalan (floor(now/step)*step) jatuh di slot terakhir (n-1).
    const from = Math.floor((now - s) / step) * step + step;
    // Rentang per jam: baris per jam + baris per menit yang belum digabung (2 jam terakhir).
    // Hanya fragmen tetap yang disisipkan ke SQL; input user lewat parameter.
    const gran = step === 60 ? "('m')" : "('h','m')";
    const where = filter ? "AND method = ? AND route = ?" : "";
    const sql = `SELECT bucket - bucket % ${step} AS t, method, route, SUM(count) AS count, SUM(c4xx) AS c4xx, SUM(c5xx) AS c5xx,
        ${HS.map((h) => `SUM(${h}) AS ${h}`).join(", ")}
      FROM endpoint_rollups WHERE project_id = ? AND granularity IN ${gran} AND bucket >= ? ${where}
      GROUP BY t, method, route`;
    const params = [pid, from, ...(filter ? [filter.method, filter.route] : [])];
    const list = (await prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params)).map(
      (x) => numRow<Row>(x),
    );
    return { list, from, step, n: Math.round(s / step) };
  }
  // Jumlah request endpoint di jendela [lo, hi) detik dari endpoint_rollups (perkiraan: bucket menit/jam
  // dihitung kalau awal bucket-nya di dalam jendela). Baris menit dan jam tidak tumpang tindih (fold memindahkan).
  // Rollup hanya punya count/c4xx/c5xx: filter lain (kode persis, rentang) -> undefined (tidak ditampilkan).
  async function observedRequests(pid: string, method: string, route: string, status: StatusFilter, lo: number, hi: number) {
    const cls = new Set(status.ranges.map(([a, b]) => `${a}-${b}`));
    const only = [...cls].every((k) => k === "400-499" || k === "500-599");
    if (!status.all && !only) return undefined;
    const col = status.all ? "count" : [...cls].map((k) => (k === "500-599" ? "c5xx" : "c4xx")).join(" + ");
    const [x] = await prisma.$queryRawUnsafe<{ n: bigint | number | null }[]>(
      `SELECT SUM(${col}) AS n FROM endpoint_rollups
        WHERE project_id = ? AND method = ? AND route = ? AND granularity IN ('h', 'm') AND bucket >= ? AND bucket < ?`,
      pid, method, route, Math.floor(lo / 60) * 60, Math.ceil(hi));
    return Number(x?.n ?? 0);
  }
  const hist = (x: Row) => HS.map((h) => Number(x[h] ?? 0));


  app.get("/projects/:id/health", async (req, reply) => {
    const pid = await projectId(req, reply);
    if (!pid) return reply;
    const q = z.object({ range: rollupRange }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ detail: "invalid query" });
    const [{ list, from, step, n }, [rule]] = await Promise.all([
      rows(pid, q.data.range),
      // Ambang 5xx untuk penanda di UI: aturan alert "5xx" (persen, semua endpoint) yang aktif pertama,
      // atau default 5% / 20 request bila tidak ada.
      prisma.$queryRawUnsafe<{ pct: number; minRequests: bigint | number }[]>(
        `SELECT threshold AS pct, min_requests AS minRequests FROM alert_rules WHERE project_id = ? AND enabled = 1 AND kind = 'status'
          AND status_filter = '5xx' AND mode = 'pct' AND method IS NULL ORDER BY rowid LIMIT 1`, pid),
    ]);
    const threshold = rule ? { pct: Number(rule.pct), minRequests: Number(rule.minRequests) } : { pct: 5, minRequests: 20 };
    const by = new Map<string, { method: string; route: string; count: number; c4xx: number; c5xx: number; h: number[]; series: number[]; errSeries: number[] }>();
    for (const x of list) {
      const k = `${x.method} ${x.route}`;
      let e = by.get(k);
      if (!e) by.set(k, (e = { method: x.method, route: x.route, count: 0, c4xx: 0, c5xx: 0, h: Array<number>(BUCKETS).fill(0), series: Array<number>(n).fill(0), errSeries: Array<number>(n).fill(0) }));
      e.count += x.count;
      e.c4xx += x.c4xx;
      e.c5xx += x.c5xx;
      const h = e.h;
      hist(x).forEach((v, i) => (h[i] = (h[i] ?? 0) + v));
      const i = (x.t - from) / step;
      if (i >= 0 && i < n) {
        e.series[i] = (e.series[i] ?? 0) + x.count;
        e.errSeries[i] = (e.errSeries[i] ?? 0) + x.c5xx;
      }
    }
    const endpoints = [...by.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 200)
      .map(({ h, ...e }) => ({
        ...e,
        errorRate: e.count ? e.c5xx / e.count : 0,
        // Jumlah bucket yang melewati ambang (aturan sama dengan alert): lonjakan singkat tetap terlihat walau rata-rata rendah.
        breaches: e.series.filter((c, i) => c > 0 && c >= threshold.minRequests && ((e.errSeries[i] ?? 0) / c) * 100 >= threshold.pct).length,
        p50: ms(percentile(h, 0.5)), p95: ms(percentile(h, 0.95)), p99: ms(percentile(h, 0.99)),
      }));
    return { range: q.data.range, bucketSeconds: step, threshold, endpoints };
  });

  app.get("/projects/:id/health/endpoint", async (req, reply) => {
    const pid = await projectId(req, reply);
    if (!pid) return reply;
    const q = z.object({ range: rollupRange, method: z.string().min(1).max(16), route: z.string().min(1).max(300) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ detail: "invalid query" });
    const { list, from, step, n } = await rows(pid, q.data.range, { method: q.data.method, route: q.data.route });
    const at = new Map(list.map((x) => [x.t, x]));
    const series = Array.from({ length: n }, (_, i) => {
      const t = from + i * step;
      const x = at.get(t);
      const h = x ? hist(x) : Array<number>(BUCKETS).fill(0);
      return { t, count: x?.count ?? 0, c4xx: x?.c4xx ?? 0, c5xx: x?.c5xx ?? 0, p50: ms(percentile(h, 0.5)), p95: ms(percentile(h, 0.95)), p99: ms(percentile(h, 0.99)) };
    });
    return { bucketSeconds: step, series };
  });

  // Daftar request satu endpoint (Scale: semua; Lite: hanya span tersimpan/tersampel).
  app.get("/projects/:id/health/requests", async (req, reply) => {
    const pid = await projectId(req, reply);
    if (!pid) return reply;
    const q = z.object({
      range: rollupRange,
      method: z.string().min(1).max(16),
      route: z.string().min(1).max(300),
      status: z.string().max(300).default("5xx"),
      from: z.coerce.number().int().nonnegative().optional(),
      to: z.coerce.number().int().nonnegative().optional(),
      before: z.string().regex(/^\d{1,17}:[0-9a-f]{16}$/).optional(), // kursor "<startUs>:<spanId>"
      limit: z.coerce.number().int().min(1).max(200).default(50),
      ...pageQuery,
    }).safeParse(req.query);
    if (!q.success || (q.data.page && q.data.before)) return reply.code(400).send({ detail: "invalid query" });
    const statusFilter = parseStatusFilter(q.data.status);
    if (!statusFilter) return reply.code(400).send({ detail: "invalid status filter" });
    const { range: r, from, to, before, page, size, limit: cursorLimit, ...rest } = q.data;
    // Paging bernomor (page/size, OFFSET) atau kursor lama (before/limit).
    const limit = page ? size : cursorLimit;
    const offset = page ? (page - 1) * size : 0;
    if (offset >= MAX_PAGE_OFFSET) return reply.code(400).send({ detail: OLD_PAGE_MESSAGE });
    // Jendela rentang (detik); from/to dijepit di dalamnya.
    const nowS = clock() / 1000;
    const lo = Math.max(nowS - ROLLUP_RANGES[r].s, from ?? -Infinity);
    const hi = Math.min(nowS + 60, to ?? Infinity); // +60: toleransi jam klien sedikit di depan
    if ((from !== undefined && to !== undefined && from >= to) || lo >= hi) return reply.code(400).send({ detail: "invalid time window" });
    const filter = { ...rest, fromUs: Math.floor(lo * 1e6), toUs: Math.ceil(hi * 1e6) };
    const sampled = !(telemetry?.storesAllSpans ?? false);
    // topErrors merangkum SELURUH jendela filter (bukan per halaman) dan dihitung di setiap halaman, supaya
    // deep link ke halaman >= 2 tetap menampilkannya (biaya dibatasi TOP_ERRORS_SCAN / LITE_TOP_ERRORS_SCAN).
    // statusCounts: filter sama TANPA filter status, supaya chip menampilkan semua kode yang tersedia.
    const { status: _s, ...noStatus } = filter;
    const [rows, topErrors, total, observed, statusCounts] = await Promise.all([
      telemetry?.listRequests
        ? telemetry.listRequests(pid, { ...filter, limit, offset, ...(before ? { beforeUs: Number(before.split(":")[0]), beforeSpanId: before.split(":")[1]! } : {}) })
        : [],
      telemetry?.topErrors ? telemetry.topErrors(pid, filter) : [],
      telemetry?.countRequests ? telemetry.countRequests(pid, filter) : 0,
      // Lite: jumlah request sebenarnya dari rollup (semua request dihitung, walau hanya sebagian yang tersimpan).
      sampled ? observedRequests(pid, rest.method, rest.route, statusFilter, lo, hi) : undefined,
      telemetry?.requestStatusCounts ? telemetry.requestStatusCounts(pid, noStatus) : [],
    ]);
    // Satu query tambahan per halaman untuk penyebab gagal tiap request.
    const errs = rows.length && telemetry?.traceErrors
      ? await telemetry.traceErrors(pid, [...new Set(rows.map((r) => r.traceId))], { fromUs: rows[rows.length - 1]!.startUs, toUs: rows[0]!.startUs })
      : new Map();
    const slowMs = rows.length ? await slowTraceMs(prisma, pid) : null;
    const requests = rows.map((r) => {
      const error = errs.get(r.traceId) ?? null;
      return { ...r, error, slow: isSlow(r.durationUs, slowMs, r.status >= 500 || error != null) };
    });
    return {
      sampled,
      requests,
      topErrors,
      total,
      statusCounts,
      page: page ?? 1,
      size: limit,
      ...(observed !== undefined ? { observed } : {}),
      nextBefore: requests.length === limit ? `${requests[requests.length - 1]!.startUs}:${requests[requests.length - 1]!.spanId}` : null,
    };
  });
}
