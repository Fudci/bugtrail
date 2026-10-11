-- Jumlah request per kode status HTTP per endpoint per menit, untuk aturan alert kode persis (mis. 403).
-- Hanya per menit; disimpan beberapa jam (retention.ts), cukup untuk jendela alert (maks 60 menit).
CREATE TABLE "endpoint_status_rollups" (
  "project_id" TEXT NOT NULL,
  "bucket" INTEGER NOT NULL,
  "service" TEXT NOT NULL DEFAULT '',
  "method" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "status" INTEGER NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("project_id", "bucket", "service", "method", "route", "status"),
  FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE
) WITHOUT ROWID;

-- Aturan alert per project (dikirim ke webhook Discord project).
-- kind 'status': status_filter (token seperti di API Health: "5xx", "403", "520-529"),
--   mode 'pct' (threshold = persen dari request) atau 'count' (threshold = jumlah request).
-- kind 'latency': percentile (50/95/99) >= threshold (ms).
-- method/route NULL = semua endpoint. min_requests: minimal request di jendela sebelum aturan dinilai.
CREATE TABLE "alert_rules" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "project_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "enabled" INTEGER NOT NULL DEFAULT 1,
  "kind" TEXT NOT NULL,
  "status_filter" TEXT,
  "mode" TEXT NOT NULL DEFAULT 'pct',
  "percentile" INTEGER,
  "threshold" REAL NOT NULL,
  "window_minutes" INTEGER NOT NULL,
  "min_requests" INTEGER NOT NULL DEFAULT 1,
  "method" TEXT,
  "route" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE
);
CREATE INDEX "alert_rules_project" ON "alert_rules" ("project_id");

-- Cooldown per aturan per endpoint.
CREATE TABLE "alert_rule_state" (
  "rule_id" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "last_alert_at" INTEGER NOT NULL,
  PRIMARY KEY ("rule_id", "method", "route"),
  FOREIGN KEY ("rule_id") REFERENCES "alert_rules" ("id") ON DELETE CASCADE
) WITHOUT ROWID;

-- Alert "Endpoint 5xx rate" lama menjadi aturan pertama (kolom alert_5xx_* tidak dipakai lagi).
INSERT INTO "alert_rules" ("id", "project_id", "name", "enabled", "kind", "status_filter", "mode", "threshold", "window_minutes", "min_requests")
SELECT lower(hex(randomblob(16))), "id", '5xx rate', 1, 'status', '5xx', 'pct', "alert_5xx_pct", "alert_5xx_minutes", "alert_5xx_min_requests"
FROM "projects" WHERE "alert_5xx_pct" IS NOT NULL;
