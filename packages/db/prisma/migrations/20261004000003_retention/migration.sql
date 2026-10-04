-- Retensi per project: simpan maksimal N event terbaru dan/atau event berumur <= D hari.
ALTER TABLE "projects" ADD COLUMN "retention_max_events" INTEGER NOT NULL DEFAULT 10000;
ALTER TABLE "projects" ADD COLUMN "retention_days" INTEGER NOT NULL DEFAULT 90;
