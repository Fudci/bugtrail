-- Status HTTP per event untuk filter Overview/Issues (mis. 409, 500, 502), sebagai kolom generated VIRTUAL:
-- tidak menambah ukuran baris dan berlaku juga untuk event lama. Sumber: tag "status" / "http.status_code"
-- (tags berbentuk object, bentuk standar SDK) atau contexts.response.status_code. Di luar 100-599 = NULL.
ALTER TABLE "events" ADD COLUMN "http_status" INTEGER GENERATED ALWAYS AS (
  CASE WHEN CAST(coalesce(json_extract("payload", '$.tags.status'), json_extract("payload", '$.tags."http.status_code"'),
                          json_extract("payload", '$.contexts.response.status_code')) AS INTEGER) BETWEEN 100 AND 599
       THEN CAST(coalesce(json_extract("payload", '$.tags.status'), json_extract("payload", '$.tags."http.status_code"'),
                          json_extract("payload", '$.contexts.response.status_code')) AS INTEGER) END) VIRTUAL;

-- Filter status dalam rentang waktu project (Overview, Issues, chip jumlah per kode).
CREATE INDEX "events_project_http_status" ON "events"("project_id", "http_status", "received_at") WHERE "http_status" IS NOT NULL;
