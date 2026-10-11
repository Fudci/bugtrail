import { createPrisma, migrate, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { buildApp } from "./app.js";
import { ensureFirstAdmin } from "./auth/bootstrap.js";
import { Alerter } from "./process/alerts.js";
import { scheduleRetention } from "./process/retention.js";
import { QuotaMeter } from "./process/quota.js";
import { IngestStore } from "./process/store.js";
import { createOtlpGrpcServer } from "./otlp/grpc.js";
import { ClickHouseLogStore } from "./otlp/clickhouse-logs.js";
import { SqliteLogStore, type LogStore, type StoredLog } from "./otlp/logs.js";
import { ClickHouseTelemetryStore, clickHouseReachable } from "./otlp/clickhouse-store.js";
import { readTelemetryConfig } from "./otlp/config.js";
import { RollupAggregator } from "./otlp/rollups.js";
import { ServiceGraph } from "./otlp/service-graph.js";
import { AlertRuleChecker } from "./process/alert-rules.js";
import { OngoingAlertChecker } from "./process/ongoing-alerts.js";
import { TelemetryQueue } from "./otlp/telemetry-queue.js";
import { SqliteTelemetryStore, type TelemetryStore } from "./otlp/telemetry-store.js";
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
const rollups = new RollupAggregator(raw, { log: (msg, err) => console.error(`[health] ${msg}`, err ?? "") });
rollups.start();
const services = new ServiceGraph(raw, { log: (msg, err) => console.error(`[services] ${msg}`, err ?? "") });
services.start();
const quota = new QuotaMeter(raw, { alerter, log: (msg, err) => console.error(`[quota] ${msg}`, err ?? "") });
quota.start();
const endpointAlerts = new AlertRuleChecker(raw, alerter, (msg, err) => console.error(`[alerts] ${msg}`, err ?? ""));
endpointAlerts.start();
const ongoingAlerts = new OngoingAlertChecker(raw, alerter, {
  webUrl: process.env["WEB_URL"] ?? process.env["PUBLIC_URL"] ?? `http://localhost:${num("API_PORT", 4000)}`,
  log: (msg, err) => console.error(`[alerts] ${msg}`, err ?? ""),
});
ongoingAlerts.start();
const stopRetention = scheduleRetention(raw, files, num("RETENTION_INTERVAL_MS", 10 * 60_000), (msg, err) =>
  err ? console.error(`[retention] ${msg}`, err) : console.log(`[retention] ${msg}`),
);

// Penyimpanan trace OpenTelemetry: SQLite (mode Lite, default) atau ClickHouse (mode Scale).
const telemetryConfig = (() => {
  try {
    return readTelemetryConfig(process.env);
  } catch (err) {
    // Salah konfigurasi: satu baris yang jelas, bukan stack trace dari bundle.
    console.error(`[telemetry] ${(err as Error).message}`);
    process.exit(1);
  }
})();
let telemetry: TelemetryStore = new SqliteTelemetryStore(raw);
let spanQueue: TelemetryQueue | undefined;
// Log OTLP: Lite = SQLite (retensi OTLP_LOG_RETENTION_DAYS), Scale = ClickHouse lewat log_queue.
let logStore: LogStore = new SqliteLogStore(raw);
let logQueue: TelemetryQueue<StoredLog> | undefined;
if (telemetryConfig.kind === "clickhouse") {
  const retention = raw.prepare("SELECT retention_days FROM projects WHERE id = ?").pluck();
  const ch = new ClickHouseTelemetryStore({ ...telemetryConfig, retentionDays: (id) => Number(retention.get(id) ?? 90) });
  // ClickHouse bisa start lebih lambat dari BugTrail (docker compose): coba sampai 60 detik.
  for (let attempt = 1; ; attempt++) {
    try {
      // Ping dengan klien tanpa log dulu: klien biasa mencetak stack trace ECONNREFUSED di tiap percobaan.
      if (attempt < 30 && !(await clickHouseReachable(telemetryConfig))) throw new Error("not reachable");
      await ch.init();
      break;
    } catch (err) {
      if (attempt >= 30) {
        console.error(`[telemetry] cannot use ClickHouse at ${telemetryConfig.url}: ${(err as Error).message}`);
        process.exit(1);
      }
      if (attempt === 1) console.log(`[telemetry] waiting for ClickHouse at ${telemetryConfig.url}…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  telemetry = ch;
  spanQueue = new TelemetryQueue(raw, ch, {
    maxSpans: num("SPAN_QUEUE_MAX", 2_000_000),
    log: (msg, err) => console.error(`[telemetry] ${msg}`, err ?? ""),
  });
  if (spanQueue.size > 0) console.log(`[telemetry] resuming ${spanQueue.size} queued spans`);
  spanQueue.start();
  const chLogs = new ClickHouseLogStore({ ...telemetryConfig, retentionDays: (id) => Number(retention.get(id) ?? 90) });
  await chLogs.init();
  logStore = chLogs;
  logQueue = new TelemetryQueue<StoredLog>(raw, chLogs, {
    table: "log_queue", label: "logs",
    maxSpans: num("LOG_QUEUE_MAX", 2_000_000),
    log: (msg, err) => console.error(`[logs] ${msg}`, err ?? ""),
  });
  if (logQueue.size > 0) console.log(`[logs] resuming ${logQueue.size} queued logs`);
  logQueue.start();
}
console.log(`[telemetry] trace storage: ${telemetry.kind}${telemetry.storesAllSpans ? " (all traces)" : " (error and slow traces)"}, log storage: ${logStore.kind}`);

const app = await buildApp(
  { prisma, store, alerter, files, symbolicator, webDist: process.env["WEB_DIST"], dbPath: sqlitePath(), telemetry, spanQueue, rollups, services, quota, logStore, logQueue },
  // Default "warn": log per-request (level info) memakan CPU di beban tinggi. LOG_LEVEL=info untuk debug.
  { logger: { level: process.env["LOG_LEVEL"] ?? "warn" } },
);

// OTLP/gRPC di port terpisah (standar 4317). OTLP_GRPC_PORT=0 mematikannya.
const grpcPort = num("OTLP_GRPC_PORT", 4317);
const grpcServer = grpcPort > 0 && app.traceIngest ? createOtlpGrpcServer(app.traceIngest, app.log, app.logIngest) : undefined;

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await grpcServer?.close();
  await app.close();      // berhenti terima request baru
  rollups.stop();         // tulis rollup yang tertunda
  services.stop();
  quota.stop();           // tulis hitungan drop yang tertunda
  stopRetention();
  endpointAlerts.stop();
  ongoingAlerts.stop();
  await spanQueue?.stop();    // span yang belum terkirim tetap aman di disk
  await logQueue?.stop();
  await telemetry.close?.();
  await logStore.close?.();
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
if (grpcServer) {
  // Port gRPC terpakai (mis. OpenTelemetry Collector di host yang sama): jangan matikan BugTrail;
  // dashboard, Sentry SDK dan OTLP/HTTP tetap jalan.
  try {
    await grpcServer.listen(grpcPort);
    console.log(`[bugtrail] OTLP/gRPC listening on :${grpcPort}`);
  } catch (err) {
    console.error(`[bugtrail] OTLP/gRPC disabled: cannot listen on :${grpcPort} (${(err as Error).message}). Set OTLP_GRPC_PORT to a free port, or 0 to turn it off.`);
  }
}
