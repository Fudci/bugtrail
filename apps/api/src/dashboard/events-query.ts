import { z } from "zod";
import { Prisma, type PrismaClient } from "@bugtool/db";
import { parseStatusFilter, type StatusFilter } from "../otlp/status-filter.js";
import { toCsv } from "./csv.js";

// Filter status HTTP event (?http=409,5xx,520-529), aturan token sama dengan Traces/API Health.
export const httpParam = z
  .string()
  .max(200)
  .optional()
  .transform((s, ctx): StatusFilter | undefined => {
    const f = parseStatusFilter(s);
    if (!f) {
      ctx.addIssue({ code: "custom", message: "invalid http status filter" });
      return z.NEVER;
    }
    return f.all ? undefined : f;
  });

// Kolom events.http_status (generated, lihat migrasi 20261027000000_event_http_status).
export function httpStatusSql(f: StatusFilter, alias = "") {
  const col = Prisma.raw(`${alias}http_status`);
  return Prisma.sql`(${Prisma.join(f.ranges.map(([lo, hi]) => Prisma.sql`${col} BETWEEN ${lo} AND ${hi}`), " OR ")})`;
}

// Query FTS5 dari input user: tiap kata jadi prefix-term yang di-quote, supaya input tidak bisa membentuk
// sintaks FTS (mis. "user.id" atau tanda kutip) yang membuat query error. null = tidak ada kata.
export function ftsMatch(query: string) {
  const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8) ?? [];
  return terms.length ? terms.map((t) => `"${t}"*`).join(" ") : null;
}

export interface EventMatch { query?: string | undefined; http?: StatusFilter | undefined }

// Kondisi tambahan untuk event: cocok dengan pencarian (isi event atau user ID persis) dan status HTTP.
export function eventMatchSql(f: EventMatch, alias = "") {
  const parts: Prisma.Sql[] = [];
  if (f.query) {
    const match = ftsMatch(f.query);
    const byUser = Prisma.sql`${Prisma.raw(`${alias}user_id`)} = ${f.query}`;
    parts.push(match
      ? Prisma.sql`(${Prisma.raw(`${alias}id`)} IN (SELECT event_id FROM events_fts WHERE events_fts MATCH ${match}) OR ${byUser})`
      : byUser);
  }
  if (f.http) parts.push(httpStatusSql(f.http, alias));
  return parts.length ? Prisma.join(parts, " AND ") : Prisma.sql`1=1`;
}

// Jumlah event per status HTTP (untuk chip filter), event tanpa status tidak dihitung.
export async function httpStatusCounts(prisma: PrismaClient, where: Prisma.Sql) {
  const rows = await prisma.$queryRaw<{ code: number; n: bigint | number }[]>`
    SELECT http_status AS code, COUNT(*) AS n FROM events WHERE ${where} AND http_status IS NOT NULL GROUP BY http_status`;
  return rows.map((r) => ({ code: Number(r.code), count: Number(r.n) }));
}

const EVENTS_EXPORT_MAX = 50_000;

// CSV satu baris per event (untuk menelusuri kasus per user/device). where memakai alias "e.".
export async function eventsCsv(prisma: PrismaClient, projectId: string, where: Prisma.Sql) {
  const rows = await prisma.$queryRaw<Record<string, string | number | null>[]>`
    SELECT e.id, e.received_at, e.issue_id, i.title, e.level, e.http_status,
      json_extract(e.payload, '$.tags.method') AS method, json_extract(e.payload, '$.tags.route') AS route,
      e.user_id, e.release, e.environment,
      trim(coalesce(json_extract(e.payload, '$.contexts.os.name'), '') || ' ' || coalesce(json_extract(e.payload, '$.contexts.os.version'), '')) AS os,
      trim(coalesce(json_extract(e.payload, '$.contexts.device.manufacturer'), '') || ' ' || coalesce(json_extract(e.payload, '$.contexts.device.model'), '')) AS device,
      json_extract(e.payload, '$.contexts.device.connection_type') AS connection,
      coalesce(json_extract(e.payload, '$.exception.values[#-1].value'), json_extract(e.payload, '$.logentry.formatted'),
               json_extract(e.payload, '$.logentry.message'), json_extract(e.payload, '$.message')) AS message
    FROM events e JOIN issues i ON i.id = e.issue_id
    WHERE e.project_id = ${projectId} AND ${where}
    ORDER BY e.received_at DESC LIMIT ${EVENTS_EXPORT_MAX}`;
  const web = (process.env["WEB_URL"] ?? process.env["PUBLIC_URL"] ?? "").replace(/\/$/, "");
  const s = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? undefined : v);
  return toCsv(
    ["event_id", "received_at", "issue_id", "issue_title", "level", "http_status", "method", "route", "user_id", "release", "environment", "os", "device", "connection", "message", "url"],
    rows.map((r) => [
      r["id"], new Date(String(r["received_at"])).toISOString(), r["issue_id"], r["title"], r["level"], s(r["http_status"]),
      s(r["method"]), s(r["route"]), s(r["user_id"]), s(r["release"]), s(r["environment"]), s(r["os"]), s(r["device"]), s(r["connection"]),
      s(r["message"]), `${web}/p/${projectId}/issues/${r["issue_id"]}?event=${r["id"]}`,
    ]),
  );
}
