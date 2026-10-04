import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../packages/db/src/migrate.js";

// File SQLite baru per run test, supaya data dev tidak tersentuh.
let dir: string;

export function setup() {
  dir = mkdtempSync(join(tmpdir(), "bugtool-test-"));
  const file = join(dir, "test.db");
  migrate(file, join(import.meta.dirname, "../packages/db/prisma/migrations"));
  process.env["TEST_DATABASE_URL"] = `file:${file}`;
}

export function teardown() {
  rmSync(dir, { recursive: true, force: true });
}
