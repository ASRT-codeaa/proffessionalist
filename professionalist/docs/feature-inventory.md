
# Feature Inventory — Professionalist Platform

**Phase-1 audit baseline.** Date: **2026-10-20**. Audience: engineering.

Method: every capability below was checked against two sources of truth.

- **Backend (current, live):** `/workspaces/app-mirror/app/**` — a read-only mirror stated in
  `CLOUDFLARE-MIGRATION-HANDOFF.md` §3 to be byte-identical to the live VPS Express/PostgreSQL API.
  Evidence is `file:line` in that mirror.
- **Frontend (shipped):** the Cloudflare Pages SPA bundle `dist/assets/index-kP6wg8PP.js` and its
  lazy page chunks. The SPA **source tree (`src/**`) is not present** in the repo, so UI behaviour is
  read from the minified bundle only. Evidence is `chunk:identifier`.

The Worker target (`cf-api/**`) is **in flight** and is described in `audit-report.md`; it is not the
source of truth for "does this work today".

**Status legend (exactly one per row):**
- **Working** — backend endpoint exists and the shipped UI calls it consistently.
- **Partially working** — some part works, some is missing/stubbed/mismatched.
- **Broken** — UI calls something that does not exist on the backend, or backend/UI disagree on shape.
- **Missing** — no capability at all (schema, route and/or UI absent).
- **Requires a decision or external configuration** — needs an owner choice or external credential/config to exist or run.

A backend endpoint that exists but is **never called by the UI** is marked `(legacy/dead)` in Evidence and
discussed in `audit-report.md` §C. A UI call that has **no backend** is a Broken row.

---

## 1. Authentication & account security

| Capability | Status | Evidence (backend) | Evidence (UI bundle) | Backend exists vs UI calling missing |
|---|---|---|---|---|
| Register | Working | `routes/auth.js:68-150`; bcrypt cost 12 at `:109`; welcome mail fire-and-forget `:130-140` | `/register` route; http client POST `/api/auth/register` | Match. |
| Login | Working | `routes/auth.js:152-211` | `/login`; client POST `/api/auth/login` | Match. |
| Logout | Working | `routes/auth.js` logout handler (session revoke) | client POST `/api/auth/logout` | Match. |
| Sessions (server-tracked) | Working | `auth_sessions` rows; verify JOIN `middleware/authenticate.js:44-62`; boot revoke `server.js:179` | Bearer token storage in client | Match. |
| JWT issuance | Working | HS256 `jsonwebtoken`, exp `JWT_EXPIRES_IN\|\|2h` `routes/auth.js:24-30` | client attaches `Authorization: Bearer` | Match. |
| Token refresh / rotation | Working | `routes/auth.js:213-252` rotates `token_hash` | client `401 → refresh → retry` interceptor | Match. |
| Email verification | Working | issue in register `routes/auth.js:130-140`; consume `routes/auth-mail.js:128-156` (204) | `/verify-email` route; client POST `/api/auth/verify-email` | Match. Hashed single-use tokens `services/emailTokens.js` verify=24h. |
| Resend verification | Working | `routes/auth-mail.js:79-98` | client POST `/api/auth/resend-verification` | Match. |
| Forgot password (email link) | Working | `routes/auth-mail.js:51-77`; reset token 60m `services/emailTokens.js` | `/forgot-password`; client POST `/api/auth/forgot-password` | Match. |
| Reset password | Working | `routes/auth-mail.js:158-206`; revoke-all-sessions `:186` | `/reset-password`; client POST `/api/auth/reset-password` | Match. |
| Account recovery **without** email | Requires a decision or external configuration | `routes/auth-mail.js:100-126` — endpoint named "recover-account" but it **emails a reset link**, i.e. still requires inbox access. No alternative-identity path exists. | `/recover-account` route exists and calls `/api/auth/recover-account` | UI/backend path match, but the **capability** ("recover with no email") is not implemented; needs owner decision on an alternate-identity flow. |
| Change password (authenticated) | Working | `routes/spa/chat.js:603-628` (bcrypt12, revokes other sessions) — mis-homed under the chat router | `/settings`; client PATCH `/api/users/me/password` | Match (route path ≠ file location; see `audit-report.md` §C). |
| Failed-login tracking | Working | `routes/auth.js:184-196` `failed_login_attempts` | — | Server-side; UI sees the lockout envelope. |
| Account lockout | Working | `routes/auth.js:179-181` `locked_until`; `MAX_LOGIN_FAILURES\|\|5`, `LOCKOUT_MINUTES\|\|15` `routes/auth.js:15-16` | — | This is the **real** brute-force defence (comment `server.js:87-91`). |
| Rate limiting — IP | Working | `ipLimiter` 3000/15m `server.js:67-74`, global `app.use(ipLimiter)` | — | Match. |
| Rate limiting — per-user | Working | `userLimiter` 400/60s key `u:{sub}` `server.js:76-85`, mounted post-auth `server.js:158` | — | Match. |
| Rate limiting — auth | Working | `authLimiter` 100/15m `skipSuccessfulRequests` `server.js:92-100`, on `/api/auth` `server.js:145-148` | — | Match. |

---

## 2. Navigation & routing (SPA)

| Capability | Status | Evidence (UI bundle) | Notes |
|---|---|---|---|
| App router / nav | Working | `index-kP6wg8PP.js` route table | Routes present: `/`, `/home`, `/discover`, `/network`, `/messages`, `/messages/:id`, `/notifications`, `/marketplace`, `/marketplace/:id`, `/create-listing`, `/opportunities`, `/saved`, `/search`, `/settings`, `/support`, `/profile/:username`, `/profile/edit`, `/onboarding`, `/verify-email`, `/login`, `/register`, `/forgot-password`, `/recover-account`, `/reset-password`, `/assistant`, `/tasks`, `/progress`, `/advertising`, `/business/:slug`. |
| Admin route | Requires a decision or external configuration | `AdminPage` lazy chunk referenced; guarded redirect `state:{from:"/admin"}`. The exact `path:"/admin"` string literal was **not captured** in the bundle → route path existence is **unverified inference**. | Also gated by `requireStaff`/`requireAdmin` server-side (`middleware/security.js:21-35`). |
| HTTP client + error envelope | Working | fetch + Bearer + `401→refresh→retry`; `parseError` reads `error.code/message/fields`; 204 handling | Backend envelope `server.js:47-52` matches exactly. |
| Media URL resolution | Working | `mediaUrl = API_BASE_URL + url` | Backend serves `/uploads` `server.js:132-143`. |

---

## 3. Home feed & posts

| Capability | Status | Evidence (backend) | Evidence (UI) | Backend vs UI |
|---|---|---|---|---|
| Home feed | Working | `GET /api/posts/feed` `routes/spa/feed.js:70-112` | `/home`; client GET `/api/posts/feed` | Match. |
| Create post | Working | `POST /api/posts` `routes/spa/feed.js:167` | client POST `/api/posts` | Match. |
| Attach post media | Working | `POST /api/posts/media` `routes/spa/feed.js:155` | client upload | Match; upload limits `middleware/upload.js:8-14`. |
| Edit post | Missing | **No `PATCH /api/posts/:id` in the SPA router.** Only `routes/platform.js` `PATCH /posts/:id` `:~1180` exists (legacy, see §C) and is shadowed by spa mount order. | No edit-post call in bundle | Post edit not wired to a reachable endpoint. |
| Delete post | Working | `DELETE /api/posts/:id` `routes/spa/feed.js:212` | client DELETE | Match. |
| Get single post | Working | `GET /api/posts/:id` `routes/spa/feed.js:204` | — | Match. |
| Like / unlike | Working | `routes/spa/feed.js:222` | client like | Match. |
| Polls | Working | create/`vote` `routes/spa/feed.js:254`; `=ANY($1::bigint[])` at `:30,:36` | — | Match. |
| Comment (list/add) | Working | `GET`/`POST /api/posts/comments` `routes/spa/feed.js:274,292` | client comments | Match. |
| Reply to comment | Working | Same POST accepts `parent_id` (comment tree) `routes/spa/feed.js:292` | — | Match. |
| Delete comment | Working | `DELETE /api/posts/comments/:id` `routes/spa/feed.js:317` | client | Match. |
| Share | Working | `routes/spa/feed.js:333` | client share | Match. |
| Save post (bookmark) | Working | `routes/spa/feed.js:359` writes `saved_items`, `COALESCE(p.media->0,to_jsonb(...))` | client save | Match (this is the **live** save table; `platform.js` `saved_posts` is the dead twin — §C). |
| Engagement counts | Partially working | Feed/list SELECT returns like/comment counts `routes/spa/feed.js:70-112` | bundle renders counts | Counts render for feed posts; **share counts** are not separately surfaced — **unverified inference** beyond what the list query projects. |

---

## 4. Discover & global search

| Capability | Status | Evidence (backend) | Evidence (UI) | Notes |
|---|---|---|---|---|
| Discover page | Working | `GET /api/posts` (hashtag/feed) `routes/spa/feed.js`; trending via `/api/meta/trends` returns `[]` `routes/meta.js` | `/discover` | Trends endpoint returns an **empty array stub** → discover trending is effectively **Missing** even though page works. |
| Hashtag filter | Working | `unnest` hashtags `routes/spa/feed.js:83`; ILIKE `routes/network.js:72-78` | client | Postgres-only constructs flagged for hand-port (`audit-report.md` §B). |
| Global search (people+posts+listings+jobs) | Working | `GET /api/search` `routes/spa/social.js:152-221` | `/search`; client `/api/search` | Match. Legacy `platform.js` `GET /search` `:2699-2778` is **dead** (shadowed) — §C. |
| Search suggestions | Working | `routes/spa/social.js:82-137` (`unnest` `:94`) | client | Match. |

---

## 5. Network — connections, follows, blocks

| Capability | Status | Evidence (backend) | Evidence (UI) | Notes |
|---|---|---|---|---|
| People suggestions | Working | `GET /api/network/suggestions` `routes/network.js:81-104`; ILIKE `:72-78` | `/network` | Only route in `network.js`. |
| Connections list / requests / connect | Working | `routes/spa/social.js` `network/*` `:230-464` | `/network` client | Match. |
| Follow / unfollow | Working | `routes/spa/social.js` network follows `:230-464` | client | Match. |
| Block / unblock | Working | `routes/spa/social.js` network blocks `:230-464` | client | Match. |
| My-network overview (progress) | Working | `GET /api/users/me/progress` `routes/spa/social.js:468-582` (`generate_series` `:530-537`) | `/progress` | Match; hand-port site. |

`routes/platform.js` also implements `/connections`, `/follows`, `/blocks` (`:568-966`) — **legacy/dead**
(superseded by `spa/social.js` via mount order; zero bundle references). See `audit-report.md` §C.

---

## 6. Profiles

| Capability | Status | Evidence (backend) | Evidence (UI) | Notes |
|---|---|---|---|---|
| Avatar / profile photo | Working | `POST /api/onboarding/avatar` `routes/onboarding.js`; `middleware/upload.js:8` avatar 6MB | `/onboarding`, `/profile/edit` | Match. |
| Cover photo | Working | cover kind 12MB `middleware/upload.js:8-14` | client | Match. |
| Bio / headline | Working | `PATCH /api/users/me/profile` whitelist `PROFILE_COLUMNS` `routes/spa/social.js:611-622` | `/profile/edit`; client PATCH | Match **only for whitelisted columns**. |
| Skills | Working | add `routes/onboarding.js:172-183` (INSERT…RETURNING inside tx — hand-port); read via DTO `services/userDto.js` | `/profile/edit` | Match; RETURNING-in-tx needs data-modifying CTE. |
| Public profile view | Working | `GET /api/users/:username` `routes/spa/social.js:723-776` | `/profile/:username` | Match. |
| Experience | **Partially working / Broken write** | DTO **reads** `experiences` `services/userDto.js:51-68`; **write not accepted** by `PATCH /api/users/me/profile` (not in `PROFILE_COLUMNS`). Writes only exist on legacy `platform.js` experience routes `:363-463` (dead). | `EditProfilePage` collects experience but only sends `updateProfile`→`/api/users/me/profile` | **Broken:** UI edits experience, backend PATCH silently drops it; legacy write endpoints are not mounted-reachable by the SPA. |
| Education | **Partially working** | DTO **reads** `education` `services/userDto.js:51-68`; not in PATCH whitelist; legacy `platform.js` `:465-562` dead | `EditProfilePage` collects education | Same drop-on-write pattern as experience. |
| Portfolio | **Missing (write) / stub (read)** | `services/userDto.js:115-116` returns `portfolio: []` **hardcoded**; no live write path | `EditProfilePage` collects portfolio | Data captured in UI but never persisted or returned. |
| Certifications | **Missing (write) / stub (read)** | `services/userDto.js:115-116` `certifications: []` **hardcoded**; not in PATCH whitelist | `EditProfilePage` collects certifications | Same as portfolio. |

---

## 7. Marketplace

| Capability | Status | Evidence (backend) | Evidence (UI) | Notes |
|---|---|---|---|---|
| Category list | Working | `routes/spa/market.js:41-70`; `/api/meta/categories` `routes/meta.js` | `/marketplace` | Match. |
| Home / listings | Working | `routes/spa/market.js` home + `listings` (sort `NULLS LAST` `:126`, nearby `DESC NULLS LAST` `:58`) | `/marketplace` | Match; hand-port sites. |
| Search & filter | Working | listings filters `routes/spa/market.js` | client | Match. |
| Price | Working | listings carry price column `routes/spa/market.js` | client | Match. |
| Images | Working | `POST /api/listings/:id/images` `routes/spa/market.js`; save coalesce `feed.js:359` | upload | Match. |
| Detail view (+ view count) | Working | `GET /api/listings/:id` increments views `routes/spa/market.js` | `/marketplace/:id` | Match. |
| Related listings | Working | `:id/related` `routes/spa/market.js` | client | Match. |
| Create / edit / delete (ownership) | Working | POST/PATCH/DELETE `routes/spa/market.js:~200-344`; ownership via `company_members` | `/create-listing` | Match. |
| Availability | Working | `PATCH` availability field `routes/spa/market.js` | client | Match. |
| Favorite / save | Working | `routes/spa/market.js` favorite; `saved_items` via `routes/spa/market.js:683-724` | `/saved` | Match. |
| Contact seller via messaging | Working | `sendMessage` carries `shared_listing_id` `routes/spa/chat.js` | `/marketplace/:id` → message | Match. |
| **Report listing** | **Broken** | No `POST /api/reports` reachable for listing reports. Reports table exists and is **admin-read only** `routes/admin.js:320-377`. | `ListingPage` "Report listing" `onSubmit` = **toast only, no API call** (bundle) | UI collects the report but never transmits it; backend has no public report endpoint. |
| Moderate listing (report action) | Working (admin) | `routes/admin.js:320-377` `requireAdmin` | `/admin` (guarded) | Admin side exists; the intake (user report) does not. |

---

## 8. Jobs & companies

| Capability | Status | Evidence (backend) | Evidence (UI) | Notes |
|---|---|---|---|---|
| Company profiles | Working | `routes/spa/market.js` `businesses` CRUD + `:slug` `:414-677` | `/business/:slug` | Match. |
| Employer permissions | Working | `company_members` ownership checks `routes/spa/market.js` | client | Match. |
| Job (opportunity) list + search/filter | Working | `GET /api/opportunities` `routes/spa/market.js:360-411` | `/opportunities` | Match. |
| Create / edit job | Working | `routes/spa/market.js` business job endpoints `:414-677` | `/business/:slug`, employer UI | Match. |
| Apply | Working | `POST /api/opportunities/:id/apply` `routes/spa/market.js:360-411` | client apply | Match. |
| Applicant status tracking | Partially working | apply returns status; PATCH of applicant status lives on **legacy** `platform.js` `applications` `:1715-2074` (dead) | No bundle call for status PATCH found | Employer-side status transition not wired to a live SPA endpoint → **unverified inference** for employer tracking UI. |
| Close / reopen job | Requires a decision or external configuration | No explicit close/reopen on live `spa/market.js`; only legacy `platform.js` job PUT/PATCH `:1715-2074` (dead) | not in bundle | Feature exists only in the dead legacy surface; needs decision to re-implement on the SPA router. |
| Job notifications | Working | `notify()` → `notifications` `services/spaKit.js`; applied on job/listing events | `/notifications` | Match. |
| Company analytics | Working | `routes/spa/market.js` analytics (`generate_series` `:550-557`) | employer UI | Hand-port site. |
| Company reviews | Working | `routes/spa/market.js` reviews `:414-677` | `/business/:slug` | Match. |

---

## 9. Groups & events

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Groups | **Missing** | No `groups` table in `migrations/*.sql` (49-table census); no route; no bundle route | Entirely absent. |
| Events | **Missing** | No `events` table; no route; no bundle route | Entirely absent. |

---

## 10. Saved items

| Capability | Status | Evidence (backend) | Evidence (UI) | Notes |
|---|---|---|---|---|
| Saved posts / listings | Working | `saved_items`; posts `routes/spa/feed.js:359`; listings/collections `routes/spa/market.js:683-724` | `/saved`; client GET | Match. |
| Saved collections | Working | `routes/spa/market.js` collections `:683-724` | `/saved` | Match. |

---

## 11. Messaging & notifications

| Capability | Status | Evidence (backend) | Evidence (UI) | Notes |
|---|---|---|---|---|
| Conversations list | Working | `GET /api/conversations` `routes/spa/chat.js:60-` ('epoch' `:55`) | `/messages` | Hand-port site (`'epoch'`). |
| Conversation detail | Working | `GET /api/conversations/:id` `routes/spa/chat.js` | `/messages/:id` | Match. |
| Send message | Working | `POST /api/conversations/:id/messages` `routes/spa/chat.js` (`unnest` `:123`; conversations DEFAULT VALUES `:118`) | client | Hand-port site (`unnest`). |
| Mark read | Working | `.../messages/:id/read` `routes/spa/chat.js` | client | Match. |
| Reactions | Working | `.../messages/:id/reaction` `routes/spa/chat.js` | client | Match. |
| Search messages | Working | `routes/spa/chat.js` message search | client | Match. |
| Message attachments | Working | `POST .../upload` `routes/spa/chat.js`; message kind 12MB `middleware/upload.js` | upload | Match. |
| Notifications list | Working | `GET /api/notifications` `routes/spa/social.js:29-78` | `/notifications` | Match. |
| Unread count | Working | `.../unread-count` `routes/spa/social.js:29-78` | client | Match. |
| Mark all read / mark read | Working | `POST .../read-all`, `PATCH .../:id/read` `routes/spa/social.js:29-78` | client | Match. Legacy `platform.js` `PATCH` read `:2619-2693` dead. |

---

## 12. Videos

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Video feed / tabs / playback / recommendation / discovery / moderation | **Missing** | **Zero** `videos` references in any `routes/**`; no `videos` table; **no `/videos` route and no `"videos"` string in the shipped bundle** | The API contract is being drafted separately at `docs/videos-api-contract.md` (do not touch). Nothing is built yet. |

---

## 13. Subscriptions & monetization

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| "Upgrade Now" / plans | **Missing** | No `subscriptions`/`plans` table; no route; **no `"Upgrade Now"` or subscription string in the bundle** | Absent end-to-end. |
| Entitlement enforcement | **Missing** | No middleware checks plan entitlement (`middleware/authenticate.js` checks `status='active'` only, `:70-72`) | Absent. |
| Billing history / transactions | **Broken** (stubbed) | `GET /api/admin/transactions` returns `[]` — **no payments schema** `routes/admin.js:383-385` | Admin UI would show an empty table; not a real ledger. |
| Revenue reporting | **Broken** (stubbed) | `routes/admin.js:160-202` stats returns `revenue: 0` hardcoded | Cosmetic only. |

---

## 14. Admin / staff

| Capability | Status | Evidence (backend) | Evidence (UI) | Notes |
|---|---|---|---|---|
| Role gating (staff/admin) | Working | `middleware/security.js` `requireStaff:21-27`, `requireAdmin:29-35`; applied `routes/admin.js:13-14` | `/admin` guarded | Match. |
| User list / detail | Working | `GET /api/admin/users`, `/security-events`, `/audit-logs` `routes/admin.js` | AdminPage | Match. |
| Promote / change role | Working | `PATCH /api/admin/users/:id/role` `requireAdmin` `routes/admin.js:51-126` | AdminPage | Match. |
| Suspend / block / verify / badge | Working | `POST /api/admin/users/:id/action` `USER_ACTIONS` + revoke sessions + mail `routes/admin.js:430-527` | AdminPage | Match. |
| Revoke sessions | Working | inside `users/:id/action` `routes/admin.js:430-527`; per-user `routes/spa/chat.js:630-640` | AdminPage, `/settings` | Match. |
| Business verify | Working | `routes/admin.js:204-272` | AdminPage | `verified`/`verified_badge` columns exist in code; **migration `010_verified_badge` is NOT in the mirror** (server-only) → see `audit-report.md` §B/§C. |
| Listings / posts moderation | Working | `routes/admin.js:274-316` | AdminPage | Match. |
| Reports queue | Working (read) | `routes/admin.js:320-377` — intake missing (see §7). | AdminPage | |
| Transactions / tickets / ads | Partially working | `/transactions` returns `[]` `:383-385`; `/tickets` reads `support_tickets`+`support_messages` `:387-412`; `/ads` reads `ad_campaigns` `:414-424` | AdminPage | Read tables exist (schema) but their **write** endpoints are missing (§16, §17). |
| Ops routes (`/api/admin/ops`) | Requires a decision or external configuration | `routes/spa/ops.js`: `/status` (`information_schema` tableCounts `:99-100`), `/audit`, delete/role, content PUT, categories, data/purge, **`/migrations/run`** reads `.sql` from disk `:375-412` (`MIGRATIONS_DIR=__dirname` `:32`) | not in bundle | Gated by admin+`OPS_OWNER_ID`+optional `x-ops-token` `:67-83`. The **migration runner is filesystem-dependent and cannot run on a Worker** → owner decision (handoff §6). |

---

## 15. Assistant / AI

| Capability | Status | Evidence (backend) | Evidence (UI) | Notes |
|---|---|---|---|---|
| AI conversations / messages / suggestions | **Broken** | `ai_conversations` / `ai_messages` tables exist (schema) but **no route reads/writes them**; no `/api/ai/*` handler in any router | `AssistantPage` calls `/api/ai/conversations`, `/api/ai/messages`, `/api/ai/suggestions` (bundle) → falls through `/api` mount to 404 catch-all `server.js:160-162` | **UI calls something not there.** Schema present, endpoint absent. |

---

## 16. Tasks & progress

| Capability | Status | Evidence (backend) | Evidence (UI) | Notes |
|---|---|---|---|---|
| Tasks CRUD + toggle | Working | `routes/spa/chat.js:360-473` | `/tasks` client | Match (mis-homed under chat router). |
| Progress dashboard | Working | `GET /api/users/me/progress` `routes/spa/social.js:468-582` (`generate_series`) | `/progress` | Hand-port site. |
| Goals | Working | `routes/spa/social.js:584-607` | client | Match. |
| Onboarding wizard | Working | `POST /api/onboarding/avatar`, `PUT /api/onboarding` `routes/onboarding.js` (BEGIN/COMMIT `:137/:140/:205/:209`; skills RETURNING-in-tx `:172-183`; follows unnest `:191`) | `/onboarding` | Match; transaction + RETURNING sites need hand-port. |

---

## 17. Advertising

| Capability | Status | Evidence (backend) | Evidence (UI) | Notes |
|---|---|---|---|---|
| Campaign create/manage | **Broken** | `ad_campaigns` table exists (schema); only **admin-read** `routes/admin.js:414-424`. No `/api/ads/*` write endpoint. | `AdvertisingPage` calls `/api/ads/campaigns` (bundle) → 404 catch-all `server.js:160-162` | **UI calls something not there.** |
| Ad inventory / delivery | **Missing** | No delivery/serving logic anywhere | — | Absent. |

---

## 18. Support / help

| Capability | Status | Evidence (backend) | Evidence (UI) | Notes |
|---|---|---|---|---|
| Ticket create / list / reply | **Broken** | `support_tickets`+`support_messages` tables exist (schema); only **admin-read** `routes/admin.js:387-412`. No public `/api/support/*` endpoint. | `SupportPage` calls `/api/support/tickets`, `/api/support/availability`, `/api/support/:id`, `/api/support/:id/reply` (bundle) → 404 catch-all `server.js:160-162` | **UI calls something not there.** |
| `/support` category list | Working | bundled static categories in `SupportPage` (billing etc.) | `/support` | The only part that works is the static help surface. |

---

## 19. Settings

| Capability | Status | Evidence (backend) | Evidence (UI) | Notes |
|---|---|---|---|---|
| User settings get/set | Working | `GET/PATCH /api/users/me/settings` `routes/spa/chat.js:496-571` (jsonb merge `data \|\| EXCLUDED.data` `:565-571`) | `/settings` | Hand-port: jsonb merge → `json_patch`. |
| Session list / revoke | Working | `routes/spa/chat.js:630-640` | `/settings` | Match. |
| Change password | Working | `routes/spa/chat.js:603-628` | `/settings` | Match. |

---

## 20. PWA / offline

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Service worker | Working | `dist/sw.js` present in served SPA root | Offline shell for the Cloudflare-hosted frontend only; **no API-side offline**. |
| Manifest | Working | `dist/manifest.webmanifest` present | Match. |

---

## 21. Monitoring / health

| Capability | Status | Evidence (backend) | Notes |
|---|---|---|---|
| `/health` | Working | `server.js:112-119` — honest DB probe (`health()` throws on unreachable) | Reports `database:"connected"` truthfully. |
| `/health/full` | **Partially working (cosmetic lie)** | `server.js:121-128` — returns `redis:"connected"` **unconditionally**, and `redis.js` is never called by any route | The redis field is **always false-positive**; see `audit-report.md` risk register. |

---

## Summary counts (indicative)

- **Fully Working:** auth core, sessions/JWT/refresh, email verify+reset, lockout, all three rate limiters,
  routing, home feed, posts (create/media/delete/like/poll/comment/reply/share/save), discover+search,
  network connections/follows/blocks, profile photo/bio/headline/skills/public-view, marketplace core,
  jobs (list/create/apply/notifications/analytics/reviews), saved, messaging+notifications, tasks/goals/progress,
  settings, onboarding, admin gating/user-mgmt/verify/moderate, PWA, `/health`.
- **Broken / disconnected UI→missing backend:** post edit, experience & education write, listing report,
  AI assistant, advertising, support tickets, transactions/revenue (stubs), `/health/full` redis field.
- **Missing entirely:** groups, events, videos (all), subscriptions/plans/entitlement, portfolio &
  certifications persistence, job close/reopen (live surface), ad delivery.
- **Requires decision / external config:** email-less account recovery, `/admin` route path, admin ops
  migration runner, job applicant status PATCH surface.
