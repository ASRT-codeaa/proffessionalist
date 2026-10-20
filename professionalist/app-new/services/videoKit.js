const { query } = require("../../db");
const dto = require("../../services/spaDto");
const kit = require("../../services/spaKit");

/* -------------------------------------------------------------------------- *
 *  Video service: the provider gate, the ranking model and the item DTO.
 *
 *  A video is a posts row plus a videos row (app-new/migrations/012_videos.sql), so likes,
 *  comments, shares and saves stay on the routes that already work: this file reads them through
 *  dto.postJoins() rather than counting any of them a second time.  What lives here is only what
 *  videos add — the canonicalisation/provider/robots gate, the weighted ranking, the opaque cursor
 *  and VIDEO_ITEM.
 *
 *  Nothing here touches the network.  Discovery is a pure gate over the URLs an operator posts to
 *  /admin/discovery/run; fetching an rss or sitemap body needs outbound fetch plus a live robots.txt
 *  read, which app-new/README.md lists as not done.
 * -------------------------------------------------------------------------- */

const { HttpError, str, num } = kit;

const EVENTS = ["view_start", "watch", "complete", "like", "save", "share", "follow_from_video", "impression"];

/* The six ranking keys.  Their values live in video_rank_config, so tuning the feed is an UPDATE and
   never a deploy; this list is only the allowlist of names a weight may have. */
const RANK_KEYS = [
  "interest_relevance",
  "watch_completion",
  "engagement",
  "followed_creators",
  "quality_freshness",
  "diversity_discovery",
];
const DEFAULT_WEIGHTS = {
  interest_relevance: 0.30,
  watch_completion: 0.20,
  engagement: 0.15,
  followed_creators: 0.15,
  quality_freshness: 0.10,
  diversity_discovery: 0.10,
};

/* One request ranks this many approved rows before it answers, and never returns more than 30 per
   page.  A bounded window keeps the cost per request fixed and is the honest scope of the claim:
   the feed is a ranking over the recent window, not over the whole table. */
const CANDIDATE_WINDOW = 200;
const MAX_PAGE = 30;

/* The anti-popularity invariant.  Whatever the weights say, one page carries at most two videos by
   the same author, so a single prolific account cannot occupy the feed even with
   diversity_discovery weighted to 0.  tools/test-videos.mjs pins this. */
const MAX_PER_AUTHOR = 2;

const ENGAGEMENT_K = 10; /* saturating normaliser: 10 interactions ≈ 0.5, 90 ≈ 0.9 */
const FRESHNESS_DAYS = 14; /* age at which the freshness feature is down to 0.5 */
const IMPRESSION_SATURATION = 25; /* impressions at which the discovery bonus is spent */

/* -------------------------------------------------------------------------- */
/*                                small values                                */
/* -------------------------------------------------------------------------- */

const text = dto.text;

const round = (value, digits = 6) => {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
};

/** topic_ids is TEXT holding a JSON array of slugs on BOTH dialects (see the migration's note): one
    column, one shape, so no DTO field can become dialect-dependent.  A bad row degrades to "no
    topics" rather than throwing — one broken row must not take the feed down. */
function jsonList(value) {
  if (Array.isArray(value)) return value.map(entry => String(entry)).filter(Boolean);
  const raw = value === null || value === undefined ? "" : String(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(entry => String(entry)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*                         the cursor (opaque, keyset)                        */
/* -------------------------------------------------------------------------- */

/* base64url of {"s":score,"i":videoId,"p":page}.  The id is the tie-breaker and the score is the
   key it was sorted on, so a page boundary is a value pair rather than an offset the client can
   invent; `p` is carried for diagnostics only and is never trusted. */
function encodeCursor({ score, id, page }) {
  const json = JSON.stringify({ s: round(score), i: Number(id), p: Number(page) || 0 });
  return Buffer.from(json, "utf8").toString("base64url");
}

function decodeCursor(value) {
  const raw = str(value, 200);
  if (!raw) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(400, "cursor is invalid", { cursor: "Not valid" });
  }
  if (!parsed || typeof parsed !== "object"
    || !Number.isSafeInteger(Number(parsed.i)) || Number(parsed.i) <= 0
    || !Number.isFinite(Number(parsed.s))) {
    throw new HttpError(400, "cursor is invalid", { cursor: "Not valid" });
  }
  return { score: Number(parsed.s), id: Number(parsed.i), page: Number(parsed.p) || 0 };
}

/* -------------------------------------------------------------------------- */
/*                    providers, canonical URLs, the gate                     */
/* -------------------------------------------------------------------------- */

/* The allowlist.  A provider with no entry here cannot be posted and cannot be indexed, so adding a
   source is a deliberate edit to this file, never something a client can ask for.  `disallow` is a
   snapshot of that host's robots.txt, matched against the request path: a crawler that reads the
   live file needs outbound fetch, which this slice does not do. */
const PROVIDERS = {
  youtube: {
    domains: ["youtube.com", "youtu.be"],
    canonical(url) {
      const id = youtubeId(url);
      if (!id) return null;
      return {
        canonical: `https://www.youtube.com/watch?v=${id}`,
        embed: `https://www.youtube.com/embed/${id}`,
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      };
    },
    /* googleusercontent's own robots file for www.youtube.com, the parts that matter to a resource
       crawler: these paths are player plumbing and sign-in surfaces, not videos */
    disallow: ["/api/", "/t/", "/signin", "/get_video_info", "/youtubei/"],
  },
  vimeo: {
    domains: ["vimeo.com"],
    canonical(url) {
      const m = /^\/(\d{4,})/.exec(url.pathname);
      if (!m) return null;
      return {
        canonical: `https://vimeo.com/${m[1]}`,
        embed: `https://player.vimeo.com/video/${m[1]}`,
        thumbnail: null,
      };
    },
    disallow: ["/algolia/", "/auth/", "/settings", "/staff_picks/"],
  },
  linkedin: {
    domains: ["linkedin.com"],
    canonical(url) {
      const path = url.pathname.replace(/\/+$/, "");
      if (!/^\/(posts|videos|showcase)/.test(path)) return null;
      return {
        /* ?utm_* and ?trk= are tracking, not part of the resource */
        canonical: `https://www.linkedin.com${path}`,
        embed: null,
        thumbnail: null,
      };
    },
    disallow: ["/authwall", "/login", "/mng/", "/uas/", "/feed/sharing"],
  },
};

const LOCAL_HOSTS = ["localhost", "127.0.0.1"];

/** The last two labels of a host, so video.youtube.com and www.youtube.com are one provider. */
function registrable(host) {
  const parts = String(host || "").toLowerCase().split(".").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join(".") : parts.join(".");
}

function providerFor(host) {
  const base = registrable(host);
  return Object.keys(PROVIDERS).find(name => PROVIDERS[name].domains.includes(base)) || null;
}

/** youtu.be/ID, /watch?v=ID, /shorts/ID, /embed/ID, /live/ID — five spellings, one id. */
function youtubeId(url) {
  if (url.hostname.toLowerCase() === "youtu.be") {
    const m = /^\/([A-Za-z0-9_-]{6,20})/.exec(url.pathname);
    return m ? m[1] : null;
  }
  const param = url.searchParams.get("v");
  if (param && /^[A-Za-z0-9_-]{6,20}$/.test(param)) return param;
  const m = /^\/(shorts|embed|live)\/([A-Za-z0-9_-]{6,20})/.exec(url.pathname);
  return m ? m[2] : null;
}

const SIGNED_URL = /(^|[?&])(auth|token|sig|access_key|passwd|password|api_key)=/i;

/**
 * One string in, one decision out.  Never throws, and the order is the policy:
 * parseable -> scheme -> provider allowlist -> recognisable resource -> robots.
 * `{outcome:"ok", canonical, provider, embed, thumbnail}` or `{outcome:"<reason>", detail}`.
 */
function gateUrl(raw) {
  const given = str(raw, 2000);
  if (!given) return { outcome: "rejected", detail: "empty" };

  let url = null;
  try {
    url = new URL(given);
  } catch {
    return { outcome: "rejected", detail: "not a URL" };
  }

  const host = url.hostname.toLowerCase();
  const schemeOk = url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.includes(host));
  if (!schemeOk) return { outcome: "scheme_denied", detail: url.protocol.replace(":", "") };

  const provider = providerFor(host);
  if (!provider) return { outcome: "provider_denied", detail: host };

  const shape = PROVIDERS[provider].canonical(url);
  if (!shape || !shape.canonical) return { outcome: "rejected", detail: `${provider}: unrecognised path` };

  /* robots last: a string that is not a resource at all should not get to report a rule match */
  const path = `${url.pathname}${url.search}`.toLowerCase();
  const rule = PROVIDERS[provider].disallow.find(entry => path.startsWith(entry) || path.includes(entry));
  if (rule) return { outcome: "robots_denied", detail: rule };
  /* a URL carrying a credential is somebody's session, not a video */
  if (SIGNED_URL.test(`${url.pathname}${url.search}`)) return { outcome: "robots_denied", detail: "signed url" };

  return { outcome: "ok", provider, canonical: shape.canonical, embed: shape.embed, thumbnail: shape.thumbnail };
}

/* -------------------------------------------------------------------------- */
/*                              ranking features                              */
/* -------------------------------------------------------------------------- */

/**
 * The weights for this request.  Read from video_rank_config on every feed/search call so an admin's
 * PUT takes effect immediately; a key with no row falls back to the approved default rather than
 * scoring 0 silently, which is what a half-applied migration would otherwise look like.
 */
async function loadWeights() {
  const rows = await query(`SELECT key, weight::float AS weight FROM video_rank_config ORDER BY key`);
  const weights = { ...DEFAULT_WEIGHTS };
  for (const row of rows.rows) {
    if (Object.prototype.hasOwnProperty.call(weights, row.key)) {
      weights[row.key] = num(row.weight, DEFAULT_WEIGHTS[row.key]);
    }
  }
  return {
    weights,
    items: rows.rows.map(row => ({ key: text(row.key), weight: num(row.weight), updatedAt: dto.iso(row.updated_at) })),
    sum: round(RANK_KEYS.reduce((total, key) => total + weights[key], 0), 6),
  };
}

/** The viewer's explicit topic weights: slug -> 0..1. */
async function viewerInterests(viewer) {
  if (!viewer) return new Map();
  const rows = await query(
    `SELECT t.slug, vi.weight::float AS weight
       FROM video_interests vi JOIN video_topics t ON t.id = vi.topic_id
      WHERE vi.user_id = $1`,
    [viewer]
  );
  const map = new Map();
  for (const row of rows.rows) map.set(String(row.slug).toLowerCase(), Math.max(0, Math.min(1, num(row.weight))));
  return map;
}

/** views, watch segments and impressions for a set of videos, in one round trip. */
async function activityStats(videoIds) {
  const list = [...new Set((videoIds || []).map(Number).filter(n => Number.isSafeInteger(n) && n > 0))];
  if (!list.length) return new Map();
  const rows = await query(
    `SELECT video_id::int AS video_id,
            COUNT(CASE WHEN event = 'view_start' THEN 1 END)::int AS views,
            COUNT(CASE WHEN event = 'watch' THEN 1 END)::int AS watch_count,
            COALESCE(SUM(CASE WHEN event = 'watch' THEN value_ms ELSE 0 END), 0)::int AS watch_ms,
            COUNT(CASE WHEN event = 'impression' THEN 1 END)::int AS impressions
       FROM video_activity
      WHERE video_id = ANY($1::bigint[])
      GROUP BY video_id`,
    [list]
  );
  const map = new Map();
  for (const row of rows.rows) {
    map.set(num(row.video_id), {
      views: num(row.views),
      watchCount: num(row.watch_count),
      watchMs: num(row.watch_ms),
      impressions: num(row.impressions),
    });
  }
  return map;
}

const ageInDays = value => {
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? Math.max(0, (Date.now() - at) / 86400000) : 9999;
};

/**
 * The five features that do not depend on what else the page picked, plus the constant half of the
 * diversity feature.  Computed once per candidate per request; the page assembly below only moves
 * the author-repeat factor, which keeps a 200-row window cheap.
 */
function featuresOf(candidate, interests) {
  const stats = candidate.stats || {};
  let match = 0;
  for (const slug of candidate.topics) match += interests.get(slug) || 0;
  const budget = [...interests.values()].reduce((total, weight) => total + weight, 0);
  const interactions = candidate.likeCount + candidate.commentCount + candidate.saveCount + candidate.shareCount;
  const completion = candidate.durationMs && stats.watchCount
    ? stats.watchMs / (candidate.durationMs * stats.watchCount)
    : 0;

  return {
    /* the share of the viewer's interest budget this video's topics cover */
    interest_relevance: round(budget > 0 ? Math.min(1, match / budget) : 0, 4),
    watch_completion: round(Math.min(1, completion), 4),
    engagement: round(interactions / (interactions + ENGAGEMENT_K), 4),
    /* the row carries it already (VIDEO_SELECT's EXISTS over follows), so no second query */
    followed_creators: candidate.row && candidate.row.viewer_follows ? 1 : 0,
    quality_freshness: round(FRESHNESS_DAYS / (FRESHNESS_DAYS + ageInDays(candidate.createdAt)), 4),
  };
}

/** The diversity feature at assembly time: unseen clips score high, repeats of an author drop off. */
const discoveryFeature = (candidate, repeats) => round(
  (1 / (1 + repeats)) * (1 - Math.min(1, num(candidate.stats && candidate.stats.impressions) / IMPRESSION_SATURATION)),
  4
);

const scoreOf = (candidate, weights, repeats) => round(
  RANK_KEYS.filter(key => key !== "diversity_discovery")
    .reduce((total, key) => total + weights[key] * candidate.features[key], 0)
  + weights.diversity_discovery * discoveryFeature(candidate, repeats),
  6
);

/**
 * Greedy page assembly: score what is still allowed, take the best, recount that author's repeats,
 * until the page is full or nothing is allowed.  MAX_PER_AUTHOR is a selection constraint rather
 * than a score term, which is the difference between "diversity usually happens" and "a popularity
 * only weight vector still cannot hand one creator the page".
 */
function rankCandidates(candidates, { weights, interests, limit }) {
  const remaining = candidates.map(candidate => ({
    ...candidate,
    stats: Object.assign({}, candidate.stats || {}),
    features: featuresOf(candidate, interests),
  }));
  const taken = [];
  const byAuthor = new Map();

  while (taken.length < limit && remaining.length) {
    let bestIndex = -1;
    let bestScore = -1;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      if ((byAuthor.get(candidate.authorId) || 0) >= MAX_PER_AUTHOR) continue;
      const score = scoreOf(candidate, weights, byAuthor.get(candidate.authorId) || 0);
      /* ties break on the higher id, which is the newer row: a deterministic order a cursor can
         point into without an arbitrary engine-dependent tie order */
      if (score > bestScore || (score === bestScore && bestIndex >= 0 && candidate.id > remaining[bestIndex].id)) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) break;
    const chosen = remaining.splice(bestIndex, 1)[0];
    chosen.score = bestScore;
    chosen.features.diversity_discovery = discoveryFeature(chosen, byAuthor.get(chosen.authorId) || 0);
    taken.push(chosen);
    byAuthor.set(chosen.authorId, (byAuthor.get(chosen.authorId) || 0) + 1);
  }
  return taken;
}

/* -------------------------------------------------------------------------- */
/*                                 VIDEO_ITEM                               */
/* -------------------------------------------------------------------------- */

/** Uploads play from the bucket through the app's own /uploads convention; links play at home. */
function playUrlOf(row) {
  if (text(row.kind) === "upload") {
    const key = text(row.media_key);
    return key ? `/${key.replace(/^\/+/, "")}` : text(row.canonical_url);
  }
  return text(row.canonical_url);
}

/**
 * thumbnail_key holds an R2/object key for an upload ("posts/7-ab.jpg") or an absolute https URL for
 * a link the poster supplied; one column carries both because a thumbnail is one string either way.
 * Returns null when there is nothing to show, and the client falls back to playUrl.
 */
function thumbnailOf(row) {
  const stored = text(row.thumbnail_key);
  if (stored) return /^https?:\/\//i.test(stored) ? stored : `/${stored.replace(/^\/+/, "")}`;
  const generated = externalThumbnail(row);
  return generated || null;
}

function externalThumbnail(row) {
  if (text(row.provider) !== "youtube") return null;
  const id = /watch\?v=([A-Za-z0-9_-]+)/.exec(text(row.canonical_url));
  return id ? `https://i.ytimg.com/vi/${id[1]}/hqdefault.jpg` : null;
}

function reasonsFor(features, weights) {
  return RANK_KEYS.map(key => ({ key, value: num(features && features[key]), weight: num(weights && weights[key]) }));
}

const rankingOf = (candidate, weights) => ({
  score: round(candidate.score === undefined ? 0 : candidate.score, 6),
  reasons: reasonsFor(candidate.features, weights),
});

/** One joined row in, VIDEO_ITEM out.  Every id is a number, every date an ISO string or null. */
function toVideoItem(row, { stats, ranking, includeAdmin } = {}) {
  const activity = stats || { views: 0 };
  const item = {
    id: num(row.video_id),
    postId: num(row.post_id),
    kind: text(row.kind) || "upload",
    provider: text(row.provider) || "self",
    playUrl: playUrlOf(row),
    thumbnailUrl: thumbnailOf(row),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : num(row.duration_ms),
    width: row.width === null || row.width === undefined ? null : num(row.width),
    height: row.height === null || row.height === undefined ? null : num(row.height),
    caption: text(row.content).trim(),
    hashtags: dto.strArray(row.hashtags),
    topics: jsonList(row.topic_ids),
    author: {
      id: num(row.user_id),
      name: text(row.author_name),
      headline: text(row.headline),
      avatarUrl: text(row.avatar_url),
      viewerFollows: Boolean(row.viewer_follows),
    },
    stats: {
      views: num(activity.views),
      likes: num(row.like_count),
      comments: num(row.comment_count),
      saves: num(row.save_count),
      shares: num(row.share_count),
    },
    viewer: { liked: Boolean(row.my_reaction), saved: Boolean(row.saved) },
    createdAt: dto.iso(row.created_at) || new Date().toISOString(),
    ranking: ranking || { score: 0, reasons: reasonsFor(null, null) },
  };
  if (includeAdmin) {
    item.canonicalUrl = text(row.canonical_url);
    item.embedUrl = row.embed_url === null || row.embed_url === undefined ? null : text(row.embed_url);
    item.moderationState = text(row.moderation_state);
    item.availability = text(row.availability);
    item.sourceUserId = row.source_user_id === null || row.source_user_id === undefined ? null : num(row.source_user_id);
    item.indexedAt = dto.iso(row.indexed_at);
    item.lastCheckedAt = row.last_checked_at ? dto.iso(row.last_checked_at) : null;
  }
  return item;
}

const itemOf = (candidate, { weights, includeAdmin }) => toVideoItem(candidate.row, {
  stats: candidate.stats,
  ranking: rankingOf(candidate, weights),
  includeAdmin,
});

/* -------------------------------------------------------------------------- */
/*                                  the read                                  */
/* -------------------------------------------------------------------------- */

/* The one SELECT every video read uses: videos joined to its post, its author, and the engagement
   the posts tables already count.  $1 is ALWAYS the viewer id — dto.postJoins("$1") and the follows
   EXISTS both hang off it, and every caller is behind authenticate so it is never null. */
const VIDEO_SELECT = `
  v.id::int AS video_id,
  v.post_id::int AS post_id,
  v.kind, v.provider, v.canonical_url, v.media_key, v.embed_url,
  v.thumbnail_key, v.topic_ids, v.moderation_state, v.availability,
  v.source_user_id::int AS source_user_id, v.indexed_at, v.last_checked_at,
  v.duration_ms::int AS duration_ms, v.width::int AS width, v.height::int AS height,
  p.content, p.media, p.media_url, COALESCE(p.hashtags, '{}') AS hashtags, p.created_at,
  u.id::int AS user_id,
  COALESCE(u.name, u.username, '') AS author_name,
  COALESCE(pr.headline, pr.job_title, '') AS headline,
  COALESCE(pr.avatar_url, '') AS avatar_url,
  COALESCE(lc.count, 0)::int AS like_count,
  COALESCE(cc.count, 0)::int AS comment_count,
  COALESCE(sc.count, 0)::int AS share_count,
  COALESCE(sv.count, 0)::int AS save_count,
  pl.reaction AS my_reaction,
  (si.id IS NOT NULL) AS saved,
  EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1::bigint AND f.following_id = p.user_id) AS viewer_follows`;

/** dto.postJoins carries the like/comment/share/viewer joins; the save count is the one addition. */
function videoJoins() {
  return `${dto.postJoins("$1")}
    LEFT JOIN (SELECT ref_id, COUNT(*) AS count FROM saved_items
                WHERE item_type = 'post' GROUP BY ref_id) sv ON sv.ref_id = p.id::text`;
}

/** approved + playable + not deleted + an active author: what any non-staff viewer may see. */
const PUBLIC_CLAUSE = `v.deleted_at IS NULL AND p.deleted_at IS NULL
  AND v.moderation_state = 'approved' AND v.availability = 'ok' AND u.status = 'active'`;

/** everything that exists, for staff and for the author's own reads. */
const ANY_CLAUSE = `v.deleted_at IS NULL AND p.deleted_at IS NULL AND u.status = 'active'`;

async function selectVideos({ viewer, where, params, order, limit }) {
  const size = Math.max(1, Math.min(500, Number(limit) || CANDIDATE_WINDOW));
  const rows = await query(
    `SELECT ${VIDEO_SELECT}
       FROM videos v
       JOIN posts p ON p.id = v.post_id
       JOIN users u ON u.id = p.user_id
       LEFT JOIN profiles pr ON pr.user_id = u.id
       ${videoJoins()}
      WHERE ${where}
      ORDER BY ${order}
      LIMIT ${size}`,
    [viewer, ...(params || [])]
  );
  return rows.rows.map(row => ({
    id: num(row.video_id),
    authorId: num(row.user_id),
    topics: jsonList(row.topic_ids),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : num(row.duration_ms),
    createdAt: row.created_at,
    likeCount: num(row.like_count),
    commentCount: num(row.comment_count),
    saveCount: num(row.save_count),
    shareCount: num(row.share_count),
    stats: { views: 0, watchCount: 0, watchMs: 0, impressions: 0 },
    row,
  }));
}

/**
 * The whole read in one call: window -> attach activity -> rank -> keyset past the cursor ->
 * VIDEO_ITEMs.  Feed, search and the admin index all go through it, so there is one ranking path.
 */
async function rankedPage({ viewer, where, params, order, window = CANDIDATE_WINDOW, limit, cursor, weights, includeAdmin }) {
  const config = weights || (await loadWeights()).weights;
  const candidates = await selectVideos({ viewer, where, params, order, limit: window });
  const stats = await activityStats(candidates.map(candidate => candidate.id));
  for (const candidate of candidates) {
    candidate.stats = Object.assign({}, stats.get(candidate.id) || {}, { authorOnPage: 0 });
  }
  const interests = await viewerInterests(viewer);

  /* rank one past the page: the extra item is what tells us a nextCursor is honest */
  const ranked = rankCandidates(candidates, { weights: config, interests, limit: window });
  const after = cursor
    ? (() => {
      const at = ranked.findIndex(candidate => candidate.id === cursor.id);
      return at >= 0
        ? ranked.slice(at + 1)
        : ranked.filter(candidate => candidate.score < cursor.score
          || (candidate.score === cursor.score && candidate.id < cursor.id));
    })()
    : ranked;

  const slice = after.slice(0, limit);
  const last = slice[slice.length - 1];
  return {
    items: slice.map(candidate => itemOf(candidate, { weights: config, includeAdmin })),
    nextCursor: last && after.length > slice.length
      ? encodeCursor({ score: last.score, id: last.id, page: (cursor ? cursor.page : 0) + 1 })
      : null,
    total: ranked.length,
    weights: config,
  };
}

module.exports = {
  EVENTS, RANK_KEYS, DEFAULT_WEIGHTS, PROVIDERS,
  CANDIDATE_WINDOW, MAX_PAGE, MAX_PER_AUTHOR, ENGAGEMENT_K, FRESHNESS_DAYS, IMPRESSION_SATURATION,
  text, round, jsonList, encodeCursor, decodeCursor,
  registrable, providerFor, youtubeId, gateUrl,
  loadWeights, viewerInterests, activityStats, featuresOf, discoveryFeature, rankCandidates,
  playUrlOf, thumbnailOf, reasonsFor, toVideoItem, itemOf,
  VIDEO_SELECT, videoJoins, PUBLIC_CLAUSE, ANY_CLAUSE, selectVideos, rankedPage,
};
