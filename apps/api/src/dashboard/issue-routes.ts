import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma, toDbDate, type PrismaClient } from "@bugtool/db";
import { projectRole, requireUser } from "../auth/session.js";
import { toCsv } from "./csv.js";
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
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const eventsQuery = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
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

// Cari issue lewat isi event (FTS5). Tiap kata jadi prefix-term yang di-quote, supaya input user
// tidak bisa membentuk sintaks FTS (mis. "user.id" atau tanda kutip) yang membuat query error.
async function searchIssueIds(prisma: PrismaClient, projectId: string, query: string) {
  const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8) ?? [];
  if (terms.length === 0) return [];
  const match = terms.map((t) => `"${t}"*`).join(" ");
  const rows = await prisma.$queryRaw<{ issue_id: string }[]>`
    SELECT DISTINCT issue_id FROM events_fts WHERE events_fts MATCH ${match} AND project_id = ${projectId} LIMIT 1000`;
  return rows.map((r) => r.issue_id);
}

type IssueFilter = Pick<z.infer<typeof listQuery>, "status" | "level" | "query" | "release" | "firstRelease">;

// Filter halaman Issues; dipakai juga oleh ekspor CSV supaya hasilnya sama dengan yang dilihat user.
async function issueFilter(prisma: PrismaClient, projectId: string, f: IssueFilter): Promise<Prisma.IssueWhereInput> {
  const ids = f.query ? await searchIssueIds(prisma, projectId, f.query) : null;
  return {
    projectId,
    ...(f.status !== "all" && { status: f.status }),
    ...(f.level && { level: f.level }),
    ...(f.release && { events: { some: { release: f.release } } }),
    ...(f.firstRelease && { firstRelease: f.firstRelease }),
    // SQLite LIKE (dipakai `contains`) tidak peka huruf besar/kecil untuk ASCII.
    ...(f.query && { OR: [{ title: { contains: f.query } }, { id: { in: ids ?? [] } }] }),
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

    const { status, level, query, limit, release, firstRelease } = q.data;
    const cursor = q.data.cursor ? decodeCursor(q.data.cursor) : null;
    if (q.data.cursor && !cursor) return reply.code(400).send({ detail: "invalid cursor" });

    const rows = await prisma.issue.findMany({
      where: {
        ...(await issueFilter(prisma, p.data.id, { status, level, query, release, firstRelease })),
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
        WHERE project_id = ${p.data.id} AND user_id IS NOT NULL GROUP BY issue_id`;
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
    const latest = await prisma.event.findFirst({
      where: { issueId: issue.id },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    });
    const [userCount] = await prisma.$queryRaw<{ n: bigint | number }[]>`
      SELECT COUNT(DISTINCT user_id) AS n FROM events WHERE issue_id = ${issue.id} AND user_id IS NOT NULL`;
    const v = latest ? viewEvent(issue.projectId, latest) : null;
    return {
      ...issue,
      userCount: Number(userCount?.n ?? 0),
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
    // SQLite: kolom biasa di samping MAX() mengambil baris yang MAX-nya (event terakhir user itu).
    const rows = await prisma.$queryRaw<{ user_id: string; events: bigint | number; last_seen: string; last_event_id: string }[]>`
      SELECT user_id, COUNT(*) AS events, MAX(received_at) AS last_seen, id AS last_event_id
      FROM events WHERE issue_id = ${issue.id} AND user_id IS NOT NULL
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
    const cursor = q.data.cursor ? decodeCursor(q.data.cursor) : null;
    if (q.data.cursor && !cursor) return reply.code(400).send({ detail: "invalid cursor" });

    const events = await prisma.event.findMany({
      where: {
        issueId: issue.id,
        ...(cursor && {
          OR: [{ receivedAt: { lt: cursor.at } }, { receivedAt: cursor.at, id: { lt: cursor.id } }],
        }),
      },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: q.data.limit + 1,
      select: { id: true, receivedAt: true, timestamp: true, level: true, release: true, environment: true, userId: true },
    });
    const page = events.slice(0, q.data.limit);
    const last = page.at(-1);
    // Ringkasan device per event langsung dari JSON payload (tanpa memuat payload utuh).
    const extra = page.length
      ? await prisma.$queryRaw<{ id: string; model: string | null; manufacturer: string | null; os: string | null; online: number | null; connection: string | null }[]>`
          SELECT id,
            json_extract(payload, '$.contexts.device.model') AS model,
            json_extract(payload, '$.contexts.device.manufacturer') AS manufacturer,
            trim(coalesce(json_extract(payload, '$.contexts.os.name'), '') || ' ' || coalesce(json_extract(payload, '$.contexts.os.version'), '')) AS os,
            json_extract(payload, '$.contexts.device.online') AS online,
            json_extract(payload, '$.contexts.device.connection_type') AS connection
          FROM events WHERE id IN (${Prisma.join(page.map((p) => p.id))})`
      : [];
    const byId = new Map(extra.map((x) => [x.id, x]));
    return {
      events: page.map((ev) => {
        const x = byId.get(ev.id);
        return {
          ...ev,
          device: x ? [x.manufacturer, x.model].filter(Boolean).join(" ") || null : null,
          os: x?.os || null,
          online: x?.online == null ? null : Boolean(x.online),
          connection: x?.connection ?? null,
        };
      }),
      nextCursor: events.length > q.data.limit && last ? encodeCursor(last.receivedAt, last.id) : null,
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
