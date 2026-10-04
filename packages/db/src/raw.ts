import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type RawDb = Database.Database;

// Koneksi better-sqlite3 langsung untuk jalur ingest (sinkron, tanpa overhead Prisma).
// busy_timeout = 0: JANGAN menunggu lock secara sinkron — itu memblokir event loop sementara
// transaksi Prisma (yang memegang lock) butuh event loop untuk selesai → deadlock.
// Pemanggil menangkap SQLITE_BUSY dan mencoba lagi secara async (lihat isBusy).
export function openRaw(path: string): RawDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 0");
  return db;
}

export const isBusy = (err: unknown) =>
  typeof err === "object" && err !== null && "code" in err &&
  ((err as { code: string }).code === "SQLITE_BUSY" || (err as { code: string }).code === "SQLITE_LOCKED");

// Format tanggal yang dipakai Prisma di SQLite (iso8601 dengan offset +00:00).
// Tulis dengan format yang sama supaya perbandingan teks/urutan tetap benar.
export const toDbDate = (d: Date) => d.toISOString().replace("Z", "+00:00");
