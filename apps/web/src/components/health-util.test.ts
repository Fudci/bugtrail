import { describe, expect, it } from "vitest";
import type { HealthEndpoint } from "../api";
import { breaches, sortEndpoints } from "./health-util";

const ep = (route: string, count: number, c5xx: number, p95: number | null = null, breaches = 0): HealthEndpoint =>
  ({ method: "GET", route, count, c4xx: 0, c5xx, errorRate: count ? c5xx / count : 0, p50: null, p95, p99: null, series: [], errSeries: [], breaches });
const thr = { pct: 5, minRequests: 20 };

describe("health threshold helpers", () => {
  it("breaches only with enough requests and rate >= pct", () => {
    expect(breaches(20, 1, thr)).toBe(true);   // tepat 5%
    expect(breaches(100, 4, thr)).toBe(false); // 4%
    expect(breaches(10, 10, thr)).toBe(false); // < minRequests
    expect(breaches(0, 0, { pct: 0, minRequests: 0 })).toBe(false);
  });

  it("ranks short spikes (breached buckets) above a higher overall rate", () => {
    const list = [ep("/steady", 100, 10), ep("/spiky", 5000, 75, null, 6), ep("/once", 300, 3, null, 1)];
    expect(sortEndpoints(list, "problems", thr).map((e) => e.route)).toEqual(["/spiky", "/once", "/steady"]);
  });

  it("sorts problems by 5xx rate among endpoints with enough requests, then the rest by count", () => {
    const list = [ep("/big", 1000, 10), ep("/few", 5, 5), ep("/bad", 40, 8), ep("/mid", 50, 0), ep("/tiny", 10, 0)];
    expect(sortEndpoints(list, "problems", thr).map((e) => e.route)).toEqual(["/bad", "/big", "/mid", "/tiny", "/few"]);
    expect(sortEndpoints(list, "requests", thr).map((e) => e.route)).toEqual(["/big", "/mid", "/bad", "/tiny", "/few"]);
  });

  it("sorts p95 desc with missing latency last", () => {
    const list = [ep("/a", 1, 0, null), ep("/b", 1, 0, 100), ep("/c", 1, 0, 500)];
    expect(sortEndpoints(list, "p95", thr).map((e) => e.route)).toEqual(["/c", "/b", "/a"]);
  });
});
