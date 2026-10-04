import { isBusy, toDbDate, type RawDb } from "@bugtool/db";
import type { FileStore } from "../sourcemaps/storage.js";

const CHUNK = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

export interface RetentionResult {
  eventsDeleted: number;
  issuesDeleted: number;
  artifactsDeleted?: number;
  filesDeleted?: number;
}

const ARTIFACT_MAX_IDLE_DAYS = 90;
const CHUNK_MAX_AGE_MS = 24 * 3_600_000;

/**
 * Hapus event yang melewati batas retensi tiap project, lalu issue yang tidak punya event lagi.
 * Dihapus per potongan kecil (CHUNK) dengan jeda di antaranya, supaya ingest & dashboard
 * tidak tertahan lama oleh satu transaksi besar.
 */
export async function runRetention(db: RawDb, now = new Date(), files?: FileStore): Promise<RetentionResult> {
  const res: RetentionResult = { eventsDeleted: 0, issuesDeleted: 0 };
  const projects = db
    .prepare("SELECT id, retention_max_events AS max, retention_days AS days FROM projects")
    .all() as { id: string; max: number; days: number }[];

  const byAge = db.prepare(`DELETE FROM events WHERE id IN (
    SELECT id FROM events WHERE project_id = ? AND received_at < ? LIMIT ${CHUNK})`);
  const count = db.prepare("SELECT COUNT(*) FROM events WHERE project_id = ?").pluck();
  const oldest = db.prepare(`DELETE FROM events WHERE id IN (
    SELECT id FROM events WHERE project_id = ? ORDER BY received_at ASC LIMIT ?)`);
  const orphans = db.prepare(`DELETE FROM issues WHERE id IN (
    SELECT i.id FROM issues i WHERE i.project_id = ?
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.issue_id = i.id) LIMIT ${CHUNK})`);

  // Jalankan satu potongan; kalau DB sedang dikunci transaksi lain, tunggu sebentar lalu ulangi.
  const run = async (fn: () => number) => {
    for (;;) {
      try {
        return fn();
      } catch (err) {
        if (!isBusy(err)) throw err;
        await sleep(5);
      }
    }
  };

  for (const p of projects) {
    const cutoff = toDbDate(new Date(now.getTime() - p.days * 86_400_000));
    for (;;) {
      const n = await run(() => byAge.run(p.id, cutoff).changes);
      res.eventsDeleted += n;
      if (n < CHUNK) break;
      await tick();
    }

    let excess = (count.get(p.id) as number) - p.max;
    while (excess > 0) {
      const take = Math.min(excess, CHUNK);
      const n = await run(() => oldest.run(p.id, take).changes);
      res.eventsDeleted += n;
      excess -= take;
      if (n === 0) break;
      await tick();
    }

    for (;;) {
      const n = await run(() => orphans.run(p.id).changes);
      res.issuesDeleted += n;
      if (n < CHUNK) break;
      await tick();
    }
  }

  // Source map yang tidak dipakai menerjemahkan event selama 90 hari, lalu file yang tidak dirujuk lagi.
  if (files) {
    const cutoff = toDbDate(new Date(now.getTime() - ARTIFACT_MAX_IDLE_DAYS * 86_400_000));
    res.artifactsDeleted = await run(() =>
      db.prepare("DELETE FROM artifacts WHERE COALESCE(last_used_at, created_at) < ?").run(cutoff).changes);
    const referenced = new Set(db.prepare("SELECT DISTINCT sha1 FROM artifacts").pluck().all() as string[]);
    res.filesDeleted = files.gc(referenced, CHUNK_MAX_AGE_MS, now.getTime());
  }

  // Kembalikan halaman kosong ke disk (butuh auto_vacuum=INCREMENTAL, diatur oleh migrate()).
  if (res.eventsDeleted > 0 || res.issuesDeleted > 0) await run(() => (db.pragma("incremental_vacuum"), 0));
  return res;
}

/** Jalankan retensi berkala. Return fungsi untuk menghentikan. */
export function scheduleRetention(db: RawDb, files: FileStore | undefined, intervalMs: number, log: (msg: string, err?: unknown) => void) {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const loop = async () => {
    try {
      const r = await runRetention(db, new Date(), files);
      if (r.eventsDeleted || r.issuesDeleted || r.artifactsDeleted || r.filesDeleted) {
        log(`retention: ${r.eventsDeleted} events, ${r.issuesDeleted} issues, ${r.artifactsDeleted ?? 0} sourcemaps, ${r.filesDeleted ?? 0} files deleted`);
      }
    } catch (err) {
      log("retention failed", err);
    }
    if (!stopped) timer = setTimeout(loop, intervalMs);
  };
  timer = setTimeout(loop, 30_000); // jangan bebani saat baru start
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
