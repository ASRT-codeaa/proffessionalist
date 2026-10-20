const express = require("express");
const { query, pool } = require("../../db");
const dto = require("../../services/spaDto");
const kit = require("../../services/spaKit");
const videos = require("../../services/videoKit");
const { audit } = require("../../services/audit");
const { requireStaff } = require("../../middleware/security");
const { uploadImage, publicUrl, mediaType } = require("../../middleware/upload");

/* -------------------------------------------------------------------------- *
 *  The video surface, mounted at /api/videos behind authenticate+userLimiter.
 *
 *  Shape of the feature: a video IS a posts row (so /api/posts/:id/like, /comments, /save and
 *  /share keep being the only engagement writes in the app) plus a videos row keyed to it.  What
 *  this file adds is the video-specific read model (feed/search/detail over the weighted ranking),
 *  the creator's add path, the telemetry sink, the viewer's interests, and the staff console.
 *
 *  Permissions are decided here and nowhere else:
 *    - the viewer id is req.user.sub from the session lookup, never req.body.userId;
 *    - staff reads come from middleware/security.js's requireStaff, i.e. the users.role column the
 *      authenticate.js session query loaded — a token payload edit buys nothing, and a body field
 *      is not read for authority anywhere in this file;
 *    - every staff mutation writes one audit_logs row through services/audit.js with actor, action,
 *      target, outcome and ip, and never a caption, comment body or token.
 * -------------------------------------------------------------------------- */

const router = express.Router();
const admin = express.Router();

const { handle, builder, invalid, missing, forbidden, fail, toId, uid, str, list, num, isStaff } = kit;

const TABS = ["for-you", "following", "trending"];
const TOPIC_SLUG = /^[a-z][a-z0-9_-]{1,59}$/;
const DEDUPE_KEY = /^[\w:.@-]{1,120}$/;
const MAX_URLS_PER_RUN = 50;

const pageLimit = value => Math.max(1, Math.min(videos.MAX_PAGE, num(value, 10) || 10));

/* -------------------------------------------------------------------------- */
/*                                   the feed                                 */
/* -------------------------------------------------------------------------- */

router.get("/feed", handle(async (req, res) => {
  const me = uid(req);
  const tab = TABS.includes(str(req.query.tab, 20)) ? str(req.query.tab, 20) : "for-you";
  const limit = pageLimit(req.query.limit);
  const cursor = videos.decodeCursor(req.query.cursor);

  const b = builder();
  const where = [videos.PUBLIC_CLAUSE];
  const order = "v.indexed_at DESC, v.id DESC";

  if (tab === "following") {
    where.push(`EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = $1::bigint AND fo.following_id = p.user_id)`);
  }
  if (tab === "trending") {
    /* the last seven days only: a clip cannot trend forever, and recency is already a feature */
    where.push(`p.created_at >= ${b.add(new Date(Date.now() - 7 * 86400000).toISOString())}`);
  }

  const ranked = await videos.rankedPage({
    viewer: me,
    where: where.join(" AND "),
    params: b.params,
    order: tab === "for-you" ? order : "p.created_at DESC, v.id DESC",
    limit,
    cursor,
  });

  res.json({ items: ranked.items, nextCursor: ranked.nextCursor, tab });
}));

/* -------------------------------------------------------------------------- */
/*                                  search                                    */
/* -------------------------------------------------------------------------- */

router.get("/search", handle(async (req, res) => {
  const me = uid(req);
  const term = str(req.query.q, 80).toLowerCase();
  const limit = pageLimit(req.query.limit);
  const cursor = videos.decodeCursor(req.query.cursor);

  /* an empty query is the client's "type to search" state, not a request for the whole index */
  if (!term) return res.json({ items: [], nextCursor: null, query: "", total: 0 });

  const b = builder([videos.likeValue ? undefined : undefined]);
  b.params.length = 0;
  const like = `%${term.replace(/[%_\\]/g, m => `\\${m}`)}%`;
  const param = b.add(like);

  const ranked = await videos.rankedPage({
    viewer: me,
    where: `${videos.PUBLIC_CLAUSE}
      AND (LOWER(COALESCE(p.content, '')) LIKE ${param}
        OR LOWER(u.name) LIKE ${param} OR LOWER(u.username) LIKE ${param}
        OR LOWER(v.topic_ids) LIKE ${param}
        OR EXISTS (SELECT 1 FROM unnest(COALESCE(p.hashtags, '{}')) AS t(tag) WHERE LOWER(t.tag) LIKE ${param}))`,
    params: b.params,
    order: "v.indexed_at DESC, v.id DESC",
    limit,
    cursor,
  });

  res.json({
    items: ranked.items,
    nextCursor: ranked.nextCursor,
    query: term,
    total: ranked.total,
  });
}));

/** The seeded taxonomy, so the interest editor can draw chips without hardcoding slugs. */
router.get("/topics", handle(async (req, res) => {
  const rows = await query(
    `SELECT id::int AS id, slug, name, parent_id::int AS parent_id
       FROM video_topics ORDER BY name`
  );
  res.json({ items: rows.rows.map(row => ({
    id: num(row.id), slug: videos.text(row.slug), name: videos.text(row.name),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : num(row.parent_id),
  })) });
}));

/* -------------------------------------------------------------------------- */
/*                              one video, with                               *
 *                              the existing comments                         */
/* -------------------------------------------------------------------------- */

/**
 * The row a viewer is allowed to see at all: approved and playable, or their own, or anything that
 * exists for staff.  Returns null when the video does not exist or is soft-deleted for everyone but
 * staff, which is what keeps a pending clip from being confirmable by a stranger.
 */
async function loadVideo(id, viewer) {
  const rows = await videos.selectVideos({
    viewer,
    where: `${videos.ANY_CLAUSE} AND v.id = $2`,
    params: [id],
    order: "v.id",
    limit: 1,
  });
  const candidate = rows[0] || null;
  if (!candidate) return null;
  const row = candidate.row;
  const owner = num(row.user_id) === viewer || num(row.source_user_id) === viewer;
  const public_ = row.moderation_state === "approved" && row.availability === "ok";
  if (!public_ && !owner && !isStaff({ user: { role: viewerRoleFrom(req_cache.get(viewer)) } })) {
    /* staff is decided by the caller (it has req); the row-level answer here is owner-or-public */
  }
  return { candidate, row, owner, public: public_ };
}

const req_cache = new Map();
const viewerRoleFrom = role => role || "user";

router.get("/:id", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id, "id");
  const loaded = await loadVideo(id, me);
  if (!loaded) return missing(res, "Video");
  if (!loaded.public && !loaded.owner && !isStaff(req)) return missing(res, "Video");

  const stats = await videos.activityStats([id]);
  const weights = (await videos.loadWeights()).weights;
  const candidate = Object.assign({}, loaded.candidate, {
    stats: stats.get(id) || { views: 0 },
    features: videos.featuresOf(loaded.candidate, await videos.viewerInterests(me)),
    score: 0,
  });
  const ranking = {
    score: videos.round(candidate.score, 6),
    reasons: videos.reasonsFor(candidate.features, weights),
  };

  const comments = await query(
    `SELECT c.id::int AS id, c.post_id::int AS post_id, c.user_id::int AS user_id, c.content, c.created_at,
            COALESCE(cl.count, 0)::int AS like_count,
            (clike.user_id IS NOT NULL) AS liked
       FROM comments c
       LEFT JOIN (SELECT comment_id, COUNT(*) AS count FROM comment_likes GROUP BY comment_id) cl ON cl.comment_id = c.id
       LEFT JOIN comment_likes clike ON clike.comment_id = c.id AND clike.user_id = $1
      WHERE c.post_id = $2 AND c.deleted_at IS NULL
      ORDER BY c.created_at ASC
      LIMIT 200`,
    [me, num(loaded.row.post_id)]
  );
  const people = await dto.loadPeople(comments.rows.map(r => r.user_id), me);

  res.json(Object.assign(
    videos.toVideoItem(loaded.row, {
      stats: candidate.stats,
      ranking,
      includeAdmin: loaded.owner || isStaff(req),
    }),
    { comments: comments.rows.map(r => dto.toComment(r, people)) }
  ));
}));

/* -------------------------------------------------------------------------- */
/*                            add a video (creator)                             */
/* -------------------------------------------------------------------------- */

/** Every topic slug a write may name has to exist; a typo is a 400, never a silently dropped tag. */
async function resolveTopics(value) {
  const wanted = list(Array.isArray(value) ? value : String(value || "").split(/[,\s]+/), 12)
    .map(entry => entry.toLowerCase().replace(/^#/, "").trim())
    .filter(entry => TOPIC_SLUG.test(entry));
  if (!wanted.length) return { slugs: [], unknown: [] };

  const rows = await query(
    `SELECT slug FROM video_topics WHERE slug = ANY($1::text[])`,
    [wanted]
  );
  const known = rows.rows.map(row => String(row.slug).toLowerCase());
  return { slugs: known, unknown: wanted.filter(slug => !known.includes(slug)) };
}

/**
 * A video and its post are two writes with a foreign key between them, and D1 has no cross-statement
 * transaction that can read the new post id back (see cf-api/src/db.js:79-132).  The post therefore
 * goes in first with RETURNING, the videos row second, and if the second write fails the first is
 * soft-deleted so nothing half-created is ever visible on /api/posts/feed.  The duplicate check runs
 * before either write, which is why the compensating delete is rare rather than routine.
 */
async function createVideo({ me, post, video }) {
  const created = await query(
    `INSERT INTO posts (user_id, content, media, media_url, post_type, visibility, link_url, hashtags)
     VALUES ($1,$2,$3::jsonb,$4,'post','public',$5,$6)
     RETURNING id`,
    [me, post.content, JSON.stringify(post.media), post.mediaUrl, post.linkUrl, post.hashtags]
  );
  const postId = num(created.rows[0] && created.rows[0].id);
  if (!postId) throw new kit.HttpError(500, "could not create the post for this video");

  try {
    const inserted = await query(
      `INSERT INTO videos (post_id, kind, provider, canonical_url, media_key, embed_url,
                           duration_ms, width, height, thumbnail_key, topic_ids,
                           moderation_state, availability, source_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending','ok',$12)
       RETURNING id`,
      [postId, video.kind, video.provider, video.canonicalUrl, video.mediaKey, video.embedUrl,
        video.durationMs, video.width, video.height, video.thumbnailKey,
        JSON.stringify(video.topics), me]
    );
    return { videoId: num(inserted.rows[0] && inserted.rows[0].id), postId };
  } catch (err) {
    await query(`UPDATE posts SET deleted_at = NOW() WHERE id = $1`, [postId]).catch(() => {});
    if (err && err.code === "23505") {
      const clash = fail(res => res, 0, "", ""); // never reached; see the route's own duplicate guard
      throw new kit.HttpError(409, String(clash || "already indexed"));
    }
    throw err;
  }
}

const intOrNull = value => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 && n <= 86400000 ? n : null;
};
const dimOrNull = value => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 8192 ? n : null;
};

/** https-only, and only on the providers the gate knows.  Anything else is a 400/403, not a maybe. */
function externalThumbnail(value) {
  const raw = str(value, 500);
  return /^https:\/\/[\w.~-]+\/[\w./=?%+&-]*$/i.test(raw) ? raw : null;
}

router.post("/", uploadImage("post", "file"), handle(async (req, res) => {
  const me = uid(req);
  const body = req.body || {};

  /* a role or an authorship the client declares is not read, ever */
  if (body.userId !== undefined || body.user_id !== undefined || body.role !== undefined) {
    return invalid(res, { userId: "Not allowed" }, "A video is always owned by the signed-in account");
  }

  const topics = await resolveTopics(body.topics);
  if (topics.unknown.length) {
    return invalid(res, { topics: `Unknown topic: ${topics.unknown.join(", ")}` });
  }

  const file = req.file || (req.files || [])[0] || null;
  let video;

  if (file) {
    if (mediaType(file.mimetype) !== "video") {
      return invalid(res, { file: "A video file is MP4, WEBM or MOV" });
    }
    const url = publicUrl("post", file.filename);
    video = {
      kind: "upload",
      provider: "self",
      canonicalUrl: url,
      mediaKey: url,
      embedUrl: null,
      /* the storage key is the same string with the /uploads prefix removed, which is exactly how
         src/shims/upload.js's keyFromPath() reads it back off a URL */
      thumbnailKey: externalThumbnail(body.thumbnailUrl),
    };
  } else {
    const gate = videos.gateUrl(body.url);
    if (gate.outcome === "provider_denied") return forbidden(res, "That provider is not allowlisted");
    if (gate.outcome !== "ok") {
      return invalid(res, { url: gate.detail === "empty" ? "Add a video URL or attach a file" : `URL refused: ${gate.outcome} (${gate.detail || ""})` });
    }
    const clash = await query(`SELECT id::int AS id FROM videos WHERE canonical_url = $1`, [gate.canonical]);
    if (clash.rowCount) {
      return fail(res, 409, "duplicate", "This video is already in the index", { url: "Already indexed" });
    }
    video = {
      kind: "link",
      provider: gate.provider,
      canonicalUrl: gate.canonical,
      mediaKey: null,
      embedUrl: gate.embed,
      thumbnailKey: externalThumbnail(body.thumbnailUrl) || gate.thumbnail,
    };
  }

  const caption = str(body.caption === undefined ? body.text : body.caption, 2000);
  if (video.kind === "upload" && !caption) {
    return invalid(res, { caption: "Say what this video is about" });
  }

  const created = await createVideo({
    me,
    post: {
      content: caption || (video.canonicalUrl || " ").slice(0, 2000),
      media: video.kind === "upload" ? [video.canonicalUrl] : [],
      mediaUrl: video.kind === "upload" ? video.canonicalUrl : null,
      linkUrl: video.kind === "upload" ? null : video.canonicalUrl,
      hashtags: list(body.hashtags, 20).map(tag => str(tag, 60).replace(/^#/, "").toLowerCase()).filter(Boolean),
    },
    video: {
      ...video,
      durationMs: intOrNull(body.durationMs),
      width: dimOrNull(body.width),
      height: dimOrNull(body.height),
      topics: topics.slugs,
    },
  });

  const loaded = await loadVideo(created.videoId, me);
  const weights = (await videos.loadWeights()).weights;
  res.status(201).json(Object.assign(
    videos.toVideoItem(loaded.row, {
      stats: { views: 0 },
      ranking: { score: 0, reasons: videos.reasonsFor(null, weights) },
      includeAdmin: true,
    }),
    { comments: [] }
  ));
}));

/* -------------------------------------------------------------------------- */
/*                                  activity                                  */
/* -------------------------------------------------------------------------- */

router.post("/:id/activity", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id, "id");
  const body = req.body || {};
  const event = str(body.event, 24);

  if (!videos.EVENTS.includes(event)) {
    return invalid(res, { event: `Use one of: ${videos.EVENTS.join(", ")}` });
  }
  const dedupe = str(body.dedupe_key === undefined ? body.dedupeKey : body.dedupe_key, 120);
  if (!DEDUPE_KEY.test(dedupe)) {
    return invalid(res, { dedupe_key: "Required, 1-120 characters of letters, digits, . _ : @ -" });
  }
  for (const [name, value] of [["value_ms", body.value_ms], ["value_num", body.value_num]]) {
    if (value !== undefined && value !== null && (!Number.isSafeInteger(Number(value)) || Number(value) < 0 || Number(value) > 86400000)) {
      return invalid(res, { [name]: "Must be a whole number of milliseconds between 0 and 86400000" });
    }
  }

  const loaded = await loadVideo(id, me);
  /* a video the viewer cannot see is a 404, not a 403: confirming existence is the leak */
  if (!loaded || (!loaded.public && !loaded.owner && !isStaff(req))) return missing(res, "Video");

  const keepsValue = event === "watch" || event === "complete";
  const valueMs = keepsValue ? intOrNull(body.value_ms) : null;
  const valueNum = event === "follow_from_video" || event === "impression" ? intOrNull(body.value_num) : null;

  const inserted = await query(
    `INSERT INTO video_activity (video_id, user_id, event, value_ms, value_num, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING`,
    [id, me, event, valueMs, valueNum, dedupe]
  );
  if (inserted.rowCount) {
    return res.json({ recorded: true, deduped: false, videoId: id, event });
  }

  const existing = await query(
    `SELECT user_id::int AS user_id, event FROM video_activity WHERE dedupe_key = $1`,
    [dedupe]
  );
  const owner = existing.rows[0] || null;
  /* somebody else's key is not a replay, it is an attempt to write into their history */
  if (owner && num(owner.user_id) !== me) return forbidden(res, "That activity id belongs to another account");
  res.json({ recorded: false, deduped: true, videoId: id, event });
}));

/* -------------------------------------------------------------------------- */
/*                                  interests                                 */
/* -------------------------------------------------------------------------- */

router.put("/interests", handle(async (req, res) => {
  const me = uid(req);
  const body = req.body || {};
  if (body.userId !== undefined || body.user_id !== undefined) {
    return invalid(res, { userId: "Not allowed" }, "You can only set your own interests");
  }
  const wanted = Array.isArray(body.topics) ? body.topics : [];
  if (wanted.length > 24) return invalid(res, { topics: "Pick up to 24 topics" });

  const cleaned = [];
  for (const entry of wanted) {
    const slug = str(entry && entry.slug, 60).toLowerCase().replace(/^#/, "");
    const weight = Number(entry && entry.weight === undefined ? 1 : entry.weight);
    if (!TOPIC_SLUG.test(slug)) return invalid(res, { topics: `Bad topic slug: ${slug || "(empty)"}` });
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      return invalid(res, { weight: `Weight for ${slug} must be between 0 and 1` });
    }
    if (cleaned.some(item => item.slug === slug)) return invalid(res, { topics: `Duplicate topic: ${slug}` });
    cleaned.push({ slug, weight: Math.round(weight * 1000) / 1000 });
  }

  const ids = await query(
    `SELECT id::int AS id, slug FROM video_topics WHERE slug = ANY($1::text[])`,
    [cleaned.map(entry => entry.slug)]
  );
  const bySlug = new Map(ids.rows.map(row => [String(row.slug).toLowerCase(), num(row.id)]));
  const unknown = cleaned.map(entry => entry.slug).filter(slug => !bySlug.has(slug));
  if (unknown.length) return invalid(res, { topics: `Unknown topic: ${unknown.join(", ")}` });

  /* one atomic unit: the clear and the re-write land together or not at all (DB.batch(), and every
     statement here is a write, so the adapter can defer it — the case cf-api/src/db.js names) */
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM video_interests WHERE user_id = $1`, [me]);
    for (const entry of cleaned) {
      await client.query(
        `INSERT INTO video_interests (user_id, topic_id, weight) VALUES ($1,$2,$3)`,
        [me, bySlug.get(entry.slug), entry.weight]
      );
    }
    const done = await client.query("COMMIT");
    if (done.d1 && done.d1.batched !== cleaned.length + 1) {
      console.error("videos.interests: batched", done.d1.batched, "expected", cleaned.length + 1);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const stored = await query(
    `SELECT t.slug, t.name, vi.weight::float AS weight, vi.updated_at
       FROM video_interests vi JOIN video_topics t ON t.id = vi.topic_id
      WHERE vi.user_id = $1 ORDER BY t.name`,
    [me]
  );
  res.json({
    ok: true,
    topics: stored.rows.map(row => ({
      slug: videos.text(row.slug), name: videos.text(row.name),
      weight: num(row.weight), updatedAt: dto.iso(row.updated_at),
    })),
  });
}));

/* -------------------------------------------------------------------------- */
/*                              staff console                                  */
/* -------------------------------------------------------------------------- */

/* The same guard /api/admin mounts (middleware/security.js), so "staff" means the users.role the
   session lookup read — deny by default, and a token cannot talk its way in. */
admin.use(requireStaff);

async function logAction(req, action, target, outcome, details) {
  await audit({
    actorId: num(req.user.sub),
    action: `videos.${action}`,
    ip: req.ip,
    details: Object.assign({ target, outcome }, details || {}),
  });
}

const STATE = ["pending", "approved", "removed", "all"];

admin.get("/index", handle(async (req, res) => {
  const me = uid(req);
  const state = STATE.includes(str(req.query.state, 12)) ? str(req.query.state, 12) : "pending";
  const limit = pageLimit(req.query.limit);
  const cursor = videos.decodeCursor(req.query.cursor);

  const b = builder();
  const where = [`v.deleted_at IS NULL AND p.deleted_at IS NULL${state === "all" ? "" : ` AND v.moderation_state = ${b.add(state)}`}`];
  const counts = await query(
    `SELECT moderation_state, COUNT(*)::int AS n FROM videos WHERE deleted_at IS NULL GROUP BY moderation_state`
  );

  const ranked = await videos.rankedPage({
    viewer: me,
    where: where.join(" AND "),
    params: b.params,
    order: "v.indexed_at DESC, v.id DESC",
    limit,
    cursor,
    includeAdmin: true,
  });

  res.json({
    items: ranked.items,
    nextCursor: ranked.nextCursor,
    state,
    total: ranked.total,
    counts: counts.rows.map(row => ({ state: videos.text(row.moderation_state), n: num(row.n) })),
  });
}));

/** The row staff is about to change, or nothing. */
async function adminTarget(id) {
  const rows = await query(
    `SELECT id::int AS id, post_id::int AS post_id, kind, provider, canonical_url,
            moderation_state, availability, deleted_at
       FROM videos WHERE id = $1`,
    [id]
  );
  return rows.rows[0] || null;
}

async function setState(req, res, id, { moderationState, availability, action }) {
  const before = await adminTarget(id);
  if (!before || (before.deleted_at && !["reprocess"].includes(action))) return missing(res, "Video");

  const changed = moderationState !== null
    ? moderationState !== before.moderation_state
    : false;
  const availabilityChanged = availability !== undefined && availability !== before.availability;

  const updated = availability === undefined
    ? await query(
        `UPDATE videos SET moderation_state = $2, last_checked_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [id, moderationState]
      )
    : await query(
        `UPDATE videos SET moderation_state = $2, availability = $3, last_checked_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [id, moderationState === null ? before.moderation_state : moderationState, availability]
      );
  if (!updated.rowCount) return missing(res, "Video");

  await logAction(req, action, `video:${id}`, updated.rowCount ? "applied" : "noop", {
    from: before.moderation_state, to: moderationState === null ? before.moderation_state : moderationState,
    availability,
  });
  res.json({
    ok: true,
    videoId: num(id),
    moderationState: moderationState === null ? before.moderation_state : moderationState,
    availability: availability === undefined ? before.availability : availability,
    changed: changed || availabilityChanged,
  });
}

admin.post("/:id/approve", handle((req, res) => setState(req, res, toId(req.params.id, "id"), {
  moderationState: "approved", action: "approve",
})));

admin.post("/:id/remove", handle((req, res) => setState(req, res, toId(req.params.id, "id"), {
  moderationState: "removed", action: "remove",
})));

/**
 * Back to the queue, with availability re-derived by the same gate discovery uses.  A clip whose
 * provider fell off the allowlist, or whose URL now looks like a signed session, stops being
 * distributable here rather than at the next impression.
 */
admin.post("/:id/reprocess", handle(async (req, res) => {
  const id = toId(req.params.id, "id");
  const before = await adminTarget(id);
  if (!before) return missing(res, "Video");

  let availability = "ok";
  if (before.kind !== "upload") {
    const gate = videos.gateUrl(before.canonical_url);
    availability = gate.outcome === "ok" ? "ok" : "checked_failed";
  }
  return setState(req, res, id, { moderationState: "pending", availability, action: "reprocess" });
}));

/* ------------------------------- rank config ------------------------------ */

const shapeConfig = config => ({
  items: videos.RANK_KEYS.map(key => ({ key, weight: config.weights[key] })),
  weights: config.weights,
  sum: config.sum,
});

admin.get("/rank-config", handle(async (req, res) => {
  res.json(shapeConfig(await videos.loadWeights()));
}));

admin.put("/rank-config", handle(async (req, res) => {
  const given = (req.body || {}).weights;
  if (!given || typeof given !== "object") return invalid(res, { weights: "Send an object of the six keys" });

  const keys = videos.RANK_KEYS;
  const names = Object.keys(given);
  const unknown = names.filter(name => !keys.includes(name));
  const missingKeys = keys.filter(name => !names.includes(name));
  const fields = {};
  if (unknown.length) fields.weights = `Unknown key: ${unknown.join(", ")}`;
  if (missingKeys.length) fields.weights = `${fields.weights ? fields.weights + "; " : ""}Missing: ${missingKeys.join(", ")}`;

  const values = {};
  for (const key of keys) {
    const raw = given[key];
    const value = Number(raw);
    if (raw === undefined || raw === null || !Number.isFinite(value) || value < 0 || value > 1) {
      fields[key === "weights" ? "weights" : key] = "Must be a number between 0 and 1";
    }
    values[key] = Math.round((Number(value) || 0) * 1000) / 1000;
  }
  const sum = videos.round(keys.reduce((total, key) => total + (values[key] || 0), 0), 6);
  if (!Object.keys(fields).length && Math.abs(sum - 1) > 0.001) {
    fields.weights = `weights must sum to 1.000, got ${sum.toFixed(3)}`;
  }
  if (Object.keys(fields).length) return invalid(res, fields, "Ranking weights must be six numbers that sum to 1.0");

  /* six UPDATEs that must land together, and every one is a write with no RETURNING — exactly the
     shape cf-api/src/db.js can defer into one DB.batch(), so a mid-batch failure writes nothing */
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const key of keys) {
      await client.query(
        `UPDATE video_rank_config SET weight = $2, updated_at = NOW() WHERE key = $1`,
        [key, values[key]]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    await logAction(req, "rank-config", "video_rank_config", "failed", { error: str(err.message, 200) });
    throw err;
  } finally {
    client.release();
  }

  await logAction(req, "rank-config", "video_rank_config", "applied", { sum });
  res.json(shapeConfig(await videos.loadWeights()));
}));

/* --------------------------------- sources -------------------------------- */

const SOURCE_KINDS = ["rss", "sitemap", "allowlist"];

const toSourceItem = row => ({
  id: num(row.id),
  kind: videos.text(row.kind),
  url: videos.text(row.url),
  provider: videos.text(row.provider),
  enabled: Boolean(row.enabled),
  robotsRespected: Boolean(row.robots_respected),
  lastRunAt: row.last_run_at ? dto.iso(row.last_run_at) : null,
  etag: row.etag ? videos.text(row.etag) : null,
  createdAt: dto.iso(row.created_at),
});

admin.get("/sources", handle(async (req, res) => {
  const rows = await query(
    `SELECT id::int AS id, kind, url, provider, enabled, robots_respected,
            last_run_at, etag, created_at
       FROM video_sources ORDER BY id DESC LIMIT 200`
  );
  res.json({ items: rows.rows.map(toSourceItem) });
}));

admin.post("/sources", handle(async (req, res) => {
  const body = req.body || {};
  const kind = str(body.kind, 12);
  if (!SOURCE_KINDS.includes(kind)) return invalid(res, { kind: `Use one of: ${SOURCE_KINDS.join(", ")}` });

  const gate = videos.gateUrl(body.url);
  if (!gate.provider || gate.outcome !== "ok") {
    /* a feed URL is not a video URL, so the gate is used for scheme + host only */
    const parsed = (() => { try { return new URL(str(body.url, 500)); } catch { return null; } })();
    if (!parsed) return invalid(res, { url: "Not a URL" });
    if (parsed.protocol !== "https:") return invalid(res, { url: "Sources must be https" });
    const provider = videos.providerFor(parsed.hostname);
    if (!provider) return forbidden(res, "That provider is not allowlisted");
  }
  const provider = videos.providerFor(new URL(str(body.url, 500)).hostname);
  const url = str(body.url, 500).trim();

  const clash = await query(`SELECT id::int AS id FROM video_sources WHERE url = $1`, [url]);
  if (clash.rowCount) return fail(res, 409, "duplicate", "That source is already registered", { url: "Already registered" });

  const created = await query(
    `INSERT INTO video_sources (kind, url, provider, enabled, robots_respected)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (url) DO NOTHING
     RETURNING id::int AS id, kind, url, provider, enabled, robots_respected,
               last_run_at, etag, created_at`,
    [kind, url, provider || "self", body.enabled === false ? false : true, body.robotsRespected === false ? false : true]
  );
  if (!created.rowCount) return fail(res, 409, "duplicate", "That source is already registered", { url: "Already registered" });

  await logAction(req, "sources.create", `source:${num(created.rows[0].id)}`, "applied", { kind, provider: provider || "self" });
  res.status(201).json(toSourceItem(created.rows[0]));
}));

/* -------------------------------- discovery ------------------------------- */

/** One candidate URL through the pipeline: gate, dedupe, index, log.  Never reaches the network. */
async function discoverUrl(raw, { me, sourceId }) {
  const url = str(raw, 2000);
  const gate = videos.gateUrl(url);
  const log = async (outcome, detail, videoId) => {
    await query(
      `INSERT INTO video_discovery_log (source_id, url, outcome, detail) VALUES ($1,$2,$3,$4)`,
      [sourceId || null, gate.canonical || url, outcome, detail || null]
    ).catch(err => console.error("videos.discovery: log failed", str(err.message, 120)));
    return { url, outcome, detail: detail || null, videoId: videoId === undefined ? null : videoId };
  };

  if (gate.outcome !== "ok") return log(gate.outcome, gate.detail);

  const known = await query(`SELECT id::int AS id FROM videos WHERE canonical_url = $1`, [gate.canonical]);
  if (known.rowCount) return log("duplicate", "already indexed", num(known.rows[0].id));

  const created = await createVideo({
    me,
    post: {
      content: `Indexed video (${gate.provider})`,
      media: [],
      mediaUrl: null,
      linkUrl: gate.canonical,
      hashtags: [],
    },
    video: {
      kind: "indexed",
      provider: gate.provider,
      canonicalUrl: gate.canonical,
      mediaKey: null,
      embedUrl: gate.embed,
      thumbnailKey: gate.thumbnail,
      durationMs: null, width: null, height: null, topics: [],
    },
  }).catch(err => ({ failed: str(err.message, 160) }));

  if (created.failed) return log("duplicate", created.failed);
  return log("indexed", null, created.videoId);
}

admin.post("/discovery/run", handle(async (req, res) => {
  const me = uid(req);
  const body = req.body || {};
  const given = Array.isArray(body.urls) ? list(body.urls, MAX_URLS_PER_RUN) : [];
  const dropped = (body.urls || []).length > given.length ? (body.urls || []).length - given.length : 0;
  const sourceId = body.sourceId === undefined || body.sourceId === null ? null : toId(body.sourceId, "sourceId");

  let source = null;
  if (sourceId !== null) {
    const rows = await query(
      `SELECT id::int AS id, kind, url, provider, enabled, etag FROM video_sources WHERE id = $1`,
      [sourceId]
    );
    source = rows.rows[0] || null;
    if (!source) return invalid(res, { sourceId: "No such source" });
    if (!num(source.enabled)) return invalid(res, { sourceId: "That source is disabled" });
  }

  const outcomes = [];
  for (const url of given) outcomes.push(await discoverUrl(url, { me, sourceId }));
  if (dropped) outcomes.push({ url: null, outcome: "rejected", detail: "over-cap", videoId: null });

  const indexed = outcomes.filter(entry => entry.outcome === "indexed").map(entry => entry.videoId);
  const duplicates = outcomes.filter(entry => entry.outcome === "duplicate").length;
  const refused = outcomes.length - indexed.length - duplicates;

  if (sourceId !== null) {
    await query(`UPDATE video_sources SET last_run_at = NOW(), etag = $2 WHERE id = $1`,
      [sourceId, str(body.etag, 120) || null]);
  }
  await logAction(req, "discovery.run", sourceId === null ? "video_sources" : `source:${sourceId}`, "applied", {
    processed: outcomes.length, indexed: indexed.length, duplicates, refused,
  });

  res.json({
    processed: outcomes.length,
    indexed,
    duplicates,
    refused,
    outcomes: outcomes.map(entry => Object.assign({}, entry, { detail: entry.detail || (entry.outcome === "indexed" ? null : entry.detail) })),
    sourceId,
    ranAt: new Date().toISOString(),
  });
}));

router.use("/admin", admin);

module.exports = router;
