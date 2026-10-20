# Videos API contract (vertical slice)

Authoritative for `app-new/routes/spa/videos.js`. If code and this file disagree, the code is wrong
or this file was not updated — update whichever is wrong in the same change.

Base path: **`/api/videos`**, mounted behind `authenticate, userLimiter` exactly like
`server.js:158` mounts the SPA surface. That means:

* **every** endpoint requires a `Authorization: Bearer <jwt>` header — there is no anonymous read.
  A missing/garbage/expired token answers the `authenticate.js` envelope (401 below).
* Roles come from the database row the session lookup loads (`req.user.role`), never from a body,
  query or client-declared field. A route that needs staff re-checks `req.user.role` itself.
* `userLimiter` (400 req/min per user by default) can answer 429 on any endpoint.

## Conventions

| Rule | Detail |
| --- | --- |
| ids | **JSON numbers**, never `"4"`. Every id in this contract is produced by `num()`, so `id === 7` works on the client. |
| timestamps | ISO-8601 UTC string with milliseconds, or `null`. |
| media urls | Root-relative path `/uploads/<directory>/<file>`; the client prepends `API_BASE_URL`, like every other media field in the app. Absolute `https://…` appears only for external (`link` / `indexed`) videos' `playUrl`/`canonicalUrl`. |
| errors | `{"error":{"code":"…","message":"…","fields":{}}}` with exactly those three keys, `fields` always an object (possibly empty). |
| pagination | opaque `cursor`, never an offset the client builds. `nextCursor: null` means the end. |
| limits | `limit` 1–30, default 10. Out of range is clamped, not rejected. |

Error codes in use: `validation_error` (400), `unauthorized` (401), `session_expired` (401),
`forbidden` (403), `not_found` (404), `duplicate` (409), `rate_limited` (429), `api_error` (500),
`unavailable` (503, only `/health`-style routes — this router does not emit it).

## `VIDEO_ITEM`

```json
{
  "id": 41,
  "postId": 1204,
  "kind": "upload",
  "provider": "self",
  "playUrl": "/uploads/posts/7-1a2b3c4d5e6f7a8b.mp4",
  "thumbnailUrl": "/uploads/posts/7-9f8e7d6c5b4a3f2e.jpg",
  "durationMs": 48200,
  "width": 1080,
  "height": 1920,
  "caption": "How I ran a hiring funnel in 2026",
  "hashtags": ["hiring", "recruiting"],
  "topics": ["hiring", "career"],
  "author": {
    "id": 7,
    "name": "Ada Lovelace",
    "headline": "Staff engineer, payments",
    "avatarUrl": "/uploads/avatars/7-3c2b1a0f9e8d7c6b.png",
    "viewerFollows": false
  },
  "stats": { "views": 12, "likes": 3, "comments": 1, "saves": 0, "shares": 0 },
  "viewer": { "liked": false, "saved": true },
  "createdAt": "2026-10-19T08:12:44.000Z",
  "ranking": {
    "score": 0.418321,
    "reasons": [
      { "key": "interest_relevance", "value": 1, "weight": 0.3 },
      { "key": "watch_completion", "value": 0.62, "weight": 0.2 },
      { "key": "engagement", "value": 0.375, "weight": 0.15 },
      { "key": "followed_creators", "value": 0, "weight": 0.15 },
      { "key": "quality_freshness", "value": 0.9, "weight": 0.1 },
      { "key": "diversity_discovery", "value": 0.5, "weight": 0.1 }
    ]
  }
}
```

Nullability — every other field is always present and non-null:

| Field | Nullable | Notes |
| --- | --- | --- |
| `durationMs`, `width`, `height` | `number \| null` | null when nobody measured the clip |
| `thumbnailUrl` | `string \| null` | uploads without a poster frame are null; the client falls back to `playUrl` |
| `author.headline`, `author.avatarUrl`, `author.name` | `""` when absent | never `null` |
| `ranking.score` | always `number` | rounded to 6 decimals |
| `ranking` | object | feeds and `GET /:id` both carry it; `POST /` returns `ranking.score: 0` |

`kind` ∈ `upload | link | indexed`; `provider` ∈ `self | youtube | vimeo | linkedin`.

`link` rows always carry `canonicalUrl` and `embedUrl` **for every viewer**, not only in admin
payloads: both strings are the public watch/embed URLs the provider publishes, so there is no
secret to leak, and the player needs `embedUrl` to launch the click-to-play iframe facade.
Upload rows keep the old rule — those URLs are only exposed to their owner or to staff.
A `linkedin` link has `embedUrl: null` (no embed gate for that provider), and the player then
offers the external "Watch on LinkedIn" link instead of an iframe.

---

## Feed

`GET /api/videos/feed?tab=for-you|following|trending&cursor=<opaque>&limit=10`

```json
{ "items": [ /* VIDEO_ITEM[] */ ], "nextCursor": "czouNDI4MzIxJmk6NDE", "tab": "for-you" }
```

* Unknown `tab` → `for-you`. Empty result is `{"items":[],"nextCursor":null,"tab":"for-you"}` with 200.
* `limit` is clamped to 1..30.
* Only rows with `moderation_state = 'approved'`, `availability = 'ok'`, `videos.deleted_at IS NULL`,
  `posts.deleted_at IS NULL` and an `active` author appear in any tab.
* The same `PUBLIC_CLAUSE` also hides creators the viewer **muted**, and every creator in a **block**
  relationship with the viewer (a block is mutual — neither side sees the other's clips). See
  *Safety: mutes and blocks*.
* `for-you` = weighted ranking (see *Ranking*). `following` = authored by a user the viewer follows
  (newest first). `trending` = recent engagement: `(likes+comments+saves+shares)` over items created
  in the last 7 days, ties broken by newest, then by id.
* A `cursor` that is not decodable answers
  `400 {"error":{"code":"validation_error","message":"cursor is invalid","fields":{"cursor":"Not valid"}}}`.
* Ranking is recomputed per request, so a `nextCursor` is stable for an unchanged dataset; a like or
  a new video between pages can reorder later pages (no snapshot guarantee — documented).

## Search

`GET /api/videos/search?q=<1..80 chars>&cursor=<opaque>&limit=10`

Matches caption text, hashtags, topic slugs and author name/username, ASCII-case-insensitive.
Search answers **every** match — the feed's per-author ceiling does not apply to a lookup.

* No match: `200 {"items":[],"nextCursor":null,"query":"womyn","total":0}`.
* Empty/absent `q`: `200 {"items":[],"nextCursor":null,"query":"","total":0}` — the client shows its
  "type to search" state; the server does **not** return the whole feed.
* `q` longer than 80 chars is truncated, `q` that is only whitespace counts as absent → empty state.
* Search is a ranking pass too (`ranking.reasons` present), scored against the query's own topic hits.

## Single video

`GET /api/videos/:id`

```json
{
  "…VIDEO_ITEM fields…": "…",
  "canonicalUrl": "/uploads/posts/7-1a2b3c4d5e6f7a8b.mp4",
  "embedUrl": null,
  "moderationState": "approved",
  "availability": "ok",
  "indexedAt": "2026-10-19T08:12:44.000Z",
  "comments": [
    { "id": 88, "postId": 1204, "author": { "id": 9, "…": "Person DTO" },
      "text": "Nice breakdown.", "likeCount": 0, "liked": false,
      "createdAt": "2026-10-19T09:00:00.000Z" }
  ]
}
```

`comments` uses the existing `toComment` DTO, oldest first, capped at 200, and comment likes/deletes
keep going through `/api/posts/:id/...` — no new engagement surface.

Visible when approved+ok, **or** when the viewer is the author (`moderationState:"pending"` is then
returned to them), **or** when the viewer is staff. Otherwise
`404 {"error":{"code":"not_found","message":"Video was not found","fields":{}}}`. A soft-deleted
video is 404 for everyone except staff.

## Create

`POST /api/videos` — two bodies, both accepted:

**1. external link (JSON)** `{"url":"https://youtu.be/x?si=abc","caption":"…","topics":["hiring"],
"durationMs":48200,"width":1080,"height":1920,"thumbnailUrl":"https://i.ytimg.com/vi/x/hqdefault.jpg"}`

**2. upload (multipart/form-data)** field `file` = one video file (`video/mp4|webm|quicktime`),
plus text fields `caption`, `topics` (repeated or JSON array string), `durationMs`, `width`, `height`.
The file lands on the existing `post` upload kind, so `/uploads/posts/…` keeps its meaning on both
stacks and no new storage kind had to be invented.

Server-side validation only (a client-side check is never the reason for a rejection):

| Case | Answer |
| --- | --- |
| `url` missing / not a URL / not `https:` (nor `http:` on localhost) | `400 validation_error`, `fields.url` |
| host outside the provider allowlist | `403 forbidden` `"That provider is not allowlisted"` |
| canonical URL already stored | `409 duplicate`, `fields.url` `"This video is already in the index"` |
| upload with a non-video mimetype | `400 validation_error` (the multer shim's `"Use a PNG, JPG, WEBP, GIF, MP4 or PDF file"`) |
| upload over the kind's byte limit | `400 validation_error` `"Keep each file under 12 MB."` |
| body over `BODY_LIMIT` | `413 validation_error` `"request entity too large"` (the app's error middleware) |
| `topics` with an unknown slug | `400 validation_error`, `fields.topics` |
| `caption` longer than 2000 chars | truncated to 2000 (no error) |

Success: `201` + `VIDEO_ITEM` (with `canonicalUrl`, `embedUrl`, `moderationState:"pending"`,
`availability:"ok"`). New rows always start `pending`, so nothing reaches a public feed without the
moderation step; the author can see their own video at `GET /:id` straight away.

`POST /` always records the acting user as `videos.source_user_id` and as the `posts.user_id`; the
author can never be declared in the body.

## Activity

`POST /api/videos/:id/activity` `{"event":"watch","value_ms":9000,"value_num":null,"dedupe_key":"41:u7:watch:seg-3"}`

* `event` ∈ `view_start | watch | complete | like | save | share | follow_from_video | impression`;
  anything else → `400 validation_error`, `fields.event`.
* `dedupe_key` is required, 1–120 chars; a duplicate key for the same viewer+video+event is stored
  once. Replays are not an error.
* A key that already exists for a **different** user is never accepted or silently ignored:
  `403 forbidden` `"That activity id belongs to another account"` (IDOR guard).
* Activity on a video the viewer cannot see → `404 not_found` (a pending video of somebody else is
  not even confirmable as existing).
* Answers `200 {"recorded":true,"deduped":false,"videoId":41,"event":"watch"}` when it landed, and
  `200 {"recorded":false,"deduped":true,…}` on a replay.
* `value_ms`/`value_num` are optional non-negative integers ≤ 86 400 000; longer or negative →
  `400 validation_error`. They are dropped (null) when the event does not use them.
* `like`/`save`/`share` events are telemetry only — the counters the UI reads stay on
  `/api/posts/:id/like|save|share`, so a `video_activity` row never becomes a second source of truth.

## Interests

`PUT /api/videos/interests` `{"topics":[{"slug":"hiring","weight":0.8},{"slug":"career","weight":0.4}]}`

* Self only: the user id comes from the session, and a body carrying `userId`/`user_id` is
  `400 validation_error` — you cannot write another viewer's weights.
* Replaces the viewer's whole interest set in one atomic batch (D1 `DB.batch()`).
* `weight` must be a number 0..1; unknown slug → `400 validation_error`, `fields.topics`.
* `200 {"ok":true,"topics":[{"slug":"hiring","name":"Hiring","weight":0.8,"updatedAt":"…"}]}`.
* An empty array clears the viewer's interests and answers `{"ok":true,"topics":[]}`.

## Topics (addition beyond the brief)

`GET /api/videos/topics` → `200 {"items":[{"id":1,"slug":"career","name":"Career","parentId":null}]}`
The taxonomy is seeded by the migration; the interest editor needs it to draw chips. Public-ish only
in the sense that it is not sensitive: it still requires a token because the whole mount does.

---

## Admin

All `/api/videos/admin/…` routes are deny-by-default: no session → 401, session whose DB role is not
`staff`/`admin` → `403 {"error":{"code":"forbidden","message":"This area needs staff access","fields":{}}}`
(the same wording as `middleware/security.js`). Every mutating admin call writes one `audit_logs`
row through `services/audit.js` with `action: "videos.<call>"`, `details.target` (`video:41`),
`details.outcome`, `details.ip` — and never a message body, caption text or token.

### `GET /admin/index?state=pending|approved|removed|all&cursor=&limit=`
`200 {"items":[ VIDEO_ITEM + {"moderationState":"pending","availability":"ok","canonicalUrl":"…",
"sourceUserId":12,"indexedAt":"…","lastCheckedAt":null} ],"total":3,"nextCursor":null,"state":"pending",
"counts":[{"state":"pending","n":3},{"state":"approved","n":19}]}`
Staff sees everything including soft-deleted rows when `state=all`. The queue lists **every**
matching row (no per-author ceiling — see *Ranking*), newest-indexed first; `counts` is the whole
index grouped by state, so the console can show queue depth without paging through it.

### `POST /admin/:id/approve` · `POST /admin/:id/remove` · `POST /admin/:id/reprocess`
No body. Single-statement updates (`… RETURNING id`), so the write and its guard are one round trip.

| Call | Effect | Answer |
| --- | --- | --- |
| approve | `moderation_state='approved'`, `last_checked_at=now` | `200 {"ok":true,"videoId":41,"moderationState":"approved","availability":"ok"}` |
| remove | `moderation_state='removed'` (the post row is **not** deleted) | `200 {…,"moderationState":"removed"}` |
| reprocess | `moderation_state='pending'`, `availability` re-derived from the provider/scheme/robots gate (`ok` or `unavailable`) | `200 {…,"moderationState":"pending","availability":"ok"}` |

Unknown/soft-deleted id → 404 `not_found`. A video already in that state → `200` with
`"changed":false` (idempotent), still audited.

### `GET /admin/rank-config`
```json
{ "items": [ { "key": "interest_relevance", "weight": 0.3, "updatedAt": "…" } ],
  "weights": { "interest_relevance": 0.3, "watch_completion": 0.2, "engagement": 0.15,
               "followed_creators": 0.15, "quality_freshness": 0.1, "diversity_discovery": 0.1 },
  "sum": 1 }
```
The six keys are always present because the migration seeds them; weights are read per request, so a
`PUT` changes the next feed without a deploy.

### `PUT /admin/rank-config` `{"weights":{"interest_relevance":0.4,"watch_completion":0.15,"engagement":0.15,"followed_creators":0.15,"quality_freshness":0.05,"diversity_discovery":0.1}}`
* All six keys must be present (partial updates are rejected so the sum stays meaningful).
* Each value a number 0..1; `sum` must be 1.0 (tolerance ±0.001) → otherwise
  `400 validation_error` with `fields.weights` listing the offenders
  (`"weights must sum to 1.000, got 1.100"`).
* Unknown key → `400 validation_error`, `fields.weights`.
* Success answers the same shape as `GET`. Applied as one atomic batch: a rejected statement leaves
  every weight at its old value.

### `GET /admin/sources` · `POST /admin/sources`
GET → `200 {"items":[{"id":5,"kind":"rss","url":"https://…/feed.xml","provider":"youtube",
"enabled":true,"robotsRespected":true,"lastRunAt":null,"etag":null,"createdAt":"…"}]}`.
POST body `{"kind":"rss|sitemap|allowlist","url":"https://…","provider":"youtube","enabled":true}`:
scheme must be `https`, `kind` must be in the list, `provider` must be on the video provider
allowlist; a duplicate `url` → `409 duplicate`. Success `201` + the source item.

### `POST /admin/discovery/run` `{"urls":["https://www.youtube.com/watch?v=abc","…"],"sourceId":5}`
Admin-triggered only; **there is no cron** (`wrangler.toml` declares no `[triggers]`, so
`src/worker.js` exports no `scheduled()` handler). To add one later: put

```toml
[triggers]
crons = ["17 * * * *"]
```

in `cf-api/wrangler.toml`, add `async scheduled(event, env, ctx) { … }` to `src/worker.js` calling
the same `videoKit.runDiscovery()` with an operator id, and keep the audit line so a scheduled write
is attributable. Until then nothing runs itself: this endpoint is the whole pipeline's trigger.

Each URL passes the gate in this order, and each result is written to `video_discovery_log`:

| Outcome | Meaning |
| --- | --- |
| `indexed` | new `videos` row (`kind:'indexed'`, `moderation_state:'pending'`) + its post row |
| `duplicate` | canonical URL already in the index (this batch or a previous run) |
| `provider_denied` | host not on the allowlist |
| `scheme_denied` | not `https:` |
| `robots_denied` | the path matches a `Disallow:` rule of the provider's robots snapshot, or the URL carries a signature/auth/captcha token the crawler must not touch |
| `rejected` | malformed or empty after normalisation |

`200 {"processed":3,"indexed":[52],"duplicates":1,"refused":1,"outcomes":[{"url":"https://…",
"outcome":"indexed","videoId":52,"detail":null}],"sourceId":null,"ranAt":"…"}`.
Idempotent: re-posting the same `urls` answers `duplicates` for all of them and inserts nothing.
`sourceId`, when given, must name an enabled source or the call is `400 validation_error,
fields.sourceId`; a valid source gets `last_run_at` stamped and its `etag` stored from the body's
optional `etag` field. `urls` is capped at 50 entries per call (extra ones are dropped with
`detail:"over-cap"`), and a call with no `urls` is a no-op that still reports the source's run.

## Ranking

`score = Σ weight(key) × feature(key)`, weights from `video_rank_config`, features normalised 0..1:

| Key | Feature |
| --- | --- |
| `interest_relevance` | Σ of the viewer's `video_interests.weight` for the video's topics, divided by the viewer's largest single weight, capped at 1. No interests → 0. |
| `watch_completion` | Σ `value_ms` of the video's `watch` events ÷ (`count × durationMs`); 0 when nothing was watched or the clip is unmeasured. |
| `engagement` | `(likes + comments + saves + shares) ÷ (that sum + 10)` — saturating, so one viral clip cannot dominate. |
| `followed_creators` | 1 when the viewer follows the author, else 0. |
| `quality_freshness` | `14 ÷ (14 + ageInDays)`, computed in JS from `created_at` so no dialect-specific date arithmetic is needed. |
| `diversity_discovery` | `(1 ÷ (1 + sameAuthorAlreadyOnThisPage)) × (1 − min(1, impressions ÷ 25))` — rewards unseen clips, discounts authors the page already carries. |

Diversity guard, independent of the weights: **one author is preferred at 2 items before any other
creator's row is skipped** (the `MAX_PER_AUTHOR` ceiling shapes the page's order, together with
`diversity_discovery`). Once every other candidate has been taken, the ceiling relaxes — the next
best over-ceiling clip is returned rather than dropping content. An earlier reading hard-capped the
whole ranking window at 2 per author, which made a prolific creator's third-plus clips *unreachable*
(19 approved videos by two authors answered the feed with 4 items); the 2026-10-20 fix keeps the
ordering intent and restores reachability. The admin queue and search are exempt from the ceiling
entirely — a moderation list or a lookup that hides rows reads as breakage, not as diversity.

`ranking.reasons` reports each feature's raw value and the weight applied, so the UI can label
"why am I seeing this" and the ops console can debug a weight change without a redeploy.

**Parameter binding convention** (where the bug above lived): `rankedPage`/`selectVideos` bind
`[viewer, ...whereParams]`, so inside any caller-supplied `WHERE` clause **`$1` is always the viewer
id** — route parameters must be numbered from `$2` (`routeParams()` in `routes/spa/videos.js`).

## Schema

`app-new/migrations/012_videos.sql` (Postgres, for the VPS) and
`app-new/migrations-d1/012_videos.sql` (the same tables in the D1/SQLite dialect the Worker applies
through `cf-api/tools/apply-schema.mjs`). Tables: `videos`, `video_topics` (seeded with career,
hiring, design, engineering, finance, sales, leadership, freelancing), `video_interests`,
`video_activity`, `video_rank_config` (seeded with the six weights), `video_sources`,
`video_discovery_log`. A video is always a `posts` row plus a `videos` row, so `post_likes`,
`comments`, `post_shares`, `saved_items` keep serving engagement verbatim.

## Automatic enrolment from posts

The feed already received videos before `/videos` existed: plain public posts whose `media` carries
an `.mp4`/`.webm`/`.mov`/`.m4v` under `/uploads/`, and posts whose `link_url` passes `gateUrl()`.
Both are now enrolled into the `videos` index automatically, through one shared classifier —
`videoKit.fromPostRow(post)` — used by:

* the **intake hook** in `POST /posts` (`routes/spa/feed.js`): after the post row is committed, a
  post with `post_type='post'`, public visibility and no `scheduled_at` is classified; a match is
  inserted as `videos (…, moderation_state='pending', availability='ok')` unless its
  `canonical_url` is already indexed or the post already owns a row. Listing kinds (job, product,
  …), connections-only posts and scheduled posts stay out; the hook is wrapped in `try/catch`
  because enrolment must never turn a successful post into a failed request.
* the **backfill tool** `cf-api/tools/backfill-post-videos.mjs` (same classifier, run against D1
  over the HTTP query API). Dry run by default; `--apply` only INSERTs. Idempotent: re-running
  enrols 0.

Everything lands as `pending`: **nothing reaches the videos feed until staff approve it in the
video console** (`/videos/admin`), backfilled rows included — the operator chose review-first over
auto-approval. Approved rows then obey the same `PUBLIC_CLAUSE` as creator-added videos, and
engagement never moves: it stays on the `posts` row, which is what `VIDEO_SELECT` reads through `p`.

Notes for the two dialects: the hook lives in the `app-new` overlay and so only the Cloudflare
side auto-enrols; the VPS stays byte-identical to the mirror as the rollback path (rollback
simply stops enrolment, it does not un-index anything). The provider-link half is currently
vacuous in production: the two existing `link_url` posts point at non-allowlisted domains, so the
gate rejects them by design — links enrol only from the moment a gated URL is posted.

## Safety: mutes and blocks

Mutes are **server-side and account-wide** (`mutes(user_id, muted_id)` — migration 013, PK on the
pair, FK cascades to `users`, `CHECK user_id <> muted_id`). The list travels with the account, so
mute state survives a device change; the client's localStorage copy is only a pre-load cache.

Routes (router `app-new/routes/spa/safety.js`, mounted into the single `/api` chain — adding a
second `app.use("/api", authenticate, userLimiter, …)` line would double-count every request
against the rate limiter):

| Route | Answers | Notes |
| --- | --- | --- |
| `GET /api/mutes` | `{"items":[{id,username,name,avatarUrl}]}` | the viewer's muted creators |
| `POST /api/mutes/:userId` | `201 {"muted":true,"userId":n}` | self → `400`, unknown user → `404`, repeat → idempotent `201` |
| `DELETE /api/mutes/:userId` | `{"muted":false,"userId":n}` | unmute; the creator is immediately back in both feeds |
| `GET /api/blocks` | `{"items":[…]}` | read-only addition — the `POST/DELETE /api/blocks` write path already lives in `platform.js` and is deliberately not duplicated here |

The exclusion itself is SQL, applied to both feeds identically: the videos `PUBLIC_CLAUSE`
(`videoKit.js`) and the `WHERE` list of `GET /api/posts/feed` (`routes/spa/feed.js`) each carry a
`NOT EXISTS mutes` (one-way: muting hides the creator's posts from the muter only) and a symmetric
`NOT EXISTS blocks` (two-way: blocker and blocked never see each other's content, in either
direction of the relationship). `GET /api/videos/search` routes through the same ranking page, so
it inherits the videos-side exclusion. Home feed additionally accepts `?scope=following`, which
narrows the timeline to creators the viewer follows (the same `follows` table the videos
"following" tab reads) — the client exposes it as a "Following" chip on the feed page.
