import { describe, expect, it } from "vitest";
import type { HealthPoint } from "../api";
import { areaPath, breachBands, bucketAt, compact, indicesOf, lastInProgress, linePath, niceTicks, splitLive, windowOf } from "./chart-math";

const pt = (t: number, count: number, c5xx = 0): HealthPoint => ({ t, count, c4xx: 0, c5xx, p50: null, p95: null, p99: null });
const thr = { pct: 5, minRequests: 20 };

describe("chart math", () => {
  it("niceTicks covers max with round steps", () => {
    expect(niceTicks(5491)).toEqual([0, 2000, 4000, 6000]);
    expect(niceTicks(7.5)).toEqual([0, 2.5, 5, 7.5]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(100)).toEqual([0, 50, 100]);
  });

  it("compact formats axis numbers", () => {
    expect(compact(2000)).toBe("2k");
    expect(compact(1500000)).toBe("1.5M");
    expect(compact(2.5)).toBe("2.5");
  });

  it("bucketAt snaps and clamps", () => {
    expect(bucketAt(0, 100, 10)).toBe(0);
    expect(bucketAt(55, 100, 10)).toBe(5);
    expect(bucketAt(-5, 100, 10)).toBe(0);
    expect(bucketAt(150, 100, 10)).toBe(9);
  });

  it("breachBands merges contiguous breaching buckets", () => {
    const s = [pt(0, 100, 10), pt(60, 100, 10), pt(120, 100, 0), pt(180, 10, 10), pt(240, 50, 5)];
    expect(breachBands(s, thr)).toEqual([{ start: 0, end: 1 }, { start: 4, end: 4 }]);
  });

  it("paths break on null points", () => {
    expect(linePath([[0, 1], null, [2, 3], [4, 5]])).toBe("M0.0,1.0M2.0,3.0L4.0,5.0");
    expect(areaPath([[0, 1], [2, 3]], 10)).toBe("M0.0,10L0.0,1.0L2.0,3.0L2.0,10Z");
  });

  it("windowOf/indicesOf round-trip", () => {
    const s = [pt(0, 1), pt(60, 1), pt(120, 1), pt(180, 1)];
    const w = windowOf(s, 2, 1, 60);
    expect(w).toEqual({ from: 60, to: 180 });
    expect(indicesOf(s, w)).toEqual({ start: 1, end: 2 });
    expect(indicesOf(s, null)).toBeNull();
  });

  it("lastInProgress is true only while the last bucket has not ended", () => {
    const s = [pt(0, 1), pt(60, 1)];
    expect(lastInProgress(s, 60, 90)).toBe(true);
    expect(lastInProgress(s, 60, 119.9)).toBe(true);
    expect(lastInProgress(s, 60, 120)).toBe(false); // bucket 60..120 sudah selesai
    expect(lastInProgress(s, 60, 500)).toBe(false);
    expect(lastInProgress([pt(3600, 1)], 3600, 3601)).toBe(true);
    expect(lastInProgress([], 60, 0)).toBe(false);
  });

  it("splitLive separates the in-progress tail from solid points", () => {
    const a: [number, number] = [0, 1], b: [number, number] = [1, 2], c: [number, number] = [2, 3];
    expect(splitLive([a, b, c], false)).toEqual({ solid: [a, b, c], tail: [] });
    expect(splitLive([a, b, c], true)).toEqual({ solid: [a, b, null], tail: [b, c] });
    expect(splitLive([a, null, c], true)).toEqual({ solid: [a, null, null], tail: [c] });
    expect(splitLive([a, b, null], true)).toEqual({ solid: [a, b, null], tail: [] });
  });
});
