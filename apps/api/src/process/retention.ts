import { isBusy, toDbDate, type RawDb } from "@bugtool/db";
import type { FileStore } from "../sourcemaps/storage.js";
import { BUCKETS } from "../otlp/rollups.js";

const CHUNK = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

export interface RetentionResult {
  eventsDeleted: number;
  issuesDeleted: number;
  artifactsDeleted?: number;
  filesDeleted?: number;
  logsDeleted?: number;
}

const ARTIFACT_MAX_IDLE_DAYS = 90;
const CHUNK_MAX_AGE_MS = 24 * 3_600_000;

const HS = Array.from({ length: BUCKETS }, (_, i) => `h${i}`);
const ROLLUP_MINUTE_KEEP_S = 2 * 3600;
const ROLLUP_HOUR_KEEP_S = 90 * 86_400;

// Tabel rollup per menit/jam: kolom kunci (selain project_id, granularity, bucket), kolom yang dijumlah,
// dan kolom yang diambil minimumnya. h0..h11 dan dur_sum_us/dur_max_us ada di kedua tabel.
// Nama tabel/kolom di sini konstanta, bukan input user.
const ROLLUP_TABLES = {
  endpoint_rollups: { keys: ["service", "method", "route"], sums: ["count", "c2xx", "c4xx", "c5xx"], mins: [] as string[] },
  service_rollups: { keys: ["service", "peer"], sums: ["count", "errors"], mins: ["external"] },
} as const;

/** Data per menit > 2 jam digabung ke per jam (lalu dihapus), data per jam > 90 hari dihapus. */
function foldTable(db: RawDb, table: keyof typeof ROLLUP_TABLES, now: Date): { folded: number; deleted: number } {
  const { keys, sums, mins } = ROLLUP_TABLES[table];
  const nowS = Math.floor(now.getTime() / 1000);
  const cut = Math.floor((nowS - ROLLUP_MINUTE_KEEP_S) / 3600) * 3600; // hanya jam yang sudah lengkap
  const added = [...sums, "dur_sum_us", ...HS];
  const cols = [...keys, ...mins, ...added, "dur_max_us"];
  return db.transaction(() => {
    // WHERE sebelum ON CONFLICT menghindari ambiguitas parsing INSERT ... SELECT ... ON CONFLICT di SQLite.
    const folded = db.prepare(`INSERT INTO ${table} (project_id, granularity, bucket, ${cols.join(", ")})
      SELECT project_id, 'h', bucket - bucket % 3600, ${[...keys, ...mins.map((c) => `MIN(${c})`), ...added.map((c) => `SUM(${c})`), "MAX(dur_max_us)"].join(", ")}
      FROM ${table} WHERE granularity = 'm' AND bucket < ?
      GROUP BY project_id, bucket - bucket % 3600, ${keys.join(", ")}
      ON CONFLICT (project_id, granularity, bucket, ${keys.join(", ")}) DO UPDATE SET
        ${[...mins.map((c) => `${c} = min(${c}, excluded.${c})`), ...added.map((c) => `${c} = ${c} + excluded.${c}`), "dur_max_us = max(dur_max_us, excluded.dur_max_us)"].join(", ")}`).run(cut).changes;
    db.prepare(`DELETE FROM ${table} WHERE granularity = 'm' AND bucket < ?`).run(cut);
    const deleted = db.prepare(`DELETE FROM ${table} WHERE granularity = 'h' AND bucket < ?`).run(nowS - ROLLUP_HOUR_KEEP_S).changes;
    return { folded, deleted };
  })();
}

/** API Health (endpoint_rollups). */
export const foldRollups = (db: RawDb, now: Date) => foldTable(db, "endpoint_rollups", now);
/** Service map (service_rollups). */
export const foldServiceRollups = (db: RawDb, now: Date) => foldTable(db, "service_rollups", now);

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
  // Span OpenTelemetry (tampilan trace) mengikuti umur maksimal project.
  const spansByAge = db.prepare(`DELETE FROM trace_spans WHERE rowid IN (
    SELECT rowid FROM trace_spans WHERE project_id = ? AND received_at < ? LIMIT ${CHUNK})`);
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

    for (;;) {
      const n = await run(() => spansByAge.run(p.id, cutoff).changes);
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

  // Rollup API Health: gabung per menit ke per jam, hapus yang kedaluwarsa.
  await run(() => foldRollups(db, now).folded);
  await run(() => foldServiceRollups(db, now).folded);
  // Jumlah per kode status hanya untuk jendela alert (maks 60 menit): simpan 3 jam.
  await run(() => db.prepare("DELETE FROM endpoint_status_rollups WHERE bucket < ?").run(Math.floor(now.getTime() / 1000) - 3 * 3600).changes);

  // Log OTLP mode Lite (tabel logs): hapus yang diterima lebih dari OTLP_LOG_RETENTION_DAYS hari lalu (default 3).
  // Mode Scale menyimpan log di ClickHouse (TTL); tabel ini kosong.
  const logDays = Number(process.env["OTLP_LOG_RETENTION_DAYS"] ?? 3);
  if (Number.isFinite(logDays) && logDays > 0) {
    const logCut = Math.floor(now.getTime() / 1000 - logDays * 86_400);
    const oldLogs = db.prepare("DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE received_at < ? LIMIT ?)");
    for (;;) {
      const n = await run(() => oldLogs.run(logCut, CHUNK).changes);
      res.logsDeleted = (res.logsDeleted ?? 0) + n;
      if (n < CHUNK) break;
      await tick();
    }
  }

  // Catatan kuota (drop) dan pemakaian span per jam: simpan 30 hari.
  const usageCut = Math.floor(now.getTime() / 1000) - 30 * 86_400;
  await run(() => db.prepare("DELETE FROM quota_drops WHERE hour < ?").run(usageCut).changes);
  await run(() => db.prepare("DELETE FROM span_usage WHERE hour < ?").run(usageCut).changes);

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
