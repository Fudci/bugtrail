import { isBusy, type RawDb } from "@bugtool/db";
import { z } from "zod";
import { BUCKETS, percentile } from "../otlp/rollups.js";
import { parseStatusFilter, statusSql } from "../otlp/status-filter.js";
import type { Alerter, DiscordMessage } from "./alerts.js";

// Aturan alert per project (tabel alert_rules), dinilai tiap menit dari rollup API Health:
//  - status: jumlah request dengan kode tertentu (endpoint_status_rollups) sebagai persen atau jumlah;
//  - latency: persentil (p50/p95/p99) dari histogram endpoint_rollups.
// Satu webhook Discord per project. Cooldown 30 menit per aturan per endpoint (alert_rule_state).

const COOLDOWN_S = 30 * 60;
export const MAX_RULES = 20;
const HS = Array.from({ length: BUCKETS }, (_, i) => `h${i}`);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const fmt = (n: number) => n.toLocaleString("en-US");

export interface AlertRule {
  id: string; projectId: string; name: string; enabled: boolean;
  kind: "status" | "latency";
  statusFilter: string | null; mode: "pct" | "count"; percentile: 50 | 95 | 99 | null;
  threshold: number; windowMinutes: number; minRequests: number;
  method: string | null; route: string | null;
}

/** Body POST/PATCH aturan. Status filter memakai token yang sama dengan API Health (tanpa "all"/"error"). */
export const ruleBody = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  kind: z.enum(["status", "latency"]),
  statusFilter: z.string().max(200).nullable().optional(),
  mode: z.enum(["pct", "count"]).default("pct"),
  percentile: z.union([z.literal(50), z.literal(95), z.literal(99)]).nullable().optional(),
  threshold: z.number().positive().max(10_000_000),
  windowMinutes: z.number().int().min(1).max(60),
  minRequests: z.number().int().min(1).max(1_000_000).default(1),
  method: z.string().trim().min(1).max(16).nullable().optional(),
  route: z.string().min(1).max(300).nullable().optional(),
}).superRefine((r, ctx) => {
  if (r.kind === "status") {
    const f = parseStatusFilter(r.statusFilter ?? "");
    if (!r.statusFilter || !f || f.all) ctx.addIssue({ code: "custom", path: ["statusFilter"], message: "pick at least one status, e.g. 5xx or 403" });
    if (r.mode === "pct" && r.threshold > 100) ctx.addIssue({ code: "custom", path: ["threshold"], message: "percentage must be at most 100" });
  } else if (!r.percentile) {
    ctx.addIssue({ code: "custom", path: ["percentile"], message: "pick p50, p95 or p99" });
  }
  // Satu endpoint = method dan route keduanya diisi; semua endpoint = keduanya kosong.
  if (Boolean(r.method) !== Boolean(r.route)) ctx.addIssue({ code: "custom", path: ["route"], message: "set both method and route, or neither" });
});
export type RuleInput = z.infer<typeof ruleBody>;

/** Baris DB -> AlertRule. */
export function ruleOf(r: Record<string, unknown>): AlertRule {
  return {
    id: String(r["id"]), projectId: String(r["project_id"]), name: String(r["name"]), enabled: Number(r["enabled"]) === 1,
    kind: r["kind"] === "latency" ? "latency" : "status",
    statusFilter: (r["status_filter"] as string | null) ?? null, mode: r["mode"] === "count" ? "count" : "pct",
    percentile: r["percentile"] == null ? null : (Number(r["percentile"]) as 50 | 95 | 99),
    threshold: Number(r["threshold"]), windowMinutes: Number(r["window_minutes"]), minRequests: Number(r["min_requests"]),
    method: (r["method"] as string | null) ?? null, route: (r["route"] as string | null) ?? null,
  };
}

/** Ringkasan aturan untuk pesan dan UI, mis. "403 ≥ 20 requests in 5 min" atau "p95 ≥ 1,000 ms in 5 min". */
export function describeRule(r: Pick<AlertRule, "kind" | "statusFilter" | "mode" | "percentile" | "threshold" | "windowMinutes" | "minRequests">) {
  const cond = r.kind === "latency"
    ? `p${r.percentile} ≥ ${fmt(r.threshold)} ms`
    : r.mode === "pct" ? `${r.statusFilter} ≥ ${r.threshold}% of requests` : `${r.statusFilter} ≥ ${fmt(r.threshold)} requests`;
  const min = r.minRequests > 1 && !(r.kind === "status" && r.mode === "count") ? `, min ${fmt(r.minRequests)} requests` : "";
  return `${cond} in ${r.windowMinutes} min${min}`;
}

type Endpoint = { method: string; route: string; count: number } & Record<string, number>;
export type Hit = { method: string; route: string; count: number; value: number; topCodes?: string };

/** Pesan Discord untuk satu endpoint yang melanggar aturan (juga dipakai tombol "Send test"). */
export function ruleMessage(alerter: Alerter, rule: AlertRule, projectName: string, hit: Hit, now: Date): DiscordMessage {
  const desc = rule.kind === "latency"
    ? `**p${rule.percentile} ${fmt(hit.value >= 10_001 ? 10_000 : hit.value)}${hit.value >= 10_001 ? "+" : ""} ms** over ${fmt(hit.count)} requests in the last ${rule.windowMinutes} min (threshold ${fmt(rule.threshold)} ms).`
    : rule.mode === "pct"
      ? `**${Math.round(hit.value * 10) / 10}%** of ${fmt(hit.count)} requests matched \`${rule.statusFilter}\` in the last ${rule.windowMinutes} min (threshold ${rule.threshold}%).`
      : `**${fmt(hit.value)}** requests matched \`${rule.statusFilter}\` in the last ${rule.windowMinutes} min (threshold ${fmt(rule.threshold)}).`;
  const fields = [{ name: "Project", value: clip(projectName, 100), inline: true }, { name: "Rule", value: clip(rule.name, 100), inline: true }];
  if (hit.topCodes) fields.push({ name: "Status codes", value: hit.topCodes, inline: true });
  const query: Record<string, string> = { method: hit.method, route: hit.route };
  if (rule.kind === "status" && rule.statusFilter) query["status"] = rule.statusFilter;
  return {
    embeds: [{
      title: clip(`${rule.name}: ${hit.method} ${hit.route}`, 256),
      url: alerter.healthUrl(rule.projectId, query),
      description: desc,
      color: rule.kind === "latency" ? 0xf4cf4f : 0xe5484d,
      fields,
      footer: { text: "BugTrail" },
      timestamp: now.toISOString(),
    }],
  };
}

export class AlertRuleChecker {
  private timer: NodeJS.Timeout | null = null;
  private rules;
  private lastAt;
  private mark;
  private stmts = new Map<string, { all(...p: unknown[]): unknown[] }>();

  constructor(private db: RawDb, private alerter: Alerter, private log?: (m: string, e?: unknown) => void) {
    this.rules = db.prepare(`SELECT r.*, p.name AS project_name, p.discord_webhook_url AS webhook FROM alert_rules r
      JOIN projects p ON p.id = r.project_id WHERE r.enabled = 1 AND p.discord_webhook_url IS NOT NULL`);
    this.lastAt = db.prepare("SELECT last_alert_at FROM alert_rule_state WHERE rule_id = ? AND method = ? AND route = ?").pluck();
    this.mark = db.prepare(`INSERT INTO alert_rule_state (rule_id, method, route, last_alert_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (rule_id, method, route) DO UPDATE SET last_alert_at = excluded.last_alert_at`);
  }

  private stmt(sql: string) {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  /** Endpoint yang melanggar aturan dalam jendelanya. Semua service dijumlahkan per method + route. */
  evaluate(rule: AlertRule, nowS: number): Hit[] {
    // Menit lengkap terakhir + menit berjalan, sama dengan alert 5xx sebelumnya.
    const since = Math.floor((nowS - rule.windowMinutes * 60) / 60) * 60 + 60;
    const one = rule.method && rule.route ? " AND method = ? AND route = ?" : "";
    const ep = rule.method && rule.route ? [rule.method, rule.route] : [];
    const endpoints = this.stmt(`SELECT method, route, SUM(count) AS count, ${HS.map((h) => `SUM(${h}) AS ${h}`).join(", ")}
      FROM endpoint_rollups WHERE project_id = ? AND granularity = 'm' AND bucket >= ?${one} GROUP BY method, route`)
      .all(rule.projectId, since, ...ep) as Endpoint[];

    if (rule.kind === "latency") {
      return endpoints.flatMap((e) => {
        if (e.count < rule.minRequests) return [];
        const p = percentile(HS.map((h) => Number(e[h] ?? 0)), rule.percentile! / 100);
        return p !== null && p >= rule.threshold ? [{ method: e.method, route: e.route, count: e.count, value: p }] : [];
      });
    }

    const st = statusSql(parseStatusFilter(rule.statusFilter ?? "")!, "status", () => "?");
    const rows = this.stmt(`SELECT method, route, status, SUM(count) AS n FROM endpoint_status_rollups
      WHERE project_id = ? AND bucket >= ?${one} AND ${st.sql} GROUP BY method, route, status`)
      .all(rule.projectId, since, ...ep, ...st.params) as { method: string; route: string; status: number; n: number }[];
    const matched = new Map<string, { n: number; codes: [number, number][] }>();
    for (const r of rows) {
      const k = `${r.method} ${r.route}`;
      const m = matched.get(k) ?? { n: 0, codes: [] };
      m.n += r.n;
      m.codes.push([r.status, r.n]);
      matched.set(k, m);
    }
    return endpoints.flatMap((e) => {
      const m = matched.get(`${e.method} ${e.route}`);
      if (!m) return [];
      const topCodes = m.codes.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => `${c} × ${fmt(n)}`).join(", ");
      if (rule.mode === "count") return m.n >= rule.threshold ? [{ method: e.method, route: e.route, count: e.count, value: m.n, topCodes }] : [];
      if (e.count < rule.minRequests) return [];
      const pct = (m.n / e.count) * 100;
      return pct >= rule.threshold ? [{ method: e.method, route: e.route, count: e.count, value: pct, topCodes }] : [];
    });
  }

  /** Return jumlah alert yang diantrikan. Tidak pernah throw. */
  check(now = new Date()): number {
    let queued = 0;
    const nowS = Math.floor(now.getTime() / 1000);
    let rows: Record<string, unknown>[];
    try {
      rows = this.rules.all() as Record<string, unknown>[];
    } catch (err) {
      this.log?.("alert rule check failed", err);
      return 0;
    }
    for (const row of rows) {
      const rule = ruleOf(row);
      // Error per aturan dicatat lalu lanjut, agar satu aturan tidak menghentikan yang lain.
      try {
        for (const hit of this.evaluate(rule, nowS)) {
          const last = this.lastAt.get(rule.id, hit.method, hit.route) as number | undefined;
          if (last !== undefined && nowS - last < COOLDOWN_S) continue;
          try {
            this.mark.run(rule.id, hit.method, hit.route, nowS);
          } catch (err) {
            if (isBusy(err)) continue; // dicoba lagi menit berikutnya
            throw err;
          }
          this.alerter.notify(String(row["webhook"]), ruleMessage(this.alerter, rule, String(row["project_name"]), hit, now));
          queued++;
        }
      } catch (err) {
        this.log?.(`alert rule ${rule.id} check failed`, err);
      }
    }
    return queued;
  }

  start(intervalMs = 60_000) {
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
