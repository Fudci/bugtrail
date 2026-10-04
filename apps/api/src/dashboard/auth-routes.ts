import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@bugtool/db";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { endSession, requireUser, startSession } from "../auth/session.js";
import { hashToken } from "../auth/tokens.js";

const loginBody = z.object({ email: z.email().toLowerCase(), password: z.string().min(1).max(200) });
const acceptBody = z.object({ name: z.string().trim().max(100).optional(), password: z.string().min(10).max(200) });

// Hash dummy supaya waktu respons login sama untuk email yang tidak terdaftar.
const DUMMY_HASH = await hashPassword("dummy-password-for-timing");

export async function authRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  app.post("/auth/login", async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ detail: "invalid body" });
    const user = await prisma.user.findUnique({ where: { email: body.data.email } });
    const ok = await verifyPassword(body.data.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user?.passwordHash || !ok) return reply.code(401).send({ detail: "incorrect email or password" });
    await startSession(prisma, reply, user.id);
    return { id: user.id, email: user.email, name: user.name, isAdmin: user.isAdmin };
  });

  app.post("/auth/logout", async (req, reply) => {
    await endSession(prisma, req, reply);
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: requireUser }, async (req) => req.user);

  // Publik: info undangan untuk layar "terima undangan".
  app.get<{ Params: { token: string } }>("/invites/:token", async (req, reply) => {
    const invite = await findOpenInvite(prisma, req.params.token);
    if (!invite) return reply.code(404).send({ detail: "invite is invalid or has expired" });
    const existing = await prisma.user.findUnique({ where: { email: invite.email }, select: { passwordHash: true } });
    return {
      email: invite.email,
      role: invite.role,
      project: { id: invite.project.id, name: invite.project.name },
      hasAccount: Boolean(existing?.passwordHash),
    };
  });

  // Terima undangan. Akun baru: set password di sini. Akun lama: harus login dulu sebagai email tersebut.
  app.post<{ Params: { token: string } }>("/invites/:token/accept", async (req, reply) => {
    const invite = await findOpenInvite(prisma, req.params.token);
    if (!invite) return reply.code(404).send({ detail: "invite is invalid or has expired" });

    const existing = await prisma.user.findUnique({ where: { email: invite.email } });
    let userId: string;
    if (existing?.passwordHash) {
      if (req.user?.id !== existing.id) return reply.code(403).send({ detail: "sign in as " + invite.email + " to accept" });
      userId = existing.id;
    } else {
      const body = acceptBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ detail: "password must be at least 10 characters" });
      const passwordHash = await hashPassword(body.data.password);
      const user = await prisma.user.upsert({
        where: { email: invite.email },
        update: { passwordHash, name: body.data.name ?? existing?.name ?? null },
        create: { email: invite.email, passwordHash, name: body.data.name ?? null },
      });
      userId = user.id;
    }

    await prisma.$transaction([
      prisma.member.upsert({
        where: { projectId_userId: { projectId: invite.projectId, userId } },
        update: { role: invite.role },
        create: { projectId: invite.projectId, userId, role: invite.role },
      }),
      prisma.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } }),
    ]);
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
