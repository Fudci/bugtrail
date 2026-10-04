import { createPrisma, migrate, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { buildApp } from "./app.js";
import { ensureFirstAdmin } from "./auth/bootstrap.js";
import { Alerter } from "./process/alerts.js";
import { scheduleRetention } from "./process/retention.js";
import { IngestStore } from "./process/store.js";
import { FileStore } from "./sourcemaps/storage.js";
import { Symbolicator } from "./sourcemaps/symbolicate.js";

const num = (k: string, d: number) => Number(process.env[k] ?? d);

const applied = migrate(sqlitePath());
if (applied.length) console.log(`[db] migrations applied: ${applied.join(", ")}`);

const prisma = createPrisma();
await tunePrisma(prisma);
const bootstrap = await ensureFirstAdmin(prisma, process.env);
if (bootstrap === "created") console.log(`[auth] first admin created: ${process.env["ADMIN_EMAIL"]}`);

// Jalur ingest pakai koneksi SQLite sendiri (sinkron, tahan crash); dashboard tetap lewat Prisma.
const raw = openRaw(sqlitePath());
const files = FileStore.forDb(sqlitePath());
const symbolicator = new Symbolicator(raw, files, num("SOURCEMAP_CACHE_MB", 32) * 1024 * 1024);
const alerter = new Alerter(raw, {
  webUrl: process.env["WEB_URL"] ?? process.env["PUBLIC_URL"] ?? `http://localhost:${num("API_PORT", 4000)}`,
  log: (msg, err) => console.error(`[alerts] ${msg}`, err ?? ""),
});
const store = new IngestStore(raw, {
  onBatch: (r) => alerter.onBatch(r),
  symbolicator,
  maxBacklog: num("INGEST_BACKLOG_MAX", 100_000),
  batchSize: num("INGEST_BATCH_SIZE", 200),
  log: (msg, err) => console.error(`[ingest] ${msg}`, err),
});
if (store.backlog > 0) console.log(`[ingest] resuming ${store.backlog} queued events`);
store.start();
const stopRetention = scheduleRetention(raw, files, num("RETENTION_INTERVAL_MS", 10 * 60_000), (msg, err) =>
  err ? console.error(`[retention] ${msg}`, err) : console.log(`[retention] ${msg}`),
);

const app = await buildApp(
  { prisma, store, alerter, files, symbolicator, webDist: process.env["WEB_DIST"], dbPath: sqlitePath() },
  // Default "warn": log per-request (level info) memakan CPU di beban tinggi. LOG_LEVEL=info untuk debug.
  { logger: { level: process.env["LOG_LEVEL"] ?? "warn" } },
);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await app.close();      // berhenti terima request baru
  stopRetention();
  await store.stop();     // tulis request yang tertunda; sisa antrian aman di disk
  raw.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const port = num("API_PORT", 4000);
await app.listen({ port, host: "0.0.0.0" });
console.log(`[bugtrail] listening on :${port}`);
