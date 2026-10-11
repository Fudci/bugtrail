-- Index jendela waktu span server (daftar request, top errors, pencarian trace).
CREATE INDEX IF NOT EXISTS "trace_spans_project_id_kind_start_us_idx" ON "trace_spans"("project_id","kind","start_us");
