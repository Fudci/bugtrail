import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { slowCache } from "./otlp/slow-config.js";
import { createPrisma, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./auth/password.js";
import { BODY_MAX, SqliteTelemetryStore, type StoredSpan } from "./otlp/telemetry-store.js";
import { IngestStore } from "./process/store.js";

// Pencarian trace: GET /api/0/projects/:id/traces (+ /traces/services) di atas store SQLite (mode Lite).
const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL not set (run via `pnpm test:int`)");

const prisma = createPrisma(url);
const raw = openRaw(sqlitePath(url));
const queue = new IngestStore(raw, { maxBacklog: 1000, batchSize: 50 });
const telemetry = new SqliteTelemetryStore(raw);
const NOW = Date.UTC(2026, 9, 10, 12, 30, 30);
const NOW_US = NOW * 1000;
const PW = "password-123";
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;

let seq = 0;
type SpanOpts = { ago: number; trace?: string; parent?: string; kind?: number; service?: string; name?: string; route?: string; http?: number | string; statusCode?: number; ms?: number; events?: StoredSpan["events"] };
const span = (o: SpanOpts): StoredSpan => {
  seq++;
  const attributes: Record<string, unknown> = {};
  if (o.route !== undefined) attributes["http.route"] = o.route;
  if (o.http !== undefined) attributes["http.response.status_code"] = o.http;
  return {
    projectId, traceId: o.trace ?? seq.toString(16).padStart(32, "a"), spanId: seq.toString(16).padStart(16, "b"), parentSpanId: o.parent,
    service: o.service ?? "api", name: o.name ?? "GET /x", kind: o.kind ?? 2, startUs: NOW_US - o.ago * 1e6, durationUs: (o.ms ?? 5) * 1000,
    statusCode: o.statusCode ?? 0, attributes, events: o.events ?? [], resource: {},
  };
};

async function login(email: string) {
  const r = await app.inject({ method: "POST", url: "/api/0/auth/login", payload: { email, password: PW } });
  expect(r.statusCode).toBe(200);
  const c = r.cookies.find((c) => c.name === "bt_session")!;
  return `${c.name}=${c.value}`;
}
const get = (cookie: string, path: string) => app.inject({ method: "GET", url: `/api/0/projects/${projectId}/${path}`, headers: { cookie } });

beforeAll(async () => {
  await tunePrisma(prisma);
  app = await buildApp({ prisma, store: queue, telemetry, now: () => NOW });
});

beforeEach(async () => {
  await prisma.organization.deleteMany();
  const org = await prisma.organization.create({ data: { name: "T", slug: "t" } });
  projectId = (await prisma.project.create({ data: { organizationId: org.id, name: "T", slug: "t" } })).id;
  await prisma.user.deleteMany();
  const passwordHash = await hashPassword(PW);
  const ani = await prisma.user.create({ data: { username: "ani", email: "ani@x.io", passwordHash } });
  await prisma.user.create({ data: { username: "budi", email: "budi@x.io", passwordHash } }); // tanpa membership
  await prisma.member.create({ data: { projectId, userId: ani.id, role: "viewer" } });
  raw.prepare("DELETE FROM trace_spans").run();
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

// Satu set data: t1..t5 dalam 1 jam terakhir, t6 dua jam lalu, t7 untuk uji escape LIKE.
function seed() {
  const t1 = span({ ago: 10, route: "/users/:id", name: "GET /users/:id", http: 200 });
  const t1c = span({ ago: 10, trace: t1.traceId, parent: t1.spanId, kind: 3, name: "SELECT users" });
  const t2 = span({ ago: 20, http: 503, name: "POST /pay", route: "/pay" });
  const t2c = span({ ago: 20, trace: t2.traceId, parent: t2.spanId, kind: 3, name: "SELECT pay",
    events: [{ name: "exception", timeUs: NOW_US - 20e6, attributes: { "exception.type": "DbError", "exception.message": "boom" } }] });
  const t3 = span({ ago: 30, service: "web", http: "404", name: "GET /a_b%", route: "/a_b%" });
  const t4 = span({ ago: 40, http: 200, statusCode: 2, ms: 900, name: "GET /slow" });
  // Trace tanpa root tersimpan (parent dari service lain): wakilnya span server paling awal.
  const t5 = span({ ago: 50, parent: "f".repeat(16), name: "GET /orphan", http: 200 });
  const t5b = span({ ago: 49, trace: t5.traceId, parent: "e".repeat(16), name: "GET /orphan-later", http: 200 });
  const t6 = span({ ago: 7200, name: "GET /old", http: 200 });
  const t7 = span({ ago: 60, name: "GET /aXb", route: "/aXb", http: 200 });
  telemetry.writeSpans([t1, t1c, t2, t2c, t3, t4, t5, t5b, t6, t7]);
  return { t1, t2, t3, t4, t5, t6, t7 };
}

const ids = (b: { traces: { traceId: string }[] }) => b.traces.map((t) => t.traceId);

describe("trace search", () => {
  it("lists one row per trace (root span, fallback earliest server span), newest first, with span count and error", async () => {
    const { t1, t2, t3, t4, t5, t7 } = seed();
    const cookie = await login("ani@x.io");
    const res = await get(cookie, "traces?range=1h");
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.sampled).toBe(true);
    expect(b.nextBefore).toBeNull();
    expect(ids(b)).toEqual([t1, t2, t3, t4, t5, t7].map((t) => t.traceId));
    expect(b.traces[0]).toEqual({ traceId: t1.traceId, spanId: t1.spanId, startUs: t1.startUs, durationUs: 5000, service: "api", name: "GET /users/:id",
      statusCode: 0, httpStatus: 200, spanCount: 2, error: null, slow: false });
    expect(b.traces[1].error).toMatchObject({ type: "DbError", message: "boom" });
    expect(b.traces[2]).toMatchObject({ httpStatus: 404, service: "web" });
    expect(b.traces[4]).toMatchObject({ spanId: t5.spanId, name: "GET /orphan", spanCount: 2 });
    // Paging bernomor: root dan orphan digabung per halaman tanpa hilang/duplikat, total sama.
    const win = { fromUs: NOW_US - 3600e6, toUs: NOW_US + 60e6, status: "all" };
    const pages: string[] = [];
    for (let offset = 0; offset < 6; offset += 2) pages.push(...telemetry.searchTraces(projectId, { ...win, limit: 2, offset }).map((t) => t.traceId));
    expect(pages).toEqual(ids(b));
    expect(telemetry.countTraces(projectId, win)).toBe(6);
    expect(b.total).toBe(6);
  });

  it("marks slow successful traces using the project slowTraceMs", async () => {
    const fast = span({ ago: 10, http: 200, ms: 200, name: "GET /f" });
    const slow = span({ ago: 20, http: 200, ms: 1500, name: "GET /s" });
    const slowErr = span({ ago: 30, http: 500, ms: 1500, name: "GET /e" });
    telemetry.writeSpans([fast, slow, slowErr]);
    const cookie = await login("ani@x.io");
    const flags = async () => (await get(cookie, "traces?range=1h")).json().traces.map((t: { slow: boolean }) => t.slow);
    expect(await flags()).toEqual([false, true, false]);
    await prisma.project.update({ where: { id: projectId }, data: { slowTraceMs: 100 } });
    slowCache.clear();
    expect(await flags()).toEqual([true, true, false]);
    await prisma.project.update({ where: { id: projectId }, data: { slowTraceMs: null } });
    slowCache.clear();
    expect(await flags()).toEqual([false, false, false]);
  });

  it("filters by service, status, duration, text (escaped LIKE) and range", async () => {
    const { t1, t2, t3, t4, t6 } = seed();
    const cookie = await login("ani@x.io");
    const q = async (s: string) => ids((await get(cookie, `traces?range=1h&${s}`)).json());
    expect(await q("service=web")).toEqual([t3.traceId]);
    expect(await q("status=error")).toEqual([t2.traceId, t4.traceId]);
    expect(await q("status=5xx")).toEqual([t2.traceId]);
    expect(await q("status=4xx")).toEqual([t3.traceId]);
    expect(await q("minMs=500")).toEqual([t4.traceId]);
    expect(await q("q=USERS")).toEqual([t1.traceId]); // http.route, tanpa peduli huruf besar/kecil
    expect(await q("q=pay")).toEqual([t2.traceId]);
    expect(await q("q=a_b")).toEqual([t3.traceId]); // "_" bukan wildcard: /aXb tidak ikut
    expect(await q("q=%25")).toEqual([t3.traceId]);
    expect(await q("q=%5C")).toEqual([]);
    expect(ids((await get(cookie, "traces?range=24h")).json())).toContain(t6.traceId);
    expect(await q("")).not.toContain(t6.traceId);
  });

  it("pages with a composite cursor without losing traces that share a start time", async () => {
    const same = [1, 2, 3].map(() => span({ ago: 5, http: 200 }));
    telemetry.writeSpans(same);
    const cookie = await login("ani@x.io");
    const a = (await get(cookie, "traces?range=1h&limit=2")).json();
    expect(a.traces).toHaveLength(2);
    expect(a.nextBefore).toMatch(/^\d+:[0-9a-f]{16}$/);
    const b = (await get(cookie, `traces?range=1h&limit=2&before=${a.nextBefore}`)).json();
    expect(b.nextBefore).toBeNull();
    expect([...ids(a), ...ids(b)].sort()).toEqual(same.map((s) => s.traceId).sort());
  });

  it("lists services seen in the range", async () => {
    seed();
    telemetry.writeSpans([span({ ago: 7200, service: "batch" })]);
    const cookie = await login("ani@x.io");
    expect((await get(cookie, "traces/services?range=1h")).json()).toEqual({ services: ["api", "web"] });
    expect((await get(cookie, "traces/services?range=24h")).json()).toEqual({ services: ["api", "batch", "web"] });
  });

  it("serves the server span body lazily: members only, project-scoped, truncated at 64K, null when absent", async () => {
    const big = "y".repeat(BODY_MAX + 10);
    const withBody = span({ ago: 5, http: 500 });
    withBody.attributes = { ...withBody.attributes, "http.request.body": '{"a":1}', "http.request.query": "x=1", "http.response.body": big, "enduser.id": 42 };
    const bare = span({ ago: 6, http: 200 });
    const client = span({ ago: 6, trace: bare.traceId, parent: bare.spanId, kind: 3 });
    client.attributes = { "http.request.body": "secret" };
    telemetry.writeSpans([withBody, bare, client]);
    telemetry.writeSpans([withBody]); // kirim ulang: diabaikan
    expect(telemetry.serverSpanBody(projectId, withBody.traceId, withBody.spanId)!.response).toHaveLength(BODY_MAX + 1);
    const path = (s: StoredSpan) => `traces/${s.traceId}/server-span?spanId=${s.spanId}`;
    const cookie = await login("ani@x.io");
    const r = (await get(cookie, path(withBody))).json();
    expect(r.body).toMatchObject({ request: '{"a":1}', query: "x=1", userId: "42", truncated: true, truncatedFields: ["response"] });
    expect(r.body.response).toHaveLength(BODY_MAX);
    expect((await get(cookie, path(bare))).json()).toEqual({ body: null });
    // Span client (bukan server) tidak dilayani.
    expect((await get(cookie, path(client))).statusCode).toBe(404);
    // Bukan member -> 404; trace project lain -> 404.
    expect((await get(await login("budi@x.io"), path(withBody))).statusCode).toBe(404);
    const org2 = await prisma.organization.create({ data: { name: "U", slug: "u" } });
    const other = (await prisma.project.create({ data: { organizationId: org2.id, name: "U", slug: "u" } })).id;
    const ani = await prisma.user.findUniqueOrThrow({ where: { email: "ani@x.io" } });
    await prisma.member.create({ data: { projectId: other, userId: ani.id, role: "viewer" } });
    const cross = await app.inject({ method: "GET", url: `/api/0/projects/${other}/${path(withBody)}`, headers: { cookie } });
    expect(cross.statusCode).toBe(404);
    expect((await get(cookie, `traces/${withBody.traceId}/server-span?spanId=xyz`)).statusCode).toBe(400);
    expect((await get(cookie, `traces/nothex/server-span?spanId=${withBody.spanId}`)).statusCode).toBe(400);
  });

  it("hides other projects (404) and validates input (400)", async () => {
    seed();
    const budi = await login("budi@x.io");
    expect((await get(budi, "traces")).statusCode).toBe(404);
    expect((await get(budi, "traces/services")).statusCode).toBe(404);
    const cookie = await login("ani@x.io");
    expect((await app.inject({ method: "GET", url: "/api/0/projects/nope/traces", headers: { cookie } })).statusCode).toBe(404);
    for (const bad of ["range=2h", "status=ok", `q=${"x".repeat(201)}`, "limit=201", "limit=0", "minMs=-1", "before=abc", `service=${"s".repeat(201)}`]) {
      expect((await get(cookie, `traces?${bad}`)).statusCode, bad).toBe(400);
    }
    expect((await get(cookie, "traces/services?range=2h")).statusCode).toBe(400);
    expect((await get(cookie, `traces?q=${"x".repeat(200)}`)).statusCode).toBe(200);
  });
});
