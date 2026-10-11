import { isBusy, type RawDb } from "@bugtool/db";
import type { Alerter } from "./alerts.js";

// Kuota ingest per project per menit (jendela tetap 1 menit, di memori; restart = hitungan mulai dari nol).
// Data di atas kuota tidak diantrikan: ingest membalas 429 + Retry-After (detik sampai menit berikutnya).
// Jumlah yang dibuang dicatat di memori lalu ditulis berkala ke quota_drops (per project per jam),
// supaya tidak ada tulisan DB per request.

export type QuotaKind = "events" | "spans" | "logs";
export type QuotaResult = { ok: true } | { ok: false; retryAfter: number };

const LIMIT_TTL_MS = 60_000;
const ALERT_COOLDOWN_MS = 3_600_000;
const hourOf = (ms: number) => Math.floor(ms / 3_600_000) * 3600;

interface Limits { events: number | null; spans: number | null; logs: number | null; name: string; webhook: string | null }
interface Window { minute: number; events: number; spans: number; logs: number }
interface Pending { events: number; spans: number; logs: number; usedSpans: number }

export class QuotaMeter {
  private limits = new Map<string, Limits & { until: number }>();
  private windows = new Map<string, Window>();
  /** Akumulasi belum ditulis, kunci `${projectId}\0${hour}`. */
  private pending = new Map<string, Pending>();
  private lastAlert = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private readLimits;
  private upsertDrops;
  private upsertUsage;
  private hourDrops;

  constructor(
    private db: RawDb,
    private opts: { alerter?: Alerter | undefined; now?: () => number; log?: (msg: string, err?: unknown) => void } = {},
  ) {
    this.readLimits = db.prepare<[string], Limits>(
      `SELECT quota_events_per_min AS events, quota_spans_per_min AS spans, quota_logs_per_min AS logs, name, discord_webhook_url AS webhook
       FROM projects WHERE id = ?`);
    this.upsertDrops = db.prepare(`INSERT INTO quota_drops (project_id, hour, events, spans, logs) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (project_id, hour) DO UPDATE SET events = events + excluded.events, spans = spans + excluded.spans, logs = logs + excluded.logs`);
    this.upsertUsage = db.prepare(`INSERT INTO span_usage (project_id, hour, spans) VALUES (?, ?, ?)
      ON CONFLICT (project_id, hour) DO UPDATE SET spans = spans + excluded.spans`);
    this.hourDrops = db.prepare<[string, number], { events: number; spans: number; logs: number }>(
      "SELECT COALESCE(SUM(events), 0) AS events, COALESCE(SUM(spans), 0) AS spans, COALESCE(SUM(logs), 0) AS logs FROM quota_drops WHERE project_id = ? AND hour >= ?");
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private limitsFor(projectId: string, now: number): Limits | null {
    const hit = this.limits.get(projectId);
    if (hit && hit.until > now) return hit;
    try {
      const row = this.readLimits.get(projectId);
      if (!row) return null;
      if (this.limits.size > 10_000) this.limits.clear();
      this.limits.set(projectId, { ...row, until: now + LIMIT_TTL_MS });
      return row;
    } catch {
      // Gagal baca DB: jangan menolak ingest karena kuota.
      return hit ?? null;
    }
  }

  /** Kosongkan cache batas (dipanggil saat setting kuota diubah). */
  invalidate(projectId: string) {
    this.limits.delete(projectId);
  }

  private window(projectId: string, now: number) {
    const minute = Math.floor(now / 60_000);
    let w = this.windows.get(projectId);
    if (!w || w.minute !== minute) {
      // Batasi memori tanpa me-reset penghitung menit berjalan (clear() sempat membuat kuota lolos sesaat).
      if (this.windows.size > 10_000) {
        for (const [pid, old] of this.windows) if (old.minute !== minute) this.windows.delete(pid);
      }
      this.windows.set(projectId, (w = { minute, events: 0, spans: 0, logs: 0 }));
    }
    return w;
  }

  private bucket(projectId: string, now: number) {
    const k = `${projectId}\0${hourOf(now)}`;
    let p = this.pending.get(k);
    if (!p) this.pending.set(k, (p = { events: 0, spans: 0, logs: 0, usedSpans: 0 }));
    return p;
  }

  /**
   * Hitung `n` item untuk project. Kalau melewati kuota menit ini, tidak dihitung sebagai diterima,
   * jumlahnya dicatat sebagai dibuang, dan pemanggil membalas 429 + Retry-After.
   * Permintaan ditolak utuh (tidak diterima sebagian).
   */
  consume(projectId: string, kind: QuotaKind, n: number): QuotaResult {
    if (n <= 0) return { ok: true };
    const now = this.now();
    const w = this.window(projectId, now);
    const limit = this.limitsFor(projectId, now)?.[kind] ?? null;
    if (limit != null && w[kind] + n > limit) {
      this.bucket(projectId, now)[kind] += n;
      return { ok: false, retryAfter: Math.max(1, Math.ceil(((w.minute + 1) * 60_000 - now) / 1000)) };
    }
    w[kind] += n;
    return { ok: true };
  }

  /** Kembalikan hitungan kalau item ternyata tidak jadi diterima (mis. antrian penuh). */
  refund(projectId: string, kind: QuotaKind, n: number) {
    const w = this.windows.get(projectId);
    if (w && w.minute === Math.floor(this.now() / 60_000)) w[kind] = Math.max(0, w[kind] - n);
  }

  /** Span OTLP yang diterima (untuk grafik pemakaian). */
  recordSpans(projectId: string, n: number) {
    if (n > 0) this.bucket(projectId, this.now()).usedSpans += n;
  }

  /** Hitungan menit berjalan. */
  current(projectId: string) {
    const now = this.now();
    const w = this.windows.get(projectId);
    const minute = Math.floor(now / 60_000);
    return w && w.minute === minute ? { events: w.events, spans: w.spans, logs: w.logs } : { events: 0, spans: 0, logs: 0 };
  }

  /** Tulis akumulasi ke DB lalu kirim alert untuk project yang mulai membuang data. Tidak pernah throw. */
  flush(): number {
    if (this.pending.size === 0) return 0;
    const batch = this.pending;
    this.pending = new Map();
    const dropping = new Set<string>();
    try {
      this.db.transaction(() => {
        for (const [k, p] of batch) {
          const [pid, hour] = k.split("\0") as [string, string];
          if (p.events || p.spans || p.logs) {
            this.upsertDrops.run(pid, Number(hour), p.events, p.spans, p.logs);
            dropping.add(pid);
          }
          if (p.usedSpans) this.upsertUsage.run(pid, Number(hour), p.usedSpans);
        }
      })();
    } catch (err) {
      if (!isBusy(err)) this.opts.log?.("quota flush failed", err);
      // Gabungkan kembali untuk percobaan berikutnya.
      for (const [k, p] of batch) {
        const q = this.pending.get(k);
        if (!q) this.pending.set(k, p);
        else { q.events += p.events; q.spans += p.spans; q.logs += p.logs; q.usedSpans += p.usedSpans; }
      }
      return 0;
    }
    for (const pid of dropping) this.alert(pid);
    return batch.size;
  }

  private alert(projectId: string) {
    const alerter = this.opts.alerter;
    if (!alerter) return;
    try {
      const now = this.now();
      const last = this.lastAlert.get(projectId);
      if (last !== undefined && now - last < ALERT_COOLDOWN_MS) return;
      const cfg = this.limitsFor(projectId, now);
      if (!cfg?.webhook) return;
      this.lastAlert.set(projectId, now);
      // "Jam terakhir" (perkiraan): baris jam berjalan + jam sebelumnya (granularitas tabel per jam).
      const d = this.hourDrops.get(projectId, hourOf(now - 3_600_000))!;
      const fmt = (x: number) => x.toLocaleString("en-US");
      alerter.notify(cfg.webhook, {
        embeds: [{
          title: `Quota exceeded in ${cfg.name.slice(0, 100)}`,
          url: alerter.settingsUrl(projectId),
          description: `Quota exceeded in ${cfg.name.slice(0, 100)}: ${fmt(d.events)} events / ${fmt(d.spans)} spans${d.logs ? ` / ${fmt(d.logs)} logs` : ""} dropped in the last hour`,
          color: 0xe5484d,
          footer: { text: "BugTrail" },
          timestamp: new Date(now).toISOString(),
        }],
      });
    } catch (err) {
      this.opts.log?.("quota alert failed", err);
    }
  }

  start(intervalMs = 10_000) {
    this.timer = setInterval(() => this.flush(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }
}
