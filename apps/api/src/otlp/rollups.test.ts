import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, openRaw } from "@bugtool/db";
import type { FlatSpan } from "./convert.js";
import { bucketIndex, endpointKey, percentile, RollupAggregator } from "./rollups.js";

const span = (p: Partial<FlatSpan>): FlatSpan => ({
  traceId: "a".repeat(32), spanId: "b".repeat(16), name: "GET", kind: 2, startUs: 0, durationUs: 1000,
  statusCode: 0, attributes: {}, events: [], resource: {}, ...p,
});

describe("endpointKey", () => {
  it("uses method + http.route and new/old status attributes", () => {
    expect(endpointKey(span({ attributes: { "http.request.method": "get", "http.route": "/users/:id", "http.response.status_code": 404 } })))
      .toEqual({ method: "GET", route: "/users/:id", status: 404 });
    expect(endpointKey(span({ attributes: { "http.method": "POST", "http.route": "/login", "http.status_code": "500" } })))
      .toEqual({ method: "POST", route: "/login", status: 500 });
  });
  it("falls back to span name when http.route is missing", () => {
    expect(endpointKey(span({ name: "GET /health", attributes: { "http.request.method": "GET", "http.response.status_code": 200 } })))
      .toEqual({ method: "GET", route: "GET /health", status: 200 });
  });
  it("ignores non-server spans and spans without a valid status", () => {
    expect(endpointKey(span({ kind: 3, attributes: { "http.response.status_code": 200 } }))).toBeNull();
    expect(endpointKey(span({ attributes: {} }))).toBeNull();
    expect(endpointKey(span({ attributes: { "http.response.status_code": 99 } }))).toBeNull();
  });
});

describe("bucketIndex / percentile", () => {
  it("maps durations to fixed buckets", () => {
    expect(bucketIndex(4_000)).toBe(0);      // 4 ms <= 5
    expect(bucketIndex(5_000)).toBe(0);
    expect(bucketIndex(5_001)).toBe(1);
    expect(bucketIndex(20_000_000)).toBe(11); // 20 s -> +Inf
  });
  it("returns the bucket upper bound that crosses the rank", () => {
    const h = Array(12).fill(0);
    h[2] = 90; h[6] = 10;                     // 90x <=25ms, 10x <=500ms
    expect(percentile(h, 0.5)).toBe(25);
    expect(percentile(h, 0.95)).toBe(500);
    expect(percentile(Array(12).fill(0), 0.5)).toBeNull();
  });
});

// DB sementara dengan migrasi penuh + baris project minimal (FK tetap aktif).
function db() {
  const path = join(mkdtempSync(join(tmpdir(), "rollup-")), "t.db");
  migrate(path);
  const raw = openRaw(path);
  raw.prepare("INSERT INTO organizations (id, name, slug) VALUES ('o1', 'O', 'o')").run();
  raw.prepare("INSERT INTO projects (id, organization_id, name, slug) VALUES ('p1', 'o1', 'P', 'p')").run();
  return raw;
}
const req = (status: number, ms: number, route = "/a") =>
  span({ durationUs: ms * 1000, attributes: { "http.request.method": "GET", "http.route": route, "http.response.status_code": status } });

// Agregator tidak pernah di-start di unit test, jadi tidak ada timer yang tersisa.
describe("RollupAggregator", () => {
  it("merges spans per minute and adds to existing rows on flush", () => {
    const raw = db();
    const agg = new RollupAggregator(raw);
    const t = Date.UTC(2026, 9, 5, 10, 0, 30);
    agg.add("p1", [req(200, 3), req(500, 40), req(404, 7)], t);
    expect(agg.flush()).toBe(1);
    agg.add("p1", [req(200, 3)], t + 10_000);
    agg.flush();
    const row = raw.prepare("SELECT * FROM endpoint_rollups").get() as Record<string, number>;
    expect(row).toMatchObject({ granularity: "m", bucket: Date.UTC(2026, 9, 5, 10, 0) / 1000, count: 4, c2xx: 2, c4xx: 1, c5xx: 1, h0: 2, h1: 1, h3: 1, dur_max_us: 40_000 });
  });
  it("caps distinct endpoints per project into (other)", () => {
    const raw = db();
    const agg = new RollupAggregator(raw, { maxEndpoints: 2 });
    agg.add("p1", [req(200, 1, "/a"), req(200, 1, "/b"), req(200, 1, "/c"), req(200, 1, "/d")], 0);
    agg.flush();
    const routes = raw.prepare("SELECT route FROM endpoint_rollups ORDER BY route").pluck().all();
    expect(routes).toEqual(["(other)", "/a", "/b"]);
  });
  it("keeps a failed batch once and merges it with new data for the same key", () => {
    const raw = db();
    const agg = new RollupAggregator(raw);
    const real = (agg as unknown as { upsert: unknown }).upsert;
    (agg as unknown as { upsert: unknown }).upsert = { run: () => { throw new Error("disk"); } };
    agg.add("p1", [req(200, 3)], 0);
    expect(agg.flush()).toBe(0);
    agg.add("p1", [req(500, 40)], 1000);
    (agg as unknown as { upsert: unknown }).upsert = real;
    expect(agg.flush()).toBe(1);
    expect(raw.prepare("SELECT count, c2xx, c5xx, dur_max_us, h0, h3 FROM endpoint_rollups").get())
      .toEqual({ count: 2, c2xx: 1, c5xx: 1, dur_max_us: 40_000, h0: 1, h3: 1 });
  });
});
