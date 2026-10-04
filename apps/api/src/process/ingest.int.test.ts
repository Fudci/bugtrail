import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { buildApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { IngestStore } from "./store.js";

// Alur penuh: HTTP envelope -> antrian di memori -> persistBatch -> issues/events (SQLite).
const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL not set (jalankan lewat `pnpm test:int`)");

const prisma = createPrisma(url);
const raw = openRaw(sqlitePath(url));
const queue = new IngestStore(raw, { maxBacklog: 1000, batchSize: 50 });
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;
const KEY = "0123456789abcdef0123456789abcdef";
const path = () => `/api/${projectId}/envelope/`;

function envelope(ev: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const body = JSON.stringify(ev);
  return `${JSON.stringify(header)}\n${JSON.stringify({ type: "event", length: Buffer.byteLength(body) })}\n${body}\n`;
}

function errorEvent(eventId: string, fn = "handle", lineno = 10) {
  return {
    event_id: eventId,
    exception: {
      values: [{ type: "TypeError", value: `bad ${lineno}`, stacktrace: { frames: [{ filename: "src/a.ts", function: fn, lineno, in_app: true }] } }],
    },
  };
}

const id = (n: number) => n.toString(16).padStart(32, "0");

// Tunggu antrian kosong; return jumlah event yang diterima sejak drain terakhir.
let lastAccepted = 0;
async function drain() {
  await queue.drain();
  const n = queue.accepted - lastAccepted;
  lastAccepted = queue.accepted;
  return n;
}

beforeAll(async () => {
  await tunePrisma(prisma);
  queue.start();
  app = await buildApp({ prisma, store: queue });
});

beforeEach(async () => {
  await drain();
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

describe("ingest end-to-end", () => {
  it("groups same stack into one issue and dedupes event_id", async () => {
    const send = (ev: object) =>
      app.inject({ method: "POST", url: `${path()}?sentry_key=${KEY}`, payload: envelope(ev as Record<string, unknown>), headers: { "content-type": "text/plain" } });

    expect((await send(errorEvent(id(1), "handle", 10))).json()).toEqual({ id: id(1) });
    await send(errorEvent(id(2), "handle", 99));
    await send(errorEvent(id(1), "handle", 10)); // duplikat
    await send(errorEvent(id(3), "other"));
    expect(await drain()).toBe(4);

    const issues = await prisma.issue.findMany({ where: { projectId }, orderBy: { eventCount: "desc" } });
    expect(issues.map((i) => i.eventCount)).toEqual([2, 1]);
    expect(issues[0]!.title).toBe("TypeError: bad 10");
    expect(await prisma.event.count({ where: { projectId } })).toBe(3);
  });

  it("accepts gzip + X-Sentry-Auth, and dsn in envelope header", async () => {
    const r1 = await app.inject({
      method: "POST",
      url: path(),
      payload: gzipSync(envelope(errorEvent(id(10)))),
      headers: { "content-encoding": "gzip", "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${KEY}` },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({
      method: "POST",
      url: path(),
      payload: envelope({ event_id: id(11), message: "x" }, { dsn: `http://${KEY}@h/${projectId}` }),
    });
    expect(r2.statusCode).toBe(200);
    expect(await drain()).toBe(2);
  });

  it("reopens a resolved issue on new event", async () => {
    const send = (n: number) => app.inject({ method: "POST", url: `${path()}?sentry_key=${KEY}`, payload: envelope(errorEvent(id(n))) });
    await send(20);
    await drain();
    await prisma.issue.updateMany({ where: { projectId }, data: { status: "resolved" } });
    await send(21);
    await drain();
    const [issue] = await prisma.issue.findMany({ where: { projectId } });
    expect(issue!.status).toBe("unresolved");
  });

  it("rejects bad auth and malformed input", async () => {
    const ev = envelope(errorEvent(id(30)));
    expect((await app.inject({ method: "POST", url: path(), payload: ev })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${path()}?sentry_key=nope`, payload: ev })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${path()}?sentry_key=${KEY}`, payload: "xx" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/not-a-uuid/envelope/?sentry_key=${KEY}`, payload: ev })).statusCode).toBe(404);
    expect(await drain()).toBe(0);
  });

  it("answers CORS preflight", async () => {
    const r = await app.inject({
      method: "OPTIONS",
      url: path(),
      headers: { origin: "https://app.example.com", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(r.statusCode).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });
});

describe("releases", () => {
  it("ringkasan per release + filter issue per release", async () => {
    const withRelease = (eventId: string, release: string, fn: string) => ({ ...errorEvent(eventId, fn), release, user: { id: `u-${eventId}` } });
    const send = (ev: object) => app.inject({ method: "POST", url: `${path()}?sentry_key=${KEY}`, payload: envelope(ev as Record<string, unknown>) });
    await send(withRelease(id(100), "app@1.0.0", "a"));
    await send(withRelease(id(101), "app@1.0.0", "a"));
    await send(withRelease(id(102), "app@1.1.0", "a"));
    await send(withRelease(id(103), "app@1.1.0", "b"));
    await drain();

    const passwordHash = await hashPassword("password-123");
    const user = await prisma.user.create({ data: { email: `r${Date.now()}@x.io`, passwordHash, isAdmin: true } });
    const login = await app.inject({ method: "POST", url: "/api/0/auth/login", payload: { email: user.email, password: "password-123" } });
    const cookie = `bt_session=${login.cookies.find((c) => c.name === "bt_session")!.value}`;

    const rel = (await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/releases`, headers: { cookie } })).json();
    const byName = Object.fromEntries(rel.map((r: { release: string }) => [r.release, r]));
    expect(byName["app@1.0.0"]).toMatchObject({ events: 2, issues: 1, users: 2, newIssues: 1 });
    expect(byName["app@1.1.0"]).toMatchObject({ events: 2, issues: 2, users: 2, newIssues: 1 });

    const inRel = (await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/issues?status=all&release=app@1.1.0`, headers: { cookie } })).json();
    expect(inRel.issues).toHaveLength(2);
    const fresh = (await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/issues?status=all&firstRelease=app@1.1.0`, headers: { cookie } })).json();
    expect(fresh.issues).toHaveLength(1);
  });
});

describe("user terdampak & event per user", () => {
  it("daftar user, event terakhir per user, ringkasan device, event issue lain ditolak", async () => {
    const ev = (n: number, user: string, model: string, online: boolean) => ({
      ...errorEvent(id(200 + n), "crashy"),
      user: { id: user },
      contexts: { device: { manufacturer: "Xiaomi", model, online, connection_type: online ? "wifi" : null }, os: { name: "Android", version: "16" } },
    });
    const send = (e: object) => app.inject({ method: "POST", url: `${path()}?sentry_key=${KEY}`, payload: envelope(e as Record<string, unknown>) });
    await send(ev(1, "budi", "A1", true));
    await send(ev(2, "budi", "A1", true));
    await send(ev(3, "sari", "B2", false));
    await send({ ...errorEvent(id(299), "other-fn"), user: { id: "x" } });
    await drain();

    const passwordHash = await hashPassword("password-123");
    const user = await prisma.user.create({ data: { email: `u${Date.now()}@x.io`, passwordHash, isAdmin: true } });
    const login = await app.inject({ method: "POST", url: "/api/0/auth/login", payload: { email: user.email, password: "password-123" } });
    const cookie = `bt_session=${login.cookies.find((c) => c.name === "bt_session")!.value}`;
    const get = (u: string) => app.inject({ method: "GET", url: `/api/0${u}`, headers: { cookie } });

    const issues = (await get(`/projects/${projectId}/issues?status=all`)).json().issues as { id: string; culprit: string }[];
    const crashy = issues.find((i) => i.culprit.includes("crashy"))!;
    const other = issues.find((i) => i.culprit.includes("other-fn"))!;

    const users = (await get(`/issues/${crashy.id}/users`)).json();
    expect(users.map((u: { userId: string; events: number }) => [u.userId, u.events])).toEqual([["budi", 2], ["sari", 1]]);
    const sariEvent = (await get(`/issues/${crashy.id}/events/${users[1].lastEventId}`)).json();
    expect(sariEvent.event.payload.user.id).toBe("sari");
    expect(sariEvent.event.payload.contexts.device.online).toBe(false);

    const list = (await get(`/issues/${crashy.id}/events`)).json().events;
    expect(list).toHaveLength(3);
    expect(list.find((e: { userId: string }) => e.userId === "sari")).toMatchObject({ device: "Xiaomi B2", os: "Android 16", online: false });
    expect(list.find((e: { userId: string }) => e.userId === "budi")).toMatchObject({ online: true, connection: "wifi" });

    // Event dari issue lain tidak bisa dibuka lewat issue ini.
    const otherEventId = (await get(`/issues/${other.id}/events`)).json().events[0].id;
    expect((await get(`/issues/${crashy.id}/events/${otherEventId}`)).statusCode).toBe(404);
  });
});
