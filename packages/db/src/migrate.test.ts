import { mkdtempSync, mkdirSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "./migrate.js";

const ALL = join(import.meta.dirname, "../prisma/migrations");
const USERNAMES = "20261014000000_usernames";

// Folder migrasi sampai (tidak termasuk) `stop`, untuk membuat DB "versi lama".
function migrationsBefore(stop: string) {
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  for (const d of readdirSync(ALL, { withFileTypes: true })) {
    if (d.isDirectory() && d.name < stop) cpSync(join(ALL, d.name), join(dir, d.name), { recursive: true });
  }
  return dir;
}

describe("usernames migration (rebuilds users with foreign keys off)", () => {
  it("keeps members, sessions and invites, and derives unique usernames from emails", () => {
    const dir = mkdtempSync(join(tmpdir(), "db-"));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "t.db");
    migrate(file, migrationsBefore(USERNAMES));
    const db = new Database(file);
    db.exec(`INSERT INTO organizations (id, name, slug) VALUES ('o', 'O', 'o');
      INSERT INTO projects (id, organization_id, name, slug) VALUES ('p', 'o', 'P', 'p');
      INSERT INTO users (id, email) VALUES ('u1', 'Andi@a.io'), ('u2', 'andi@b.io'), ('u3', 'x@c.io');
      INSERT INTO members (project_id, user_id, role) VALUES ('p', 'u1', 'admin'), ('p', 'u2', 'member'), ('p', 'u3', 'viewer');
      INSERT INTO sessions (id, user_id, expires_at) VALUES ('s1', 'u1', '2099-01-01');
      INSERT INTO invites (id, project_id, email, token_hash, invited_by_id, expires_at) VALUES ('i1', 'p', 'z@d.io', 'h', 'u1', '2099-01-01');`);
    db.close();

    expect(migrate(file, ALL)).toContain(USERNAMES);
    const after = new Database(file);
    expect(after.prepare("SELECT id, username, email FROM users ORDER BY id").all()).toEqual([
      { id: "u1", username: "andi", email: "Andi@a.io" },
      { id: "u2", username: "andi-2", email: "andi@b.io" },
      { id: "u3", username: "x", email: "x@c.io" },
    ]);
    expect(after.prepare("SELECT COUNT(*) FROM members").pluck().get()).toBe(3);
    expect(after.prepare("SELECT COUNT(*) FROM sessions").pluck().get()).toBe(1);
    expect(after.prepare("SELECT COUNT(*) FROM invites").pluck().get()).toBe(1);
    expect(after.pragma("foreign_key_check")).toEqual([]);
    expect(after.pragma("foreign_keys", { simple: true })).toBe(1);
    // Email sekarang opsional, username wajib dan unik.
    after.prepare("INSERT INTO users (id, username) VALUES ('u4', 'nomail')").run();
    expect(() => after.prepare("INSERT INTO users (id, username) VALUES ('u5', 'nomail')").run()).toThrow(/UNIQUE/);
    after.close();
  });
});
