import { describe, expect, it } from "vitest";
import { classCounts, customToken, groupCodes, parseStatus, toggleToken } from "./status-util";

describe("parseStatus", () => {
  it("reads classes, codes, ranges and all; rejects invalid", () => {
    expect(parseStatus(null)).toEqual([]);
    expect(parseStatus("all")).toEqual([]);
    expect(parseStatus("500,502,5xx,500")).toEqual(["500", "502", "5xx"]);
    expect(parseStatus("520-529")).toEqual(["520-529"]);
    expect(parseStatus("error")).toBeNull();
    expect(parseStatus("error,404", { allowError: true })).toEqual(["error", "404"]);
    for (const s of ["600", "6xx", "529-520", "abc", Array(21).fill("500").join(",")]) expect(parseStatus(s), s).toBeNull();
  });
});

describe("customToken", () => {
  it("accepts a code or a range", () => {
    expect(customToken(" 499 ")).toBe("499");
    expect(customToken("520 - 529")).toBe("520-529");
    expect(customToken("500-500")).toBe("500");
    for (const s of ["", "99", "600", "529-520", "5xx", "500-600"]) expect(customToken(s), s).toBeNull();
  });
});

describe("toggleToken", () => {
  it("selecting a class clears its codes and ranges, keeps others", () => {
    expect(toggleToken(["500", "520-529", "404"], "5xx")).toEqual(["404", "5xx"]);
    expect(toggleToken(["5xx"], "5xx")).toEqual([]);
  });
  it("selecting a code inside a selected class narrows to the code", () => {
    expect(toggleToken(["5xx", "4xx"], "502")).toEqual(["4xx", "502"]);
    expect(toggleToken(["502"], "502")).toEqual([]);
    expect(toggleToken(["error"], "404")).toEqual(["error", "404"]);
  });
});

describe("counts", () => {
  const c = [{ code: 200, count: 9 }, { code: 404, count: 2 }, { code: 500, count: 74 }, { code: 502, count: 80 }, { code: 301, count: 1 }];
  it("sums per class and groups codes 5xx | 4xx | others by count", () => {
    expect(Object.fromEntries(classCounts(c))).toEqual({ "2xx": 9, "3xx": 1, "4xx": 2, "5xx": 154 });
    expect(groupCodes(c).map((g) => g.map((x) => x.code))).toEqual([[502, 500], [404], [200, 301]]);
  });
});
