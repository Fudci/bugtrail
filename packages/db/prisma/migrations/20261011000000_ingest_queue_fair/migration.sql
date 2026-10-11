-- Antrian adil: pemrosesan mengambil event tertua per project, jadi perlu indeks (project_id, id).
CREATE INDEX "ingest_queue_project_id_id_idx" ON "ingest_queue"("project_id", "id");
