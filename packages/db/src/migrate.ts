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
      // Membuat ulang tabel yang dirujuk tabel lain (mis. users) harus dengan foreign key mati, kalau tidak
      // DROP TABLE ikut menghapus baris anak (ON DELETE CASCADE). PRAGMA ini tidak berlaku di dalam transaksi,
      // jadi diset di luar, lalu integritas dicek sebelum commit (https://www.sqlite.org/lang_altertable.html).
      const fkOff = sql.startsWith("-- bugtool:foreign-keys-off");
      if (fkOff) db.pragma("foreign_keys = OFF");
      try {
        db.transaction(() => {
          db.exec(sql);
          if (fkOff) {
            const bad = db.pragma("foreign_key_check") as unknown[];
            if (bad.length) throw new Error(`migration ${name} broke ${bad.length} foreign key references`);
          }
          db.prepare("INSERT INTO _bugtool_migrations (name) VALUES (?)").run(name);
        })();
      } finally {
        if (fkOff) db.pragma("foreign_keys = ON");
      }
    }
    return pending;
  } finally {
    db.close();
  }
}
