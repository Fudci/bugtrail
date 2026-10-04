import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { PrismaClient, Role } from "@bugtool/db";
import { hashToken, newToken } from "./tokens.js";

export const SESSION_COOKIE = "bt_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

const cookieOpts = () => ({
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  // Secure hanya saat diakses lewat HTTPS; kalau tidak, browser menolak cookie di http://.
  secure: (process.env["PUBLIC_URL"] ?? "").startsWith("https://"),
});

export async function startSession(prisma: PrismaClient, reply: FastifyReply, userId: string) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({ data: { id: hashToken(token), userId, expiresAt } });
  reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts(), expires: expiresAt });
}

export async function endSession(prisma: PrismaClient, req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await prisma.session.deleteMany({ where: { id: hashToken(token) } });
  reply.clearCookie(SESSION_COOKIE, cookieOpts());
}

// Mengisi req.user dari cookie sesi (null kalau tidak login / kedaluwarsa).
export const sessionPlugin = fp(async (app: FastifyInstance, opts: { prisma: PrismaClient }) => {
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = await opts.prisma.session.findUnique({
      where: { id: hashToken(token) },
      include: { user: { select: { id: true, email: true, name: true, isAdmin: true } } },
    });
    if (!session) return;
    if (session.expiresAt < new Date()) {
      await opts.prisma.session.delete({ where: { id: session.id } }).catch(() => {});
      return;
    }
    req.user = session.user;
  });
});

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ detail: "not authenticated" });
}

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2 };

// Akses project berdasarkan keanggotaan; admin global boleh semua.
// Return role efektif, atau null (route harus balas 404 supaya keberadaan project tidak bocor).
export async function projectRole(
  prisma: PrismaClient,
  user: AuthUser,
  projectId: string,
  min: Role = "viewer",
): Promise<Role | null> {
  if (user.isAdmin) {
    const exists = await prisma.project.count({ where: { id: projectId } });
    return exists ? "admin" : null;
  }
  const m = await prisma.member.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
    select: { role: true },
  });
  if (!m || RANK[m.role] < RANK[min]) return null;
  return m.role;
}
