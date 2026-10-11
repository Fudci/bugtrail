-- Endpoint per service: kolom service (service.name dari resource OTLP, '' = tidak diketahui) masuk ke primary key,
-- supaya route yang sama di dua service tidak tergabung. Query API Health tetap menjumlah semua service.
-- SQLite tidak bisa mengubah primary key: tabel dibuat ulang, data lama masuk sebagai service ''.
CREATE TABLE "endpoint_rollups_new" (
  "project_id" TEXT NOT NULL,
  "granularity" TEXT NOT NULL,
  "bucket" INTEGER NOT NULL,
  "service" TEXT NOT NULL DEFAULT '',
  "method" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "c2xx" INTEGER NOT NULL DEFAULT 0,
  "c4xx" INTEGER NOT NULL DEFAULT 0,
  "c5xx" INTEGER NOT NULL DEFAULT 0,
  "dur_sum_us" INTEGER NOT NULL DEFAULT 0,
  "dur_max_us" INTEGER NOT NULL DEFAULT 0,
  "h0" INTEGER NOT NULL DEFAULT 0, "h1" INTEGER NOT NULL DEFAULT 0, "h2" INTEGER NOT NULL DEFAULT 0,
  "h3" INTEGER NOT NULL DEFAULT 0, "h4" INTEGER NOT NULL DEFAULT 0, "h5" INTEGER NOT NULL DEFAULT 0,
  "h6" INTEGER NOT NULL DEFAULT 0, "h7" INTEGER NOT NULL DEFAULT 0, "h8" INTEGER NOT NULL DEFAULT 0,
  "h9" INTEGER NOT NULL DEFAULT 0, "h10" INTEGER NOT NULL DEFAULT 0, "h11" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("project_id", "granularity", "bucket", "service", "method", "route"),
  FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE
) WITHOUT ROWID;
INSERT INTO "endpoint_rollups_new" ("project_id", "granularity", "bucket", "service", "method", "route", "count", "c2xx", "c4xx", "c5xx",
  "dur_sum_us", "dur_max_us", "h0", "h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9", "h10", "h11")
SELECT "project_id", "granularity", "bucket", '', "method", "route", "count", "c2xx", "c4xx", "c5xx",
  "dur_sum_us", "dur_max_us", "h0", "h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9", "h10", "h11" FROM "endpoint_rollups";
DROP TABLE "endpoint_rollups";
ALTER TABLE "endpoint_rollups_new" RENAME TO "endpoint_rollups";
