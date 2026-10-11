import { describe, expect, it } from "vitest";
import { ExceptionDedupe, SpanBuffer, TraceQuota } from "./buffer.js";
import type { FlatSpan } from "./convert.js";

const span = (traceId: string, spanId: string, error = false): FlatSpan => ({
  traceId, spanId, name: spanId, kind: 1, startUs: 0, durationUs: 1, statusCode: error ? 2 : 0,
  attributes: {}, events: error ? [{ name: "exception", timeUs: 0, attributes: {} }] : [], resource: {},
});
const isErr = (s: FlatSpan) => s.statusCode === 2;
const ids = (xs: { spanId: string }[]) => xs.map((x) => x.spanId);

describe("SpanBuffer", () => {
  it("drops traces without errors and releases held spans when an error arrives later", () => {
    const b = new SpanBuffer();
    expect(b.add("p", [span("t1", "a"), span("t1", "b")], isErr, 0)).toEqual([]);
    expect(ids(b.add("p", [span("t1", "c", true)], isErr, 1000))).toEqual(["a", "b", "c"]);
    // span yang datang setelah error ikut disimpan
    expect(ids(b.add("p", [span("t1", "root")], isErr, 2000))).toEqual(["root"]);
    expect(b.size).toBe(0);
  });

  it("forgets healthy traces after the hold window and caps memory", () => {
    const b = new SpanBuffer({ holdMs: 1000, maxSpans: 3 });
    b.add("p", [span("old", "a")], isErr, 0);
    b.add("p", [span("x", "1"), span("y", "2"), span("z", "3")], isErr, 500);
    expect(b.size).toBe(3); // "old" dibuang karena batas maxSpans
    expect(b.add("p", [span("old", "late", true)], isErr, 600).map((s) => s.spanId)).toEqual(["late"]);
    b.add("p", [], isErr, 5000);
    expect(b.size).toBe(0);
  });

  it("keeps projects apart", () => {
    const b = new SpanBuffer();
    b.add("p1", [span("t", "a")], isErr, 0);
    expect(ids(b.add("p2", [span("t", "e", true)], isErr, 1))).toEqual(["e"]);
  });
});

describe("ExceptionDedupe", () => {
  it("counts an error once per key within the window, and again after it", () => {
    const d = new ExceptionDedupe(1000);
    expect(d.firstTime("t:Err:boom", 0)).toBe(true);
    expect(d.firstTime("t:Err:boom", 10)).toBe(false);
    expect(d.firstTime("t2:Err:boom", 20)).toBe(true);
    expect(d.firstTime("t:Err:boom", 2000)).toBe(true);
  });
});

describe("TraceQuota", () => {
  it("allows N traces per group per hour, keeps allowing a trace it already accepted, resets next hour", () => {
    const q = new TraceQuota(2);
    expect(q.allow("issue", "t1", 0)).toBe(true);
    expect(q.allow("issue", "t2", 1)).toBe(true);
    expect(q.allow("issue", "t3", 2)).toBe(false);
    expect(q.allow("issue", "t1", 3)).toBe(true); // span susulan dari trace yang sudah diterima
    expect(q.allow("other", "t4", 4)).toBe(true); // issue lain punya kuota sendiri
    expect(q.allow("issue", "t5", 3_600_000)).toBe(true);
  });
});
