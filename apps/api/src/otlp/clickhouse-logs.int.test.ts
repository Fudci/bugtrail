import { describe, expect, it } from "vitest";
import { ClickHouseLogStore } from "./clickhouse-logs.js";
import { sampleLogs } from "./fixtures.js";
import { flattenLogs } from "./logs.js";

// Log mode Scale ke ClickHouse sungguhan; dilewati kalau CLICKHOUSE_TEST_URL tidak di-set.
const url = process.env["CLICKHOUSE_TEST_URL"];
const db = `bt_test_logs_${Date.now()}`;

describe.skipIf(!url)("ClickHouseLogStore (real ClickHouse)", () => {
  const opts = {
    url: url!, username: process.env["CLICKHOUSE_TEST_USER"] ?? "default", password: process.env["CLICKHOUSE_TEST_PASSWORD"] ?? "",
    database: db, retentionDays: () => 7,
  };

  it("stores logs, dedupes a re-sent batch, filters and pages like SQLite", async () => {
    const s = new ClickHouseLogStore(opts);
    await s.init();
    await s.init(); // idempoten
    const T = "4bf92f3577b34da6a3ce929d0e0e4736";
    const logs = [...flattenLogs(sampleLogs(T, "1760000000000000000")), ...flattenLogs(sampleLogs("cd".repeat(16), "1760000001000000000"))]
      .map((l) => ({ ...l, projectId: "p1" }));
    const encoded = s.encodeSpans(logs);
    await s.writeEncoded(encoded);
    await s.writeEncoded(encoded); // dikirim ulang oleh antrian: diabaikan
    const win = { fromUs: 1759999990000000, toUs: 1760000010000000 };

    const all = await s.searchLogs("p1", { ...win, limit: 10 });
    expect(all).toHaveLength(4);
    expect(all[0]!.timeUs).toBeGreaterThanOrEqual(all[3]!.timeUs); // terbaru dulu
    expect(await s.searchLogs("p1", { ...win, limit: 10, minSeverity: 17 })).toHaveLength(2);
    expect(await s.searchLogs("p1", { ...win, limit: 10, text: "SLOW QUERY" })).toHaveLength(2);
    expect(await s.searchLogs("p2", { ...win, limit: 10 })).toHaveLength(0);
    const t = await s.searchLogs("p1", { traceId: T, limit: 10, order: "asc" });
    expect(t.map((l) => [l.body, l.attributes["user.id"], l.service])).toEqual([["order insert failed: Invalid column name 'coupon_id'", "user-10233", "checkout-api"]]);

    const p1 = await s.searchLogs("p1", { ...win, limit: 3 });
    const last = p1.at(-1)!;
    const p2 = await s.searchLogs("p1", { ...win, limit: 3, before: { timeUs: last.timeUs, id: last.id } });
    expect(p2).toHaveLength(1);
    expect(new Set([...p1, ...p2].map((l) => l.id)).size).toBe(4);
    expect(await s.logServices("p1", win.fromUs, win.toUs)).toEqual(["checkout-api"]);
    await s.close();
  });
});
