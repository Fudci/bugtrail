-- Kuota ingest per project per menit. NULL = tanpa batas.
ALTER TABLE "projects" ADD COLUMN "quota_events_per_min" INTEGER DEFAULT 6000;
ALTER TABLE "projects" ADD COLUMN "quota_spans_per_min" INTEGER DEFAULT 600000;

-- Data yang dibuang karena melewati kuota, per project per jam (hour = awal jam, epoch detik).
CREATE TABLE "quota_drops" (
  "project_id" TEXT NOT NULL,
  "hour" INTEGER NOT NULL,
  "events" INTEGER NOT NULL DEFAULT 0,
  "spans" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("project_id", "hour"),
  FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE
) WITHOUT ROWID;

-- Span OTLP yang diterima per project per jam (grafik pemakaian di Setting).
CREATE TABLE "span_usage" (
  "project_id" TEXT NOT NULL,
  "hour" INTEGER NOT NULL,
  "spans" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("project_id", "hour"),
  FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE
) WITHOUT ROWID;
