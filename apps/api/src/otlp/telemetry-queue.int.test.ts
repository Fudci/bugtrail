import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { buildApp } from "../app.js";
import { keyCache } from "../ingest/key-cache.js";
import { IngestStore } from "../process/store.js";
import { sampleRequest } from "./fixtures.js";
import { TelemetryQueue } from "./telemetry-queue.js";
import type { StoredSpan, TelemetryStore } from "./telemetry-store.js";

// Mode Scale dengan penyimpanan palsu: semua span (juga trace sukses) sampai, tidak hilang walau
// penyimpanan gagal beberapa kali, dan 429 saat antrian penuh.
const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL not set (run via `pnpm test:int`)");

class FlakyStore implements TelemetryStore {
  readonly kind = "fake";
  readonly storesAllSpans = true;
  spans: StoredSpan[] = [];
  failNext = 0;
  rejectTrace = "";
  writeSpans(spans: StoredSpan[]) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("clickhouse down");
    }
    if (spans.some((s) => s.traceId === this.rejectTrace)) throw Object.assign(new Error("Cannot parse input"), { rejected: true });
    this.spans.push(...spans);
  }
  getTrace(projectId: string, traceId: string) {
    return this.spans.filter((s) => s.projectId === projectId && s.traceId === traceId);
  }
}

const prisma = createPrisma(url);
const raw = openRaw(sqlitePath(url));
const queue = new IngestStore(raw, { maxBacklog: 1000, batchSize: 50 });
const fake = new FlakyStore();
const spanQueue = new TelemetryQueue(raw, fake, { maxSpans: 12, retryMs: 10 });
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;
const KEY = "abcabcabcabcabcabcabcabcabcabcab";
const post = (body: unknown) =>
  app.inject({ method: "POST", url: "/otlp/v1/traces", payload: JSON.stringify(body), headers: { "content-type": "application/json", "x-bugtrail-key": KEY } });

beforeAll(async () => {
  await tunePrisma(prisma);
  queue.start();
  spanQueue.start();
  app = await buildApp({ prisma, store: queue, telemetry: fake, spanQueue });
});

beforeEach(async () => {
  await queue.drain();
  await spanQueue.drain();
  fake.spans = [];
  keyCache.clear();
  await prisma.organization.deleteMany();
  const org = await prisma.organization.create({ data: { name: "T", slug: "t" } });
  const p = await prisma.project.create({ data: { organizationId: org.id, name: "T", slug: "t" } });
  await prisma.dsnKey.create({ data: { projectId: p.id, publicKey: KEY } });
  projectId = p.id;
});

afterAll(async () => {
  await app?.close();
  await spanQueue.stop();
  await queue.stop();
  await prisma.$disconnect();
});

describe("Scale mode span queue", () => {
  it("stores every span, including traces without errors, and still creates the issue", async () => {
    const ok = sampleRequest("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    const root = ok.resourceSpans[0]!.scopeSpans[0]!.spans[0]! as Record<string, unknown>;
    root["events"] = [];
    root["status"] = { code: 1 };
    expect((await post(ok)).statusCode).toBe(200);
    expect((await post(sampleRequest("ffffffffffffffffffffffffffffffff"))).statusCode).toBe(200);
    await spanQueue.drain();
    await queue.drain();
    expect(fake.getTrace(projectId, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")).toHaveLength(2); // trace sukses tetap tersimpan
    expect(fake.getTrace(projectId, "ffffffffffffffffffffffffffffffff")).toHaveLength(2);
    expect(await prisma.issue.count({ where: { projectId } })).toBe(1);
  });

  it("keeps spans on disk while the store is failing and delivers them once it recovers", async () => {
    fake.failNext = 3;
    expect((await post(sampleRequest("12121212121212121212121212121212"))).statusCode).toBe(200);
    await spanQueue.drain();
    expect(fake.spans).toHaveLength(2);
    expect(spanQueue.failures).toBeGreaterThanOrEqual(3);
  });

  it("answers 429 when the queue is full", async () => {
    fake.failNext = 1_000_000; // penyimpanan mati: span menumpuk di disk
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await post(sampleRequest(i.toString(16).padStart(32, "3")))).statusCode);
    expect(codes.slice(0, 6).every((c) => c === 200)).toBe(true); // 6 × 2 span = batas 12
    expect(codes.slice(6)).toEqual([429, 429]);
    fake.failNext = 0;
    await spanQueue.drain();
    expect(fake.spans).toHaveLength(12);
  });

  it("drops only the rows the store rejects, so one bad batch can't block the queue", async () => {
    fake.rejectTrace = "77777777777777777777777777777777";
    for (const t of ["66666666666666666666666666666666", "77777777777777777777777777777777", "88888888888888888888888888888888"]) {
      expect((await post(sampleRequest(t))).statusCode).toBe(200);
    }
    await spanQueue.drain();
    expect(fake.spans.map((s) => s.traceId).sort()).toEqual([
      "66666666666666666666666666666666", "66666666666666666666666666666666",
      "88888888888888888888888888888888", "88888888888888888888888888888888",
    ]);
    expect(spanQueue.dropped).toBe(2);
    fake.rejectTrace = "";
  });
});

