import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, openRaw } from "@bugtool/db";
import type { FlatSpan } from "./convert.js";
import { externalPeer, ServiceGraph } from "./service-graph.js";
import { foldServiceRollups } from "../process/retention.js";

const span = (p: Partial<FlatSpan>): FlatSpan => ({
  traceId: "a".repeat(32), spanId: "b".repeat(16), name: "op", kind: 1, startUs: 0, durationUs: 1000,
  statusCode: 0, attributes: {}, events: [], resource: {}, ...p,
});

function db() {
  const path = join(mkdtempSync(join(tmpdir(), "svc-")), "t.db");
  migrate(path);
  const raw = openRaw(path);
  raw.prepare("INSERT INTO organizations (id, name, slug) VALUES ('o1', 'O', 'o')").run();
  raw.prepare("INSERT INTO projects (id, organization_id, name, slug) VALUES ('p1', 'o1', 'P', 'p')").run();
  return raw;
}
type R = { service: string; peer: string; external: number; count: number; errors: number };
const rows = (raw: ReturnType<typeof db>) =>
  raw.prepare("SELECT service, peer, external, count, errors FROM service_rollups ORDER BY service, peer").all() as R[];

const T = Date.UTC(2026, 9, 10, 12, 0, 10);

describe("externalPeer", () => {
  it("prefers peer.service, then the database (by name, then host), then messaging system, then server address", () => {
    expect(externalPeer(span({ attributes: { "peer.service": "billing", "server.address": "10.0.0.1", "db.system": "mssql" } }))).toBe("billing");
    expect(externalPeer(span({ attributes: { "db.system.name": "postgresql", "db.namespace": "shop", "server.address": "db" } }))).toBe("postgresql · shop");
    expect(externalPeer(span({ attributes: { "db.system": "mssql", "db.name": "MWS-PIS", "net.peer.name": "10.0.0.5" } }))).toBe("mssql · MWS-PIS");
    expect(externalPeer(span({ attributes: { "db.system": "mssql", "db.name": "HR" } }))).toBe("mssql · HR");
    expect(externalPeer(span({ attributes: { "db.system": "redis", "server.address": "cache" } }))).toBe("redis · cache");
    expect(externalPeer(span({ attributes: { "db.system": "mssql" } }))).toBe("mssql");
    expect(externalPeer(span({ attributes: { "messaging.system": "rabbitmq", "server.address": "mq" } }))).toBe("rabbitmq");
    expect(externalPeer(span({ attributes: { "server.address": "api.example.com" } }))).toBe("api.example.com");
    expect(externalPeer(span({}))).toBe("(unknown)");
  });
});

describe("ServiceGraph", () => {
  it("links a client span to the server span of another service across separate exports", () => {
    const raw = db();
    const g = new ServiceGraph(raw);
    // gateway memanggil orders: span client diekspor lebih dulu oleh gateway, span server oleh orders.
    g.add("p1", [span({ service: "gateway", kind: 2, spanId: "1".repeat(16), attributes: { "http.response.status_code": 200 } }),
      span({ service: "gateway", kind: 3, spanId: "2".repeat(16), parentSpanId: "1".repeat(16), durationUs: 30_000, attributes: { "http.response.status_code": 502 } })], T);
    g.add("p1", [span({ service: "orders", kind: 2, spanId: "3".repeat(16), parentSpanId: "2".repeat(16), statusCode: 2 })], T + 1000);
    g.flush(T + 2000);
    expect(rows(raw)).toEqual([
      { service: "gateway", peer: "", external: 0, count: 1, errors: 0 },
      { service: "gateway", peer: "orders", external: 0, count: 1, errors: 1 }, // error dari sisi pemanggil (502)
      { service: "orders", peer: "", external: 0, count: 1, errors: 1 },
    ]);
  });

  it("server span first, client later also links; same-service calls are not edges", () => {
    const raw = db();
    const g = new ServiceGraph(raw);
    g.add("p1", [span({ service: "orders", kind: 2, spanId: "3".repeat(16), parentSpanId: "2".repeat(16) })], T);
    g.add("p1", [span({ service: "gateway", kind: 3, spanId: "2".repeat(16) }),
      span({ service: "gateway", kind: 3, spanId: "4".repeat(16) }), span({ service: "gateway", kind: 2, spanId: "5".repeat(16), parentSpanId: "4".repeat(16) })], T);
    g.flush(T, true);
    expect(rows(raw).filter((r) => r.peer !== "")).toEqual([
      { service: "gateway", peer: "orders", external: 0, count: 1, errors: 0 },
    ]);
  });

  it("unmatched client spans become external edges after the wait, not before", () => {
    const raw = db();
    const g = new ServiceGraph(raw);
    g.add("p1", [span({ service: "orders", kind: 3, spanId: "6".repeat(16), attributes: { "db.system": "mssql" } })], T);
    g.flush(T + 30_000);
    expect(rows(raw)).toEqual([]);
    g.flush(T + 61_000);
    expect(rows(raw)).toEqual([{ service: "orders", peer: "mssql", external: 1, count: 1, errors: 0 }]);
  });

  it("caps distinct external destinations per project", () => {
    const raw = db();
    const g = new ServiceGraph(raw);
    g.add("p1", Array.from({ length: 205 }, (_, i) => span({ service: "a", kind: 3, spanId: i.toString(16).padStart(16, "0"), attributes: { "server.address": `h${i}.example.com` } })), T);
    g.flush(T, true);
    const peers = rows(raw).map((r) => r.peer);
    expect(new Set(peers).size).toBe(201);
    expect(rows(raw).find((r) => r.peer === "(other)")!.count).toBe(5);
  });

  it("ignores DNS lookups (client spans without a destination)", () => {
    const raw = db();
    const g = new ServiceGraph(raw);
    g.add("p1", [span({ service: "api", kind: 3, name: "dns.lookup", attributes: { "peer.ipv6": "::1" } })], T);
    g.flush(T, true);
    expect(rows(raw)).toEqual([]);
  });

  it("does not link spans across projects", () => {
    const raw = db();
    raw.prepare("INSERT INTO projects (id, organization_id, name, slug) VALUES ('p2', 'o1', 'Q', 'q')").run();
    const g = new ServiceGraph(raw);
    g.add("p1", [span({ service: "a", kind: 3, spanId: "7".repeat(16), attributes: { "peer.service": "x" } })], T);
    g.add("p2", [span({ service: "b", kind: 2, spanId: "8".repeat(16), parentSpanId: "7".repeat(16) })], T);
    g.flush(T, true);
    expect(rows(raw).filter((r) => r.peer !== "")).toEqual([{ service: "a", peer: "x", external: 1, count: 1, errors: 0 }]);
  });

  it("folds old minute rows into hour rows", () => {
    const raw = db();
    const g = new ServiceGraph(raw);
    g.add("p1", [span({ service: "a", kind: 2 })], T);
    g.add("p1", [span({ service: "a", kind: 2 })], T + 120_000);
    g.flush(T + 120_000, true);
    foldServiceRollups(raw, new Date(T + 4 * 3_600_000));
    expect(raw.prepare("SELECT granularity, count FROM service_rollups").all()).toEqual([{ granularity: "h", count: 2 }]);
  });
});
