# Route-level differential report (task #20)

Harness: `cf-api/tools/diff-routes.mjs` + helpers `cf-api/tools/diff-support.mjs`.
Run: `node cf-api/tools/diff-routes.mjs` (`--list` prints the enumerated surface, `--only=<regex>` narrows it).
Exits non-zero on any DEFECT or BLOCKER.

Oracle = production `https://api.proffessionalist.com` (Express 5 → nginx → Cloudflare), **read-only**.
Subject = the ported Worker at `http://127.0.0.1:8803` (`wrangler dev`, local DO counters, real
`professionalist-db-v2` D1, real `professionalist-media` R2). `/health` was up and returned
`{"status":"healthy","api":"online","database":"connected"}` before every run.

Production was touched with GET/HEAD/OPTIONS only, never with credentials, never a login attempt:
**152 of 250** allowed production requests per run (149 path probes + OPTIONS + 2 GET + 1 upload GET).

## 1. Endpoint surface (enumerated from `cf-api/port/**`, not guesswork)

Grep of `router.get|post|put|patch|delete(` across the ported route files, prefixed by the mount
order transcribed in `cf-api/src/api.js`:

| number | meaning |
|---|---|
| **196** | raw router definitions found in source (matches §3 census of the mirror) |
| **185** | unique reachable `METHOD path` endpoints (11 platform routes are shadowed by the spa router mounted ahead of them — `/posts/:id`, `/posts`, `/posts/:id/like|save|share|comments`, `/notifications`, `/notifications/:id/read`, `/search`) |
| **149** | unique paths → the production GET-probe count |

Grouping (the +3 app-level public GETs and the `/uploads` static handler come from `api.js`, not the routers):

| group | endpoints | what it is |
|---|---|---|
| public | 8 | `GET /`, `/health`, `/health/full`, `/uploads/*`, and `/api/meta/{countries,categories,trends,content}` |
| anonymous-guarded | 8 | `/api/auth/{register,login,refresh}` + the 5 `/api/auth/*` mail routes (authLimiter, no session) |
| authenticated | 153 | bearer-guarded `/api/...` (spa + platform + network) and `/api/onboarding` |
| admin-ops | 31 | `/api/admin/*` (staff/admin) and `/api/admin/ops/*` (requireOps) |

`/api/*` mounting detail: `app.use("/api", authenticate, userLimiter, …)`, so **every** unmatched or
unauthenticated `/api/...` path — including `/api/auth/login` reached by GET — answers the same
401 `unauthorized` envelope rather than 404. That made a uniform, stateless, credential-free
production probe possible for the whole authenticated surface (Phase A).

## 2. Phase A — production differential (status + exact body + header set)

For each unique path one GET against both stacks. Data-independent bodies (the 401/404 envelopes and
the static `/api/meta` payloads) compared byte-for-byte; data-bearing anonymous GETs compared on
content; header **name-sets** compared with duplicate counts.

- **148 / 149 paths fully clean** — identical status, identical body, matching header set.
- **1 content-differs → DEFECT**: `/api/meta/content` (see §4).

### Phase A.2 — preflight, rate-limit format, one real object
- `OPTIONS /api/meta/countries`: both `204` with identical `Access-Control-Allow-Methods`. ✅
- `RateLimit` + `RateLimit-Policy` present on both stacks; the **format matches exactly**, including
  the `pk=:…:` partition: `"3000-in-15min"; q=3000; w=900; pk=:…:` on both (`r=`/`t=` differ only as
  live counters). ✅
- Real `/uploads` object (`avatars/16-….jpg`): both `200`, both `content-type: image/jpeg`;
  `ETag` differs as documented **ENVIRONMENTAL** (`send`'s weak `W/"size-mtime"` vs R2's md5). ✅

## 3. Phase B — Worker-only authenticated surface (blocked by config)

- Mail failure cannot hang the run: register returned in ~1.4s and the background drain did not block. ✅
- `POST /api/auth/verify-email` bogus token → `400` with a proper `invalid_token` envelope; real
  token (a self-chosen plaintext whose SHA-256 was inserted into `email_verification_tokens`, then
  POSTed) → `204` and `users.email_verified_at` became set. ✅
- `POST /api/auth/login` with ~100 wrong credentials on a TEST-NET IP tripped the auth bucket **on
  the Worker only** (0 production calls) → `429` envelope `{code:"rate_limited",
  message:"Too many attempts. Please try again in a few minutes."}` + `Retry-After` +
  `RateLimit-Policy "100-in-15min"; …; pk=:…:` — matches the documented production shape. ✅
- **BLOCKED**: `/me`, the 56-path authenticated GET sweep, all writes (profile/avatar/post/message)
  and refresh/logout could not run — see §5. The admin-ops 403 boundary was therefore not reachable
  either (it needs a session to get past `authenticate` before `requireStaff`/`requireOps`).

## 4. DEFECT — `/api/meta/content` (adapter loses non-scalar bound parameters)

```
prod(200): {"maintenance":{"enabled":false,"message":""},"announcement":null,"landing":{"hero":"","note":""}}
work(200): {"maintenance":{"enabled":false},"announcement":null,"landing":null}
```
The Worker output is byte-identical to `CONTENT_DEFAULTS` in `port/routes/meta.js:25`, i.e. the
`SELECT … WHERE key = ANY($1::text[])` returned **zero rows** and the route's `catch` fired. This is
not ordering and not environmental: the D1 table provably holds the same three rows the oracle shows
(verified with `d1Read("SELECT key,value FROM app_content")`).

Root cause (proved, not theorised):
- `port/routes/meta.js:29` passes a JS **array** as a parameter through `db.query()`.
- `cf-api/src/db.js:67` (the single-statement path) does `stmt.bind(...t.params)` with the **raw**
  translated parameters, while the transaction path binds `compat.encodeParams(...)`
  (`cf-api/src/db.js:102`, pushed encoded at `cf-api/src/db.js:118`). `encodeParam`
  (`cf-api/src/pg-compat.js:510`) is the step that turns a JS array/object into the JSON *text* that
  `json_each(?)` requires; without it D1 receives a non-scalar bind.
- A/B proof against the live D1 via the Cloudflare query API (the `count-rows.mjs` HTTP pattern):
  - param = `JSON.stringify(["maintenance","announcement","landing"])` → 3 rows (what production sees),
  - param = the raw array, or its `String()` comma-join → `{ok:false,"malformed JSON: SQLITE_ERROR"}`
    → which is exactly what makes the route fall back to defaults.

Impact: any `db.query()` (non-transactional) call site that binds a `text[]`/`bigint[]` array, a
`Date`, a boolean-as-object, or a jsonb object is mis-bound on the Worker. Candidate sites (found by
grep, **not each individually exercised** here because auth is blocked): `routes/meta.js` (proven),
plus array/`ANY`/`::text[]`/`new Date` parameters in `routes/admin.js`, `routes/onboarding.js`,
`routes/spa/chat.js`, `routes/spa/feed.js`, `routes/spa/ops.js`, `routes/spa/social.js`. The
transactional path (`routes/onboarding.js:135`, `routes/spa/ops.js:393`) is unaffected because it
encodes. Suggested fix (owned by the caller, not this harness): encode in `db.js:67` the way the
batch path does.

## 5. BLOCKER — token issuance 500s (running env lacks `JWT_SECRET`)

`POST /api/auth/register` returns `500 {"error":"Registration failed"}` and mints **no**
`auth_sessions` row, although the `users`, `profiles` and `security_events` rows all land. `POST
/api/auth/login` with the correct password likewise returns `500 {"error":"Login failed"}` with no
session row. The failure is therefore in the shared tail, `createSession`
(`port/routes/auth.js:36`), reached only after the user lookup/insert succeeds.

`createSession` calls `issueToken` → `jwt.sign(payload, process.env.JWT_SECRET, …)`
(`port/routes/auth.js:24-30`) → `src/shims/jwt.js:100` `createHmac("sha256", secret)`, which throws
`TypeError: The "key" argument must be of type ...` when `secret` is `undefined`. Evidence chain:
- The shim logic is sound: local sign/verify round-trips; an empty-string key signs without throwing;
  only an `undefined` key throws. The INSERT into `auth_sessions` itself succeeds against D1 for both
  numeric and stringified `user_id` (FK is fine). So the throw is `issueToken`, not the write.
- `JWT_SECRET` is expected on `process.env` via `api.js`'s `ENV_HANDOFF`/`exportVars`
  (`src/api.js:69`, `src/api.js:88-92`) from the Worker `env` binding.
- It is **not** present in the running dev environment: there is no `.dev.vars`, and `wrangler.toml`
  `[vars]` defines only `CORS_ORIGIN` and `IP_RATE_LIMIT`. So `env.JWT_SECRET` is unset and the
  Worker 500s on every sign.

Classification: **deployment/config gap, not a port-code defect** — the operator owns the wrangler
secret. It is the reason the entire authenticated surface (§3) is unverifiable against this running
Worker. Once `JWT_SECRET` is bound, Phase B's bearer sweep, writes, refresh and logout checks become
executable and the admin-ops 403 boundary becomes reachable.

## 6. Differences classified ENVIRONMENTAL (verified to stay the only ones of their kind)
- `/uploads` real object `ETag` (and `Last-Modified`): R2 md5 + upload date vs `send`'s
  `W/"{sizeHex}-{mtimeHex}"` + file mtime. Status and `content-type` match.
- `cache-control: max-age=14400` on a production 404: Cloudflare edge error-page caching, absent on
  the Worker's app-level 404. On real 200 upload objects **both** stacks set the app's own
  `public, max-age=604800, immutable`, so this is not masking a missing application header.
- `RateLimit` `r=` (remaining) and `t=` (reset) counters, and the `pk=:…:` value (derived from the
  per-visitor key): differ by design; the policy **format** matches.
- Cloudflare/node transport headers `age cf-cache-status cf-ray via alt-svc server-timing nel
  report-to set-cookie date connection server`: production-only and env-allowed by the harness
  allowlist; the Worker never emits an unexpected header the oracle lacks (`workerHdrOnly` was empty
  on every probe).

## 7. Skipped (with reason)
- **All authenticated GETs, writes (profile/avatar/post/message) and refresh/logout** — blocked by §5
  (no bearer token obtainable in this env).
- **Any POST/PUT/PATCH/DELETE against production** — forbidden by rule 1 (read-only; a failed login
  would write `failed_login_attempts` / could lock a real account).
- **Real admin-ops data reads** (`/api/admin/*`, `/api/admin/ops/*`) — need a staff/admin session
  (§5) and, for ops, `OPS_OWNER_ID`/`OPS_TOKEN`; forging a role in D1 is out of scope for a
  read-only-on-production differential. Only the guard boundary was targeted (unreachable this run).
- **`/uploads` byte-level comparison** — binary; only `content-type` compared, `ETag`/`Last-Modified`
  are ENVIRONMENTAL.
- **Password-reset end-to-end** — stopped at the mail call (mailer outbound fails by design; the run
  proved it does not hang).

## 8. Stability and cleanup
Two consecutive full runs were byte-identical modulo inherently-varying values (live `r=`/`t=`
counters, `pk=:…:`, `Retry-After`, the unique throwaway email/user id, the `…ms` register timing).
Every row the harness created was deleted: `users`, `profiles`, `profile_skills`, `auth_sessions`,
`security_events` (the ~100 `login_failed` rows are removed by a run-scoped
`user_id IS NULL AND created_at >` window so copied rows are never touched), `audit_logs`,
`notifications`, `email_verification_tokens`, `password_reset_tokens`, plus any created `posts` /
`conversations` / `messages`. Final D1 census: **7 users (baseline), 0 rows with `id`/`user_id >= 36`**
in every probe table. Nothing was left in R2 (the avatar upload step did not run while auth was
blocked, so no orphan object exists). No production system, VPS, or wrangler resource was mutated.
