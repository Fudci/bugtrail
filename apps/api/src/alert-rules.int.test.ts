import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./auth/password.js";
import { keyCache } from "./ingest/key-cache.js";
import { RollupAggregator } from "./otlp/rollups.js";
import { SqliteTelemetryStore } from "./otlp/telemetry-store.js";
import { AlertRuleChecker } from "./process/alert-rules.js";
import { Alerter, type DiscordMessage } from "./process/alerts.js";
import { IngestStore } from "./process/store.js";

// Aturan alert: OTLP -> rollup (termasuk per kode status) -> AlertRuleChecker -> Discord; plus API CRUD.
const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL not set (run via `pnpm test:int`)");

const prisma = createPrisma(url);
const raw = openRaw(sqlitePath(url));
const queue = new IngestStore(raw, { maxBacklog: 1000, batchSize: 50 });
const telemetry = new SqliteTelemetryStore(raw);
const rollups = new RollupAggregator(raw); // tidak di-start: test memanggil flush()
const HOOK = "https://discord.com/api/webhooks/123456/abcDEF_ghi-123";
const KEY = "abcabcabcabcabcabcabcabcabcabc12";
const PW = "password-123";
let sent: { url: string; msg: DiscordMessage }[] = [];
const alerter = new Alerter(raw, { webUrl: "https://bugs.example.com", send: async (u, msg) => { sent.push({ url: u, msg }); return { ok: true, status: 204 }; } });
const checker = new AlertRuleChecker(raw, alerter);
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;
let admin: string;
let viewer: string;

let seq = 0;
const req = (route: string, status: number, ms = 5) => ({
  traceId: (++seq).toString(16).padStart(32, "a"), spanId: seq.toString(16).padStart(16, "b"), name: `GET ${route}`, kind: 2,
  startTimeUnixNano: "1700000000000000000", endTimeUnixNano: String(1700000000000000000n + BigInt(ms) * 1_000_000n), status: {},
  attributes: [
    { key: "http.request.method", value: { stringValue: "GET" } },
    { key: "http.route", value: { stringValue: route } },
    { key: "http.response.status_code", value: { intValue: String(status) } },
  ],
});
async function send(spans: object[]) {
  const r = await app.inject({ method: "POST", url: "/otlp/v1/traces", headers: { "content-type": "application/json", "x-bugtrail-key": KEY },
    payload: JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans }] }] }) });
  expect(r.statusCode).toBe(200);
  rollups.flush();
}
const many = (n: number, route: string, status: number, ms?: number) => Array.from({ length: n }, () => req(route, status, ms));
const api = (cookie: string, method: "GET" | "POST" | "PUT" | "DELETE", path: string, payload?: object) =>
  app.inject({ method, url: `/api/0/projects/${projectId}/alert-rules${path}`, headers: { cookie }, ...(payload && { payload }) });
const rule = (over: object = {}) => ({ name: "rule", kind: "status", statusFilter: "5xx", mode: "pct", threshold: 10, windowMinutes: 5, minRequests: 10, ...over });

async function login(email: string) {
  const r = await app.inject({ method: "POST", url: "/api/0/auth/login", payload: { email, password: PW } });
  const c = r.cookies.find((c) => c.name === "bt_session")!;
  return `${c.name}=${c.value}`;
}

beforeAll(async () => {
  await tunePrisma(prisma);
  queue.start();
  app = await buildApp({ prisma, store: queue, telemetry, rollups, alerter });
});

beforeEach(async () => {
  await queue.drain();
  rollups.flush();
  keyCache.clear();
  sent = [];
  await prisma.organization.deleteMany();
  const org = await prisma.organization.create({ data: { name: "T", slug: "t" } });
  const p = await prisma.project.create({ data: { organizationId: org.id, name: "Shop", slug: "t", discordWebhookUrl: HOOK } });
  await prisma.dsnKey.create({ data: { projectId: p.id, publicKey: KEY } });
  projectId = p.id;
  await prisma.user.deleteMany();
  const passwordHash = await hashPassword(PW);
  const a = await prisma.user.create({ data: { username: "admin", email: "admin@x.io", passwordHash } });
  const v = await prisma.user.create({ data: { username: "viewer", email: "viewer@x.io", passwordHash } });
  await prisma.member.create({ data: { projectId, userId: a.id, role: "admin" } });
  await prisma.member.create({ data: { projectId, userId: v.id, role: "viewer" } });
  admin = await login("admin@x.io");
  viewer = await login("viewer@x.io");
});

afterAll(async () => {
  await app?.close();
  await queue.stop();
  await prisma.$disconnect();
});

describe("alert rules checker", () => {
  it("status rule by exact code: counts only 403, links to the filtered endpoint, respects cooldown", async () => {
    expect((await api(admin, "POST", "", rule({ name: "Forbidden spike", statusFilter: "403", mode: "count", threshold: 5 }))).statusCode).toBe(201);
    await send([...many(6, "/admin", 403), ...many(20, "/admin", 401), ...many(4, "/orders", 403)]);
    const now = new Date();
    expect(checker.check(now)).toBe(1); // /orders hanya 4 x 403
    await alerter.idle();
    const e = sent[0]!.msg.embeds[0]!;
    expect(sent[0]!.url).toBe(HOOK);
    expect(e.title).toBe("Forbidden spike: GET /admin");
    expect(e.description).toContain("**6** requests matched `403`");
    expect(e.fields).toContainEqual({ name: "Status codes", value: "403 × 6", inline: true });
    expect(e.url).toBe(`https://bugs.example.com/p/${projectId}/health?method=GET&route=%2Fadmin&status=403`);
    expect(checker.check(new Date(now.getTime() + 60_000))).toBe(0); // cooldown 30 menit
  });

  it("percentage rule needs min requests; a rule scoped to one endpoint ignores others", async () => {
    await api(admin, "POST", "", rule({ name: "5xx", threshold: 10, minRequests: 10 }));
    await api(admin, "POST", "", rule({ name: "checkout only", statusFilter: "500,502", threshold: 50, minRequests: 1, method: "get", route: "/checkout" }));
    await send([...many(5, "/few", 500), ...many(18, "/bad", 200), ...many(2, "/bad", 503), ...many(1, "/checkout", 502), ...many(1, "/checkout", 200)]);
    expect(checker.check(new Date())).toBe(2);
    await alerter.idle();
    expect(sent.map((s) => s.msg.embeds[0]!.title).sort()).toEqual(["5xx: GET /bad", "checkout only: GET /checkout"]);
    // /few: 100% tapi < 10 request; /checkout tidak dihitung aturan "5xx" (2 request < 10)
  });

  it("latency rule on a percentile", async () => {
    await api(admin, "POST", "", rule({ name: "slow", kind: "latency", percentile: 95, threshold: 1000, minRequests: 5, statusFilter: null }));
    await send([...many(10, "/slow", 200, 1500), ...many(10, "/fast", 200, 20)]);
    expect(checker.check(new Date())).toBe(1);
    await alerter.idle();
    expect(sent[0]!.msg.embeds[0]!.title).toBe("slow: GET /slow");
    expect(sent[0]!.msg.embeds[0]!.description).toContain("**p95 2,500 ms** over 10 requests");
  });

  it("disabled rules and projects without a webhook stay quiet", async () => {
    await api(admin, "POST", "", rule({ enabled: false }));
    await send(many(20, "/x", 500));
    expect(checker.check(new Date())).toBe(0);
    await api(admin, "POST", "", rule());
    await prisma.project.update({ where: { id: projectId }, data: { discordWebhookUrl: null } });
    expect(checker.check(new Date())).toBe(0);
  });
});

describe("alert rules API", () => {
  it("creates, lists, updates and deletes rules (admin only)", async () => {
    const c = await api(admin, "POST", "", rule({ name: "  Login 401  ", statusFilter: " 401, 403 ", method: "post", route: "/login" }));
    expect(c.statusCode).toBe(201);
    expect(c.json()).toMatchObject({ name: "Login 401", statusFilter: "401,403", method: "POST", route: "/login", enabled: true,
      summary: "401,403 ≥ 10% of requests in 5 min, min 10 requests" });
    const id = c.json().id;
    expect((await api(admin, "GET", "")).json().rules).toHaveLength(1);
    const u = await api(admin, "PUT", `/${id}`, rule({ name: "lat", kind: "latency", percentile: 99, threshold: 800, statusFilter: "5xx" }));
    expect(u.json()).toMatchObject({ kind: "latency", percentile: 99, statusFilter: null, method: null, summary: "p99 ≥ 800 ms in 5 min, min 10 requests" });
    expect((await api(viewer, "GET", "")).statusCode).toBe(404);
    expect((await api(viewer, "DELETE", `/${id}`)).statusCode).toBe(404);
    expect((await api(admin, "DELETE", `/${id}`)).statusCode).toBe(204);
    expect((await api(admin, "DELETE", `/${id}`)).statusCode).toBe(404);
  });

  it("rejects invalid rules", async () => {
    for (const bad of [
      rule({ statusFilter: "" }), rule({ statusFilter: "all" }), rule({ statusFilter: "700" }),
      rule({ threshold: 150 }), rule({ kind: "latency", percentile: null }), rule({ method: "GET" }),
      rule({ windowMinutes: 61 }), rule({ name: "" }),
    ]) expect((await api(admin, "POST", "", bad)).statusCode).toBe(400);
    expect((await api(admin, "POST", "", rule({ mode: "count", threshold: 500 }))).statusCode).toBe(201); // jumlah boleh > 100
  });

  it("caps rules per project and sends a test message for one rule", async () => {
    for (let i = 0; i < 20; i++) expect((await api(admin, "POST", "", rule({ name: `r${i}` }))).statusCode).toBe(201);
    expect((await api(admin, "POST", "", rule())).statusCode).toBe(400);
    const id = (await api(admin, "GET", "")).json().rules[0].id;
    expect((await api(admin, "POST", `/${id}/test`)).statusCode).toBe(200);
    expect(sent[0]!.msg.embeds[0]!.title).toBe("[Test] r0: GET /example");
  });
});
