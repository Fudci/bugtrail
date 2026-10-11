-- Alert "ongoing errors": selama sebuah issue terus menerima event, kirim ringkasan per interval.
-- alert_ongoing_seconds NULL = mati; 30, 60, 300 atau 900. alert_ongoing_backoff = 1: setelah 10 menit
-- berlangsung, interval naik ke 15 menit.
ALTER TABLE "projects" ADD COLUMN "alert_ongoing_seconds" INTEGER;
ALTER TABLE "projects" ADD COLUMN "alert_ongoing_backoff" BOOLEAN NOT NULL DEFAULT true;

-- Episode per issue: mulai saat event pertama setelah sepi, selesai saat satu interval tanpa event.
CREATE TABLE "ongoing_alert_state" (
  "issue_id" TEXT NOT NULL PRIMARY KEY,
  "started_at" INTEGER NOT NULL,
  "last_sent_at" INTEGER NOT NULL,
  "last_check_at" INTEGER NOT NULL,
  FOREIGN KEY ("issue_id") REFERENCES "issues" ("id") ON DELETE CASCADE
);
