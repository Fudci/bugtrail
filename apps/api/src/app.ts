import { existsSync } from "node:fs";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import Fastify, { type FastifyServerOptions } from "fastify";
import type { PrismaClient } from "@bugtool/db";
import { sessionPlugin } from "./auth/session.js";
import { authRoutes } from "./dashboard/auth-routes.js";
import { issueRoutes } from "./dashboard/issue-routes.js";
import { healthRoutes } from "./dashboard/health-routes.js";
import { traceRoutes } from "./dashboard/trace-routes.js";
import { overviewRoutes } from "./dashboard/overview-routes.js";
import { projectRoutes } from "./dashboard/project-routes.js";
import { sourcemapRoutes } from "./dashboard/sourcemap-routes.js";
import { ingestRoutes } from "./ingest/route.js";
import { SpanBuffer } from "./otlp/buffer.js";
import { serviceRoutes } from "./dashboard/service-routes.js";
import { logRoutes } from "./dashboard/log-routes.js";
import { passwordResetRoutes } from "./dashboard/password-reset-routes.js";
import { alertRuleRoutes } from "./dashboard/alert-rule-routes.js";
import { createLogIngest, type LogIngest } from "./otlp/log-ingest.js";
import type { LogStore, StoredLog } from "./otlp/logs.js";
import { otlpRoutes } from "./otlp/route.js";
import { createTraceIngest, type TraceIngest } from "./otlp/trace-ingest.js";
import type { RollupAggregator } from "./otlp/rollups.js";
import type { ServiceGraph } from "./otlp/service-graph.js";
import type { TelemetryQueue } from "./otlp/telemetry-queue.js";
import type { TelemetryStore } from "./otlp/telemetry-store.js";
import type { Alerter } from "./process/alerts.js";
import type { QuotaMeter } from "./process/quota.js";
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
  /** Penyimpanan span OpenTelemetry. Kosong = endpoint OTLP tidak aktif. */
  telemetry?: TelemetryStore | undefined;
  /** Mode Scale: antrian span di disk ke penyimpanan yang menyimpan semua span (ClickHouse). */
  spanQueue?: TelemetryQueue | undefined;
  /** API Health: rollup request per endpoint. */
  rollups?: RollupAggregator | undefined;
  /** Service map: rollup per service dan panggilan antar service. */
  services?: ServiceGraph | undefined;
  /** Penyimpanan log OTLP. Kosong = endpoint /otlp/v1/logs tidak aktif. */
  logStore?: LogStore | undefined;
  /** Mode Scale: antrian log di disk ke ClickHouse. */
  logQueue?: TelemetryQueue<StoredLog> | undefined;
  /** Kuota ingest per project per menit. Kosong = tanpa kuota. */
  quota?: QuotaMeter | undefined;
  /** Jam (ms epoch) untuk API Health; disuntik di test. Default Date.now. */
  now?: (() => number) | undefined;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Ingest trace OTLP (kosong kalau telemetry tidak aktif); dipakai server OTLP/gRPC di index.ts. */
    traceIngest: TraceIngest | undefined;
    /** Ingest log OTLP (kosong kalau log tidak aktif); dipakai server OTLP/gRPC. */
    logIngest: LogIngest | undefined;
  }
}

export async function buildApp(deps: AppDeps, opts: FastifyServerOptions = {}) {
  const { prisma, store, alerter, webDist, dbPath, files, symbolicator, telemetry, spanQueue, rollups, services, now, quota, logStore, logQueue } = deps;
  const app = Fastify(opts);
  // Dipakai bersama OTLP/HTTP (di sini) dan OTLP/gRPC (server terpisah, dijalankan index.ts).
  const traceIngest = telemetry ? createTraceIngest({
    prisma, store, telemetry, spanQueue, rollups, services, quota, buffer: new SpanBuffer(), log: app.log,
    tracesPerIssueHour: process.env["OTLP_TRACES_PER_ISSUE_HOUR"] ? Number(process.env["OTLP_TRACES_PER_ISSUE_HOUR"]) : undefined,
    slowTracesPerEndpointHour: process.env["OTLP_SLOW_TRACES_PER_ENDPOINT_HOUR"] ? Number(process.env["OTLP_SLOW_TRACES_PER_ENDPOINT_HOUR"]) : undefined,
  }) : undefined;
  const logIngest = telemetry && logStore ? createLogIngest({ store: logStore, queue: logQueue, quota, log: app.log }) : undefined;

  app.get("/health", async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      const traceStore = telemetry?.ping ? ((await telemetry.ping().catch(() => false)) ? "ok" : "unreachable") : undefined;
      return { status: "ok", db: "ok", queue: store.size, ...(traceStore && { traceStore, spanQueue: spanQueue?.size ?? 0 }) };
    } catch (err) {
      app.log.error(err);
      return reply.code(503).send({ status: "error", db: "unreachable" });
    }
  });

  await app.register(ingestRoutes, { prisma, store, quota });
  if (telemetry) {
    await app.register(otlpRoutes, { traces: traceIngest!, logs: logIngest });
  }
  // Endpoint sentry-cli (auth Bearer token), di luar plugin dashboard yang memakai cookie.
  if (files) await app.register(sentryCliRoutes, { prisma, files });

  // API dashboard: same-origin, auth via cookie sesi, tanpa CORS.
  await app.register(async (dash) => {
    await dash.register(cookie);
    await dash.register(sessionPlugin, { prisma });
    await dash.register(authRoutes, { prisma });
    await dash.register(passwordResetRoutes, { prisma });
    await dash.register(projectRoutes, { prisma, dbPath, alerter, telemetry, quota });
    await dash.register(issueRoutes, { prisma, symbolicator, telemetry });
    await dash.register(sourcemapRoutes, { prisma });
    await dash.register(overviewRoutes, { prisma });
    await dash.register(healthRoutes, { prisma, telemetry, now });
    await dash.register(traceRoutes, { prisma, telemetry, now });
    await dash.register(serviceRoutes, { prisma, now });
    await dash.register(logRoutes, { prisma, logStore, now });
    await dash.register(alertRuleRoutes, { prisma, alerter });
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

  app.decorate("traceIngest", traceIngest);
  app.decorate("logIngest", logIngest);
  return app;
}
