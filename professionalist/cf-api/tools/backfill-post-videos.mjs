/* Backfill: enrol already-posted videos into the videos index.
   The live D1 has posts rows whose media is an mp4 (or whose link_url passes the provider gate)
   that predate the POST /posts intake hook, so the /videos feed cannot see them.  This tool runs
   the SAME classifier the hook uses (port/services/videoKit.js's fromPostRow, so the gate, the
   VIDEO_FILE pattern and the canonical urls can never drift apart) over every plain public post,
   and inserts the missing videos rows as moderation_state='pending', availability='ok': nothing
   reaches the videos feed until staff approve it in the video console, backfill rows included.

   node cf-api/tools/backfill-post-videos.mjs            # dry run: counts + samples, writes nothing
   node cf-api/tools/backfill-post-videos.mjs --apply    # insert the missing rows

   Idempotent: a post is skipped when its canonical_url is already indexed (UNIQUE) or the post
   already has a videos row.  Re-running after --apply changes nothing.

   Security: never print a token, the account id, or the D1 uuid; error strings pass through
   hideSecrets.  Read-only by default, and --apply only INSERTs — nothing is ever UPDATEd or deleted. */
import path from "node:path";
import { createRequire } from "node:module";
import { readTrim, hideSecrets } from "./paths.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.join(HERE, "..");
const hide = hideSecrets;

const TOKEN = readTrim("token");
const ACCT = readTrim("tmp", "acct.txt");
const DB_ID = readTrim("tmp", "d1-id.txt");

const require = createRequire(import.meta.url);
const videos = require(path.join(ROOT, "port", "services", "videoKit.js"));

async function q(sql, params = [], attempt = 1) {
  let j;
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/d1/database/${DB_ID}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(params.length ? { sql, params } : { sql }),
    });
    j = await r.json();
    if (!j.success) throw new Error(`${r.status} ${hide(JSON.stringify(j.errors || j)).slice(0, 300)}`);
  } catch (err) {
    if (attempt < 4 && /timeout|network|fetch failed|5[0-9][0-9]/i.test(String(err.message))) {
      await new Promise(s => setTimeout(s, attempt * 700));
      return q(sql, params, attempt + 1);
    }
    throw err;
  }
  return j.result[0];
}

const POSTS = await q(`SELECT id, media, media_url, link_url, created_at FROM posts
  WHERE deleted_at IS NULL AND post_type = 'post' AND visibility = 'public' AND scheduled_at IS NULL
  ORDER BY id`);
const EXISTING = await q(`SELECT post_id, canonical_url FROM videos`);
const takenUrls = new Set(EXISTING.results.map(r => r.canonical_url));
const takenPosts = new Set(EXISTING.results.map(r => Number(r.post_id)));

const enrolments = [];
let clashes = 0;
for (const post of POSTS.results) {
  const asVideo = videos.fromPostRow(post);
  if (!asVideo) continue;
  if (takenUrls.has(asVideo.canonicalUrl) || takenPosts.has(Number(post.id))) { clashes++; continue; }
  takenUrls.add(asVideo.canonicalUrl); takenPosts.add(Number(post.id));
  enrolments.push({ postId: post.id, ...asVideo });
}

const byKind = {};
for (const e of enrolments) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
const kindSummary = Object.entries(byKind).map(([k, n]) => `${k}:${n}`).join(", ") || "none";
console.log(`${POSTS.results.length} candidate post(s); ${enrolments.length} to enrol (${kindSummary}), ${clashes} already indexed`);
for (const e of enrolments) {
  console.log(`  post ${e.postId}: ${e.kind}/${e.provider} -> ${e.canonicalUrl.slice(0, 90)}`);
}

if (!process.argv.includes("--apply")) {
  console.log("dry run; nothing written.  Re-run with --apply to insert.");
  process.exit(0);
}

let inserted = 0;
const INSERT = `INSERT INTO videos (post_id, kind, provider, canonical_url, media_key, embed_url,
                                    thumbnail_key, topic_ids, moderation_state, availability)
  VALUES (?1,?2,?3,?4,?5,?6,?7,'[]','pending','ok')`;
for (const e of enrolments) {
  const params = [e.postId, e.kind, e.provider, e.canonicalUrl, e.mediaKey, e.embedUrl, e.thumbnailKey];
  try {
    await q(`${INSERT} ON CONFLICT (canonical_url) DO NOTHING`, params);
    inserted++;
  } catch (err) {
    if (/ON CONFLICT/i.test(String(err.message))) {
      /* this D1 build refuses the conflict clause — OR IGNORE is the same idempotent statement */
      try {
        await q(INSERT.replace("INSERT INTO", "INSERT OR IGNORE INTO"), params);
        inserted++;
      } catch (err2) {
        console.error(`  FAILED post ${e.postId}: ${hide(String(err2.message)).slice(0, 200)}`);
      }
      continue;
    }
    console.error(`  FAILED post ${e.postId}: ${hide(String(err.message)).slice(0, 200)}`);
  }
}
console.log(`inserted ${inserted}/${enrolments.length} videos row(s)`);

/* what the feed will show once staff approve the queue */
const states = await q(`SELECT moderation_state, COUNT(*) AS n FROM videos GROUP BY moderation_state`);
const summary = states.results.map(r => `${r.moderation_state}:${r.n}`).join(", ");
console.log(`videos index by state -> ${summary}`);
