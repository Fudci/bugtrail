-- Antrian span OpenTelemetry di disk untuk mode Scale (ClickHouse): span ditulis di sini dulu
-- (sebelum OTLP dibalas 200), lalu dipindahkan per batch ke ClickHouse. Satu baris = span dari satu request.
CREATE TABLE "span_queue" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "span_count" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
