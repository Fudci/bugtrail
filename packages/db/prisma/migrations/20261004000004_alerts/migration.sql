-- Alert Discord per project.
ALTER TABLE "projects" ADD COLUMN "discord_webhook_url" TEXT;
ALTER TABLE "projects" ADD COLUMN "alert_new_issue" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "projects" ADD COLUMN "alert_regression" BOOLEAN NOT NULL DEFAULT true;
-- Lonjakan: >= threshold event dalam spike_minutes menit. NULL = mati.
ALTER TABLE "projects" ADD COLUMN "alert_spike_threshold" INTEGER;
ALTER TABLE "projects" ADD COLUMN "alert_spike_minutes" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "projects" ADD COLUMN "last_spike_alert_at" TEXT;
