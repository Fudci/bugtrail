import { describe, expect, it } from "vitest";
import { externalLabel, layoutMap } from "./service-map";

const col = (r: ReturnType<typeof layoutMap>) => Object.fromEntries(r.nodes.map((n) => [n.id, n.col]));

describe("layoutMap", () => {
  it("puts callers left of callees and externals right after their caller", () => {
    const r = layoutMap(["gateway", "orders", "billing"], [
      { source: "gateway", target: "orders", external: false },
      { source: "orders", target: "billing", external: false },
      { source: "gateway", target: "billing", external: false },
      { source: "orders", target: "postgresql", external: true },
      { source: "gateway", target: "redis", external: true },
    ]);
    expect(col(r)).toEqual({ gateway: 0, orders: 1, billing: 2, postgresql: 2, redis: 1 });
    // Di kolom yang sama, service lebih dulu, eksternal di bawahnya.
    expect(r.nodes.find((n) => n.id === "redis")!.row).toBe(1);
    expect(r.nodes.find((n) => n.id === "postgresql")!.external).toBe(true);
  });

  it("terminates on cycles and keeps every node", () => {
    const r = layoutMap(["a", "b"], [{ source: "a", target: "b", external: false }, { source: "b", target: "a", external: false }]);
    expect(r.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(Math.max(...r.nodes.map((n) => n.col))).toBeLessThan(2);
  });

  it("a peer seen both as service and external is drawn once, as a service", () => {
    const r = layoutMap(["a", "b"], [{ source: "a", target: "b", external: true }]);
    expect(r.nodes.map((n) => [n.id, n.external])).toEqual([["a", false], ["b", false]]);
  });
});

describe("externalLabel", () => {
  it("calls databases databases, everything else not instrumented", () => {
    expect(["mssql · MWS-PIS", "mongoose · MyWorkSpace", "redis", "PostgreSQL · shop", "api.stripe.com", "(unknown)", "mssqlish"].map(externalLabel))
      .toEqual(["database", "database", "database", "database", "not instrumented", "not instrumented", "not instrumented"]);
  });
});
