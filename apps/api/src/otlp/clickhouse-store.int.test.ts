import { describe, expect, it } from "vitest";
import { ClickHouseTelemetryStore } from "./clickhouse-store.js";
import { BODY_MAX } from "./telemetry-store.js";
import { flattenSpans } from "./convert.js";
import { sampleRequest } from "./fixtures.js";

// Tes ke ClickHouse sungguhan. Dilewati kalau CLICKHOUSE_TEST_URL tidak di-set (CI menjalankannya
// dengan service clickhouse/clickhouse-server). Database dibuat sendiri oleh init().
const url = process.env["CLICKHOUSE_TEST_URL"];
const db = `bt_test_${Date.now()}`;

// Jumlah baris mentah (tanpa penyaringan duplikat seperti di getTrace).
async function rowCount(s: ClickHouseTelemetryStore, traceId: string) {
  const c = (s as unknown as { client: { query: (p: object) => Promise<{ json: () => Promise<{ n: string }[]> }> } }).client;
  const rs = await c.query({ query: "SELECT count() AS n FROM otel_spans WHERE trace_id = {t: String}", query_params: { t: traceId }, format: "JSONEachRow" });
  return Number((await rs.json())[0]!.n);
}

describe.skipIf(!url)("ClickHouseTelemetryStore (real ClickHouse)", () => {
  const store = () => new ClickHouseTelemetryStore({
    url: url!,
    username: process.env["CLICKHOUSE_TEST_USER"] ?? "default",
    password: process.env["CLICKHOUSE_TEST_PASSWORD"] ?? "",
    database: db,
    // Contoh data bertanggal Oktober 2025 dengan retensi 7 hari: tetap tersimpan karena TTL dihitung dari waktu terima.
    retentionDays: () => 7,
  });

  it("creates its database and table, stores spans and reads a trace back with microsecond times", async () => {
    const s = store();
    await s.init();
    await s.init(); // idempoten
    expect(await s.ping()).toBe(true);
    const spans = flattenSpans(sampleRequest("abababababababababababababababab")).map((x) => ({ ...x, projectId: "p1" }));
    await s.writeSpans(spans);
    // Kirim ulang batch yang sama (respons hilang): ClickHouse mengabaikan duplikatnya.
    await s.writeEncoded(s.encodeSpans(spans));
    expect(await rowCount(s, "abababababababababababababababab")).toBe(2);
    const trace = await s.getTrace("p1", "abababababababababababababababab");
    expect(trace.map((t) => t.name)).toEqual(["POST /orders", "SELECT coupons"]);
    expect(trace[0]).toMatchObject({ startUs: spans[0]!.startUs, durationUs: 612400, statusCode: 2, service: "checkout-api" });
    expect(trace[0]!.events[0]?.attributes["exception.type"]).toBe("SequelizeDatabaseError");
    expect(trace[1]).toMatchObject({ parentSpanId: "00f067aa0ba902b7" });
    expect(await s.getTrace("other-project", "abababababababababababababababab")).toEqual([]);
    await s.close();
  });

  it("rejects malformed rows with an error the span queue treats as 'rejected', not as a connection error", async () => {
    const s = store();
    await s.init();
    const err = await s.writeEncoded("not json\n").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const { isRejected } = await import("./telemetry-queue.js");
    expect(isRejected(err)).toBe(true);
    await s.close();
  });

  it("lists individual server requests with status as number or string, route fallback, dedupe and paging", async () => {
    const s = store();
    await s.init();
    const now = Date.now() * 1000;
    let n = 0;
    const sp = (o: { ago: number; status?: number | string; route?: string | null; kind?: number; name?: string; method?: string }) => {
      n++;
      const attributes: Record<string, unknown> = { "http.method": o.method ?? "get" };
      if (o.route !== null) attributes["http.route"] = o.route ?? "/a";
      if (o.status !== undefined) attributes["http.status_code"] = o.status;
      return { projectId: "rq", traceId: n.toString(16).padStart(32, "c"), spanId: n.toString(16).padStart(16, "d"), name: o.name ?? "GET /a",
        kind: o.kind ?? 2, startUs: now - o.ago * 1e6, durationUs: 5000, statusCode: 0, attributes, events: [], resource: {}, service: "api" };
    };
    const spans = [
      sp({ ago: 30, status: 500 }), sp({ ago: 20, status: "503" }), sp({ ago: 10, status: 404 }), sp({ ago: 5, status: 200 }),
      sp({ ago: 15, status: 500, kind: 3 }), sp({ ago: 25, status: 500, route: "/b" }), sp({ ago: 12, status: 502, route: null, name: "/a" }),
      sp({ ago: 7200, status: 500 }),
    ];
    await s.writeSpans(spans);
    await s.writeEncoded(s.encodeSpans(spans.slice(0, 1))); // duplikat (token beda): harus tetap satu baris
    const q = { method: "GET", route: "/a", fromUs: now - 3600e6, toUs: now + 1e6, status: "5xx" as const, limit: 50 };
    const r5 = await s.listRequests("rq", q);
    expect(r5.map((r) => r.status)).toEqual([502, 503, 500]);
    expect(r5[0]).toMatchObject({ method: "GET", route: "/a", service: "api", durationUs: 5000, startUs: now - 12e6 });
    expect((await s.listRequests("rq", { ...q, status: "4xx" })).map((r) => r.status)).toEqual([404]);
    expect((await s.listRequests("rq", { ...q, status: "all" })).map((r) => r.status)).toEqual([200, 404, 502, 503, 500]);
    const p1 = await s.listRequests("rq", { ...q, limit: 2 });
    expect(p1.map((r) => r.status)).toEqual([502, 503]);
    expect((await s.listRequests("rq", { ...q, limit: 2, beforeUs: p1[1]!.startUs })).map((r) => r.status)).toEqual([500]);
    expect(await s.listRequests("other", q)).toEqual([]);
    // Kode persis + rentang; status angka atau teks; statusCounts tanpa filter status, duplikat insert dihitung sekali.
    expect((await s.listRequests("rq", { ...q, status: "500,503" })).map((r) => r.status)).toEqual([503, 500]);
    expect((await s.listRequests("rq", { ...q, status: "502-503,2xx" })).map((r) => r.status)).toEqual([200, 502, 503]);
    expect(await s.countRequests("rq", { ...q, status: "500" })).toBe(1);
    const sc = await s.requestStatusCounts("rq", { method: "GET", route: "/a", fromUs: q.fromUs, toUs: q.toUs });
    expect(sc.sort((x, y) => x.code - y.code)).toEqual([200, 404, 500, 502, 503].map((code) => ({ code, count: 1 })));
    // Tiga span dengan waktu sama (+ satu status null yang jatuh ke http.status_code): paging tanpa hilang/duplikat.
    const t = now - 100e6;
    const same = [1, 2, 3].map(() => ({ ...sp({ ago: 0, status: 500, route: "/same" }), startUs: t }));
    const nul = { ...sp({ ago: 0, status: 500, route: "/null" }), startUs: t };
    nul.attributes["http.response.status_code"] = null;
    await s.writeSpans([...same, nul]);
    const qs = { ...q, route: "/same", limit: 2 };
    const a = await s.listRequests("rq", qs);
    const b = await s.listRequests("rq", { ...qs, beforeUs: a[1]!.startUs, beforeSpanId: a[1]!.spanId });
    const ids = [...a, ...b].map((r) => r.spanId);
    expect(ids).toHaveLength(3);
    expect(ids.sort()).toEqual(same.map((x) => x.spanId).sort());
    expect((await s.listRequests("rq", { ...q, route: "/null" })).map((r) => r.status)).toEqual([500]);
    await s.close();
  });

  it("finds the error of each trace and the top errors of a window", async () => {
    const s = store();
    await s.init();
    const now = Date.now() * 1000;
    const ex = (t: number, type: string, message: string) => ({ name: "exception", timeUs: t, attributes: { "exception.type": type, "exception.message": message, "exception.stacktrace": "at y\n".repeat(3000) } });
    let n = 0;
    const sp = (ago: number, o: Partial<{ kind: number; parent: string; trace: string; name: string; statusMessage: string; events: unknown[]; status: number }> = {}) => {
      n++;
      return { projectId: "te", traceId: o.trace ?? n.toString(16).padStart(32, "e"), spanId: n.toString(16).padStart(16, "f"), parentSpanId: o.parent,
        name: o.name ?? "GET /e", kind: o.kind ?? 2, startUs: now - ago * 1e6, durationUs: 1000, statusCode: 2, statusMessage: o.statusMessage,
        attributes: o.kind && o.kind !== 2 ? {} : { "http.method": "GET", "http.route": "/e", "http.status_code": o.status ?? 500 },
        events: (o.events ?? []) as never, resource: {}, service: "api" };
    };
    const a = sp(40);
    const childA = sp(40, { kind: 3, parent: a.spanId, trace: a.traceId, name: "SELECT coupons", events: [ex(now - 39e6, "Late", "later"), ex(now - 39.5e6, "DbError", "x".repeat(3000))] });
    const b = sp(30, { statusMessage: "upstream timeout" });
    const c = sp(20);
    const d = sp(10, { events: [ex(now - 10e6, "DbError", "x".repeat(3000))] });
    const ok = sp(5, { status: 200, events: [ex(now - 5e6, "Ignored", "not 5xx")] });
    await s.writeSpans([a, childA, b, c, d, ok]);
    await s.writeSpans([childA]); // duplikat: tidak menggandakan hitungan
    const m = await s.traceErrors("te", [a.traceId, b.traceId, c.traceId], { fromUs: now - 40e6, toUs: now - 20e6 });
    expect(m.get(a.traceId)).toMatchObject({ type: "DbError", spanName: "SELECT coupons" });
    expect(m.get(a.traceId)!.message).toHaveLength(1024);
    expect(m.get(a.traceId)!.stacktrace).toHaveLength(8192);
    expect(m.get(b.traceId)).toEqual({ message: "upstream timeout", spanName: "GET /e" });
    expect(m.has(c.traceId)).toBe(false);
    expect((await s.traceErrors("other", [a.traceId])).size).toBe(0);
    const w = { method: "GET", route: "/e", fromUs: now - 3600e6, toUs: now + 1e6, status: "5xx" as const };
    expect(await s.topErrors("te", w)).toEqual([{ type: "DbError", message: "x".repeat(1024), count: 2 }, { message: "upstream timeout", count: 1 }]);
    expect((await s.topErrors("te", { ...w, status: "all" }))[1]).toEqual({ type: "Ignored", message: "not 5xx", count: 1 });
    await s.close();
  });

  it("searches traces by root span with filters, span count, dedupe, paging ties and services", async () => {
    const s = store();
    await s.init();
    const now = Date.now() * 1000;
    let n = 0;
    const sp = (o: { ago: number; trace?: string; parent?: string; kind?: number; service?: string; name?: string; route?: string; http?: number | string | null; statusCode?: number; ms?: number }) => {
      n++;
      const attributes: Record<string, unknown> = {};
      if (o.route !== undefined) attributes["http.route"] = o.route;
      if (o.http !== undefined) attributes["http.response.status_code"] = o.http;
      return { projectId: "ts", traceId: o.trace ?? n.toString(16).padStart(32, "a"), spanId: n.toString(16).padStart(16, "b"), parentSpanId: o.parent,
        name: o.name ?? "GET /x", kind: o.kind ?? 2, startUs: now - o.ago * 1e6, durationUs: (o.ms ?? 5) * 1000, statusCode: o.statusCode ?? 0,
        attributes, events: [], resource: {}, service: o.service ?? "api" };
    };
    const t1 = sp({ ago: 10, route: "/users/:id", name: "GET /users/:id", http: 200 });
    const t1c = sp({ ago: 10, trace: t1.traceId, parent: t1.spanId, kind: 3, name: "SELECT users" });
    const t2 = sp({ ago: 20, http: 503, name: "POST /pay" });
    const t3 = sp({ ago: 30, service: "web", http: "404", route: "/a_b%" });
    const t4 = sp({ ago: 40, http: 200, statusCode: 2, ms: 900 });
    const t5 = sp({ ago: 50, parent: "f".repeat(16), name: "GET /orphan" }); // tanpa root tersimpan
    const t5b = sp({ ago: 49, trace: t5.traceId, parent: "e".repeat(16), name: "GET /orphan-later" });
    // http.response.status_code null -> jatuh ke http.status_code.
    const t6 = { ...sp({ ago: 55, http: null }), attributes: { "http.response.status_code": null, "http.status_code": 502 } };
    const t7 = sp({ ago: 7200, service: "batch" });
    const t8 = sp({ ago: 60, route: "/aXb" });
    await s.writeSpans([t1, t1c, t2, t3, t4, t5, t5b, t6, t7, t8]);
    await s.writeEncoded(s.encodeSpans([t1, t1c])); // duplikat (token beda): tetap satu trace, spanCount tetap 2
    const q = { fromUs: now - 3600e6, toUs: now + 60e6, status: "all" as const, limit: 50 };
    const ids = async (o: { service?: string; text?: string; minDurationUs?: number; status?: "all" | "error" | "5xx" | "4xx" }) =>
      (await s.searchTraces("ts", { ...q, ...o })).map((r) => r.traceId);
    const all = await s.searchTraces("ts", q);
    expect(all.map((r) => r.traceId)).toEqual([t1, t2, t3, t4, t5, t6, t8].map((t) => t.traceId));
    expect(all[0]).toEqual({ traceId: t1.traceId, spanId: t1.spanId, startUs: t1.startUs, durationUs: 5000, service: "api", name: "GET /users/:id", statusCode: 0, httpStatus: 200, spanCount: 2 });
    expect(all[2]!.httpStatus).toBe(404);
    expect(all[4]).toMatchObject({ spanId: t5.spanId, spanCount: 2 });
    expect(all[5]!.httpStatus).toBe(502);
    expect(all[6]!.httpStatus).toBeUndefined();
    expect(await ids({ service: "web" })).toEqual([t3.traceId]);
    expect(await ids({ status: "error" })).toEqual([t2.traceId, t4.traceId, t6.traceId]);
    expect(await ids({ status: "5xx" })).toEqual([t2.traceId, t6.traceId]);
    expect(await ids({ status: "4xx" })).toEqual([t3.traceId]);
    expect(await ids({ minDurationUs: 500_000 })).toEqual([t4.traceId]);
    expect(await ids({ text: "USERS" })).toEqual([t1.traceId]);
    expect(await ids({ text: "pay" })).toEqual([t2.traceId]);
    expect(await ids({ text: "a_b" })).toEqual([t3.traceId]);
    expect(await ids({ text: "%" })).toEqual([t3.traceId]);
    expect(await s.searchTraces("other", q)).toEqual([]);
    const p1 = await s.searchTraces("ts", { ...q, limit: 2 });
    const p2 = await s.searchTraces("ts", { ...q, limit: 50, beforeUs: p1[1]!.startUs, beforeSpanId: p1[1]!.spanId });
    expect([...p1, ...p2].map((r) => r.traceId)).toEqual(all.map((r) => r.traceId));
    // Paging bernomor (offset): root dan orphan digabung per halaman tanpa hilang/duplikat.
    const pages = [];
    for (let offset = 0; offset < all.length; offset += 2) pages.push(...await s.searchTraces("ts", { ...q, limit: 2, offset }));
    expect(pages.map((r) => r.traceId)).toEqual(all.map((r) => r.traceId));
    expect(await s.countTraces("ts", { fromUs: q.fromUs, toUs: q.toUs, status: "all" })).toBe(all.length);
    // Tiga root dengan waktu sama: paging tanpa hilang/duplikat.
    const t = now - 100e6;
    const same = [1, 2, 3].map(() => ({ ...sp({ ago: 0, service: "same" }), startUs: t }));
    await s.writeSpans(same);
    const a = await s.searchTraces("ts", { ...q, service: "same", limit: 2 });
    const b = await s.searchTraces("ts", { ...q, service: "same", limit: 2, beforeUs: a[1]!.startUs, beforeSpanId: a[1]!.spanId });
    expect([...a, ...b].map((r) => r.traceId).sort()).toEqual(same.map((x) => x.traceId).sort());
    expect(await s.listServices("ts", q.fromUs, q.toUs)).toEqual(["api", "same", "web"]);
    expect(await s.listServices("ts", now - 86_400e6, q.toUs)).toEqual(["api", "batch", "same", "web"]);
    await s.close();
  });

  it("pages requests and traces by offset and counts totals without double counting retried inserts", async () => {
    const s = store();
    await s.init();
    const now = Date.now() * 1000;
    const spans = Array.from({ length: 12 }, (_, i) => ({
      projectId: "pg", traceId: `9a${(i + 1).toString(16).padStart(30, "0")}`, spanId: (i + 1).toString(16).padStart(16, "f"),
      name: "GET /p", kind: 2, startUs: now - (i + 1) * 1e6, durationUs: 1000, statusCode: 0,
      attributes: { "http.method": "GET", "http.route": "/p", "http.status_code": i % 4 === 0 ? 404 : 500 }, events: [], resource: {}, service: "api",
    }));
    await s.writeSpans(spans);
    // Insert ulang sebagian dengan isi batch berbeda (token beda): baris duplikat benar-benar ada di tabel.
    await s.writeEncoded(s.encodeSpans(spans.slice(0, 4)));
    await s.writeEncoded(s.encodeSpans(spans.slice(2, 7)));
    expect(await rowCount(s, spans[3]!.traceId)).toBe(3);
    const f = { method: "GET", route: "/p", fromUs: now - 3600e6, toUs: now + 1e6, status: "all" as const };
    expect(await s.countRequests("pg", f)).toBe(12);
    expect(await s.countRequests("pg", { ...f, status: "5xx" })).toBe(9);
    expect(await s.countRequests("pg", { ...f, status: "4xx" })).toBe(3);
    expect(await s.countRequests("other", f)).toBe(0);
    const pages = [];
    for (let o = 0; o < 15; o += 5) pages.push(...(await s.listRequests("pg", { ...f, limit: 5, offset: o })));
    expect(pages.map((r) => r.spanId)).toEqual(spans.map((x) => x.spanId)); // terbaru dulu, tanpa duplikat/lompatan
    expect(await s.listRequests("pg", { ...f, limit: 5, offset: 12 })).toEqual([]);
    const tf = { fromUs: f.fromUs, toUs: f.toUs, status: "all" as const };
    expect(await s.countTraces("pg", tf)).toBe(12);
    expect(await s.countTraces("pg", { ...tf, status: "4xx" })).toBe(3);
    expect(await s.countTraces("pg", { ...tf, text: "nope" })).toBe(0);
    expect(await s.countTraces("pg", { ...tf, status: "404,500" })).toBe(12);
    expect(await s.countRequests("pg", { ...f, status: "500-500" })).toBe(9);
    // statusCounts: duplikat insert tidak dihitung dua kali (requests: uniqExact; traces: satu baris per trace).
    const byCode = (x: { code: number; count: number }[]) => x.sort((p, q) => p.code - q.code);
    expect(byCode(await s.requestStatusCounts("pg", { method: "GET", route: "/p", fromUs: f.fromUs, toUs: f.toUs })))
      .toEqual([{ code: 404, count: 3 }, { code: 500, count: 9 }]);
    expect(byCode(await s.traceStatusCounts("pg", { fromUs: f.fromUs, toUs: f.toUs }))).toEqual([{ code: 404, count: 3 }, { code: 500, count: 9 }]);
    expect(await s.traceStatusCounts("pg", { fromUs: f.fromUs, toUs: f.toUs, text: "nope" })).toEqual([]);
    const tp = [];
    for (let o = 0; o < 12; o += 5) tp.push(...(await s.searchTraces("pg", { ...tf, limit: 5, offset: o })));
    expect(tp.map((r) => r.traceId)).toEqual(spans.map((x) => x.traceId));
    expect(tp.every((r) => r.spanCount === 1)).toBe(true);
    await s.close();
  });
  it("reads one server span's body attributes, once despite a retried insert, scoped to project and kind", async () => {
    const s = store();
    await s.init();
    const base = { traceId: "f".repeat(32), name: "POST /b", startUs: Date.now() * 1000, durationUs: 1, statusCode: 0, events: [], resource: {}, service: "api" };
    const server = { ...base, projectId: "sb", spanId: "1".repeat(16), kind: 2,
      attributes: { "http.request.body": '{"a":1}', "http.response.body": "z".repeat(BODY_MAX + 5), "enduser.id": 7 } };
    const bare = { ...base, projectId: "sb", spanId: "2".repeat(16), kind: 2, attributes: {} };
    const client = { ...base, projectId: "sb", spanId: "3".repeat(16), kind: 3, attributes: { "http.request.body": "x" } };
    await s.writeSpans([server, bare, client]);
    await s.writeEncoded(s.encodeSpans([server])); // duplikat
    const b = await s.serverSpanBody("sb", base.traceId, server.spanId);
    expect(b).toMatchObject({ request: '{"a":1}', userId: "7" });
    expect(b!.query).toBeUndefined();
    expect(b!.response).toHaveLength(BODY_MAX + 1);
    expect(await s.serverSpanBody("sb", base.traceId, bare.spanId)).toEqual({});
    expect(await s.serverSpanBody("sb", base.traceId, client.spanId)).toBeNull();
    expect(await s.serverSpanBody("other", base.traceId, server.spanId)).toBeNull();
    await s.close();
  });
});
