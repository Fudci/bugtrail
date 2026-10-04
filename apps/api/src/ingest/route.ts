import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@bugtool/db";
import type { IngestJob } from "../process/persist.js";
import { BacklogFullError, type IngestStore } from "../process/store.js";
import { extractPublicKey } from "./auth.js";
import { keyCache } from "./key-cache.js";
import { decompress, EnvelopeError, MAX_ENVELOPE_BYTES, MAX_EVENT_BYTES, parseEnvelope } from "./envelope.js";


const eventSchema = z.looseObject({
  event_id: z.string().regex(/^[0-9a-fA-F]{32}$|^[0-9a-fA-F-]{36}$/),
});

// DSN baru memakai nomor project (angka); UUID tetap diterima untuk DSN lama.
const paramsSchema = z.object({ projectId: z.union([z.uuid(), z.string().regex(/^\d{1,9}$/)]) });

export async function ingestRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; store: IngestStore }) {
  const { prisma, store } = opts;

  // Return UUID project kalau key sah untuk project (nomor publik atau UUID) itu, null kalau tidak.
  async function resolveProject(publicKey: string, ref: string): Promise<string | null> {
    const k = `${ref}:${publicKey}`;
    const hit = keyCache.get(k);
    if (hit !== undefined) return hit;
    const key = await prisma.dsnKey.findFirst({
      where: { publicKey, revokedAt: null, project: /^\d+$/.test(ref) ? { publicId: Number(ref) } : { id: ref } },
      select: { projectId: true },
    });
    const projectId = key?.projectId ?? null;
    keyCache.set(k, projectId);
    return projectId;
  }

  // SDK browser mengirim dari origin mana pun; auth tetap lewat DSN key, bukan cookie.
  await app.register(cors, {
    origin: true,
    methods: ["POST"],
    allowedHeaders: ["content-type", "content-encoding", "x-sentry-auth"],
    credentials: false,
  });

  // Body envelope bisa text/plain, x-sentry-envelope, dll. — ambil mentah sebagai Buffer.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_ENVELOPE_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  app.post("/api/:projectId/envelope/", async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ detail: "unknown project" });
    const projectRef = params.data.projectId;

    let envelope;
    try {
      const raw = decompress(req.body as Buffer, req.headers["content-encoding"]);
      envelope = parseEnvelope(raw);
    } catch (err) {
      if (err instanceof EnvelopeError) return reply.code(400).send({ detail: err.message });
      throw err;
    }

    const publicKey = extractPublicKey({
      authHeader: req.headers["x-sentry-auth"] as string | undefined,
      queryKey: (req.query as Record<string, string | undefined>)["sentry_key"],
      envelopeDsn: envelope.headers["dsn"],
    });
    if (!publicKey) return reply.code(403).send({ detail: "missing authorization" });

    const projectId = await resolveProject(publicKey, projectRef);
    if (!projectId) return reply.code(403).send({ detail: "invalid key" });

    const receivedAt = new Date().toISOString();
    let id = typeof envelope.headers["event_id"] === "string" ? envelope.headers["event_id"] : undefined;
    const jobs: IngestJob[] = [];
    for (const item of envelope.items) {
      // Tahap 2: hanya error event. attachment/session/transaction/client_report diabaikan dulu.
      if (item.headers.type !== "event") continue;
      if (item.payload.length > MAX_EVENT_BYTES) return reply.code(413).send({ detail: "event too large" });

      let json: unknown;
      try {
        json = JSON.parse(item.payload.toString("utf8"));
      } catch {
        return reply.code(400).send({ detail: "invalid event json" });
      }
      const parsed = eventSchema.safeParse(json);
      if (!parsed.success) return reply.code(400).send({ detail: "invalid event" });

      jobs.push({ projectId, receivedAt, payload: parsed.data });
      id ??= parsed.data.event_id;
    }

    if (jobs.length) {
      try {
        // Balas 200 hanya setelah event tersimpan di disk.
        await store.enqueue(jobs);
      } catch (err) {
        // Antrian penuh: SDK Sentry menghormati 429 + Retry-After dan mengirim ulang nanti.
        if (err instanceof BacklogFullError) return reply.code(429).header("retry-after", "5").send({ detail: "server busy" });
        req.log.error(err, "enqueue failed");
        return reply.code(503).header("retry-after", "10").send({ detail: "storage unavailable" });
      }
    }
    return { id };
  });
}
