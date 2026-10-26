import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma, toDbDate, type PrismaClient } from "@bugtool/db";
import { projectRole, requireUser } from "../auth/session.js";
import { toCsv } from "./csv.js";
import { eventMatchSql, eventsCsv, ftsMatch, httpParam, httpStatusCounts, httpStatusSql, type EventMatch } from "./events-query.js";
import { OLD_PAGE_MESSAGE, pageQuery } from "./paging.js";
import { MAX_PAGE_OFFSET } from "../otlp/telemetry-store.js";
import { traceView, type TelemetryStore } from "../otlp/telemetry-store.js";
import { unsymbolicatedDebugIds, type Symbolicator } from "../sourcemaps/symbolicate.js";

const idParam = z.object({ id: z.uuid() });
const LEVELS = ["fatal", "error", "warning", "info", "debug"] as const;
const STATUSES = ["unresolved", "resolved", "ignored"] as const;

const listQuery = z.object({
  status: z.enum([...STATUSES, "all"]).default("unresolved"),
  level: z.enum(LEVELS).optional(),
  query: z.string().trim().max(200).optional(),
  release: z.string().max(200).optional(),
  firstRelease: z.string().max(200).optional(),
  http: httpParam,
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
// Filter event di dalam satu issue: ?q= (sama dengan pencarian Issues) dan ?http= (status HTTP).
const matchQuery = z.object({ q: z.string().trim().max(200).optional(), http: httpParam });
const eventsQuery = matchQuery.extend(pageQuery);
const matchOf = (m: z.infer<typeof matchQuery>): EventMatch => ({ query: m.q || undefined, http: m.http });
const patchBody = z
  .object({ status: z.enum(STATUSES).optional(), assigneeId: z.uuid().nullable().optional() })
  .refine((b) => b.status !== undefined || b.assigneeId !== undefined, "nothing to update");

// Cursor = "<iso timestamp>|<uuid>" dalam base64url, untuk urutan (waktu DESC, id DESC).
function encodeCursor(at: Date, id: string) {
  return Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}
function decodeCursor(c: string): { at: Date; id: string } | null {
  const [iso, id] = Buffer.from(c, "base64url").toString().split("|");
  const at = new Date(iso ?? "");
  if (!id || Number.isNaN(at.getTime()) || !z.uuid().safeParse(id).success) return null;
  return { at, id };
}

// Cari issue lewat isi event (FTS5).
async function searchIssueIds(prisma: PrismaClient, projectId: string, query: string) {
  const match = ftsMatch(query);
  if (!match) return [];
  const rows = await prisma.$queryRaw<{ issue_id: string }[]>`
    SELECT DISTINCT issue_id FROM events_fts WHERE events_fts MATCH ${match} AND project_id = ${projectId} LIMIT 1000`;
  return rows.map((r) => r.issue_id);
}

// Issue yang punya event dengan status HTTP tertentu (masih tersimpan).
async function httpIssueIds(prisma: PrismaClient, projectId: string, http: NonNullable<IssueFilter["http"]>) {
  const rows = await prisma.$queryRaw<{ issue_id: string }[]>`
    SELECT DISTINCT issue_id FROM events WHERE project_id = ${projectId} AND ${httpStatusSql(http)} LIMIT 10000`;
  return rows.map((r) => r.issue_id);
}

type IssueFilter = Pick<z.infer<typeof listQuery>, "status" | "level" | "query" | "release" | "firstRelease" | "http">;

// Filter halaman Issues; dipakai juga oleh ekspor CSV supaya hasilnya sama dengan yang dilihat user.
async function issueFilter(prisma: PrismaClient, projectId: string, f: IssueFilter): Promise<Prisma.IssueWhereInput> {
  const ids = f.query ? await searchIssueIds(prisma, projectId, f.query) : null;
  const httpIds = f.http ? await httpIssueIds(prisma, projectId, f.http) : null;
  return {
    projectId,
    ...(f.status !== "all" && { status: f.status }),
    ...(f.level && { level: f.level }),
    ...(f.release && { events: { some: { release: f.release } } }),
    ...(f.firstRelease && { firstRelease: f.firstRelease }),
    // SQLite LIKE (dipakai `contains`) tidak peka huruf besar/kecil untuk ASCII.
    ...(f.query && { OR: [{ title: { contains: f.query } }, { id: { in: ids ?? [] } }] }),
    ...(httpIds && { id: { in: httpIds } }),
  };
}

const EXPORT_MAX = 10_000;
const SPARK_DAYS = 14;

// Jumlah event per hari (UTC) selama 14 hari terakhir untuk satu halaman issue, dalam satu query.
async function sparklines(prisma: PrismaClient, ids: string[]) {
  const out = new Map<string, number[]>();
  if (!ids.length) return out;
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const start = new Date(today - (SPARK_DAYS - 1) * 86400_000);
  const rows = await prisma.$queryRaw<{ issue_id: string; d: string; n: bigint | number }[]>`
    SELECT issue_id, substr(received_at, 1, 10) AS d, COUNT(*) AS n FROM events
    WHERE issue_id IN (${Prisma.join(ids)}) AND received_at >= ${toDbDate(start)}
    GROUP BY issue_id, d`;
  for (const r of rows) {
    const i = Math.round((Date.parse(r.d) - start.getTime()) / 86400_000);
    if (i < 0 || i >= SPARK_DAYS) continue;
    const arr = out.get(r.issue_id) ?? new Array(SPARK_DAYS).fill(0);
    arr[i] = Number(r.n);
    out.set(r.issue_id, arr);
  }
  return out;
}

export async function issueRoutes(
  app: FastifyInstance,
  { prisma, symbolicator, telemetry }: { prisma: PrismaClient; symbolicator?: Symbolicator | undefined; telemetry?: TelemetryStore | undefined },
) {
  app.addHook("preHandler", requireUser);

  app.get("/projects/:id/issues", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const q = listQuery.safeParse(req.query);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if (!q.success) return reply.code(400).send({ detail: "invalid query" });
    if (!(await projectRole(prisma, req.user!, p.data.id))) return reply.code(404).send({ detail: "not found" });

    const { status, level, query, limit, release, firstRelease, http } = q.data;
    const cursor = q.data.cursor ? decodeCursor(q.data.cursor) : null;
    if (q.data.cursor && !cursor) return reply.code(400).send({ detail: "invalid cursor" });

    const rows = await prisma.issue.findMany({
      where: {
        ...(await issueFilter(prisma, p.data.id, { status, level, query, release, firstRelease, http })),
        ...(cursor && {
          AND: [{ OR: [{ lastSeen: { lt: cursor.at } }, { lastSeen: cursor.at, id: { lt: cursor.id } }] }],
        }),
      },
      orderBy: [{ lastSeen: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: { assignee: { select: { id: true, username: true, name: true, email: true } } },
    });

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const spark = await sparklines(prisma, page.map((r) => r.id));
    return {
      issues: page.map((r) => ({ ...toIssue(r), spark: spark.get(r.id) ?? new Array(SPARK_DAYS).fill(0) })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.lastSeen, last.id) : null,
    };
  });

  app.get("/projects/:id/issues/export", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const q = listQuery.safeParse(req.query);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if (!q.success) return reply.code(400).send({ detail: "invalid query" });
    if (!(await projectRole(prisma, req.user!, p.data.id))) return reply.code(404).send({ detail: "not found" });

    const issues = await prisma.issue.findMany({
      where: await issueFilter(prisma, p.data.id, q.data),
      orderBy: [{ lastSeen: "desc" }, { id: "desc" }],
      take: EXPORT_MAX,
      include: { assignee: { select: { email: true, username: true } } },
    });
    // Jumlah user unik per issue dalam satu query, bukan satu query per baris.
    const users = new Map<string, number>();
    if (issues.length) {
      const counts = await prisma.$queryRaw<{ issue_id: string; n: bigint | number }[]>`
        SELECT issue_id, COUNT(DISTINCT user_id) AS n FROM events
        WHERE issue_id IN (${Prisma.join(issues.map((i) => i.id))}) AND user_id IS NOT NULL GROUP BY issue_id`;
      for (const c of counts) users.set(c.issue_id, Number(c.n));
    }

    const web = (process.env["WEB_URL"] ?? process.env["PUBLIC_URL"] ?? "").replace(/\/$/, "");
    const csv = toCsv(
      ["id", "title", "culprit", "level", "status", "events", "users", "first_seen", "last_seen", "first_release", "assignee", "url"],
      issues.map((i) => [
        i.id, i.title, i.culprit, i.level, i.status, i.eventCount, users.get(i.id) ?? 0,
        i.firstSeen, i.lastSeen, i.firstRelease, i.assignee ? (i.assignee.email ?? i.assignee.username) : undefined, `${web}/p/${p.data.id}/issues/${i.id}`,
      ]),
    );
    const date = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="issues-${date}.csv"`)
      .send(csv);
  });

  // Ekspor per event dari issue yang cocok dengan filter halaman Issues; pencarian & status HTTP juga
  // menyaring event-nya, supaya hasil pencarian NRK hanya berisi event milik NRK itu.
  app.get("/projects/:id/issues/events-export", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const q = listQuery.safeParse(req.query);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if (!q.success) return reply.code(400).send({ detail: "invalid query" });
    if (!(await projectRole(prisma, req.user!, p.data.id))) return reply.code(404).send({ detail: "not found" });

    const issues = await prisma.issue.findMany({ where: await issueFilter(prisma, p.data.id, q.data), select: { id: true }, take: EXPORT_MAX });
    const where = Prisma.join([
      issues.length ? Prisma.sql`e.issue_id IN (${Prisma.join(issues.map((i) => i.id))})` : Prisma.sql`0=1`,
      q.data.release ? Prisma.sql`e.release = ${q.data.release}` : Prisma.sql`1=1`,
      eventMatchSql({ query: q.data.query, http: q.data.http }, "e."),
    ], " AND ");
    const date = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="events-${date}.csv"`)
      .send(await eventsCsv(prisma, p.data.id, where));
  });

  // Jumlah event per status HTTP di project (chip filter halaman Issues).
  app.get("/projects/:id/issues/http-statuses", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if (!(await projectRole(prisma, req.user!, p.data.id))) return reply.code(404).send({ detail: "not found" });
    return { statusCounts: await httpStatusCounts(prisma, Prisma.sql`project_id = ${p.data.id}`) };
  });

  // Ringkasan per release (dari event yang masih tersimpan, jadi ikut dibatasi retensi).
  app.get("/projects/:id/releases", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if (!(await projectRole(prisma, req.user!, p.data.id))) return reply.code(404).send({ detail: "not found" });
    const rows = await prisma.$queryRaw<{ release: string; events: bigint | number; issues: bigint | number; users: bigint | number; first_seen: string; last_seen: string }[]>`
      SELECT release, COUNT(*) AS events, COUNT(DISTINCT issue_id) AS issues, COUNT(DISTINCT user_id) AS users,
             MIN(received_at) AS first_seen, MAX(received_at) AS last_seen
      FROM events WHERE project_id = ${p.data.id} AND release IS NOT NULL
      GROUP BY release ORDER BY first_seen DESC LIMIT 100`;
    const fresh = await prisma.$queryRaw<{ release: string; n: bigint | number }[]>`
      SELECT first_release AS release, COUNT(*) AS n FROM issues
      WHERE project_id = ${p.data.id} AND first_release IS NOT NULL GROUP BY first_release`;
    const newByRelease = new Map(fresh.map((r) => [r.release, Number(r.n)]));
    return rows.map((r) => ({
      release: r.release,
      events: Number(r.events),
      issues: Number(r.issues),
      users: Number(r.users),
      newIssues: newByRelease.get(r.release) ?? 0,
      firstSeen: new Date(r.first_seen).toISOString(),
      lastSeen: new Date(r.last_seen).toISOString(),
    }));
  });

  // Event untuk tampilan: yang masuk sebelum source map diunggah diterjemahkan di sini (tidak disimpan).
  function viewEvent(projectId: string, row: Parameters<typeof toEvent>[0]) {
    const event = toEvent(row);
    let payload = event.payload as Record<string, unknown>;
    if (symbolicator && unsymbolicatedDebugIds(payload).length) {
      try {
        payload = symbolicator.symbolicate(projectId, payload).payload;
      } catch {}
    }
    return { event: { ...event, payload }, sourcemapsMissing: unsymbolicatedDebugIds(payload) };
  }

  app.get("/issues/:id", async (req, reply) => {
    const issue = await loadIssue(prisma, req, reply);
    if (!issue) return;
    const m = matchQuery.safeParse(req.query);
    if (!m.success) return reply.code(400).send({ detail: "invalid query" });
    const match = matchOf(m.data);
    const filtered = Boolean(match.query || match.http);
    // Dengan filter (?q= / ?http=), event "terbaru" dan jumlah user dihitung dari event yang cocok saja.
    const [latestId] = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM events WHERE issue_id = ${issue.id} AND ${eventMatchSql(match)} ORDER BY received_at DESC, id DESC LIMIT 1`;
    const latest = latestId ? await prisma.event.findUnique({ where: { id: latestId.id } }) : null;
    const [counts] = await prisma.$queryRaw<{ users: bigint | number; events: bigint | number }[]>`
      SELECT COUNT(DISTINCT user_id) AS users, COUNT(*) AS events FROM events WHERE issue_id = ${issue.id} AND ${eventMatchSql(match)}`;
    const v = latest ? viewEvent(issue.projectId, latest) : null;
    return {
      ...issue,
      userCount: Number(counts?.users ?? 0),
      matchCount: filtered ? Number(counts?.events ?? 0) : null,
      statusCounts: await httpStatusCounts(prisma, Prisma.sql`issue_id = ${issue.id}`),
      latestEvent: v?.event ?? null,
      sourcemapsMissing: v?.sourcemapsMissing ?? [],
    };
  });

  // Satu event tertentu dari issue ini (tab Events / klik user terdampak).
  app.get("/issues/:id/events/:eventId", async (req, reply) => {
    const issue = await loadIssue(prisma, req, reply);
    if (!issue) return;
    // event_id dari SDK = 32 hex sembarang (tidak selalu UUID versi sah), jadi jangan pakai z.uuid().
    const e = z.object({ eventId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) }).safeParse(req.params);
    const row = e.success ? await prisma.event.findFirst({ where: { id: e.data.eventId.toLowerCase(), issueId: issue.id } }) : null;
    if (!row) return reply.code(404).send({ detail: "event not found (it may have been removed by retention)" });
    return viewEvent(issue.projectId, row);
  });

  // Trace OpenTelemetry dari event issue ini (hanya trace yang berisi error yang disimpan).
  app.get("/issues/:id/trace/:traceId", async (req, reply) => {
    const issue = await loadIssue(prisma, req, reply);
    if (!issue) return;
    const t = z.object({ traceId: z.string().regex(/^[0-9a-f]{32}$/) }).safeParse(req.params);
    if (!t.success) return reply.code(400).send({ detail: "invalid trace id" });
    const spans = (await telemetry?.getTrace(issue.projectId, t.data.traceId)) ?? [];
    if (!spans.length) return reply.code(404).send({ detail: "trace not stored (it may have been removed by retention)" });
    return traceView(t.data.traceId, spans);
  });

  // User terdampak: per user ID, jumlah event & event terakhirnya (dari event yang masih tersimpan).
  app.get("/issues/:id/users", async (req, reply) => {
    const issue = await loadIssue(prisma, req, reply);
    if (!issue) return;
    const m = matchQuery.safeParse(req.query);
    if (!m.success) return reply.code(400).send({ detail: "invalid query" });
    // SQLite: kolom biasa di samping MAX() mengambil baris yang MAX-nya (event terakhir user itu).
    const rows = await prisma.$queryRaw<{ user_id: string; events: bigint | number; last_seen: string; last_event_id: string }[]>`
      SELECT user_id, COUNT(*) AS events, MAX(received_at) AS last_seen, id AS last_event_id
      FROM events WHERE issue_id = ${issue.id} AND user_id IS NOT NULL AND ${eventMatchSql(matchOf(m.data))}
      GROUP BY user_id ORDER BY events DESC, last_seen DESC LIMIT 100`;
    return rows.map((r) => ({
      userId: r.user_id,
      events: Number(r.events),
      lastSeen: new Date(r.last_seen).toISOString(),
      lastEventId: r.last_event_id,
    }));
  });

  app.get("/issues/:id/events", async (req, reply) => {
    const issue = await loadIssue(prisma, req, reply);
    if (!issue) return;
    const q = eventsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ detail: "invalid query" });
    const page = q.data.page ?? 1;
    const offset = (page - 1) * q.data.size;
    if (offset >= MAX_PAGE_OFFSET) return reply.code(400).send({ detail: OLD_PAGE_MESSAGE });
    const where = Prisma.sql`issue_id = ${issue.id} AND ${eventMatchSql(matchOf(q.data))}`;

    const [total] = await prisma.$queryRaw<{ n: bigint | number }[]>`SELECT COUNT(*) AS n FROM events WHERE ${where}`;
    // Ringkasan device per event langsung dari JSON payload (tanpa memuat payload utuh).
    const rows = await prisma.$queryRaw<{ id: string; received_at: string; release: string | null; user_id: string | null; http_status: number | null; model: string | null; manufacturer: string | null; os: string | null; online: number | null; connection: string | null }[]>`
      SELECT id, received_at, release, user_id, http_status,
        json_extract(payload, '$.contexts.device.model') AS model,
        json_extract(payload, '$.contexts.device.manufacturer') AS manufacturer,
        trim(coalesce(json_extract(payload, '$.contexts.os.name'), '') || ' ' || coalesce(json_extract(payload, '$.contexts.os.version'), '')) AS os,
        json_extract(payload, '$.contexts.device.online') AS online,
        json_extract(payload, '$.contexts.device.connection_type') AS connection
      FROM events WHERE ${where} ORDER BY received_at DESC, id DESC LIMIT ${q.data.size} OFFSET ${offset}`;
    return {
      total: Number(total?.n ?? 0),
      page,
      size: q.data.size,
      events: rows.map((x) => ({
        id: x.id,
        receivedAt: new Date(x.received_at).toISOString(),
        release: x.release,
        userId: x.user_id,
        httpStatus: x.http_status === null ? null : Number(x.http_status),
        device: [x.manufacturer, x.model].filter(Boolean).join(" ") || null,
        os: x.os || null,
        online: x.online == null ? null : Boolean(x.online),
        connection: x.connection ?? null,
      })),
    };
  });
  // Hapus permanen: issue + semua event-nya (cascade) + indeks pencarian (trigger). Hanya admin project.
  app.delete("/issues/:id", async (req, reply) => {
    const issue = await loadIssue(prisma, req, reply, "admin");
    if (!issue) return;
    await prisma.issue.delete({ where: { id: issue.id } });
    return reply.code(204).send();
  });

  app.post("/projects/:id/issues/delete", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const body = z.object({ ids: z.array(z.uuid()).min(1).max(500) }).safeParse(req.body);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if (!body.success) return reply.code(400).send({ detail: "invalid ids (max 500)" });
    if ((await projectRole(prisma, req.user!, p.data.id, "admin")) !== "admin") {
      return reply.code(404).send({ detail: "not found" });
    }
    // projectId di filter: id issue dari project lain diabaikan.
    const r = await prisma.issue.deleteMany({ where: { projectId: p.data.id, id: { in: body.data.ids } } });
    return { deleted: r.count };
  });

  app.patch("/issues/:id", async (req, reply) => {
    const issue = await loadIssue(prisma, req, reply, "member");
    if (!issue) return;
    const body = patchBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ detail: "invalid body" });

    if (body.data.assigneeId) {
      const assignee = await prisma.user.findUnique({ where: { id: body.data.assigneeId }, select: { id: true, username: true, email: true, name: true, isAdmin: true } });
      if (!assignee || !(await projectRole(prisma, assignee, issue.projectId))) {
        return reply.code(400).send({ detail: "assignee must be a project member" });
      }
    }
    await prisma.issue.update({
      where: { id: issue.id },
      data: {
        ...(body.data.status && { status: body.data.status }),
        ...(body.data.assigneeId !== undefined && { assigneeId: body.data.assigneeId }),
      },
    });
    return { ok: true };
  });
}

// Ambil issue + cek akses; kalau gagal sudah membalas 404 dan return null.
async function loadIssue(
  prisma: PrismaClient,
  req: { params: unknown; user: import("../auth/session.js").AuthUser | null },
  reply: import("fastify").FastifyReply,
  min: "viewer" | "member" | "admin" = "viewer",
) {
  const p = idParam.safeParse(req.params);
  const issue = p.success
    ? await prisma.issue.findUnique({
        where: { id: p.data.id },
        include: { assignee: { select: { id: true, username: true, name: true, email: true } } },
      })
    : null;
  const role = issue && (await projectRole(prisma, req.user!, issue.projectId, min));
  if (!issue || !role) {
    reply.code(404).send({ detail: "not found" });
    return null;
  }
  return { ...issue, role };
}

type IssueWithAssignee = {
  id: string; title: string; culprit: string | null; level: string; status: string; eventCount: number;
  firstSeen: Date; lastSeen: Date; assignee: { id: string; username: string; name: string | null; email: string | null } | null;
};

function toIssue(r: IssueWithAssignee) {
  return {
    id: r.id,
    title: r.title,
    culprit: r.culprit,
    level: r.level,
    status: r.status,
    eventCount: r.eventCount,
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    assignee: r.assignee,
  };
}

function toEvent(e: { id: string; receivedAt: Date; timestamp: Date; level: string; release: string | null; environment: string | null; userId: string | null; payload: unknown }) {
  return { id: e.id, receivedAt: e.receivedAt, timestamp: e.timestamp, level: e.level, release: e.release, environment: e.environment, userId: e.userId, payload: e.payload };
}
