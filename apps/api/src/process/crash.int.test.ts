import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "@bugtool/db";

// Uji ketahanan sungguhan: server proses terpisah dibanjiri event lalu di-kill -9 di tengah jalan.
// Setiap event yang sudah dibalas 200 HARUS ada di database setelah server dinyalakan lagi.
const root = join(import.meta.dirname, "../../../..");
const dir = mkdtempSync(join(tmpdir(), "bugtool-crash-"));
const dbFile = join(dir, "crash.db");
const PORT = 4590 + Math.floor(Math.random() * 300);
const KEY = "c".repeat(32);
const PROJECT = "11111111-1111-4111-8111-111111111111";
let proc: ChildProcess | null = null;

function startServer() {
  proc = spawn(process.execPath, ["--import", "tsx", join(root, "apps/api/src/index.ts")], {
    cwd: join(root, "apps/api"),
    env: { ...process.env, DATABASE_URL: `file:${dbFile}`, API_PORT: String(PORT), LOG_LEVEL: "error",
      MIGRATIONS_DIR: join(root, "packages/db/prisma/migrations") },
    stdio: "ignore",
  });
  return waitHealthy();
}

async function waitHealthy() {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return (await r.json()) as { queue: number };
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start");
}

const hex = (n: number) => n.toString(16).padStart(32, "0");
function envelope(n: number) {
  const ev = JSON.stringify({ event_id: hex(n), message: `crash test ${n % 7}`, level: "error" });
  return `{}\n{"type":"event","length":${Buffer.byteLength(ev)}}\n${ev}\n`;
}

afterAll(() => {
  proc?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

describe("crash safety", () => {
  it("keeps every acknowledged event across kill -9", async () => {
    migrate(dbFile, join(root, "packages/db/prisma/migrations"));
    const seed = new Database(dbFile);
    seed.prepare("INSERT INTO organizations (id, name, slug) VALUES ('o', 'o', 'o')").run();
    seed.prepare("INSERT INTO projects (id, organization_id, name, slug) VALUES (?, 'o', 'p', 'p')").run(PROJECT);
    seed.prepare("INSERT INTO dsn_keys (id, project_id, public_key) VALUES ('k', ?, ?)").run(PROJECT, KEY);
    seed.close();

    await startServer();
    const acked = new Set<number>();
    let next = 0;
    let killed = false;
    // 32 pengirim paralel terus mengirim sampai server mati.
    const sender = async () => {
      while (!killed) {
        const n = next++;
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}/api/${PROJECT}/envelope/?sentry_key=${KEY}`, { method: "POST", body: envelope(n) });
          if (r.status === 200) acked.add(n);
        } catch {
          return; // koneksi putus karena kill
        }
      }
    };
    const senders = Array.from({ length: 32 }, sender);
    await new Promise((r) => setTimeout(r, 1500));
    killed = true;
    proc!.kill("SIGKILL");
    await Promise.all(senders);
    expect(acked.size).toBeGreaterThan(200);

    // Nyalakan lagi: sisa antrian harus diproses.
    const h = await startServer();
    for (let i = 0; i < 200 && (await waitHealthy()).queue > 0; i++) await new Promise((r) => setTimeout(r, 50));
    proc!.kill("SIGTERM");
    await new Promise((r) => proc!.once("exit", r));

    const db = new Database(dbFile, { readonly: true });
    const ids = new Set((db.prepare("SELECT id FROM events").pluck().all() as string[]).map((id) => parseInt(id.replace(/-/g, ""), 16)));
    const left = db.prepare("SELECT COUNT(*) FROM ingest_queue").pluck().get();
    db.close();
    const missing = [...acked].filter((n) => !ids.has(n));
    console.log(`acked=${acked.size} stored=${ids.size} queueAfterRestart=${h.queue} missing=${missing.length}`);
    expect(missing).toEqual([]);
    expect(left).toBe(0);
  }, 60_000);
});
