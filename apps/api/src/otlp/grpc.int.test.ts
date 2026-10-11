import * as grpc from "@grpc/grpc-js";
import protobuf from "protobufjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { buildApp } from "../app.js";
import { keyCache } from "../ingest/key-cache.js";
import { QuotaMeter } from "../process/quota.js";
import { IngestStore } from "../process/store.js";
import { sampleRequest, toProtobuf } from "./fixtures.js";
import { createOtlpGrpcServer } from "./grpc.js";
import { SqliteTelemetryStore } from "./telemetry-store.js";

// OTLP/gRPC: klien grpc-js sungguhan -> server gRPC -> pipeline ingest yang sama dengan OTLP/HTTP.
const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL not set (run via `pnpm test:int`)");

const prisma = createPrisma(url);
const raw = openRaw(sqlitePath(url));
const queue = new IngestStore(raw, { maxBacklog: 1000, batchSize: 50 });
const telemetry = new SqliteTelemetryStore(raw);
const quota = new QuotaMeter(raw);
const KEY = "0123456789abcdef0123456789abcdef";
const SPANS_PER_REQ = 2;
let app: Awaited<ReturnType<typeof buildApp>>;
let server: ReturnType<typeof createOtlpGrpcServer>;
let client: grpc.Client;
let projectId: string;

const id = (b: Buffer) => b;
function exportTraces(body: Uint8Array, md: Record<string, string> = { "x-bugtrail-key": KEY }) {
  const metadata = new grpc.Metadata();
  for (const [k, v] of Object.entries(md)) metadata.set(k, v);
  return new Promise<{ err: grpc.ServiceError | null; res?: Buffer }>((resolve) =>
    client.makeUnaryRequest("/opentelemetry.proto.collector.trace.v1.TraceService/Export", id, id, Buffer.from(body), metadata,
      (err, res) => resolve({ err, res })));
}

beforeAll(async () => {
  await tunePrisma(prisma);
  queue.start();
  app = await buildApp({ prisma, store: queue, telemetry, quota });
  server = createOtlpGrpcServer(app.traceIngest!, { error: () => {} });
  const port = await server.listen(0, "127.0.0.1");
  client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
});

beforeEach(async () => {
  await queue.drain();
  keyCache.clear();
  await prisma.organization.deleteMany();
  const org = await prisma.organization.create({ data: { name: "T", slug: "t" } });
  const p = await prisma.project.create({ data: { organizationId: org.id, name: "T", slug: "t", quotaSpansPerMin: SPANS_PER_REQ * 2 } });
  await prisma.dsnKey.create({ data: { projectId: p.id, publicKey: KEY } });
  projectId = p.id;
  quota.invalidate(projectId);
});

afterAll(async () => {
  client?.close();
  await server?.close();
  await app?.close();
  await queue.stop();
  await prisma.$disconnect();
});

describe("OTLP/gRPC traces", () => {
  it("ingests protobuf spans into issues and stored traces, auth via Bearer too", async () => {
    const r1 = await exportTraces(toProtobuf(sampleRequest("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")));
    expect(r1.err).toBeNull();
    expect(r1.res!.length).toBe(0); // ExportTraceServiceResponse kosong = sukses penuh
    const r2 = await exportTraces(toProtobuf(sampleRequest("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")), { authorization: `Bearer ${KEY}` });
    expect(r2.err).toBeNull();
    await queue.drain();
    const issues = await prisma.issue.findMany({ where: { projectId } });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.eventCount).toBe(2);
    expect(telemetry.getTrace(projectId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").map((s) => s.name)).toEqual(["POST /orders", "SELECT coupons"]);
  });

  it("maps auth and decode errors to gRPC status codes", async () => {
    const body = toProtobuf(sampleRequest());
    expect((await exportTraces(body, {})).err?.code).toBe(grpc.status.UNAUTHENTICATED);
    expect((await exportTraces(body, { "x-bugtrail-key": "f".repeat(32) })).err?.code).toBe(grpc.status.PERMISSION_DENIED);
    expect((await exportTraces(Buffer.from([0x0a, 0xff, 0xff]))).err?.code).toBe(grpc.status.INVALID_ARGUMENT);
  });

  it("over the span quota: RESOURCE_EXHAUSTED with RetryInfo so exporters retry", async () => {
    const body = toProtobuf(sampleRequest());
    expect((await exportTraces(body)).err).toBeNull();
    expect((await exportTraces(body)).err).toBeNull();
    const { err } = await exportTraces(body);
    expect(err?.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
    const details = err!.metadata.get("grpc-status-details-bin")[0] as Buffer;
    // Decode manual: google.rpc.Status.details[0] = Any{type_url, value=RetryInfo{retry_delay{seconds}}}.
    const root = protobuf.Root.fromJSON({ nested: {
      Status: { fields: { code: { type: "int32", id: 1 }, details: { rule: "repeated", type: "Any", id: 3 } } },
      Any: { fields: { type_url: { type: "string", id: 1 }, value: { type: "bytes", id: 2 } } },
      RetryInfo: { fields: { retryDelay: { type: "Duration", id: 1 } } },
      Duration: { fields: { seconds: { type: "int64", id: 1 } } },
    } });
    const st = root.lookupType("Status").toObject(root.lookupType("Status").decode(details)) as { code: number; details: { type_url: string; value: Uint8Array }[] };
    expect(st.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
    expect(st.details[0]!.type_url).toBe("type.googleapis.com/google.rpc.RetryInfo");
    const info = root.lookupType("RetryInfo").toObject(root.lookupType("RetryInfo").decode(st.details[0]!.value), { longs: Number }) as { retryDelay: { seconds: number } };
    expect(info.retryDelay.seconds).toBeGreaterThan(0);
  });
});
