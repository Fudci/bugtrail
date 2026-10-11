-- API Health: rollup request per endpoint (span server OTLP). granularity 'm' = per menit, 'h' = per jam.
-- bucket = awal periode (epoch detik). h0..h11 = histogram latensi (batas: 5,10,25,50,100,250,500,1000,2500,5000,10000 ms, +Inf).
CREATE TABLE "endpoint_rollups" (
  "project_id" TEXT NOT NULL,
  "granularity" TEXT NOT NULL,
  "bucket" INTEGER NOT NULL,
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
  PRIMARY KEY ("project_id", "granularity", "bucket", "method", "route"),
  FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE
) WITHOUT ROWID;

-- Alert rasio 5xx per endpoint. NULL = mati.
ALTER TABLE "projects" ADD COLUMN "alert_5xx_pct" REAL;
ALTER TABLE "projects" ADD COLUMN "alert_5xx_minutes" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "projects" ADD COLUMN "alert_5xx_min_requests" INTEGER NOT NULL DEFAULT 20;

CREATE TABLE "endpoint_alert_state" (
  "project_id" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "last_alert_at" INTEGER NOT NULL,
  PRIMARY KEY ("project_id", "method", "route"),
  FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE
) WITHOUT ROWID;
