import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ClickHouseClient } from "@clickhouse/client";
import { clickHouseClient, ensureDatabase, retentionDaysOf, toDateTime64, type ClickHouseStoreOptions } from "./clickhouse-store.js";
import type { LogRow, LogSearchQuery, LogStore, StoredLog } from "./logs.js";

// Mode Scale: log OTLP di ClickHouse, ditulis per batch oleh antrian log_queue (TelemetryQueue yang sama).
// Retensi per project lewat TTL (received_at + retention_days project), deduplikasi insert seperti otel_spans.
// id = UUID per log, dibuat saat masuk antrian, jadi batch yang dikirim ulang punya isi (dan token) yang sama.
const TABLE = "otel_logs";

const SCHEMA = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  project_id LowCardinality(String),
  ts DateTime64(6, 'UTC'),
  id String,
  severity_number UInt8,
  severity_text LowCardinality(String),
  service LowCardinality(String),
  body String CODEC(ZSTD(3)),
  attributes String CODEC(ZSTD(3)),
  resource String CODEC(ZSTD(3)),
  trace_id String,
  span_id String,
  retention_days UInt16,
  received_at DateTime DEFAULT now(),
  INDEX idx_trace trace_id TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (project_id, ts)
TTL received_at + toIntervalDay(retention_days)
SETTINGS non_replicated_deduplication_window = 1000`;

type Row = { id: string; ts_us: string; severity_number: number; severity_text: string; service: string; body: string; attributes: string; resource: string; trace_id: string; span_id: string };

export class ClickHouseLogStore implements LogStore {
  readonly kind = "clickhouse";
  private client: ClickHouseClient;

  constructor(private opts: ClickHouseStoreOptions) {
    this.client = clickHouseClient(opts);
  }

  /** Buat database dan tabel kalau belum ada. Idempoten. */
  async init() {
    await ensureDatabase(this.opts);
    await this.client.command({ query: SCHEMA });
  }

  encodeSpans(logs: StoredLog[]): string {
    const dayOf = retentionDaysOf(this.opts);
    let out = "";
    for (const l of logs) {
      out += JSON.stringify({
        project_id: l.projectId, ts: toDateTime64(l.timeUs), id: randomUUID(),
        severity_number: l.severityNumber, severity_text: l.severityText ?? "", service: l.service ?? "",
        body: l.body, attributes: JSON.stringify(l.attributes), resource: JSON.stringify(l.resource),
        trace_id: l.traceId ?? "", span_id: l.spanId ?? "", retention_days: dayOf(l.projectId),
      }) + "\n";
    }
    return out;
  }

  async writeEncoded(encoded: string) {
    if (!encoded) return;
    const body = Buffer.from(encoded);
    const res = await this.client.exec({
      query: `INSERT INTO ${TABLE} FORMAT JSONEachRow`,
      values: Readable.from([body], { objectMode: false }),
      clickhouse_settings: { insert_deduplication_token: createHash("sha256").update(body).digest("hex") },
    });
    res.stream.resume();
    await new Promise<void>((ok, fail) => res.stream.on("end", ok).on("error", fail));
  }

  async writeLogs(logs: StoredLog[]) {
    if (logs.length) await this.writeEncoded(this.encodeSpans(logs));
  }

  async searchLogs(projectId: string, q: LogSearchQuery): Promise<LogRow[]> {
    const where = ["project_id = {projectId: String}"];
    if (q.traceId) where.push("trace_id = {traceId: String}");
    if (q.fromUs !== undefined) where.push("ts >= fromUnixTimestamp64Micro({fromUs: Int64})");
    if (q.toUs !== undefined) where.push("ts < fromUnixTimestamp64Micro({toUs: Int64})");
    if (q.service) where.push("service = {service: String}");
    if (q.minSeverity) where.push("severity_number >= {minSeverity: UInt8}");
    if (q.text) where.push("positionCaseInsensitiveUTF8(body, {text: String}) > 0");
    const asc = q.order === "asc";
    if (q.before) where.push(`(ts, id) ${asc ? ">" : "<"} (fromUnixTimestamp64Micro({beforeUs: Int64}), {beforeId: String})`);
    const dir = asc ? "ASC" : "DESC";
    const rs = await this.client.query({
      query: `SELECT id, toString(toUnixTimestamp64Micro(ts)) AS ts_us, severity_number, severity_text, service, body, attributes, resource, trace_id, span_id
              FROM ${TABLE} WHERE ${where.join(" AND ")}
              ORDER BY ts ${dir}, id ${dir} LIMIT 1 BY id LIMIT {limit: UInt32}`,
      query_params: {
        projectId, traceId: q.traceId ?? "", fromUs: Math.floor(q.fromUs ?? 0), toUs: Math.ceil(q.toUs ?? 0), service: q.service ?? "",
        minSeverity: q.minSeverity ?? 0, text: q.text ?? "", beforeUs: q.before?.timeUs ?? 0, beforeId: q.before?.id ?? "", limit: q.limit,
      },
      format: "JSONEachRow",
    });
    return (await rs.json<Row>()).map((r) => ({
      id: r.id, timeUs: Number(r.ts_us), severityNumber: Number(r.severity_number), severityText: r.severity_text || undefined,
      service: r.service || undefined, body: r.body, attributes: JSON.parse(r.attributes), resource: JSON.parse(r.resource),
      traceId: r.trace_id || undefined, spanId: r.span_id || undefined,
    }));
  }

  async logServices(projectId: string, fromUs: number, toUs: number): Promise<string[]> {
    const rs = await this.client.query({
      query: `SELECT DISTINCT service FROM ${TABLE} WHERE project_id = {projectId: String} AND service != ''
                AND ts >= fromUnixTimestamp64Micro({fromUs: Int64}) AND ts < fromUnixTimestamp64Micro({toUs: Int64}) ORDER BY service LIMIT 200`,
      query_params: { projectId, fromUs: Math.floor(fromUs), toUs: Math.ceil(toUs) },
      format: "JSONEachRow",
    });
    return (await rs.json<{ service: string }>()).map((r) => r.service);
  }

  async close() {
    await this.client.close();
  }
}
