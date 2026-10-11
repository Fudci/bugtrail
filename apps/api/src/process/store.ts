import { isBusy, type RawDb } from "@bugtool/db";
import type { Symbolicator } from "../sourcemaps/symbolicate.js";
import { persistBatch, type BatchResult, type IngestJob, type QueuedJob } from "./persist.js";

export interface StoreOptions {
  /** Event yang belum diproses di disk. Lebih dari ini -> ingest dibalas 429. */
  maxBacklog: number;
  /** Event per transaksi pemrosesan. */
  batchSize: number;
  /** Jeda maksimum mengumpulkan request sebelum ditulis bersama (group commit). */
  flushIntervalMs?: number;
  symbolicator?: Symbolicator;
  onBatch?: (r: BatchResult) => void;
  log?: (msg: string, err?: unknown) => void;
}

export class BacklogFullError extends Error {}

type Row = { id: number; project_id: string; received_at: string; payload: string };
type Pending = { jobs: IngestJob[]; resolve: () => void; reject: (e: unknown) => void };

const STORAGE_CODES = new Set(["SQLITE_FULL", "SQLITE_IOERR", "SQLITE_CANTOPEN", "SQLITE_READONLY", "SQLITE_CORRUPT"]);
const isStorageError = (err: unknown) => {
  const code = (err as { code?: string } | null)?.code ?? "";
  return [...STORAGE_CODES].some((c) => code.startsWith(c));
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Antrian ingest yang tahan crash, disimpan di tabel ingest_queue (SQLite).
 *
 * enqueue(): request dikumpulkan beberapa ms lalu ditulis dalam satu transaksi (group commit);
 *            promise baru resolve SETELAH data ada di disk → aman membalas 200 ke SDK.
 * loop:      ambil batch secara adil per project (event tertua tiap project, bergiliran), simpan
 *            issue/event + hapus baris antrian dalam satu transaksi (persistBatch).
 *            Crash di mana pun → tidak ada event hilang. Satu project yang membanjiri antrian
 *            tidak menunda project lain: tiap batch memberi jatah ke semua project yang antre.
 */
export class IngestStore {
  private pending: Pending[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private busy = false;
  backlog: number;
  accepted = 0;
  processed = 0;
  failed = 0;

  private insert;
  private projects;
  private selectProject;
  private selectId;
  private dropOne;
  /** Setelah error data: id baris batch yang gagal, diproses satu per satu sampai yang bermasalah ketemu. */
  private isolate: number[] = [];
  /** Giliran project berikutnya kalau jumlah project melebihi batchSize. */
  private cursor = 0;

  constructor(private db: RawDb, private opts: StoreOptions) {
    this.insert = db.prepare("INSERT INTO ingest_queue (project_id, received_at, payload) VALUES (?, ?, ?)");
    // Daftar project yang antre lewat indeks (project_id, id): satu lompatan indeks per project, bukan scan antrian.
    this.projects = db.prepare(`WITH RECURSIVE p(pid) AS (
        SELECT MIN(project_id) FROM ingest_queue
        UNION ALL SELECT (SELECT MIN(project_id) FROM ingest_queue WHERE project_id > p.pid) FROM p WHERE p.pid IS NOT NULL)
      SELECT pid FROM p WHERE pid IS NOT NULL`).pluck();
    this.selectProject = db.prepare<[string, number, number], Row>(
      "SELECT id, project_id, received_at, payload FROM ingest_queue WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?",
    );
    this.selectId = db.prepare<[number], Row>("SELECT id, project_id, received_at, payload FROM ingest_queue WHERE id = ?");
    this.dropOne = db.prepare("DELETE FROM ingest_queue WHERE id = ?");
    // Sisa antrian dari run sebelumnya (mis. setelah crash) ikut diproses.
    this.backlog = db.prepare("SELECT COUNT(*) FROM ingest_queue").pluck().get() as number;
  }

  get size() {
    return this.backlog + this.pending.reduce((n, p) => n + p.jobs.length, 0);
  }

  /** Resolve setelah tersimpan di disk. Reject BacklogFullError kalau antrian penuh. */
  enqueue(jobs: IngestJob[]): Promise<void> {
    if (this.stopping) return Promise.reject(new BacklogFullError("shutting down"));
    if (this.size + jobs.length > this.opts.maxBacklog) return Promise.reject(new BacklogFullError("backlog full"));
    return new Promise((resolve, reject) => {
      this.pending.push({ jobs, resolve, reject });
      this.flushTimer ??= setTimeout(() => void this.flush(), this.opts.flushIntervalMs ?? 2);
    });
  }

  private async flush() {
    this.flushTimer = null;
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return;
    const write = this.db.transaction(() => {
      for (const p of batch) for (const j of p.jobs) this.insert.run(j.projectId, j.receivedAt, JSON.stringify(j.payload));
    });
    for (let attempt = 0; ; attempt++) {
      try {
        write();
        break;
      } catch (err) {
        // Lock dipegang transaksi Prisma (dashboard) → coba lagi tanpa memblokir event loop.
        if (isBusy(err) && attempt < 500) {
          await sleep(2);
          continue;
        }
        for (const p of batch) p.reject(err);
        return;
      }
    }
    const n = batch.reduce((s, p) => s + p.jobs.length, 0);
    this.backlog += n;
    this.accepted += n;
    for (const p of batch) p.resolve();
    this.wake?.();
  }

  start() {
    this.running ??= this.loop();
  }

  /** Berhenti dengan rapi: tulis request yang sedang dikumpulkan. Sisa antrian aman di disk. */
  async stop() {
    this.stopping = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await this.flush();
    this.wake?.();
    await this.running;
  }

  /** Tunggu antrian di disk habis diproses (dipakai test). */
  async drain() {
    while (this.size > 0 || this.busy) await sleep(5);
  }

  /**
   * Ambil batch adil: jatah batchSize dibagi rata ke project yang antre (tertua dulu per project);
   * sisa jatah dari project yang antreannya pendek diberikan ke project lain.
   */
  private nextBatch(): Row[] {
    if (this.backlog <= 0) return [];
    while (this.isolate.length) {
      const row = this.selectId.get(this.isolate[0]!);
      if (row) return [row];
      this.isolate.shift();
    }
    const all = this.projects.all() as string[];
    if (!all.length) return [];
    const limit = this.opts.batchSize;
    // Lebih banyak project daripada jatah: bergiliran mulai dari cursor.
    const start = this.cursor % all.length;
    const pids = all.length > limit ? [...all.slice(start), ...all.slice(0, start)].slice(0, limit) : all;
    this.cursor = start + pids.length;
    const rows: Row[] = [];
    let left = limit;
    let open = pids;
    const last = new Map<string, number>();
    while (left > 0 && open.length) {
      const share = Math.max(1, Math.floor(left / open.length));
      const next: string[] = [];
      for (const pid of open) {
        if (left <= 0) break;
        const take = Math.min(share, left);
        const got = this.selectProject.all(pid, last.get(pid) ?? 0, take);
        if (got.length) last.set(pid, got.at(-1)!.id);
        rows.push(...got);
        left -= got.length;
        if (got.length === take) next.push(pid);
      }
      open = next;
    }
    return rows;
  }

  private async loop() {
    while (!this.stopping) {
      const rows = this.nextBatch();
      if (rows.length === 0) {
        this.backlog = 0;
        await new Promise<void>((r) => (this.wake = r));
        this.wake = null;
        continue;
      }
      this.busy = true;
      const jobs: QueuedJob[] = rows.map((r) => ({
        queueId: r.id,
        projectId: r.project_id,
        receivedAt: r.received_at,
        payload: JSON.parse(r.payload) as Record<string, unknown>,
      }));
      try {
        const res = persistBatch(this.db, jobs, this.opts.symbolicator);
        this.backlog = Math.max(0, this.backlog - rows.length);
        this.processed += res.created;
        if (this.isolate.length) this.isolate.shift();
        this.opts.onBatch?.(res);
      } catch (err) {
        if (isBusy(err)) {
          await sleep(2);
        } else if (isStorageError(err)) {
          // Disk penuh / I/O: event tetap di antrian, coba lagi nanti. Jangan dibuang.
          this.failed++;
          this.opts.log?.(`ingest storage error, retrying in 5s`, err);
          await sleep(5000);
        } else if (rows.length > 1) {
          // Error data di salah satu event: pecah batch untuk menemukan yang bermasalah.
          this.isolate = rows.map((r) => r.id);
        } else {
          // Satu event yang selalu gagal (mis. project-nya sudah dihapus): buang supaya antrian jalan.
          this.dropOne.run(rows[0]!.id);
          this.backlog = Math.max(0, this.backlog - 1);
          this.failed++;
          if (this.isolate.length) this.isolate.shift();
          this.opts.log?.(`dropped unprocessable event (queue id ${rows[0]!.id})`, err);
        }
      } finally {
        this.busy = false;
      }
      // Beri giliran ke request HTTP di antara batch.
      await new Promise((r) => setImmediate(r));
    }
  }
}
