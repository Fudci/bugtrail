// Isi ClickHouse dengan span dan log sintetis untuk uji baca dashboard (mode Scale).
// Data dibuat di dalam ClickHouse (INSERT ... SELECT FROM numbers), jauh lebih cepat daripada lewat OTLP.
// Pakai: CH_URL=http://localhost:18124 CH_USER=bench CH_PASSWORD=... SPANS=5000000 LOGS=2000000 npx tsx scripts/bench-clickhouse/seed.ts (dari apps/api)
import { createClient } from "@clickhouse/client";
import { ClickHouseLogStore } from "../../src/otlp/clickhouse-logs.js";
import { ClickHouseTelemetryStore } from "../../src/otlp/clickhouse-store.js";

const opts = {
  url: process.env["CH_URL"] ?? "http://localhost:18124", username: process.env["CH_USER"] ?? "bench",
  password: process.env["CH_PASSWORD"] ?? "", database: process.env["CH_DATABASE"] ?? "bench", retentionDays: () => 30,
};
const SPANS = Number(process.env["SPANS"] ?? 5_000_000);
const LOGS = Number(process.env["LOGS"] ?? 2_000_000);
const BATCH = 1_000_000;
export const PROJECT = "bench";

// Tabel dibuat oleh kode store yang sebenarnya (skema sama dengan production).
await new ClickHouseTelemetryStore(opts).init();
await new ClickHouseLogStore(opts).init();
const ch = createClient({ url: opts.url, username: opts.username, password: opts.password, database: opts.database, request_timeout: 600_000 });
await ch.command({ query: "TRUNCATE TABLE otel_spans" });
await ch.command({ query: "TRUNCATE TABLE otel_logs" });

// Satu trace = 5 span: 0 = server (endpoint), 1 = query DB, 2 = HTTP keluar, 3-4 = internal.
// Endpoint: 50 route dengan sebaran tidak rata (beberapa route jauh lebih ramai). 3% 5xx, 7% 4xx;
// separuh dari 5xx punya exception. Waktu tersebar 7 hari terakhir; 1% request lambat (hingga 5 s).
const SPAN_SELECT = `
WITH intDiv(number, 5) AS i, number % 5 AS k,
  cityHash64(i) AS h,
  toUInt32(pow((h % 1000) / 1000, 2) * 50) AS r,
  h % 100 AS pct,
  multiIf(pct < 3, 500 + (h % 4), pct < 10, 400 + [0, 1, 3, 4][1 + (h % 4)], 200) AS status,
  ['GET', 'POST', 'PUT', 'DELETE'][1 + (r % 4)] AS method,
  concat('/api/v1/res', toString(r), if(r % 3 = 0, '/:id', '')) AS route,
  ['api-gateway', 'orders', 'billing', 'auth', 'users'][1 + (i % 5)] AS svc,
  now64(6) - toIntervalMicrosecond(h % (7 * 86400 * 1000000)) AS t0,
  if(h % 100 = 7, 1000000 + h % 4000000, 3000 + h % 300000) AS d0
SELECT
  '${PROJECT}' AS project_id,
  lower(hex(MD5(toString(i)))) AS trace_id,
  substring(lower(hex(MD5(concat(toString(number), 's')))), 1, 16) AS span_id,
  if(k = 0, '', substring(lower(hex(MD5(concat(toString(i * 5), 's')))), 1, 16)) AS parent_span_id,
  svc AS service,
  multiIf(k = 0, concat(method, ' ', route), k = 1, 'SELECT orders', k = 2, 'GET', 'middleware') AS name,
  multiIf(k = 0, 2, k IN (1, 2), 3, 1) AS kind,
  t0 + toIntervalMicrosecond(k * 1000) AS ts,
  if(k = 0, d0, intDiv(d0, 5)) AS duration_us,
  if(k = 0 AND status >= 500, 2, 0) AS status_code,
  '' AS status_message,
  multiIf(k = 0, concat('{"http.request.method":"', method, '","http.route":"', route, '","http.response.status_code":', toString(status), ',"enduser.id":"user-', toString(h % 5000), '"}'),
          k = 1, '{"db.system":"postgresql","db.name":"shop","db.statement":"SELECT * FROM orders WHERE id = $1"}',
          k = 2, '{"server.address":"api.payments.example","http.response.status_code":200}', '{}') AS attributes,
  if(k = 0 AND status >= 500 AND h % 2 = 0,
     concat('[{"name":"exception","timeUs":', toString(toUnixTimestamp64Micro(t0)), ',"attributes":{"exception.type":"', ['DbError', 'TimeoutError', 'TypeError'][1 + (h % 3)],
            '","exception.message":"failure ', toString(r % 7), '","exception.stacktrace":"Error\\\\n    at handler (/app/src/routes.js:', toString(r), ':5)"}}]'), '[]') AS events,
  concat('{"service.name":"', svc, '"}') AS resource,
  30 AS retention_days,
  now() AS received_at
FROM numbers({start: UInt64}, {count: UInt64})`;

const LOG_SELECT = `
WITH cityHash64(number, 'log') AS h, intDiv(h % 1000000, 1) AS i
SELECT '${PROJECT}' AS project_id,
  now64(6) - toIntervalMicrosecond(h % (7 * 86400 * 1000000)) AS ts,
  generateUUIDv4(number) AS id,
  multiIf(h % 100 < 3, 17, h % 100 < 12, 13, 9) AS severity_number,
  multiIf(h % 100 < 3, 'ERROR', h % 100 < 12, 'WARN', 'INFO') AS severity_text,
  ['api-gateway', 'orders', 'billing', 'auth', 'users'][1 + (number % 5)] AS service,
  concat(['request handled', 'cache miss for key', 'payment declined for order', 'slow query on orders', 'user signed in'][1 + (h % 5)], ' ', toString(h % 100000)) AS body,
  concat('{"orderId":', toString(h % 100000), '}') AS attributes,
  '{}' AS resource,
  if(h % 10 < 3, lower(hex(MD5(toString(i)))), '') AS trace_id,
  '' AS span_id,
  30 AS retention_days,
  now() AS received_at
FROM numbers({start: UInt64}, {count: UInt64})`;

const run = async (label: string, table: string, select: string, total: number) => {
  const t0 = Date.now();
  for (let start = 0; start < total; start += BATCH) {
    await ch.command({ query: `INSERT INTO ${table} ${select}`, query_params: { start, count: Math.min(BATCH, total - start) } });
    process.stdout.write(`\r${label}: ${Math.min(total, start + BATCH).toLocaleString("en-US")} / ${total.toLocaleString("en-US")}`);
  }
  console.log(` (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
};
await run("spans", "otel_spans", SPAN_SELECT, SPANS);
await run("logs", "otel_logs", LOG_SELECT, LOGS);
await ch.command({ query: "OPTIMIZE TABLE otel_spans FINAL" });
await ch.command({ query: "OPTIMIZE TABLE otel_logs FINAL" });
const rs = await ch.query({ query: `SELECT table, sum(rows) AS rows, formatReadableSize(sum(data_compressed_bytes)) AS disk,
  formatReadableSize(sum(data_uncompressed_bytes)) AS raw FROM system.parts WHERE database = currentDatabase() AND active GROUP BY table`, format: "JSONEachRow" });
console.table(await rs.json());
await ch.close();
