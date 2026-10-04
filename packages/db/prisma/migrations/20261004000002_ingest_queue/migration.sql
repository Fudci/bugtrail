-- Antrian ingest yang tahan crash: event ditulis ke sini sebelum SDK dibalas 200,
-- lalu dihapus dalam transaksi yang sama dengan penyimpanan issue/event.
CREATE TABLE "ingest_queue" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "project_id" TEXT NOT NULL,
    "received_at" TEXT NOT NULL,
    "payload" TEXT NOT NULL
);

-- Release tempat issue pertama kali muncul (untuk halaman Releases: "issue baru di release ini").
ALTER TABLE "issues" ADD COLUMN "first_release" TEXT;
CREATE INDEX "issues_project_id_first_release_idx" ON "issues"("project_id", "first_release");
CREATE INDEX "events_project_id_release_idx" ON "events"("project_id", "release");
