import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { Alerter, type DiscordMessage } from "./alerts.js";
import { duration, OngoingAlertChecker } from "./ongoing-alerts.js";

// Ongoing errors: satu ringkasan per issue per interval selama event terus masuk, dengan backoff dan batas per project.
const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL not set (run via `pnpm test:int`)");

const prisma = createPrisma(url);
const raw = openRaw(sqlitePath(url));
const HOOK = "https://discord.com/api/webhooks/123456/abcDEF_ghi-123";
let sent: DiscordMessage[] = [];
const alerter = new Alerter(raw, { webUrl: "https://bugs.example.com", send: async (_u, msg) => { sent.push(msg); return { ok: true, status: 204 }; } });
const checker = new OngoingAlertChecker(raw, alerter, { webUrl: "https://bugs.example.com" });
const T0 = Date.UTC(2026, 9, 11, 1, 0, 0);
let projectId: string;

async function issue(title: string, firstSeenMs = T0 - 3_600_000) {
  return prisma.issue.create({ data: { projectId, fingerprint: randomUUID(), title, culprit: "POST /auth/login/init", firstSeen: new Date(firstSeenMs), lastSeen: new Date(firstSeenMs) } });
}
async function events(issueId: string, atMs: number, n: number, users = n) {
  await prisma.event.createMany({ data: Array.from({ length: n }, (_, i) => ({
    id: randomUUID().replace(/-/g, ""), projectId, issueId, receivedAt: new Date(atMs), timestamp: new Date(atMs), userId: `u${i % users}`, payload: {},
  })) });
}
const tick = async (ms: number) => { const n = checker.check(new Date(ms)); await alerter.idle(); return n; };

beforeEach(async () => {
  await tunePrisma(prisma);
  sent = [];
  await prisma.organization.deleteMany();
  const org = await prisma.organization.create({ data: { name: "T", slug: "t" } });
  const p = await prisma.project.create({ data: { organizationId: org.id, name: "Shop", slug: "t", discordWebhookUrl: HOOK, alertOngoingSeconds: 60, alertOngoingBackoff: true } });
  projectId = p.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("ongoing error alerts", () => {
  it("sends one summary per issue per interval while events keep coming, then stops", async () => {
    const i = await issue("HttpError: POST /auth/login/init — 400");
    await events(i.id, T0 - 10_000, 50, 12);
    expect(await tick(T0)).toBe(1);
    expect(sent[0]!.embeds[0]!.title).toBe("HttpError: POST /auth/login/init — 400");
    expect(sent[0]!.embeds[0]!.description).toContain("**50 events** · 12 users in the last 1 min");
    expect(sent[0]!.embeds[0]!.url).toBe(`https://bugs.example.com/p/${projectId}/issues/${i.id}`);

    await events(i.id, T0 + 20_000, 30);
    expect(await tick(T0 + 30_000)).toBe(0); // interval 1 menit belum lewat
    await events(i.id, T0 + 50_000, 10);
    expect(await tick(T0 + 60_000)).toBe(1);
    expect(sent[1]!.embeds[0]!.description).toContain("**40 events**");
    expect(sent[1]!.embeds[0]!.description).toContain("still happening, 1 min so far");

    expect(await tick(T0 + 120_000)).toBe(0); // tidak ada event baru: tidak ada pesan
  });

  it("backs off to every 15 minutes after 10 minutes of the same error", async () => {
    const i = await issue("E");
    for (let m = 0; m <= 14; m++) await events(i.id, T0 + m * 60_000 - 5_000, 1);
    let n = 0;
    for (let m = 0; m <= 14; m++) n += await tick(T0 + m * 60_000);
    expect(n).toBe(10); // menit 0..9 tiap menit; mulai menit ke-10 (backoff) tiap 15 menit
    await events(i.id, T0 + 23 * 60_000 - 5_000, 1);
    expect(await tick(T0 + 23 * 60_000)).toBe(0); // belum 15 menit sejak pesan menit ke-9
    await events(i.id, T0 + 24 * 60_000 - 5_000, 1);
    expect(await tick(T0 + 24 * 60_000)).toBe(1);
    expect(sent.at(-1)!.embeds[0]!.description).toContain("24 min so far");
  });

  it("skips ignored issues and the first interval of a brand-new issue when New issue alerts are on", async () => {
    const ignored = await issue("ignored");
    await prisma.issue.update({ where: { id: ignored.id }, data: { status: "ignored" } });
    await events(ignored.id, T0 - 5_000, 5);
    const fresh = await issue("fresh", T0 - 5_000);
    await events(fresh.id, T0 - 5_000, 5);
    expect(await tick(T0)).toBe(0);
    await events(fresh.id, T0 + 30_000, 3);
    expect(await tick(T0 + 60_000)).toBe(1);
    expect(sent[0]!.embeds[0]!.title).toBe("fresh");
  });

  it("caps messages per project per minute and summarizes the rest once", async () => {
    for (let k = 0; k < 25; k++) await events((await issue(`issue ${k}`)).id, T0 - 5_000, 1);
    expect(await tick(T0)).toBe(21); // 20 issue + 1 ringkasan
    expect(sent.at(-1)!.embeds[0]!.title).toBe("+5 more ongoing issues in Shop");
    expect(await tick(T0 + 30_000)).toBe(0); // menit sama: tidak ada ringkasan kedua
  });

  it("does nothing when turned off", async () => {
    await prisma.project.update({ where: { id: projectId }, data: { alertOngoingSeconds: null } });
    await events((await issue("x")).id, T0 - 5_000, 5);
    expect(await tick(T0)).toBe(0);
  });

  it("formats durations", () => {
    expect([20, 60, 420, 4800].map(duration)).toEqual(["20 s", "1 min", "7 min", "1 h 20 min"]);
  });
});
