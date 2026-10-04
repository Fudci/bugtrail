import { isBusy, toDbDate, type RawDb } from "@bugtool/db";
import type { BatchResult, IssueChange } from "./persist.js";

// Hanya URL webhook Discord resmi yang diterima — mencegah server dipakai mengirim request
// ke alamat internal (SSRF) lewat pengaturan webhook.
export const DISCORD_WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export interface DiscordMessage {
  content?: string;
  embeds: {
    title: string;
    url?: string;
    description?: string;
    color: number;
    fields?: { name: string; value: string; inline?: boolean }[];
    footer?: { text: string };
    timestamp?: string;
  }[];
}

export type Sender = (webhookUrl: string, msg: DiscordMessage) => Promise<{ ok: boolean; status: number; retryAfterMs?: number }>;

export const discordSender: Sender = async (url, msg) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "BugTrail", ...msg }),
    signal: AbortSignal.timeout(5000),
  });
  let retryAfterMs: number | undefined;
  if (res.status === 429) {
    // Discord mengembalikan retry_after dalam detik.
    const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
    retryAfterMs = Math.ceil((body.retry_after ?? 2) * 1000);
  }
  return { ok: res.ok, status: res.status, ...(retryAfterMs !== undefined && { retryAfterMs }) };
};

const COLORS = { fatal: 0x1f1f1d, error: 0xe5484d, warning: 0xf4cf4f, info: 0x3b82f6, debug: 0x8b887f, spike: 0xf97316 } as const;
const MAX_PER_PROJECT_PER_BATCH = 5;
const MAX_QUEUE = 200;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

interface ProjectAlertCfg {
  id: string;
  name: string;
  webhook: string | null;
  newIssue: number;
  regression: number;
  spikeThreshold: number | null;
  spikeMinutes: number;
  lastSpikeAt: string | null;
}

/**
 * Kirim alert Discord setelah batch event tersimpan.
 * Antrian kirim di memori, satu per satu, menghormati rate limit Discord (429 + retry_after).
 * Catatan: alert yang belum terkirim hilang kalau proses mati — event-nya sendiri tetap aman.
 */
export class Alerter {
  private queue: { url: string; msg: DiscordMessage }[] = [];
  private sending = false;
  sent = 0;
  dropped = 0;
  private cfg;
  private countSince;
  private markSpike;

  constructor(
    private db: RawDb,
    private opts: { webUrl: string; send?: Sender; log?: (msg: string, err?: unknown) => void },
  ) {
    this.cfg = db.prepare<[string], ProjectAlertCfg>(`SELECT id, name, discord_webhook_url AS webhook,
      alert_new_issue AS newIssue, alert_regression AS regression, alert_spike_threshold AS spikeThreshold,
      alert_spike_minutes AS spikeMinutes, last_spike_alert_at AS lastSpikeAt FROM projects WHERE id = ?`);
    this.countSince = db.prepare("SELECT COUNT(*) FROM events WHERE project_id = ? AND received_at >= ?").pluck();
    this.markSpike = db.prepare("UPDATE projects SET last_spike_alert_at = ? WHERE id = ?");
  }

  private get send() {
    return this.opts.send ?? discordSender;
  }

  issueUrl(projectId: string, issueId: string) {
    return `${this.opts.webUrl.replace(/\/$/, "")}/p/${projectId}/issues/${issueId}`;
  }

  /** Dipanggil setelah persistBatch commit. Tidak pernah throw. */
  onBatch(res: BatchResult, now = new Date()) {
    try {
      const byProject = new Map<string, IssueChange[]>();
      for (const c of res.changes) {
        const list = byProject.get(c.projectId);
        if (list) list.push(c);
        else byProject.set(c.projectId, [c]);
      }
      for (const pid of new Set([...byProject.keys(), ...res.projects])) {
        const cfg = this.cfg.get(pid);
        if (!cfg?.webhook) continue;
        const wanted = (byProject.get(pid) ?? []).filter((c) => (c.kind === "new" ? cfg.newIssue : cfg.regression));
        for (const c of wanted.slice(0, MAX_PER_PROJECT_PER_BATCH)) this.enqueue(cfg.webhook, this.issueMessage(cfg, c));
        if (wanted.length > MAX_PER_PROJECT_PER_BATCH) {
          const rest = wanted.length - MAX_PER_PROJECT_PER_BATCH;
          this.enqueue(cfg.webhook, {
            embeds: [{ title: `+${rest} more new/regressed issues in ${clip(cfg.name, 100)}`, url: `${this.opts.webUrl.replace(/\/$/, "")}/p/${pid}/issues`, color: COLORS.error }],
          });
        }
        if (cfg.spikeThreshold) this.checkSpike(cfg, now);
      }
    } catch (err) {
      this.opts.log?.("alert evaluation failed", err);
    }
  }

  private checkSpike(cfg: ProjectAlertCfg, now: Date) {
    const windowMs = cfg.spikeMinutes * 60_000;
    // Cooldown: minimal 30 menit atau satu jendela, supaya lonjakan panjang tidak spam.
    const cooldownMs = Math.max(windowMs, 30 * 60_000);
    if (cfg.lastSpikeAt && now.getTime() - new Date(cfg.lastSpikeAt).getTime() < cooldownMs) return;
    const n = this.countSince.get(cfg.id, toDbDate(new Date(now.getTime() - windowMs))) as number;
    if (n < cfg.spikeThreshold!) return;
    try {
      this.markSpike.run(toDbDate(now), cfg.id);
    } catch (err) {
      if (isBusy(err)) return; // dicoba lagi di batch berikutnya
      throw err;
    }
    this.enqueue(cfg.webhook!, {
      embeds: [{
        title: clip(`Error spike in ${cfg.name}`, 256),
        url: `${this.opts.webUrl.replace(/\/$/, "")}/p/${cfg.id}/issues`,
        description: `**${n.toLocaleString("en-US")} events** in the last ${cfg.spikeMinutes} min (threshold ${cfg.spikeThreshold!.toLocaleString("en-US")}).`,
        color: COLORS.spike,
        footer: { text: "BugTrail" },
        timestamp: now.toISOString(),
      }],
    });
  }

  private issueMessage(cfg: ProjectAlertCfg, c: IssueChange): DiscordMessage {
    const label = c.kind === "new" ? "New issue" : "Regression (resolved issue reappeared)";
    return {
      embeds: [{
        title: clip(c.title, 256),
        url: this.issueUrl(c.projectId, c.issueId),
        ...(c.culprit && { description: "`" + clip(c.culprit, 300) + "`" }),
        color: COLORS[c.level as keyof typeof COLORS] ?? COLORS.error,
        fields: [
          { name: "Project", value: clip(cfg.name, 100), inline: true },
          { name: "Type", value: label, inline: true },
          { name: "Level", value: c.level, inline: true },
        ],
        footer: { text: "BugTrail" },
        timestamp: new Date().toISOString(),
      }],
    };
  }

  private enqueue(url: string, msg: DiscordMessage) {
    if (this.queue.length >= MAX_QUEUE) {
      this.dropped++;
      return;
    }
    this.queue.push({ url, msg });
    void this.pump();
  }

  private async pump() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const item = this.queue[0]!;
        try {
          const r = await this.send(item.url, item.msg);
          if (r.status === 429 && r.retryAfterMs !== undefined) {
            await new Promise((res) => setTimeout(res, Math.min(r.retryAfterMs!, 60_000)));
            continue; // ulangi item yang sama
          }
          if (!r.ok) this.opts.log?.(`discord webhook responded ${r.status}`);
          else this.sent++;
        } catch (err) {
          this.opts.log?.("discord webhook failed", err);
        }
        this.queue.shift();
      }
    } finally {
      this.sending = false;
    }
  }

  /** Kirim pesan tes langsung (tombol "Kirim tes" di Setting). */
  async test(url: string, projectName: string) {
    return this.send(url, {
      embeds: [{ title: "BugTrail test alert ✅", description: `Webhook for project **${clip(projectName, 100)}** is working.`, color: COLORS.info, footer: { text: "BugTrail" } }],
    });
  }

  /** Tunggu antrian kirim kosong (test). */
  async idle() {
    while (this.queue.length || this.sending) await new Promise((r) => setTimeout(r, 5));
  }
}
