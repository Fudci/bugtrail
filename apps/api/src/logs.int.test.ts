import * as grpc from "@grpc/grpc-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./auth/password.js";
import { keyCache } from "./ingest/key-cache.js";
import { logsToProtobuf, sampleLogs } from "./otlp/fixtures.js";
import { createOtlpGrpcServer } from "./otlp/grpc.js";
import { SqliteLogStore } from "./otlp/logs.js";
import { SqliteTelemetryStore } from "./otlp/telemetry-store.js";
import { QuotaMeter } from "./process/quota.js";
import { runRetention } from "./process/retention.js";
import { IngestStore } from "./process/store.js";

// OTLP logs mode Lite: /otlp/v1/logs (JSON, protobuf) + gRPC LogsService -> tabel logs -> API dashboard.
const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL not set (run via `pnpm test:int`)");

const prisma = createPrisma(url);
const raw = openRaw(sqlitePath(url));
const queue = new IngestStore(raw, { maxBacklog: 1000, batchSize: 50 });
const telemetry = new SqliteTelemetryStore(raw);
const logStore = new SqliteLogStore(raw);
const quota = new QuotaMeter(raw);
const KEY = "1234567890abcdef1234567890abcdef";
const PW = "password-123";
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
let app: Awaited<ReturnType<typeof buildApp>>;
let server: ReturnType<typeof createOtlpGrpcServer>;
let client: grpc.Client;
let projectId: string;
let cookie: string;

const nowNs = () => String(BigInt(Date.now()) * 1_000_000n);
const post = (body: Buffer | string, type = "application/json") =>
  app.inject({ method: "POST", url: "/otlp/v1/logs", payload: body, headers: { "content-type": type, "x-bugtrail-key": KEY } });
const get = (path: string) => app.inject({ method: "GET", url: `/api/0/projects/${projectId}${path}`, headers: { cookie } });

beforeAll(async () => {
  await tunePrisma(prisma);
  queue.start();
  app = await buildApp({ prisma, store: queue, telemetry, logStore, quota });
  server = createOtlpGrpcServer(app.traceIngest!, { error: () => {} }, app.logIngest);
  client = new grpc.Client(`127.0.0.1:${await server.listen(0, "127.0.0.1")}`, grpc.credentials.createInsecure());
});

beforeEach(async () => {
  keyCache.clear();
  await prisma.organization.deleteMany();
  const org = await prisma.organization.create({ data: { name: "T", slug: "t" } });
  const p = await prisma.project.create({ data: { organizationId: org.id, name: "T", slug: "t", quotaLogsPerMin: 6 } });
  await prisma.dsnKey.create({ data: { projectId: p.id, publicKey: KEY } });
  projectId = p.id;
  quota.invalidate(projectId);
  await prisma.user.deleteMany();
  const u = await prisma.user.create({ data: { username: "log", email: "log@x.io", passwordHash: await hashPassword(PW) } });
  await prisma.member.create({ data: { projectId, userId: u.id, role: "viewer" } });
  const r = await app.inject({ method: "POST", url: "/api/0/auth/login", payload: { email: "log@x.io", password: PW } });
  const c = r.cookies.find((c) => c.name === "bt_session")!;
  cookie = `${c.name}=${c.value}`;
});

afterAll(async () => {
  client?.close();
  await server?.close();
  await app?.close();
  await queue.stop();
  await prisma.$disconnect();
});

describe("OTLP logs", () => {
  it("accepts JSON and protobuf, links logs to the trace, and searches them", async () => {
    const r1 = await post(JSON.stringify(sampleLogs(TRACE, nowNs())));
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({});
    const r2 = await post(Buffer.from(logsToProtobuf(sampleLogs("ab".repeat(16), nowNs()))), "application/x-protobuf");
    expect(r2.statusCode).toBe(200);
    expect(r2.headers["content-type"]).toBe("application/x-protobuf");

    const all = (await get("/logs?range=15m")).json();
    expect(all.enabled).toBe(true);
    expect(all.logs).toHaveLength(4);
    expect((await get("/logs?range=15m&severity=17")).json().logs.map((l: { traceId: string }) => l.traceId).sort()).toEqual([TRACE, "ab".repeat(16)]);
    expect((await get("/logs?range=15m&text=SLOW%20QUERY")).json().logs).toHaveLength(2); // tidak peka huruf besar
    expect((await get("/logs?range=15m&text=50%25")).json().logs).toHaveLength(0); // % dicocokkan apa adanya
    expect((await get("/logs?range=15m&service=other")).json().logs).toHaveLength(0);
    expect((await get("/logs/services?range=15m")).json()).toEqual({ services: ["checkout-api"] });

    // Paging kursor: 3 + 1
    const p1 = (await get("/logs?range=15m&limit=3")).json();
    expect(p1.logs).toHaveLength(3);
    const p2 = (await get(`/logs?range=15m&limit=3&before=${encodeURIComponent(p1.nextBefore)}`)).json();
    expect(p2.logs).toHaveLength(1);
    expect(p2.nextBefore).toBeNull();
    expect(new Set([...p1.logs, ...p2.logs].map((l: { id: string }) => l.id)).size).toBe(4);

    const t = (await get(`/traces/${TRACE}/logs`)).json();
    expect(t.logs.map((l: { body: string }) => l.body)).toEqual(["order insert failed: Invalid column name 'coupon_id'"]);
  });

  it("accepts logs over gRPC", async () => {
    const md = new grpc.Metadata();
    md.set("x-bugtrail-key", KEY);
    const id = (b: Buffer) => b;
    const err = await new Promise<grpc.ServiceError | null>((resolve) => client.makeUnaryRequest(
      "/opentelemetry.proto.collector.logs.v1.LogsService/Export", id, id, Buffer.from(logsToProtobuf(sampleLogs(TRACE, nowNs()))), md, (e) => resolve(e)));
    expect(err).toBeNull();
    expect((await get(`/traces/${TRACE}/logs`)).json().logs).toHaveLength(1);
  });

  it("rejects the whole request over the log quota with 429 and counts the drop", async () => {
    for (let i = 0; i < 3; i++) expect((await post(JSON.stringify(sampleLogs(TRACE, nowNs())))).statusCode).toBe(200);
    const r = await post(JSON.stringify(sampleLogs(TRACE, nowNs())));
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    expect((await get("/logs?range=15m")).json().logs).toHaveLength(6);
    expect(quota.current(projectId).logs).toBe(6);
    quota.flush();
    expect(raw.prepare("SELECT logs FROM quota_drops WHERE project_id = ?").pluck().get(projectId)).toBe(2);
  });

  it("validates queries and requires access", async () => {
    expect((await get("/logs?range=99d")).statusCode).toBe(400);
    expect((await get("/logs?traceId=xyz")).statusCode).toBe(400);
    expect((await get("/traces/nothex/logs")).statusCode).toBe(400);
    expect((await get("/logs?before=123:abc")).statusCode).toBe(400); // id SQLite harus angka
    expect((await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/logs` })).statusCode).toBe(401);
  });

  it("retention deletes Lite logs received more than 3 days ago", async () => {
    await post(JSON.stringify(sampleLogs(TRACE, nowNs())));
    raw.prepare("UPDATE logs SET received_at = received_at - 4 * 86400 WHERE project_id = ? AND severity_number = 17").run(projectId);
    const res = await runRetention(raw);
    expect(res.logsDeleted).toBe(1);
    expect((await get("/logs?range=15m")).json().logs).toHaveLength(1);
  });
});
