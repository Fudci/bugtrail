import { describe, expect, it } from "vitest";
import { pageCount, pageItems, rangeText, readPaging } from "./pager-util";

describe("pageItems", () => {
  it("lists every page when there are few", () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageItems(1, 7)).toEqual([1, 2, 3, "…", 7]);
  });
  it("keeps first, last and current±2 with ellipsis for the gaps", () => {
    expect(pageItems(10, 20)).toEqual([1, "…", 8, 9, 10, 11, 12, "…", 20]);
    expect(pageItems(20, 20)).toEqual([1, "…", 18, 19, 20]);
    expect(pageItems(1, 20)).toEqual([1, 2, 3, "…", 20]);
  });
  it("shows a single hidden page as its number instead of an ellipsis", () => {
    expect(pageItems(5, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pageItems(4, 10)).toEqual([1, 2, 3, 4, 5, 6, "…", 10]);
  });
});

describe("paging helpers", () => {
  it("counts pages within the offset cap", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(1000, 50)).toBe(20);
    expect(pageCount(1001, 50)).toBe(21);
    expect(pageCount(1_000_000, 50)).toBe(200);
    expect(pageCount(1_000_000, 25)).toBe(400);
  });
  it("formats the showing range", () => {
    expect(rangeText(2, 50, 50, 1000)).toBe("Showing 51–100 of 1,000");
    expect(rangeText(1, 50, 20, 20)).toBe("Showing 1–20 of 20");
    expect(rangeText(3, 50, 0, 20)).toBe("Showing 0 of 20");
  });
  it("reads page and size from the URL with defaults", () => {
    expect(readPaging(new URLSearchParams(""))).toEqual({ page: 1, size: 50 });
    expect(readPaging(new URLSearchParams("page=3&size=25"))).toEqual({ page: 3, size: 25 });
    expect(readPaging(new URLSearchParams("page=0&size=30"))).toEqual({ page: 1, size: 50 });
    expect(readPaging(new URLSearchParams("page=999&size=100"))).toEqual({ page: 100, size: 100 });
  });
});
