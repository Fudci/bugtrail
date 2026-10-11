import { isBusy, toDbDate, type RawDb } from "@bugtool/db";
import type { Alerter, DiscordMessage } from "./alerts.js";

// Alert "ongoing errors": selama sebuah issue terus menerima event, kirim SATU ringkasan per issue per interval
// (jumlah event, jumlah user, sudah berapa lama), bukan satu pesan per event.
//  - Episode mulai di event pertama setelah sepi; selesai kalau satu interval penuh tanpa event.
//  - Backoff (opsional): setelah 10 menit berlangsung, interval naik ke 15 menit.
//  - Batas per project: 20 pesan per menit; sisanya digabung jadi satu ringkasan.
//  - Issue baru tidak dikirim di interval pertamanya kalau alert "New issue" aktif (sudah ada pesan New issue).
//  - Issue yang di-ignore tidak dikirim.

export const ONGOING_INTERVALS = [30, 60, 300, 900] as const;
const BACKOFF_AFTER_S = 10 * 60;
const BACKOFF_INTERVAL_S = 15 * 60;
const MAX_PER_PROJECT_PER_MIN = 20;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const fmt = (n: number) => n.toLocaleString("en-US");
const COLOR = 0xe5484d;

/** "45 s", "7 min", "1 h 20 min". */
export function duration(s: number) {
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

type Cfg = { id: string; name: string; webhook: string; seconds: number; backoff: number; newIssue: number };
type Active = { issueId: string; title: string; culprit: string | null; level: string; firstSeen: string; status: string; events: number; users: number };
type State = { started_at: number; last_sent_at: number; last_check_at: number };

export class OngoingAlertChecker {
  private timer: NodeJS.Timeout | null = null;
  private projects;
  private active;
  private getState;
  private putState;
  private endStates;
  /** Pesan terkirim per project di menit berjalan (batas per project). */
  private sentThisMinute = new Map<string, { minute: number; n: number; overflowSent: boolean }>();

  constructor(private db: RawDb, private alerter: Alerter, private opts: { webUrl: string; log?: (m: string, e?: unknown) => void }) {
    this.projects = db.prepare(`SELECT id, name, discord_webhook_url AS webhook, alert_ongoing_seconds AS seconds,
      alert_ongoing_backoff AS backoff, alert_new_issue AS newIssue FROM projects
      WHERE alert_ongoing_seconds IS NOT NULL AND discord_webhook_url IS NOT NULL`);
    // Issue yang punya event sejak `since`, dengan jumlah event dan user (distinct user_id) di jendela itu.
    this.active = db.prepare(`SELECT e.issue_id AS issueId, i.title, i.culprit, i.level, i.first_seen AS firstSeen, i.status,
        COUNT(*) AS events, COUNT(DISTINCT e.user_id) AS users
      FROM events e JOIN issues i ON i.id = e.issue_id
      WHERE e.project_id = ? AND e.received_at >= ? GROUP BY e.issue_id ORDER BY events DESC LIMIT 200`);
    this.getState = db.prepare("SELECT started_at, last_sent_at, last_check_at FROM ongoing_alert_state WHERE issue_id = ?");
    this.putState = db.prepare(`INSERT INTO ongoing_alert_state (issue_id, started_at, last_sent_at, last_check_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (issue_id) DO UPDATE SET started_at = excluded.started_at, last_sent_at = excluded.last_sent_at, last_check_at = excluded.last_check_at`);
    // Episode selesai: issue project ini yang tidak punya event selama satu interval penuh.
    this.endStates = db.prepare(`DELETE FROM ongoing_alert_state WHERE last_check_at < ?
      AND issue_id IN (SELECT id FROM issues WHERE project_id = ?)`);
  }

  private issueUrl(projectId: string, issueId: string) {
    return `${this.opts.webUrl.replace(/\/$/, "")}/p/${projectId}/issues/${issueId}`;
  }

  private budget(projectId: string, nowS: number) {
    const minute = Math.floor(nowS / 60);
    let b = this.sentThisMinute.get(projectId);
    if (!b || b.minute !== minute) this.sentThisMinute.set(projectId, (b = { minute, n: 0, overflowSent: false }));
    return b;
  }

  message(cfg: Cfg, a: Active, sinceS: number, ongoingS: number, nowS: number): DiscordMessage {
    const users = a.users > 0 ? ` · ${fmt(a.users)} ${a.users === 1 ? "user" : "users"}` : "";
    return {
      embeds: [{
        title: clip(a.title, 256),
        url: this.issueUrl(cfg.id, a.issueId),
        description: `${a.culprit ? "`" + clip(a.culprit, 300) + "`\n" : ""}**${fmt(a.events)} ${a.events === 1 ? "event" : "events"}**${users} in the last ${duration(nowS - sinceS)}`
          + ` · still happening, ${duration(ongoingS)} so far`,
        color: COLOR,
        fields: [
          { name: "Project", value: clip(cfg.name, 100), inline: true },
          { name: "Type", value: "Ongoing error", inline: true },
          { name: "Level", value: a.level, inline: true },
        ],
        footer: { text: "BugTrail" },
        timestamp: new Date(nowS * 1000).toISOString(),
      }],
    };
  }

  /** Return jumlah pesan yang diantrikan. Tidak pernah throw. */
  check(now = new Date()): number {
    const nowS = Math.floor(now.getTime() / 1000);
    let queued = 0;
    let cfgs: Cfg[];
    try {
      cfgs = this.projects.all() as Cfg[];
    } catch (err) {
      this.opts.log?.("ongoing alert check failed", err);
      return 0;
    }
    for (const cfg of cfgs) {
      try {
        queued += this.checkProject(cfg, nowS);
      } catch (err) {
        if (!isBusy(err)) this.opts.log?.(`ongoing alert check failed for project ${cfg.id}`, err);
      }
    }
    return queued;
  }

  private checkProject(cfg: Cfg, nowS: number): number {
    const interval = ONGOING_INTERVALS.includes(cfg.seconds as never) ? cfg.seconds : 60;
    // Episode yang sepi selama satu interval penuh (dengan backoff: 15 menit) berakhir.
    this.endStates.run(nowS - Math.max(interval, cfg.backoff ? BACKOFF_INTERVAL_S : interval) - 1, cfg.id);
    // Satu query untuk jendela terpanjang yang mungkin dibutuhkan; dipilah per issue di bawah.
    const lookback = cfg.backoff ? Math.max(interval, BACKOFF_INTERVAL_S) : interval;
    const rows = this.active.all(cfg.id, toDbDate(new Date((nowS - lookback) * 1000))) as Active[];
    let queued = 0;
    const overflow: Active[] = [];
    const budget = this.budget(cfg.id, nowS);
    for (const a of rows) {
      if (a.status === "ignored") continue;
      const st = this.getState.get(a.issueId) as State | undefined;
      // Event terakhir dalam interval biasa? Kalau tidak dan belum ada episode, issue ini sepi.
      const recent = this.countSince(a.issueId, nowS - interval);
      if (!st) {
        if (recent.events === 0) continue;
        const isNew = Date.parse(a.firstSeen) / 1000 >= nowS - interval;
        // Issue baru: pesan "New issue" sudah dikirim; mulai episode tanpa pesan.
        if (isNew && cfg.newIssue) { this.putState.run(a.issueId, nowS, nowS, nowS); continue; }
        if (budget.n >= MAX_PER_PROJECT_PER_MIN) { overflow.push(a); continue; }
        this.putState.run(a.issueId, nowS, nowS, nowS);
        this.alerter.notify(cfg.webhook, this.message(cfg, { ...a, ...recent }, nowS - interval, 0, nowS));
        budget.n++; queued++;
        continue;
      }
      if (recent.events > 0) this.putState.run(a.issueId, st.started_at, st.last_sent_at, nowS);
      const ongoing = nowS - st.started_at;
      const every = cfg.backoff && ongoing >= BACKOFF_AFTER_S ? Math.max(interval, BACKOFF_INTERVAL_S) : interval;
      if (nowS - st.last_sent_at < every) continue;
      const since = this.countSince(a.issueId, st.last_sent_at);
      if (since.events === 0) continue;
      if (budget.n >= MAX_PER_PROJECT_PER_MIN) { overflow.push(a); continue; }
      this.putState.run(a.issueId, st.started_at, nowS, recent.events > 0 ? nowS : st.last_check_at);
      this.alerter.notify(cfg.webhook, this.message(cfg, { ...a, ...since }, st.last_sent_at, ongoing, nowS));
      budget.n++; queued++;
    }
    // Paling banyak satu ringkasan "lebih" per project per menit.
    if (overflow.length && !budget.overflowSent) {
      budget.overflowSent = true;
      // Satu ringkasan untuk issue yang melewati batas per project menit ini; dicoba lagi menit berikutnya.
      const events = overflow.reduce((s, a) => s + a.events, 0);
      this.alerter.notify(cfg.webhook, {
        embeds: [{
          title: clip(`+${fmt(overflow.length)} more ongoing ${overflow.length === 1 ? "issue" : "issues"} in ${cfg.name}`, 256),
          url: `${this.opts.webUrl.replace(/\/$/, "")}/p/${cfg.id}/issues`,
          description: `${fmt(events)} events. Discord limit for this project reached (${MAX_PER_PROJECT_PER_MIN} messages per minute).`,
          color: COLOR,
          footer: { text: "BugTrail" },
          timestamp: new Date(nowS * 1000).toISOString(),
        }],
      });
      queued++;
    }
    return queued;
  }

  private countStmt: { get(...p: unknown[]): unknown } | null = null;
  private countSince(issueId: string, sinceS: number) {
    this.countStmt ??= this.db.prepare(`SELECT COUNT(*) AS events, COUNT(DISTINCT user_id) AS users FROM events
      WHERE issue_id = ? AND received_at >= ?`);
    return this.countStmt.get(issueId, toDbDate(new Date(sinceS * 1000))) as { events: number; users: number };
  }

  start(intervalMs = 30_000) {
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
