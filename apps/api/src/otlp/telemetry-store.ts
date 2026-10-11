import { toDbDate, type RawDb } from "@bugtool/db";
import type { FlatSpan } from "./convert.js";
import { statusFilterOf, statusSql } from "./status-filter.js";

// Kontrak penyimpanan telemetry. Dua implementasi:
//  - SQLite (mode Lite, default): hanya trace yang berisi error, ditulis langsung (retensi: process/retention.ts);
//  - ClickHouse (mode Scale): semua span, ditulis lewat antrian di disk (span-queue.ts), retensi lewat TTL.
// Penerima OTLP dan halaman dashboard hanya memakai kontrak ini.
export interface StoredSpan extends FlatSpan {
  projectId: string;
}

/** Satu request (span server) untuk daftar API Health. */
export interface RequestRow { traceId: string; spanId: string; startUs: number; durationUs: number; status: number; method: string; route: string; service?: string }
export interface ListRequestsQuery { method: string; route: string; fromUs: number; toUs: number;
  /** Filter status (lihat status-filter.ts), mis. "5xx", "500,502", "520-529", "all". */
  status: string; limit: number; beforeUs?: number; beforeSpanId?: string; offset?: number }

/** Penyebab gagal satu request: exception pertama di trace, atau status_message span server. */
export interface RequestError { type?: string; message?: string; stacktrace?: string; spanName?: string }
/** Atribut body span server (mentah, sudah dipotong BODY_MAX + 1 karakter oleh store). */
export interface ServerSpanBody { request?: string; query?: string; response?: string; userId?: string }
/** Batas panjang (karakter) tiap body di respons API; store mengambil 1 karakter lebih untuk mendeteksi pemotongan. */
export const BODY_MAX = 65_536;
export const BODY_ATTRS = { request: "http.request.body", query: "http.request.query", response: "http.response.body", userId: "enduser.id" } as const;
export interface TopError { type?: string; message: string; count: number }
export type RequestFilter = Pick<ListRequestsQuery, "method" | "route" | "fromUs" | "toUs" | "status">;

/** Filter pencarian trace; satu baris per trace diwakili span root-nya. */
export interface TraceSearchQuery {
  fromUs: number; toUs: number; service?: string; text?: string;
  /** Filter status (lihat status-filter.ts); "error" = status span root error atau HTTP >= 500. */
  status: string;
  minDurationUs?: number; limit: number; beforeUs?: number; beforeSpanId?: string; offset?: number;
}
/** Filter trace tanpa paging (untuk menghitung total). */
export type TraceFilter = Omit<TraceSearchQuery, "limit" | "beforeUs" | "beforeSpanId" | "offset">;
export interface TraceRow {
  traceId: string; spanId: string; startUs: number; durationUs: number; service?: string; name: string;
  statusCode: number; httpStatus?: number; spanCount: number;
}

/** Escape wildcard LIKE (%, _, \) supaya teks user dicocokkan apa adanya (dipakai dengan ESCAPE '\'). */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// Batas panjang supaya respons daftar request tetap kecil.
export const ERR_MESSAGE_MAX = 1024;
export const ERR_STACK_MAX = 8192;
/** Rentang waktu tambahan di sekitar span server saat mencari span lain satu trace (span anak/async). */
export const TRACE_MARGIN_US = 3600e6;
/** Batas jumlah request yang dihitung untuk topErrors (yang terbaru). */
export const TOP_ERRORS_SCAN = 50_000;
/**
 * Batas mode Lite (SQLite, sinkron di event loop): top errors dihitung dari 2.000 request tersampel
 * terbaru yang cocok filter saja, supaya satu request dashboard tidak memblok server.
 */
export const LITE_TOP_ERRORS_SCAN = 2_000;
/** Paging bernomor: offset ((page-1)*size) harus di bawah batas ini supaya query OFFSET tetap murah. */
export const MAX_PAGE_OFFSET = 10_000;

/** Kandidat error dari satu span; ex* terisi kalau span punya event exception. */
export interface ErrorCandidate {
  traceId: string; spanName: string; kind: number; statusMessage?: string;
  ex?: { timeUs: number; type?: string; message?: string; stacktrace?: string };
}

const cut = (v: unknown, n: number) => (typeof v === "string" && v !== "" ? v.slice(0, n) : undefined);

/** Exception paling awal (menurut waktu event) dari events JSON satu span. */
export function firstException(events: { name: string; timeUs: number; attributes: Record<string, unknown> }[], spanStartUs: number) {
  let best: ErrorCandidate["ex"];
  for (const e of events) {
    if (e.name !== "exception") continue;
    const t = e.timeUs || spanStartUs;
    if (best && best.timeUs <= t) continue;
    const a = e.attributes ?? {};
    best = { timeUs: t, type: cut(a["exception.type"], 300), message: cut(a["exception.message"], ERR_MESSAGE_MAX), stacktrace: cut(a["exception.stacktrace"], ERR_STACK_MAX) };
  }
  return best;
}

/** Per trace: exception paling awal di semua span; kalau tidak ada, status_message span server. */
export function reduceErrors(cands: ErrorCandidate[]): Map<string, RequestError> {
  const ex = new Map<string, ErrorCandidate>();
  const st = new Map<string, ErrorCandidate>();
  for (const c of cands) {
    if (c.ex) { const b = ex.get(c.traceId); if (!b || c.ex.timeUs < b.ex!.timeUs) ex.set(c.traceId, c); }
    else if (c.kind === 2 && c.statusMessage && !st.has(c.traceId)) st.set(c.traceId, c);
  }
  const out = new Map<string, RequestError>();
  for (const [t, c] of ex) out.set(t, { type: c.ex!.type, message: c.ex!.message, stacktrace: c.ex!.stacktrace, spanName: c.spanName });
  for (const [t, c] of st) if (!out.has(t)) out.set(t, { message: c.statusMessage!.slice(0, ERR_MESSAGE_MAX), spanName: c.spanName });
  return out;
}

/** Kelompokkan error per (type, message), 5 terbanyak. */
export function groupTopErrors(errors: Iterable<RequestError>, n = 5): TopError[] {
  const m = new Map<string, TopError>();
  for (const e of errors) {
    const k = `${e.type ?? ""}\u0000${e.message ?? ""}`;
    const g = m.get(k);
    if (g) g.count++;
    else m.set(k, { ...(e.type ? { type: e.type } : {}), message: e.message ?? "", count: 1 });
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.message.localeCompare(b.message)).slice(0, n);
}

/** Jumlah per kode status HTTP (untuk chip filter). */
export interface StatusCount { code: number; count: number }

/** Bentuk JSON trace untuk dashboard (dipakai route trace issue dan trace project). */
export function traceView(traceId: string, spans: StoredSpan[]) {
  return {
    traceId,
    spans: spans.map(({ projectId: _p, resource, ...s }) => ({ ...s, service: s.service ?? (resource["service.name"] as string | undefined) })),
    resource: spans[0]!.resource,
  };
}

export interface TelemetryStore {
  /** "sqlite" atau "clickhouse"; ditampilkan di Settings. */
  readonly kind: string;
  /** true = simpan semua span (mode Scale); false = hanya trace yang berisi error (mode Lite). */
  readonly storesAllSpans: boolean;
  writeSpans(spans: StoredSpan[]): void | Promise<void>;
  getTrace(projectId: string, traceId: string): StoredSpan[] | Promise<StoredSpan[]>;
  /**
   * Opsional (dipakai TelemetryQueue): ubah span ke format tulis penyimpanan SEKALI saat masuk antrian, lalu kirim
   * teks itu apa adanya, supaya proses latar tidak mem-parse dan meng-encode ulang JSON (memblokir event loop).
   */
  encodeSpans?(spans: StoredSpan[]): string;
  writeEncoded?(encoded: string): Promise<void>;
  /** Daftar request satu endpoint (span server), terbaru dulu; paging lewat beforeUs. */
  listRequests?(projectId: string, q: ListRequestsQuery): RequestRow[] | Promise<RequestRow[]>;
  /** Jumlah request yang cocok filter di jendela (duplikat insert tidak dihitung dua kali). */
  countRequests?(projectId: string, q: RequestFilter): number | Promise<number>;
  /** Penyebab gagal per trace (satu query untuk satu halaman); range = rentang start span server halaman itu. */
  traceErrors?(projectId: string, traceIds: string[], range?: { fromUs: number; toUs: number }): Map<string, RequestError> | Promise<Map<string, RequestError>>;
  /** Body request/response dari atribut span server (kind 2); null kalau span tidak ada di project itu. */
  serverSpanBody?(projectId: string, traceId: string, spanId: string): ServerSpanBody | null | Promise<ServerSpanBody | null>;
  /** 5 error terbanyak di request yang cocok dengan filter (seluruh jendela, bukan hanya satu halaman). */
  topErrors?(projectId: string, q: RequestFilter): TopError[] | Promise<TopError[]>;
  /**
   * Cari trace di jendela waktu, terbaru dulu; paging kursor (startUs, spanId). Wakil trace = span root
   * (tanpa parent); kalau root tidak tersimpan, span server paling awal di jendela (best-effort).
   */
  searchTraces?(projectId: string, q: TraceSearchQuery): TraceRow[] | Promise<TraceRow[]>;
  /** Jumlah trace (wakil) yang cocok filter di jendela; aturan sama dengan searchTraces. */
  countTraces?(projectId: string, q: TraceFilter): number | Promise<number>;
  /** Jumlah request per kode status (filter sama dengan countRequests, TANPA filter status). */
  requestStatusCounts?(projectId: string, q: Omit<RequestFilter, "status">): StatusCount[] | Promise<StatusCount[]>;
  /** Jumlah trace per status HTTP wakilnya (filter sama dengan countTraces, TANPA filter status; tanpa HTTP tidak dihitung). */
  traceStatusCounts?(projectId: string, q: Omit<TraceFilter, "status">): StatusCount[] | Promise<StatusCount[]>;
  /** Nama service yang punya span di jendela waktu (urut abjad). */
  listServices?(projectId: string, fromUs: number, toUs: number): string[] | Promise<string[]>;
  /** Cek koneksi untuk /health. */
  ping?(): Promise<boolean>;
  close?(): Promise<void>;
}

// Aturan status pencarian trace (kolom http/status_code dari subquery searchTraces); token "error".
const SQLITE_TRACE_ERROR = "(status_code = 2 OR coalesce(http, 0) >= 500)";
const qmark = () => "?";
/** Status request: selalu 100-599 (sama dengan endpointKey) lalu filter dari token. */
const reqStatus = (raw: string) => {
  const w = statusSql(statusFilterOf(raw), "status", qmark);
  return { sql: `status BETWEEN 100 AND 599 AND ${w.sql}`, params: w.params };
};
const traceStatus = (raw: string) => statusSql(statusFilterOf(raw, { allowError: true }), "http", qmark, SQLITE_TRACE_ERROR);

export class SqliteTelemetryStore implements TelemetryStore {
  readonly kind = "sqlite";
  readonly storesAllSpans = false;
  private insert;
  private select;
  private reqInner;
  private errors;
  // Statement per teks SQL; bentuknya hanya bergantung pada jumlah token status (maks MAX_STATUS_TOKENS).
  private stmts = new Map<string, { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown }>();
  private spanCounts;
  private services;
  private body;

  constructor(private db: RawDb) {
    // Lewat primary key (project_id, trace_id, span_id).
    this.spanCounts = db.prepare(`SELECT trace_id, count(*) AS n FROM trace_spans
      WHERE project_id = ? AND trace_id IN (SELECT value FROM json_each(?)) GROUP BY trace_id`);
    this.services = db.prepare(`SELECT DISTINCT service FROM trace_spans
      WHERE project_id = ? AND service IS NOT NULL AND service != '' AND start_us >= ? AND start_us < ? ORDER BY service LIMIT 500`);
    // Lewat primary key; nilai non-teks (angka/objek) dari json_extract dijadikan teks oleh substr.
    const attr = (k: string) => `substr(json_extract(attributes, '$."${k}"'), 1, ${BODY_MAX + 1})`;
    this.body = db.prepare(`SELECT ${Object.entries(BODY_ATTRS).map(([f, k]) => `${attr(k)} AS ${f}`).join(", ")}
      FROM trace_spans WHERE project_id = ? AND trace_id = ? AND span_id = ? AND kind = 2`);
    // Span yang sama bisa terkirim ulang (retry exporter): abaikan duplikat.
    this.insert = db.prepare(`INSERT OR IGNORE INTO trace_spans
      (project_id, trace_id, span_id, parent_span_id, service, name, kind, start_us, duration_us,
       status_code, status_message, attributes, events, resource, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.select = db.prepare(`SELECT * FROM trace_spans WHERE project_id = ? AND trace_id = ? ORDER BY start_us, span_id LIMIT 2000`);
    // Kursor paging komposit (start_us, span_id) supaya span dengan waktu sama tidak hilang antar halaman.
    // Aturan method/route/status sama dengan endpointKey (rollups.ts). Index (project_id, kind, start_us)
    // membatasi scan ke span server di jendela waktu.
    // http_method/http_route/http_status: kolom generated + index trace_spans_endpoint (migrasi 20261015000000).
    this.reqInner = `SELECT trace_id, span_id, start_us, duration_us, service, http_method AS method, http_route AS route, http_status AS status
        FROM trace_spans
        WHERE project_id = ? AND kind = 2 AND start_us >= ? AND start_us < ?`;
    // Lewat primary key (project_id, trace_id, span_id); hanya span dengan exception atau span server bermasalah.
    this.errors = db.prepare(`SELECT trace_id, name, kind, start_us, status_message, events FROM trace_spans
      WHERE project_id = ? AND trace_id IN (SELECT value FROM json_each(?))
        AND (instr(events, '"exception"') > 0 OR (kind = 2 AND coalesce(status_message, '') != ''))
      ORDER BY start_us, span_id`);
  }

  writeSpans(spans: StoredSpan[]) {
    if (!spans.length) return;
    const now = toDbDate(new Date());
    this.db.transaction(() => {
      for (const s of spans) {
        this.insert.run(s.projectId, s.traceId, s.spanId, s.parentSpanId ?? null, s.service ?? null, s.name.slice(0, 500), s.kind,
          s.startUs, s.durationUs, s.statusCode, s.statusMessage?.slice(0, 2000) ?? null,
          JSON.stringify(s.attributes), JSON.stringify(s.events), JSON.stringify(s.resource), now);
      }
    })();
  }

  getTrace(projectId: string, traceId: string): StoredSpan[] {
    return (this.select.all(projectId, traceId) as Record<string, unknown>[]).map((r) => ({
      projectId,
      traceId,
      spanId: r["span_id"] as string,
      parentSpanId: (r["parent_span_id"] as string | null) ?? undefined,
      service: (r["service"] as string | null) ?? undefined,
      name: r["name"] as string,
      kind: Number(r["kind"]),
      startUs: Number(r["start_us"]),
      durationUs: Number(r["duration_us"]),
      statusCode: Number(r["status_code"]),
      statusMessage: (r["status_message"] as string | null) ?? undefined,
      attributes: JSON.parse(r["attributes"] as string),
      events: JSON.parse(r["events"] as string),
      resource: JSON.parse(r["resource"] as string),
    }));
  }

  private stmt(sql: string) {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  listRequests(projectId: string, q: ListRequestsQuery): RequestRow[] {
    const st = reqStatus(q.status);
    const rows = this.stmt(`SELECT * FROM (${this.reqInner} AND (start_us < ? OR (start_us = ? AND span_id < ?)))
      WHERE method = ? AND route = ? AND ${st.sql}
      ORDER BY start_us DESC, span_id DESC LIMIT ? OFFSET ?`)
      .all(projectId, q.fromUs, q.toUs, q.beforeUs ?? q.toUs, q.beforeUs ?? q.toUs, q.beforeSpanId ?? "", q.method, q.route, ...st.params, q.limit, q.offset ?? 0) as Record<string, unknown>[];
    return rows.map((r) => ({
      traceId: r["trace_id"] as string,
      spanId: r["span_id"] as string,
      startUs: Number(r["start_us"]),
      durationUs: Number(r["duration_us"]),
      status: Number(r["status"]),
      method: r["method"] as string,
      route: r["route"] as string,
      service: (r["service"] as string | null) ?? undefined,
    }));
  }

  // Primary key (project_id, trace_id, span_id) sudah meniadakan duplikat, jadi COUNT(*) cukup.
  countRequests(projectId: string, q: RequestFilter): number {
    const st = reqStatus(q.status);
    return Number((this.stmt(`SELECT COUNT(*) AS n FROM (${this.reqInner}) WHERE method = ? AND route = ? AND ${st.sql}`)
      .get(projectId, q.fromUs, q.toUs, q.method, q.route, ...st.params) as { n: number }).n);
  }

  requestStatusCounts(projectId: string, q: Omit<RequestFilter, "status">): StatusCount[] {
    const rows = this.stmt(`SELECT status AS code, COUNT(*) AS n FROM (${this.reqInner})
      WHERE method = ? AND route = ? AND status BETWEEN 100 AND 599 GROUP BY status`)
      .all(projectId, q.fromUs, q.toUs, q.method, q.route) as { code: number; n: number }[];
    return rows.map((r) => ({ code: Number(r.code), count: Number(r.n) }));
  }

  traceErrors(projectId: string, traceIds: string[]): Map<string, RequestError> {
    const cands: ErrorCandidate[] = [];
    // Dipotong per 500 id supaya parameter JSON tetap kecil (topErrors bisa memanggil dengan ribuan id).
    for (let i = 0; i < traceIds.length; i += 500) {
      const rows = this.errors.all(projectId, JSON.stringify(traceIds.slice(i, i + 500))) as Record<string, unknown>[];
      for (const r of rows) {
        let events = [];
        try { events = JSON.parse(r["events"] as string); } catch { /* events rusak: abaikan */ }
        cands.push({
          traceId: r["trace_id"] as string, spanName: r["name"] as string, kind: Number(r["kind"]),
          statusMessage: (r["status_message"] as string | null) ?? undefined,
          ex: Array.isArray(events) ? firstException(events, Number(r["start_us"])) : undefined,
        });
      }
    }
    return reduceErrors(cands);
  }

  // Wakil per trace: span root; kalau root tidak tersimpan ("orphan"), span server paling awal.
  // Root dibaca langsung lewat index parsial trace_spans_root_start (urut waktu, tanpa pengelompokan);
  // hanya orphan yang dikelompokkan, dan untuk satu halaman hanya di rentang waktu halaman itu.
  // Mengelompokkan semua trace di jendela (row_number per trace) butuh ~1 detik di 200 ribu trace, dan di
  // Lite query SQLite menahan event loop server selama itu.
  searchTraces(projectId: string, q: TraceSearchQuery): TraceRow[] {
    const st = traceStatus(q.status);
    const need = q.limit + (q.offset ?? 0);
    const cursor = [q.beforeUs ?? q.toUs, q.beforeUs ?? q.toUs, q.beforeSpanId ?? ""];
    const page = (sql: string, params: unknown[]) => this.stmt(`${sql} AND ${st.sql} AND (start_us < ? OR (start_us = ? AND span_id < ?))
        ORDER BY start_us DESC, span_id DESC LIMIT ?`).all(...params, ...st.params, ...cursor, need) as Record<string, unknown>[];
    const rq = this.rootQuery(projectId, q);
    const roots = page(rq.sql, rq.params);
    // Orphan hanya bisa masuk halaman kalau lebih baru dari root ke-`need`.
    const cutoff = roots.length >= need ? Number(roots[roots.length - 1]!["start_us"]) : q.fromUs;
    const oq = this.orphanQuery(projectId, { ...q, fromUs: cutoff });
    const orphans = page(oq.sql, oq.params);
    const rows = [...roots, ...orphans]
      .sort((a, b) => Number(b["start_us"]) - Number(a["start_us"]) || String(b["span_id"]).localeCompare(String(a["span_id"])))
      .slice(q.offset ?? 0, need);
    const counts = new Map<string, number>();
    if (rows.length) {
      for (const c of this.spanCounts.all(projectId, JSON.stringify(rows.map((r) => r["trace_id"]))) as { trace_id: string; n: number }[]) {
        counts.set(c.trace_id, Number(c.n));
      }
    }
    return rows.map((r) => ({
      traceId: r["trace_id"] as string,
      spanId: r["span_id"] as string,
      startUs: Number(r["start_us"]),
      durationUs: Number(r["duration_us"]),
      ...(r["service"] != null ? { service: r["service"] as string } : {}),
      name: r["name"] as string,
      statusCode: Number(r["status_code"]),
      ...(r["http"] != null && Number(r["http"]) > 0 ? { httpStatus: Number(r["http"]) } : {}),
      spanCount: counts.get(r["trace_id"] as string) ?? 1,
    }));
  }

  countTraces(projectId: string, q: TraceFilter): number {
    const st = traceStatus(q.status);
    const n = (sql: string, params: unknown[]) => Number((this.stmt(`SELECT COUNT(*) AS n FROM (${sql} AND ${st.sql})`)
      .get(...params, ...st.params) as { n: number }).n);
    const rq = this.rootQuery(projectId, q), oq = this.orphanQuery(projectId, q);
    return n(rq.sql, rq.params) + n(oq.sql, oq.params);
  }

  traceStatusCounts(projectId: string, q: Omit<TraceFilter, "status">): StatusCount[] {
    const by = new Map<number, number>();
    for (const { sql, params } of [this.rootQuery(projectId, q), this.orphanQuery(projectId, q)]) {
      for (const r of this.stmt(`SELECT http AS code, COUNT(*) AS n FROM (${sql} AND http BETWEEN 100 AND 599) GROUP BY http`).all(...params) as { code: number; n: number }[]) {
        by.set(Number(r.code), (by.get(Number(r.code)) ?? 0) + Number(r.n));
      }
    }
    return [...by].map(([code, count]) => ({ code, count }));
  }

  // Filter hanya dipasang kalau diisi: tanpa filter, hitungan cukup dari index (tanpa mengurai JSON per baris).
  private repFilter(q: Omit<TraceFilter, "status">) {
    const sql: string[] = [];
    const params: unknown[] = [];
    if (q.service) { sql.push("service = ?"); params.push(q.service); }
    if (q.text) {
      const like = `%${likeEscape(q.text)}%`;
      sql.push("(route LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    if (q.minDurationUs) { sql.push("duration_us >= ?"); params.push(q.minDurationUs); }
    return { sql: sql.length ? sql.join(" AND ") : "1 = 1", params };
  }
  private rootQuery(projectId: string, q: Omit<TraceFilter, "status">) {
    const f = this.repFilter(q);
    return { sql: this.rootSql(f.sql), params: [projectId, q.fromUs, q.toUs, ...f.params] };
  }
  private orphanQuery(projectId: string, q: Omit<TraceFilter, "status">) {
    const f = this.repFilter(q);
    return { sql: this.orphanSql(f.sql), params: [projectId, q.fromUs, q.toUs, q.fromUs - TRACE_MARGIN_US, q.toUs, ...f.params] };
  }

  // Kolom wakil + filter teks/service/durasi; hanya fragmen tetap yang disisipkan, input user lewat parameter.
  // route = http.route atau nama span (untuk pencarian teks bersama name).
  private static readonly REP_COLS = `trace_id, span_id, start_us, duration_us, service, name, status_code, http_status AS http, http_route AS route`;
  private rootSql(filter: string) {
    return `SELECT * FROM (SELECT ${SqliteTelemetryStore.REP_COLS}
          FROM trace_spans INDEXED BY trace_spans_root_start
          WHERE project_id = ? AND (parent_span_id IS NULL OR parent_span_id = '') AND start_us >= ? AND start_us < ?)
        WHERE ${filter}`;
  }
  // Span server tanpa root tersimpan (root dicari sedikit lebih awal dari jendela: TRACE_MARGIN_US).
  private orphanSql(filter: string) {
    return `SELECT * FROM (SELECT ${SqliteTelemetryStore.REP_COLS},
            row_number() OVER (PARTITION BY trace_id ORDER BY start_us, span_id) AS rn
          FROM trace_spans t INDEXED BY trace_spans_child_server_start
          WHERE project_id = ? AND kind = 2 AND parent_span_id IS NOT NULL AND parent_span_id != '' AND start_us >= ? AND start_us < ?
            AND NOT EXISTS (SELECT 1 FROM trace_spans r WHERE r.project_id = t.project_id AND r.trace_id = t.trace_id
              AND (r.parent_span_id IS NULL OR r.parent_span_id = '') AND r.start_us >= ? AND r.start_us < ?))
        WHERE rn = 1 AND ${filter}`;
  }

  serverSpanBody(projectId: string, traceId: string, spanId: string): ServerSpanBody | null {
    const r = this.body.get(projectId, traceId, spanId) as Record<string, unknown> | undefined;
    if (!r) return null;
    const out: ServerSpanBody = {};
    for (const f of Object.keys(BODY_ATTRS) as (keyof ServerSpanBody)[]) if (r[f] != null) out[f] = String(r[f]);
    return out;
  }

  listServices(projectId: string, fromUs: number, toUs: number): string[] {
    return (this.services.all(projectId, fromUs, toUs) as { service: string }[]).map((r) => r.service);
  }

  // Lite hanya menyimpan trace tersampel, jadi cukup ambil trace di jendela lalu kelompokkan di JS.
  // Lite: hanya LITE_TOP_ERRORS_SCAN request terbaru (lihat docs/self-hosting.md).
  topErrors(projectId: string, q: RequestFilter, scan = LITE_TOP_ERRORS_SCAN): TopError[] {
    const reqs = this.listRequests(projectId, { ...q, limit: scan });
    return groupTopErrors(this.traceErrors(projectId, [...new Set(reqs.map((r) => r.traceId))]).values());
  }
}
