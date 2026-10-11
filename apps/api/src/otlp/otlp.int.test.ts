import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { buildApp } from "../app.js";
import { keyCache } from "../ingest/key-cache.js";
import { slowCache } from "./slow-config.js";
import { IngestStore } from "../process/store.js";
import { sampleRequest, toProtobuf } from "./fixtures.js";
import { SqliteTelemetryStore } from "./telemetry-store.js";

// Alur penuh: POST /otlp/v1/traces (OTLP/JSON) -> issue lewat pipeline ingest + span trace tersimpan.
const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL not set (run via `pnpm test:int`)");

const prisma = createPrisma(url);
const raw = openRaw(sqlitePath(url));
const queue = new IngestStore(raw, { maxBacklog: 1000, batchSize: 50 });
const telemetry = new SqliteTelemetryStore(raw);
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;
const KEY = "fedcba9876543210fedcba9876543210";

const post = (body: unknown, headers: Record<string, string> = { "x-bugtrail-key": KEY }, type = "application/json") =>
  app.inject({ method: "POST", url: "/otlp/v1/traces", payload: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body), headers: { "content-type": type, ...headers } });

beforeAll(async () => {
  await tunePrisma(prisma);
  queue.start();
  app = await buildApp({ prisma, store: queue, telemetry });
});

beforeEach(async () => {
  await queue.drain();
  // Project dihapus langsung lewat DB (bukan lewat dashboard yang mengosongkan cache key).
  keyCache.clear();
  slowCache.clear();
  await prisma.organization.deleteMany();
  const org = await prisma.organization.create({ data: { name: "T", slug: "t" } });
  const p = await prisma.project.create({ data: { organizationId: org.id, name: "T", slug: "t" } });
  await prisma.dsnKey.create({ data: { projectId: p.id, publicKey: KEY } });
  projectId = p.id;
});

afterAll(async () => {
  await app?.close();
  await queue.stop();
  await prisma.$disconnect();
});

describe("OTLP traces endpoint", () => {
  it("turns span exceptions into one grouped issue and stores the error trace", async () => {
    const r1 = await post(sampleRequest("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({});
    // gzip, auth lewat Authorization: Bearer, trace lain dengan error yang sama
    const r2 = await post(gzipSync(JSON.stringify(sampleRequest("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))), { authorization: `Bearer ${KEY}`, "content-encoding": "gzip" });
    expect(r2.statusCode).toBe(200);
    await queue.drain();

    const issues = await prisma.issue.findMany({ where: { projectId } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ title: "SequelizeDatabaseError: Invalid column name 'coupon_id'.", culprit: "POST /orders", eventCount: 2 });
    const ev = await prisma.event.findFirstOrThrow({ where: { issueId: issues[0]!.id } });
    expect(ev).toMatchObject({ release: "2.4.1", environment: "production", userId: "user-10233" });
    expect((ev.payload as { contexts: { trace: { trace_id: string } } }).contexts.trace.trace_id).toMatch(/^(a|b){32}$/);

    const trace = telemetry.getTrace(projectId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(trace.map((s) => s.name)).toEqual(["POST /orders", "SELECT coupons"]);
    expect(trace[1]).toMatchObject({ parentSpanId: "00f067aa0ba902b7", durationUs: 355200, service: "checkout-api" });
  });

  it("counts every error but stores at most 20 traces per issue per hour", async () => {
    for (let i = 0; i < 25; i++) expect((await post(sampleRequest(i.toString(16).padStart(32, "d")))).statusCode).toBe(200);
    await queue.drain();
    const issue = await prisma.issue.findFirstOrThrow({ where: { projectId } });
    expect(issue.eventCount).toBe(25);
    const stored = await prisma.traceSpan.groupBy({ by: ["traceId"], where: { projectId } });
    expect(stored).toHaveLength(20);
  });

  it("does not store traces without errors", async () => {
    const ok = sampleRequest("cccccccccccccccccccccccccccccccc");
    const span = ok.resourceSpans[0]!.scopeSpans[0]!.spans[0]! as Record<string, unknown>;
    span["events"] = [];
    span["status"] = { code: 1 };
    expect((await post(ok)).statusCode).toBe(200);
    await queue.drain();
    expect(await prisma.issue.count({ where: { projectId } })).toBe(0);
    expect(telemetry.getTrace(projectId, "cccccccccccccccccccccccccccccccc")).toEqual([]);
  });

  it("rejects bad auth, content types and bodies with OTLP-friendly codes", async () => {
    expect((await post(sampleRequest(), {})).statusCode).toBe(401);
    expect((await post(sampleRequest(), { "x-bugtrail-key": "nope" })).statusCode).toBe(403);
    expect((await post(sampleRequest(), undefined, "text/plain")).statusCode).toBe(415);
    expect((await post("{not json")).statusCode).toBe(400);
    expect((await post({ hello: 1 })).statusCode).toBe(400);
  });

  it("accepts OTLP protobuf and answers in protobuf, errors as google.rpc.Status", async () => {
    const body = Buffer.from(toProtobuf(sampleRequest("9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a")));
    const ok = await post(body, { "x-bugtrail-key": KEY }, "application/x-protobuf");
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("application/x-protobuf");
    expect(ok.rawPayload).toHaveLength(0);
    await queue.drain();
    expect(await prisma.issue.findFirst({ where: { projectId } })).toMatchObject({ culprit: "POST /orders" });
    expect(telemetry.getTrace(projectId, "9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a")).toHaveLength(2);

    const bad = await post(Buffer.from("not protobuf"), { "x-bugtrail-key": KEY }, "application/x-protobuf");
    expect(bad.statusCode).toBe(400);
    expect(bad.headers["content-type"]).toBe("application/x-protobuf");
    const noKey = await post(body, {}, "application/x-protobuf");
    expect(noKey.statusCode).toBe(401);
    expect(noKey.rawPayload.length).toBeGreaterThan(0); // google.rpc.Status
  });

  // Request sukses (tanpa exception) dengan durasi span server tertentu.
  const okRequest = (traceId: string, ms: number, route = "/orders", error = false) => {
    const r = sampleRequest(traceId);
    const span = r.resourceSpans[0]!.scopeSpans[0]!.spans[0]! as Record<string, unknown>;
    span["endTimeUnixNano"] = String(1759586772418000000n + BigInt(ms) * 1_000_000n);
    span["name"] = `POST ${route}`;
    span["attributes"] = [
      { key: "http.method", value: { stringValue: "POST" } }, { key: "http.route", value: { stringValue: route } },
      { key: "http.status_code", value: { intValue: error ? "500" : "200" } },
    ];
    if (!error) {
      span["events"] = [];
      span["status"] = { code: 1 };
    }
    return r;
  };
  const stored = async () => (await prisma.traceSpan.groupBy({ by: ["traceId"], where: { projectId } })).map((t) => t.traceId).sort();

  it("Lite: stores slow successful traces, not fast ones", async () => {
    expect((await post(okRequest("5".repeat(32), 1500))).statusCode).toBe(200);
    expect((await post(okRequest("6".repeat(32), 200))).statusCode).toBe(200);
    expect(await stored()).toEqual(["5".repeat(32)]);
    expect(telemetry.getTrace(projectId, "5".repeat(32))).toHaveLength(2);
  });

  it("Lite: keeps at most 10 slow traces per endpoint per hour", async () => {
    for (let i = 0; i < 11; i++) expect((await post(okRequest(i.toString(16).padStart(32, "e"), 2000))).statusCode).toBe(200);
    expect(await stored()).toHaveLength(10);
    expect((await post(okRequest("f".repeat(32), 2000, "/other"))).statusCode).toBe(200);
    expect(await stored()).toContain("f".repeat(32));
  });

  it("Lite: a slow error trace uses only the error quota", async () => {
    // 10 trace error lambat di endpoint yang sama: semua tersimpan lewat kuota error, kuota lambat utuh.
    for (let i = 0; i < 10; i++) expect((await post(okRequest(i.toString(16).padStart(32, "a"), 2000, "/slow", true))).statusCode).toBe(200);
    expect(await stored()).toHaveLength(10);
    for (let i = 0; i < 10; i++) expect((await post(okRequest(i.toString(16).padStart(32, "b"), 2000, "/slow"))).statusCode).toBe(200);
    expect(await stored()).toHaveLength(20);
  });

  it("Lite: slowTraceMs null disables slow traces", async () => {
    await prisma.project.update({ where: { id: projectId }, data: { slowTraceMs: null } });
    expect((await post(okRequest("7".repeat(32), 5000))).statusCode).toBe(200);
    expect(await stored()).toEqual([]);
  });
});
