import { existsSync } from "node:fs";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import Fastify, { type FastifyServerOptions } from "fastify";
import type { PrismaClient } from "@bugtool/db";
import { sessionPlugin } from "./auth/session.js";
import { authRoutes } from "./dashboard/auth-routes.js";
import { issueRoutes } from "./dashboard/issue-routes.js";
import { overviewRoutes } from "./dashboard/overview-routes.js";
import { projectRoutes } from "./dashboard/project-routes.js";
import { sourcemapRoutes } from "./dashboard/sourcemap-routes.js";
import { ingestRoutes } from "./ingest/route.js";
import type { Alerter } from "./process/alerts.js";
import type { IngestStore } from "./process/store.js";
import { sentryCliRoutes } from "./sourcemaps/cli-routes.js";
import type { FileStore } from "./sourcemaps/storage.js";
import type { Symbolicator } from "./sourcemaps/symbolicate.js";

export interface AppDeps {
  prisma: PrismaClient;
  store: IngestStore;
  alerter?: Alerter | undefined;
  files?: FileStore | undefined;
  symbolicator?: Symbolicator | undefined;
  /** Folder hasil build web (index.html + assets). Kosong = tidak menyajikan dashboard (mode dev pakai Vite). */
  webDist?: string | undefined;
  /** Path file SQLite, untuk menampilkan ukuran database. */
  dbPath?: string | undefined;
}

export async function buildApp(deps: AppDeps, opts: FastifyServerOptions = {}) {
  const { prisma, store, alerter, webDist, dbPath, files, symbolicator } = deps;
  const app = Fastify(opts);

  app.get("/health", async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ok", db: "ok", queue: store.size };
    } catch (err) {
      app.log.error(err);
      return reply.code(503).send({ status: "error", db: "unreachable" });
    }
  });

  await app.register(ingestRoutes, { prisma, store });
  // Endpoint sentry-cli (auth Bearer token), di luar plugin dashboard yang memakai cookie.
  if (files) await app.register(sentryCliRoutes, { prisma, files });

  // API dashboard: same-origin, auth via cookie sesi, tanpa CORS.
  await app.register(async (dash) => {
    await dash.register(cookie);
    await dash.register(sessionPlugin, { prisma });
    await dash.register(authRoutes, { prisma });
    await dash.register(projectRoutes, { prisma, dbPath, alerter });
    await dash.register(issueRoutes, { prisma, symbolicator });
    await dash.register(sourcemapRoutes, { prisma });
    await dash.register(overviewRoutes, { prisma });
  }, { prefix: "/api/0" });

  if (webDist && existsSync(webDist)) {
    await app.register(staticPlugin, { root: webDist, wildcard: false, maxAge: "1h" });
    // SPA: route selain /api dan file statis -> index.html. URL /api/* yang tidak ada tetap 404 JSON.
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== "GET" || req.url.startsWith("/api/")) {
        return reply.code(404).send({ detail: "not found" });
      }
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    });
  }

  return app;
}
