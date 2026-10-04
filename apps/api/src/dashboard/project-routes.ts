import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@bugtool/db";
import { projectRole, requireUser } from "../auth/session.js";
import { hashToken, newToken } from "../auth/tokens.js";
import { keyCache } from "../ingest/key-cache.js";
import { DISCORD_WEBHOOK_RE, type Alerter } from "../process/alerts.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const publicUrl = () => new URL(process.env["PUBLIC_URL"] ?? `http://localhost:${process.env["API_PORT"] ?? 4000}`);
const webUrl = () => process.env["WEB_URL"] ?? "http://localhost:5173";

// Project ID di DSN harus angka (SDK Sentry: projectId.match(/^\d+/)), jadi pakai publicId.
export function dsnFor(publicKey: string, publicId: number) {
  const u = publicUrl();
  const path = u.pathname.replace(/\/$/, "");
  return `${u.protocol}//${publicKey}@${u.host}${path}/${publicId}`;
}

const idParam = z.object({ id: z.uuid() });
const createBody = z.object({
  name: z.string().trim().min(1).max(100),
  platform: z.string().trim().max(50).optional(),
});
const inviteBody = z.object({ email: z.email().toLowerCase(), role: z.enum(["admin", "member", "viewer"]).default("member") });
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });
const roleBody = z.object({ role: z.enum(["admin", "member", "viewer"]) });

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "project";

const settingsBody = z.object({
  retentionMaxEvents: z.number().int().min(100).max(10_000_000).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
});

function dbSizeBytes(dbPath: string | undefined) {
  if (!dbPath) return null;
  return ["", "-wal"].reduce((n, suf) => {
    try {
      return n + statSync(dbPath + suf).size;
    } catch {
      return n;
    }
  }, 0);
}

const alertsBody = z.object({
  // null = matikan alert; undefined = tidak diubah (URL lama tetap).
  discordWebhookUrl: z.string().trim().regex(DISCORD_WEBHOOK_RE, "invalid Discord webhook URL").nullable().optional(),
  alertNewIssue: z.boolean().optional(),
  alertRegression: z.boolean().optional(),
  alertSpikeThreshold: z.number().int().min(1).max(1_000_000).nullable().optional(),
  alertSpikeMinutes: z.number().int().min(1).max(1440).optional(),
});

// URL webhook = kredensial (siapa pun yang tahu bisa kirim pesan ke channel). Jangan kirim utuh ke browser.
const maskWebhook = (url: string | null) => (url ? url.replace(/\/[\w-]+$/, (t) => `/••••${t.slice(-4)}`) : null);

export async function projectRoutes(
  app: FastifyInstance,
  { prisma, dbPath, alerter }: { prisma: PrismaClient; dbPath?: string | undefined; alerter?: Alerter | undefined },
) {
  app.addHook("preHandler", requireUser);

  app.get("/projects", async (req) => {
    const user = req.user!;
    const projects = await prisma.project.findMany({
      where: user.isAdmin ? {} : { members: { some: { userId: user.id } } },
      orderBy: { createdAt: "asc" },
      include: {
        members: { where: { userId: user.id }, select: { role: true } },
        _count: { select: { issues: { where: { status: "unresolved" } } } },
      },
    });
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      platform: p.platform,
      createdAt: p.createdAt,
      role: user.isAdmin ? "admin" : (p.members[0]?.role ?? "viewer"),
      unresolvedIssues: p._count.issues,
    }));
  });

  app.post("/projects", async (req, reply) => {
    const user = req.user!;
    if (!user.isAdmin) return reply.code(403).send({ detail: "only admins can create projects" });
    const body = createBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ detail: "project name is required" });

    const org =
      (await prisma.organization.findFirst({ orderBy: { createdAt: "asc" } })) ??
      (await prisma.organization.create({ data: { name: "Default", slug: "default" } }));
    const base = slugify(body.data.name);
    const taken = await prisma.project.count({ where: { organizationId: org.id, slug: { startsWith: base } } });
    const slug = taken ? `${base}-${randomBytes(3).toString("hex")}` : base;

    // Nomor publik berikutnya; kalau bentrok dengan pembuatan project lain bersamaan, coba lagi.
    let project;
    for (let attempt = 0; ; attempt++) {
      const max = await prisma.project.aggregate({ _max: { publicId: true } });
      try {
        project = await prisma.project.create({
          data: {
            organizationId: org.id,
            name: body.data.name,
            slug,
            platform: body.data.platform ?? null,
            publicId: (max._max.publicId ?? 0) + 1,
            members: { create: { userId: user.id, role: "admin" } },
            dsnKeys: { create: { publicKey: randomBytes(16).toString("hex") } },
          },
          include: { dsnKeys: true },
        });
        break;
      } catch (err) {
        if (attempt < 5 && (err as { code?: string }).code === "P2002") continue;
        throw err;
      }
    }
    return reply.code(201).send({
      id: project.id,
      name: project.name,
      slug: project.slug,
      platform: project.platform,
      dsn: dsnFor(project.dsnKeys[0]!.publicKey, project.publicId!),
    });
  });

  app.get("/projects/:id", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    const role = await projectRole(prisma, req.user!, p.data.id);
    if (!role) return reply.code(404).send({ detail: "not found" });
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: p.data.id },
      include: { dsnKeys: { where: { revokedAt: null }, orderBy: { createdAt: "asc" } } },
    });
    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      platform: project.platform,
      role,
      // Viewer tidak perlu DSN.
      dsnKeys: role === "viewer" ? [] : project.dsnKeys.map((k) => ({ id: k.id, label: k.label, dsn: dsnFor(k.publicKey, project.publicId!) })),
      retentionMaxEvents: project.retentionMaxEvents,
      retentionDays: project.retentionDays,
      alerts: role === "admin" ? {
        discordWebhook: maskWebhook(project.discordWebhookUrl),
        newIssue: project.alertNewIssue,
        regression: project.alertRegression,
        spikeThreshold: project.alertSpikeThreshold,
        spikeMinutes: project.alertSpikeMinutes,
      } : null,
    };
  });

  // Statistik penyimpanan (admin project). Ukuran file DB = seluruh instalasi, bukan per project.
  app.get("/projects/:id/stats", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if ((await projectRole(prisma, req.user!, p.data.id, "admin")) !== "admin") return reply.code(404).send({ detail: "not found" });
    const [events, issues, oldest] = await Promise.all([
      prisma.event.count({ where: { projectId: p.data.id } }),
      prisma.issue.count({ where: { projectId: p.data.id } }),
      prisma.event.findFirst({ where: { projectId: p.data.id }, orderBy: { receivedAt: "asc" }, select: { receivedAt: true } }),
    ]);
    return { events, issues, oldestEventAt: oldest?.receivedAt ?? null, dbSizeBytes: dbSizeBytes(dbPath) };
  });

  app.patch("/projects/:id/settings", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if ((await projectRole(prisma, req.user!, p.data.id, "admin")) !== "admin") return reply.code(404).send({ detail: "not found" });
    const body = settingsBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ detail: "retention: 100–10,000,000 events, 1–3650 days" });
    const data = Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined));
    await prisma.project.update({ where: { id: p.data.id }, data });
    return { ok: true };
  });

  app.patch("/projects/:id/alerts", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if ((await projectRole(prisma, req.user!, p.data.id, "admin")) !== "admin") return reply.code(404).send({ detail: "not found" });
    const body = alertsBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ detail: body.error.issues[0]?.message ?? "invalid body" });
    const data = Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined));
    await prisma.project.update({ where: { id: p.data.id }, data });
    return { ok: true };
  });

  // Kirim pesan tes ke webhook tersimpan (atau URL baru yang belum disimpan).
  app.post("/projects/:id/alerts/test", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if ((await projectRole(prisma, req.user!, p.data.id, "admin")) !== "admin") return reply.code(404).send({ detail: "not found" });
    const body = z.object({ discordWebhookUrl: z.string().trim().regex(DISCORD_WEBHOOK_RE).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ detail: "invalid Discord webhook URL" });
    const project = await prisma.project.findUniqueOrThrow({ where: { id: p.data.id }, select: { name: true, discordWebhookUrl: true } });
    const url = body.data.discordWebhookUrl ?? project.discordWebhookUrl;
    if (!url) return reply.code(400).send({ detail: "no webhook configured" });
    if (!alerter) return reply.code(503).send({ detail: "alerts are disabled" });
    try {
      const r = await alerter.test(url, project.name);
      if (!r.ok) return reply.code(502).send({ detail: `Discord responded with ${r.status}` });
      return { ok: true };
    } catch {
      return reply.code(502).send({ detail: "could not reach Discord" });
    }
  });

  // Hapus project beserta semua issue/event/anggota/DSN (cascade). Hanya admin global.
  app.delete("/projects/:id", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if (!req.user!.isAdmin) return reply.code(403).send({ detail: "only admins can delete projects" });
    const r = await prisma.project.deleteMany({ where: { id: p.data.id } });
    if (!r.count) return reply.code(404).send({ detail: "not found" });
    keyCache.clear(); // DSN project ini langsung ditolak, tidak menunggu TTL cache

    return reply.code(204).send();
  });

  app.get("/projects/:id/members", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    const role = await projectRole(prisma, req.user!, p.data.id);
    if (!role) return reply.code(404).send({ detail: "not found" });
    const members = await prisma.member.findMany({
      where: { projectId: p.data.id },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    const invites =
      role === "admin"
        ? await prisma.invite.findMany({
            where: { projectId: p.data.id, acceptedAt: null, expiresAt: { gt: new Date() } },
            orderBy: { createdAt: "desc" },
            select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
          })
        : [];
    return { members: members.map((m) => ({ ...m.user, role: m.role, joinedAt: m.createdAt })), invites };
  });

  app.post("/projects/:id/invites", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if ((await projectRole(prisma, req.user!, p.data.id, "admin")) !== "admin") {
      return reply.code(404).send({ detail: "not found" });
    }
    const body = inviteBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ detail: "invalid email" });

    const already = await prisma.member.count({ where: { projectId: p.data.id, user: { email: body.data.email } } });
    if (already) return reply.code(409).send({ detail: "already a member" });

    const token = newToken();
    const invite = await prisma.invite.create({
      data: {
        projectId: p.data.id,
        email: body.data.email,
        role: body.data.role,
        tokenHash: hashToken(token),
        invitedById: req.user!.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    // Link hanya dikembalikan sekali di sini; DB menyimpan hash-nya saja.
    return reply.code(201).send({ id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt, link: `${webUrl()}/invite/${token}` });
  });

  app.delete("/projects/:id/invites/:inviteId", async (req, reply) => {
    const p = z.object({ id: z.uuid(), inviteId: z.uuid() }).safeParse(req.params);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if ((await projectRole(prisma, req.user!, p.data.id, "admin")) !== "admin") {
      return reply.code(404).send({ detail: "not found" });
    }
    await prisma.invite.deleteMany({ where: { id: p.data.inviteId, projectId: p.data.id } });
    return reply.code(204).send();
  });

  app.patch("/projects/:id/members/:userId", async (req, reply) => {
    const p = memberParams.safeParse(req.params);
    const body = roleBody.safeParse(req.body);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if (!body.success) return reply.code(400).send({ detail: "invalid role" });
    if ((await projectRole(prisma, req.user!, p.data.id, "admin")) !== "admin") {
      return reply.code(404).send({ detail: "not found" });
    }
    if (body.data.role !== "admin" && (await isLastAdmin(prisma, p.data.id, p.data.userId))) {
      return reply.code(409).send({ detail: "a project must have at least one admin" });
    }
    const res = await prisma.member.updateMany({ where: { projectId: p.data.id, userId: p.data.userId }, data: { role: body.data.role } });
    if (!res.count) return reply.code(404).send({ detail: "not found" });
    return { ok: true };
  });

  app.delete("/projects/:id/members/:userId", async (req, reply) => {
    const p = memberParams.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if ((await projectRole(prisma, req.user!, p.data.id, "admin")) !== "admin") {
      return reply.code(404).send({ detail: "not found" });
    }
    if (await isLastAdmin(prisma, p.data.id, p.data.userId)) {
      return reply.code(409).send({ detail: "a project must have at least one admin" });
    }
    await prisma.member.deleteMany({ where: { projectId: p.data.id, userId: p.data.userId } });
    return reply.code(204).send();
  });
}

async function isLastAdmin(prisma: PrismaClient, projectId: string, userId: string) {
  const admins = await prisma.member.findMany({ where: { projectId, role: "admin" }, select: { userId: true } });
  return admins.length === 1 && admins[0]!.userId === userId;
}
