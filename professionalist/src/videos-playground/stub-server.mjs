#!/usr/bin/env node
/**
 * stub-server.mjs — DEV-ONLY backend for the videos playground.
 *
 * It is not part of the shipped app and is not read by src/pages, src/components/video or
 * src/services. Its only job is to answer the documented routes from
 * docs/videos-api-contract.md (plus the reused /api/posts and /api/network engagement
 * routes) with the EXACT contract shapes — numeric ids, VIDEO_ITEM, `{error:{code,
 * message,fields}}` — so the real components can be driven over HTTP while the app spine
 * around them is still being built. It mirrors app-new/routes/spa/videos.js; if the two
 * disagree, the contract doc wins (and this file is wrong).
 *
 *   node src/videos-playground/stub-server.mjs        # listens on 127.0.0.1:8811
 *
 * State is in memory: likes, saves, comments, interests and the admin index persist for
 * the run so the optimistic UI has something to reconcile against. Media files are
 * fetched once from a public sample list into node_modules/.cache (never committed) and
 * streamed with Range support, exactly like the app's /uploads pipeline.
 */

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.VIDEOS_STUB_PORT || 8811);

const { FIXTURE_ITEMS, FIXTURE_COMMENTS, FIXTURE_TOPICS } = await import("./fixtures/contractShapes.ts");

const ALLOWED_EVENTS = new Set([
  "view_start",
  "watch",
  "complete",
  "like",
  "save",
  "share",
  "follow_from_video",
  "impression",
]);
const TOPIC_SLUGS = new Map(FIXTURE_TOPICS.map((t) => [t.slug, t.name]));
const PROVIDER_HOSTS = [
  ["youtube", /(^|\.)youtube\.com$/i, /^https?:$/],
  ["youtube", /^youtu\.be$/i, /^https?:$/],
  ["vimeo", /(^|\.)vimeo\.com$/i, /^https?:$/],
  ["linkedin", /(^|\.)linkedin\.com$/i, /^https?:$/],
];

/** Mutable copies so engagement and interests behave like a server. */
let nextId = 100;
const items = FIXTURE_ITEMS.map((item) => ({
  ...item,
  stats: { ...item.stats },
  viewer: { ...item.viewer },
  author: { ...item.author },
  hashtags: [...item.hashtags],
  topics: [...item.topics],
}));
/** The admin index: every video with its moderation row. */
const moderation = new Map(
  items.map((item, i) => [
    item.id,
    {
      moderationState: i === 0 ? "approved" : "approved",
      availability: item.playUrl.includes("does-not-exist") ? "unavailable" : "ok",
      canonicalUrl: item.playUrl,
      sourceUserId: item.author.id,
      indexedAt: item.createdAt,
      lastCheckedAt: null,
    },
  ]),
);
const commentsByPost = new Map();
/** Interests: Map<slug, weight> — only ever written through PUT (contract: no GET). */
const interests = new Map();
const activityDedupes = new Set();
const activityLog = [];
const following = new Set();
const rankConfig = {
  interest_relevance: 0.3,
  watch_completion: 0.2,
  engagement: 0.15,
  followed_creators: 0.15,
  quality_freshness: 0.1,
  diversity_discovery: 0.1,
};
const sources = [
  {
    id: 5,
    kind: "rss",
    url: "https://www.youtube.com/feeds/videos.xml?channel_id=example",
    provider: "youtube",
    enabled: true,
    robotsRespected: true,
    lastRunAt: null,
    etag: null,
    createdAt: new Date().toISOString(),
  },
];

for (const item of items) commentsByPost.set(item.postId, []);
commentsByPost.set(items[0].postId, FIXTURE_COMMENTS.map((c) => ({ ...c, author: { ...c.author } })));

const SAMPLE_SOURCES = [
  "https://mdn.github.io/shared-assets/videos/flower.mp4",
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
  "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
];
const CACHE_DIR = path.join(process.cwd(), "node_modules", ".cache", "professionalist-videos");

/* --------------------------------- media ---------------------------------- */

function thumbSvg(index) {
  const hues = [[222, 79], [215, 60], [268, 55], [152, 55], [12, 70], [200, 65]];
  const [hue, sat] = hues[index % hues.length];
  const label = ["Pricing pages", "Design review", "Query plans", "Hiring for judgement", "Missing source", "Studio tour"][index % 6];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="hsl(${hue} ${sat}% 22%)"/><stop offset="100%" stop-color="hsl(${hue + 30} ${sat}% 42%)"/>
  </linearGradient></defs>
  <rect width="720" height="1280" fill="url(#g)"/>
  <text x="48" y="1120" font-family="Inter, system-ui, sans-serif" font-size="46" font-weight="700" fill="#fff">${label}</text>
  <text x="48" y="1180" font-family="Inter, system-ui, sans-serif" font-size="30" fill="#ffffffb3">Professionalist playground fixture</text>
</svg>`;
}

function avatarSvg(seed) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  const initials = seed.slice(0, 2).toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <rect width="96" height="96" rx="48" fill="hsl(${hash} 65% 46%)"/>
  <text x="48" y="60" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="34" font-weight="700" fill="#fff">${initials}</text>
</svg>`;
}

async function sampleClip(index) {
  if (!existsSync(CACHE_DIR)) await mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `sample-${index}.mp4`);
  if (existsSync(file)) return readFile(file);
  const url = SAMPLE_SOURCES[index % SAMPLE_SOURCES.length];
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(file, buf);
    console.log(`[videos-stub] cached ${url} (${buf.length} bytes)`);
    return buf;
  } catch (err) {
    console.warn(`[videos-stub] could not fetch ${url}: ${err.message}`);
    return null;
  }
}

function sendRange(req, res, body, type) {
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : body.length - 1;
    res.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${body.length}`,
      "accept-ranges": "bytes",
    });
    res.end(body.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": String(body.length), "accept-ranges": "bytes" });
  res.end(body);
}

/* -------------------------------- helpers --------------------------------- */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
  res.end(body);
}

function fail(res, status, code, message, fields = {}) {
  return json(res, status, { error: { code, message, fields } });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function readJson(req) {
  const raw = (await readBody(req)).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function paginate(list, cursor, limit) {
  const offset = Number(cursor || 0);
  const size = Math.min(30, Math.max(1, Number(limit || 10)));
  const slice = list.slice(offset, offset + size);
  const next = offset + size < list.length ? String(offset + size) : null;
  return { items: slice, nextCursor: next };
}

function findItem(id) {
  return items.find((item) => item.id === Number(id)) ?? null;
}

function detailOf(item) {
  const mod = moderation.get(item.id) ?? {};
  return {
    ...item,
    canonicalUrl: mod.canonicalUrl ?? item.playUrl,
    embedUrl: item.kind === "link" || item.kind === "indexed" ? item.playUrl : null,
    moderationState: mod.moderationState ?? "approved",
    availability: mod.availability ?? "ok",
    indexedAt: mod.indexedAt ?? item.createdAt,
    comments: commentsByPost.get(item.postId) ?? [],
  };
}

function tabList(tab) {
  if (tab === "following") return items.filter((item) => following.has(item.author.id));
  if (tab === "trending") {
    // documented rule: recent engagement, newest wins ties
    return [...items].sort((a, b) => engagement(b) - engagement(a) || new Date(b.createdAt) - new Date(a.createdAt));
  }
  return [...items].sort((a, b) => (b.ranking?.score ?? 0) - (a.ranking?.score ?? 0));
}

function engagement(item) {
  const s = item.stats;
  return s.likes + s.comments + s.saves + s.shares;
}

function providerOf(url) {
  for (const [provider, hostRe] of PROVIDER_HOSTS) if (hostRe.test(url.hostname)) return provider;
  return null;
}

function gateUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { outcome: "rejected" };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && /localhost|\[::1\]|127\./.test(url.hostname))) {
    return { outcome: "scheme_denied" };
  }
  const provider = providerOf(url);
  if (!provider) return { outcome: "provider_denied" };
  return { outcome: "ok", provider, canonical: url.toString() };
}

/* --------------------------------- routes --------------------------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    });
    return res.end();
  }

  if (pathname.startsWith("/media/")) {
    const clip = /^\/media\/clip-(\d+)\.mp4$/.exec(pathname);
    if (clip) {
      const body = await sampleClip(Number(clip[1]));
      if (!body) return fail(res, 503, "unavailable", "Sample clip not reachable from this machine.");
      return sendRange(req, res, body, "video/mp4");
    }
    if (pathname === "/media/does-not-exist.mp4") {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    const thumb = /^\/media\/thumb-(\d+)\.svg$/.exec(pathname);
    if (thumb) {
      const body = Buffer.from(thumbSvg(Number(thumb[1])));
      res.writeHead(200, { "content-type": "image/svg+xml", "content-length": String(body.length) });
      return res.end(body);
    }
    const avatar = /^\/media\/avatar-(.+)\.svg$/.exec(pathname);
    if (avatar) {
      const body = Buffer.from(avatarSvg(avatar[1]));
      res.writeHead(200, { "content-type": "image/svg+xml", "content-length": String(body.length) });
      return res.end(body);
    }
  }

  /* ------------------------------ videos feed ------------------------------ */

  if (method === "GET" && pathname === "/api/videos/feed") {
    const tab = ["for-you", "following", "trending"].includes(url.searchParams.get("tab"))
      ? url.searchParams.get("tab")
      : "for-you";
    const page = paginate(tabList(tab), url.searchParams.get("cursor"), url.searchParams.get("limit") || 3);
    return json(res, 200, { ...page, tab });
  }

  if (method === "GET" && pathname === "/api/videos/search") {
    const q = (url.searchParams.get("q") || "").toLowerCase().slice(0, 80).trim();
    if (!q) return json(res, 200, { items: [], nextCursor: null, query: "", total: 0 });
    const matched = items.filter(
      (item) =>
        item.caption.toLowerCase().includes(q) ||
        item.topics.join(" ").toLowerCase().includes(q) ||
        item.hashtags.join(" ").toLowerCase().includes(q) ||
        item.author.name.toLowerCase().includes(q),
    );
    return json(res, 200, { items: matched, nextCursor: null, query: q, total: matched.length });
  }

  if (method === "GET" && pathname === "/api/videos/topics") {
    return json(res, 200, { items: FIXTURE_TOPICS });
  }

  /* ------------------------------- admin (stub: staff always) --------------- */

  if (pathname.startsWith("/api/videos/admin/")) {
    return handleAdmin(pathname, method, url, req, res);
  }

  /* --------------------------------- create -------------------------------- */

  if (pathname === "/api/videos" && method === "POST") {
    const contentType = req.headers["content-type"] || "";
    if (contentType.includes("application/json")) {
      const body = await readJson(req);
      if (body.userId !== undefined || body.user_id !== undefined || body.role !== undefined) {
        return fail(res, 400, "validation_error", "A video is always owned by the signed-in account", { userId: "Not allowed" });
      }
      const gate = gateUrl(body.url);
      if (gate.outcome === "provider_denied") return fail(res, 403, "forbidden", "That provider is not allowlisted");
      if (gate.outcome !== "ok") return fail(res, 400, "validation_error", `URL refused: ${gate.outcome}`, { url: "Add a video URL or attach a file" });
      if (items.some((item) => item.playUrl === gate.canonical)) {
        return fail(res, 409, "duplicate", "This video is already in the index", { url: "Already indexed" });
      }
      const unknown = (Array.isArray(body.topics) ? body.topics : []).filter((slug) => !TOPIC_SLUGS.has(String(slug)));
      if (unknown.length) return fail(res, 400, "validation_error", `Unknown topic: ${unknown.join(", ")}`, { topics: "Unknown topic" });
      const id = ++nextId;
      const item = {
        id,
        postId: 2000 + id,
        kind: "link",
        provider: gate.provider,
        playUrl: gate.canonical,
        thumbnailUrl: body.thumbnailUrl || null,
        durationMs: Number.isFinite(body.durationMs) ? body.durationMs : null,
        width: Number.isFinite(body.width) ? body.width : null,
        height: Number.isFinite(body.height) ? body.height : null,
        caption: String(body.caption || gate.canonical).slice(0, 2000),
        hashtags: [],
        topics: Array.isArray(body.topics) ? body.topics : [],
        author: { id: 101, name: "You (playground)", headline: "Signed-in fixture user", avatarUrl: "/media/avatar-me.svg", viewerFollows: false },
        stats: { views: 0, likes: 0, comments: 0, saves: 0, shares: 0 },
        viewer: { liked: false, saved: false },
        createdAt: new Date().toISOString(),
        ranking: { score: 0, reasons: [] },
      };
      items.push(item);
      commentsByPost.set(item.postId, []);
      moderation.set(id, { moderationState: "pending", availability: "ok", canonicalUrl: gate.canonical, sourceUserId: 101, indexedAt: item.createdAt, lastCheckedAt: null });
      return json(res, 201, detailOf(item));
    }

    // multipart upload: validate the parts the same way the real API does
    const raw = (await readBody(req)).toString("latin1");
    const fileMatch = /name="file"; filename="([^"]*)"\r\n([^\r\n]*)/.exec(raw);
    const filename = fileMatch?.[1] || "";
    const fileHeader = fileMatch?.[2] || "";
    if (!filename) return fail(res, 400, "validation_error", "Attach a video file.", { file: "A video file is MP4, WEBM or MOV" });
    const mime = /mimetype:\s*([\w/+-]+)/i.exec(fileHeader)?.[1] || "";
    const kindMimeOk = /^video\/(mp4|webm|quicktime|x-m4v)/i.test(mime) || /\.(mp4|webm|mov|m4v)$/i.test(filename);
    if (!kindMimeOk) return fail(res, 400, "validation_error", "Use a PNG, JPG, WEBP, GIF, MP4 or PDF file", { file: "A video file is MP4, WEBM or MOV" });
    const bytes = Buffer.byteLength(raw, "latin1");
    if (bytes > 12 * 1024 * 1024) return fail(res, 400, "validation_error", "Keep each file under 12 MB.", { file: "Over the byte limit" });
    const caption = /name="caption"[\s\S]*?\r\n\r\n([^\r]*)/.exec(raw)?.[1]?.trim() || "";
    if (!caption) return fail(res, 400, "validation_error", "Say what this video is about", { caption: "Required for uploads" });
    const topics = [...raw.matchAll(/name="topics"[\s\S]*?\r\n\r\n([^\r]*)/g)].map((m) => m[1].trim()).filter(Boolean);
    const unknown = topics.filter((slug) => !TOPIC_SLUGS.has(slug));
    if (unknown.length) return fail(res, 400, "validation_error", `Unknown topic: ${unknown.join(", ")}`, { topics: "Unknown topic" });
    const id = ++nextId;
    const item = {
      id,
      postId: 2000 + id,
      kind: "upload",
      provider: "self",
      playUrl: "/media/clip-1.mp4",
      thumbnailUrl: null,
      durationMs: Number(/name="durationMs"[\s\S]*?\r\n\r\n(\d+)/.exec(raw)?.[1]) || 12_000,
      width: Number(/name="width"[\s\S]*?\r\n\r\n(\d+)/.exec(raw)?.[1]) || 720,
      height: Number(/name="height"[\s\S]*?\r\n\r\n(\d+)/.exec(raw)?.[1]) || 1280,
      caption: caption.slice(0, 2000),
      hashtags: [],
      topics,
      author: { id: 101, name: "You (playground)", headline: "Signed-in fixture user", avatarUrl: "/media/avatar-me.svg", viewerFollows: false },
      stats: { views: 0, likes: 0, comments: 0, saves: 0, shares: 0 },
      viewer: { liked: false, saved: false },
      createdAt: new Date().toISOString(),
      ranking: { score: 0, reasons: [] },
    };
    items.push(item);
    commentsByPost.set(item.postId, []);
    moderation.set(id, { moderationState: "pending", availability: "ok", canonicalUrl: item.playUrl, sourceUserId: 101, indexedAt: item.createdAt, lastCheckedAt: null });
    return json(res, 201, detailOf(item));
  }

  /* -------------------------------- activity -------------------------------- */

  const activityMatch = /^\/api\/videos\/(\d+)\/activity$/.exec(pathname);
  if (activityMatch && method === "POST") {
    const body = await readJson(req);
    const videoId = Number(activityMatch[1]);
    if (!findItem(videoId)) return fail(res, 404, "not_found", "Video was not found");
    if (!ALLOWED_EVENTS.has(body?.event)) return fail(res, 400, "validation_error", "event is not a known activity", { event: "Not valid" });
    const key = String(body?.dedupe_key ?? "");
    if (!key || key.length > 120) return fail(res, 400, "validation_error", "dedupe_key is required (1-120 chars)", { dedupe_key: "Not valid" });
    for (const field of ["value_ms", "value_num"]) {
      const v = body[field];
      if (v != null && (!Number.isInteger(v) || v < 0 || v > 86_400_000)) {
        return fail(res, 400, "validation_error", `${field} must be 0..86400000`, { [field]: "Not valid" });
      }
    }
    const deduped = activityDedupes.has(key);
    if (!deduped) {
      activityDedupes.add(key);
      activityLog.push({ videoId, event: body.event, value_ms: body.value_ms ?? null, value_num: body.value_num ?? null, dedupe_key: key, at: Date.now() });
    }
    return json(res, 200, { recorded: !deduped, deduped, videoId, event: body.event });
  }

  /* -------------------------------- interests ------------------------------- */

  if (pathname === "/api/videos/interests" && method === "PUT") {
    const body = await readJson(req);
    if (body.userId !== undefined || body.user_id !== undefined) {
      return fail(res, 400, "validation_error", "You can only set your own interests", { userId: "Not allowed" });
    }
    const wanted = Array.isArray(body.topics) ? body.topics : [];
    if (wanted.length > 24) return fail(res, 400, "validation_error", "Pick up to 24 topics", { topics: "Too many" });
    const cleaned = [];
    for (const entry of wanted) {
      const slug = String(entry?.slug ?? "").toLowerCase().replace(/^#/, "");
      const weight = Number(entry?.weight === undefined ? 1 : entry.weight);
      if (!TOPIC_SLUGS.has(slug)) return fail(res, 400, "validation_error", `Unknown topic: ${slug || "(empty)"}`, { topics: "Unknown topic" });
      if (!Number.isFinite(weight) || weight < 0 || weight > 1) return fail(res, 400, "validation_error", `Weight for ${slug} must be between 0 and 1`, { weight: "Not valid" });
      if (cleaned.some((row) => row.slug === slug)) return fail(res, 400, "validation_error", `Duplicate topic: ${slug}`, { topics: "Duplicate" });
      cleaned.push({ slug, weight });
    }
    interests.clear();
    for (const row of cleaned) interests.set(row.slug, row.weight);
    const echo = cleaned.map((row) => ({ slug: row.slug, name: TOPIC_SLUGS.get(row.slug), weight: row.weight, updatedAt: new Date().toISOString() }));
    return json(res, 200, { ok: true, topics: echo });
  }

  /* ------------------------------ single video ------------------------------ */

  const videoMatch = /^\/api\/videos\/(\d+)$/.exec(pathname);
  if (videoMatch && method === "GET") {
    const item = findItem(videoMatch[1]);
    if (!item) return fail(res, 404, "not_found", "Video was not found");
    return json(res, 200, detailOf(item));
  }

  /* ---------- existing post engagement endpoints (reused by the contract) ---------- */

  const likeMatch = /^\/api\/posts\/(\d+)\/like$/.exec(pathname);
  if (likeMatch && method === "POST") {
    const body = await readJson(req);
    const item = items.find((row) => row.postId === Number(likeMatch[1]));
    if (!item) return fail(res, 404, "not_found", "Post not found.");
    const reaction = body?.reaction ?? null;
    const liked = Boolean(reaction);
    if (liked !== item.viewer.liked) item.stats.likes = Math.max(0, item.stats.likes + (liked ? 1 : -1));
    item.viewer.liked = liked;
    return json(res, 200, { liked, likeCount: item.stats.likes, reaction });
  }

  const saveMatch = /^\/api\/posts\/(\d+)\/save$/.exec(pathname);
  if (saveMatch && method === "POST") {
    const item = items.find((row) => row.postId === Number(saveMatch[1]));
    if (!item) return fail(res, 404, "not_found", "Post not found.");
    item.viewer.saved = !item.viewer.saved;
    item.stats.saves = Math.max(0, item.stats.saves + (item.viewer.saved ? 1 : -1));
    return json(res, 200, { saved: item.viewer.saved });
  }

  const shareMatch = /^\/api\/posts\/(\d+)\/share$/.exec(pathname);
  if (shareMatch && method === "POST") {
    const item = items.find((row) => row.postId === Number(shareMatch[1]));
    if (!item) return fail(res, 404, "not_found", "Post not found.");
    item.stats.shares += 1;
    return json(res, 200, { shareCount: item.stats.shares });
  }

  const commentsMatch = /^\/api\/posts\/(\d+)\/comments$/.exec(pathname);
  if (commentsMatch && (method === "GET" || method === "POST")) {
    const postId = Number(commentsMatch[1]);
    const list = commentsByPost.get(postId) || [];
    if (method === "GET") return json(res, 200, list); // plain array, oldest first (toComment DTO)
    const body = await readJson(req);
    const text = String(body?.text || "").trim();
    if (!text) return fail(res, 400, "validation_error", "Comment text is required.", { text: "Write something first." });
    const created = {
      id: ++nextId,
      postId,
      text,
      author: { id: 101, name: "You (playground)", headline: "Signed-in fixture user", avatarUrl: "/media/avatar-me.svg", viewerFollows: false },
      likeCount: 0,
      liked: false,
      createdAt: new Date().toISOString(),
    };
    list.push(created);
    commentsByPost.set(postId, list);
    const item = items.find((row) => row.postId === postId);
    if (item) item.stats.comments = list.length;
    return json(res, 201, created);
  }

  const commentDeleteMatch = /^\/api\/posts\/comments\/(\d+)$/.exec(pathname);
  if (commentDeleteMatch && method === "DELETE") {
    const id = Number(commentDeleteMatch[1]);
    for (const [postId, list] of commentsByPost) {
      const next = list.filter((c) => c.id !== id);
      if (next.length !== list.length) {
        commentsByPost.set(postId, next);
        const item = items.find((row) => row.postId === postId);
        if (item) item.stats.comments = next.length;
      }
    }
    return json(res, 200, { ok: true });
  }

  if ((pathname === "/api/network/follow" || pathname === "/api/network/unfollow") && method === "POST") {
    const body = await readJson(req);
    const userId = Number(body?.userId);
    if (pathname.endsWith("network/follow")) following.add(userId);
    else following.delete(userId);
    for (const item of items) if (item.author.id === userId) item.author.viewerFollows = following.has(userId);
    return json(res, 200, { following: following.has(userId) });
  }

  if (pathname === "/api/_stub/state" && method === "GET") {
    return json(res, 200, {
      activity: activityLog.slice(-40),
      following: [...following],
      interestCount: interests.size,
      interests: [...interests.entries()].map(([slug, weight]) => ({ topic: slug, weight })),
    });
  }

  return fail(res, 404, "not_found", `No stub route for ${method} ${pathname}.`);
});

/* ---------------------------------- admin ---------------------------------- */

function handleAdmin(pathname, method, url, req, res) {
  const indexMatch = /^\/api\/videos\/admin\/index$/.exec(pathname);
  if (indexMatch && method === "GET") {
    const state = url.searchParams.get("state") || "pending";
    const rows = items
      .map((item) => ({ ...item, ...(moderation.get(item.id) ?? {}) }))
      .filter((row) => state === "all" || row.moderationState === state);
    const page = paginate(rows, url.searchParams.get("cursor"), url.searchParams.get("limit"));
    return json(res, 200, { ...page, total: rows.length, state });
  }

  const stateMatch = /^\/api\/videos\/admin\/(\d+)\/(approve|remove|reprocess)$/.exec(pathname);
  if (stateMatch && method === "POST") {
    const id = Number(stateMatch[1]);
    const call = stateMatch[2];
    const mod = moderation.get(id);
    if (!findItem(id) || !mod) return fail(res, 404, "not_found", "Video was not found");
    const changed = mod.moderationState !== (call === "approve" ? "approved" : call === "remove" ? "removed" : "pending");
    if (call === "approve") {
      mod.moderationState = "approved";
      mod.lastCheckedAt = new Date().toISOString();
      return json(res, 200, { ok: true, videoId: id, moderationState: "approved", availability: mod.availability, changed });
    }
    if (call === "remove") {
      mod.moderationState = "removed";
      return json(res, 200, { ok: true, videoId: id, moderationState: "removed", changed });
    }
    mod.moderationState = "pending";
    return json(res, 200, { ok: true, videoId: id, moderationState: "pending", availability: mod.availability, changed });
  }

  if (pathname === "/api/videos/admin/rank-config") {
    if (method === "PUT") {
      return readJson(req).then((body) => {
        const keys = Object.keys(rankConfig);
        const weights = body?.weights ?? {};
        const given = Object.keys(weights);
        if (given.some((k) => !keys.includes(k)) || keys.some((k) => !(k in weights))) {
          return fail(res, 400, "validation_error", "all six weight keys are required", { weights: "Missing or unknown key" });
        }
        for (const k of keys) {
          if (typeof weights[k] !== "number" || weights[k] < 0 || weights[k] > 1) {
            return fail(res, 400, "validation_error", `weight ${k} must be 0..1`, { weights: k });
          }
        }
        const sum = keys.reduce((acc, k) => acc + weights[k], 0);
        if (Math.abs(sum - 1) > 0.001) {
          return fail(res, 400, "validation_error", `weights must sum to 1.000, got ${sum.toFixed(3)}`, { weights: "sum" });
        }
        Object.assign(rankConfig, weights);
        return json(res, 200, rankConfigPayload());
      });
    }
    if (method !== "GET") return fail(res, 404, "not_found", `No stub route for ${method} ${pathname}.`);
    return json(res, 200, rankConfigPayload());
  }

  if (pathname === "/api/videos/admin/sources") {
    if (method === "GET") return json(res, 200, { items: sources });
    if (method === "POST") {
      return readJson(req).then((body) => {
        let parsed;
        try {
          parsed = new URL(String(body.url));
        } catch {
          return fail(res, 400, "validation_error", "url is not valid", { url: "Not valid" });
        }
        if (parsed.protocol !== "https:") return fail(res, 400, "validation_error", "url must be https", { url: "https only" });
        if (!["rss", "sitemap", "allowlist"].includes(body.kind)) return fail(res, 400, "validation_error", "kind is not valid", { kind: "Not valid" });
        if (!["youtube", "vimeo", "linkedin"].includes(body.provider)) return fail(res, 400, "validation_error", "provider is not allowlisted", { provider: "Not valid" });
        if (sources.some((row) => row.url === parsed.toString())) return fail(res, 409, "duplicate", "This source is already registered", { url: "Duplicate" });
        const row = {
          id: ++nextId,
          kind: body.kind,
          url: parsed.toString(),
          provider: body.provider,
          enabled: body.enabled !== false,
          robotsRespected: true,
          lastRunAt: null,
          etag: null,
          createdAt: new Date().toISOString(),
        };
        sources.push(row);
        return json(res, 201, row);
      });
    }
    return fail(res, 404, "not_found", `No stub route for ${method} ${pathname}.`);
  }

  if (pathname === "/api/videos/admin/discovery/run" && method === "POST") {
    return readJson(req).then((body) => {
      const urls = (Array.isArray(body.urls) ? body.urls : []).slice(0, 50);
      const outcomes = urls.map((rawUrl) => {
        const gate = gateUrl(rawUrl);
        if (gate.outcome !== "ok") {
          return { url: String(rawUrl), outcome: gate.outcome === "scheme_denied" ? "scheme_denied" : gate.outcome === "provider_denied" ? "provider_denied" : "rejected", videoId: null, detail: gate.outcome };
        }
        if (items.some((item) => item.playUrl === gate.canonical)) {
          return { url: String(rawUrl), outcome: "duplicate", videoId: null, detail: null };
        }
        const id = ++nextId;
        const item = {
          id,
          postId: 2000 + id,
          kind: "indexed",
          provider: gate.provider,
          playUrl: gate.canonical,
          thumbnailUrl: null,
          durationMs: null,
          width: null,
          height: null,
          caption: `Indexed: ${gate.canonical}`,
          hashtags: [],
          topics: [],
          author: { id: 101, name: "Discovery (stub)", headline: "", avatarUrl: null, viewerFollows: false },
          stats: { views: 0, likes: 0, comments: 0, saves: 0, shares: 0 },
          viewer: { liked: false, saved: false },
          createdAt: new Date().toISOString(),
          ranking: { score: 0, reasons: [] },
        };
        items.push(item);
        commentsByPost.set(item.postId, []);
        moderation.set(id, { moderationState: "pending", availability: "ok", canonicalUrl: gate.canonical, sourceUserId: null, indexedAt: item.createdAt, lastCheckedAt: null });
        return { url: String(rawUrl), outcome: "indexed", videoId: id, detail: null };
      });
      const source = body.sourceId ? sources.find((row) => row.id === Number(body.sourceId) && row.enabled) : null;
      if (body.sourceId && !source) return fail(res, 400, "validation_error", "sourceId must name an enabled source", { sourceId: "Not valid" });
      if (source) {
        source.lastRunAt = new Date().toISOString();
        if (body.etag) source.etag = String(body.etag);
      }
      return json(res, 200, {
        processed: urls.length,
        indexed: outcomes.filter((o) => o.outcome === "indexed").map((o) => o.videoId),
        duplicates: outcomes.filter((o) => o.outcome === "duplicate").length,
        refused: outcomes.filter((o) => !["indexed", "duplicate"].includes(o.outcome)).length,
        outcomes,
        sourceId: source?.id ?? null,
        ranAt: new Date().toISOString(),
      });
    });
  }

  return fail(res, 404, "not_found", `No stub admin route for ${method} ${pathname}.`);
}

function rankConfigPayload() {
  const keys = Object.keys(rankConfig);
  return {
    items: keys.map((key) => ({ key, weight: rankConfig[key], updatedAt: new Date().toISOString() })),
    weights: { ...rankConfig },
    sum: Math.round(keys.reduce((acc, k) => acc + rankConfig[k], 0) * 1000) / 1000,
  };
}

server.listen(PORT, HOST, () => {
  console.log(`[videos-stub] http://${HOST}:${PORT}  (GET /api/videos/feed, /api/_stub/state)`);
});
