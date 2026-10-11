import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@bugtool/db";
import { projectRole, requireUser } from "../auth/session.js";
import { describeRule, MAX_RULES, ruleBody, ruleMessage, ruleOf, type AlertRule } from "../process/alert-rules.js";
import type { Alerter } from "../process/alerts.js";

// Aturan alert (Settings → Discord alerts), hanya admin project. Webhook tetap satu per project.
const ruleId = z.string().regex(/^[0-9a-f-]{32,36}$/);
const errText = (e: z.ZodError) => e.issues.map((i) => i.message).join("; ");

export async function alertRuleRoutes(app: FastifyInstance, { prisma, alerter }: { prisma: PrismaClient; alerter?: Alerter | undefined }) {
  app.addHook("preHandler", requireUser);

  async function adminProject(req: FastifyRequest, reply: FastifyReply) {
    const id = z.uuid().safeParse((req.params as { id?: string }).id);
    if (!id.success || (await projectRole(prisma, req.user!, id.data, "admin")) !== "admin") {
      await reply.code(404).send({ detail: "not found" });
      return null;
    }
    return id.data;
  }

  const list = async (pid: string) => (await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    "SELECT * FROM alert_rules WHERE project_id = ? ORDER BY rowid", pid)).map(ruleOf);
  const one = async (pid: string, rid: string) => (await list(pid)).find((r) => r.id === rid) ?? null;
  const view = (r: AlertRule) => ({ ...r, projectId: undefined, summary: describeRule(r) });

  // Simpan hanya kolom yang relevan untuk jenis aturannya.
  const columns = (b: z.infer<typeof ruleBody>) => [
    b.name, b.enabled ? 1 : 0, b.kind,
    b.kind === "status" ? b.statusFilter!.trim().toLowerCase().replace(/\s+/g, "") : null,
    b.kind === "status" ? b.mode : "pct",
    b.kind === "latency" ? b.percentile! : null,
    b.threshold, b.windowMinutes, b.minRequests, b.method ? b.method.toUpperCase() : null, b.route ?? null,
  ];

  app.get("/projects/:id/alert-rules", async (req, reply) => {
    const pid = await adminProject(req, reply);
    if (!pid) return reply;
    return { rules: (await list(pid)).map(view), max: MAX_RULES };
  });

  app.post("/projects/:id/alert-rules", async (req, reply) => {
    const pid = await adminProject(req, reply);
    if (!pid) return reply;
    const b = ruleBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ detail: errText(b.error) });
    if ((await list(pid)).length >= MAX_RULES) return reply.code(400).send({ detail: `at most ${MAX_RULES} alert rules per project` });
    const id = randomUUID();
    await prisma.$executeRawUnsafe(`INSERT INTO alert_rules (id, project_id, name, enabled, kind, status_filter, mode, percentile, threshold,
      window_minutes, min_requests, method, route) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, pid, ...columns(b.data));
    return reply.code(201).send(view((await one(pid, id))!));
  });

  app.put("/projects/:id/alert-rules/:rid", async (req, reply) => {
    const pid = await adminProject(req, reply);
    if (!pid) return reply;
    const rid = ruleId.safeParse((req.params as { rid?: string }).rid);
    if (!rid.success || !(await one(pid, rid.data))) return reply.code(404).send({ detail: "not found" });
    const b = ruleBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ detail: errText(b.error) });
    await prisma.$executeRawUnsafe(`UPDATE alert_rules SET name = ?, enabled = ?, kind = ?, status_filter = ?, mode = ?, percentile = ?,
      threshold = ?, window_minutes = ?, min_requests = ?, method = ?, route = ? WHERE id = ? AND project_id = ?`, ...columns(b.data), rid.data, pid);
    // Aturan berubah: cooldown lama tidak berlaku lagi.
    await prisma.$executeRawUnsafe("DELETE FROM alert_rule_state WHERE rule_id = ?", rid.data);
    return view((await one(pid, rid.data))!);
  });

  app.delete("/projects/:id/alert-rules/:rid", async (req, reply) => {
    const pid = await adminProject(req, reply);
    if (!pid) return reply;
    const rid = ruleId.safeParse((req.params as { rid?: string }).rid);
    if (!rid.success) return reply.code(404).send({ detail: "not found" });
    const n = await prisma.$executeRawUnsafe("DELETE FROM alert_rules WHERE id = ? AND project_id = ?", rid.data, pid);
    return n ? reply.code(204).send() : reply.code(404).send({ detail: "not found" });
  });

  // Kirim contoh pesan aturan ke webhook project (data contoh, tidak mengubah cooldown).
  app.post("/projects/:id/alert-rules/:rid/test", async (req, reply) => {
    const pid = await adminProject(req, reply);
    if (!pid) return reply;
    const rid = ruleId.safeParse((req.params as { rid?: string }).rid);
    const rule = rid.success ? await one(pid, rid.data) : null;
    if (!rule) return reply.code(404).send({ detail: "not found" });
    const p = await prisma.project.findUniqueOrThrow({ where: { id: pid }, select: { name: true, discordWebhookUrl: true } });
    if (!p.discordWebhookUrl || !alerter) return reply.code(400).send({ detail: "set a Discord webhook first" });
    // Contoh tepat di ambang aturan, untuk endpoint aturan atau endpoint contoh.
    const sample = { method: rule.method ?? "GET", route: rule.route ?? "/example", count: Math.max(rule.minRequests, 100), value: rule.threshold,
      ...(rule.kind === "status" ? { topCodes: `${rule.statusFilter} (example)` } : {}) };
    const msg = ruleMessage(alerter, rule, p.name, sample, new Date());
    msg.embeds[0]!.title = `[Test] ${msg.embeds[0]!.title}`;
    const r = await alerter.sendNow(p.discordWebhookUrl, msg);
    return r.ok ? { ok: true } : reply.code(502).send({ detail: `Discord answered ${r.status}` });
  });
}
