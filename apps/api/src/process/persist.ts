import { randomUUID } from "node:crypto";
import { toDbDate, type RawDb } from "@bugtool/db";
import type { Symbolicator } from "../sourcemaps/symbolicate.js";
import { computeFingerprint, normalizeEvent, type NormalizedEvent } from "./normalize.js";

export interface IngestJob {
  projectId: string;
  receivedAt: string;
  payload: Record<string, unknown>;
}

export interface QueuedJob extends IngestJob {
  queueId: number;
}

/** Issue yang perlu dipertimbangkan untuk alert setelah batch di-commit. */
export interface IssueChange {
  issueId: string;
  projectId: string;
  title: string;
  culprit: string | null;
  level: string;
  kind: "new" | "regression";
}

export interface BatchResult {
  created: number;
  duplicate: number;
  invalid: number;
  changes: IssueChange[];
  /** project yang menerima event di batch ini (untuk cek lonjakan). */
  projects: Set<string>;
}

type Prepared = { job: QueuedJob; e: NormalizedEvent; fingerprint: string; receivedAt: Date };

const searchText = (e: NormalizedEvent) =>
  [e.title, e.culprit, e.message, ...e.exceptions.map((x) => x.value)].filter(Boolean).join(" ");

interface IssueRow { id: string; first_seen: string; last_seen: string; status: string }

// Prepared statement dibuat sekali per koneksi.
function statements(db: RawDb) {
  return {
    eventExists: db.prepare("SELECT 1 FROM events WHERE id = ?").pluck(),
    findIssue: db.prepare<[string, string], IssueRow>(
      "SELECT id, first_seen, last_seen, status FROM issues WHERE project_id = ? AND fingerprint = ?",
    ),
    insertIssue: db.prepare(`INSERT INTO issues
      (id, project_id, fingerprint, title, culprit, level, status, event_count, first_seen, last_seen, first_release)
      VALUES (?, ?, ?, ?, ?, ?, 'unresolved', ?, ?, ?, ?)`),
    updateIssue: db.prepare(`UPDATE issues SET event_count = event_count + ?, first_seen = ?, last_seen = ?,
      status = CASE WHEN status = 'resolved' THEN 'unresolved' ELSE status END WHERE id = ?`),
    insertEvent: db.prepare(`INSERT INTO events
      (id, project_id, issue_id, received_at, timestamp, level, release, environment, user_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertFts: db.prepare("INSERT INTO events_fts (content, event_id, issue_id, project_id) VALUES (?, ?, ?, ?)"),
    deleteQueued: db.prepare("DELETE FROM ingest_queue WHERE id <= ?"),
  };
}

const cache = new WeakMap<RawDb, ReturnType<typeof statements>>();

/**
 * Simpan batch dari antrian dan hapus barisnya dari ingest_queue dalam SATU transaksi sinkron.
 * Crash di titik mana pun: transaksi batal, baris antrian tetap ada, diproses ulang saat start.
 * Batch harus berisi baris antrian berurutan dari id terkecil (lihat store.ts).
 */
export function persistBatch(db: RawDb, jobs: QueuedJob[], symbolicator?: Symbolicator): BatchResult {
  const st = cache.get(db) ?? statements(db);
  cache.set(db, st);
  const result: BatchResult = { created: 0, duplicate: 0, invalid: 0, changes: [], projects: new Set() };
  if (jobs.length === 0) return result;

  const prepared: Prepared[] = [];
  const seen = new Set<string>();
  for (const job of jobs) {
    try {
      const receivedAt = new Date(job.receivedAt);
      // Terjemahkan stacktrace lewat source map DULU, supaya judul, culprit, dan fingerprint
      // (pengelompokan issue) memakai nama fungsi & file asli, bukan hasil minify.
      if (symbolicator) {
        try {
          job.payload = symbolicator.symbolicate(job.projectId, job.payload).payload;
        } catch {
          // source map rusak: simpan event apa adanya
        }
      }
      const e = normalizeEvent(job.payload, receivedAt);
      if (seen.has(e.eventId)) {
        result.duplicate++;
        continue;
      }
      seen.add(e.eventId);
      prepared.push({ job, e, fingerprint: computeFingerprint(e), receivedAt });
    } catch {
      // Payload rusak tidak bisa diperbaiki dengan retry — buang (tetap dihapus dari antrian).
      result.invalid++;
    }
  }

  const maxQueueId = Math.max(...jobs.map((j) => j.queueId));

  db.transaction(() => {
    // Kelompokkan per issue supaya tiap issue cukup diproses sekali per batch.
    const groups = new Map<string, Prepared[]>();
    for (const p of prepared) {
      if (st.eventExists.get(p.e.eventId)) {
        result.duplicate++;
        continue;
      }
      const k = `${p.job.projectId}\x00${p.fingerprint}`;
      const g = groups.get(k);
      if (g) g.push(p);
      else groups.set(k, [p]);
    }

    for (const group of groups.values()) {
      const first = group[0]!;
      const times = group.map((p) => p.e.timestamp.getTime());
      const minTs = new Date(Math.min(...times));
      const maxTs = new Date(Math.max(...times));
      const latest = group.reduce((a, b) => (b.e.timestamp >= a.e.timestamp ? b : a));

      const issue = st.findIssue.get(first.job.projectId, first.fingerprint);
      let issueId: string;
      if (issue) {
        issueId = issue.id;
        const firstSeen = new Date(issue.first_seen) < minTs ? issue.first_seen : toDbDate(minTs);
        const lastSeen = new Date(issue.last_seen) > maxTs ? issue.last_seen : toDbDate(maxTs);
        st.updateIssue.run(group.length, firstSeen, lastSeen, issueId);
        if (issue.status === "resolved") {
          result.changes.push({ issueId, projectId: first.job.projectId, title: latest.e.title, culprit: latest.e.culprit ?? null, level: latest.e.level, kind: "regression" });
        }
      } else {
        issueId = randomUUID();
        const earliest = group.reduce((a, b) => (b.e.timestamp < a.e.timestamp ? b : a));
        st.insertIssue.run(
          issueId, first.job.projectId, first.fingerprint, latest.e.title, latest.e.culprit ?? null,
          latest.e.level, group.length, toDbDate(minTs), toDbDate(maxTs), earliest.e.release ?? null,
        );
        result.changes.push({ issueId, projectId: first.job.projectId, title: latest.e.title, culprit: latest.e.culprit ?? null, level: latest.e.level, kind: "new" });
      }

      for (const p of group) {
        st.insertEvent.run(
          p.e.eventId, p.job.projectId, issueId, toDbDate(p.receivedAt), toDbDate(p.e.timestamp), p.e.level,
          p.e.release ?? null, p.e.environment ?? null, p.e.userId ?? null, JSON.stringify(p.job.payload),
        );
        st.insertFts.run(searchText(p.e), p.e.eventId, issueId, p.job.projectId);
        result.projects.add(p.job.projectId);
      }
      result.created += group.length;
    }

    st.deleteQueued.run(maxQueueId);
  })();

  return result;
}
