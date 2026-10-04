-- Token untuk sentry-cli (unggah source map), per project. Hanya hash yang disimpan.
CREATE TABLE "upload_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" DATETIME,
    CONSTRAINT "upload_tokens_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "upload_tokens_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "upload_tokens_token_hash_key" ON "upload_tokens"("token_hash");
CREATE INDEX "upload_tokens_project_id_idx" ON "upload_tokens"("project_id");

-- Indeks artifact: debug ID -> file di disk (/data/files/<sha1>). Satu debug ID bisa punya
-- source_map dan minified_source.
CREATE TABLE "artifacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "debug_id" TEXT NOT NULL,
    "file_type" TEXT NOT NULL,
    "url" TEXT,
    "sha1" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" DATETIME,
    CONSTRAINT "artifacts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "artifacts_project_id_debug_id_file_type_key" ON "artifacts"("project_id", "debug_id", "file_type");
CREATE INDEX "artifacts_sha1_idx" ON "artifacts"("sha1");
