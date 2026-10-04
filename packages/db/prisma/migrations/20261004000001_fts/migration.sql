-- Pencarian teks event (pengganti tsvector Postgres). Diisi oleh pemroses event.
CREATE VIRTUAL TABLE "events_fts" USING fts5(
    "content",
    "event_id" UNINDEXED,
    "issue_id" UNINDEXED,
    "project_id" UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- Jaga indeks tetap sinkron saat event terhapus (termasuk cascade dari issue/project).
CREATE TRIGGER "events_fts_after_delete" AFTER DELETE ON "events" BEGIN
    DELETE FROM "events_fts" WHERE "event_id" = OLD."id";
END;
