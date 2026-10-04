import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client.js";

export * from "./generated/prisma/client.js";
export { migrate } from "./migrate.js";
export { isBusy, openRaw, toDbDate, type RawDb } from "./raw.js";

// DATABASE_URL: "file:/path/to/bugtool.db" (atau path biasa).
export function sqlitePath(url = process.env["DATABASE_URL"]) {
  if (!url) throw new Error("DATABASE_URL is not set");
  return url.replace(/^file:/, "");
}

export function createPrisma(url = process.env["DATABASE_URL"]) {
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlitePath(url) }) });
}

// WAL: pembaca tidak memblokir penulis. synchronous=NORMAL aman di WAL dan jauh lebih cepat.
// busy_timeout: tunggu lock alih-alih langsung gagal "database is locked".
export async function tunePrisma(prisma: PrismaClient) {
  await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await prisma.$queryRawUnsafe("PRAGMA synchronous = NORMAL");
  await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
  await prisma.$queryRawUnsafe("PRAGMA foreign_keys = ON");
}
