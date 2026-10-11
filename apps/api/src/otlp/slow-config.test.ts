import { describe, expect, it } from "vitest";
import { isSlow } from "./slow-config.js";

describe("isSlow", () => {
  it("needs a threshold, enough duration and no failure", () => {
    expect(isSlow(1_000_000, 1000, false)).toBe(true);
    expect(isSlow(999_999, 1000, false)).toBe(false);
    expect(isSlow(5_000_000, null, false)).toBe(false);
    expect(isSlow(5_000_000, 1000, true)).toBe(false);
  });
});
