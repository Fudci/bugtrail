import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@bugtool/db";
import { projectRole } from "../auth/session.js";

// Dipakai bersama route dashboard telemetry (API Health, Services, Traces, Logs).

/** Rentang rollup (API Health, Services): panjang (detik) + ukuran bucket grafik. */
export const ROLLUP_RANGES = { "1h": { s: 3600, step: 60 }, "24h": { s: 86_400, step: 3600 }, "7d": { s: 7 * 86_400, step: 3600 } } as const;
export const rollupRange = z.enum(["1h", "24h", "7d"]).default("24h");

/** Rentang pencarian (Traces, Logs), detik. */
export const SEARCH_RANGES = { "15m": 900, "1h": 3600, "24h": 86_400, "7d": 7 * 86_400 } as const;
export const searchRange = z.enum(["15m", "1h", "24h", "7d"]).default("1h");

/** Baris $queryRawUnsafe: SQLite mengembalikan bigint untuk agregat; ubah ke number. */
export const numRow = <T>(x: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])) as T;

/** Validasi :id project + akses user; balas 404 dan return null kalau tidak valid atau tidak punya akses. */
export function projectIdFor(prisma: PrismaClient) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const id = z.uuid().safeParse((req.params as { id?: string }).id);
    if (!id.success || !(await projectRole(prisma, req.user!, id.data))) {
      await reply.code(404).send({ detail: "not found" });
      return null;
    }
    return id.data;
  };
}
