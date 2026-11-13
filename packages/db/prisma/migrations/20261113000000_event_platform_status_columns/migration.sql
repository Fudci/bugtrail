-- Platform & status HTTP event sebagai kolom biasa, diisi sekali saat event masuk (lihat process/normalize.ts).
-- Sebelumnya dihitung dari JSON payload saat dibaca: payload mobile ~30 KB, sehingga kartu Platforms di Overview
-- mengurai seluruh event tiap kali dibuka (~20 detik untuk 10 ribu event di VPS kecil) dan menahan server.

-- Kolom generated VIRTUAL dari migrasi 20261027000000 diganti kolom biasa.
DROP INDEX IF EXISTS "events_project_http_status";
ALTER TABLE "events" DROP COLUMN "http_status";
ALTER TABLE "events" ADD COLUMN "http_status" INTEGER;
-- Nama OS dari SDK, atau field platform kalau OS tidak dikirim. NULL = tidak diketahui.
ALTER TABLE "events" ADD COLUMN "platform" TEXT;

-- Isi event lama sekali (aturan sama dengan normalize.ts untuk tags berbentuk object).
UPDATE "events" SET
  "platform" = substr(coalesce(nullif(json_extract("payload", '$.contexts.os.name'), ''), nullif(json_extract("payload", '$.platform'), '')), 1, 100),
  "http_status" = (SELECT CASE WHEN s BETWEEN 100 AND 599 THEN s END FROM (SELECT CAST(coalesce(
      json_extract("payload", '$.tags.status'), json_extract("payload", '$.tags."http.status_code"'),
      json_extract("payload", '$.contexts.response.status_code')) AS INTEGER) AS s));

-- Overview: hitungan per platform / status dalam rentang waktu tanpa membaca baris event (covering).
CREATE INDEX "events_project_received_platform" ON "events"("project_id", "received_at", "platform", "http_status", "level");
-- Filter status: issue yang punya event dengan status tertentu, langsung dari index.
CREATE INDEX "events_project_http_status" ON "events"("project_id", "http_status", "issue_id") WHERE "http_status" IS NOT NULL;
-- Tab "All" di Issues (tanpa filter status): urutan last_seen langsung dari index.
CREATE INDEX "issues_project_id_last_seen_idx" ON "issues"("project_id", "last_seen" DESC, "id" DESC);
