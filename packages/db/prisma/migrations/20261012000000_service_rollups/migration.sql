-- Service map: rollup per service dan per panggilan antar service, dihitung saat ingest OTLP
-- (jadi lengkap juga di mode Lite yang hanya menyimpan trace error/lambat).
-- peer = '' : request masuk ke service (span server/consumer); count/errors/latensi milik service itu.
-- peer = X  : panggilan service -> X (span client/producer), latensi dari sisi pemanggil.
--             X = service.name tujuan kalau span server-nya terlihat, selain itu peer.service / server.address / db.system.
-- external = 1 kalau tujuan tidak terlihat sebagai service OTLP (database, API pihak ketiga).
-- granularity/bucket/h0..h11 sama dengan endpoint_rollups.
CREATE TABLE "service_rollups" (
  "project_id" TEXT NOT NULL,
  "granularity" TEXT NOT NULL,
  "bucket" INTEGER NOT NULL,
  "service" TEXT NOT NULL,
  "peer" TEXT NOT NULL,
  "external" INTEGER NOT NULL DEFAULT 0,
  "count" INTEGER NOT NULL DEFAULT 0,
  "errors" INTEGER NOT NULL DEFAULT 0,
  "dur_sum_us" INTEGER NOT NULL DEFAULT 0,
  "dur_max_us" INTEGER NOT NULL DEFAULT 0,
  "h0" INTEGER NOT NULL DEFAULT 0, "h1" INTEGER NOT NULL DEFAULT 0, "h2" INTEGER NOT NULL DEFAULT 0,
  "h3" INTEGER NOT NULL DEFAULT 0, "h4" INTEGER NOT NULL DEFAULT 0, "h5" INTEGER NOT NULL DEFAULT 0,
  "h6" INTEGER NOT NULL DEFAULT 0, "h7" INTEGER NOT NULL DEFAULT 0, "h8" INTEGER NOT NULL DEFAULT 0,
  "h9" INTEGER NOT NULL DEFAULT 0, "h10" INTEGER NOT NULL DEFAULT 0, "h11" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("project_id", "granularity", "bucket", "service", "peer"),
  FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE
) WITHOUT ROWID;
