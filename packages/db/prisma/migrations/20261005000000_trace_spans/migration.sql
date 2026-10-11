-- Span dari trace OpenTelemetry yang berisi error (trace lain tidak disimpan).
-- Dipakai untuk tampilan trace di halaman issue. Dihapus ikut retensi project.
CREATE TABLE "trace_spans" (
    "project_id" TEXT NOT NULL,
    "trace_id" TEXT NOT NULL,
    "span_id" TEXT NOT NULL,
    "parent_span_id" TEXT,
    "service" TEXT,
    "name" TEXT NOT NULL,
    "kind" INTEGER NOT NULL DEFAULT 0,
    "start_us" INTEGER NOT NULL,
    "duration_us" INTEGER NOT NULL,
    "status_code" INTEGER NOT NULL DEFAULT 0,
    "status_message" TEXT,
    "attributes" TEXT NOT NULL DEFAULT '{}',
    "events" TEXT NOT NULL DEFAULT '[]',
    "resource" TEXT NOT NULL DEFAULT '{}',
    "received_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("project_id", "trace_id", "span_id"),
    CONSTRAINT "trace_spans_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "trace_spans_project_id_received_at_idx" ON "trace_spans"("project_id", "received_at");
