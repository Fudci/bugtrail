import { likeEscape } from "./telemetry-store.js";
import { attrs, OtlpError, type Attrs } from "./convert.js";
import type { RawDb } from "@bugtool/db";

// OTLP logs (ExportLogsServiceRequest, https://opentelemetry.io/docs/specs/otel/logs/data-model/) -> log datar.
// Log dengan trace_id ditautkan ke trace (tab Logs di halaman trace) dan ke issue dari trace yang sama.

export interface FlatLog {
  timeUs: number;
  /** 1-24 (TRACE 1-4, DEBUG 5-8, INFO 9-12, WARN 13-16, ERROR 17-20, FATAL 21-24); 0 = tidak diketahui. */
  severityNumber: number;
  severityText?: string | undefined;
  body: string;
  attributes: Attrs;
  resource: Attrs;
  service?: string | undefined;
  traceId?: string | undefined;
  spanId?: string | undefined;
}
export interface StoredLog extends FlatLog { projectId: string }
export interface LogRow extends FlatLog { id: string }

export interface LogSearchQuery {
  /** Wajib kecuali traceId diisi. */
  fromUs?: number | undefined; toUs?: number | undefined;
  text?: string | undefined; service?: string | undefined; traceId?: string | undefined;
  /** Severity minimum (mis. 17 = ERROR ke atas). */
  minSeverity?: number | undefined;
  limit: number;
  /** Kursor "lebih lama dari": (timeUs, id) baris terakhir halaman sebelumnya. */
  before?: { timeUs: number; id: string } | undefined;
  /** Urutan; default terbaru dulu. Tab trace memakai "asc" (kronologis). */
  order?: "asc" | "desc" | undefined;
}

/** Penyimpanan log: SQLite (Lite) atau ClickHouse (Scale, lewat antrian di disk). */
export interface LogStore {
  readonly kind: string;
  writeLogs(logs: StoredLog[]): void | Promise<void>;
  encodeSpans?(logs: StoredLog[]): string;
  writeEncoded?(encoded: string): Promise<void>;
  searchLogs(projectId: string, q: LogSearchQuery): LogRow[] | Promise<LogRow[]>;
  /** Nama service yang punya log di jendela waktu (urut abjad). */
  logServices(projectId: string, fromUs: number, toUs: number): string[] | Promise<string[]>;
  close?(): Promise<void>;
}

export const LOG_BODY_MAX = 16_384;
const ATTR_VALUE_MAX = 2_048;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const nsToUs = (v: unknown): number => {
  if (typeof v === "number") return Math.floor(v / 1000);
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(BigInt(v) / 1000n);
  return 0;
};
const hexId = (v: unknown, len: number): string | undefined => {
  const s = str(v)?.toLowerCase();
  return s && s.length === len && /^[0-9a-f]+$/.test(s) && !/^0+$/.test(s) ? s : undefined;
};

// Severity dari teks kalau severity_number kosong (mis. logger yang hanya mengisi "warn").
const TEXT_SEVERITY: Record<string, number> = { trace: 1, debug: 5, info: 9, information: 9, notice: 10, warn: 13, warning: 13, error: 17, err: 17, critical: 21, fatal: 21, panic: 21 };
export function severityOf(num: unknown, text: string | undefined): number {
  const n = Number(num ?? 0);
  if (Number.isInteger(n) && n >= 1 && n <= 24) return n;
  return (text && TEXT_SEVERITY[text.toLowerCase()]) || 0;
}
/** Nama tingkat severity untuk tampilan. */
export const severityName = (n: number) => (n >= 21 ? "FATAL" : n >= 17 ? "ERROR" : n >= 13 ? "WARN" : n >= 9 ? "INFO" : n >= 5 ? "DEBUG" : n >= 1 ? "TRACE" : "");

function anyText(v: unknown): string {
  if (!isObj(v)) return "";
  if ("stringValue" in v) return String(v["stringValue"] ?? "");
  // Body terstruktur (map/array) disimpan sebagai JSON dari nilai yang sudah diurai.
  const parsed = attrs([{ key: "v", value: v }])["v"];
  return parsed === undefined ? "" : typeof parsed === "string" ? parsed : JSON.stringify(parsed);
}

function cutAttrs(a: Attrs): Attrs {
  for (const [k, v] of Object.entries(a)) if (typeof v === "string" && v.length > ATTR_VALUE_MAX) a[k] = v.slice(0, ATTR_VALUE_MAX);
  return a;
}

export function flattenLogs(body: unknown, nowUs = Date.now() * 1000): FlatLog[] {
  if (!isObj(body) || !Array.isArray(body["resourceLogs"])) throw new OtlpError("expected resourceLogs");
  const out: FlatLog[] = [];
  for (const rl of body["resourceLogs"]) {
    if (!isObj(rl)) continue;
    const resource = attrs(isObj(rl["resource"]) ? rl["resource"]["attributes"] : undefined);
    for (const sl of Array.isArray(rl["scopeLogs"]) ? rl["scopeLogs"] : []) {
      if (!isObj(sl) || !Array.isArray(sl["logRecords"])) continue;
      for (const r of sl["logRecords"]) {
        if (!isObj(r)) continue;
        const text = str(r["severityText"])?.slice(0, 32);
        out.push({
          // Spec: time_unix_nano boleh kosong; pakai observed time, lalu waktu terima.
          timeUs: nsToUs(r["timeUnixNano"]) || nsToUs(r["observedTimeUnixNano"]) || nowUs,
          severityNumber: severityOf(r["severityNumber"], text),
          severityText: text,
          body: anyText(r["body"]).slice(0, LOG_BODY_MAX) || str(r["eventName"]) || "",
          attributes: cutAttrs(attrs(r["attributes"])),
          resource,
          service: str(resource["service.name"])?.slice(0, 200),
          traceId: hexId(r["traceId"], 32),
          spanId: hexId(r["spanId"], 16),
        });
      }
    }
  }
  return out;
}

/** Mode Lite: log di SQLite (tabel logs), retensi lewat process/retention.ts. */
export class SqliteLogStore implements LogStore {
  readonly kind = "sqlite";
  private insert;
  private cache = new Map<string, { all(...params: unknown[]): unknown[] }>();

  constructor(private db: RawDb) {
    this.insert = db.prepare(`INSERT INTO logs (project_id, time_us, received_at, severity_number, severity_text, service, body, attributes, resource, trace_id, span_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  }

  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) this.cache.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  writeLogs(logs: StoredLog[]) {
    if (!logs.length) return;
    const at = Math.floor(Date.now() / 1000);
    this.db.transaction(() => {
      for (const l of logs) {
        this.insert.run(l.projectId, l.timeUs, at, l.severityNumber, l.severityText ?? null, l.service ?? null, l.body,
          JSON.stringify(l.attributes), JSON.stringify(l.resource), l.traceId ?? null, l.spanId ?? null);
      }
    })();
  }

  searchLogs(projectId: string, q: LogSearchQuery): LogRow[] {
    const where = ["project_id = ?"];
    const params: unknown[] = [projectId];
    if (q.traceId) { where.push("trace_id = ?"); params.push(q.traceId); }
    if (q.fromUs !== undefined) { where.push("time_us >= ?"); params.push(q.fromUs); }
    if (q.toUs !== undefined) { where.push("time_us < ?"); params.push(q.toUs); }
    if (q.service) { where.push("service = ?"); params.push(q.service); }
    if (q.minSeverity) { where.push("severity_number >= ?"); params.push(q.minSeverity); }
    // LIKE di SQLite tidak peka huruf besar/kecil untuk ASCII.
    if (q.text) { where.push("body LIKE ? ESCAPE '\\'"); params.push(`%${likeEscape(q.text)}%`); }
    const asc = q.order === "asc";
    if (q.before) {
      where.push(asc ? "(time_us > ? OR (time_us = ? AND id > ?))" : "(time_us < ? OR (time_us = ? AND id < ?))");
      params.push(q.before.timeUs, q.before.timeUs, Number(q.before.id));
    }
    const dir = asc ? "ASC" : "DESC";
    const rows = this.stmt(`SELECT id, time_us, severity_number, severity_text, service, body, attributes, resource, trace_id, span_id
      FROM logs WHERE ${where.join(" AND ")} ORDER BY time_us ${dir}, id ${dir} LIMIT ?`).all(...params, q.limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r["id"]),
      timeUs: Number(r["time_us"]),
      severityNumber: Number(r["severity_number"]),
      severityText: (r["severity_text"] as string | null) ?? undefined,
      service: (r["service"] as string | null) ?? undefined,
      body: String(r["body"]),
      attributes: JSON.parse(String(r["attributes"])),
      resource: JSON.parse(String(r["resource"])),
      traceId: (r["trace_id"] as string | null) ?? undefined,
      spanId: (r["span_id"] as string | null) ?? undefined,
    }));
  }

  // Skip scan lewat index logs_project_service_time: lompat dari service ke service berikutnya (sedikit
  // jumlahnya), lalu cek ada log di jendela. DISTINCT biasa memindai semua log (~2 detik di 3 juta log).
  logServices(projectId: string, fromUs: number, toUs: number): string[] {
    return (this.stmt(`WITH RECURSIVE s(svc, n) AS (
        SELECT (SELECT service FROM logs WHERE project_id = ? AND service IS NOT NULL ORDER BY service LIMIT 1), 1
        UNION ALL
        SELECT (SELECT service FROM logs WHERE project_id = ? AND service > s.svc ORDER BY service LIMIT 1), n + 1
        FROM s WHERE s.svc IS NOT NULL AND n < 1000)
      SELECT svc AS service FROM s
      WHERE svc IS NOT NULL AND EXISTS (SELECT 1 FROM logs WHERE project_id = ? AND service = s.svc AND time_us >= ? AND time_us < ?)
      ORDER BY svc LIMIT 200`)
      .all(projectId, projectId, projectId, fromUs, toUs) as { service: string }[]).map((r) => r.service);
  }
}
