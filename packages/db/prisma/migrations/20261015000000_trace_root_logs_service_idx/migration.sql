-- Mode Lite: pencarian Traces membaca span root langsung (urut waktu) tanpa mengelompokkan semua trace,
-- dan filter service di Logs tidak memindai semua log (lihat apps/api/scripts/bench-sqlite).
CREATE INDEX IF NOT EXISTS "trace_spans_root_start" ON "trace_spans"("project_id", "start_us")
  WHERE "parent_span_id" IS NULL OR "parent_span_id" = '';
CREATE INDEX IF NOT EXISTS "logs_project_service_time" ON "logs"("project_id", "service", "time_us");
