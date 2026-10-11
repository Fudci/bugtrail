import { describe, expect, it } from "vitest";
import { parseStatusFilter, statusSql } from "./status-filter.js";

describe("parseStatusFilter", () => {
  it("treats empty and all as no filter", () => {
    for (const s of [undefined, "", " ", "all", "ALL", "500,all"]) expect(parseStatusFilter(s)?.all, String(s)).toBe(true);
  });
  it("parses classes, exact codes and ranges (backward compatible with 5xx/4xx)", () => {
    expect(parseStatusFilter("5xx")).toEqual({ all: false, error: false, ranges: [[500, 599]] });
    expect(parseStatusFilter("4xx")).toEqual({ all: false, error: false, ranges: [[400, 499]] });
    expect(parseStatusFilter("500, 502,520-529,2xx")?.ranges).toEqual([[500, 500], [502, 502], [520, 529], [200, 299]]);
    expect(parseStatusFilter("499")?.ranges).toEqual([[499, 499]]);
  });
  it("allows error only for traces", () => {
    expect(parseStatusFilter("error")).toBeNull();
    expect(parseStatusFilter("error,404", { allowError: true })).toEqual({ all: false, error: true, ranges: [[404, 404]] });
  });
  it("rejects invalid tokens and too many tokens", () => {
    for (const s of ["600", "099", "6xx", "0xx", "529-520", "500-600", "50", "5000", "abc", "500,,502", "500;502", "1e2", "-500"]) {
      expect(parseStatusFilter(s), s).toBeNull();
    }
    expect(parseStatusFilter(Array(20).fill("500").join(","))).not.toBeNull();
    expect(parseStatusFilter(Array(21).fill("500").join(","))).toBeNull();
  });
});

describe("statusSql", () => {
  it("builds an OR of bound ranges", () => {
    const f = parseStatusFilter("500,520-529", { allowError: true })!;
    expect(statusSql(f, "s", () => "?")).toEqual({ sql: "(s BETWEEN ? AND ? OR s BETWEEN ? AND ?)", params: [500, 500, 520, 529] });
    expect(statusSql(parseStatusFilter("error,404", { allowError: true })!, "s", () => "?", "E").sql).toBe("(E OR s BETWEEN ? AND ?)");
    expect(statusSql(parseStatusFilter("all")!, "s", () => "?")).toEqual({ sql: "1 = 1", params: [] });
  });
});
