-- bugtool:foreign-keys-off
-- Akun berbasis username: undangan cukup link (tanpa email), orang yang diundang memilih username + password.
-- Email menjadi opsional (unik kalau diisi). SQLite tidak bisa mengubah NOT NULL, jadi users dan invites dibuat ulang
-- dengan foreign key mati (lihat migrate.ts); referensi dicek foreign_key_check sebelum commit.

-- Username awal akun lama = bagian email sebelum "@", huruf kecil; kalau bentrok ditambah "-2", "-3", ...
CREATE TABLE "users_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "password_hash" TEXT,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "users_new" ("id", "username", "email", "name", "password_hash", "is_admin", "created_at")
SELECT "id",
  CASE WHEN n = 1 THEN base ELSE base || '-' || n END,
  "email", "name", "password_hash", "is_admin", "created_at"
FROM (
  SELECT u.*, lower(CASE WHEN instr(u."email", '@') > 1 THEN substr(u."email", 1, instr(u."email", '@') - 1) ELSE u."email" END) AS base,
    ROW_NUMBER() OVER (PARTITION BY lower(CASE WHEN instr(u."email", '@') > 1 THEN substr(u."email", 1, instr(u."email", '@') - 1) ELSE u."email" END)
      ORDER BY u."created_at", u."id") AS n
  FROM "users" u
);
DROP TABLE "users";
ALTER TABLE "users_new" RENAME TO "users";
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- Undangan: email opsional (link biasa).
CREATE TABLE "invites_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "token_hash" TEXT NOT NULL,
    "invited_by_id" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "accepted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invites_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "invites_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "invites_new" SELECT "id", "project_id", "email", "role", "token_hash", "invited_by_id", "expires_at", "accepted_at", "created_at" FROM "invites";
DROP TABLE "invites";
ALTER TABLE "invites_new" RENAME TO "invites";
CREATE UNIQUE INDEX "invites_token_hash_key" ON "invites"("token_hash");
CREATE INDEX "invites_project_id_idx" ON "invites"("project_id");
