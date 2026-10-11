import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@bugtool/db";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { endSession, requireUser, startSession } from "../auth/session.js";
import { hashToken } from "../auth/tokens.js";
import { USERNAME_HINT, USERNAME_RE } from "../auth/users.js";

// Login dengan username atau email (field lama "email" tetap diterima).
const loginBody = z.object({
  login: z.string().trim().toLowerCase().min(1).max(200).optional(),
  email: z.string().trim().toLowerCase().min(1).max(200).optional(),
  password: z.string().min(1).max(200),
}).refine((b) => b.login || b.email);
// Akun baru dari undangan: username + password wajib, nama dan email opsional.
const acceptBody = z.object({
  username: z.string().trim().toLowerCase().regex(USERNAME_RE, `username: ${USERNAME_HINT}`),
  name: z.string().trim().max(100).optional(),
  email: z.union([z.literal(""), z.email().toLowerCase()]).optional(),
  password: z.string().min(10, "password must be at least 10 characters").max(200),
});
const userView = (u: { id: string; username: string; email: string | null; name: string | null; isAdmin: boolean }) =>
  ({ id: u.id, username: u.username, email: u.email, name: u.name, isAdmin: u.isAdmin });

// Hash dummy supaya waktu respons login sama untuk akun yang tidak terdaftar.
const DUMMY_HASH = await hashPassword("dummy-password-for-timing");

export async function authRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  app.post("/auth/login", async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ detail: "invalid body" });
    const login = (body.data.login ?? body.data.email)!;
    const user = await prisma.user.findUnique({ where: login.includes("@") ? { email: login } : { username: login } });
    const ok = await verifyPassword(body.data.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user?.passwordHash || !ok) return reply.code(401).send({ detail: "incorrect username or password" });
    await startSession(prisma, reply, user.id);
    return userView(user);
  });

  app.post("/auth/logout", async (req, reply) => {
    await endSession(prisma, req, reply);
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: requireUser }, async (req) => req.user);

  // Publik: info undangan untuk layar "terima undangan". Undangan dengan email yang sudah punya akun
  // harus diterima oleh akun itu (login dulu); undangan tanpa email bisa membuat akun baru atau dipakai
  // oleh siapa pun yang sedang login.
  app.get<{ Params: { token: string } }>("/invites/:token", async (req, reply) => {
    const invite = await findOpenInvite(prisma, req.params.token);
    if (!invite) return reply.code(404).send({ detail: "invite is invalid or has expired" });
    const existing = invite.email ? await prisma.user.findUnique({ where: { email: invite.email }, select: { passwordHash: true } }) : null;
    return {
      email: invite.email,
      role: invite.role,
      project: { id: invite.project.id, name: invite.project.name },
      hasAccount: Boolean(existing?.passwordHash),
    };
  });

  // Terima undangan (sekali pakai).
  //  - Sedang login: bergabung sebagai akun itu (kalau undangan menyebut email, harus akun dengan email itu).
  //  - Belum login: buat akun baru dengan username + password (email opsional); email undangan yang sudah
  //    punya akun harus login dulu.
  app.post<{ Params: { token: string } }>("/invites/:token/accept", async (req, reply) => {
    const invite = await findOpenInvite(prisma, req.params.token);
    if (!invite) return reply.code(404).send({ detail: "invite is invalid or has expired" });

    const owner = invite.email ? await prisma.user.findUnique({ where: { email: invite.email } }) : null;
    let userId: string;
    if (req.user) {
      if (invite.email && req.user.email !== invite.email) return reply.code(403).send({ detail: `sign in as ${invite.email} to accept` });
      userId = req.user.id;
    } else if (owner?.passwordHash) {
      return reply.code(403).send({ detail: `sign in as ${invite.email} to accept` });
    } else {
      const body = acceptBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ detail: body.error.issues[0]?.message ?? "invalid body" });
      const email = invite.email ?? (body.data.email || null);
      if (await prisma.user.findUnique({ where: { username: body.data.username }, select: { id: true } })) {
        return reply.code(409).send({ detail: "username is already taken" });
      }
      if (email && !owner && (await prisma.user.findUnique({ where: { email }, select: { id: true } }))) {
        return reply.code(409).send({ detail: "an account with this email already exists; sign in to accept" });
      }
      const passwordHash = await hashPassword(body.data.password);
      // Akun email undangan tanpa password (dibuat lama sebelum login) diambil alih; selain itu akun baru.
      const user = owner
        ? await prisma.user.update({ where: { id: owner.id }, data: { username: body.data.username, passwordHash, name: body.data.name ?? owner.name } })
        : await prisma.user.create({ data: { username: body.data.username, email, passwordHash, name: body.data.name ?? null } });
      userId = user.id;
    }

    // Sekali pakai: tandai dipakai hanya kalau belum dipakai (dua klik bersamaan tidak sama-sama lolos).
    const claimed = await prisma.invite.updateMany({ where: { id: invite.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
    if (claimed.count === 0) return reply.code(404).send({ detail: "invite is invalid or has expired" });
    await prisma.member.upsert({
      where: { projectId_userId: { projectId: invite.projectId, userId } },
      update: { role: invite.role },
      create: { projectId: invite.projectId, userId, role: invite.role },
    });
    if (!req.user) await startSession(prisma, reply, userId);
    return { projectId: invite.projectId };
  });
}

async function findOpenInvite(prisma: PrismaClient, token: string) {
  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { project: { select: { id: true, name: true } } },
  });
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) return null;
  return invite;
}
