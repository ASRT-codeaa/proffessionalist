-- 013_mutes — per-viewer creator mutes, mirrored in app-new/migrations-d1/013_mutes.sql.
--
-- Mutes hide a creator's posts from the muter's feeds (home GET /posts/feed and the videos
-- ranking) with no relationship change: unlike blocks there is no follow/connection teardown,
-- and unlike blocks it is one-directional.  Kept parallel to the blocks table in
-- migrations/003_product.sql: composite PK, both FKs cascade with the user, no self-mute.
-- The VPS does not run the app-new overlay that reads this table; the file exists so the two
-- dialects stay diffable, exactly like 012_videos.sql.

CREATE TABLE IF NOT EXISTS mutes (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    muted_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id, muted_id),
    CHECK(user_id <> muted_id)
);
