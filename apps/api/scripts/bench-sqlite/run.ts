// Uji baca dashboard mode Lite (SQLite) dengan volume besar untuk Lite: span trace error/lambat + log.
// Membuat DB baru (DB_FILE), mengisinya lewat store yang sebenarnya, lalu mengukur query yang sama dengan
// scripts/bench-clickhouse/run.ts. Query SQLite sinkron: waktu di sini = waktu event loop server tertahan.
// Pakai (dari apps/api): SPANS=1000000 LOGS=3000000 DB_FILE=../../data/bench/lite.db npx tsx scripts/bench-sqlite/run.ts
import { existsSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { migrate, openRaw } from "@bugtool/db";
import { SqliteLogStore, type StoredLog } from "../../src/otlp/logs.js";
import { SqliteTelemetryStore, type StoredSpan } from "../../src/otlp/telemetry-store.js";

const FILE = process.env["DB_FILE"] ?? "../../data/bench/lite.db";
const SPANS = Number(process.env["SPANS"] ?? 1_000_000);
const LOGS = Number(process.env["LOGS"] ?? 3_000_000);
const RUNS = Number(process.env["RUNS"] ?? 5);
const P = "bench";
const SERVICES = ["api-gateway", "orders", "billing", "auth", "users"];
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const h = (n: number) => Number.parseInt(md5(String(n)).slice(0, 12), 16);

if (process.env["RESEED"] !== "0" || !existsSync(FILE)) {
  for (const s of ["", "-wal", "-shm"]) rmSync(FILE + s, { force: true });
  migrate(FILE);
  const raw = openRaw(FILE);
  raw.prepare("INSERT INTO organizations (id, name, slug) VALUES ('o', 'O', 'o')").run();
  raw.prepare(`INSERT INTO projects (id, organization_id, name, slug) VALUES ('${P}', 'o', 'Bench', 'bench')`).run();
  const spans = new SqliteTelemetryStore(raw);
  const logs = new SqliteLogStore(raw);
  const now = Date.now() * 1000;
  const week = 7 * 86_400e6;
  let t0 = Date.now();
  // Sama dengan seed ClickHouse: 1 trace = 5 span, 50 route tidak rata, 3% 5xx (separuh dengan exception), 7% 4xx.
  for (let start = 0; start < SPANS; start += 10_000) {
    const batch: StoredSpan[] = [];
    for (let n = start; n < Math.min(SPANS, start + 10_000); n++) {
      const i = Math.floor(n / 5), k = n % 5, x = h(i);
      const r = Math.floor(((x % 1000) / 1000) ** 2 * 50), pct = x % 100;
      const status = pct < 3 ? 500 + (x % 4) : pct < 10 ? 400 + [0, 1, 3, 4][x % 4]! : 200;
      const method = ["GET", "POST", "PUT", "DELETE"][r % 4]!;
      const route = `/api/v1/res${r}${r % 3 === 0 ? "/:id" : ""}`;
      const startUs = now - (x % week) + k * 1000;
      const d0 = x % 100 === 7 ? 1_000_000 + (x % 4_000_000) : 3000 + (x % 300_000);
      batch.push({
        projectId: P, traceId: md5(`t${i}`), spanId: md5(`s${n}`).slice(0, 16), parentSpanId: k === 0 ? undefined : md5(`s${i * 5}`).slice(0, 16),
        service: SERVICES[i % 5], name: k === 0 ? `${method} ${route}` : k === 1 ? "SELECT orders" : k === 2 ? "GET" : "middleware",
        kind: k === 0 ? 2 : k < 3 ? 3 : 1, startUs, durationUs: k === 0 ? d0 : Math.floor(d0 / 5), statusCode: k === 0 && status >= 500 ? 2 : 0,
        attributes: k === 0 ? { "http.request.method": method, "http.route": route, "http.response.status_code": status, "enduser.id": `user-${x % 5000}` }
          : k === 1 ? { "db.system": "postgresql", "db.name": "shop" } : {},
        events: k === 0 && status >= 500 && x % 2 === 0
          ? [{ name: "exception", timeUs: startUs, attributes: { "exception.type": ["DbError", "TimeoutError", "TypeError"][x % 3], "exception.message": `failure ${r % 7}`, "exception.stacktrace": `Error\n    at handler (/app/src/routes.js:${r}:5)` } }]
          : [],
        resource: { "service.name": SERVICES[i % 5] },
      });
    }
    spans.writeSpans(batch);
    if (start % 200_000 === 0) process.stdout.write(`\rspans ${start.toLocaleString("en-US")}`);
  }
  console.log(`\rspans ${SPANS.toLocaleString("en-US")} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  t0 = Date.now();
  // Log 3 hari (retensi Lite), 30% terkait trace.
  for (let start = 0; start < LOGS; start += 20_000) {
    const batch: StoredLog[] = [];
    for (let n = start; n < Math.min(LOGS, start + 20_000); n++) {
      const x = h(n + 1e9);
      batch.push({
        projectId: P, timeUs: now - (x % (3 * 86_400e6)), severityNumber: x % 100 < 3 ? 17 : x % 100 < 12 ? 13 : 9,
        severityText: x % 100 < 3 ? "ERROR" : x % 100 < 12 ? "WARN" : "INFO", service: SERVICES[n % 5],
        body: `${["request handled", "cache miss for key", "payment declined for order", "slow query on orders", "user signed in"][x % 5]} ${x % 100000}`,
        attributes: { orderId: x % 100000 }, resource: {}, traceId: x % 10 < 3 ? md5(`t${x % 200000}`) : undefined,
      });
    }
    logs.writeLogs(batch);
    if (start % 500_000 === 0) process.stdout.write(`\rlogs ${start.toLocaleString("en-US")}`);
  }
  console.log(`\rlogs ${LOGS.toLocaleString("en-US")} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  raw.exec("ANALYZE");
  raw.close();
}

migrate(FILE); // DB benchmark lama: terapkan migrasi baru (mis. index) sebelum mengukur
const raw = openRaw(FILE);
raw.exec("ANALYZE");
const spans = new SqliteTelemetryStore(raw);
const logs = new SqliteLogStore(raw);
const size = (raw.prepare("SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()").pluck().get() as number) / 1048576;
console.log(`DB ${size.toFixed(0)} MiB`);
const nowUs = Date.now() * 1000;
const day = 86_400e6;
const busy = { method: "GET", route: "/api/v1/res0/:id" };
const results: Record<string, unknown>[] = [];
async function time(query: string, window: string, fn: () => unknown) {
  const ms: number[] = [];
  let out: unknown;
  for (let i = 0; i < RUNS; i++) { const t = performance.now(); out = await fn(); ms.push(performance.now() - t); }
  const s = [...ms.slice(1)].sort((a, b) => a - b);
  const rows = Array.isArray(out) ? `${out.length} rows` : typeof out === "number" ? `n=${out}` : "";
  results.push({ query, window, "first ms": Math.round(ms[0]!), "median ms": Math.round(s[Math.floor(s.length / 2)]!), "max ms": Math.round(Math.max(...ms)), result: rows });
}
for (const [window, fromUs] of [["24h", nowUs - day], ["7d", nowUs - 7 * day]] as const) {
  const w = { fromUs, toUs: nowUs + 60e6 };
  const f = { ...busy, ...w, status: "5xx" };
  await time("listRequests 5xx, busy endpoint, page 1", window, () => spans.listRequests(P, { ...f, limit: 50 }));
  await time("listRequests all, busy endpoint, page 100", window, () => spans.listRequests(P, { ...f, status: "all", limit: 50, offset: 4950 }));
  await time("countRequests 5xx", window, () => spans.countRequests(P, f));
  await time("requestStatusCounts", window, () => spans.requestStatusCounts(P, { ...busy, ...w }));
  await time("topErrors", window, () => spans.topErrors(P, f));
  const tq = { ...w, status: "all" };
  await time("searchTraces, no filter", window, () => spans.searchTraces(P, { ...tq, limit: 50 }));
  await time("searchTraces, service", window, () => spans.searchTraces(P, { ...tq, service: "orders", limit: 50 }));
  await time("searchTraces, text", window, () => spans.searchTraces(P, { ...tq, text: "res17", limit: 50 }));
  await time("searchTraces, errors", window, () => spans.searchTraces(P, { ...w, status: "error", limit: 50 }));
  await time("countTraces", window, () => spans.countTraces(P, tq));
  await time("traceStatusCounts", window, () => spans.traceStatusCounts(P, w));
  await time("searchLogs, no filter", window, () => logs.searchLogs(P, { ...w, limit: 100 }));
  await time("searchLogs, text", window, () => logs.searchLogs(P, { ...w, text: "payment declined", limit: 100 }));
  await time("searchLogs, errors + service", window, () => logs.searchLogs(P, { ...w, minSeverity: 17, service: "billing", limit: 100 }));
  await time("logServices", window, () => logs.logServices(P, w.fromUs, w.toUs));
}
const someTrace = spans.searchTraces(P, { fromUs: nowUs - day, toUs: nowUs, status: "all", limit: 1 })[0]!.traceId;
await time("getTrace", "-", () => spans.getTrace(P, someTrace));
await time("searchLogs by traceId", "-", () => logs.searchLogs(P, { traceId: someTrace, limit: 500, order: "asc" }));
console.table(results);
raw.close();
