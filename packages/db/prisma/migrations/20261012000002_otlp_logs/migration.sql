-- OTLP logs. Mode Lite: disimpan di tabel logs (retensi OTLP_LOG_RETENTION_DAYS, default 3 hari, dari waktu terima).
-- Mode Scale: ditulis lewat log_queue (antrian di disk, sama dengan span_queue) ke ClickHouse.
-- time_us = waktu log (time_unix_nano, atau observed_time_unix_nano kalau kosong), mikrodetik.
-- received_at = waktu terima (epoch detik), dasar retensi.
CREATE TABLE "logs" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "project_id" TEXT NOT NULL,
  "time_us" INTEGER NOT NULL,
  "received_at" INTEGER NOT NULL,
  "severity_number" INTEGER NOT NULL DEFAULT 0,
  "severity_text" TEXT,
  "service" TEXT,
  "body" TEXT NOT NULL,
  "attributes" TEXT NOT NULL DEFAULT '{}',
  "resource" TEXT NOT NULL DEFAULT '{}',
  "trace_id" TEXT,
  "span_id" TEXT,
  FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE
);
CREATE INDEX "logs_project_time" ON "logs" ("project_id", "time_us");
CREATE INDEX "logs_project_trace" ON "logs" ("project_id", "trace_id") WHERE "trace_id" IS NOT NULL;
CREATE INDEX "logs_received" ON "logs" ("received_at");

CREATE TABLE "log_queue" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "span_count" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Kuota log per project per menit (NULL = tanpa batas) dan log yang dibuang karena kuota.
ALTER TABLE "projects" ADD COLUMN "quota_logs_per_min" INTEGER DEFAULT 6000;
ALTER TABLE "quota_drops" ADD COLUMN "logs" INTEGER NOT NULL DEFAULT 0;
