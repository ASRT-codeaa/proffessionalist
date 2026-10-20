-- 013_mutes, D1/SQLite form of app-new/migrations/013_mutes.sql.
--
-- Same table, same constraints; only the dialect differs, kept diffable against the Postgres
-- file the way 012_videos.sql is.  Applied to the real D1 by the same HTTP path
-- (cf-api/tools/backfill-post-videos.mjs pattern), and merged into the build manifest so
-- cf-api/tools/test-videos.mjs and test-worker.mjs boot with the table present.

CREATE TABLE IF NOT EXISTS "mutes" (
  "user_id" INTEGER NOT NULL,
  "muted_id" INTEGER NOT NULL,
  "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  PRIMARY KEY ("user_id", "muted_id"),
  CHECK ("user_id" <> "muted_id"),
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("muted_id") REFERENCES "users" ("id") ON DELETE CASCADE
);
