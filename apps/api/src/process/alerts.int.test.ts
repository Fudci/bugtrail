import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { buildApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { Alerter, DISCORD_WEBHOOK_RE, type DiscordMessage } from "./alerts.js";
import { IngestStore } from "./store.js";

const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL not set (jalankan lewat `pnpm test:int`)");

const prisma = createPrisma(url);
const raw = openRaw(sqlitePath(url));
const HOOK = "https://discord.com/api/webhooks/123456/abcDEF_ghi-123";
let sent: { url: string; msg: DiscordMessage }[] = [];
const alerter = new Alerter(raw, {
  webUrl: "https://bugs.example.com",
  send: async (u, msg) => {
    sent.push({ url: u, msg });
    return { ok: true, status: 204 };
  },
});
const store = new IngestStore(raw, { maxBacklog: 1000, batchSize: 50, onBatch: (r) => alerter.onBatch(r) });
store.start();
let projectId: string;
let n = 0;

const ev = (fn: string) => ({
  event_id: (++n).toString(16).padStart(32, "a"),
  exception: { values: [{ type: "TypeError", value: "boom", stacktrace: { frames: [{ filename: "src/a.ts", function: fn, in_app: true }] } }] },
});
async function ingest(...events: object[]) {
  await store.enqueue(events.map((payload) => ({ projectId, receivedAt: new Date().toISOString(), payload: payload as Record<string, unknown> })));
  await store.drain();
  await alerter.idle();
}

beforeEach(async () => {
  await tunePrisma(prisma);
  sent = [];
  await prisma.organization.deleteMany();
  const org = await prisma.organization.create({ data: { name: "A", slug: "a" } });
  const p = await prisma.project.create({ data: { organizationId: org.id, name: "Mobile", slug: "m", discordWebhookUrl: HOOK } });
  projectId = p.id;
});

afterAll(async () => {
  await store.stop();
  raw.close();
  await prisma.$disconnect();
});

describe("alert Discord", () => {
  it("issue baru dikirim sekali; event berikutnya di issue yang sama tidak", async () => {
    await ingest(ev("handle"));
    await ingest(ev("handle"), ev("handle"));
    expect(sent).toHaveLength(1);
    const e = sent[0]!.msg.embeds[0]!;
    expect(e.title).toBe("TypeError: boom");
    expect(e.url).toMatch(new RegExp(`^https://bugs.example.com/p/${projectId}/issues/[0-9a-f-]{36}$`));
    expect(e.fields?.find((f) => f.name === "Type")?.value).toBe("New issue");
  });

  it("regresi: issue resolved yang muncul lagi", async () => {
    await ingest(ev("pay"));
    await prisma.issue.updateMany({ where: { projectId }, data: { status: "resolved" } });
    sent = [];
    await ingest(ev("pay"));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg.embeds[0]!.fields?.find((f) => f.name === "Type")?.value).toMatch(/Regression/);
    expect((await prisma.issue.findFirstOrThrow({ where: { projectId } })).status).toBe("unresolved");
  });

  it("toggle mati: tidak ada alert; tanpa webhook: tidak ada alert", async () => {
    await prisma.project.update({ where: { id: projectId }, data: { alertNewIssue: false } });
    await ingest(ev("x1"));
    await prisma.project.update({ where: { id: projectId }, data: { alertNewIssue: true, discordWebhookUrl: null } });
    await ingest(ev("x2"));
    expect(sent).toHaveLength(0);
  });

  it("lonjakan: sekali saat melewati batas, lalu cooldown", async () => {
    await prisma.project.update({ where: { id: projectId }, data: { alertNewIssue: false, alertSpikeThreshold: 5, alertSpikeMinutes: 5 } });
    await ingest(ev("s"), ev("s"), ev("s"));
    expect(sent).toHaveLength(0);
    await ingest(ev("s"), ev("s"));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg.embeds[0]!.title).toMatch(/Error spike/);
    await ingest(ev("s"), ev("s"), ev("s"));
    expect(sent).toHaveLength(1);
  });

  it("banyak issue baru sekaligus: maks 5 pesan + 1 ringkasan", async () => {
    await ingest(...Array.from({ length: 12 }, (_, i) => ev(`fn${i}`)));
    expect(sent).toHaveLength(6);
    expect(sent[5]!.msg.embeds[0]!.title).toMatch(/^\+7 /);
  });
});

describe("validasi webhook", () => {
  it("hanya URL webhook Discord", () => {
    expect(DISCORD_WEBHOOK_RE.test(HOOK)).toBe(true);
    expect(DISCORD_WEBHOOK_RE.test("https://discordapp.com/api/webhooks/1/x")).toBe(true);
    for (const bad of ["http://discord.com/api/webhooks/1/x", "https://evil.com/api/webhooks/1/x",
      "https://discord.com.evil.com/api/webhooks/1/x", "http://169.254.169.254/latest", "https://discord.com/api/webhooks/1/x?y=1"]) {
      expect(DISCORD_WEBHOOK_RE.test(bad), bad).toBe(false);
    }
  });

  it("API: simpan, samarkan URL, tolak URL non-Discord, admin saja", async () => {
    await prisma.user.deleteMany();
    const passwordHash = await hashPassword("password-123");
    await prisma.user.create({ data: { email: "root@x.io", passwordHash, isAdmin: true } });
    const app = await buildApp({ prisma, store, alerter });
    const login = await app.inject({ method: "POST", url: "/api/0/auth/login", payload: { email: "root@x.io", password: "password-123" } });
    const cookie = `bt_session=${login.cookies.find((c) => c.name === "bt_session")!.value}`;
    const patch = (payload: object) => app.inject({ method: "PATCH", url: `/api/0/projects/${projectId}/alerts`, headers: { cookie }, payload });

    expect((await patch({ discordWebhookUrl: "http://169.254.169.254/x" })).statusCode).toBe(400);
    expect((await patch({ discordWebhookUrl: HOOK, alertSpikeThreshold: 100 })).statusCode).toBe(200);
    const proj = (await app.inject({ method: "GET", url: `/api/0/projects/${projectId}`, headers: { cookie } })).json();
    expect(proj.alerts.discordWebhook).toBe("https://discord.com/api/webhooks/123456/••••-123");
    expect(JSON.stringify(proj)).not.toContain("abcDEF");
    expect(proj.alerts.spikeThreshold).toBe(100);

    const t = await app.inject({ method: "POST", url: `/api/0/projects/${projectId}/alerts/test`, headers: { cookie }, payload: {} });
    expect(t.statusCode).toBe(200);
    expect(sent.at(-1)!.url).toBe(HOOK);
    await app.close();
  });
});
