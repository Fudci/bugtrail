import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./auth/password.js";
import { keyCache } from "./ingest/key-cache.js";
import { RollupAggregator } from "./otlp/rollups.js";
import { ServiceGraph } from "./otlp/service-graph.js";
import { SqliteTelemetryStore } from "./otlp/telemetry-store.js";
import { IngestStore } from "./process/store.js";

// Service map: POST /otlp/v1/traces dari dua service -> service_rollups -> GET /services.
const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL not set (run via `pnpm test:int`)");

const prisma = createPrisma(url);
const raw = openRaw(sqlitePath(url));
const queue = new IngestStore(raw, { maxBacklog: 1000, batchSize: 50 });
const telemetry = new SqliteTelemetryStore(raw);
const services = new ServiceGraph(raw);
const rollups = new RollupAggregator(raw); // tidak di-start: test memanggil flush() sendiri
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;
let cookie: string;
const KEY = "abcdefabcdefabcdefabcdefabcdef12";
const PW = "password-123";

const post = (service: string, spans: object[]) => app.inject({
  method: "POST", url: "/otlp/v1/traces", headers: { "content-type": "application/json", "x-bugtrail-key": KEY },
  payload: JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] }, scopeSpans: [{ spans }] }] }),
});
const sp = (spanId: string, kind: number, ms: number, parent?: string, attrs: Record<string, string | number> = {}) => ({
  traceId: "c".repeat(32), spanId: spanId.repeat(16), ...(parent && { parentSpanId: parent.repeat(16) }), name: "op", kind,
  startTimeUnixNano: "1700000000000000000", endTimeUnixNano: String(1700000000000000000n + BigInt(ms) * 1_000_000n), status: {},
  attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: typeof v === "number" ? { intValue: String(v) } : { stringValue: v } })),
});
const get = (path: string) => app.inject({ method: "GET", url: `/api/0/projects/${projectId}${path}`, headers: { cookie } });

beforeAll(async () => {
  await tunePrisma(prisma);
  queue.start();
  app = await buildApp({ prisma, store: queue, telemetry, services, rollups });
});

beforeEach(async () => {
  await queue.drain();
  services.flush(Date.now(), true);
  keyCache.clear();
  await prisma.organization.deleteMany();
  const org = await prisma.organization.create({ data: { name: "T", slug: "t" } });
  const p = await prisma.project.create({ data: { organizationId: org.id, name: "T", slug: "t" } });
  await prisma.dsnKey.create({ data: { projectId: p.id, publicKey: KEY } });
  projectId = p.id;
  await prisma.user.deleteMany();
  const u = await prisma.user.create({ data: { username: "svc", email: "svc@x.io", passwordHash: await hashPassword(PW) } });
  await prisma.member.create({ data: { projectId, userId: u.id, role: "viewer" } });
  const r = await app.inject({ method: "POST", url: "/api/0/auth/login", payload: { email: "svc@x.io", password: PW } });
  const c = r.cookies.find((c) => c.name === "bt_session")!;
  cookie = `${c.name}=${c.value}`;
});

afterAll(async () => {
  await app?.close();
  await queue.stop();
  await prisma.$disconnect();
});

describe("services API", () => {
  it("builds nodes and edges from spans exported separately by each service", async () => {
    expect((await post("gateway", [sp("1", 2, 50), sp("2", 3, 40, "1")])).statusCode).toBe(200);
    expect((await post("orders", [sp("3", 2, 30, "2", { "http.response.status_code": 500, "http.request.method": "POST", "http.route": "/orders" }), sp("4", 3, 5, "3", { "db.system": "postgresql" })])).statusCode).toBe(200);
    services.flush(Date.now(), true);
    rollups.flush();

    const r = await get("/services?range=1h");
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.services.map((s: { name: string; count: number; errors: number }) => [s.name, s.count, s.errors]))
      .toEqual(expect.arrayContaining([["gateway", 1, 0], ["orders", 1, 1]]));
    expect(b.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "gateway", target: "orders", external: false, count: 1 }),
      expect.objectContaining({ source: "orders", target: "postgresql", external: true, count: 1 }),
    ]));
    expect(b.services[0].series).toHaveLength(60);

    const d = (await get("/services/detail?range=1h&service=orders")).json();
    expect(d).toMatchObject({ service: "orders", count: 1, errors: 1, errorRate: 1 });
    expect(d.upstream.map((e: { source: string }) => e.source)).toEqual(["gateway"]);
    expect(d.downstream.map((e: { target: string }) => e.target)).toEqual(["postgresql"]);
    expect(d.endpoints).toEqual([expect.objectContaining({ method: "POST", route: "/orders", count: 1, c5xx: 1 })]);
    // Route yang sama di service lain tidak ikut.
    expect((await get("/services/detail?range=1h&service=gateway")).json().endpoints).toEqual([]);
  });

  it("rejects bad queries and users without access", async () => {
    expect((await get("/services?range=99d")).statusCode).toBe(400);
    expect((await get("/services/detail?range=1h")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/services` })).statusCode).toBe(401);
  });
});
