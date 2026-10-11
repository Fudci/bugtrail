import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { toDbDate, type PrismaClient } from "@bugtool/db";
import { hashPassword } from "../auth/password.js";
import { projectRole, requireUser, startSession, type AuthUser } from "../auth/session.js";
import { hashToken, newToken } from "../auth/tokens.js";

// Lupa password tanpa email: admin membuat link reset dari daftar member, mengirimnya sendiri,
// lalu user mengisi password baru. Link sekali pakai, berlaku 24 jam; link baru membatalkan yang lama.
// Setelah reset, semua sesi user itu diakhiri (perangkat lain harus login ulang).
const RESET_TTL_MS = 24 * 60 * 60 * 1000;
const webUrl = () => process.env["WEB_URL"] ?? "http://localhost:5173";
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });
const resetBody = z.object({ password: z.string().min(10, "password must be at least 10 characters").max(200) });

/**
 * Boleh membuat link reset? Admin global: siapa saja. Admin project: hanya user yang bukan admin global
 * dan yang semua project-nya juga dia kelola (supaya admin satu project tidak bisa mengambil alih
 * akun yang punya akses lebih luas).
 */
async function canReset(prisma: PrismaClient, actor: AuthUser, target: { id: string; isAdmin: boolean }) {
  if (actor.isAdmin) return true;
  if (target.isAdmin || target.id === actor.id) return false;
  const projects = await prisma.member.findMany({ where: { userId: target.id }, select: { projectId: true } });
  for (const { projectId } of projects) {
    if ((await projectRole(prisma, actor, projectId, "admin")) !== "admin") return false;
  }
  return true;
}

async function openReset(prisma: PrismaClient, token: string) {
  const [row] = await prisma.$queryRawUnsafe<{ id: string; user_id: string }[]>(
    "SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
    hashToken(token), toDbDate(new Date()));
  return row ?? null;
}

export async function passwordResetRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  // Admin: buat link reset untuk satu member project.
  app.post("/projects/:id/members/:userId/password-reset", { preHandler: requireUser }, async (req, reply) => {
    const p = memberParams.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ detail: "not found" });
    if ((await projectRole(prisma, req.user!, p.data.id, "admin")) !== "admin") return reply.code(404).send({ detail: "not found" });
    const member = await prisma.member.findUnique({
      where: { projectId_userId: { projectId: p.data.id, userId: p.data.userId } },
      select: { user: { select: { id: true, username: true, isAdmin: true } } },
    });
    if (!member) return reply.code(404).send({ detail: "not found" });
    if (member.user.id === req.user!.id) return reply.code(400).send({ detail: "change your own password with create-admin.js or ask another admin" });
    if (!(await canReset(prisma, req.user!, member.user))) {
      return reply.code(403).send({ detail: "only a global admin can reset this account (it is an admin or belongs to projects you don't manage)" });
    }
    const token = newToken();
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);
    await prisma.$transaction([
      // Link lama yang belum dipakai tidak berlaku lagi.
      prisma.$executeRawUnsafe("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL", member.user.id),
      prisma.$executeRawUnsafe(`INSERT INTO password_resets (id, user_id, token_hash, created_by_id, expires_at) VALUES (?, ?, ?, ?, ?)`,
        randomUUID(), member.user.id, hashToken(token), req.user!.id, toDbDate(expiresAt)),
    ]);
    // Link hanya dikembalikan sekali di sini; DB menyimpan hash-nya saja.
    return reply.code(201).send({ username: member.user.username, expiresAt, link: `${webUrl()}/reset-password/${token}` });
  });

  // Publik: info link untuk halaman reset.
  app.get<{ Params: { token: string } }>("/password-reset/:token", async (req, reply) => {
    const r = await openReset(prisma, req.params.token);
    if (!r) return reply.code(404).send({ detail: "reset link is invalid or has expired" });
    const user = await prisma.user.findUnique({ where: { id: r.user_id }, select: { username: true } });
    return { username: user?.username };
  });

  // Publik: set password baru, akhiri semua sesi lama, lalu login di browser ini.
  app.post<{ Params: { token: string } }>("/password-reset/:token", async (req, reply) => {
    const body = resetBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ detail: body.error.issues[0]?.message ?? "invalid body" });
    const r = await openReset(prisma, req.params.token);
    if (!r) return reply.code(404).send({ detail: "reset link is invalid or has expired" });
    // Sekali pakai: hanya satu permintaan yang berhasil menandai link ini.
    const claimed = await prisma.$executeRawUnsafe("UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL", toDbDate(new Date()), r.id);
    if (!claimed) return reply.code(404).send({ detail: "reset link is invalid or has expired" });
    const passwordHash = await hashPassword(body.data.password);
    await prisma.$transaction([
      prisma.user.update({ where: { id: r.user_id }, data: { passwordHash } }),
      prisma.session.deleteMany({ where: { userId: r.user_id } }),
    ]);
    await startSession(prisma, reply, r.user_id);
    return { ok: true };
  });
}
