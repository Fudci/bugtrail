import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma, toDbDate, type PrismaClient } from "@bugtool/db";
import { projectRole, requireUser } from "../auth/session.js";
import { toCsv } from "./csv.js";

const RANGES = { "24h": { ms: 24 * 3600_000, bucket: "hour" }, "7d": { ms: 7 * 86400_000, bucket: "day" }, "14d": { ms: 14 * 86400_000, bucket: "day" }, "30d": { ms: 30 * 86400_000, bucket: "day" } } as const;

const query = z.object({
  range: z.enum(Object.keys(RANGES) as [keyof typeof RANGES]).default("14d"),
  release: z.string().max(200).optional(),
  environment: z.string().max(200).optional(),
  level: z.enum(["fatal", "error", "warning", "info", "debug"]).optional(),
  // Offset zona waktu browser dalam menit (mis. WIB = 420), supaya batas hari sesuai jam lokal.
  platform: z.string().max(100).optional(),
  tz: z.coerce.number().int().min(-840).max(840).default(0),
});

const n = (v: bigint | number | null | undefined) => Number(v ?? 0);
const EXPORT_MAX = 10_000;

// Kondisi WHERE untuk event dalam rentang waktu + filter overview. alias: prefix tabel, mis. "e.".
// Platform = nama OS dari SDK, atau field platform kalau OS tidak dikirim (sama dengan kartu Platforms).
const PLATFORM_SQL = "coalesce(json_extract(payload, '$.contexts.os.name'), json_extract(payload, '$.platform'), 'unknown')";

function eventFilter(pid: string, f: { release?: string | undefined; environment?: string | undefined; level?: string | undefined; platform?: string | undefined }) {
  return (a: Date, b: Date, alias = "") => {
    const col = (c: string) => Prisma.raw(`${alias}${c}`);
    return Prisma.join(
      [
        Prisma.sql`${col("project_id")} = ${pid}`,
        f.release ? Prisma.sql`${col("release")} = ${f.release}` : Prisma.sql`1=1`,
        f.environment ? Prisma.sql`${col("environment")} = ${f.environment}` : Prisma.sql`1=1`,
        f.level ? Prisma.sql`${col("level")} = ${f.level}` : Prisma.sql`1=1`,
        f.platform ? Prisma.sql`${Prisma.raw(PLATFORM_SQL.replaceAll("payload", `${alias}payload`))} = ${f.platform}` : Prisma.sql`1=1`,
        Prisma.sql`${col("received_at")} >= ${toDbDate(a)} AND ${col("received_at")} < ${toDbDate(b)}`,
      ],
      " AND ",
    );
  };
}

// Overview per project: angka ringkas vs periode sebelumnya, grafik event per jam/hari, level, issue teratas, OS.
// Semua dihitung dari event yang masih tersimpan, jadi ikut dibatasi retensi.
export async function overviewRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  app.addHook("preHandler", requireUser);

  app.get("/projects/:id/overview", async (req, reply) => {
    const id = z.uuid().safeParse((req.params as { id?: string }).id);
    const q = query.safeParse(req.query);
    if (!id.success) return reply.code(404).send({ detail: "not found" });
    if (!q.success) return reply.code(400).send({ detail: "invalid query" });
    if (!(await projectRole(prisma, req.user!, id.data))) return reply.code(404).send({ detail: "not found" });

    const pid = id.data;
    const { range, release, environment, level, platform, tz } = q.data;
    const { ms, bucket } = RANGES[range];
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    const prevFrom = new Date(from.getTime() - ms);

    const inRange = eventFilter(pid, { release, environment, level, platform });
    // Pembagian per level sengaja tanpa filter level, supaya level lain tetap terlihat untuk dibandingkan.
    const inRangeAllLevels = eventFilter(pid, { release, environment, platform });
    // Sama untuk platform: daftar platform tidak ikut difilter platform.
    const inRangeAllPlatforms = eventFilter(pid, { release, environment, level });

    const totals = async (a: Date, b: Date) => {
      const [t] = await prisma.$queryRaw<{ events: bigint; users: bigint }[]>`
        SELECT COUNT(*) AS events, COUNT(DISTINCT user_id) AS users FROM events WHERE ${inRange(a, b)}`;
      const [ni] = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(DISTINCT e.issue_id) AS n FROM events e JOIN issues i ON i.id = e.issue_id
        WHERE ${inRange(a, b, "e.")} AND i.first_seen >= ${toDbDate(a)} AND i.first_seen < ${toDbDate(b)}`;
      return { events: n(t?.events), users: n(t?.users), newIssues: n(ni?.n) };
    };

    const shift = `${tz >= 0 ? "+" : ""}${tz} minutes`;
    const fmt = bucket === "hour" ? "%Y-%m-%dT%H" : "%Y-%m-%d";

    const [current, previous, seriesRows, levels, top, platforms, releases, environments] = await Promise.all([
      totals(from, to),
      totals(prevFrom, from),
      prisma.$queryRaw<{ t: string; n: bigint }[]>`
        SELECT strftime(${fmt}, received_at, ${shift}) AS t, COUNT(*) AS n FROM events WHERE ${inRange(from, to)} GROUP BY t`,
      prisma.$queryRaw<{ level: string; n: bigint }[]>`
        SELECT level, COUNT(*) AS n FROM events WHERE ${inRangeAllLevels(from, to)} GROUP BY level ORDER BY n DESC`,
      prisma.$queryRaw<{ id: string; title: string; culprit: string | null; level: string; status: string; events: bigint; users: bigint }[]>`
        SELECT i.id, i.title, i.culprit, i.level, i.status, COUNT(*) AS events, COUNT(DISTINCT e.user_id) AS users
        FROM events e JOIN issues i ON i.id = e.issue_id WHERE ${inRange(from, to, "e.")}
        GROUP BY i.id ORDER BY events DESC LIMIT 5`,
      prisma.$queryRaw<{ name: string | null; n: bigint }[]>`
        SELECT ${Prisma.raw(PLATFORM_SQL)} AS name, COUNT(*) AS n
        FROM events WHERE ${inRangeAllPlatforms(from, to)} GROUP BY name ORDER BY n DESC LIMIT 6`,
      prisma.$queryRaw<{ v: string }[]>`
        SELECT DISTINCT release AS v FROM events WHERE project_id = ${pid} AND release IS NOT NULL ORDER BY received_at DESC LIMIT 50`,
      prisma.$queryRaw<{ v: string }[]>`
        SELECT DISTINCT environment AS v FROM events WHERE project_id = ${pid} AND environment IS NOT NULL LIMIT 50`,
    ]);

    // Isi bucket kosong supaya grafik selalu punya titik untuk setiap jam/hari.
    const counts = new Map(seriesRows.map((r) => [r.t, n(r.n)]));
    const step = bucket === "hour" ? 3600_000 : 86400_000;
    const series: { t: string; events: number }[] = [];
    const keyOf = (ms: number) => new Date(ms + tz * 60_000).toISOString().slice(0, bucket === "hour" ? 13 : 10);
    for (const at of [...Array.from({ length: Math.ceil(ms / step) }, (_, i) => from.getTime() + i * step), to.getTime()]) {
      const key = keyOf(at);
      if (series.at(-1)?.t !== key) series.push({ t: key, events: counts.get(key) ?? 0 });
    }

    return {
      range, bucket, from, to,
      totals: { ...current, previous },
      series,
      levels: levels.map((l) => ({ level: l.level, events: n(l.n) })),
      topIssues: top.map((t) => ({ ...t, events: n(t.events), users: n(t.users) })),
      platforms: platforms.map((p) => ({ name: p.name ?? "unknown", events: n(p.n) })),
      releases: releases.map((r) => r.v),
      environments: environments.map((r) => r.v),
    };
  });

  // Ekspor CSV: issue yang punya event dalam rentang + filter overview, dengan hitungan khusus periode itu.
  app.get("/projects/:id/overview/export", async (req, reply) => {
    const id = z.uuid().safeParse((req.params as { id?: string }).id);
    const q = query.safeParse(req.query);
    if (!id.success) return reply.code(404).send({ detail: "not found" });
    if (!q.success) return reply.code(400).send({ detail: "invalid query" });
    if (!(await projectRole(prisma, req.user!, id.data))) return reply.code(404).send({ detail: "not found" });

    const { range, release, environment, level, platform } = q.data;
    const to = new Date();
    const from = new Date(to.getTime() - RANGES[range].ms);
    const rows = await prisma.$queryRaw<{ id: string; title: string; culprit: string | null; level: string; status: string; events: bigint; users: bigint; first: string; last: string; first_seen: string }[]>`
      SELECT i.id, i.title, i.culprit, i.level, i.status, COUNT(*) AS events, COUNT(DISTINCT e.user_id) AS users,
             MIN(e.received_at) AS first, MAX(e.received_at) AS last, i.first_seen
      FROM events e JOIN issues i ON i.id = e.issue_id
      WHERE ${eventFilter(id.data, { release, environment, level, platform })(from, to, "e.")}
      GROUP BY i.id ORDER BY events DESC LIMIT ${EXPORT_MAX}`;

    const web = (process.env["WEB_URL"] ?? process.env["PUBLIC_URL"] ?? "").replace(/\/$/, "");
    const iso = (v: string | Date) => new Date(v).toISOString();
    const csv = toCsv(
      ["id", "title", "culprit", "level", "status", "events_in_period", "users_in_period", "first_event_in_period", "last_event_in_period", "issue_first_seen", "url"],
      rows.map((r) => [r.id, r.title, r.culprit, r.level, r.status, n(r.events), n(r.users), iso(r.first), iso(r.last), iso(r.first_seen), `${web}/p/${id.data}/issues/${r.id}`]),
    );
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="overview-${range}-${to.toISOString().slice(0, 10)}.csv"`)
      .send(csv);
  });
}
