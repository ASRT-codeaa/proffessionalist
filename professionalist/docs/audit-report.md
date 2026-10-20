# Engineering Audit Report — Professionalist

**Phase-1 read-only audit.** Date: **2026-10-20**. Audience: engineering / migration owners.

Companion file: `docs/feature-inventory.md` (per-capability status). This report covers architecture,
the backend endpoint map, duplicate/dead code, the risk register, security, and owner decisions.

Sources of truth:
- **Current backend:** `/workspaces/app-mirror/app/**` (mirror stated byte-identical to live VPS —
  `CLOUDFLARE-MIGRATION-HANDOFF.md` §3). All `file:line` below are in that mirror.
- **Frontend:** served SPA bundle `dist/assets/index-kP6wg8PP.js` + lazy chunks. **SPA `src/**` is not
  in the repo**, so UI claims are read from the minified bundle and any that could not be confirmed are
  labelled **unverified inference**.
- **Target backend:** `cf-api/**` (in flight — other agents are editing it now; not evaluated for
  correctness here, only its existence/state is recorded).

No production was probed, no login attempted, no Cloudflare API called. This is static analysis only.

---

## A. Architecture: current vs target, per layer

### A.1 Current (live VPS)

- **API:** Express 5 (`package.json` express `5.1.0`) bound to `127.0.0.1:5000` behind nginx
  (`server.js:183`). `app.set("trust proxy",1)` for Cloudflare `X-Forwarded-For` (`server.js:23`).
- **DB:** PostgreSQL via `pg.Pool` (`db.js`, required as `{ health, query, pool }`).
- **Cache/queue:** Redis client present (`redis.js`) but **no route calls it** (see §C.4) — effectively unused.
- **AuthN:** HS256 Bearer JWT (`jsonwebtoken`) + server-side `auth_sessions` row lookup
  (`middleware/authenticate.js:44-62`); DB lockout (`failed_login_attempts`/`locked_until`).
- **Static media:** local disk `/uploads` (`server.js:132-143`), multer uploads
  (`middleware/upload.js`), served same-origin with `Cross-Origin-Resource-Policy: cross-origin` so the
  CDN-hosted SPA can embed them.
- **Mail:** `services/mailer.js` → `https.request` to `email.proffessionalist.com`
  (`MAILER_API_URL`/`MAILER_API_TOKEN`), fire-and-forget retries `[0,1500,6000]`, self-disables without
  creds or with `MAILER_ENABLED=false`.
- **Frontend:** React SPA on Cloudflare Pages/Workers static hosting; `sw.js` + `manifest.webmanifest`
  for PWA; talks to `api.proffessionalist.com` via a fetch client (Bearer + `401→refresh→retry`).

### A.2 Target (Cloudflare)

- **Compute:** single Worker (`cf-api/src/worker.js`) whose `fetch` hands one Request to the hand-
  transcribed `src/api.js` (a line-for-line copy of `server.js` mount order) and hosts the
  `RateLimiter` **Durable Object**.
- **DB:** D1 (`wrangler.toml` `[[d1_databases]] DB`, `database_name="professionalist-db-v2"`, committed
  `database_id="placeholder"`, real id substituted at deploy from a tmp file — never printed here).
- **Storage:** R2 (`[[r2_buckets]] MEDIA`), bucket `professionalist-media`; `serveUpload()` in
  `src/shims/upload.js` replaces `express.static`.
- **Rate limit:** Durable Object (`[[durable_objects.bindings]] RATE_COUNTERS`, class `RateLimiter`),
  **SQLite-backed** (`[[migrations]] new_sqlite_classes=["RateLimiter"]`) — a deliberate deviation from
  the KV plan (§D, and handoff §6 "DEVIATION").
- **Compatibility shims** (`cf-api/src/shims/`): `express.js` (Fetch-API subset), `pg-compat.js` +
  `db.js` (pg→D1 adapter), `jwt.js` (WebCrypto HS256), `limit.js` (express-rate-limit→DO),
  `upload.js` (multer→R2), `helmet.js`/`cors.js` (header shims), `https.js` (node:https→fetch for mailer).

### A.3 Per-layer migration status

| Layer | Target tech | Status | Evidence / note |
|---|---|---|---|
| Routing/mounts | Worker `api.js` | **Ported, preview-deployed** | handoff §5.8: `professionalist-api.geraldmariba.workers.dev` answers byte-identically to VPS (`verify-preview.mjs` 0 diffs). |
| DB driver | D1 + `pg-compat.js` | **Adapter written & verified; 5 hand-ports still unwritten to ported copies** | handoff §6 "Remaining in #18". D1 `database_id` still `placeholder` in committed config. |
| Auth/JWT | WebCrypto HS256 | **Shim differential-tested** | `shims/jwt.js`; handoff §6 shims list. |
| Sessions | D1 `auth_sessions` | Working in preview (port of authenticate middleware) | — |
| Rate limit | Durable Object | **Deployed as SQLite-backed DO** | `[[migrations]] new_sqlite_classes`; code 10099 forced this (§D risk). |
| Media | R2 | **Working: all 67 files (92,394,392 bytes) backfilled and verified** | `tools/backfill-r2.mjs --verify` reads keys/size/stored content-type back with 0 problems, and handoff §5.8 compares a live 437,299-byte avatar across both stacks (same type/length/cache/ranges, and a `bytes=0-99` Range returning the same 100 bytes on both). The "39 files / 26.8 MB" figure was an early read-only SSH pass and the `wrangler.toml` note carrying it has now been corrected. |
| Mail | `https.js`→fetch | **Shim exists; needs node:https port wired** | mirror `services/mailer.js` uses `https.request`. |
| Ops migration runner | n/a | **Blocked — cannot run on Worker** | `routes/spa/ops.js:375-412` reads `.sql` from disk; owner decision pending (handoff §6). |
| Frontend source | Pages | **Missing from repo** | `src/**` not present; other agents creating it now. |
| Redis | dropped | **Intentionally not ported** | handoff §6 "DEVIATION — Redis is not ported"; mirror `redis.js` has no route caller. |

**Cut-over posture:** VPS still serves 100% of traffic (instant rollback). No custom hostname bound to the
Worker (`/settings` → `routes: (none)`, handoff §5.8). Binding `api.proffessionalist.com` needs explicit
owner go-ahead **plus** a quiet-window `copy-data.mjs` re-run to pick up rows written after 2026-10-19.

---

## B. Backend endpoint map (current Express/PostgreSQL)

Auth column: **A** = `authenticate` required; **S** = `requireStaff`; **AD** = `requireAdmin`;
**OPS** = admin+`OPS_OWNER_ID`+optional `x-ops-token` (`routes/spa/ops.js:67-83`); **(public)**.
Limiter column: **ip** = global ipLimiter; **+u** = userLimiter; **+a** = authLimiter.
"PG-only" = SQL needing hand-port (recursive-CTE / `json_each` / `json_patch` / `json_extract` / D1-specific).

Mount order (`server.js:145-158`): `/api/auth`(authLimiter)×2, `/api/admin`, `/api/meta`,
`/api/onboarding`(auth,userLimiter), then `/api`(auth,userLimiter, **spa first**, platform second).
`ipLimiter` is global (`server.js:103`).

### B.1 `/api/auth` — `routes/auth.js` (+ `routes/auth-mail.js`), limiter +a

| Method Path | Auth | PG-only | Tables | Evidence |
|---|---|---|---|---|
| POST /register | public | — | users, auth_sessions, email_verification_tokens | auth.js:68-150 |
| POST /login | public | NOW()/locked_until compare | users, auth_sessions | auth.js:152-211 |
| POST /refresh | public | NOW() | auth_sessions | auth.js:213-252 |
| POST /logout | A | — | auth_sessions | auth.js |
| GET /me | A | JOIN | users, auth_sessions | auth.js |
| POST /forgot-password | public | NOW() | password_reset_tokens | auth-mail.js:51-77 |
| POST /resend-verification | public | — | users, email_verification_tokens | auth-mail.js:79-98 |
| POST /recover-account | public | — | password_reset_tokens (emails reset link; **not** email-less) | auth-mail.js:100-126 |
| POST /verify-email | public | used_at/expires_at | email_verification_tokens, users | auth-mail.js:128-156 |
| POST /reset-password | public | revoke all | auth_sessions, users | auth-mail.js:158-206 |

### B.2 `/api/meta` — `routes/meta.js` (public)

| GET /countries · /categories · /trends | — | reference tables; **trends returns `[]` stub** | meta.js |
| GET /content | — | app_content `WHERE key = ANY($1::text[])` (`:29`, `json_each`) | meta.js:29 |

### B.3 `/api/onboarding` — `routes/onboarding.js`, limiter +u, A

| POST /avatar | — | uploads (avatar) |
| PUT / (me) | **TX** BEGIN/COMMIT `:137/:140/:205/:209`; skills `INSERT…RETURNING id` inside tx `:172-183` → **data-modifying CTE**; follows `unnest($2::bigint[])` `:191` → `json_each`; UPLOAD_ROOT `__dirname` `:10` |

### B.4 `/api/admin` — `routes/admin.js`, A + S (AD/OPS noted), limiter ip only (no +u)

| Method Path | Auth | Notes | Evidence |
|---|---|---|---|
| GET /users · /security-events · /audit-logs | S | — | admin.js |
| PATCH /users/:id/status · /role | **AD** | revoke sessions | admin.js:51-126 |
| GET /stats | S | `monthlySignups generate_series :144-158` **PG-only**; `revenue:0` hardcoded | admin.js:144-202 |
| GET /businesses · POST /businesses/:id/verify | S | `verified`/`verified_badge` cols (migration 010 server-only, see §C.3) | admin.js:204-272 |
| GET /listings · /posts | S | — | admin.js:274-316 |
| GET /reports · POST /reports/:id/action | **AD** | intake endpoint absent (§feature-inventory 7) | admin.js:320-377 |
| GET /transactions | S | **returns `[]`, no payments schema** | admin.js:383-385 |
| GET /tickets | S | reads support_tickets+support_messages (**no public write path**) | admin.js:387-412 |
| GET /ads | S | reads ad_campaigns (**no public write path**) | admin.js:414-424 |
| POST /users/:id/action | **AD** | suspend/block/verify/badge; revoke sessions; mail | admin.js:430-527 |

### B.5 `/api` → spa (`routes/spa/index.js`) — limiter +u, A — **the surface the UI actually calls**

**`spa/feed.js`** (posts):
GET /posts/feed `:70-112`(unnest hashtags `:83`) · POST /posts/media `:155` · POST /posts `:167` ·
GET /posts/:id `:204` · DELETE /posts/:id `:212` · POST /posts/:id/like `:222` · poll `:254`
(`=ANY($1::bigint[])` `:30,:36`) · GET/POST /posts/comments `:274/:292` · DELETE /posts/comments/:id `:317`
· POST /posts/:id/share `:333` · POST /posts/:id/save `:359` (`saved_items`,
`COALESCE(p.media->0,to_jsonb(media_url))` → `json_extract`/`json_quote`). **No PATCH /posts/:id (no edit).**

**`spa/social.js`** (network/search/notifications/progress/profile):
notifications GET/unread-count/read-all(POST)/:id/read(PATCH) `:29-78` · search/suggestions
`unnest :94` `:82-137` · GET /search `:152-221` · network/* (connections/requests/follows/blocks)
`:230-464` · GET /users/me/progress `generate_series+date_trunc :530-537` `:468-582` · goals `:584-607` ·
**PATCH /users/me/profile** whitelist `PROFILE_COLUMNS` `:611-622` (**no experience/education/portfolio/cert**) ·
GET /users/:username `:723-776`.

**`spa/market.js`** (marketplace/opportunities/businesses/saved):
categories/home/listings (`NULLS LAST :126`, nearby `DESC NULLS LAST :58`) `:41-70` · /:id(increment views)
· /:id/related · POST / PATCH (ownership via `company_members`) / DELETE · /favorite · /images ·
/my-listings `:41-344` · opportunities GET / apply `:360-411` · businesses CRUD + analytics
(`generate_series :550-557`) + employees + reviews + /businesses/:slug `:414-677` · saved + collections +
DELETE `:683-724`.

**`spa/chat.js`** (messaging/tasks/settings/password/sessions):
messages/conversations GET(`'epoch' :55`) · POST(`unnest u(id) :123`, conversations DEFAULT VALUES `:118`) ·
/:id · /:id/messages · /:id · /messages/:id/read · /reaction · /search · /upload `:60-354` ·
tasks CRUD+toggle `:360-473` · settings GET `:496-545` / PATCH (`data || EXCLUDED.data :565-571` → **json_patch**) ·
password PATCH (bcrypt12, revoke other sessions `:603-628`) · sessions DELETE `:630-640`.

**`/api/admin/ops`** (mounted `spa/index.js:12` → `spa/ops.js`), limiter ip, **A+S+OPS**:
/status (`information_schema.tables =ANY :99-100` → **sqlite_master+json_each**; `process.version`/uptime `:135-157`) ·
/audit · users/delete (`DELETE=ANY` `:215`) · users/role · content PUT (`$2::jsonb :276-283`) ·
categories PUT/DELETE `:301-336` · data/purge `:340-366` · **/migrations/run** (`pool.connect()`+
`fs.readFileSync` migration runner `:375-412`, `MIGRATIONS_DIR=__dirname :32`) → **filesystem-dependent, cannot port.**
`STATUS_TABLES :38-44` / `PURGE_TARGETS :46-59` list `ai_conversations, ad_campaigns, support_tickets,
user_tasks, user_settings, reports, reviews, …`.

### B.6 `/api` → platform (`routes/platform.js`) — mounted **after** spa → largely shadowed

Legacy handlers (all A, limiter +u): profile/me GET+PUT `:99-220` · profile/:username `:222-277` ·
skills GET + profile/me/skills POST/DELETE `:283-361` · experience `:363-463` · education `:465-562` ·
connections GET/requests/POST/PATCH/DELETE + follows + blocks `:568-966` · posts GET(uses `saved_posts`
`993`)/POST/GET/:id/PATCH/DELETE/like/share/save/comments `:972-1416` · comments PATCH/DELETE `:1418-1473` ·
companies CRUD+members `:1479-1709` · jobs CRUD+apply+applications PATCH `:1715-2074` · marketplace CRUD
(`category` string col + `media_url`, archive-on-delete) `:2080-2262` · conversations/messages `:2268-2613` ·
notifications GET+read-all(PATCH)+read `:2619-2693` · **GET /search `:2699-2778` (dead, shadowed)**.

Because `spaRoutes` mounts first (`server.js:158`, and the `:152-157` comment: platform matches
`/posts/:id` and `/marketplace/:id` and would swallow `/posts/feed` and `/marketplace/home`), **every
overlapping platform path is unreachable** and is treated as dead in §C.

### B.7 Cross-check vs handoff §6 hand-port table

All 12 §6 sites confirmed present at the exact lines (mirror): `admin.js:146`(gen_series) ·
`market.js:552`(gen_series) · `social.js:532`(gen_series) · `ops.js:99`(information_schema) ·
`chat.js:569`(jsonb `||`→json_patch) · `feed.js:83`(unnest) · `social.js:94`(unnest) ·
`onboarding.js:191`(unnest) · `chat.js:123`(unnest) · `feed.js:359`(->/to_jsonb) · `chat.js:55`('epoch') ·
`market.js:58`(NULLS LAST). **Extra** beyond §6: `onboarding.js:172-183` RETURNING-inside-tx (data-modifying
CTE), `ops.js:375-412` migration runner (drop/redesign), `mailer.js` `https.request` (→fetch). No §6 site
was found missing from the mirror; no un-listed PG-only construct beyond these was discovered.

---

## C. Duplicates, dead routes, disconnected UI, inconsistent models, obsolete deps

### C.1 Triple overlap: connections / follows / network

- `routes/network.js` — **only** `GET /suggestions` (`:81-104`, ILIKE `:72-78`), mounted `spa/index.js:12`.
- `routes/spa/social.js` `network/*` `:230-464` — the **live** connections/follows/blocks the UI uses.
- `routes/platform.js` `/connections` `/follows` `/blocks` `:568-966` — **legacy/dead** (shadowed; 0 bundle refs).
Three SELECT shapes over `connections`/`follows`; only the spa one is reachable.

### C.2 posts / feed / search overlap (resolved by mount order)

`spa/feed.js` and `platform.js` both implement posts; `spa/social.js` `GET /search` `:152-221` and
`platform.js` `GET /search` `:2699-2778` both exist — platform's is **dead** (shadowed). Same for posts/notifications.

### C.3 `server.js.bak.*` / `auth.js.bak.*` drift + missing migration

- `server.js.bak.1790937123`: older **generalLimiter 300/15m**, bare `{error:"..."}` envelopes, **no**
  userLimiter/onboarding/spa/uploads mounts → proves the current per-user + envelope + spa architecture is
  recent. Backup files are dead artifacts; must not be ported.
- `auth.js.bak.1790935545:7`: `const { client } = require("../redis");` → confirms auth **used to** depend
  on Redis; current `routes/auth.js` does not (obsolete-dep evidence, §C.4).
- **Migration gap:** mirror has `001-009` and `011`, **missing `010_verified_badge`** (server-only). Yet
  `verified`/`verified_badge` columns are read by `routes/admin.js:204-272` and DTO. The generated D1
  schema is rebuilt from the **live** PostgreSQL DDL (handoff §5.1), so this only matters if anyone
  re-applies the mirror's `migrations/*.sql` to D1 instead of `compat/live-schema.sql`.

### C.4 `redis.js` — obsolete dependency

`redis.js` exports `connectRedis`/`client`. Only live caller is `server.js:177` (`connectRedis()` at boot).
**No route uses it** (the only route-level `require("../redis")` is in the `.bak` file). `redis` `5.8.1`
remains in `package.json`. `/health/full` still reports `redis:"connected"` unconditionally
(`server.js:121-128`) — a **cosmetic lie** (see §D). Migration correctly drops Redis (handoff §6).

### C.5 Inconsistent data models (legacy vs SPA twins)

- **Saved:** `spa/feed.js:359` writes **`saved_items`**; `platform.js` writes **`saved_posts`** (`993`) — two tables for one feature; only `saved_items` is UI-reachable.
- **Marketplace:** `spa/market.js` uses `category_id` (FK) + `images` (jsonb); `platform.js` uses a `category` **string** column + single `media_url` and **archieves on delete** — divergent schema assumptions in the two routers over the same logical resource.
- **Notifications read:** spa uses `POST /read-all` + `PATCH /:id/read`; platform uses `PATCH /read-all` (`:2676`) — verb/path mismatch on the dead twin.
- **Mis-homed routes:** change-password, sessions, settings, tasks live in `spa/chat.js` (chat router) though they are profile/account features — a discoverability/maintenance hazard (the SPA still calls the right paths).

### C.6 Disconnected UI → backend (calls a path that returns 404)

Confirmed in the bundle; each falls through `/api` to the 404 catch-all (`server.js:160-162`):
- **AI assistant:** `AssistantPage` → `/api/ai/conversations`, `/api/ai/messages`, `/api/ai/suggestions`. **No `/api/ai/*` router.** `ai_conversations`/`ai_messages` tables exist (**schema-only, no reader/writer**).
- **Advertising:** `AdvertisingPage` → `/api/ads/campaigns`. Only **admin-read** `/api/admin/ads` exists; no user-facing write endpoint. `ad_campaigns` is schema + admin-read only.
- **Support:** `SupportPage` → `/api/support/tickets`, `/api/support/availability`, `/api/support/:id`, `/api/support/:id/reply`. Only **admin-read** `/api/admin/tickets`; no public endpoint. `support_tickets`/`support_messages` schema + admin-read only.
- **Report listing:** `ListingPage` "Report listing" `onSubmit` = **toast only, no API call**; no public `POST /reports`. `reports` table is admin-read only.
- **Experience / education write:** `EditProfilePage` collects them but only calls `PATCH /api/users/me/profile`
  (`PROFILE_COLUMNS` ignores those fields, `spa/social.js:611-622`). The platform write routes (`:363-562`) exist but are dead → user edits are silently dropped.
- **Portfolio / certifications:** collected in UI; `userDto.js:115-116` returns **hardcoded `[]`**; no write → captured data lost.

### C.7 Dead legacy surface in platform.js (0 bundle references)

`profile/me`, `skills`, `experience`, `education`, `connections`, `follows`, `blocks`, `jobs`, `applications`,
legacy `conversations/messages`, legacy `search`, legacy `saved_posts` writes — all shadowed by the spa mount
and unreferenced by the shipped SPA. Candidate for deletion **after** cutover (do not port).

---

## D. Risk register

| # | Risk | Likelihood | Impact | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|
| 1 | **D1 snapshot drift until cutover** — data copied to D1 on 2026-10-19; VPS rows written since are absent. Any preview comparison or early flip serves stale data. | High (site is live) | High (data loss / wrong reads) | Quiet-window `copy-data.mjs` re-run **immediately before** hostname flip; keep VPS as 100% origin until then; no cron/backfill running (handoff §3, §5.8). | Migration owner | **Open** |
| 2 | **`/health/full` reports `redis:"connected"` unconditionally** while Redis is unused/retired (`server.js:121-128`; §C.4). A green health check misleads on-call. | Certain (it is a literal) | Medium (false confidence; masks real dependency loss) | After cutover, drop the redis field or make it reflect D1/R2/DO truth; `/health` (`:112-119`) is already honest. Mark as known cosmetic in runbook now. | Backend | **Open** |
| 3 | **SQLite-backed Durable Object requirement** — first deploy failed with Cloudflare API **code 10099** ("new key-value backed DO namespaces no longer supported"); fixed config-only via `new_sqlite_classes`. This is a **deploy-only** failure invisible to `wrangler dev`. | Certain (measured) | High (deploy blocks) | Keep `[[migrations]] new_sqlite_classes=["RateLimiter"]` (one-way ledger tag `v1`); never half-switch to `[exports]`; prove any DO change with a real deploy, not dev. | Migration owner | **Mitigated (config), needs ongoing discipline** |
| 4 | **Rate-limit fail-open** — `shims/limit.js` catch lets the request through if the DO counters error; a counter/DO outage disables all three buckets. | Low-Med (DO brief failures) | Medium (abuse window; weakens IP/user throttles) | Accepted by design: DB lockout (`failed_login_attempts`/`locked_until`, `routes/auth.js:179-196`) is the **real** brute-force defence (`server.js:87-91`). Add DO-alarm/metric on 500-rate; do not rely on limiter as sole defence. | Backend | **Accepted with control** |
| 5 | **Leaked Cloudflare API token awaiting rotation** — an early `set -a; . ~/.cf_token_tmp` echoed the token into a transcript (handoff §5.8). Token value deliberately **not** reproduced here. | Certain (exposure happened) | **High** (account takeover of Cloudflare) | Rotate the token now; purge any transcript/artifact containing it; keep using `export CLOUDFLARE_API_TOKEN=$(cat …)` + `paths.mjs` `hideSecrets`. Verify no secret-bearing Worker **version** is retained (handoff §2: `wrangler rollback` repairs version snapshots). | **Owner / security** | **OPEN — urgent** |
| 6 | **Missing SPA `src/` tree blocks UI work** — repo has only the built `dist/`; two agents are recreating `src/**` now. Audit UI facts come from minified bundle only. | Certain | Medium (can't fix disconnected UI until source lands) | Land `src/**` (in progress); re-verify bundle-inferred endpoints against source before shipping fixes. | Frontend | **In progress** |
| 7 | **D1 has no cross-statement transactions** (no BEGIN/COMMIT binding) — buffered `pool.connect()`+batch. `routes/onboarding.js:137` and `routes/spa/ops.js:393` are the only tx sites; onboarding's `INSERT…RETURNING id` (`:172-183`) is read-your-write the buffer can't serve. | High (onboarding is a live path) | High (broken onboarding / partial writes) | Port onboarding skills insert to a **data-modifying CTE** (`WITH s AS (INSERT…RETURNING id) INSERT…`) so it fits one batch (handoff §6). Design-decide `ops.js` migration runner (§C.3, D-#20). Guard must **throw**, not return empty, on in-tx SELECT/RETURNING. | Migration owner | **Open** |
| 8 | **R2 media becomes the only copy after cutover** — the backfill IS complete and verified (67 files / 92,394,392 bytes, `--verify` 0 problems, §5.8 Range parity), but the VPS disk is still the authoritative original until the flip, and R2 has no versioning enabled. | Med | **High** (permanent media loss if R2 is damaged and no second copy exists) | Keep the VPS disk (and `/workspaces/vps-uploads`) as the rollback source until R2 is confirmed under real traffic; decide on bucket versioning / a second copy before retiring the VPS; re-run `backfill-r2.mjs --verify` in the cutover window to catch files written since 2026-10-19. | Migration owner | **Open** (backfill done; second-copy decision outstanding) |
| 9 | **Preview Worker publicly reachable** at `professionalist-api.geraldmariba.workers.dev` (`workers_dev = true`); no custom hostname bound yet (`routes:(none)`). | Certain | Medium | `--preview` forces `MAILER_ENABLED=false` so the public URL can't deliver real password resets (`services/mailer.js:18`). Turn `workers_dev` off / restrict at hostname flip; re-deploy **without** `--preview` so mail actually works post-cutover. | Migration owner | **Mitigated (preview flag)** |
| 10 | **Legacy/disconnected UI shipped** — AI, advertising, support, listing-report, and profile experience/education/portfolio edits call endpoints that 404 or silently drop (§C.6). Users see toasts/empties, not errors. | Certain (bundle shows the calls) | Medium (broken features on the live site) | Ship real endpoints or feature-flag those pages before marketing them; reconcile `saved_posts` vs `saved_items` and the double router (§C.5). | Product + Backend | **Open** |
| 11 | **Missing `010_verified_badge` migration** in mirror though columns are used (§C.3). Harmless if D1 schema comes from `live-schema.sql`; breaks only if someone re-applies mirror `migrations/*.sql`. | Low | Medium | Standardise on `compat/live-schema.sql`/`compat/schema.sql` as the single source; add the missing file or drop it from the mirror. | Backend | **Open (low)** |
| 12 | **CORS/cookie posture** — `credentials:true` with an origin **allowlist** from `CORS_ORIGIN` (`server.js:28-35`); auth is Bearer-in-header, not cookie, so CSRF is not the primary surface. If `CORS_ORIGIN` is unset it becomes `false` (no cross-origin) — a silent misconfig that breaks the SPA. | Low | Medium | Assert `CORS_ORIGIN` set at boot; keep allowlist (never `*` with credentials). Verify identical origins carried into Worker `env` (`api.js` ENV_HANDOFF lists `CORS_ORIGIN`; confirmed public non-secret, handoff §5.8). | Backend | **Open (verify at flip)** |

---

## E. Security

### E.1 Server-side authorization (verified)

- **Every** protected router is behind `authenticate` (`server.js:156-158`; `middleware/authenticate.js`): JWT
  verify + `auth_sessions` JOIN requiring `revoked_at IS NULL` and `expires_at > NOW()` (`:44-62`) +
  account `status='active'` check (`:70-72`). Bearer-in-header (not ambient cookie) → token theft is the
  threat model, not CSRF.
- **Role gates** (`middleware/security.js`): `requireStaff` (staff|admin) `:21-27`, `requireAdmin` `:29-35`,
  applied per-route in `routes/admin.js:13-14,51-126,320-377,430-527`. Destructive/admin actions are the
  admin-only ones — good separation.
- **Ops gate** (`routes/spa/ops.js:67-83`): admin **and** `OPS_OWNER_ID` **and** optional `x-ops-token`.
- **Ownership checks** on marketplace mutations via `company_members` (`routes/spa/market.js`) and on
  message/task/settings scope by `user_id`.

### E.2 IDOR candidates to review (authz is present, but object-scoping deserves a pass)

- `GET/DELETE /api/posts/:id`, `PATCH /users/me/profile`, `POST /conversations/:id/messages`,
  `DELETE /api/listings/:id`, `POST /admin/users/:id/action` — each must prove the handler filters by the
  caller's `sub`/membership, not just that the row exists. Evidence of scoping was seen for
  listings/tasks/settings; **post read/delete (`feed.js:204/212`) and `:id/related` scoping, and message
  `:id/read` recipient-scoping, were not individually line-verified here → treat as IDOR review targets,
  labelled unverified inference.** No cross-tenant leak was demonstrated (read-only audit).
- Admin `users/:id/status|role|action` correctly require `requireAdmin`; risk is privilege escalation if a
  non-admin ever reaches `/api/admin` — mount applies S on all and AD on the sensitive ones.

### E.3 Upload validation & size limits (`middleware/upload.js`)

- Per-kind size caps: avatar **6MB**, cover/post/listing/message **12MB** (`:8-14`).
- MIME allowlist: images + pdf + mp4/webm/mov (`:17-34`). Server-generated filename
  `{owner}-{16hex}{ext}` (`:42-45`) — no user-controlled filename/path → path-traversal-resistant.
- `removeStored` cleanup (`:104-109`). Body JSON/urlencoded capped at `BODY_LIMIT||1mb` (`server.js:37-38`).
- Note: `/uploads` static sets `CORP: cross-origin` (`server.js:132-143`) — required for CDN-embedded
  media, but means media is readable cross-origin by design; ensure nothing sensitive is ever written there.

### E.4 Transport / headers / sessions

- `helmet()` applied globally (`server.js:26`); `x-powered-by` disabled (`:24`); `trust proxy` = 1 hop
  (`:23`). CORS allowlist + `credentials:true` + method/header whitelist (`server.js:28-35`).
- Sessions: HS256 JWT exp `JWT_EXPIRES_IN||2h`, but **real** lifetime bound by `auth_sessions` row
  (`SESSION_TTL_SECONDS`); logout / password-change / admin-action / reset-password all **revoke** rows
  (`routes/auth-mail.js:186`, `chat.js:603-628`, `admin.js:430-527`, boot sweep `server.js:179`).
- Mail tokens are **hashed, single-use**, with TTLs (`services/emailTokens.js`; verify 24h / reset 60m) —
  replay/dump resistant.

### E.5 Audit-log content (`services/audit.js`)

- `securityEvent → security_events`; `audit → audit_logs`. Actor recorded by `actor_user_id`; **no ip
  column** → ip stored inside `details` json (confirmed by schema/`STATUS_TABLES`). Ensure `details` never
  logs secrets/tokens; `/health` and ops `envKeys` (`ops.js:147`) print **key names only, never values**.

### E.6 What to TEST (read-only audit — no attacks, no live-account logins)

Because failed logins **lock real members** (`MAX_LOGIN_FAILURES=5`/`LOCKOUT_MINUTES=15`), do **not**
attempt logins against production accounts. Planned safe verifications after the SPA source lands and/or on
preview:

1. Envelope parity: hit unknown `/api/xyz` → expect `{error:{code:"not_found",…}}` (matches `parseError`).
2. Authz matrix (own test accounts only): member token → `PATCH /admin/users/:id/status` must 403;
   non-ops admin → `/api/admin/ops/*` must 403.
3. IDOR probes with **two of our own** seeded accounts: user A requests B's post/listing/conversation by id.
4. Rate limiters on **our** load account: confirm 400/60s per-user and 100/15m auth-failure buckets fire and
   that a DO-counter outage fails **open**, not error (risk 4).
5. Upload rejects: oversize/over-MIME file → expect 4xx and no `removeStored` leak; verify filename is
   server-generated.
6. Session revocation: after `reset-password` and admin `users/:id/action`, old tokens must 401.
7. `/health` vs `/health/full`: confirm `/health` reflects DB truth; document `/health/full` redis field as
   known-cosmetic (risk 2).
8. Mail: on preview (`MAILER_ENABLED=false`) confirm no real send; at flip confirm re-deploy **without**
   `--preview` so resets actually deliver (risk 9).
9. Data-model: exercise save-post → confirm it writes `saved_items` (not `saved_posts`); exercise
   listing report → confirm the 404/no-op gap (risk 10).

---

## F. External dependencies & decisions required from the owner

1. **Hostname flip approval** — explicit go-ahead to bind `api.proffessionalist.com` to the Worker and to
   turn `workers_dev`/preview off (risk 9). VPS remains origin until then.
2. **Quiet-window re-copy** — schedule `copy-data.mjs` D1 re-sync immediately before the flip to close the
   snapshot-drift gap (risk 1).
3. **Cloudflare API token rotation** — rotate the leaked token **now** and purge any artifact/transcript
   holding it (risk 5). Highest urgency.
4. **Frontend source upload** — land `src/**` so the disconnected-UI items (§C.6) can be fixed and
   bundle-inferred claims re-verified (risk 6).
5. **Payment provider credentials** — subscriptions/billing/transactions are schema-and-stub only
   (`admin.js:383-385,160-202`); a real provider + plan/entitlement model is a product decision and config,
   not a port.
6. **Cloudflare plan limits** — confirm the account's D1/R2/DO/Worker limits support production traffic
   (esp. DO write rate and D1 batch size) before relying on the Worker for 100% load.
7. **`ops.js` migration runner design** — decide: port to a D1 migration tool or drop `/migrations/run`
   from the Worker surface; it cannot read `.sql` from disk on a Worker (risk 7, handoff §6 #20).
8. **Feature-flag vs build decision** for AI assistant / advertising / support / listing-report /
   experience-education-portfolio edits (risk 10) — either ship the endpoints or hide the pages.
9. **R2 backup/versioning policy** — decide whether to enable object versioning / a second copy, since R2
   becomes the sole media store post-cutover (risk 8).

---

*End of report. All backend claims are `file:line` in the read-only `app-mirror`; UI claims come from the
served bundle and are marked "unverified inference" where the source tree was unavailable. No secrets
(JWT_SECRET, API token, account/zone ids, R2 keys, SSH keys) are reproduced in this file.*
