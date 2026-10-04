import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { gunzipSync } from "node:zlib";
import { unzipSync } from "fflate";
import { z } from "zod";
import type { PrismaClient } from "@bugtool/db";
import { hashToken } from "../auth/tokens.js";
import { isSha1, sha1, type FileStore } from "./storage.js";
import { normalizeDebugId } from "./symbolicate.js";

// Endpoint yang dipakai `sentry-cli sourcemaps upload` (protokol chunk-upload + artifact bundle).
// Auth: "Authorization: Bearer <upload token>" — token dibuat per project di Setting.

const CHUNK_SIZE = 8 * 1024 * 1024;        // harus pangkat 2 (sentry-cli <= 2.39)
const MAX_REQUEST = 32 * 1024 * 1024;
const MAX_BUNDLE = 256 * 1024 * 1024;      // ukuran zip bundle
const MAX_UNZIPPED = 1024 * 1024 * 1024;   // total isi setelah unzip (cegah zip bomb)
const ARTIFACT_TYPES = new Set(["source_map", "minified_source"]);

const assembleBody = z.object({
  checksum: z.string().regex(/^[0-9a-f]{40}$/),
  chunks: z.array(z.string().regex(/^[0-9a-f]{40}$/)).min(1).max(10_000),
  projects: z.array(z.string()).optional(),
});

interface TokenCtx { tokenId: string; projectId: string; projectSlug: string }

const publicUrl = () => (process.env["PUBLIC_URL"] ?? `http://localhost:${process.env["API_PORT"] ?? 4000}`).replace(/\/$/, "");

export async function sentryCliRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; files: FileStore }) {
  const { prisma, files } = opts;
  await app.register(multipart, { limits: { fileSize: CHUNK_SIZE, files: 64, fields: 16 } });

  async function auth(req: FastifyRequest, reply: FastifyReply): Promise<TokenCtx | null> {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    if (!m) {
      reply.code(401).send({ detail: "Authentication credentials were not provided." });
      return null;
    }
    const tok = await prisma.uploadToken.findUnique({
      where: { tokenHash: hashToken(m[1]!) },
      select: { id: true, projectId: true, lastUsedAt: true, project: { select: { slug: true } } },
    });
    if (!tok) {
      reply.code(401).send({ detail: "Invalid token" });
      return null;
    }
    if (!tok.lastUsedAt || Date.now() - tok.lastUsedAt.getTime() > 60_000) {
      await prisma.uploadToken.update({ where: { id: tok.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    }
    return { tokenId: tok.id, projectId: tok.projectId, projectSlug: tok.project.slug };
  }

  // Dipakai sentry-cli untuk mengecek token.
  app.get("/api/0/", async (req, reply) => {
    const ctx = await auth(req, reply);
    if (!ctx) return;
    return { version: "0", auth: { scopes: ["project:releases", "org:ci"] }, user: null };
  });

  app.get("/api/0/organizations/:org/chunk-upload/", async (req, reply) => {
    const ctx = await auth(req, reply);
    if (!ctx) return;
    const { org } = req.params as { org: string };
    return {
      url: `${publicUrl()}/api/0/organizations/${encodeURIComponent(org)}/chunk-upload/`,
      chunkSize: CHUNK_SIZE,
      chunksPerRequest: 4,
      maxFileSize: MAX_BUNDLE,
      maxRequestSize: MAX_REQUEST,
      concurrency: 2,
      hashAlgorithm: "sha1",
      compression: ["gzip"],
      // Tanpa "release_files" sentry-cli versi tertentu meminta --release.
      accept: ["release_files", "sources", "artifact_bundles"],
    };
  });

  app.post("/api/0/organizations/:org/chunk-upload/", { bodyLimit: MAX_REQUEST + 1024 * 1024 }, async (req, reply) => {
    const ctx = await auth(req, reply);
    if (!ctx) return;
    if (!req.isMultipart()) return reply.code(400).send({ detail: "expected multipart/form-data" });
    let n = 0;
    try {
      for await (const part of req.parts()) {
        if (part.type !== "file") continue;
        if (part.fieldname !== "file" && part.fieldname !== "file_gzip") continue;
        let buf = await part.toBuffer();
        if (part.fieldname === "file_gzip") buf = gunzipSync(buf, { maxOutputLength: CHUNK_SIZE });
        if (buf.length > CHUNK_SIZE) return reply.code(413).send({ detail: "chunk too large" });
        // Nama file part = sha1 isi chunk.
        if (!isSha1(part.filename) || sha1(buf) !== part.filename) {
          return reply.code(400).send({ detail: `chunk checksum mismatch: ${part.filename}` });
        }
        files.putChunk(part.filename, buf);
        n++;
      }
    } catch (err) {
      req.log.warn(err, "chunk upload failed");
      return reply.code(400).send({ detail: "invalid chunk upload" });
    }
    return reply.code(200).send({ uploaded: n });
  });

  app.post("/api/0/organizations/:org/artifactbundle/assemble/", async (req, reply) => {
    const ctx = await auth(req, reply);
    if (!ctx) return;
    const body = assembleBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ state: "error", detail: "invalid assemble request" });
    const { checksum, chunks, projects } = body.data;

    // Token terikat ke satu project; --project harus project itu (atau tidak diisi).
    if (projects?.length && !projects.every((p) => p === ctx.projectSlug)) {
      return reply.code(400).send({
        state: "error",
        detail: `This token is only valid for project "${ctx.projectSlug}". Use --project ${ctx.projectSlug}.`,
      });
    }

    const missing = [...new Set(chunks)].filter((c) => !files.hasChunk(c));
    if (missing.length) return { state: "not_found", missingChunks: missing };

    let bundle: Buffer;
    try {
      bundle = files.readChunks(chunks);
    } catch {
      return { state: "not_found", missingChunks: chunks };
    }
    if (bundle.length > MAX_BUNDLE) return reply.code(400).send({ state: "error", detail: "bundle too large" });
    if (sha1(bundle) !== checksum) return reply.code(400).send({ state: "error", detail: "bundle checksum mismatch" });

    let stored: number;
    try {
      stored = await processBundle(prisma, files, ctx.projectId, bundle);
    } catch (err) {
      req.log.warn(err, "artifact bundle rejected");
      return reply.code(400).send({ state: "error", detail: err instanceof Error ? err.message : "invalid bundle" });
    }
    files.deleteChunks(chunks);
    req.log.info({ projectId: ctx.projectId, stored }, "artifact bundle assembled");
    return { state: "ok", missingChunks: [] };
  });
}

/** Baca zip artifact bundle (manifest.json + file), simpan source map & bundle per debug ID. */
export async function processBundle(prisma: PrismaClient, files: FileStore, projectId: string, zip: Uint8Array) {
  let total = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, {
      filter: (f) => {
        total += f.originalSize;
        if (total > MAX_UNZIPPED) throw new Error("bundle too large after unzipping");
        return true;
      },
    });
  } catch (err) {
    throw new Error(err instanceof Error && err.message.includes("too large") ? err.message : "bundle is not a valid zip");
  }
  const manifestRaw = entries["manifest.json"];
  if (!manifestRaw) throw new Error("manifest.json missing from bundle");
  let manifest: { files?: Record<string, { url?: string; type?: string; headers?: Record<string, string> }> };
  try {
    manifest = JSON.parse(Buffer.from(manifestRaw).toString("utf8"));
  } catch {
    throw new Error("invalid manifest.json");
  }

  let stored = 0;
  for (const [path, entry] of Object.entries(manifest.files ?? {})) {
    const type = entry?.type;
    const headers = Object.fromEntries(Object.entries(entry?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const debugId = normalizeDebugId(headers["debug-id"]);
    const content = entries[path];
    if (!type || !ARTIFACT_TYPES.has(type) || !debugId || !content) continue;
    const fileSha1 = files.putFile(content);
    const url = typeof entry.url === "string" ? entry.url.slice(0, 500) : null;
    // Unggah ulang debug ID yang sama: versi terbaru menang.
    await prisma.artifact.upsert({
      where: { projectId_debugId_fileType: { projectId, debugId, fileType: type } },
      update: { sha1: fileSha1, size: content.length, url, createdAt: new Date() },
      create: { projectId, debugId, fileType: type, sha1: fileSha1, size: content.length, url },
    });
    stored++;
  }
  if (stored === 0) throw new Error("bundle contains no source maps with a debug-id");
  return stored;
}
