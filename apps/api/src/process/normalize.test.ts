import { describe, expect, it } from "vitest";
import { computeFingerprint, normalizeEvent, parseTimestamp, scrubMessage, toUuid } from "./normalize.js";

const now = new Date("2026-10-03T00:00:00Z");

function excEvent(opts: { lineno?: number; value?: string; fingerprint?: string[]; fn?: string } = {}) {
  return {
    event_id: "9ec79c33ec9942ab8353589fcb2e04dc",
    level: "error",
    fingerprint: opts.fingerprint,
    exception: {
      values: [
        {
          type: "TypeError",
          value: opts.value ?? "x is undefined",
          stacktrace: {
            frames: [
              { filename: "node_modules/lib.js", function: "call", in_app: false, lineno: 1 },
              { filename: "src/app.ts", function: opts.fn ?? "handle", in_app: true, lineno: opts.lineno ?? 10 },
            ],
          },
        },
      ],
    },
  };
}

describe("normalizeEvent", () => {
  it("extracts title, culprit, level, user", () => {
    const e = normalizeEvent({ ...excEvent(), user: { id: "u1" }, release: "app@1.0" }, now);
    expect(e.eventId).toBe("9ec79c33-ec99-42ab-8353-589fcb2e04dc");
    expect(e.title).toBe("TypeError: x is undefined");
    expect(e.culprit).toBe("src/app.ts in handle");
    expect(e.userId).toBe("u1");
    expect(e.release).toBe("app@1.0");
  });

  it("handles message-only events and unknown level", () => {
    const e = normalizeEvent({ event_id: "9ec79c33ec9942ab8353589fcb2e04dc", level: "bogus", logentry: { formatted: "boom" } }, now);
    expect(e.title).toBe("boom");
    expect(e.level).toBe("error");
  });

  it("rejects missing event_id", () => {
    expect(() => normalizeEvent({}, now)).toThrow(/event_id/);
    expect(() => toUuid("xyz")).toThrow();
  });
});

describe("parseTimestamp", () => {
  it("accepts epoch and RFC 3339", () => {
    expect(parseTimestamp(1700000000.5, now).toISOString()).toBe("2023-11-14T22:13:20.500Z");
    expect(parseTimestamp("2011-05-02T17:41:36Z", now).toISOString()).toBe("2011-05-02T17:41:36.000Z");
    expect(parseTimestamp("garbage", now)).toBe(now);
  });
});

describe("computeFingerprint", () => {
  const fp = (p: unknown) => computeFingerprint(normalizeEvent(p, now));

  it("ignores line numbers and exception value for stack grouping", () => {
    expect(fp(excEvent({ lineno: 10 }))).toBe(fp(excEvent({ lineno: 99, value: "y is undefined" })));
  });
  it("splits different in-app functions", () => {
    expect(fp(excEvent())).not.toBe(fp(excEvent({ fn: "other" })));
  });
  it("honors custom fingerprint and {{ default }}", () => {
    expect(fp(excEvent({ fingerprint: ["a"] }))).toBe(fp(excEvent({ fn: "other", fingerprint: ["a"] })));
    expect(fp(excEvent({ fingerprint: ["{{ default }}", "x"] }))).not.toBe(
      fp(excEvent({ fn: "other", fingerprint: ["{{ default }}", "x"] })),
    );
  });
  it("groups messages differing only by numbers", () => {
    const m = (s: string) => ({ event_id: "9ec79c33ec9942ab8353589fcb2e04dc", message: s });
    expect(fp(m("order 123 failed"))).toBe(fp(m("order 456 failed")));
    expect(scrubMessage("id 5f0b2c1e-1111-4222-8333-444455556666")).toBe("id <uuid>");
  });
});
