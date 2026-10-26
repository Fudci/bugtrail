import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { buildApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { runRetention } from "../process/retention.js";
import { IngestStore } from "../process/store.js";

const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL not set (jalankan lewat `pnpm test:int`)");

const prisma = createPrisma(url);
// Route ingest butuh antrian; test ini tidak mengirim event.
const raw = openRaw(sqlitePath(url));
const queue = new IngestStore(raw, { maxBacklog: 10, batchSize: 10 });
let app: Awaited<ReturnType<typeof buildApp>>;
const PW = "password-123";

async function login(email: string) {
  const r = await app.inject({ method: "POST", url: "/api/0/auth/login", payload: { email, password: PW } });
  expect(r.statusCode).toBe(200);
  const c = r.cookies.find((c) => c.name === "bt_session")!;
  return { cookie: `${c.name}=${c.value}` };
}

const as = (who: { cookie: string }) => ({
  get: (u: string) => app.inject({ method: "GET", url: `/api/0${u}`, headers: who }),
  post: (u: string, payload: object = {}) => app.inject({ method: "POST", url: `/api/0${u}`, payload, headers: who }),
  patch: (u: string, payload: object) => app.inject({ method: "PATCH", url: `/api/0${u}`, payload, headers: who }),
  del: (u: string) => app.inject({ method: "DELETE", url: `/api/0${u}`, headers: who }),
});

beforeAll(async () => {
  await tunePrisma(prisma);
  app = await buildApp({ prisma, store: queue, dbPath: sqlitePath(url) });
});

beforeEach(async () => {
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
  const passwordHash = await hashPassword(PW);
  await prisma.user.createMany({
    data: [
      { username: "admin", email: "admin@x.io", passwordHash, isAdmin: true },
      { username: "budi", email: "budi@x.io", passwordHash },
    ],
  });
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

async function seedIssue(projectId: string, title: string, lastSeen = new Date()) {
  const issue = await prisma.issue.create({
    data: { projectId, fingerprint: title, title, firstSeen: lastSeen, lastSeen, eventCount: 1 },
  });
  await prisma.event.create({
    data: { id: crypto.randomUUID(), projectId, issueId: issue.id, timestamp: lastSeen, payload: { message: title } },
  });
  return issue;
}

describe("auth", () => {
  it("rejects wrong password and unauthenticated access", async () => {
    const r = await app.inject({ method: "POST", url: "/api/0/auth/login", payload: { email: "admin@x.io", password: "nope" } });
    expect(r.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/0/projects" })).statusCode).toBe(401);
  });

  it("sets httpOnly cookie, /me works, logout invalidates session", async () => {
    const r = await app.inject({ method: "POST", url: "/api/0/auth/login", payload: { email: "ADMIN@x.io", password: PW } });
    const c = r.cookies.find((c) => c.name === "bt_session")!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe("Lax");
    const me = as({ cookie: `bt_session=${c.value}` });
    expect((await me.get("/auth/me")).json().email).toBe("admin@x.io");
    await me.post("/auth/logout");
    expect((await me.get("/auth/me")).statusCode).toBe(401);
  });
});

describe("projects & membership", () => {
  it("only global admin creates projects; creator gets DSN", async () => {
    const admin = as(await login("admin@x.io"));
    const budi = as(await login("budi@x.io"));
    expect((await budi.post("/projects", { name: "X" })).statusCode).toBe(403);
    const r = await admin.post("/projects", { name: "Mobile App", platform: "flutter" });
    expect(r.statusCode).toBe(201);
    expect(r.json().dsn).toMatch(/^http:\/\/[0-9a-f]{32}@localhost:4000\/\d+$/);
  });

  it("non-members cannot see project, issues, or issue detail", async () => {
    const admin = as(await login("admin@x.io"));
    const budi = as(await login("budi@x.io"));
    const pid = (await admin.post("/projects", { name: "Secret" })).json().id;
    const issue = await seedIssue(pid, "boom");

    expect((await budi.get("/projects")).json()).toEqual([]);
    expect((await budi.get(`/projects/${pid}`)).statusCode).toBe(404);
    expect((await budi.get(`/projects/${pid}/issues`)).statusCode).toBe(404);
    expect((await budi.get(`/issues/${issue.id}`)).statusCode).toBe(404);
    expect((await budi.patch(`/issues/${issue.id}`, { status: "resolved" })).statusCode).toBe(404);
  });

  it("invite flow: new user sets password, gets access with invited role", async () => {
    const admin = as(await login("admin@x.io"));
    const pid = (await admin.post("/projects", { name: "P" })).json().id;
    await seedIssue(pid, "boom");

    const inv = await admin.post(`/projects/${pid}/invites`, { email: "sari@x.io", role: "viewer" });
    expect(inv.statusCode).toBe(201);
    const token = inv.json().link.split("/invite/")[1];

    const info = await app.inject({ method: "GET", url: `/api/0/invites/${token}` });
    expect(info.json()).toMatchObject({ email: "sari@x.io", hasAccount: false, project: { name: "P" } });

    expect((await app.inject({ method: "POST", url: `/api/0/invites/${token}/accept`, payload: { password: "short" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/0/invites/${token}/accept`, payload: { password: "sari-password-1" } })).statusCode).toBe(400); // tanpa username
    const acc = await app.inject({ method: "POST", url: `/api/0/invites/${token}/accept`, payload: { username: "sari", password: "sari-password-1" } });
    expect(acc.statusCode).toBe(200);
    const sari = as({ cookie: `bt_session=${acc.cookies.find((c) => c.name === "bt_session")!.value}` });

    expect((await sari.get("/projects")).json()).toHaveLength(1);
    expect((await sari.get(`/projects/${pid}`)).json()).toMatchObject({ role: "viewer", dsnKeys: [] });
    const [issue] = (await sari.get(`/projects/${pid}/issues`)).json().issues;
    // viewer: boleh lihat, tidak boleh ubah
    expect((await sari.patch(`/issues/${issue.id}`, { status: "resolved" })).statusCode).toBe(404);
    // token sekali pakai
    expect((await app.inject({ method: "GET", url: `/api/0/invites/${token}` })).statusCode).toBe(404);
  });

  it("plain link invite: no email, the invitee picks a username, link works once", async () => {
    const admin = as(await login("admin@x.io"));
    const pid = (await admin.post("/projects", { name: "P" })).json().id;
    const inv = await admin.post(`/projects/${pid}/invites`, { role: "member" });
    expect(inv.statusCode).toBe(201);
    expect(inv.json()).toMatchObject({ email: null, role: "member" });
    const token = inv.json().link.split("/invite/")[1];
    expect((await app.inject({ method: "GET", url: `/api/0/invites/${token}` })).json()).toMatchObject({ email: null, hasAccount: false });

    const accept = (payload: object) => app.inject({ method: "POST", url: `/api/0/invites/${token}/accept`, payload });
    expect((await accept({ username: "Bad Name!", password: "andi-password-1" })).statusCode).toBe(400);
    expect((await accept({ username: "admin", password: "andi-password-1" })).statusCode).toBe(409); // sudah dipakai
    expect((await accept({ username: "andi.s", email: "admin@x.io", password: "andi-password-1" })).statusCode).toBe(409); // email milik akun lain
    const ok = await accept({ username: "Andi.S", name: "Andi", password: "andi-password-1" });
    expect(ok.statusCode).toBe(200);
    expect((await accept({ username: "someone", password: "other-password-1" })).statusCode).toBe(404); // sekali pakai

    // Login dengan username (huruf besar/kecil tidak berpengaruh); email kosong.
    const r = await app.inject({ method: "POST", url: "/api/0/auth/login", payload: { login: "ANDI.S", password: "andi-password-1" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ username: "andi.s", email: null, name: "Andi" });
    const andi = as({ cookie: `bt_session=${r.cookies.find((c) => c.name === "bt_session")!.value}` });
    expect((await andi.get(`/projects/${pid}`)).json().role).toBe("member");
    const members = (await admin.get(`/projects/${pid}/members`)).json().members;
    expect(members.map((m: { username: string }) => m.username)).toContain("andi.s");
  });

  it("a signed-in user can accept a plain link invite with their existing account", async () => {
    const admin = as(await login("admin@x.io"));
    const pid = (await admin.post("/projects", { name: "P" })).json().id;
    const token = (await admin.post(`/projects/${pid}/invites`, { role: "viewer" })).json().link.split("/invite/")[1];
    const budi = as(await login("budi@x.io"));
    expect((await budi.post(`/invites/${token}/accept`)).statusCode).toBe(200);
    expect((await budi.get(`/projects/${pid}`)).json().role).toBe("viewer");
  });

  it("existing user must be logged in as invited email to accept", async () => {
    const admin = as(await login("admin@x.io"));
    const pid = (await admin.post("/projects", { name: "P" })).json().id;
    const token = (await admin.post(`/projects/${pid}/invites`, { email: "budi@x.io" })).json().link.split("/invite/")[1];

    // Tanpa login: tidak boleh men-set password akun orang lain lewat link undangan.
    const anon = await app.inject({ method: "POST", url: `/api/0/invites/${token}/accept`, payload: { password: "hijack-password" } });
    expect(anon.statusCode).toBe(403);
    const budi = as(await login("budi@x.io"));
    expect((await budi.post(`/invites/${token}/accept`)).statusCode).toBe(200);
    expect((await budi.get("/projects")).json()[0].role).toBe("member");
  });

  it("password reset link: admin creates it, the member sets a new password once, old sessions end", async () => {
    const admin = as(await login("admin@x.io"));
    const pid = (await admin.post("/projects", { name: "P" })).json().id;
    const budiId = (await prisma.user.findUniqueOrThrow({ where: { username: "budi" } })).id;
    await prisma.member.create({ data: { projectId: pid, userId: budiId, role: "member" } });
    const oldSession = as(await login("budi@x.io"));

    const r = await admin.post(`/projects/${pid}/members/${budiId}/password-reset`);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ username: "budi" });
    const token = r.json().link.split("/reset-password/")[1];
    // Link baru membatalkan yang lama.
    const token2 = (await admin.post(`/projects/${pid}/members/${budiId}/password-reset`)).json().link.split("/reset-password/")[1];
    expect((await app.inject({ method: "GET", url: `/api/0/password-reset/${token}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/0/password-reset/${token2}` })).json()).toEqual({ username: "budi" });

    const reset = (password: string) => app.inject({ method: "POST", url: `/api/0/password-reset/${token2}`, payload: { password } });
    expect((await reset("short")).statusCode).toBe(400);
    const ok = await reset("budi-new-password");
    expect(ok.statusCode).toBe(200);
    expect(ok.cookies.some((c) => c.name === "bt_session")).toBe(true); // langsung login
    expect((await reset("another-password-1")).statusCode).toBe(404); // sekali pakai
    expect((await oldSession.get("/projects")).statusCode).toBe(401); // sesi lama berakhir

    const bad = await app.inject({ method: "POST", url: "/api/0/auth/login", payload: { login: "budi", password: PW } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: "POST", url: "/api/0/auth/login", payload: { login: "budi", password: "budi-new-password" } });
    expect(good.statusCode).toBe(200);
  });

  it("password reset link: a project admin cannot take over wider accounts", async () => {
    const admin = as(await login("admin@x.io"));
    const p1 = (await admin.post("/projects", { name: "P1" })).json().id;
    const p2 = (await admin.post("/projects", { name: "P2" })).json().id;
    const passwordHash = await hashPassword(PW);
    const sari = await prisma.user.create({ data: { username: "sari", email: "sari@x.io", passwordHash } });
    const budiId = (await prisma.user.findUniqueOrThrow({ where: { username: "budi" } })).id;
    const adminId = (await prisma.user.findUniqueOrThrow({ where: { username: "admin" } })).id;
    await prisma.member.createMany({ data: [
      { projectId: p1, userId: sari.id, role: "admin" },   // sari: admin project P1 saja
      { projectId: p1, userId: budiId, role: "member" },
      { projectId: p2, userId: budiId, role: "member" },   // budi juga di P2 (bukan dikelola sari)
    ] }); // admin global sudah member P1 (pembuat project)
    const s = as(await login("sari@x.io"));
    expect((await s.post(`/projects/${p1}/members/${budiId}/password-reset`)).statusCode).toBe(403);
    expect((await s.post(`/projects/${p1}/members/${adminId}/password-reset`)).statusCode).toBe(403);
    expect((await s.post(`/projects/${p1}/members/${sari.id}/password-reset`)).statusCode).toBe(400); // diri sendiri
    await prisma.member.deleteMany({ where: { projectId: p2, userId: budiId } });
    expect((await s.post(`/projects/${p1}/members/${budiId}/password-reset`)).statusCode).toBe(201); // kini hanya di P1
    // Bukan admin project: 404.
    const b = as(await login("budi@x.io"));
    expect((await b.post(`/projects/${p1}/members/${sari.id}/password-reset`)).statusCode).toBe(404);
  });

  it("member cannot invite; last admin cannot be demoted", async () => {
    const admin = as(await login("admin@x.io"));
    const pid = (await admin.post("/projects", { name: "P" })).json().id;
    const budiUser = await prisma.user.findUniqueOrThrow({ where: { email: "budi@x.io" } });
    await prisma.member.create({ data: { projectId: pid, userId: budiUser.id, role: "member" } });
    const budi = as(await login("budi@x.io"));

    expect((await budi.post(`/projects/${pid}/invites`, { email: "z@x.io" })).statusCode).toBe(404);
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: "admin@x.io" } });
    expect((await admin.patch(`/projects/${pid}/members/${adminUser.id}`, { role: "member" })).statusCode).toBe(409);
  });
});

describe("issues", () => {
  it("lists with status filter, search, cursor pagination; patch status & assignee", async () => {
    const admin = as(await login("admin@x.io"));
    const pid = (await admin.post("/projects", { name: "P" })).json().id;
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await seedIssue(pid, `Error number ${i}`, new Date(t0 - i * 1000));
    await seedIssue(pid, "Timeout talking to payments", new Date(t0 - 10_000));

    const p1 = (await admin.get(`/projects/${pid}/issues?limit=4`)).json();
    expect(p1.issues.map((i: { title: string }) => i.title)).toEqual(["Error number 0", "Error number 1", "Error number 2", "Error number 3"]);
    const p2 = (await admin.get(`/projects/${pid}/issues?limit=4&cursor=${p1.nextCursor}`)).json();
    expect(p2.issues).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();

    const s = (await admin.get(`/projects/${pid}/issues?query=payments`)).json();
    expect(s.issues.map((i: { title: string }) => i.title)).toEqual(["Timeout talking to payments"]);

    const target = p1.issues[0].id;
    const budiUser = await prisma.user.findUniqueOrThrow({ where: { email: "budi@x.io" } });
    expect((await admin.patch(`/issues/${target}`, { assigneeId: budiUser.id })).statusCode).toBe(400); // bukan anggota
    const me = (await admin.get("/auth/me")).json();
    expect((await admin.patch(`/issues/${target}`, { status: "resolved", assigneeId: me.id })).statusCode).toBe(200);

    expect((await admin.get(`/projects/${pid}/issues`)).json().issues).toHaveLength(5);
    const detail = (await admin.get(`/issues/${target}`)).json();
    expect(detail).toMatchObject({ status: "resolved", assignee: { id: me.id } });
    expect(detail.latestEvent.payload).toEqual({ message: "Error number 0" });
  });

  it("exports filtered issues as CSV, escaping quotes and formula cells; hidden from non-members", async () => {
    const admin = as(await login("admin@x.io"));
    const pid = (await admin.post("/projects", { name: "P" })).json().id;
    await seedIssue(pid, 'Bad "quote", comma');
    await seedIssue(pid, "=HYPERLINK(\"http://evil\")");
    await seedIssue(pid, "Timeout talking to payments");

    const r = await admin.get(`/projects/${pid}/issues/export`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.headers["content-disposition"]).toMatch(/attachment; filename="issues-.*\.csv"/);
    const lines = r.body.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines[0]).toBe("id,title,culprit,level,status,events,users,first_seen,last_seen,first_release,assignee,url");
    expect(lines).toHaveLength(4);
    expect(r.body).toContain('"Bad ""quote"", comma"');
    expect(r.body).toContain(`"'=HYPERLINK(""http://evil"")"`);

    const s = await admin.get(`/projects/${pid}/issues/export?query=payments`);
    expect(s.body.trimEnd().split("\r\n")).toHaveLength(2);

    const budi = as(await login("budi@x.io"));
    expect((await budi.get(`/projects/${pid}/issues/export`)).statusCode).toBe(404);
  });
});

describe("hapus & retensi", () => {
  async function setup() {
    const admin = as(await login("admin@x.io"));
    const pid = (await admin.post("/projects", { name: "P" })).json().id as string;
    const budiUser = await prisma.user.findUniqueOrThrow({ where: { email: "budi@x.io" } });
    await prisma.member.create({ data: { projectId: pid, userId: budiUser.id, role: "member" } });
    const budi = as(await login("budi@x.io"));
    return { admin, budi, pid };
  }

  it("hanya admin yang bisa hapus issue; event & indeks pencarian ikut terhapus", async () => {
    const { admin, budi, pid } = await setup();
    const issue = await seedIssue(pid, "Unique searchable crash");
    raw.prepare("INSERT INTO events_fts (content, event_id, issue_id, project_id) SELECT 'Unique searchable crash', id, issue_id, project_id FROM events WHERE issue_id = ?").run(issue.id);

    expect((await budi.del(`/issues/${issue.id}`)).statusCode).toBe(404);
    expect((await admin.del(`/issues/${issue.id}`)).statusCode).toBe(204);
    expect(await prisma.issue.count({ where: { id: issue.id } })).toBe(0);
    expect(await prisma.event.count({ where: { issueId: issue.id } })).toBe(0);
    expect(raw.prepare("SELECT COUNT(*) FROM events_fts WHERE issue_id = ?").pluck().get(issue.id)).toBe(0);
  });

  it("hapus massal hanya menyentuh issue di project itu", async () => {
    const { admin, budi, pid } = await setup();
    const other = (await admin.post("/projects", { name: "Other" })).json().id as string;
    const a = await seedIssue(pid, "a");
    const b = await seedIssue(pid, "b");
    const foreign = await seedIssue(other, "x");
    expect((await budi.post(`/projects/${pid}/issues/delete`, { ids: [a.id] })).statusCode).toBe(404);
    const r = await admin.post(`/projects/${pid}/issues/delete`, { ids: [a.id, b.id, foreign.id] });
    expect(r.json()).toEqual({ deleted: 2 });
    expect(await prisma.issue.count({ where: { id: foreign.id } })).toBe(1);
  });

  it("pengaturan retensi: validasi & hanya admin", async () => {
    const { admin, budi, pid } = await setup();
    expect((await budi.patch(`/projects/${pid}/settings`, { retentionDays: 7 })).statusCode).toBe(404);
    expect((await admin.patch(`/projects/${pid}/settings`, { retentionDays: 0 })).statusCode).toBe(400);
    expect((await admin.patch(`/projects/${pid}/settings`, { retentionDays: 7, retentionMaxEvents: 500 })).statusCode).toBe(200);
    expect((await admin.get(`/projects/${pid}`)).json()).toMatchObject({ retentionDays: 7, retentionMaxEvents: 500, slowTraceMs: 1000 });
    expect((await budi.patch(`/projects/${pid}/settings`, { slowTraceMs: 2000 })).statusCode).toBe(404);
    for (const v of [49, 600_001, 1.5, "1000"]) expect((await admin.patch(`/projects/${pid}/settings`, { slowTraceMs: v })).statusCode).toBe(400);
    expect((await admin.patch(`/projects/${pid}/settings`, { slowTraceMs: 2500 })).statusCode).toBe(200);
    expect((await admin.get(`/projects/${pid}`)).json()).toMatchObject({ slowTraceMs: 2500, retentionDays: 7 });
    expect((await admin.patch(`/projects/${pid}/settings`, { slowTraceMs: null })).statusCode).toBe(200);
    expect((await admin.get(`/projects/${pid}`)).json()).toMatchObject({ slowTraceMs: null });
    const stats = (await admin.get(`/projects/${pid}/stats`)).json();
    expect(stats).toMatchObject({ events: 0, issues: 0 });
    expect(stats.dbSizeBytes).toBeGreaterThan(0);
  });

  it("retensi menghapus event lama & berlebih, lalu issue kosong", async () => {
    const { admin, pid } = await setup();
    await admin.patch(`/projects/${pid}/settings`, { retentionDays: 30, retentionMaxEvents: 100 });
    const now = Date.now();
    const old = await seedIssue(pid, "old", new Date(now - 40 * 86_400_000));
    await prisma.event.updateMany({ where: { issueId: old.id }, data: { receivedAt: new Date(now - 40 * 86_400_000) } });
    const busy = await seedIssue(pid, "busy");
    await prisma.event.createMany({
      data: Array.from({ length: 150 }, (_, i) => ({
        id: crypto.randomUUID(), projectId: pid, issueId: busy.id,
        receivedAt: new Date(now - (150 - i) * 1000), timestamp: new Date(now), payload: { n: i },
      })),
    });

    const r = await runRetention(raw, new Date(now));
    expect(await prisma.issue.count({ where: { id: old.id } })).toBe(0);
    expect(await prisma.event.count({ where: { projectId: pid } })).toBe(100);
    // Yang tersisa harus 100 event TERBARU.
    const kept = await prisma.event.findMany({ where: { projectId: pid }, orderBy: { receivedAt: "asc" }, take: 1 });
    expect(kept[0]!.receivedAt.getTime()).toBeGreaterThan(now - 101 * 1000);
    expect(r.issuesDeleted).toBe(1);
  });

  it("hapus project hanya admin global", async () => {
    const { admin, budi, pid } = await setup();
    await seedIssue(pid, "x");
    expect((await budi.del(`/projects/${pid}`)).statusCode).toBe(403);
    expect((await admin.del(`/projects/${pid}`)).statusCode).toBe(204);
    expect(await prisma.event.count({ where: { projectId: pid } })).toBe(0);
  });
});

describe("overview & sparklines", () => {
  const DAY = 86400_000;
  async function ev(projectId: string, issueId: string, at: Date, extra: { level?: "error" | "warning"; release?: string; environment?: string; userId?: string; os?: string } = {}) {
    const { os, ...cols } = extra;
    await prisma.event.create({
      data: { id: crypto.randomUUID(), projectId, issueId, timestamp: at, receivedAt: at, ...cols, payload: os ? { contexts: { os: { name: os } } } : {} },
    });
  }

  it("aggregates totals, series, levels, top issues and platforms with filters", async () => {
    const admin = as(await login("admin@x.io"));
    const pid = (await admin.post("/projects", { name: "P" })).json().id;
    const now = Date.now();
    const a = await prisma.issue.create({ data: { projectId: pid, fingerprint: "a", title: "A", firstSeen: new Date(now - 2 * DAY), lastSeen: new Date(now), eventCount: 3 } });
    const b = await prisma.issue.create({ data: { projectId: pid, fingerprint: "b", title: "B", level: "warning", firstSeen: new Date(now - 20 * DAY), lastSeen: new Date(now), eventCount: 2 } });
    await ev(pid, a.id, new Date(now - 2 * DAY), { userId: "u1", release: "1.0", environment: "production", os: "Android" });
    await ev(pid, a.id, new Date(now - 1 * DAY), { userId: "u2", release: "1.1", environment: "production", os: "Android" });
    await ev(pid, a.id, new Date(now - 60_000), { userId: "u1", release: "1.1", environment: "staging", os: "iOS" });
    await ev(pid, b.id, new Date(now - 3 * DAY), { level: "warning", release: "1.0", environment: "production", os: "iOS" });
    await ev(pid, b.id, new Date(now - 20 * DAY), { level: "warning", release: "1.0" }); // periode sebelumnya

    const o = (await admin.get(`/projects/${pid}/overview?range=14d`)).json();
    expect(o.totals).toMatchObject({ events: 4, users: 2, newIssues: 1, previous: { events: 1, newIssues: 1 } });
    expect(o.series).toHaveLength(15);
    expect(o.series.reduce((s: number, x: { events: number }) => s + x.events, 0)).toBe(4);
    expect(o.levels).toEqual([{ level: "error", events: 3 }, { level: "warning", events: 1 }]);
    expect(o.topIssues[0]).toMatchObject({ id: a.id, events: 3, users: 2 });
    expect(o.platforms).toHaveLength(2);
    expect(o.platforms).toEqual(expect.arrayContaining([{ name: "Android", events: 2 }, { name: "iOS", events: 2 }]));
    expect(o.releases).toEqual(expect.arrayContaining(["1.0", "1.1"]));
    expect(o.environments).toEqual(expect.arrayContaining(["production", "staging"]));

    const f = (await admin.get(`/projects/${pid}/overview?range=14d&environment=production&level=error`)).json();
    expect(f.totals.events).toBe(2);
    // Pembagian level tetap menampilkan semua level walau filter level aktif.
    expect(f.levels).toEqual([{ level: "error", events: 2 }, { level: "warning", events: 1 }]);

    // Filter platform: angka ikut terfilter, daftar platform tetap lengkap; export ikut filter.
    const ios = (await admin.get(`/projects/${pid}/overview?range=14d&platform=iOS`)).json();
    expect(ios.totals.events).toBe(2);
    expect(ios.platforms).toHaveLength(2);
    const iosCsv = await admin.get(`/projects/${pid}/overview/export?range=14d&platform=iOS`);
    expect(iosCsv.body.trimEnd().split("\r\n")).toHaveLength(3);

    const csv = await admin.get(`/projects/${pid}/overview/export?range=14d&level=error`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-disposition"]).toMatch(/overview-14d-.*\.csv/);
    const lines = csv.body.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
    expect(lines[0]).toContain("events_in_period");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`${a.id},A,`);
    expect(lines[1]).toContain(",3,2,");
    expect((await as(await login("budi@x.io")).get(`/projects/${pid}/overview/export`)).statusCode).toBe(404);
    const h = (await admin.get(`/projects/${pid}/overview?range=24h`)).json();
    expect(h.bucket).toBe("hour");
    expect(h.totals.events).toBe(1);
    expect(h.series.length).toBeGreaterThanOrEqual(24);
    expect((await admin.get(`/projects/${pid}/overview?range=1y`)).statusCode).toBe(400);

    const budi = as(await login("budi@x.io"));
    expect((await budi.get(`/projects/${pid}/overview`)).statusCode).toBe(404);

    const list = (await admin.get(`/projects/${pid}/issues`)).json();
    const spark = list.issues.find((i: { id: string }) => i.id === a.id).spark;
    expect(spark).toHaveLength(14);
    expect(spark.reduce((s: number, x: number) => s + x, 0)).toBe(3);
    expect(spark[13]).toBeGreaterThanOrEqual(1);
  });
});

describe("filter event: pencarian & status HTTP", () => {
  // Satu issue (fingerprint sama) dengan event dari beberapa user & status, seperti HttpError dari mobile.
  async function setup() {
    const admin = as(await login("admin@x.io"));
    const pid = (await admin.post("/projects", { name: "P" })).json().id as string;
    const issue = await prisma.issue.create({
      data: { projectId: pid, fingerprint: "http", title: "HttpError: PATCH /attendance — 409 · NRK 201221244", firstSeen: new Date(), lastSeen: new Date(), eventCount: 4 },
    });
    const ev = (user: string, status: string, ago: number) => ({ user, status, at: new Date(Date.now() - ago * 60_000) });
    for (const e of [ev("201221244", "409", 1), ev("2608110061", "409", 2), ev("201221244", "502", 3), ev("492283770", "500", 4)]) {
      const id = crypto.randomUUID();
      await prisma.event.create({
        data: { id, projectId: pid, issueId: issue.id, timestamp: e.at, receivedAt: e.at, userId: e.user,
          payload: { message: `PATCH failed NRK ${e.user}`, tags: { status: e.status, method: "PATCH", route: "/attendance" }, contexts: { os: { name: "Android", version: "16" } } } },
      });
      raw.prepare("INSERT INTO events_fts (content, event_id, issue_id, project_id) VALUES (?, ?, ?, ?)").run(`PATCH failed NRK ${e.user}`, id, issue.id, pid);
    }
    return { admin, pid, issue };
  }

  it("detail issue & daftar event hanya berisi event yang cocok dengan ?q=", async () => {
    const { admin, issue } = await setup();
    const d = (await admin.get(`/issues/${issue.id}?q=201221244`)).json();
    expect(d.matchCount).toBe(2);
    expect(d.userCount).toBe(1);
    expect(d.latestEvent.userId).toBe("201221244");
    expect((await admin.get(`/issues/${issue.id}`)).json().matchCount).toBeNull();

    const page = (await admin.get(`/issues/${issue.id}/events?q=201221244&size=25`)).json();
    expect(page.total).toBe(2);
    expect(page.events.every((e: { userId: string }) => e.userId === "201221244")).toBe(true);
    expect(page.events.map((e: { httpStatus: number }) => e.httpStatus)).toEqual([409, 502]);

    const users = (await admin.get(`/issues/${issue.id}/users?q=201221244`)).json();
    expect(users.map((u: { userId: string }) => u.userId)).toEqual(["201221244"]);
  });

  it("pagination bernomor pada daftar event", async () => {
    const { admin, issue } = await setup();
    const all = (await admin.get(`/issues/${issue.id}/events?size=25`)).json();
    expect(all.total).toBe(4);
    expect((await admin.get(`/issues/${issue.id}/events?size=25&page=2`)).json().events).toHaveLength(0);
    expect((await admin.get(`/issues/${issue.id}/events?size=25&page=1000`)).statusCode).toBe(400);
  });

  it("filter ?http= di issues, detail, overview; jumlah per status", async () => {
    const { admin, pid, issue } = await setup();
    await seedIssue(pid, "no status");
    const list = (await admin.get(`/projects/${pid}/issues?http=5xx`)).json();
    expect(list.issues.map((i: { id: string }) => i.id)).toEqual([issue.id]);
    expect((await admin.get(`/projects/${pid}/issues?http=abc`)).statusCode).toBe(400);
    expect((await admin.get(`/issues/${issue.id}?http=409`)).json().matchCount).toBe(2);

    const counts = (await admin.get(`/projects/${pid}/issues/http-statuses`)).json().statusCounts;
    expect(counts.sort((a: { code: number }, b: { code: number }) => a.code - b.code)).toEqual([
      { code: 409, count: 2 }, { code: 500, count: 1 }, { code: 502, count: 1 },
    ]);
    const ov = (await admin.get(`/projects/${pid}/overview?http=502`)).json();
    expect(ov.totals.events).toBe(1);
    expect(ov.statusCounts).toHaveLength(3);
  });

  it("ekspor per event ikut pencarian & status", async () => {
    const { admin, pid } = await setup();
    const csv = (await admin.get(`/projects/${pid}/issues/events-export?status=all&query=201221244`)).body;
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toContain("event_id,received_at,issue_id,issue_title,level,http_status,method,route,user_id");
    expect(lines).toHaveLength(3);
    expect(lines.slice(1).every((l) => l.includes(",201221244,"))).toBe(true);
    expect(lines[1]).toContain("Android 16");

    const ov = (await admin.get(`/projects/${pid}/overview/events-export?http=500`)).body.trim().split("\r\n");
    expect(ov).toHaveLength(2);
    expect(ov[1]).toContain(",500,PATCH,/attendance,492283770,");
  });
});
