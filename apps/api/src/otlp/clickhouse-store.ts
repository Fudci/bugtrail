import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { ClickHouseLogLevel, createClient, type ClickHouseClient } from "@clickhouse/client";
import {
  BODY_ATTRS, BODY_MAX, ERR_MESSAGE_MAX, ERR_STACK_MAX, TOP_ERRORS_SCAN, TRACE_MARGIN_US, reduceErrors,
  type ListRequestsQuery, type RequestError, type StatusCount, type RequestFilter, type RequestRow, type ServerSpanBody, type StoredSpan, type TelemetryStore, type TopError,
  type TraceFilter, type TraceRow, type TraceSearchQuery,
} from "./telemetry-store.js";
import { statusFilterOf, statusSql, type StatusFilter } from "./status-filter.js";

// Mode Scale: semua span di ClickHouse (https://clickhouse.com/docs/integrations/javascript).
// Ditulis per batch oleh TelemetryQueue (bukan per request) supaya ClickHouse tidak membuat terlalu banyak part.
// Retensi per project lewat TTL per baris: received_at + retention_days, dihapus otomatis saat merge.
// TTL dihitung dari waktu terima, bukan waktu span, supaya span dari server dengan jam yang salah atau
// yang dikirim ulang terlambat tidak langsung dibuang saat insert.
// Deduplikasi: setiap batch dikirim dengan insert_deduplication_token = hash isinya; batch yang dikirim
// ulang setelah respons hilang diabaikan ClickHouse (butuh non_replicated_deduplication_window > 0).
const TABLE = "otel_spans";

// Method/route/status HTTP span; aturan sama dengan endpointKey (rollups.ts). Dihitung SEKALI saat insert
// (kolom MATERIALIZED), bukan di setiap query: mengurai JSON jutaan span per query membuat API Health dan
// Traces lambat di rentang 7 hari (lihat apps/api/scripts/bench-clickhouse).
const HTTP_STATUS_EXPR = `toUInt16OrZero(trimBoth(if(JSONExtractRaw(attributes, 'http.response.status_code') NOT IN ('', 'null'), JSONExtractRaw(attributes, 'http.response.status_code'),
                    JSONExtractRaw(attributes, 'http.status_code')), '"'))`;
const HTTP_METHOD_EXPR = `upperUTF8(substring(multiIf(JSONExtractString(attributes, 'http.request.method') != '', JSONExtractString(attributes, 'http.request.method'),
                    JSONExtractString(attributes, 'http.method') != '', JSONExtractString(attributes, 'http.method'), '*'), 1, 16))`;
const HTTP_ROUTE_EXPR = `substringUTF8(if(JSONExtractString(attributes, 'http.route') != '', JSONExtractString(attributes, 'http.route'), name), 1, 300)`;
const MATERIALIZED_COLUMNS = [
  ["http_status", "UInt16", HTTP_STATUS_EXPR],
  ["http_method", "LowCardinality(String)", HTTP_METHOD_EXPR],
  ["http_route", "LowCardinality(String)", HTTP_ROUTE_EXPR],
] as const;

const SCHEMA = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  project_id LowCardinality(String),
  trace_id FixedString(32),
  span_id FixedString(16),
  parent_span_id String,
  service LowCardinality(String),
  name LowCardinality(String),
  kind UInt8,
  ts DateTime64(6, 'UTC'),
  duration_us UInt64,
  status_code UInt8,
  status_message String CODEC(ZSTD(1)),
  attributes String CODEC(ZSTD(3)),
  events String CODEC(ZSTD(3)),
  resource String CODEC(ZSTD(3)),
  retention_days UInt16,
  received_at DateTime DEFAULT now(),
${MATERIALIZED_COLUMNS.map(([n, t, e]) => `  ${n} ${t} MATERIALIZED ${e},`).join("\n")}
  INDEX idx_trace trace_id TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (project_id, service, ts)
TTL received_at + toIntervalDay(retention_days)
SETTINGS non_replicated_deduplication_window = 1000`;

// Tabel dari versi sebelumnya: TTL dari waktu terima (bukan waktu span) + deduplikasi insert.
const UPGRADES = [
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS received_at DateTime DEFAULT now()`,
  `ALTER TABLE ${TABLE} MODIFY TTL received_at + toIntervalDay(retention_days)`,
  `ALTER TABLE ${TABLE} MODIFY SETTING non_replicated_deduplication_window = 1000`,
];

// Exception paling awal (menurut timeUs) di kolom events satu span; '' kalau tidak ada.
// position() murah dan menyaring span tanpa exception sebelum JSON di-parse.
const FIRST_EX = `if(position(events, '"exception"') = 0, '',
  arraySort(e -> JSONExtractInt(e, 'timeUs'), arrayFilter(e -> JSONExtractString(e, 'name') = 'exception', JSONExtractArrayRaw(events)))[1])`;
const SPAN_HAS_ERROR = `(position(events, '"exception"') > 0 OR (kind = 2 AND status_message != ''))`;

const REQ_COLUMNS = `http_method AS method, http_route AS route, http_status AS status`;

// Aturan status pencarian trace atas tuple wakil r (r.6 = status_code, r.7 = status HTTP).
// Span server di jendela + kolom method/route/status; dipakai listRequests dan countRequests.
const REQ_INNER = `SELECT trace_id, span_id, ts, duration_us, service, ${REQ_COLUMNS}
                FROM ${TABLE}
                WHERE project_id = {projectId: String} AND kind = 2
                  AND ts >= fromUnixTimestamp64Micro({fromUs: Int64}, 'UTC') AND ts < fromUnixTimestamp64Micro({toUs: Int64}, 'UTC')`;
const REQ_BASE = "method = {method: String} AND route = {route: String} AND status BETWEEN 100 AND 599";

// Kondisi status dari token (status-filter.ts): placeholder bernama {s<i>lo/hi: UInt16}, nilai lewat query_params.
function chStatus(f: StatusFilter, col: string, errorSql?: string) {
  const w = statusSql(f, col, (i, which) => `{s${i}${which}: UInt16}`, errorSql);
  const params: Record<string, number> = {};
  f.ranges.forEach(([lo, hi], i) => { params[`s${i}lo`] = lo; params[`s${i}hi`] = hi; });
  return { sql: w.sql, params };
}
const reqStatus = (raw: string) => chStatus(statusFilterOf(raw), "status");
// Token "error" trace: status span root error (r.6 = 2) atau HTTP >= 500 (r.7).
const traceStatus = (raw: string) => chStatus(statusFilterOf(raw, { allowError: true }), "r.7", "(r.6 = 2 OR r.7 >= 500)");

// Wakil per trace (tuple r): span root; kalau root tidak tersimpan, span server paling awal.
// Mode Scale menyimpan semua span, jadi hampir setiap trace punya root: root dibaca langsung (satu baris per
// trace, tanpa GROUP BY). Hanya trace tanpa root ("orphan", mis. backend yang menerima traceparent dari aplikasi
// lain) yang dikelompokkan. Mengelompokkan SEMUA trace (~1 juta dalam 7 hari) butuh ~1 GB memori dan beberapa detik.
// r.8 = route (atau nama span kalau tanpa http.route) untuk pencarian teks.
const REP_TUPLE = "(span_id, ts, duration_us, service, name, status_code, http_status, http_route)";
const IN_WINDOW = `project_id = {projectId: String}
                  AND ts >= fromUnixTimestamp64Micro({fromUs: Int64}, 'UTC') AND ts < fromUnixTimestamp64Micro({toUs: Int64}, 'UTC')`;
const ROOT_REPS = `SELECT trace_id, ${REP_TUPLE} AS r FROM ${TABLE} WHERE ${IN_WINDOW} AND parent_span_id = ''`;
// Root dicari sedikit lebih awal dari jendela (TRACE_MARGIN_US), supaya span server dari trace yang root-nya
// tepat di luar jendela tidak dianggap orphan.
const ORPHAN_REPS = `SELECT trace_id, argMin(${REP_TUPLE}, (ts, span_id)) AS r
                FROM ${TABLE}
                WHERE ${IN_WINDOW} AND kind = 2 AND parent_span_id != ''
                  AND trace_id NOT IN (SELECT trace_id FROM ${TABLE} WHERE project_id = {projectId: String} AND parent_span_id = ''
                    AND ts >= fromUnixTimestamp64Micro({rootFromUs: Int64}, 'UTC') AND ts < fromUnixTimestamp64Micro({toUs: Int64}, 'UTC'))
                GROUP BY trace_id`;
const traceMatch = `({service: String} = '' OR r.4 = {service: String})
                AND (positionCaseInsensitiveUTF8(r.8, {text: String}) > 0 OR positionCaseInsensitiveUTF8(r.5, {text: String}) > 0)
                AND r.3 >= {minDur: UInt64}`;
const traceParams = (projectId: string, q: Omit<TraceFilter, "status">) => ({
  projectId, fromUs: Math.floor(q.fromUs), toUs: Math.ceil(q.toUs), rootFromUs: Math.floor(q.fromUs - TRACE_MARGIN_US),
  service: q.service ?? "", text: q.text ?? "", minDur: Math.max(0, Math.floor(q.minDurationUs ?? 0)),
});

interface Row {
  project_id: string; trace_id: string; span_id: string; parent_span_id: string; service: string; name: string;
  kind: number; ts_us: string; duration_us: string; status_code: number; status_message: string;
  attributes: string; events: string; resource: string;
}

// DateTime64(6) dari mikrodetik: "YYYY-MM-DD hh:mm:ss.ffffff" (UTC).
export const toDateTime64 = (us: number) => {
  const iso = new Date(Math.floor(us / 1000)).toISOString(); // ...T..:..:..mmmZ
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${String(us % 1_000_000).padStart(6, "0")}`;
};

export interface ClickHouseStoreOptions {
  url: string;
  username: string;
  password: string;
  database: string;
  /** Retensi (hari) project, dibaca dari SQLite. */
  retentionDays: (projectId: string) => number;
}

/** Klien ClickHouse dengan setelan yang sama untuk semua store (span, log). */
export function clickHouseClient(opts: ClickHouseStoreOptions, database = opts.database): ClickHouseClient {
  return createClient({
    url: opts.url, username: opts.username, password: opts.password, database,
    request_timeout: 30_000, compression: { request: true, response: true },
  });
}

/** Cek ClickHouse sudah menerima koneksi, tanpa log error dari klien (dipakai saat menunggu startup). */
export async function clickHouseReachable(opts: Pick<ClickHouseStoreOptions, "url" | "username" | "password">) {
  const probe = createClient({ url: opts.url, username: opts.username, password: opts.password, database: "default",
    request_timeout: 5_000, log: { level: ClickHouseLogLevel.OFF } });
  try {
    return (await probe.ping()).success;
  } finally {
    await probe.close();
  }
}

/** Buat database kalau belum ada (lewat database "default"). Idempoten. */
export async function ensureDatabase(opts: ClickHouseStoreOptions) {
  // Jangan bergantung pada CLICKHOUSE_DB di image: kalau volume sudah berisi data, inisialisasi
  // image dilewati dan database-nya bisa belum ada.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.database)) throw new Error(`invalid CLICKHOUSE_DATABASE "${opts.database}"`);
  const admin = createClient({ url: opts.url, username: opts.username, password: opts.password, database: "default" });
  try {
    await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${opts.database}` });
  } finally {
    await admin.close();
  }
}

/** Retensi (hari, 1..65535 untuk kolom UInt16) per project, di-cache selama satu batch encode. */
export function retentionDaysOf(opts: ClickHouseStoreOptions) {
  const days = new Map<string, number>();
  return (projectId: string) => {
    let d = days.get(projectId);
    if (d === undefined) days.set(projectId, (d = Math.min(65535, Math.max(1, opts.retentionDays(projectId)))));
    return d;
  };
}

export class ClickHouseTelemetryStore implements TelemetryStore {
  readonly kind = "clickhouse";
  readonly storesAllSpans = true;
  private client: ClickHouseClient;

  constructor(private opts: ClickHouseStoreOptions) {
    this.client = clickHouseClient(opts);
  }

  /** Buat database dan tabel kalau belum ada. Dipanggil sekali saat start. */
  async init() {
    await ensureDatabase(this.opts);
    await this.client.command({ query: SCHEMA });
    for (const query of UPGRADES) await this.client.command({ query });
    // Tabel lama: tambah kolom MATERIALIZED, lalu isi data lama sekali (mutation di latar belakang; query tetap
    // benar selama berjalan karena ClickHouse menghitung nilai kolom yang belum terisi saat dibaca).
    const have = new Set((await (await this.client.query({
      query: "SELECT name FROM system.columns WHERE database = currentDatabase() AND table = {t: String}",
      query_params: { t: TABLE }, format: "JSONEachRow",
    })).json<{ name: string }>()).map((c) => c.name));
    for (const [name, type, expr] of MATERIALIZED_COLUMNS) {
      if (have.has(name)) continue;
      await this.client.command({ query: `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS ${name} ${type} MATERIALIZED ${expr}` });
      await this.client.command({ query: `ALTER TABLE ${TABLE} MATERIALIZE COLUMN ${name}` });
    }
  }

  async ping() {
    return (await this.client.ping()).success;
  }

  // Satu baris JSON (JSONEachRow) per span.
  encodeSpans(spans: StoredSpan[]): string {
    const dayOf = retentionDaysOf(this.opts);
    let out = "";
    for (const s of spans) {
      out += JSON.stringify({
        project_id: s.projectId,
        trace_id: s.traceId,
        span_id: s.spanId,
        parent_span_id: s.parentSpanId ?? "",
        service: s.service ?? "",
        name: s.name.slice(0, 500),
        kind: s.kind,
        ts: toDateTime64(s.startUs),
        duration_us: s.durationUs,
        status_code: s.statusCode,
        status_message: s.statusMessage?.slice(0, 2000) ?? "",
        attributes: JSON.stringify(s.attributes),
        events: JSON.stringify(s.events),
        resource: JSON.stringify(s.resource),
        retention_days: dayOf(s.projectId),
      }) + "\n";
    }
    return out;
  }

  // Kirim teks JSONEachRow apa adanya (tanpa parse/encode ulang) lewat stream.
  async writeEncoded(encoded: string) {
    if (!encoded) return;
    // insert() dengan JSONEachRow selalu meng-encode tiap nilai (dan menolak stream byte), jadi pakai
    // exec() + INSERT ... FORMAT: isi stream dikirim apa adanya (lihat ExecParamsWithValues di client).
    const body = Buffer.from(encoded);
    const res = await this.client.exec({
      query: `INSERT INTO ${TABLE} FORMAT JSONEachRow`,
      values: Readable.from([body], { objectMode: false }),
      // Isi batch sama persis saat dikirim ulang -> token sama -> ClickHouse mengabaikan duplikatnya.
      clickhouse_settings: { insert_deduplication_token: createHash("sha256").update(body).digest("hex") },
    });
    res.stream.resume(); // kosongkan respons supaya koneksi kembali ke pool
    await new Promise<void>((ok, fail) => res.stream.on("end", ok).on("error", fail));
  }

  async writeSpans(spans: StoredSpan[]) {
    if (spans.length) await this.writeEncoded(this.encodeSpans(spans));
  }

  async getTrace(projectId: string, traceId: string): Promise<StoredSpan[]> {
    const rs = await this.client.query({
      query: `SELECT project_id, trace_id, span_id, parent_span_id, service, name, kind,
                toString(toUnixTimestamp64Micro(ts)) AS ts_us, toString(duration_us) AS duration_us,
                status_code, status_message, attributes, events, resource
              FROM ${TABLE}
              WHERE project_id = {projectId: String} AND trace_id = {traceId: FixedString(32)}
              ORDER BY ts, span_id
              LIMIT 1 BY span_id
              LIMIT 2000`,
      query_params: { projectId, traceId },
      format: "JSONEachRow",
    });
    const rows = await rs.json<Row>();
    return rows.map((r) => ({
      projectId,
      traceId: r.trace_id,
      spanId: r.span_id,
      parentSpanId: r.parent_span_id || undefined,
      service: r.service || undefined,
      name: r.name,
      kind: Number(r.kind),
      startUs: Number(r.ts_us),
      durationUs: Number(r.duration_us),
      statusCode: Number(r.status_code),
      statusMessage: r.status_message || undefined,
      attributes: JSON.parse(r.attributes),
      events: JSON.parse(r.events),
      resource: JSON.parse(r.resource),
    }));
  }

  async listRequests(projectId: string, q: ListRequestsQuery): Promise<RequestRow[]> {
    const st = reqStatus(q.status);
    // Kursor paging komposit (ts, span_id); status null jatuh ke http.status_code seperti SQLite.
    // Status di JSON bisa angka (500) atau teks ("500"): ambil mentah lalu buang tanda kutip.
    // Aturan method/route sama dengan endpointKey (rollups.ts); semua input lewat parameter.
    // Paging bernomor: LIMIT ... OFFSET setelah LIMIT BY, jadi duplikat insert tidak menggeser halaman.
    const rs = await this.client.query({
      query: `SELECT trace_id, span_id, toString(toUnixTimestamp64Micro(ts)) AS ts_us, toString(duration_us) AS duration_us, service, method, route, status
              FROM (${REQ_INNER}
                  AND (ts, span_id) < (fromUnixTimestamp64Micro({beforeUs: Int64}, 'UTC'), {beforeSpan: String})
              )
              WHERE ${REQ_BASE} AND ${st.sql}
              ORDER BY ts DESC, span_id DESC
              LIMIT 1 BY trace_id, span_id
              LIMIT {limit: UInt32} OFFSET {offset: UInt32}`,
      query_params: { projectId, fromUs: Math.floor(q.fromUs), toUs: Math.ceil(q.toUs), beforeUs: Math.ceil(q.beforeUs ?? q.toUs), beforeSpan: q.beforeSpanId ?? "", method: q.method, route: q.route, ...st.params, limit: q.limit, offset: q.offset ?? 0 },
      format: "JSONEachRow",
    });
    const rows = await rs.json<{ trace_id: string; span_id: string; ts_us: string; duration_us: string; service: string; method: string; route: string; status: number }>();
    return rows.map((r) => ({
      traceId: r.trace_id,
      spanId: r.span_id,
      startUs: Number(r.ts_us),
      durationUs: Number(r.duration_us),
      status: Number(r.status),
      method: r.method,
      route: r.route,
      service: r.service || undefined,
    }));
  }

  // Jumlah request unik (trace_id, span_id): baris duplikat dari insert ulang tidak dihitung dua kali.
  async countRequests(projectId: string, q: RequestFilter): Promise<number> {
    const st = reqStatus(q.status);
    const rs = await this.client.query({
      query: `SELECT toString(uniqExact(trace_id, span_id)) AS n FROM (${REQ_INNER}) WHERE ${REQ_BASE} AND ${st.sql}`,
      query_params: { projectId, fromUs: Math.floor(q.fromUs), toUs: Math.ceil(q.toUs), method: q.method, route: q.route, ...st.params },
      format: "JSONEachRow",
    });
    return Number((await rs.json<{ n: string }>())[0]?.n ?? 0);
  }

  // Per kode status; uniqExact(trace_id, span_id) meniadakan baris duplikat dari insert ulang.
  async requestStatusCounts(projectId: string, q: Omit<RequestFilter, "status">): Promise<StatusCount[]> {
    const rs = await this.client.query({
      query: `SELECT toUInt16(status) AS code, toString(uniqExact(trace_id, span_id)) AS n FROM (${REQ_INNER}) WHERE ${REQ_BASE} GROUP BY code`,
      query_params: { projectId, fromUs: Math.floor(q.fromUs), toUs: Math.ceil(q.toUs), method: q.method, route: q.route },
      format: "JSONEachRow",
    });
    return (await rs.json<{ code: number; n: string }>()).map((r) => ({ code: Number(r.code), count: Number(r.n) }));
  }

  // Satu query untuk semua trace satu halaman. Batas waktu (rentang halaman +- TRACE_MARGIN_US) memangkas
  // partisi harian; bloom filter idx_trace memangkas granule di dalamnya.
  async traceErrors(projectId: string, traceIds: string[], range?: { fromUs: number; toUs: number }): Promise<Map<string, RequestError>> {
    if (!traceIds.length) return new Map();
    const rs = await this.client.query({
      query: `SELECT trace_id, name, kind, toString(toUnixTimestamp64Micro(ts)) AS ts_us, substringUTF8(status_message, 1, ${ERR_MESSAGE_MAX}) AS status_message,
                ${FIRST_EX} AS ex, JSONExtractInt(ex, 'timeUs') AS ex_us,
                substringUTF8(JSONExtractString(ex, 'attributes', 'exception.type'), 1, 300) AS ex_type,
                substringUTF8(JSONExtractString(ex, 'attributes', 'exception.message'), 1, ${ERR_MESSAGE_MAX}) AS ex_message,
                substringUTF8(JSONExtractString(ex, 'attributes', 'exception.stacktrace'), 1, ${ERR_STACK_MAX}) AS ex_stack
              FROM ${TABLE}
              WHERE project_id = {projectId: String} AND trace_id IN {ids: Array(FixedString(32))}
                AND ts >= fromUnixTimestamp64Micro({fromUs: Int64}, 'UTC') AND ts < fromUnixTimestamp64Micro({toUs: Int64}, 'UTC')
                AND ${SPAN_HAS_ERROR}
              LIMIT 1 BY trace_id, span_id
              SETTINGS max_result_rows = 20000, result_overflow_mode = 'break'`,
      query_params: {
        projectId, ids: traceIds,
        fromUs: Math.floor((range?.fromUs ?? 0) - TRACE_MARGIN_US), toUs: Math.ceil((range?.toUs ?? 4102444800e6) + TRACE_MARGIN_US),
      },
      format: "JSONEachRow",
    });
    const rows = await rs.json<{ trace_id: string; name: string; kind: number; ts_us: string; status_message: string; ex: string; ex_us: string; ex_type: string; ex_message: string; ex_stack: string }>();
    return reduceErrors(rows.map((r) => ({
      traceId: r.trace_id, spanName: r.name, kind: Number(r.kind), statusMessage: r.status_message || undefined,
      ex: r.ex ? { timeUs: Number(r.ex_us) || Number(r.ts_us), type: r.ex_type || undefined, message: r.ex_message || undefined, stacktrace: r.ex_stack || undefined } : undefined,
    })));
  }

  // Dihitung penuh di ClickHouse: (1) trace_id request yang cocok filter di jendela (maks TOP_ERRORS_SCAN terbaru),
  // (2) span berisi error dari trace itu (jendela +- margin), (3) error pertama per trace, (4) group by type+message.
  async topErrors(projectId: string, q: RequestFilter): Promise<TopError[]> {
    const st = reqStatus(q.status);
    const rs = await this.client.query({
      query: `SELECT e.1 AS type, e.2 AS message, count() AS n FROM (
                SELECT trace_id,
                  if(countIf(ex != '') > 0,
                    argMinIf((substringUTF8(JSONExtractString(ex, 'attributes', 'exception.type'), 1, 300), substringUTF8(JSONExtractString(ex, 'attributes', 'exception.message'), 1, ${ERR_MESSAGE_MAX})),
                      JSONExtractInt(ex, 'timeUs'), ex != ''),
                    ('', substringUTF8(anyIf(status_message, kind = 2 AND status_message != ''), 1, ${ERR_MESSAGE_MAX}))) AS e
                FROM (
                  SELECT trace_id, kind, status_message, ${FIRST_EX} AS ex
                  FROM ${TABLE}
                  WHERE project_id = {projectId: String}
                    AND ts >= fromUnixTimestamp64Micro({wFrom: Int64}, 'UTC') AND ts < fromUnixTimestamp64Micro({wTo: Int64}, 'UTC')
                    AND ${SPAN_HAS_ERROR}
                    AND trace_id IN (
                      SELECT trace_id FROM (
                        SELECT trace_id, ts, ${REQ_COLUMNS}
                        FROM ${TABLE}
                        WHERE project_id = {projectId: String} AND kind = 2
                          AND ts >= fromUnixTimestamp64Micro({fromUs: Int64}, 'UTC') AND ts < fromUnixTimestamp64Micro({toUs: Int64}, 'UTC')
                      )
                      WHERE ${REQ_BASE} AND ${st.sql}
                      ORDER BY ts DESC
                      LIMIT {scan: UInt32}
                    )
                )
                GROUP BY trace_id
              )
              WHERE e.1 != '' OR e.2 != ''
              GROUP BY type, message
              ORDER BY n DESC, message
              LIMIT 5`,
      query_params: {
        projectId, method: q.method, route: q.route, ...st.params, scan: TOP_ERRORS_SCAN,
        fromUs: Math.floor(q.fromUs), toUs: Math.ceil(q.toUs),
        wFrom: Math.floor(q.fromUs - TRACE_MARGIN_US), wTo: Math.ceil(q.toUs + TRACE_MARGIN_US),
      },
      format: "JSONEachRow",
    });
    const rows = await rs.json<{ type: string; message: string; n: string }>();
    return rows.map((r) => ({ ...(r.type ? { type: r.type } : {}), message: r.message, count: Number(r.n) }));
  }

  // Wakil per trace dipilih dengan argMin (root diutamakan, lalu paling awal) atas kandidat di jendela
  // (span root atau span server); filter + kursor diterapkan ke wakilnya. argMin juga meniadakan duplikat insert.
  // Jumlah span: query kedua untuk trace satu halaman (uniqExact span_id, jendela halaman +- TRACE_MARGIN_US).
  async searchTraces(projectId: string, q: TraceSearchQuery): Promise<TraceRow[]> {
    const st = traceStatus(q.status);
    const need = q.limit + (q.offset ?? 0);
    type Rep = { trace_id: string; span_id: string; ts_us: string; duration_us: string; service: string; name: string; status_code: number; http: number };
    const page = async (source: string, extra: Record<string, number>) => {
      const rs = await this.client.query({
        query: `SELECT trace_id, r.1 AS span_id, toString(toUnixTimestamp64Micro(r.2)) AS ts_us, toString(r.3) AS duration_us,
                  r.4 AS service, r.5 AS name, r.6 AS status_code, r.7 AS http
                FROM (${source})
                WHERE (r.2, r.1) < (fromUnixTimestamp64Micro({beforeUs: Int64}, 'UTC'), {beforeSpan: String})
                  AND ${traceMatch} AND ${st.sql}
                ORDER BY r.2 DESC, r.1 DESC
                LIMIT 1 BY trace_id
                LIMIT {need: UInt32}`,
        query_params: { ...traceParams(projectId, q), ...st.params, beforeUs: Math.ceil(q.beforeUs ?? q.toUs), beforeSpan: q.beforeSpanId ?? "", need, ...extra },
        format: "JSONEachRow",
      });
      return rs.json<Rep>();
    };
    const roots = await page(ROOT_REPS, {});
    // Orphan hanya perlu dicari di rentang waktu yang bisa masuk halaman ini: sejak root ke-`need`
    // (kalau root sudah cukup), selain itu seluruh jendela.
    const cutoffUs = roots.length >= need ? Number(roots[roots.length - 1]!.ts_us) : Math.floor(q.fromUs);
    const orphans = await page(ORPHAN_REPS, { fromUs: cutoffUs, rootFromUs: Math.floor(cutoffUs - TRACE_MARGIN_US) });
    const rows = [...roots, ...orphans]
      .sort((a, b) => Number(b.ts_us) - Number(a.ts_us) || (b.span_id > a.span_id ? 1 : b.span_id < a.span_id ? -1 : 0))
      .slice(q.offset ?? 0, need);

    const counts = new Map<string, number>();
    if (rows.length) {
      const c = await this.client.query({
        query: `SELECT trace_id, uniqExact(span_id) AS n FROM ${TABLE}
                WHERE project_id = {projectId: String} AND trace_id IN {ids: Array(FixedString(32))}
                  AND ts >= fromUnixTimestamp64Micro({fromUs: Int64}, 'UTC') AND ts < fromUnixTimestamp64Micro({toUs: Int64}, 'UTC')
                GROUP BY trace_id`,
        query_params: {
          projectId, ids: rows.map((r) => r.trace_id),
          fromUs: Math.floor(Number(rows[rows.length - 1]!.ts_us) - TRACE_MARGIN_US), toUs: Math.ceil(Number(rows[0]!.ts_us) + TRACE_MARGIN_US),
        },
        format: "JSONEachRow",
      });
      for (const r of await c.json<{ trace_id: string; n: string }>()) counts.set(r.trace_id, Number(r.n));
    }
    return rows.map((r) => ({
      traceId: r.trace_id,
      spanId: r.span_id,
      startUs: Number(r.ts_us),
      durationUs: Number(r.duration_us),
      ...(r.service ? { service: r.service } : {}),
      name: r.name,
      statusCode: Number(r.status_code),
      ...(Number(r.http) > 0 ? { httpStatus: Number(r.http) } : {}),
      spanCount: counts.get(r.trace_id) ?? 1,
    }));
  }

  // Satu per trace: root dihitung unik (duplikat insert tidak terhitung), ditambah orphan.
  // Dua query paralel (root dan orphan) lebih cepat daripada satu query dengan dua subquery berurutan.
  async countTraces(projectId: string, q: TraceFilter): Promise<number> {
    const st = traceStatus(q.status);
    const params = { ...traceParams(projectId, q), ...st.params };
    const one = async (query: string) => Number((await (await this.client.query({ query, query_params: params, format: "JSONEachRow" }))
      .json<{ n: string }>())[0]?.n ?? 0);
    const [roots, orphans] = await Promise.all([
      one(`SELECT toString(uniqExact(trace_id)) AS n FROM (${ROOT_REPS}) WHERE ${traceMatch} AND ${st.sql}`),
      one(`SELECT toString(count()) AS n FROM (${ORPHAN_REPS}) WHERE ${traceMatch} AND ${st.sql}`),
    ]);
    return roots + orphans;
  }

  // Satu per trace (root unik + orphan), jadi duplikat insert tidak terhitung; trace tanpa status HTTP diabaikan.
  async traceStatusCounts(projectId: string, q: Omit<TraceFilter, "status">): Promise<StatusCount[]> {
    const params = traceParams(projectId, q);
    const one = async (query: string) => (await (await this.client.query({ query, query_params: params, format: "JSONEachRow" }))
      .json<{ code: number; n: string }>());
    const [roots, orphans] = await Promise.all([
      one(`SELECT toUInt16(r.7) AS code, toString(uniqExact(trace_id)) AS n FROM (${ROOT_REPS}) WHERE ${traceMatch} AND r.7 BETWEEN 100 AND 599 GROUP BY code`),
      one(`SELECT toUInt16(r.7) AS code, toString(count()) AS n FROM (${ORPHAN_REPS}) WHERE ${traceMatch} AND r.7 BETWEEN 100 AND 599 GROUP BY code`),
    ]);
    const by = new Map<number, number>();
    for (const r of [...roots, ...orphans]) by.set(Number(r.code), (by.get(Number(r.code)) ?? 0) + Number(r.n));
    return [...by].map(([code, count]) => ({ code, count }));
  }

  // Satu span server; LIMIT 1 meniadakan baris duplikat dari insert ulang. Nilai non-teks diambil mentah (JSON).
  async serverSpanBody(projectId: string, traceId: string, spanId: string): Promise<ServerSpanBody | null> {
    const attr = (k: string) => `substringUTF8(if(JSONType(attributes, '${k}') = 'String', JSONExtractString(attributes, '${k}'), JSONExtractRaw(attributes, '${k}')), 1, ${BODY_MAX + 1})`;
    const rs = await this.client.query({
      query: `SELECT ${Object.entries(BODY_ATTRS).map(([f, k]) => `${attr(k)} AS ${f}`).join(", ")}
              FROM ${TABLE}
              WHERE project_id = {projectId: String} AND trace_id = {traceId: FixedString(32)} AND span_id = {spanId: FixedString(16)} AND kind = 2
              LIMIT 1`,
      query_params: { projectId, traceId, spanId },
      format: "JSONEachRow",
    });
    const r = (await rs.json<Record<keyof ServerSpanBody, string>>())[0];
    if (!r) return null;
    const out: ServerSpanBody = {};
    for (const f of Object.keys(BODY_ATTRS) as (keyof ServerSpanBody)[]) if (r[f]) out[f] = r[f];
    return out;
  }

  async listServices(projectId: string, fromUs: number, toUs: number): Promise<string[]> {
    const rs = await this.client.query({
      query: `SELECT DISTINCT service FROM ${TABLE}
              WHERE project_id = {projectId: String} AND service != ''
                AND ts >= fromUnixTimestamp64Micro({fromUs: Int64}, 'UTC') AND ts < fromUnixTimestamp64Micro({toUs: Int64}, 'UTC')
              ORDER BY service LIMIT 500`,
      query_params: { projectId, fromUs: Math.floor(fromUs), toUs: Math.ceil(toUs) },
      format: "JSONEachRow",
    });
    return (await rs.json<{ service: string }>()).map((r) => r.service);
  }

  async close() {
    await this.client.close();
  }
}
