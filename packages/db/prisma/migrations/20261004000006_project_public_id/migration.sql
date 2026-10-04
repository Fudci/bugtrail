-- SDK Sentry hanya membaca project ID berupa ANGKA dari DSN (".../<angka>"), jadi DSN memakai
-- nomor publik ini, bukan UUID. Project lama diberi nomor berurutan.
ALTER TABLE "projects" ADD COLUMN "public_id" INTEGER;
UPDATE "projects" SET "public_id" = (SELECT COUNT(*) FROM "projects" p2 WHERE p2.rowid <= "projects".rowid);
CREATE UNIQUE INDEX "projects_public_id_key" ON "projects"("public_id");
