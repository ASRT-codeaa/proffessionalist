/* Verify /api/videos (app-new/routes/spa/videos.js + app-new/services/videoKit.js) end-to-end
   against a node:sqlite stand-in D1, running the REAL authenticate + requireStaff + the port's
   pg→SQLite translation.  This is the harness the /api/videos contract in docs/videos-api-contract.md
   is pinned by.  Every scenario resets the database, so the ranking windows are deterministic.

   node cf-api/tools/test-videos.mjs */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = "test-secret";

const ROOT = path.join(import.meta.dirname, "..");
const db = require("../src/db.js");
const express = require("../src/shims/express.js");
const jwt = require("../src/shims/jwt.js");
const { hashToken } = require("../port/middleware/authenticate.js");
const videos = require("../port/services/videoKit.js");

/* the videos DDL comes from the generated manifest, so this also proves Step 1's merge round-trips */
const manifest = require("../port/compat/migrations-manifest.js");
const videosSql = manifest.find(m => m.name === "012_videos.sql").sql;
const mutesSql = manifest.find(m => m.name === "013_mutes.sql").sql;

/* ------------------------------------------------------------------ *
 * the D1 stand-in (same measured shapes as test-db.mjs)
 * ------------------------------------------------------------------ */
function makeBinding() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const load = text => {
    for (const stmt of text.split(";\n")
      .map(s => s.replace(/^\s*(?:--[^\n]*\n)+/, "").replace(/^--.*$/gm, "").trim())
      .filter(Boolean)) sqlite.exec(stmt);
  };
  load(fs.readFileSync(path.join(ROOT, "compat", "schema.sql"), "utf8"));
  load(videosSql);
  load(mutesSql);

  function statement(sql) {
    let params = [];
    const self = {
      bind(...vals) { params = vals; return self; },
      async all() { return { ...exec(sql, params), success: true }; },
      async first() { const r = await self.all(); return r.results[0] || null; },
      async run() { return { ...exec(sql, params), success: true }; },
    };
    return self;
  }
  function exec(sql, params) {
    const stmt = sqlite.prepare(sql);
    const bound = params.map(p => (p === undefined ? null : p));
    if (/^\s*(SELECT|WITH|VALUES|PRAGMA|EXPLAIN)\b/i.test(sql)) {
      return { results: stmt.all(...bound), meta: { changes: 0, last_row_id: 0 } };
    }
    if (/ \bRETURNING\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      const results = stmt.all(...bound);
      return { results, meta: { changes: results.length, last_row_id: 0 } };
    }
    const info = stmt.run(...bound);
    return { results: [], meta: { changes: Number(info.changes) || 0, last_row_id: Number(info.lastInsertRowid) || 0 } };
  }
  const env = {
    DB: {
      prepare: statement,
      async batch(stmts) {
        sqlite.exec("BEGIN");
        try {
          const out = [];
          for (const s of stmts) out.push(await s.all());
          sqlite.exec("COMMIT");
          return out;
        } catch (err) { sqlite.exec("ROLLBACK"); throw err; }
      },
    },
  };
  return { env, close: () => sqlite.close() };
}

let CURRENT = null;
function resetDb() {
  if (CURRENT && CURRENT.close) CURRENT.close();
  CURRENT = makeBinding();
  db.init(CURRENT.env);
}

/* ------------------------------------------------------------------ *
 * the app under test: authenticate + a pass-through limiter + the real router
 * ------------------------------------------------------------------ */
const app = express();
app.use(express.json());
const { authenticate } = require("../port/middleware/authenticate.js");
const videoRouter = require("../port/routes/spa/videos.js");
/* the safety router rides a real /api mount the same way production chains it ahead of
   spa/platform (api.js), so GET /api/mutes and GET /api/blocks are exercised, not just assumed */
const safetyRouter = require("../port/routes/spa/safety.js");
const passthroughLimiter = (req, res, next) => next();
app.use("/api/videos", authenticate, passthroughLimiter, videoRouter);
app.use("/api", authenticate, passthroughLimiter, safetyRouter);
const ctx = { waitUntil: () => {} };

async function call(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const request = new Request(`http://localhost${url}`, { method, headers, body: payload });
  const response = await app.handle(request, CURRENT.env, ctx);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: response.status, json, text };
}

/* ------------------------------------------------------------------ *
 * seed helpers (all through the real adapter, so FK + translation run)
 * ------------------------------------------------------------------ */
const OLD = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

async function insertUser(username, { role = "user", status = "active" } = {}) {
  const r = await db.query(
    `INSERT INTO users (username,email,password_hash,name,role,status,account_type)
     VALUES ($1,$2,'h',$1,$3,$4,'individual') RETURNING id`,
    [username, `${username}@x.invalid`, role, status]
  );
  return Number(r.rows[0].id);
}
async function insertPost(userId, { content = "body", createdAt = OLD } = {}) {
  const r = await db.query(
    `INSERT INTO posts (user_id,content,created_at) VALUES ($1,$2,$3) RETURNING id`,
    [String(userId), content, createdAt]
  );
  return Number(r.rows[0].id);
}
async function insertVideo(postId, {
  canonicalUrl, topics = [], moderationState = "approved", availability = "ok",
  durationMs = null, sourceUserId = null, provider = "self", kind = "upload",
} = {}) {
  const r = await db.query(
    `INSERT INTO videos (post_id,kind,provider,canonical_url,topic_ids,duration_ms,moderation_state,availability,source_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [String(postId), kind, provider, canonicalUrl, JSON.stringify(topics), durationMs, moderationState, availability, sourceUserId === null ? null : String(sourceUserId)]
  );
  return Number(r.rows[0].id);
}
async function like(postId, userId) {
  await db.query(`INSERT INTO post_likes (post_id,user_id,reaction) VALUES ($1,$2,'like')`, [String(postId), String(userId)]);
}
async function follow(followerId, followingId) {
  await db.query(`INSERT INTO follows (follower_id,following_id) VALUES ($1,$2)`, [String(followerId), String(followingId)]);
}
async function addInterest(userId, slug, weight) {
  const t = await db.query(`SELECT id::int AS id FROM video_topics WHERE slug = $1`, [slug]);
  await db.query(`INSERT INTO video_interests (user_id,topic_id,weight) VALUES ($1,$2,$3)`,
    [String(userId), String(t.rows[0].id), weight]);
}
async function activity(videoId, userId, event, { valueMs = null, dedupe } = {}) {
  await db.query(
    `INSERT INTO video_activity (video_id,user_id,event,value_ms,dedupe_key) VALUES ($1,$2,$3,$4,$5)`,
    [String(videoId), String(userId), event, valueMs, dedupe]
  );
}
let SEQ = 0;
async function tokenFor(userId) {
  SEQ += 1;
  const sid = `sess-${userId}-${SEQ}`;
  const tok = jwt.sign({ sub: userId, sessionId: sid }, process.env.JWT_SECRET, { expiresIn: "2h" });
  await db.query(
    `INSERT INTO auth_sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)`,
    [sid, String(userId), hashToken(tok), FUTURE]
  );
  return tok;
}

/* ------------------------------------------------------------------ *
 * the tiny assertion runner
 * ------------------------------------------------------------------ */
let PASS = 0;
const FAILS = [];
function check(name, ok, detail) {
  if (ok) { PASS++; console.log(`  ok    ${name}`); }
  else { FAILS.push(name); console.log(`  FAIL  ${name}${detail ? `\n          ${String(detail).slice(0, 400)}` : ""}`); }
}

/* ================================================================== *
 *  1. ranking: a video_rank_config weight change reorders the feed
 * ================================================================== */
console.log("== feed ranking is driven by video_rank_config ==");
{
  resetDb();
  const viewer = await insertUser("viewer");
  const alice = await insertUser("alice");
  const bob = await insertUser("bob");
  await addInterest(viewer, "design", 1);

  const pDesign = await insertPost(alice, { content: "design tips" });
  await insertVideo(pDesign, { canonicalUrl: "vid-design", topics: ["design"] });
  const pEngage = await insertPost(bob, { content: "popular thing" });
  const vEngage = await insertVideo(pEngage, { canonicalUrl: "vid-engage", topics: [] });
  for (let i = 0; i < 20; i++) {
    const liker = await insertUser(`liker${i}`);
    await like(pEngage, liker);
  }

  const staff = await insertUser("staffer", { role: "staff" });
  const vTok = await tokenFor(viewer);
  const sTok = await tokenFor(staff);

  const before = await call("GET", "/api/videos/feed", { token: vTok });
  check("GET /feed is 200 and returns both clips", before.status === 200 && before.json.items.length === 2, `${before.status} ${before.text.slice(0, 200)}`);
  const orderBefore = before.json.items.map(i => i.id);
  const designId = before.json.items.find(i => i.id === before.json.items[0].id) ? orderBefore[0] : null;
  check("…ids come back as JSON numbers (=== works)", before.json.items.every(i => typeof i.id === "number"), JSON.stringify(orderBefore));
  const firstIsDesign = orderBefore[0] === before.json.items.find(i => i.topics.includes("design")).id;
  check("under default weights the interest match outranks raw popularity", firstIsDesign, `order=${JSON.stringify(orderBefore)}`);

  // flip the weights: engagement heavy, interest small (sum must be 1.0)
  const put = await call("PUT", "/api/videos/admin/rank-config", {
    token: sTok,
    body: { weights: {
      interest_relevance: 0.05, watch_completion: 0.10, engagement: 0.55,
      followed_creators: 0.10, quality_freshness: 0.10, diversity_discovery: 0.10,
    } },
  });
  check("PUT /admin/rank-config accepts a six-key vector that sums to 1.0", put.status === 200 && Math.abs(put.json.sum - 1) < 0.001, `${put.status} ${put.text.slice(0, 200)}`);

  const after = await call("GET", "/api/videos/feed", { token: vTok });
  const orderAfter = after.json.items.map(i => i.id);
  check("changing the weights reorders the feed (popularity now wins)", orderAfter[0] === orderBefore.find(id => id !== orderBefore[0]), `before=${JSON.stringify(orderBefore)} after=${JSON.stringify(orderAfter)}`);
  check("…and it is the same two videos, not a different result set", JSON.stringify([...orderAfter].sort()) === JSON.stringify([...orderBefore].sort()));
  void designId; void vEngage;
}

/* ================================================================== *
 *  2. the six weighted features each move the score (unit over the real model)
 * ================================================================== */
console.log("\n== each ranking feature changes the score ==");
{
  resetDb();
  const W = videos.DEFAULT_WEIGHTS;
  const mk = over => Object.assign({
    id: 1, authorId: 1, topics: [], createdAt: new Date().toISOString(), durationMs: null,
    likeCount: 0, commentCount: 0, saveCount: 0, shareCount: 0,
    stats: { views: 0, watchCount: 0, watchMs: 0, impressions: 0 },
    row: { viewer_follows: false },
  }, over);
  const scoreOf = (candidate, interests) => {
    const taken = videos.rankCandidates([candidate], { weights: W, interests, limit: 1 });
    return taken[0] ? taken[0].score : 0;
  };

  const withInterest = scoreOf(mk({ topics: ["design"] }), new Map([["design", 1]]));
  const noInterest = scoreOf(mk({ topics: ["design"] }), new Map());
  check("interest_relevance raises the score", withInterest > noInterest, `${noInterest} -> ${withInterest}`);

  const followed = scoreOf(mk({ row: { viewer_follows: true } }), new Map());
  const notFollowed = scoreOf(mk({ row: { viewer_follows: false } }), new Map());
  check("followed_creators raises the score", followed > notFollowed, `${notFollowed} -> ${followed}`);

  const watched = scoreOf(mk({ durationMs: 10000, stats: { watchCount: 1, watchMs: 10000, impressions: 0 } }), new Map());
  const unwatched = scoreOf(mk({ durationMs: 10000, stats: { watchCount: 1, watchMs: 0, impressions: 0 } }), new Map());
  check("watch_completion raises the score", watched > unwatched, `${unwatched} -> ${watched}`);

  const engaged = scoreOf(mk({ likeCount: 20, commentCount: 5 }), new Map());
  const quiet = scoreOf(mk({ likeCount: 0, commentCount: 0 }), new Map());
  check("engagement raises the score", engaged > quiet, `${quiet} -> ${engaged}`);

  /* Engagement is the saturating feature interactions/(interactions+ENGAGEMENT_K), so what must be
     bounded is the FEATURE (<=1) and the score's *dependence* on it (<=W.engagement).  Comparing the
     whole weighted sum to W.engagement — which this line did until 2026-10-20 — can never hold: the
     same candidate also carries quality_freshness, which is 1.0 for a video created this second. */
  const featHuge = videos.featuresOf(mk({ likeCount: 100000 }), new Map()).engagement;
  const featMore = videos.featuresOf(mk({ likeCount: 1000000 }), new Map()).engagement;
  check("engagement saturates below 1 (bounded by ENGAGEMENT_K)",
    featHuge <= 1 && featMore <= 1 && featMore - featHuge < 0.001,
    `feature 1e5=${featHuge} 1e6=${featMore}`);
  const huge = scoreOf(mk({ likeCount: 100000 }), new Map());
  check("…and a hundredfold surge past saturation buys no more than the engagement weight",
    huge - quiet < W.engagement + 1e-9, `delta=${(huge - quiet).toFixed(6)} of W.engagement=${W.engagement}`);
}

/* ================================================================== *
 *  3. the diversity guard blocks popularity-only ranking
 * ================================================================== */
console.log("\n== diversity: the author cap orders the page but never hides approved clips ==");
{
  resetDb();
  const popularityOnly = {
    interest_relevance: 0, watch_completion: 0, engagement: 1,
    followed_creators: 0, quality_freshness: 0, diversity_discovery: 0,
  };
  const mk = (id, authorId, likes) => ({
    id, authorId, topics: [], createdAt: new Date().toISOString(), durationMs: null,
    likeCount: likes, commentCount: 0, saveCount: 0, shareCount: 0,
    stats: { impressions: 0, watchCount: 0 }, row: { viewer_follows: false },
  });
  const taken = videos.rankCandidates(
    [mk(1, 42, 100), mk(2, 42, 90), mk(4, 7, 70), mk(3, 42, 80)],
    { weights: popularityOnly, interests: new Map(), limit: 4 },
  );
  check("one creator takes the first two slots, the second creator is interleaved, and the creator's third clip is still returned",
    taken.length === 4 && taken.map(c => c.authorId).join(",") === "42,42,7,42",
    taken.map(c => `${c.authorId}#${c.id}`).join(" "));

  // over the real feed route, three clips by one author plus one by another yield all four items
  const viewer = await insertUser("d_viewer");
  const author = await insertUser("d_author");
  for (let i = 0; i < 3; i++) {
    const p = await insertPost(author, { content: `clip ${i}` });
    await insertVideo(p, { canonicalUrl: `dup-${i}`, topics: [] });
  }
  const other = await insertUser("d_other");
  const pOther = await insertPost(other, { content: "solo clip" });
  await insertVideo(pOther, { canonicalUrl: "solo", topics: [] });
  const vTok = await tokenFor(viewer);
  const feed = await call("GET", "/api/videos/feed?limit=5", { token: vTok });
  check("GET /feed answers every approved clip — same-author rows are no longer dropped",
    feed.status === 200 && feed.json.items.length === 4, `${feed.status} items=${feed.json.items.length}`);
}

/* ================================================================== *
 *  4. cursor pagination is stable, no repeats, no skips
 * ================================================================== */
console.log("\n== cursor pagination ==");
{
  resetDb();
  const viewer = await insertUser("p_viewer");
  const vTok = await tokenFor(viewer);
  const expected = [];
  for (let i = 0; i < 5; i++) {
    const author = await insertUser(`p_author${i}`);
    const p = await insertPost(author, { content: `clip ${i}` });
    const vid = await insertVideo(p, { canonicalUrl: `p-clip-${i}`, topics: [] });
    expected.push(vid);
  }
  const full = await call("GET", "/api/videos/feed?limit=10", { token: vTok });
  const fullOrder = full.json.items.map(i => i.id);

  const seen = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const url = `/api/videos/feed?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await call("GET", url, { token: vTok });
    if (page.status !== 200) { check("paged feed stays 200", false, page.text.slice(0, 200)); break; }
    seen.push(...page.json.items.map(i => i.id));
    cursor = page.json.nextCursor;
    pages += 1;
    if (!cursor) break;
    if (pages > 10) { check("pagination terminates", false, "cursor never cleared"); break; }
  }
  check("paging two-at-a-time reproduces the single-request order exactly",
    JSON.stringify(seen) === JSON.stringify(fullOrder), `paged=${JSON.stringify(seen)} full=${JSON.stringify(fullOrder)}`);
  check("…with no id repeated across pages", new Set(seen).size === seen.length, JSON.stringify(seen));
  check("…and no seeded video skipped", JSON.stringify([...seen].sort()) === JSON.stringify([...expected].sort()), `seen=${JSON.stringify(seen)}`);
}

/* ================================================================== *
 *  5. POST /:id/activity is idempotent per dedupe_key
 * ================================================================== */
console.log("\n== activity dedupe is idempotent per key ==");
{
  resetDb();
  const viewer = await insertUser("a_viewer");
  const other = await insertUser("a_other");
  const author = await insertUser("a_author");
  const p = await insertPost(author, { content: "watch me" });
  const vid = await insertVideo(p, { canonicalUrl: "a-vid", durationMs: 20000, topics: [] });
  const vTok = await tokenFor(viewer);
  const oTok = await tokenFor(other);

  const first = await call("POST", `/api/videos/${vid}/activity`, { token: vTok, body: { event: "watch", dedupe_key: "watch-1", value_ms: 5000 } });
  check("a new dedupe_key records the activity", first.status === 200 && first.json.recorded === true && first.json.deduped === false, `${first.status} ${first.text.slice(0, 160)}`);

  const replay = await call("POST", `/api/videos/${vid}/activity`, { token: vTok, body: { event: "watch", dedupe_key: "watch-1", value_ms: 5000 } });
  check("the same key from the same account is a no-op, not a second row", replay.status === 200 && replay.json.recorded === false && replay.json.deduped === true, `${replay.status} ${replay.text.slice(0, 160)}`);

  const thief = await call("POST", `/api/videos/${vid}/activity`, { token: oTok, body: { event: "watch", dedupe_key: "watch-1", value_ms: 1 } });
  check("a key that belongs to another account is refused with 403", thief.status === 403 && thief.json.error.code === "forbidden", `${thief.status} ${thief.text.slice(0, 160)}`);

  const rows = (await db.query(`SELECT COUNT(*)::int AS n FROM video_activity WHERE dedupe_key = $1`, ["watch-1"])).rows[0].n;
  check("…and exactly one activity row exists for that key", Number(rows) === 1, `n=${rows}`);

  const badEvent = await call("POST", `/api/videos/${vid}/activity`, { token: vTok, body: { event: "telepathy", dedupe_key: "x1" } });
  check("an unrecognised event is a 400 validation error", badEvent.status === 400 && badEvent.json.error.fields.event, `${badEvent.status} ${badEvent.text.slice(0, 160)}`);
}

/* ================================================================== *
 *  6. authentication and permission envelopes
 * ================================================================== */
console.log("\n== auth / permission envelopes ==");
{
  resetDb();
  const viewer = await insertUser("au_viewer");
  const author = await insertUser("au_author");
  const staff = await insertUser("au_staff", { role: "staff" });
  const p = await insertPost(author, { content: "private pending" });
  const pendingVid = await insertVideo(p, { canonicalUrl: "au-pending", moderationState: "pending" });
  const vTok = await tokenFor(viewer);
  const sTok = await tokenFor(staff);

  const anon = await call("GET", "/api/videos/feed");
  check("unauthenticated GET /feed is 401", anon.status === 401, `${anon.status} ${anon.text.slice(0, 160)}`);
  check("…and carries the {error:{code,message,fields}} envelope",
    anon.json && Object.keys(anon.json.error).join(",") === "code,message,fields", JSON.stringify(anon.json));

  const anonAct = await call("POST", `/api/videos/${pendingVid}/activity`, { body: { event: "view_start", dedupe_key: "z" } });
  check("unauthenticated POST /:id/activity is 401 too", anonAct.status === 401, `${anonAct.status}`);

  // a regular user cannot reach any /admin/ route
  const adminIndex = await call("GET", "/api/videos/admin/index", { token: vTok });
  check("non-staff GET /admin/index is 403", adminIndex.status === 403 && adminIndex.json.error.code === "forbidden", `${adminIndex.status} ${adminIndex.text.slice(0, 160)}`);
  const adminApprove = await call("POST", `/api/videos/admin/${pendingVid}/approve`, { token: vTok });
  check("non-staff POST /admin/:id/approve is 403 (a non-owner cannot approve)", adminApprove.status === 403, `${adminApprove.status} ${adminApprove.text.slice(0, 160)}`);
  const adminPut = await call("PUT", "/api/videos/admin/rank-config", { token: vTok, body: { weights: {} } });
  check("non-staff PUT /admin/rank-config is 403", adminPut.status === 403, `${adminPut.status}`);

  // a stranger cannot read another user's pending (owner-or-public only)
  const strangerRead = await call("GET", `/api/videos/${pendingVid}`, { token: vTok });
  check("a non-owner cannot see a pending video (404, not a confirmable 403)", strangerRead.status === 404, `${strangerRead.status} ${strangerRead.text.slice(0, 160)}`);
  const staffRead = await call("GET", `/api/videos/${pendingVid}`, { token: sTok });
  check("staff can read the pending video", staffRead.status === 200 && staffRead.json.moderationState === "pending", `${staffRead.status} ${staffRead.text.slice(0, 200)}`);

  // approve as staff works, then the now-public video is readable by the stranger
  const approve = await call("POST", `/api/videos/admin/${pendingVid}/approve`, { token: sTok });
  check("staff POST /admin/:id/approve succeeds", approve.status === 200 && approve.json.moderationState === "approved", `${approve.status} ${approve.text.slice(0, 160)}`);
  const afterApprove = await call("GET", `/api/videos/${pendingVid}`, { token: vTok });
  check("…and the video is visible to a stranger once approved", afterApprove.status === 200 && typeof afterApprove.json.id === "number", `${afterApprove.status}`);
}

/* ================================================================== *
 *  7. the add path: provider allowlist + canonical_url duplicate
 * ================================================================== */
console.log("\n== POST / gate: provider allowlist and duplicate canonical_url ==");
{
  resetDb();
  const creator = await insertUser("add_creator");
  const cTok = await tokenFor(creator);

  const bad = await call("POST", "/api/videos", { token: cTok, body: { url: "https://notlisted.example/watch?v=abcdef" } });
  check("a URL whose provider is off the allowlist is refused 403", bad.status === 403 && bad.json.error.code === "forbidden", `${bad.status} ${bad.text.slice(0, 160)}`);

  const malformed = await call("POST", "/api/videos", { token: cTok, body: { url: "not-a-url" } });
  check("an unparseable URL is a 400", malformed.status === 400, `${malformed.status} ${malformed.text.slice(0, 160)}`);

  const firstAdd = await call("POST", "/api/videos", { token: cTok, body: { url: "https://youtu.be/abc123", caption: "a linked clip" } });
  check("a youtube link on the allowlist is indexed 201", firstAdd.status === 201 && firstAdd.json.provider === "youtube", `${firstAdd.status} ${firstAdd.text.slice(0, 200)}`);
  check("…and it comes back with a numeric JSON id", typeof firstAdd.json.id === "number", JSON.stringify(firstAdd.json.id));

  const dupe = await call("POST", "/api/videos", { token: cTok, body: { url: "https://youtu.be/abc123" } });
  check("a duplicate canonical_url is rejected 409", dupe.status === 409 && dupe.json.error.code === "duplicate", `${dupe.status} ${dupe.text.slice(0, 160)}`);

  const roleSpoof = await call("POST", "/api/videos", { token: cTok, body: { url: "https://youtu.be/zzz999", userId: 999 } });
  check("declaring a userId in the body is refused (authorship is the session)", roleSpoof.status === 400 && roleSpoof.json.error.fields.userId, `${roleSpoof.status} ${roleSpoof.text.slice(0, 160)}`);
}

/* ================================================================== *
 *  7b. embeds ship publicly; mutes and blocks empty the feed
 * ================================================================== */
console.log("\n== public link items carry embedUrl; safety exclusions bite ==");
{
  resetDb();
  const creator = await insertUser("safety_creator");
  const cTok = await tokenFor(creator);
  const muter = await insertUser("safety_muter");
  const mTok = await tokenFor(muter);

  const add = await call("POST", "/api/videos", { token: cTok, body: { url: "https://youtu.be/safety1" } });
  check("a youtube link indexes 201", add.status === 201, `${add.status} ${add.text.slice(0, 160)}`);
  await db.query(`UPDATE videos SET moderation_state = 'approved' WHERE id = $1`, [String(add.json.id)]);

  const seen = await call("GET", "/api/videos/feed", { token: mTok });
  const item = seen.json.items.find(i => i.id === add.json.id);
  check("the public feed item carries embedUrl + canonicalUrl for a link row",
    !!item && item.embedUrl === "https://www.youtube.com/embed/safety1" && item.canonicalUrl.includes("safety1"),
    JSON.stringify(item && { embedUrl: item.embedUrl, canonicalUrl: item.canonicalUrl }));

  const emptyList = await call("GET", "/api/mutes", { token: mTok });
  check("GET /api/mutes starts empty", emptyList.status === 200 && emptyList.json.items.length === 0, `${emptyList.status} ${emptyList.text.slice(0, 160)}`);

  const selfMute = await call("POST", `/api/mutes/${muter}`, { token: mTok });
  check("self-mute is a 400", selfMute.status === 400, `${selfMute.status} ${selfMute.text.slice(0, 120)}`);

  const mute = await call("POST", `/api/mutes/${creator}`, { token: mTok });
  check("POST /api/mutes/:id mutes 201", mute.status === 201 && mute.json.muted === true, `${mute.status} ${mute.text.slice(0, 160)}`);
  const dupe = await call("POST", `/api/mutes/${creator}`, { token: mTok });
  check("…and a repeat mute is idempotent 201", dupe.status === 201 && dupe.json.muted === true, `${dupe.status} ${dupe.text.slice(0, 120)}`);

  const listed = await call("GET", "/api/mutes", { token: mTok });
  check("GET /api/mutes lists the creator", listed.json.items.length === 1 && listed.json.items[0].id === creator, JSON.stringify(listed.json));

  const mutedFeed = await call("GET", "/api/videos/feed", { token: mTok });
  check("the muted creator vanishes from the videos feed",
    !mutedFeed.json.items.some(i => i.id === add.json.id), `items=${mutedFeed.json.items && mutedFeed.json.items.length}`);

  const unmute = await call("DELETE", `/api/mutes/${creator}`, { token: mTok });
  check("DELETE /api/mutes/:id unmutes", unmute.status === 200 && unmute.json.muted === false, `${unmute.status} ${unmute.text.slice(0, 120)}`);
  const backFeed = await call("GET", "/api/videos/feed", { token: mTok });
  check("…and the creator is immediately visible again",
    backFeed.json.items.some(i => i.id === add.json.id), `items=${backFeed.json.items && backFeed.json.items.length}`);

  /* the reverse direction: the CREATOR blocks the viewer, and disappears from the viewer's feed.
     Row written directly because platform.js's POST /api/blocks/:userId is the production write
     path and this harness deliberately mounts only videos+safety — the block READ is what we pin */
  await db.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)`, [String(creator), String(muter)]);
  const blockedFeed = await call("GET", "/api/videos/feed", { token: mTok });
  check("a creator who blocked the viewer is hidden both ways",
    !blockedFeed.json.items.some(i => i.id === add.json.id), `items=${blockedFeed.json.items && blockedFeed.json.items.length}`);
  const blocksList = await call("GET", "/api/blocks", { token: mTok });
  check("GET /api/blocks reads the one-way list (nobody blocked me)",
    blocksList.status === 200 && blocksList.json.items.length === 0, `${blocksList.status} ${blocksList.text.slice(0, 160)}`);
  const myBlocks = await call("GET", "/api/blocks", { token: cTok });
  check("…and shows my own block", myBlocks.json.items.length === 1 && myBlocks.json.items[0].id === muter, JSON.stringify(myBlocks.json));
}

/* ================================================================== *
 *  7c. ranked-page routes bind their WHERE parameter AFTER the viewer:
 *      $1 is the viewer id, so the admin queue's state, search's term and
 *      trending's window date must all be $2 or later.  Each check asserts
 *      the value took effect — a shifted parameter would return rows from
 *      the wrong state, nothing at all, or a stale clip.
 * ================================================================== */
console.log("\n== admin queue, search and trending bind route params at $2 (not the viewer) ==");
{
  resetDb();
  const qa = await insertUser("qa_author");
  const qs = await insertUser("qa_staff", { role: "staff" });
  const pPending = await insertPost(qa, { content: "endless scroll walkthrough" });
  const vPending = await insertVideo(pPending, { canonicalUrl: "qa-pending", moderationState: "pending" });
  const pPending2 = await insertPost(qa, { content: "second pending walkthrough" });
  const vPending2 = await insertVideo(pPending2, { canonicalUrl: "qa-pending-2", moderationState: "pending" });
  const pApproved = await insertPost(qa, { content: "quarterly hiring metrics", createdAt: new Date().toISOString() });
  const vApproved = await insertVideo(pApproved, { canonicalUrl: "qa-approved" });
  const pHiring2 = await insertPost(qa, { content: "more hiring metrics please", createdAt: new Date().toISOString() });
  const vHiring2 = await insertVideo(pHiring2, { canonicalUrl: "qa-hiring-2" });
  const pStale = await insertPost(qa, { content: "a stale quarter", createdAt: new Date(Date.now() - 30 * 86400000).toISOString() });
  const vStale = await insertVideo(pStale, { canonicalUrl: "qa-stale" });
  const sTok = await tokenFor(qs);

  const pend = await call("GET", "/api/videos/admin/index?state=pending", { token: sTok });
  const pendIds = (pend.json?.items || []).map(i => i.id);
  check("staff GET /admin/index?state=pending lists the pending row and not the approved one",
    pend.status === 200 && pendIds.includes(vPending) && !pendIds.includes(vApproved), `${pend.status} ${JSON.stringify(pendIds)} ${pend.text.slice(0, 120)}`);
  check("…and lists BOTH pending rows of one author (no feed diversity cap in the queue)",
    pendIds.includes(vPending2), JSON.stringify(pendIds));
  const appr = await call("GET", "/api/videos/admin/index?state=approved", { token: sTok });
  const apprIds = (appr.json?.items || []).map(i => i.id);
  check("…and state=approved lists that state instead",
    appr.status === 200 && apprIds.includes(vApproved) && !apprIds.includes(vPending), JSON.stringify(apprIds));
  check("admin queue answers per-state counts",
    Array.isArray(pend.json?.counts) && pend.json.counts.some(c => c.state === "pending" && c.n >= 1), JSON.stringify(pend.json?.counts));

  const search = await call("GET", "/api/videos/search?q=hiring%20metrics", { token: sTok });
  const sIds = (search.json?.items || []).map(i => i.id);
  check("search matches caption text (the viewer id does not leak into the LIKE)",
    search.status === 200 && sIds.includes(vApproved), `${search.status} ${JSON.stringify(sIds)}`);
  check("…and returns BOTH same-author matches (no diversity cap in a lookup)",
    sIds.includes(vHiring2), JSON.stringify(sIds));
  const noHit = await call("GET", "/api/videos/search?q=zzwodonothings", { token: sTok });
  check("…and an unmatched term is empty", noHit.status === 200 && (noHit.json?.items || []).length === 0, `${noHit.status}`);

  const trend = await call("GET", "/api/videos/feed?tab=trending", { token: sTok });
  const tIds = (trend.json?.items || []).map(i => i.id);
  check("trending applies its 7-day window (a 30-day-old clip is out)",
    trend.status === 200 && tIds.includes(vApproved) && !tIds.includes(vStale), `${trend.status} ${JSON.stringify(tIds)}`);

  const page = await call("GET", "/api/videos/feed?limit=30", { token: sTok });
  const pIds = (page.json?.items || []).map(i => i.id);
  check("for-you lists every approved clip of a lone author (the cap reorders, it does not hide)",
    pIds.includes(vStale) && pIds.includes(vApproved) && pIds.includes(vHiring2), JSON.stringify(pIds));
}

/* ================================================================== *
 *  8. the six weights load, and rank-config validates the sum
 * ================================================================== */
console.log("\n== rank-config load and validation ==");
{
  resetDb();
  const staff = await insertUser("rc_staff", { role: "staff" });
  const sTok = await tokenFor(staff);

  const get = await call("GET", "/api/videos/admin/rank-config", { token: sTok });
  check("GET /admin/rank-config returns the six seeded weights",
    get.status === 200 && get.json.items.length === 6 && videos.RANK_KEYS.every(k => k in get.json.weights),
    `${get.status} items=${get.json && get.json.items && get.json.items.length}`);
  check("…and they sum to 1.0", get.status === 200 && Math.abs(get.json.sum - 1) < 0.001, `sum=${get.json && get.json.sum}`);

  const wrongSum = await call("PUT", "/api/videos/admin/rank-config", {
    token: sTok,
    body: { weights: { interest_relevance: 0.4, watch_completion: 0.4, engagement: 0.4, followed_creators: 0.1, quality_freshness: 0.1, diversity_discovery: 0.1 } },
  });
  check("PUT with weights that do not sum to 1.0 is a 400 with fields.weights",
    wrongSum.status === 400 && wrongSum.json.error.fields.weights, `${wrongSum.status} ${wrongSum.text.slice(0, 200)}`);

  const missing = await call("PUT", "/api/videos/admin/rank-config", {
    token: sTok, body: { weights: { interest_relevance: 1 } },
  });
  check("PUT missing the other five keys is refused", missing.status === 400, `${missing.status} ${missing.text.slice(0, 200)}`);

  const ok = await call("PUT", "/api/videos/admin/rank-config", {
    token: sTok,
    body: { weights: { interest_relevance: 0.5, watch_completion: 0.1, engagement: 0.1, followed_creators: 0.1, quality_freshness: 0.1, diversity_discovery: 0.1 } },
  });
  check("PUT with a valid vector lands and is readable back", ok.status === 200 && ok.json.weights.interest_relevance === 0.5 && Math.abs(ok.json.sum - 1) < 0.001, `${ok.status} ${ok.text.slice(0, 200)}`);
  const reload = await db.query(`SELECT weight::float AS w FROM video_rank_config WHERE key = 'interest_relevance'`);
  check("…and the write actually persisted to video_rank_config", Math.abs(Number(reload.rows[0].w) - 0.5) < 1e-9, `w=${reload.rows[0].w}`);
}

/* ================================================================== *
 *  9. interests write path and topics taxonomy
 * ================================================================== */
console.log("\n== interests and topics ==");
{
  resetDb();
  const viewer = await insertUser("int_viewer");
  const vTok = await tokenFor(viewer);

  const topics = await call("GET", "/api/videos/topics", { token: vTok });
  check("GET /topics returns the seeded taxonomy", topics.status === 200 && topics.json.items.length >= 6 && topics.json.items.every(t => typeof t.id === "number"), `${topics.status} n=${topics.json && topics.json.items && topics.json.items.length}`);

  const set = await call("PUT", "/api/videos/interests", { token: vTok, body: { topics: [{ slug: "design", weight: 1 }, { slug: "career", weight: 0.5 }] } });
  check("PUT /interests stores the viewer's weighted topics", set.status === 200 && set.json.topics.length === 2, `${set.status} ${set.text.slice(0, 200)}`);

  const unknown = await call("PUT", "/api/videos/interests", { token: vTok, body: { topics: [{ slug: "notatopic", weight: 1 }] } });
  check("PUT /interests with an unknown slug is a 400", unknown.status === 400 && unknown.json.error.fields.topics, `${unknown.status} ${unknown.text.slice(0, 200)}`);

  const spoof = await call("PUT", "/api/videos/interests", { token: vTok, body: { userId: 999, topics: [] } });
  check("PUT /interests refuses a declared userId", spoof.status === 400, `${spoof.status}`);
}

/* ------------------------------------------------------------------ */
console.log(`\nVERDICT: ${PASS} passed, ${FAILS.length} failed`);
if (FAILS.length) { for (const f of FAILS) console.log(`  - ${f}`); process.exit(1); }
console.log("/api/videos ranks on video_rank_config, dedupes by key, gates by session role, and paginates without repeats.");
