// Ukur waktu query dashboard di ClickHouse (mode Scale) memakai store yang sebenarnya.
// Isi data dulu dengan seed.ts. Pakai (dari apps/api): CH_PASSWORD=... npx tsx scripts/bench-clickhouse/run.ts
import { ClickHouseLogStore } from "../../src/otlp/clickhouse-logs.js";
import { ClickHouseTelemetryStore } from "../../src/otlp/clickhouse-store.js";

const opts = {
  url: process.env["CH_URL"] ?? "http://localhost:18124", username: process.env["CH_USER"] ?? "bench",
  password: process.env["CH_PASSWORD"] ?? "", database: process.env["CH_DATABASE"] ?? "bench", retentionDays: () => 30,
};
const P = "bench";
const RUNS = Number(process.env["RUNS"] ?? 5);
const spans = new ClickHouseTelemetryStore(opts);
const logs = new ClickHouseLogStore(opts);
const nowUs = Date.now() * 1000;
const day = 86_400e6;
// Endpoint paling ramai di seed (route 0) dan yang jarang (route 49).
const busy = { method: "GET", route: "/api/v1/res0/:id" };
const rare = { method: "POST", route: "/api/v1/res49" };
const results: { query: string; window: string; first: number; median: number; max: number; rows: string }[] = [];

async function time(query: string, window: string, fn: () => Promise<unknown>) {
  const ms: number[] = [];
  let out: unknown;
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    out = await fn();
    ms.push(performance.now() - t);
  }
  const sorted = [...ms.slice(1)].sort((a, b) => a - b);
  const rows = Array.isArray(out) ? `${out.length} rows` : typeof out === "number" ? `n=${out}` : out instanceof Map ? `${out.size} rows` : "";
  results.push({ query, window, first: Math.round(ms[0]!), median: Math.round(sorted[Math.floor(sorted.length / 2)] ?? ms[0]!), max: Math.round(Math.max(...ms)), rows });
  process.stdout.write(".");
}

for (const [window, fromUs] of [["24h", nowUs - day], ["7d", nowUs - 7 * day]] as const) {
  const w = { fromUs, toUs: nowUs + 60e6 };
  for (const [label, ep] of [["busy endpoint", busy], ["rare endpoint", rare]] as const) {
    const f = { ...ep, ...w, status: "5xx" };
    await time(`listRequests 5xx, ${label}, page 1`, window, () => spans.listRequests(P, { ...f, limit: 50 }));
    await time(`listRequests all, ${label}, page 1`, window, () => spans.listRequests(P, { ...f, status: "all", limit: 50 }));
    await time(`listRequests all, ${label}, page 100`, window, () => spans.listRequests(P, { ...f, status: "all", limit: 50, offset: 4950 }));
    await time(`countRequests 5xx, ${label}`, window, () => spans.countRequests(P, f));
    await time(`requestStatusCounts, ${label}`, window, () => spans.requestStatusCounts(P, { ...ep, ...w }));
    await time(`topErrors, ${label}`, window, () => spans.topErrors(P, f));
  }
  const tq = { ...w, status: "all" };
  await time("searchTraces, no filter", window, () => spans.searchTraces(P, { ...tq, limit: 50 }));
  await time("searchTraces, service", window, () => spans.searchTraces(P, { ...tq, service: "orders", limit: 50 }));
  await time("searchTraces, text", window, () => spans.searchTraces(P, { ...tq, text: "res17", limit: 50 }));
  await time("searchTraces, errors", window, () => spans.searchTraces(P, { ...w, status: "error", limit: 50 }));
  await time("searchTraces, > 1 s", window, () => spans.searchTraces(P, { ...tq, minDurationUs: 1e6, limit: 50 }));
  await time("countTraces, no filter", window, () => spans.countTraces(P, tq));
  await time("traceStatusCounts", window, () => spans.traceStatusCounts(P, w));
  await time("listServices", window, () => spans.listServices(P, w.fromUs, w.toUs));
  await time("searchLogs, no filter", window, () => logs.searchLogs(P, { ...w, limit: 100 }));
  await time("searchLogs, text", window, () => logs.searchLogs(P, { ...w, text: "payment declined", limit: 100 }));
  await time("searchLogs, errors + service", window, () => logs.searchLogs(P, { ...w, minSeverity: 17, service: "billing", limit: 100 }));
}
// Satu trace / log satu trace (dicari lewat bloom filter trace_id, tanpa jendela waktu).
const someTrace = (await spans.searchTraces(P, { fromUs: nowUs - day, toUs: nowUs, status: "all", limit: 1 }))[0]!.traceId;
await time("getTrace", "-", () => spans.getTrace(P, someTrace));
await time("searchLogs by traceId", "-", () => logs.searchLogs(P, { traceId: someTrace, limit: 500, order: "asc" }));
const reqs = await spans.listRequests(P, { ...busy, fromUs: nowUs - day, toUs: nowUs, status: "5xx", limit: 50 });
await time("traceErrors (one page)", "24h", () => spans.traceErrors(P, [...new Set(reqs.map((r) => r.traceId))], { fromUs: reqs.at(-1)!.startUs, toUs: reqs[0]!.startUs }));
await time("serverSpanBody", "-", () => spans.serverSpanBody(P, reqs[0]!.traceId, reqs[0]!.spanId));

console.log("\n");
console.table(results.map((r) => ({ query: r.query, window: r.window, "first ms": r.first, "median ms": r.median, "max ms": r.max, result: r.rows })));
await spans.close();
await logs.close();
