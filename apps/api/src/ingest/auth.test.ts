import { describe, expect, it } from "vitest";
import { extractPublicKey } from "./auth.js";

describe("extractPublicKey", () => {
  it("reads X-Sentry-Auth", () => {
    expect(
      extractPublicKey({ authHeader: "Sentry sentry_version=7, sentry_client=sentry.javascript/9.0, sentry_key=abc123" }),
    ).toBe("abc123");
  });
  it("falls back to query, then envelope dsn", () => {
    expect(extractPublicKey({ queryKey: "q1" })).toBe("q1");
    expect(extractPublicKey({ envelopeDsn: "https://k9@bugs.example.com/42" })).toBe("k9");
  });
  it("returns undefined when absent or malformed", () => {
    expect(extractPublicKey({})).toBeUndefined();
    expect(extractPublicKey({ authHeader: "Sentry sentry_version=7" })).toBeUndefined();
    expect(extractPublicKey({ envelopeDsn: "nope" })).toBeUndefined();
  });
});
