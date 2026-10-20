-- 012: the video surface.
--
-- A video IS a posts row plus a videos row keyed to it, on purpose: post_likes, comments,
-- post_shares and saved_items already count, moderate and hydrate a posts row, so engagement needs
-- no new table and no new code. Everything below is additive; no existing table is touched.
--
-- The same six tables exist in app-new/migrations-d1/012_videos.sql, which is the D1/SQLite form of
-- this file (BIGSERIAL -> INTEGER PRIMARY KEY AUTOINCREMENT, TIMESTAMPTZ -> TEXT with a strftime
-- default, BOOLEAN -> INTEGER).  Only constructs the already-shipped migrations prove are used
-- here: no trigger, no stored procedure, no view, no partial index, no gen_random_uuid(), no
-- expression index, no ON CONFLICT DO UPDATE on anything but a VALUES-sourced insert.
--
-- topic_ids is a JSON array of video_topics.slug values stored as TEXT in BOTH dialects.  The
-- mirror's text[] columns (posts.hashtags) come back as a JS array from pg and as a JSON string from
-- D1, which would make the DTO dialect-dependent; one TEXT column keeps one shape everywhere.

BEGIN;

CREATE TABLE IF NOT EXISTS video_topics (
    id          BIGSERIAL PRIMARY KEY,
    slug        VARCHAR(60) NOT NULL UNIQUE,
    name        VARCHAR(120) NOT NULL,
    parent_id   BIGINT NULL REFERENCES video_topics(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS videos (
    id               BIGSERIAL PRIMARY KEY,
    post_id          BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    kind             VARCHAR(12) NOT NULL DEFAULT 'upload'
        CHECK (kind IN ('upload','link','indexed')),
    provider         VARCHAR(40) NOT NULL DEFAULT 'self',
    canonical_url    TEXT NOT NULL UNIQUE,
    media_key        TEXT NULL,
    embed_url        TEXT NULL,
    duration_ms      INTEGER NULL,
    width            INTEGER NULL,
    height           INTEGER NULL,
    thumbnail_key    TEXT NULL,
    topic_ids        TEXT NOT NULL DEFAULT '[]',
    moderation_state VARCHAR(12) NOT NULL DEFAULT 'pending'
        CHECK (moderation_state IN ('pending','approved','removed')),
    availability     VARCHAR(16) NOT NULL DEFAULT 'ok'
        CHECK (availability IN ('ok','unavailable','checked_failed')),
    source_user_id   BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    indexed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_checked_at  TIMESTAMPTZ NULL,
    deleted_at       TIMESTAMPTZ NULL
);

-- feed and search load their rows through the post, so the post -> video hop needs an index too.
CREATE INDEX IF NOT EXISTS idx_videos_post ON videos(post_id);
CREATE INDEX IF NOT EXISTS idx_videos_moderation ON videos(moderation_state, indexed_at);
CREATE INDEX IF NOT EXISTS idx_videos_source_user ON videos(source_user_id);
CREATE INDEX IF NOT EXISTS idx_videos_deleted ON videos(deleted_at);

CREATE TABLE IF NOT EXISTS video_interests (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic_id   BIGINT NOT NULL REFERENCES video_topics(id) ON DELETE CASCADE,
    weight     NUMERIC(4,3) NOT NULL DEFAULT 1
        CHECK (weight >= 0 AND weight <= 1),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, topic_id)
);

CREATE INDEX IF NOT EXISTS idx_video_interests_topic ON video_interests(topic_id);

-- Telemetry only. Nothing a viewer wrote (a caption, a comment, a token) ever lands here:
-- user_id + event + two numbers + a dedupe key.
--   view_start        the player began playback (one per watched item; feeds stats.views)
--   watch             a watch segment, value_ms = milliseconds watched (watch_completion)
--   complete          the clip was watched to its end (value_ms = full duration)
--   like              the player's like button, mirrors post_likes for ranking, is not the count
--   save              mirrors saved_items, same reason
--   share             mirrors post_shares, same reason
--   follow_from_video the viewer followed the author from this video's page (attributed growth)
--   impression        the item was drawn on a page (diversity_discovery discounts saturated clips)
CREATE TABLE IF NOT EXISTS video_activity (
    id         BIGSERIAL PRIMARY KEY,
    video_id   BIGINT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    user_id    BIGINT NULL REFERENCES users(id) ON DELETE CASCADE,
    event      VARCHAR(24) NOT NULL
        CHECK (event IN ('view_start','watch','complete','like','save','share',
                         'follow_from_video','impression')),
    value_ms   INTEGER NULL CHECK (value_ms IS NULL OR (value_ms >= 0 AND value_ms <= 86400000)),
    value_num  INTEGER NULL CHECK (value_num IS NULL OR (value_num >= 0 AND value_num <= 86400000)),
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_activity_video ON video_activity(video_id, event);
CREATE INDEX IF NOT EXISTS idx_video_activity_user ON video_activity(user_id);
CREATE INDEX IF NOT EXISTS idx_video_activity_created ON video_activity(created_at);

-- The six approved weights.  Read per feed request and writable through the admin route, so tuning
-- ranking is a row update, never a deploy.  The sum-to-1 rule is enforced in the route (a CHECK on
-- one row cannot see the other five).
CREATE TABLE IF NOT EXISTS video_rank_config (
    key        VARCHAR(40) PRIMARY KEY,
    weight     NUMERIC(4,3) NOT NULL CHECK (weight >= 0 AND weight <= 1),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_sources (
    id               BIGSERIAL PRIMARY KEY,
    kind             VARCHAR(12) NOT NULL
        CHECK (kind IN ('rss','sitemap','allowlist')),
    url              TEXT NOT NULL UNIQUE,
    provider         VARCHAR(40) NOT NULL,
    enabled          BOOLEAN NOT NULL DEFAULT TRUE,
    robots_respected BOOLEAN NOT NULL DEFAULT TRUE,
    last_run_at      TIMESTAMPTZ NULL,
    etag             VARCHAR(120) NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per candidate the pipeline looked at, including the refusals: the audit trail of a run is
-- the only way to tell "the source was empty" from "the source was refused".
CREATE TABLE IF NOT EXISTS video_discovery_log (
    id         BIGSERIAL PRIMARY KEY,
    source_id  BIGINT NULL REFERENCES video_sources(id) ON DELETE SET NULL,
    url        TEXT NOT NULL,
    outcome    VARCHAR(24) NOT NULL
        CHECK (outcome IN ('indexed','duplicate','provider_denied','scheme_denied',
                           'robots_denied','rejected')),
    detail     TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_discovery_source ON video_discovery_log(source_id);
CREATE INDEX IF NOT EXISTS idx_video_discovery_url ON video_discovery_log(url);
CREATE INDEX IF NOT EXISTS idx_video_discovery_created ON video_discovery_log(created_at);

/* -------------------------- seeds -------------------------- */

INSERT INTO video_topics (slug, name) VALUES
    ('career', 'Career'),
    ('hiring', 'Hiring'),
    ('design', 'Design'),
    ('engineering', 'Engineering'),
    ('finance', 'Finance'),
    ('sales', 'Sales'),
    ('leadership', 'Leadership'),
    ('freelancing', 'Freelancing')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO video_rank_config (key, weight) VALUES
    ('interest_relevance', 0.30),
    ('watch_completion', 0.20),
    ('engagement', 0.15),
    ('followed_creators', 0.15),
    ('quality_freshness', 0.10),
    ('diversity_discovery', 0.10)
ON CONFLICT (key) DO NOTHING;

INSERT INTO video_sources (kind, url, provider) VALUES
    ('allowlist', 'https://www.youtube.com/', 'youtube'),
    ('allowlist', 'https://vimeo.com/', 'vimeo'),
    ('allowlist', 'https://www.linkedin.com/', 'linkedin')
ON CONFLICT (url) DO NOTHING;

COMMIT;
