import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./auth/password.js";
import { keyCache } from "./ingest/key-cache.js";
import { RollupAggregator } from "./otlp/rollups.js";
import { LITE_TOP_ERRORS_SCAN, SqliteTelemetryStore } from "./otlp/telemetry-store.js";
import { IngestStore } from "./process/store.js";
import { foldRollups } from "./process/retention.js";
import { Alerter, type DiscordMessage } from "./process/alerts.js";

// API Health: POST /otlp/v1/traces -> rollup per endpoint di endpoint_rollups.
const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL not set (run via `pnpm test:int`)");

const prisma = createPrisma(url);
const raw = openRaw(sqlitePath(url));
const queue = new IngestStore(raw, { maxBacklog: 1000, batchSize: 50 });
const telemetry = new SqliteTelemetryStore(raw);
const rollups = new RollupAggregator(raw); // tidak di-start: test memanggil flush() sendiri
// Jam yang disuntik ke route API Health: null = waktu nyata; diisi agar bucket menit/jam deterministik.
let clock: number | null = null;
const NOW = Date.UTC(2026, 9, 10, 12, 30, 30); // tengah menit & tengah jam
const CUR = Math.floor(NOW / 60_000) * 60; // bucket menit berjalan (detik)
const HOOK = "https://discord.com/api/webhooks/123456/abcDEF_ghi-123";
let sent: { url: string; msg: DiscordMessage }[] = [];
const alerter = new Alerter(raw, {
  webUrl: "https://bugs.example.com",
  send: async (u, msg) => {
    sent.push({ url: u, msg });
    return { ok: true, status: 204 };
  },
});
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;
const KEY = "fedcba9876543210fedcba9876543210";

const post = (body: unknown, headers: Record<string, string> = { "x-bugtrail-key": KEY }) =>
  app.inject({ method: "POST", url: "/otlp/v1/traces", payload: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

let seq = 0;
const serverSpan = (route: string, status: number, ms: number) => ({
  traceId: (++seq).toString(16).padStart(32, "1"), spanId: seq.toString(16).padStart(16, "2"),
  name: `GET ${route}`, kind: 2, startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: String(1700000000000000000n + BigInt(ms) * 1_000_000n), status: {},
  attributes: [
    { key: "http.request.method", value: { stringValue: "GET" } },
    { key: "http.route", value: { stringValue: route } },
    { key: "http.response.status_code", value: { intValue: String(status) } },
  ],
});
const body = (spans: object[]) => ({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans }] }] });

beforeAll(async () => {
  await tunePrisma(prisma);
  queue.start();
  app = await buildApp({ prisma, store: queue, telemetry, rollups, now: () => clock ?? Date.now() });
});

beforeEach(async () => {
  await queue.drain();
  rollups.flush(); // buang sisa akumulasi test sebelumnya
  keyCache.clear();
  sent = [];
  await prisma.organization.deleteMany(); // cascade ke project, termasuk endpoint_rollups (FK ON DELETE CASCADE)
  const org = await prisma.organization.create({ data: { name: "T", slug: "t" } });
  const p = await prisma.project.create({ data: { organizationId: org.id, name: "T", slug: "t" } });
  await prisma.dsnKey.create({ data: { projectId: p.id, publicKey: KEY } });
  projectId = p.id;
  await prisma.user.deleteMany();
  const passwordHash = await hashPassword(PW);
  const ani = await prisma.user.create({ data: { username: "ani", email: "ani@x.io", passwordHash } });
  await prisma.user.create({ data: { username: "budi", email: "budi@x.io", passwordHash } }); // tanpa membership
  await prisma.member.create({ data: { projectId, userId: ani.id, role: "viewer" } });
});

const PW = "password-123";
async function login(email: string) {
  const r = await app.inject({ method: "POST", url: "/api/0/auth/login", payload: { email, password: PW } });
  expect(r.statusCode).toBe(200);
  const c = r.cookies.find((c) => c.name === "bt_session")!;
  return `${c.name}=${c.value}`;
}

afterAll(async () => {
  await app?.close();
  await queue.stop();
  await prisma.$disconnect();
});

describe("API Health rollups", () => {
  it("counts every server request, including successful ones, in Lite mode", async () => {
    const r = await post(body([serverSpan("/users/:id", 200, 3), serverSpan("/users/:id", 503, 40)]));
    expect(r.statusCode).toBe(200);
    rollups.flush();
    const row = raw.prepare("SELECT count, c2xx, c5xx FROM endpoint_rollups WHERE project_id = ?").get(projectId);
    expect(row).toEqual({ count: 2, c2xx: 1, c5xx: 1 });
  });

  it("does not count a request answered 429 (exporter will retry it)", async () => {
    // Antrian dengan maxBacklog 0: enqueue job error selalu ditolak BacklogFullError -> 429.
    const full = new IngestStore(raw, { maxBacklog: 0, batchSize: 50 });
    const busy = await buildApp({ prisma, store: full, telemetry, rollups });
    try {
      const s = { ...serverSpan("/boom", 500, 5), events: [{ name: "exception", timeUnixNano: "1700000000000000000",
        attributes: [{ key: "exception.type", value: { stringValue: "Error" } }, { key: "exception.message", value: { stringValue: "boom" } }] }] };
      const r = await busy.inject({ method: "POST", url: "/otlp/v1/traces", payload: JSON.stringify(body([s])),
        headers: { "content-type": "application/json", "x-bugtrail-key": KEY } });
      expect(r.statusCode).toBe(429);
      rollups.flush();
      expect(raw.prepare("SELECT count(*) FROM endpoint_rollups WHERE project_id = ?").pluck().get(projectId)).toBe(0);
    } finally {
      await busy.close();
    }
  });

  it("folds minute rows older than 2h into hour rows and expires old rows", () => {
    const now = new Date(Date.UTC(2026, 9, 5, 12, 0));
    const min = (h: number, m: number) => Date.UTC(2026, 9, 5, h, m) / 1000;
    const ins = raw.prepare(`INSERT INTO endpoint_rollups (project_id, granularity, bucket, method, route, count, c5xx, dur_max_us, h0)
      VALUES (?, ?, ?, 'GET', '/a', ?, ?, ?, ?)`);
    ins.run(projectId, "m", min(9, 1), 3, 1, 100, 3);
    ins.run(projectId, "m", min(9, 59), 2, 0, 900, 2);
    ins.run(projectId, "m", min(11, 30), 5, 0, 10, 5); // < 2 jam: tetap per menit
    ins.run(projectId, "h", Date.UTC(2026, 6, 1) / 1000, 1, 0, 1, 1); // > 90 hari: dihapus
    foldRollups(raw, now);
    const rows = raw.prepare("SELECT granularity g, bucket, count, c5xx, dur_max_us mx, h0 FROM endpoint_rollups WHERE project_id = ? ORDER BY g, bucket").all(projectId);
    expect(rows).toEqual([
      { g: "h", bucket: Date.UTC(2026, 9, 5, 9) / 1000, count: 5, c5xx: 1, mx: 900, h0: 5 },
      { g: "m", bucket: min(11, 30), count: 5, c5xx: 0, mx: 10, h0: 5 },
    ]);
    foldRollups(raw, now); // idempoten
    expect(raw.prepare("SELECT SUM(count) FROM endpoint_rollups WHERE granularity = 'h'").pluck().get()).toBe(5);
  });
});

describe("API Health dashboard", () => {
  const ins = (b: number) => raw.prepare(`INSERT INTO endpoint_rollups (project_id, granularity, bucket, method, route, count, c2xx, c5xx, h2, h6)
    VALUES (?, 'm', ?, 'GET', '/a', 20, 18, 2, 18, 2)`).run(projectId, b);
  beforeEach(() => { clock = NOW; });
  afterEach(() => { clock = null; });

  it("returns endpoints with error rate and p95 for members", async () => {
    // 18x 200 di <=25ms, 2x 500 di <=500ms pada menit berjalan
    const b = CUR;
    ins(b);
    const cookie = await login("ani@x.io");
    const res = await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/health?range=1h`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ range: "1h", bucketSeconds: 60, threshold: { pct: 5, minRequests: 20 } });
    const e = res.json().endpoints[0];
    expect(e).toMatchObject({ method: "GET", route: "/a", count: 20, c5xx: 2, errorRate: 0.1, p50: 25, p95: 500 });
    expect(e.series).toHaveLength(60);
    expect(e.series[59]).toBe(20); // menit berjalan ada di slot terakhir
    expect(e.errSeries).toHaveLength(60);
    expect(e.errSeries[59]).toBe(2);
    expect(e.breaches).toBe(1); // 10% >= 5% dengan 20 request
  });

  it("returns the project's 5xx alert rule threshold to members when set", async () => {
    raw.prepare(`INSERT INTO alert_rules (id, project_id, name, kind, status_filter, mode, threshold, window_minutes, min_requests)
      VALUES ('r1', ?, '5xx rate', 'status', '5xx', 'pct', 12.5, 5, 50)`).run(projectId);
    ins(CUR); // 20 request, 10% 5xx
    const cookie = await login("ani@x.io");
    const res = await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/health?range=1h`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().threshold).toEqual({ pct: 12.5, minRequests: 50 });
    expect(res.json().endpoints[0].breaches).toBe(0); // di bawah 12.5% dan < 50 request
    raw.prepare("DELETE FROM alert_rules WHERE id = 'r1'").run();
  });

  it("includes unfolded minute rows in hour ranges", async () => {
    ins(CUR);
    const cookie = await login("ani@x.io");
    const res = await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/health?range=24h`, headers: { cookie } });
    const e = res.json().endpoints[0];
    expect(e.series).toHaveLength(24);
    expect(e.series[23]).toBe(20);
  });

  it("7d range: 168 hour slots, merges hour and unfolded minute rows, reports c4xx", async () => {
    const put = raw.prepare(`INSERT INTO endpoint_rollups (project_id, granularity, bucket, method, route, count, c2xx, c4xx, c5xx, h2)
      VALUES (?, ?, ?, 'GET', '/a', ?, 0, ?, ?, ?)`);
    const H = 3600;
    const curH = Math.floor(NOW / 1000 / H) * H; // jam berjalan
    const first = curH - 167 * H; // slot 0
    put.run(projectId, "h", first - H, 99, 0, 0, 99); // di luar rentang: diabaikan
    put.run(projectId, "h", first, 10, 3, 1, 10);
    put.run(projectId, "h", curH - 2 * H, 7, 2, 0, 7); // sudah digabung
    put.run(projectId, "m", curH - 2 * H + 59 * 60, 1, 0, 1, 1); // menit belum digabung, jam yang sama
    put.run(projectId, "m", curH + 5 * 60, 4, 1, 0, 4);
    put.run(projectId, "m", CUR, 6, 0, 2, 6);
    const cookie = await login("ani@x.io");
    const res = await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/health?range=7d`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().bucketSeconds).toBe(H);
    const e = res.json().endpoints[0];
    expect(e).toMatchObject({ count: 28, c4xx: 6, c5xx: 4 });
    expect(e.series).toHaveLength(168);
    expect(e.series[0]).toBe(10);
    expect(e.series[165]).toBe(8); // jam + menit digabung
    expect(e.series[167]).toBe(10); // dua menit di jam berjalan
    expect(e.errSeries[167]).toBe(2);
    const ep = await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/health/endpoint?method=GET&route=%2Fa&range=7d`, headers: { cookie } });
    const { series } = ep.json();
    expect(series).toHaveLength(168);
    expect(series[0]).toMatchObject({ t: first, count: 10, c4xx: 3, c5xx: 1 });
    expect(series[165]).toMatchObject({ t: curH - 2 * H, count: 8, c4xx: 2, c5xx: 1 });
    expect(series[167]).toMatchObject({ t: curH, count: 10, c4xx: 1, c5xx: 2 });
  });

  it("returns a zero-filled series for one endpoint", async () => {
    const b = CUR;
    ins(b);
    const cookie = await login("ani@x.io");
    const res = await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/health/endpoint?method=GET&route=%2Fa&range=1h`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { bucketSeconds, series } = res.json();
    expect(bucketSeconds).toBe(60);
    expect(series).toHaveLength(60);
    expect(series[59]).toMatchObject({ t: b, count: 20, c5xx: 2, p50: 25, p95: 500 });
    expect(series[0]).toMatchObject({ count: 0, p50: null, p95: null, p99: null });
  });

  it("404s for a user without access", async () => {
    ins(CUR);
    const cookie = await login("budi@x.io");
    for (const u of [`/health?range=1h`, `/health/endpoint?method=GET&route=%2Fa`]) {
      const res = await app.inject({ method: "GET", url: `/api/0/projects/${projectId}${u}`, headers: { cookie } });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("API Health individual requests", () => {
  // Span server langsung ke trace_spans (mode Lite: hanya trace tersampel/berisi error).
  let n = 0;
  const span = (o: { secAgo: number; status?: number | string; route?: string | null; method?: string; kind?: number; name?: string; ms?: number }) => {
    n++;
    const attributes: Record<string, unknown> = { "http.request.method": o.method ?? "GET" };
    if (o.route !== null) attributes["http.route"] = o.route ?? "/a";
    if (o.status !== undefined) attributes["http.response.status_code"] = o.status;
    return {
      projectId, traceId: n.toString(16).padStart(32, "a"), spanId: n.toString(16).padStart(16, "b"),
      name: o.name ?? "GET /a", kind: o.kind ?? 2, startUs: (Math.floor(Date.now() / 1000) - o.secAgo) * 1_000_000,
      durationUs: (o.ms ?? 10) * 1000, statusCode: 0, attributes, events: [], resource: { "service.name": "svc" }, service: "svc",
    };
  };
  const get = (cookie: string, qs: string) =>
    app.inject({ method: "GET", url: `/api/0/projects/${projectId}/health/requests?${qs}`, headers: { cookie } });

  it("store lists matching server spans newest first with status filter, route fallback and paging", () => {
    telemetry.writeSpans([
      span({ secAgo: 30, status: 500 }),
      span({ secAgo: 20, status: "503" }), // status sebagai teks
      span({ secAgo: 10, status: 404 }),
      span({ secAgo: 5, status: 200 }),
      span({ secAgo: 15, status: 500, kind: 3 }), // bukan span server
      span({ secAgo: 25, status: 500, route: "/b" }),
      span({ secAgo: 12, status: 502, route: null, name: "/a" }), // tanpa http.route: pakai nama span
      span({ secAgo: 7200, status: 500 }), // di luar jendela
    ]);
    const now = Date.now() * 1000;
    const q = { method: "GET", route: "/a", fromUs: now - 3600e6, toUs: now + 1e6, status: "5xx" as const, limit: 50 };
    const r5 = telemetry.listRequests(projectId, q);
    expect(r5.map((r) => r.status)).toEqual([502, 503, 500]);
    expect(r5[0]).toMatchObject({ method: "GET", route: "/a", service: "svc", durationUs: 10_000 });
    expect(telemetry.listRequests(projectId, { ...q, status: "4xx" }).map((r) => r.status)).toEqual([404]);
    expect(telemetry.listRequests(projectId, { ...q, status: "all" }).map((r) => r.status)).toEqual([200, 404, 502, 503, 500]);
    const p1 = telemetry.listRequests(projectId, { ...q, limit: 2 });
    expect(p1.map((r) => r.status)).toEqual([502, 503]);
    expect(telemetry.listRequests(projectId, { ...q, limit: 2, beforeUs: p1[1]!.startUs }).map((r) => r.status)).toEqual([500]);
    expect(telemetry.listRequests("other", q)).toEqual([]);
  });

  it("pages through spans sharing the same start time without losing or repeating any", async () => {
    const same = [span({ secAgo: 10, status: 500 }), span({ secAgo: 10, status: 500 }), span({ secAgo: 10, status: 500 })];
    telemetry.writeSpans(same);
    const cookie = await login("ani@x.io");
    const a = (await get(cookie, "method=GET&route=%2Fa&range=1h&limit=2")).json();
    expect(a.requests).toHaveLength(2);
    const b = (await get(cookie, `method=GET&route=%2Fa&range=1h&limit=2&before=${a.nextBefore}`)).json();
    expect(b).toMatchObject({ nextBefore: null });
    const ids = [...a.requests, ...b.requests].map((r: { spanId: string }) => r.spanId);
    expect(new Set(ids).size).toBe(3);
    expect(ids.sort()).toEqual(same.map((s) => s.spanId).sort());
    expect((await get(cookie, "method=GET&route=%2Fa&before=123")).statusCode).toBe(400);
  });

  it("flags slow successful requests", async () => {
    telemetry.writeSpans([span({ secAgo: 30, status: 200, ms: 1500 }), span({ secAgo: 20, status: 500, ms: 1500 }), span({ secAgo: 10, status: 200, ms: 20 })]);
    const cookie = await login("ani@x.io");
    const b = (await get(cookie, "method=GET&route=%2Fa&range=1h&status=all")).json();
    expect(b.requests.map((r: { status: number; slow: boolean }) => [r.status, r.slow])).toEqual([[200, false], [500, false], [200, true]]);
  });

  it("serves the requests route with sampled flag, paging and validation", async () => {
    telemetry.writeSpans([span({ secAgo: 30, status: 500 }), span({ secAgo: 20, status: 500 }), span({ secAgo: 10, status: 404 })]);
    const cookie = await login("ani@x.io");
    let res = await get(cookie, "method=GET&route=%2Fa&range=1h&limit=1");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sampled).toBe(true);
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].status).toBe(500);
    expect(body.nextBefore).toBe(`${body.requests[0].startUs}:${body.requests[0].spanId}`);
    res = await get(cookie, `method=GET&route=%2Fa&range=1h&limit=1&before=${body.nextBefore}`);
    expect(res.json().requests).toHaveLength(1);
    res = await get(cookie, `method=GET&route=%2Fa&range=1h&before=${res.json().nextBefore}`);
    expect(res.json()).toMatchObject({ requests: [], nextBefore: null });
    // default status 5xx; status=all ikut 404
    expect((await get(cookie, "method=GET&route=%2Fa&range=1h")).json().requests).toHaveLength(2);
    expect((await get(cookie, "method=GET&route=%2Fa&range=1h&status=all")).json()).toMatchObject({ nextBefore: null });
    expect((await get(cookie, "method=GET&route=%2Fa&range=1h&status=all")).json().requests).toHaveLength(3);
    // from/to (detik) mempersempit jendela
    const s = Math.floor(Date.now() / 1000);
    expect((await get(cookie, `method=GET&route=%2Fa&range=1h&from=${s - 25}&to=${s}`)).json().requests).toHaveLength(1);
    for (const bad of ["route=%2Fa", "method=GET", "method=GET&route=%2Fa&status=6xx", "method=GET&route=%2Fa&status=error", "method=GET&route=%2Fa&limit=201",
      `method=GET&route=%2Fa&from=${s}&to=${s - 10}`, "method=GET&route=%2Fa&range=2d"]) {
      expect((await get(cookie, bad)).statusCode, bad).toBe(400);
    }
    expect((await get(await login("budi@x.io"), "method=GET&route=%2Fa")).statusCode).toBe(404);
  });

  it("pages by number with total, size, offset cap and Lite observed count from rollups", async () => {
    const spans = Array.from({ length: 30 }, (_, i) => span({ secAgo: 100 + i, status: i % 3 === 0 ? 404 : 500 }));
    telemetry.writeSpans(spans);
    telemetry.writeSpans(spans.slice(0, 5)); // kirim ulang: tidak boleh terhitung dua kali
    const b = Math.floor(Date.now() / 60_000) * 60 - 120;
    raw.prepare(`INSERT INTO endpoint_rollups (project_id, granularity, bucket, method, route, count, c4xx, c5xx)
      VALUES (?, 'm', ?, 'GET', '/a', 1000, 300, 600)`).run(projectId, b);
    const cookie = await login("ani@x.io");
    const p1 = (await get(cookie, "method=GET&route=%2Fa&range=1h&page=1&size=25")).json();
    expect(p1).toMatchObject({ total: 20, page: 1, size: 25, sampled: true, observed: 600 });
    expect(p1.requests).toHaveLength(20);
    expect(p1.topErrors).not.toBeNull();
    const all = (await get(cookie, "method=GET&route=%2Fa&range=1h&status=all&page=2&size=25")).json();
    expect(all).toMatchObject({ total: 30, page: 2, size: 25, observed: 1000 });
    expect(all.requests).toHaveLength(5);
    const first = (await get(cookie, "method=GET&route=%2Fa&range=1h&status=all&size=25&page=1")).json();
    // topErrors sama di setiap halaman (deep link ke halaman 2 tetap menampilkannya).
    expect(all.topErrors).toEqual(first.topErrors);
    const ids = new Set([...first.requests, ...all.requests].map((r: { spanId: string }) => r.spanId));
    expect(ids.size).toBe(30);
    expect((await get(cookie, "method=GET&route=%2Fa&range=1h&status=4xx")).json()).toMatchObject({ total: 10, page: 1, size: 50, observed: 300 });
    // page tanpa size: default 50; offset 9.950 masih boleh, 10.000 ditolak dengan pesan jelas
    expect((await get(cookie, "method=GET&route=%2Fa&range=1h&page=200")).json()).toMatchObject({ requests: [], total: 20, page: 200, size: 50 });
    const cap = await get(cookie, "method=GET&route=%2Fa&range=1h&page=201");
    expect(cap.statusCode).toBe(400);
    expect(cap.json().detail).toBe("Narrow the time range or filters to see older results");
    expect((await get(cookie, "method=GET&route=%2Fa&page=101&size=100")).statusCode).toBe(400);
    for (const bad of ["page=0", "page=1&size=30", "page=x", `page=1&before=1:${"b".repeat(16)}`]) {
      expect((await get(cookie, `method=GET&route=%2Fa&${bad}`)).statusCode, bad).toBe(400);
    }
  });

  it("filters requests by status codes and ranges, with statusCounts ignoring the status filter", async () => {
    telemetry.writeSpans([
      span({ secAgo: 10, status: 500 }), span({ secAgo: 11, status: 500 }), span({ secAgo: 12, status: "502" }),
      span({ secAgo: 13, status: 404 }), span({ secAgo: 14, status: 201 }), span({ secAgo: 15, status: 524 }),
      span({ secAgo: 16, status: 500, route: "/b" }), // endpoint lain: tidak dihitung
    ]);
    const cookie = await login("ani@x.io");
    const st = async (s: string) => (await get(cookie, `method=GET&route=%2Fa&range=1h&page=1&status=${s}`)).json();
    const codes = (b: { requests: { status: number }[] }) => b.requests.map((r) => r.status).sort();
    const multi = await st("500,502");
    expect(codes(multi)).toEqual([500, 500, 502]);
    expect(multi.total).toBe(3);
    expect(multi.observed).toBeUndefined(); // rollup tidak bisa menghitung kode persis
    const counts = [{ code: 201, count: 1 }, { code: 404, count: 1 }, { code: 500, count: 2 }, { code: 502, count: 1 }, { code: 524, count: 1 }];
    const sorted = (x: { code: number }[]) => [...x].sort((p, q) => p.code - q.code);
    expect(sorted(multi.statusCounts)).toEqual(counts);
    expect(codes(await st("520-529"))).toEqual([524]);
    expect(codes(await st("2xx,404"))).toEqual([201, 404]);
    expect(codes(await st("all"))).toHaveLength(6);
    expect(sorted((await st("404")).statusCounts)).toEqual(counts);
    for (const bad of ["600", "99", "529-520", "5xx,abc", Array(21).fill("500").join(","), "error"]) {
      expect((await get(cookie, `method=GET&route=%2Fa&status=${bad}`)).statusCode, bad).toBe(400);
    }
  });

  it("filters traces by status codes, keeps error semantics and returns statusCounts", async () => {
    const err = { ...span({ secAgo: 5 }), statusCode: 2 }; // error tanpa status HTTP
    telemetry.writeSpans([span({ secAgo: 10, status: 500 }), span({ secAgo: 11, status: 503 }), span({ secAgo: 12, status: 404 }), span({ secAgo: 13, status: 200 }), err]);
    const cookie = await login("ani@x.io");
    const t = async (qs: string) => app.inject({ method: "GET", url: `/api/0/projects/${projectId}/traces?range=1h&page=1&${qs}`, headers: { cookie } });
    const http = async (qs: string) => (await t(qs)).json().traces.map((x: { httpStatus?: number }) => x.httpStatus ?? 0).sort();
    expect(await http("status=500,404")).toEqual([404, 500]);
    expect(await http("status=501-599")).toEqual([503]);
    expect(await http("status=error")).toEqual([0, 500, 503]);
    expect(await http("status=error,404")).toEqual([0, 404, 500, 503]);
    expect(await http("status=5xx")).toEqual([500, 503]);
    const b = (await t("status=404")).json();
    expect(b.total).toBe(1);
    expect([...b.statusCounts].sort((p: { code: number }, q: { code: number }) => p.code - q.code))
      .toEqual([{ code: 200, count: 1 }, { code: 404, count: 1 }, { code: 500, count: 1 }, { code: 503, count: 1 }]);
    for (const bad of ["status=600", "status=foo", "status=1000"]) expect((await t(bad)).statusCode, bad).toBe(400);
  });

  it("pages the traces search by number with total and the same cap", async () => {
    telemetry.writeSpans(Array.from({ length: 7 }, (_, i) => span({ secAgo: 10 + i, status: 500 })));
    const cookie = await login("ani@x.io");
    const t = (qs: string) => app.inject({ method: "GET", url: `/api/0/projects/${projectId}/traces?${qs}`, headers: { cookie } });
    const a = (await t("range=1h&page=1&size=25")).json();
    expect(a).toMatchObject({ total: 7, page: 1, size: 25, sampled: true });
    expect(a.traces).toHaveLength(7);
    expect((await t("range=1h&page=2&size=25")).json()).toMatchObject({ traces: [], total: 7, page: 2 });
    expect((await t("range=1h&status=4xx")).json()).toMatchObject({ total: 0, page: 1, size: 50 });
    // kursor lama tetap jalan
    const c = (await t("range=1h&limit=4")).json();
    expect(c.traces).toHaveLength(4);
    expect((await t(`range=1h&limit=4&before=${c.nextBefore}`)).json().traces).toHaveLength(3);
    const cap = await t("range=1h&page=401&size=25");
    expect(cap.statusCode).toBe(400);
    expect(cap.json().detail).toBe("Narrow the time range or filters to see older results");
    expect((await t("range=1h&page=400&size=25")).statusCode).toBe(200);
    expect((await t("range=1h&size=10")).statusCode).toBe(400);
  });

  it("finds why each request failed: earliest exception across spans, else server status message", async () => {
    const ex = (t: number, type: string, message: string) => ({ name: "exception", timeUs: t, attributes: { "exception.type": type, "exception.message": message, "exception.stacktrace": "at x\n".repeat(3000) } });
    const a = span({ secAgo: 40, status: 500, route: "/err" }); // exception di span anak (dua event, ambil yang paling awal)
    const childA = { ...a, spanId: "c".repeat(16), parentSpanId: a.spanId, kind: 3, name: "SELECT coupons", startUs: a.startUs + 100,
      events: [ex(a.startUs + 900, "Late", "later"), ex(a.startUs + 500, "DbError", "x".repeat(3000))] };
    const b = { ...span({ secAgo: 30, status: 500, route: "/err" }), statusMessage: "upstream timeout" }; // hanya status message
    const c = span({ secAgo: 20, status: 500, route: "/err" }); // tidak ada info
    const d = span({ secAgo: 10, status: 500, route: "/err" }); // exception sama dengan a, di span server
    d.events = [ex(d.startUs + 1, "DbError", "x".repeat(3000))] as never;
    telemetry.writeSpans([a, childA, b, c, d]);
    const m = telemetry.traceErrors(projectId, [a.traceId, b.traceId, c.traceId]);
    expect(m.get(a.traceId)).toMatchObject({ type: "DbError", spanName: "SELECT coupons" });
    expect(m.get(a.traceId)!.message).toHaveLength(1024);
    expect(m.get(a.traceId)!.stacktrace).toHaveLength(8192);
    expect(m.get(b.traceId)).toEqual({ message: "upstream timeout", spanName: "GET /a" });
    expect(m.has(c.traceId)).toBe(false);

    const cookie = await login("ani@x.io");
    const body = (await get(cookie, "method=GET&route=%2Ferr&range=1h")).json();
    expect(body.requests.map((r: { error: { type?: string; message?: string } | null }) => r.error && (r.error.type ?? r.error.message))).toEqual(["DbError", null, "upstream timeout", "DbError"]);
    expect(body.topErrors).toEqual([{ type: "DbError", message: "x".repeat(1024), count: 2 }, { message: "upstream timeout", count: 1 }]);
    // Lite: top errors hanya dari N request terbaru (d, c) -> b dan a tidak terhitung.
    const nowUs = Date.now() * 1000;
    const f = { method: "GET", route: "/err", status: "5xx" as const, fromUs: nowUs - 3600e6, toUs: nowUs + 1 };
    expect(telemetry.topErrors(projectId, f, 2)).toEqual([{ type: "DbError", message: "x".repeat(1024), count: 1 }]);
    expect(LITE_TOP_ERRORS_SCAN).toBe(2000);
    const p2 = (await get(cookie, "method=GET&route=%2Ferr&range=1h&limit=1")).json();
    expect((await get(cookie, `method=GET&route=%2Ferr&range=1h&before=${p2.nextBefore}`)).json().topErrors).toEqual(p2.topErrors);
  });

  it("serves a project trace with the issue trace shape", async () => {
    const sp = span({ secAgo: 10, status: 500 });
    telemetry.writeSpans([sp]);
    const cookie = await login("ani@x.io");
    const res = await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/traces/${sp.traceId}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ traceId: sp.traceId, resource: { "service.name": "svc" } });
    expect(res.json().spans[0]).toMatchObject({ spanId: sp.spanId, service: "svc" });
    expect(res.json().spans[0].projectId).toBeUndefined();
    const miss = await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/traces/${"f".repeat(32)}`, headers: { cookie } });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().detail).toMatch(/trace not stored/);
    expect((await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/traces/xyz`, headers: { cookie } })).statusCode).toBe(400);
    const budi = await login("budi@x.io");
    expect((await app.inject({ method: "GET", url: `/api/0/projects/${projectId}/traces/${sp.traceId}`, headers: { cookie: budi } })).statusCode).toBe(404);
  });
});
