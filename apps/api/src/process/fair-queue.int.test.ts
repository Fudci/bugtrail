import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { migrate, openRaw } from "@bugtool/db";
import type { BatchResult } from "./persist.js";
import { IngestStore } from "./store.js";

// Antrian adil: project kecil tetap diproses walau project besar punya antrean panjang.
const root = join(import.meta.dirname, "../../../..");
const dir = mkdtempSync(join(tmpdir(), "bugtool-fair-"));
const file = join(dir, "fair.db");
migrate(file, join(root, "packages/db/prisma/migrations"));
const db = openRaw(file);
db.prepare("INSERT INTO organizations (id, name, slug) VALUES ('o', 'o', 'o')").run();
for (const p of ["big", "small", "third"]) db.prepare("INSERT INTO projects (id, organization_id, name, slug) VALUES (?, 'o', ?, ?)").run(p, p, p);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const ev = (projectId: string) => ({
  projectId,
  receivedAt: new Date().toISOString(),
  payload: { event_id: (++n).toString(16).padStart(32, "0"), message: `m ${projectId}`, level: "error" },
});

describe("fair ingest queue", () => {
  it("processes a small project's events in the first batch while a big project has a large backlog", async () => {
    const batches: { projects: Map<string, number> }[] = [];
    const store = new IngestStore(db, { maxBacklog: 100_000, batchSize: 50 });
    // Project besar antre lebih dulu (id lebih kecil): FIFO murni akan butuh 40 batch sebelum project kecil.
    await store.enqueue(Array.from({ length: 2000 }, () => ev("big")));
    await store.enqueue(Array.from({ length: 5 }, () => ev("small")));
    await store.enqueue(Array.from({ length: 30 }, () => ev("third")));
    const count = db.prepare("SELECT project_id, COUNT(*) AS n FROM events GROUP BY project_id");
    const s2 = new IngestStore(db, {
      maxBacklog: 100_000, batchSize: 50,
      onBatch: (_r: BatchResult) => {
        batches.push({ projects: new Map((count.all() as { project_id: string; n: number }[]).map((r) => [r.project_id, r.n])) });
      },
    });
    await store.stop();
    s2.start();
    await s2.drain();
    await s2.stop();

    // Batch pertama: small (5) + third + big berbagi 50 slot.
    const first = batches[0]!.projects;
    expect(first.get("small")).toBe(5);
    expect(first.get("third")).toBeGreaterThanOrEqual(16);
    expect(first.get("big")).toBeGreaterThanOrEqual(16);
    expect([...first.values()].reduce((a, b) => a + b, 0)).toBe(50);
    // Batch kedua: third habis, sisa jatah ke big.
    expect(batches[1]!.projects.get("third")).toBe(30);
    // Semua event akhirnya tersimpan, antrian kosong.
    expect(batches.at(-1)!.projects.get("big")).toBe(2000);
    expect(db.prepare("SELECT COUNT(*) FROM ingest_queue").pluck().get()).toBe(0);
  });

  it("rotates projects when there are more projects than the batch size", async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `r${i}`);
    for (const p of ids) db.prepare("INSERT INTO projects (id, organization_id, name, slug) VALUES (?, 'o', ?, ?)").run(p, p, p);
    const seen: string[][] = [];
    const store = new IngestStore(db, { maxBacklog: 100_000, batchSize: 4 });
    for (const p of ids) await store.enqueue([ev(p), ev(p)]);
    await store.stop();
    const before = new Set<string>();
    const cnt = db.prepare("SELECT DISTINCT project_id FROM events WHERE project_id LIKE 'r%'").pluck();
    const s2 = new IngestStore(db, {
      maxBacklog: 100_000, batchSize: 4,
      onBatch: () => {
        const now = (cnt.all() as string[]).filter((p) => !before.has(p));
        now.forEach((p) => before.add(p));
        seen.push(now);
      },
    });
    s2.start();
    await s2.drain();
    await s2.stop();
    // Dua batch pertama (4 + 4 slot) sudah menyentuh keenam project.
    expect(seen[0]!.length + seen[1]!.length).toBe(6);
    expect(db.prepare("SELECT COUNT(*) FROM events WHERE project_id LIKE 'r%'").pluck().get()).toBe(12);
  });
});
