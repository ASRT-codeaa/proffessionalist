-- 012_videos, D1/SQLite form of app-new/migrations/012_videos.sql.
--
-- Same tables, same constraints, same seeds; only the dialect differs.  Applied on Cloudflare by
-- splitting on ";\n" the way cf-api/tools/apply-schema.mjs already does for compat/schema.sql, which
-- is also what cf-api/tools/test-videos.mjs does against node:sqlite before it runs a single route.
-- Kept deliberately parallel to the Postgres file so a reviewer can diff them: BIGSERIAL becomes
-- INTEGER PRIMARY KEY AUTOINCREMENT, TIMESTAMPTZ becomes TEXT with the strftime default the rest of
-- compat/schema.sql uses, BOOLEAN becomes INTEGER, NUMERIC becomes REAL, and every CHECK, UNIQUE,
-- FOREIGN KEY and index is the same expression on both sides.  No triggers, no partial indexes, no
-- generated columns, no views.
--
-- topic_ids is TEXT holding a JSON array of slugs ('["career","hiring"]'), identical to the
-- Postgres file's TEXT column, so the route code has one shape to parse on either stack.

CREATE TABLE IF NOT EXISTS "video_topics" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "parent_id" INTEGER,
  FOREIGN KEY ("parent_id") REFERENCES "video_topics" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "videos" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "post_id" INTEGER NOT NULL,
  "kind" TEXT DEFAULT 'upload' NOT NULL,
  "provider" TEXT DEFAULT 'self' NOT NULL,
  "canonical_url" TEXT NOT NULL UNIQUE,
  "media_key" TEXT,
  "embed_url" TEXT,
  "duration_ms" INTEGER,
  "width" INTEGER,
  "height" INTEGER,
  "thumbnail_key" TEXT,
  "topic_ids" TEXT DEFAULT '[]' NOT NULL,
  "moderation_state" TEXT DEFAULT 'pending' NOT NULL,
  "availability" TEXT DEFAULT 'ok' NOT NULL,
  "source_user_id" INTEGER,
  "indexed_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  "last_checked_at" TEXT,
  "deleted_at" TEXT,
  CHECK (kind IN ('upload', 'link', 'indexed')),
  CHECK (moderation_state IN ('pending', 'approved', 'removed')),
  CHECK (availability IN ('ok', 'unavailable', 'checked_failed')),
  FOREIGN KEY ("post_id") REFERENCES "posts" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("source_user_id") REFERENCES "users" ("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "idx_videos_post" ON "videos" ("post_id");
CREATE INDEX IF NOT EXISTS "idx_videos_moderation" ON "videos" ("moderation_state", "indexed_at");
CREATE INDEX IF NOT EXISTS "idx_videos_source_user" ON "videos" ("source_user_id");
CREATE INDEX IF NOT EXISTS "idx_videos_deleted" ON "videos" ("deleted_at");

CREATE TABLE IF NOT EXISTS "video_interests" (
  "user_id" INTEGER NOT NULL,
  "topic_id" INTEGER NOT NULL,
  "weight" REAL DEFAULT 1 NOT NULL,
  "updated_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  PRIMARY KEY ("user_id", "topic_id"),
  CHECK (weight >= 0 AND weight <= 1),
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("topic_id") REFERENCES "video_topics" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_video_interests_topic" ON "video_interests" ("topic_id");

CREATE TABLE IF NOT EXISTS "video_activity" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "video_id" INTEGER NOT NULL,
  "user_id" INTEGER,
  "event" TEXT NOT NULL,
  "value_ms" INTEGER,
  "value_num" INTEGER,
  "dedupe_key" TEXT NOT NULL UNIQUE,
  "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  CHECK (event IN ('view_start', 'watch', 'complete', 'like', 'save', 'share', 'follow_from_video', 'impression')),
  CHECK (value_ms IS NULL OR (value_ms >= 0 AND value_ms <= 86400000)),
  CHECK (value_num IS NULL OR (value_num >= 0 AND value_num <= 86400000)),
  FOREIGN KEY ("video_id") REFERENCES "videos" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_video_activity_video" ON "video_activity" ("video_id", "event");
CREATE INDEX IF NOT EXISTS "idx_video_activity_user" ON "video_activity" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_video_activity_created" ON "video_activity" ("created_at");

CREATE TABLE IF NOT EXISTS "video_rank_config" (
  "key" TEXT NOT NULL,
  "weight" REAL DEFAULT 1 NOT NULL,
  "updated_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  PRIMARY KEY ("key"),
  CHECK (weight >= 0 AND weight <= 1)
);

CREATE TABLE IF NOT EXISTS "video_sources" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "kind" TEXT NOT NULL,
  "url" TEXT NOT NULL UNIQUE,
  "provider" TEXT NOT NULL,
  "enabled" INTEGER DEFAULT 1 NOT NULL,
  "robots_respected" INTEGER DEFAULT 1 NOT NULL,
  "last_run_at" TEXT,
  "etag" TEXT,
  "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  CHECK (kind IN ('rss', 'sitemap', 'allowlist'))
);

CREATE TABLE IF NOT EXISTS "video_discovery_log" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "source_id" INTEGER,
  "url" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "detail" TEXT,
  "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  CHECK (outcome IN ('indexed', 'duplicate', 'provider_denied', 'scheme_denied', 'robots_denied', 'rejected')),
  FOREIGN KEY ("source_id") REFERENCES "video_sources" ("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "idx_video_discovery_source" ON "video_discovery_log" ("source_id");
CREATE INDEX IF NOT EXISTS "idx_video_discovery_url" ON "video_discovery_log" ("url");
CREATE INDEX IF NOT EXISTS "idx_video_discovery_created" ON "video_discovery_log" ("created_at");

INSERT INTO "video_topics" ("slug", "name") VALUES ('career', 'Career') ON CONFLICT ("slug") DO NOTHING;
INSERT INTO "video_topics" ("slug", "name") VALUES ('hiring', 'Hiring') ON CONFLICT ("slug") DO NOTHING;
INSERT INTO "video_topics" ("slug", "name") VALUES ('design', 'Design') ON CONFLICT ("slug") DO NOTHING;
INSERT INTO "video_topics" ("slug", "name") VALUES ('engineering', 'Engineering') ON CONFLICT ("slug") DO NOTHING;
INSERT INTO "video_topics" ("slug", "name") VALUES ('finance', 'Finance') ON CONFLICT ("slug") DO NOTHING;
INSERT INTO "video_topics" ("slug", "name") VALUES ('sales', 'Sales') ON CONFLICT ("slug") DO NOTHING;
INSERT INTO "video_topics" ("slug", "name") VALUES ('leadership', 'Leadership') ON CONFLICT ("slug") DO NOTHING;
INSERT INTO "video_topics" ("slug", "name") VALUES ('freelancing', 'Freelancing') ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "video_rank_config" ("key", "weight") VALUES ('interest_relevance', 0.30) ON CONFLICT ("key") DO NOTHING;
INSERT INTO "video_rank_config" ("key", "weight") VALUES ('watch_completion', 0.20) ON CONFLICT ("key") DO NOTHING;
INSERT INTO "video_rank_config" ("key", "weight") VALUES ('engagement', 0.15) ON CONFLICT ("key") DO NOTHING;
INSERT INTO "video_rank_config" ("key", "weight") VALUES ('followed_creators', 0.15) ON CONFLICT ("key") DO NOTHING;
INSERT INTO "video_rank_config" ("key", "weight") VALUES ('quality_freshness', 0.10) ON CONFLICT ("key") DO NOTHING;
INSERT INTO "video_rank_config" ("key", "weight") VALUES ('diversity_discovery', 0.10) ON CONFLICT ("key") DO NOTHING;

INSERT INTO "video_sources" ("kind", "url", "provider") VALUES ('allowlist', 'https://www.youtube.com/', 'youtube') ON CONFLICT ("url") DO NOTHING;
INSERT INTO "video_sources" ("kind", "url", "provider") VALUES ('allowlist', 'https://vimeo.com/', 'vimeo') ON CONFLICT ("url") DO NOTHING;
INSERT INTO "video_sources" ("kind", "url", "provider") VALUES ('allowlist', 'https://www.linkedin.com/', 'linkedin') ON CONFLICT ("url") DO NOTHING;
