import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { buildApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { keyCache } from "../ingest/key-cache.js";
import { sampleRequest } from "../otlp/fixtures.js";
import { RollupAggregator } from "../otlp/rollups.js";
import { SqliteTelemetryStore } from "../otlp/telemetry-store.js";
import { Alerter, type DiscordMessage } from "./alerts.js";
import { QuotaMeter } from "./quota.js";
import { runRetention } from "./retention.js";
import { IngestStore } from "./store.js";

// Kuota per project per menit: 429 + Retry-After untuk Sentry envelope dan OTLP, drop dicatat dan dialertkan.
const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL not set (jalankan lewat `pnpm test:int`)");

const prisma = createPrisma(url);
const raw = openRaw(sqlitePath(url));
const queue = new IngestStore(raw, { maxBacklog: 10_000, batchSize: 100 });
const telemetry = new SqliteTelemetryStore(raw);
const rollups = new RollupAggregator(raw);
const sent: DiscordMessage[] = [];
const alerter = new Alerter(raw, { webUrl: "http://bt.local", send: async (_u, m) => (sent.push(m), { ok: true, status: 204 }) });
// Jam palsu: 30 detik setelah awal menit.
let clock = Date.UTC(2026, 9, 10, 12, 0, 30);
const quota = new QuotaMeter(raw, { alerter, now: () => clock });
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;
let publicId: number;
const KEY = "abcdefabcdefabcdefabcdefabcdef12";
const PW = "password-123";
const WEBHOOK = "https://discord.com/api/webhooks/1/abc";

let n = 0;
function envelope(count: number) {
  let s = "{}\n";
  for (let i = 0; i < count; i++) {
    const ev = JSON.stringify({ event_id: (++n).toString(16).padStart(32, "0"), message: "quota test", level: "error" });
    s += `{"type":"event","length":${Buffer.byteLength(ev)}}\n${ev}\n`;
  }
  return s;
}
const sendEvents = (count: number) =>
  app.inject({ method: "POST", url: `/api/${publicId}/envelope/?sentry_key=${KEY}`, payload: envelope(count), headers: { "content-type": "text/plain" } });
const sendSpans = (traceId: string) =>
  app.inject({ method: "POST", url: "/otlp/v1/traces", payload: JSON.stringify(sampleRequest(traceId)), headers: { "content-type": "application/json", "x-bugtrail-key": KEY } });
const SPANS_PER_REQ = sampleRequest("a".repeat(32)).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)).length;

async function login(email: string) {
  const r = await app.inject({ method: "POST", url: "/api/0/auth/login", payload: { email, password: PW } });
  const c = r.cookies.find((c) => c.name === "bt_session")!;
  return { cookie: `${c.name}=${c.value}` };
}

beforeAll(async () => {
  await tunePrisma(prisma);
  queue.start();
  app = await buildApp({ prisma, store: queue, telemetry, rollups, quota, alerter });
});

beforeEach(async () => {
  await queue.drain();
  quota.flush();
  keyCache.clear();
  sent.length = 0;
  clock += 3 * 3_600_000; // jendela menit & cooldown alert baru tiap test
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
  const org = await prisma.organization.create({ data: { name: "T", slug: "t" } });
  const p = await prisma.project.create({
    data: { organizationId: org.id, name: "Shop", slug: "t", publicId: 77, quotaEventsPerMin: 5, quotaSpansPerMin: SPANS_PER_REQ * 2, discordWebhookUrl: WEBHOOK },
  });
  await prisma.dsnKey.create({ data: { projectId: p.id, publicKey: KEY } });
  projectId = p.id;
  publicId = 77;
  quota.invalidate(projectId);
  const passwordHash = await hashPassword(PW);
  const admin = await prisma.user.create({ data: { username: "admin", email: "admin@x.io", passwordHash, isAdmin: true } });
  const viewer = await prisma.user.create({ data: { username: "v", email: "v@x.io", passwordHash } });
  await prisma.member.createMany({ data: [{ projectId, userId: admin.id, role: "admin" }, { projectId, userId: viewer.id, role: "viewer" }] });
});

afterAll(async () => {
  await app?.close();
  await queue.stop();
  await prisma.$disconnect();
});

describe("project quotas", () => {
  it("Sentry envelope: over quota -> 429 with Retry-After and X-Sentry-Rate-Limits, nothing enqueued", async () => {
    expect((await sendEvents(3)).statusCode).toBe(200);
    // 3 + 3 > 5: request ditolak utuh.
    const r = await sendEvents(3);
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBe("30");
    expect(r.headers["x-sentry-rate-limits"]).toBe("30:error:project");
    expect((await sendEvents(2)).statusCode).toBe(200); // pas 5
    await queue.drain();
    expect(await prisma.event.count({ where: { projectId } })).toBe(5);
    // Menit berikutnya: hitungan mulai lagi.
    clock += 60_000;
    expect((await sendEvents(5)).statusCode).toBe(200);
    expect(quota.current(projectId)).toEqual({ events: 5, spans: 0, logs: 0 });
  });

  it("OTLP: rejects the whole request over the span quota and keeps it out of API Health", async () => {
    expect((await sendSpans("1".repeat(32))).statusCode).toBe(200);
    expect((await sendSpans("2".repeat(32))).statusCode).toBe(200);
    rollups.flush();
    const before = Number(raw.prepare("SELECT COALESCE(SUM(count), 0) FROM endpoint_rollups WHERE project_id = ?").pluck().get(projectId));
    const r = await sendSpans("3".repeat(32));
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBe("30");
    rollups.flush();
    expect(Number(raw.prepare("SELECT COALESCE(SUM(count), 0) FROM endpoint_rollups WHERE project_id = ?").pluck().get(projectId))).toBe(before);
    await queue.drain();
    // Error dari trace yang ditolak tidak masuk antrian.
    const traces = (await prisma.event.findMany({ where: { projectId } })).map((e) => (e.payload as { contexts: { trace: { trace_id: string } } }).contexts.trace.trace_id);
    expect(traces).not.toContain("3".repeat(32));
  });

  it("records drops per hour on flush and alerts at most once per hour", async () => {
    await sendEvents(5);
    expect((await sendEvents(4)).statusCode).toBe(429);
    await sendSpans("4".repeat(32));
    await sendSpans("5".repeat(32));
    expect((await sendSpans("6".repeat(32))).statusCode).toBe(429);
    // Belum ada tulisan per request.
    expect(raw.prepare("SELECT COUNT(*) FROM quota_drops WHERE project_id = ?").pluck().get(projectId)).toBe(0);
    quota.flush();
    const hour = Math.floor(clock / 3_600_000) * 3600;
    expect(raw.prepare("SELECT hour, events, spans FROM quota_drops WHERE project_id = ?").get(projectId)).toEqual({ hour, events: 4, spans: SPANS_PER_REQ });
    expect(raw.prepare("SELECT spans FROM span_usage WHERE project_id = ? AND hour = ?").pluck().get(projectId, hour)).toBe(SPANS_PER_REQ * 2);
    await alerter.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.embeds[0]!.description).toBe(`Quota exceeded in Shop: 4 events / ${SPANS_PER_REQ} spans dropped in the last hour`);

    // Drop lagi 10 menit kemudian: tercatat, tapi tidak ada alert baru.
    clock += 10 * 60_000;
    await sendEvents(5);
    expect((await sendEvents(1)).statusCode).toBe(429);
    quota.flush();
    await alerter.idle();
    expect(sent).toHaveLength(1);
    expect(raw.prepare("SELECT events FROM quota_drops WHERE project_id = ?").pluck().get(projectId)).toBe(5);
    // Lewat satu jam: alert lagi.
    clock += 61 * 60_000;
    await sendEvents(5);
    await sendEvents(1);
    quota.flush();
    await alerter.idle();
    expect(sent).toHaveLength(2);
  });

  it("settings: admin-only, null = unlimited, 1–10,000,000; usage endpoint reports accepted and dropped", async () => {
    const admin = await login("admin@x.io");
    const viewer = await login("v@x.io");
    const patch = (who: { cookie: string }, payload: object) =>
      app.inject({ method: "PATCH", url: `/api/0/projects/${projectId}/settings`, payload, headers: who });
    expect((await patch(viewer, { quotaEventsPerMin: 10 })).statusCode).toBe(404);
    expect((await patch(admin, { quotaEventsPerMin: 0 })).statusCode).toBe(400);
    expect((await patch(admin, { quotaSpansPerMin: 10_000_001 })).statusCode).toBe(400);
    expect((await patch(admin, { quotaEventsPerMin: 1.5 })).statusCode).toBe(400);

    await sendEvents(5);
    expect((await sendEvents(7)).statusCode).toBe(429);
    expect((await patch(admin, { quotaEventsPerMin: null, quotaSpansPerMin: 10_000_000 })).statusCode).toBe(200);
    // Langsung berlaku (cache batas dikosongkan).
    expect((await sendEvents(7)).statusCode).toBe(200);
    const proj = (await app.inject({ method: "GET", url: `/api/0/projects/${projectId}`, headers: viewer })).json();
    expect(proj).toMatchObject({ quotaEventsPerMin: null, quotaSpansPerMin: 10_000_000 });

    expect(proj.overQuota).toBe(false); // drop belum di-flush: tidak ada tulisan per request
    await queue.drain();

    const u = await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/usage`, headers: viewer });
    expect(u.statusCode).toBe(200);
    const body = u.json();
    expect(body.hours).toHaveLength(24);
    expect(body.totals.events).toBe(12); // event tersimpan (jam nyata)
    expect(body.quotaEventsPerMin).toBeNull();
    expect(body.currentMinute).toHaveProperty("events");
  });

  it("usage and overQuota read quota_drops in the last 24h; retention removes rows older than 30 days", async () => {
    const hour = Math.floor(Date.now() / 3_600_000) * 3600;
    raw.prepare("INSERT INTO quota_drops (project_id, hour, events, spans) VALUES (?, ?, 12400, 3), (?, ?, 1, 0), (?, ?, 9, 9)")
      .run(projectId, hour, projectId, hour - 5 * 3600, projectId, hour - 31 * 86_400);
    raw.prepare("INSERT INTO span_usage (project_id, hour, spans) VALUES (?, ?, 50)").run(projectId, hour - 3600);
    const viewer = await login("v@x.io");
    const body = (await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/usage`, headers: viewer })).json();
    expect(body.totals).toMatchObject({ droppedEvents: 12401, droppedSpans: 3, spans: 50 });
    expect(body.hours.at(-1)).toMatchObject({ hour, droppedEvents: 12400, droppedSpans: 3 });
    expect((await app.inject({ method: "GET", url: `/api/0/projects/${projectId}`, headers: viewer })).json().overQuota).toBe(true);

    await runRetention(raw, new Date());
    expect(raw.prepare("SELECT COUNT(*) FROM quota_drops WHERE project_id = ?").pluck().get(projectId)).toBe(2);
  });
});
