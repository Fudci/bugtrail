// Jalankan init() store ke database benchmark (membuat tabel, atau meng-upgrade tabel lama).
import { ClickHouseLogStore } from "../../src/otlp/clickhouse-logs.js";
import { ClickHouseTelemetryStore } from "../../src/otlp/clickhouse-store.js";

const opts = {
  url: process.env["CH_URL"] ?? "http://localhost:18124", username: process.env["CH_USER"] ?? "bench",
  password: process.env["CH_PASSWORD"] ?? "", database: process.env["CH_DATABASE"] ?? "bench", retentionDays: () => 30,
};
const t = Date.now();
const spans = new ClickHouseTelemetryStore(opts);
await spans.init();
const logs = new ClickHouseLogStore(opts);
await logs.init();
console.log(`init ${Date.now() - t} ms`);
await spans.close();
await logs.close();
