import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@bugtool/db";
import { projectRole, requireUser } from "../auth/session.js";
import { hashToken } from "../auth/tokens.js";

const idParam = z.object({ id: z.uuid() });

// Token unggah source map (dipakai sentry-cli) dan daftar artifact. Semua khusus admin project.
export async function sourcemapRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  app.addHook("preHandler", requireUser);

  async function admin(params: unknown, user: Parameters<typeof projectRole>[1]) {
    const p = idParam.safeParse(params);
    if (!p.success) return null;
    return (await projectRole(prisma, user, p.data.id, "admin")) === "admin" ? p.data.id : null;
  }

  app.get("/projects/:id/upload-tokens", async (req, reply) => {
    const pid = await admin(req.params, req.user!);
    if (!pid) return reply.code(404).send({ detail: "not found" });
    return prisma.uploadToken.findMany({
      where: { projectId: pid },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, createdAt: true, lastUsedAt: true, createdBy: { select: { email: true } } },
    });
  });

  app.post("/projects/:id/upload-tokens", async (req, reply) => {
    const pid = await admin(req.params, req.user!);
    if (!pid) return reply.code(404).send({ detail: "not found" });
    const body = z.object({ name: z.string().trim().min(1).max(100) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ detail: "token name is required" });
    // 64 hex, sama dengan format token lama Sentry (aman untuk validasi format di sentry-cli).
    const token = randomBytes(32).toString("hex");
    const t = await prisma.uploadToken.create({
      data: { projectId: pid, name: body.data.name, tokenHash: hashToken(token), createdById: req.user!.id },
    });
    // Token mentah hanya dikembalikan sekali ini.
    return reply.code(201).send({ id: t.id, name: t.name, token });
  });

  app.delete("/projects/:id/upload-tokens/:tokenId", async (req, reply) => {
    const pid = await admin(req.params, req.user!);
    const t = z.object({ tokenId: z.uuid() }).safeParse(req.params);
    if (!pid || !t.success) return reply.code(404).send({ detail: "not found" });
    await prisma.uploadToken.deleteMany({ where: { id: t.data.tokenId, projectId: pid } });
    return reply.code(204).send();
  });

  app.get("/projects/:id/artifacts", async (req, reply) => {
    const pid = await admin(req.params, req.user!);
    if (!pid) return reply.code(404).send({ detail: "not found" });
    const [items, count, agg] = await Promise.all([
      prisma.artifact.findMany({
        where: { projectId: pid, fileType: "source_map" },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, debugId: true, url: true, size: true, createdAt: true, lastUsedAt: true },
      }),
      prisma.artifact.count({ where: { projectId: pid, fileType: "source_map" } }),
      // Total ukuran termasuk bundle JS (minified_source) yang ikut diunggah sentry-cli.
      prisma.artifact.aggregate({ where: { projectId: pid }, _sum: { size: true } }),
    ]);
    return { items, count, totalBytes: agg._sum.size ?? 0 };
  });

  app.delete("/projects/:id/artifacts/:artifactId", async (req, reply) => {
    const pid = await admin(req.params, req.user!);
    const a = z.object({ artifactId: z.uuid() }).safeParse(req.params);
    if (!pid || !a.success) return reply.code(404).send({ detail: "not found" });
    const art = await prisma.artifact.findFirst({ where: { id: a.data.artifactId, projectId: pid }, select: { debugId: true } });
    if (art) await prisma.artifact.deleteMany({ where: { projectId: pid, debugId: art.debugId } });
    return reply.code(204).send();
  });
}
