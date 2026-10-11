-- Mode Lite: query dashboard tanpa mengurai JSON per baris (lihat apps/api/scripts/bench-sqlite).
-- Query SQLite sinkron, jadi query lambat menahan seluruh server.

-- Method/route/status HTTP sebagai kolom generated VIRTUAL (aturan sama dengan endpointKey di rollups.ts).
-- Tidak menambah ukuran baris; nilainya disimpan di index di bawah, jadi query membaca index, bukan JSON.
ALTER TABLE "trace_spans" ADD COLUMN "http_method" TEXT GENERATED ALWAYS AS (
  upper(substr(coalesce(nullif(json_extract("attributes", '$."http.request.method"'), ''), nullif(json_extract("attributes", '$."http.method"'), ''), '*'), 1, 16))) VIRTUAL;
ALTER TABLE "trace_spans" ADD COLUMN "http_route" TEXT GENERATED ALWAYS AS (
  substr(coalesce(nullif(json_extract("attributes", '$."http.route"'), ''), "name"), 1, 300)) VIRTUAL;
ALTER TABLE "trace_spans" ADD COLUMN "http_status" INTEGER GENERATED ALWAYS AS (
  CAST(coalesce(json_extract("attributes", '$."http.response.status_code"'), json_extract("attributes", '$."http.status_code"')) AS INTEGER)) VIRTUAL;

-- API Health: request satu endpoint dalam jendela waktu, dengan status (covering untuk hitungan per status).
CREATE INDEX IF NOT EXISTS "trace_spans_endpoint" ON "trace_spans"("project_id", "http_method", "http_route", "start_us", "http_status")
  WHERE "kind" = 2;
-- Traces: index root dari migrasi sebelumnya diganti dengan versi yang juga memuat status (untuk chip status).
DROP INDEX IF EXISTS "trace_spans_root_start";
CREATE INDEX "trace_spans_root_start" ON "trace_spans"("project_id", "start_us", "http_status")
  WHERE "parent_span_id" IS NULL OR "parent_span_id" = '';
-- Kandidat orphan (span server yang punya parent, root-nya mungkin tidak tersimpan): biasanya hampir kosong.
CREATE INDEX IF NOT EXISTS "trace_spans_child_server_start" ON "trace_spans"("project_id", "start_us")
  WHERE "kind" = 2 AND "parent_span_id" IS NOT NULL AND "parent_span_id" != '';
