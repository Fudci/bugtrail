import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

// Migrator kecil: menjalankan prisma/migrations/*/migration.sql yang belum pernah dijalankan.
// Dipakai saat container start, supaya image tidak perlu membawa CLI Prisma.
const defaultDir = () => join(dirname(fileURLToPath(import.meta.url)), "../prisma/migrations");

export function migrate(dbPath: string, migrationsDir = process.env["MIGRATIONS_DIR"] ?? defaultDir()) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    // auto_vacuum=INCREMENTAL supaya ruang dari data yang dihapus (retensi) bisa dikembalikan ke disk.
    // Hanya berlaku untuk DB baru atau setelah VACUUM, jadi lakukan sekali sebelum masuk WAL.
    if (db.pragma("auto_vacuum", { simple: true }) !== 2) {
      db.pragma("auto_vacuum = INCREMENTAL");
      db.exec("VACUUM");
    }
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS _bugtool_migrations (
      name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const done = new Set(db.prepare("SELECT name FROM _bugtool_migrations").pluck().all() as string[]);
    const pending = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !done.has(d.name))
      .map((d) => d.name)
      .sort();
    for (const name of pending) {
      const sql = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8");
      db.transaction(() => {
        db.exec(sql);
        db.prepare("INSERT INTO _bugtool_migrations (name) VALUES (?)").run(name);
      })();
    }
    return pending;
  } finally {
    db.close();
  }
}
