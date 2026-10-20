# Cloudflare migration — handoff state

Last updated: 2026-10-13 (kept current by the agent working in this repo — see "Document maintenance" at the end)

Read this whole file before touching anything. It states the goal, the rules, what is already
done and verified, what is broken right now, and the exact next step.

---

## 1. The mandate (from the user, verbatim)

> "lets move everything from authentication to object storage to d1 but we dont want to break
> anything and the users should not notice it using opnly cloudflare resources we want to leave
> theserver alone"

So: **auth, relational data and object storage all move onto Cloudflare (D1 + R2 + KV + Workers).
Zero regressions, zero user-visible change, and the VPS is left running and untouched as the
rollback path.**

Same user, earlier in this work stream (already delivered): the SPA is served from Cloudflare,
not the VPS. That part is finished and live.

### Decisions the user explicitly approved (do not re-litigate)

| Question | Chosen answer |
|---|---|
| How to port the backend | **Compatibility-layer port** — keep the existing Express route logic and its SQL; add a pg→D1 adapter, an Express→Request shim and an R2 uploader. Not a clean Worker rewrite. |
| Sessions across the cutover | **Reuse the same `JWT_SECRET`** so HS256 tokens already issued by the VPS keep verifying in the Worker. Nobody is signed out. |
| VPS inspection | **One read-only pass** approved and completed (SELECT / pg_dump / du / md5sum only). Another SSH pass needs fresh approval in the conversation. |

### Success criteria

1. `https://api.proffessionalist.com/...` keeps the same URL, routes, status codes and JSON shapes.
2. `/uploads/...` media URLs keep working (frontend does `API_BASE_URL + url` — see
   `src/services/http.ts:203 mediaUrl()`), served now from R2 through the Worker.
3. Users stay logged in through the flip.
4. VPS still runs; flipping the hostname back is instant rollback.

---

## 2. Safety rules (hard, from the user)

- Never print, echo or commit: the SSH key `C:\Users\Admin\.qoder\ssh-key-2026-09-24.key`, the
  Cloudflare **account id**, the **zone id**, the **Cloudflare API token**, the **R2 access/secret
  keys**, or `JWT_SECRET`.
  Tools read them from disk and print only lengths/labels. One accidental leak happened this
  session from a `sed` on a token file with no `=` in it — do not repeat that; never print that file.
- Cloudflare token lives at `C:\Users\Admin\.cf_token_tmp` (raw token, single line, no `KEY=`).
  In the Linux codespace the same raw-token convention is used at `~/.cf_token_tmp`, and the id
  files at `~/.qoder/tmp/d1move/{acct.txt,d1-id.txt}` (all mode 600, all outside the repo).
  **Gotcha that will otherwise look like a dead token:** the current token is an *account-scoped*
  `cfat_` token. `GET /user/tokens/verify` returns `401 code 1000 "Invalid API Token"` for it even
  when access is fine; verify against `/accounts/{id}` instead, which returns 200.
  **Redaction gap fixed 2026-10-19:** every tool's error redactor matched only the old `cfut_`
  prefix, so a `cfat_` token could have been printed verbatim inside an API error body. All five
  now use `hideSecrets()` in `cf-api/tools/paths.mjs`, which strips `cf(at|ut)_[A-Za-z0-9]+`,
  32-hex account ids, dashed uuids, and the literal contents of the token/acct files (32-hex runs
  *before* the uuid rule, or the uuid alternation eats the first 8 hex chars of the account id).
- Local id files created by these tools (do not print their contents):
  `C:\Users\Admin\.qoder\tmp\d1move\acct.txt`, `...\d1-id.txt`.
- SSH user is `opc`, never root. ≤10 SSH calls per task. Each production change must be **one
  self-verifying script** with a rollback branch. Ask before any new SSH pass.
- Destructive DB work (drops, truncates, deletes) needs explicit approval. Creating our own new
  D1/R2/KV resources and applying our schema is in scope and approved by the mandate.
- Load credentials in shell with `set -a; . ./file; set +a`; never put them on a command line.
- **This Cloudflare account hosts unrelated production Workers.** Before any `wrangler deploy`,
  `secret put` or `rollback`, list `GET /accounts/{id}/workers/scripts` and confirm the target name
  belongs to this project (`proffessionalist-web`, `professionalist-api`, …). On 2026-10-12 a
  deploy under an already-taken name overwrote another project's live shared secret; Worker
  versions snapshot secrets, so `wrangler rollback <version-id> --name <worker> -y` repairs it.

---

## 3. Where the app runs today (verified)

- **Frontend**: React 19 + Vite 7 SPA, served by Cloudflare Workers **assets-only** Worker
  `proffessionalist-web`, bound to `proffessionalist.com` + `www` via Workers custom hostnames
  (`PUT /accounts/{A}/workers/domains` — this works without Zone:DNS:Edit, which the token lacks).
  Deploy recipe and gotchas: project memory `frontend-hosting-cloudflare.md`.
  - Dead ends already proven: Pages new-project deploys return empty HTTP 500; `*.workers.dev`
    does not serve on this account; `wrangler deploy` times out on asset upload (plain Node fetch
    with retries works).
- **Backend**: VPS `140.245.50.236`, domain `api.proffessionalist.com`, nginx(:80) →
  `127.0.0.1:5000` Express 5 (`professionalist-api.service`), Postgres 16.15 + Redis 7 in Docker.
  Details in project memory `vps-backend-topology.md`. The VPS is now API-only (web root removed).
- **Local mirror of the backend** (byte-identical to live for all shared files, verified by md5):
  `C:\Users\Admin\.qoder\tmp\spa-fix\app` — 25 JS files, `db.js`, `redis.js`, `server.js`,
  `middleware/{authenticate,upload}.js`, `routes/*` (auth, admin, meta, onboarding, platform,
  network, spa/{chat,feed,market,ops,social,index}), `services/*`.
  Parity report: live 35 files, local 29, identical 28, different 0, 7 server-only migrations,
  1 local-only migration (`010_verified_badge.sql`).
  **2026-10-19: the mirror is no longer missing.** With the SSH key supplied, it was pulled
  read-only from the VPS (`opc@140.245.50.236`, app at `/home/opc/professionalist/app`, discovered
  from `systemctl cat professionalist-api.service` → `WorkingDirectory`) with `rsync -az` into
  **`/workspaces/app-mirror/app`** — the second candidate in `paths.mjs`, so every tool finds it with
  no arguments. 40 files / 354 KB, **25 `.js` files exactly as §3 counts them**, excluding
  `node_modules/`, `.env`, `uploads/`, `*.key`, `*.pem`, `*.log`. Scanned back: the only
  secret-looking strings are `process.env.JWT_SECRET` / `process.env.DB_PASSWORD` *references*, no
  values. `test-pg.mjs --ladder` on this corpus reproduces the §6 table line for line (285 SQL
  strings, 285 translated, 0 translate throws, 3 shape failures — all three the known hand-port
  sites — 0 data failures), which is the evidence that this is the same tree the numbers were taken
  from. Redis is still not required: no route uses it (`redis.js` is only `connectRedis()` at boot).
  - **Security incident worth recording:** the uploaded private key landed *inside* the project
    directory as `professionalist/ssh-key-2026-09-24.key`, world-readable (mode 666), in a directory
    git reports as entirely untracked (`?? professionalist/`) — precisely the "a broad `git add -A`
    commits it" case §8 warns about. It was moved to `~/.ssh/professionalist-vps.key` (mode 600) and
    the repo copy deleted; the `.pub` was removed too. Never place a key under the repo path again.
  - SSH budget (§2, ≤10 calls/task): 3 used, all read-only (`systemctl cat` + `ls`, a file listing,
    the `rsync` pull). No production file was modified, no service restarted.
  What is **still** absent here is the SPA's `src/`: the repo checkout carries `index.html`,
  `vite.config.ts`, `tsconfig.json` and the built `dist/`, but no TypeScript sources — so anything
  that edits the frontend (the master prompt's redesign phases) still needs that tree copied in.
  The backend corpus is no longer a blocker: `cf-api/tools/paths.mjs` resolves the mirror at
  `$APP_MIRROR_DIR`, then `/workspaces/app-mirror/app` (present), then the Windows path.
- **Account capability**: paid Workers plan (`free_tier:false`, 500 scripts, 64MB, multiscript),
  16 D1 databases, 15 R2 buckets, 7 KV namespaces already exist.
  Re-measured read-only on 2026-10-19 from the codespace (`node cf-api/tools/cloudflare-audit.mjs`):
  **66 Worker scripts, 19 D1 databases, 17 R2 buckets, 7 KV namespaces, 5 Queues, 10 Pages
  projects, 22 Worker custom hostnames spread over at least 8 unrelated zones**
  (alphaandomegacollege.org, asrtsystems.com/.dev, alphafees.com, asrtsales.work, alptok.com,
  proffessionalist.com, …). The plan tier itself was not re-measured. §2's warning is understated:
  `email.proffessionalist.com` is bound to a **foreign** script (`proffessionalist-email`) inside
  our own zone, so zone-level operations here can damage an unrelated production service.

### Backend surface that must be reproduced

- `pool.query(text, params)` is the only DB API used — 385 call sites, 943 `$n` placeholders.
- `pool.connect()` transactions: exactly 2 — `routes/onboarding.js:137`, `routes/spa/ops.js:393`.
- `middleware/authenticate.js`: Bearer HS256 JWT + `auth_sessions` row lookup on
  `token_hash = sha256(token)`, `revoked_at IS NULL`, `expires_at > NOW()`; envelope via `deny()`.
- `middleware/upload.js`: multer diskStorage → `{UPLOAD_ROOT}/{kind}/{owner}-{hex}.{ext}`,
  kinds avatar 6MB / cover,post,listing,message 12MB, MIME allowlist, `removeStored(url)`,
  `publicUrl()` = `/uploads/{dir}/{file}`.
- `server.js`: helmet, cors (`CORS_ORIGIN`), 3 express-rate-limit limiters — ip 3000/15m,
  user 400/60s keyed `u:{sub}`, auth 100/15m skipSuccessfulRequests — all with a JSON 429 envelope.
- bcryptjs cost **12** (auth.js:109,183; chat.js:612,615) — pure JS, runs in a Worker.
- Redis client exists but is **unused** by the routes → no migration needed; rate limits go to KV.
- Messaging is polling (`setInterval`), no SSE/WebSocket to preserve.
- **Route-shape census (2026-10-19, from the mirror — this is what makes a shim rather than a
  rewrite viable):** 8,772 lines, 25 `.js` files, 196 route definitions. Every path is a literal or
  `:param` segments — **no regex, no wildcards, no optional or repeated markers** — so matching is
  segment equality. The API actually touched is: `res.json` ×188, `res.status` ×175, `req.body` ×149,
  `req.params` ×93, `req.query` ×86, `req.user` ×44, `req.ip` ×10, `req.get` ×10, `req.file` ×8,
  `req.files` ×2, `req.originalUrl`/`method`/`headers`/`socket` ×1-3 each, `router.use` ×9,
  `app.use` ×14, one `res.setHeader`, one `res.setEncoding`. `next()` is **never** called with an
  argument anywhere in `routes/`, `middleware/` or `services/`, so `next(err)`/`next('route')`
  semantics do not have to be emulated. The `res.on`/`req.on`/`req.destroy` hits are **`services/mailer.js`
  making an outbound Node `https` request** — that file needs a `fetch()` port, it is not a router issue.
  `express.static` appears once, for `/uploads`, which the Worker serves from R2 instead.
  Deps to replace: `express`(shim), `multer`(→`request.formData()`+R2), `jsonwebtoken`(→WebCrypto HS256),
  `express-rate-limit`(→KV), `helmet`/`cors`(→header functions), `pg`(→`cf-api/src/db.js`),
  `dotenv`/`redis`(→Worker vars + nothing), `bcryptjs`+`uuid` keep working under `nodejs_compat`.

### Data volume (from the read-only pass, `.../d1move/inventory2.txt`)

49 tables, 385 columns, 11 MB DB, ~500 rows total. Biggest: security_events 100, auth_sessions 62
(28 currently active), notifications 55, audit_logs 40, messages 33, search_history 30,
profile_skills 27, skills 27, listing_categories 14, posts 9, users 6, profiles 6, conversations 5.
Users: 4 active, 2 deactivated. Media on disk: the read-only `du` here first estimated **39 files, 26,790,974 bytes** in
`/home/opc/professionalist/app/uploads`; the tree actually pulled from the VPS is **67 files / 92,394,392 bytes** (avatars 7 / posts 42 / covers 5 / listings 8 / messages 5), all now
in R2 `professionalist-media` (§5.7). No cron, no background writers → a short quiet window is enough for cutover.

---

## 4. Target topology

```
proffessionalist.com, www.   ->  Worker "proffessionalist-web"  (assets only, SPA)  [DONE]
api.proffessionalist.com     ->  Worker "professionalist-api"   (Express-shim routes)
                                  ├─ D1  professionalist-db-v2  (all relational data; see §5.4)
                                  ├─ R2  professionalist-media  (67 files / 92,394,392 bytes, same /uploads keys)
                                  └─ KV  professionalist-limits (rate limiting)
VPS                          ->  left running, nginx still proxying :5000 = instant rollback
```

---

## 5. Done and verified

### 5.1 D1 schema generated from the live PostgreSQL DDL  (task #17 complete)

- `cf-api/compat/live-schema.sql` — the real `pg_dump --schema-only` from the VPS (2,946 lines).
- `cf-api/tools/pg-to-sqlite.mjs` — converts it. Run `node cf-api/tools/pg-to-sqlite.mjs`.
  Emits `cf-api/compat/schema.sql` + `cf-api/compat/columns.json` (the codec map the adapter uses).
  Mapping: timestamptz/date/jsonb/uuid/inet/text[] → TEXT, numeric/double → REAL, boolean/bigint/
  integer → INTEGER, `nextval` → `INTEGER PRIMARY KEY AUTOINCREMENT` **only** when the column really
  had a sequence default (29 of 49 PKs; the other 20 are uuid/composite/supplied keys such as
  `profiles.user_id`), `now()` → `DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  `gen_random_uuid()` → a uuid-generating DDL `DEFAULT` (4 tables: auth_sessions, conversations,
  email_verification_tokens, password_reset_tokens — see §6 "Resolved"),
  `CHECK (c = ANY(ARRAY[...]))` → `CHECK (c IN (...))`,
  FK/UNIQUE/CHECK hoisted inline, `USING btree` / `COLLATE "C"` / `varchar_pattern_ops` /
  `DESC NULLS LAST` stripped from index defs, 3 partial indexes kept (SQLite supports them),
  view `conn_edges` ported.
- `cf-api/tools/validate-schema.mjs` — applies it to node:sqlite: **0 failed statements,
  49/49 tables, 0 column-set mismatches, 49 indexes, 13 inline UNIQUE, view selects OK, all
  semantics probes pass** (ISO default, ts lexical compare, case-insensitive LIKE, json, upsert,
  view-over-seeded-data). It now also extracts every `DEFAULT (…randomblob…)` expression straight
  out of the applied DDL, checks it against `columns.json` (`default === "uuid"` ⇒ 4 expected),
  evaluates it twice and requires RFC-4122-v4 shape **and** distinctness:
  `uuid self-generating columns: 4 / expected 4`, `probe failures: 0`.
- Object parity vs the dump, 1:1: 49 indexes, 13 ADD CONSTRAINT UNIQUE, 62 FK, 49 PK, 19 CHECK.
- **D1 database `professionalist-db-v2` holds the current schema**
  (`node cf-api/tools/apply-schema.mjs`, re-check with `--verify`):
  `objects: index=80, table=50, view=1` (50 = our 49 + `sqlite_sequence`),
  `named indexes: 49`, `column-set diffs: 0`, view `conn_edges` present, and the 4 uuid `DEFAULT`s
  are confirmed in its `sqlite_master` text.

### 5.4 Two D1 databases exist — which one is live

`professionalist-db` (created 2026-10-12, **the old schema without the uuid defaults**) was verified
empty before switching: `node cf-api/tools/count-rows.mjs` → `tables in the live database: 50`,
`rows: 0 across 50 tables`, `non-empty tables: (none)`. Rather than drop/recreate those tables
(destructive DB work needs the user's approval) we created `professionalist-db-v2` with
`node cf-api/tools/create-db.mjs professionalist-db-v2`, which also re-points the tools:
`.../d1move/d1-id.txt` now holds the v2 id and the previous id is saved at `d1-id.previous.txt`.
`cf-api/wrangler.toml` sets `database_name = "professionalist-db-v2"` and keeps
`database_id = "placeholder"` **on purpose** — substitute the id from `d1-id.txt` at deploy time and
do not print or commit it. The old empty `professionalist-db` is left untouched; deleting it is the
user's call.

### 5.5 Remote state and deploy preflight, re-measured 2026-10-19 (codespace, read-only)

`node cf-api/tools/apply-schema.mjs --verify` and `node cf-api/tools/count-rows.mjs` against the
**live remote** `professionalist-db-v2` reproduce §5.1 exactly: `objects: index=80, table=50,
view=1`, `named indexes: 49`, `column-set diffs: 0`, view `conn_edges` present, `sqlite_sequence`
the only extra table. `count-rows` reports **`rows: 0 across 50 tables`, non-empty: (none)** — so
the schema is landed and the D1 holds **no user data at all**: every real record still exists only
on the VPS until #22 runs. That is the single most important thing to know before touching traffic.
**Superseded later the same day: #22 has run.** `count-rows` now reports `rows: 634 across 50 tables`,
which is **49 app tables / 619 rows** once the 15-row `sqlite_sequence` system table (the 50th table)
is excluded — the production data is in `professionalist-db-v2`. See §5.7 and §7.

§2 preflight (`node cf-api/tools/cloudflare-audit.mjs`): `proffessionalist-web` **EXISTS** (it is
the live SPA, bound to `proffessionalist.com` + `www`) — deploying under that name replaces
production; `professionalist-api` is **free to create**; 65 other scripts on the account are
foreign. `professionalist-media` (R2) and `professionalist-limits` (KV) **do not exist yet**.
Tooling gotcha worth remembering: `GET /accounts/{A}/workers/scripts` puts the script **name in the
`id` field**, not `name` — trusting `name` makes every script look unnamed, which is how an earlier
draft of the preflight reported the live SPA script as *absent*. The audit now decides existence
with a direct `GET /workers/scripts/{name}` (404 = free, 200/204 = taken) and cross-checks the list.
`/r2/bucket` is not a route (`10015`); the list endpoint is **`/r2/buckets`**, returning
`{buckets:[…]}`. Queues use `queue_name`, KV uses `title`.

### 5.6 Adapter and hand-ports executed against the live D1 — 2026-10-19 (`verify-live.mjs`, 25/25)

Everything in §5.2 and §6 was previously proven only on local `node:sqlite`. `node
cf-api/tools/verify-live.mjs` now runs **real Postgres statements through the real adapter** and
executes the translated SQL on `professionalist-db-v2`: **25 checks passed, 0 failed**, with the
database left exactly as found (final census 0 rows in all 49 app tables, no probe DDL, and the
burned `sqlite_sequence` offsets cleared afterwards — AUTOINCREMENT counters keep the ids probes used
even after the rows are deleted). Proven remotely, not by analogy:

- adapter constructs: `$n`+`?` reorder, `COUNT(*)::int`, `date_trunc('week')` (and `%w`=1 confirms it
  is genuinely a Monday), `to_char('YYYY-MM')`, `= ANY($1::bigint[])` → `json_each`, `media->0`,
  `ILIKE`+`NULLS LAST`, and `NOW() + ($3 * INTERVAL '1 second')` with `RETURNING` on `auth_sessions`.
- **all 5 §6 hand-port replacements run and return Postgres-correct values on D1**: the 12-month
  recursive CTE replacing `generate_series` (`admin.js:146`), 8 ISO week-Mondays replacing the series
  in `market.js:552`/`social.js:532`, `information_schema` → `sqlite_master` + `json_each`
  (`ops.js:99`), and `json_patch` on `user_settings.data` keeping **both** keys — the naive `||`
  port was executed too and demonstrably produces the concatenated garbage `{"a":1}{"b":2}`, which is
  why that site needs the hand-port.
- `DELETE … = ANY($1::bigint[]) RETURNING` reports `meta.changes` and the deleted rows.
- SELECT-sourced `ON CONFLICT DO NOTHING` → `INSERT OR IGNORE` executes; the §5.2 caveat is now
  **measured**: `INSERT OR IGNORE` swallowed a `CHECK (follower_id <> following_id)` violation with
  `changes=0` while the plain `INSERT` raised `CHECK constraint failed` — so OR IGNORE really is
  broader than `DO NOTHING` and hides real bugs on those three sites.
- decode parity: `int8` id arrives as a **string**, `timestamptz` as a **Date**, and `verified` as a
  real JS boolean from stored 0/1; `sqlite_sequence` repair after an explicit-id insert moves `MAX(id)`
  → next id, which is what #22's cutover depends on.

**Batch atomicity (`d1-batch-probe.mjs`) — the assumption `db.js`'s `pool.connect()` design rests on:**
`POST /query` and `POST /query_batch` both accept `{batch:[{sql,params},…]}`; **`POST /batch` is not a
route** (`404 Route not found`). A batch executes *every* statement and returns **one result object per
statement**, the same shape as `env.DB.batch()`. With a positive control (a two-insert batch commits
both rows) the failure case reads: batch `[good insert, UNIQUE-violating insert]` → HTTP 400
`UNIQUE constraint failed: users.username`, and the earlier write is **gone** — so a D1 batch is
**atomic** and buffered writes can be committed as one batch, as §6 plans.

Two of those three tools found their own bugs on the way, both worth remembering because they were
*false passes*, not crashes: the atomicity check first called `/batch`, caught the 404 as a thrown
error, counted 0 surviving rows and reported "rolled back" — the batch had simply never run. And a
`follows (follower_id,following_id) VALUES (?,?,?)` probe was rejected as `3 values for 2 columns`
(`created_at` carries a DDL default). Anything that measures a remote engine must assert the request
was accepted, and must state *why* a statement failed (`UNIQUE constraint failed`) rather than
accepting any error as the expected one.

### 5.2 D1 capability facts, measured not assumed (`cf-api/tools/d1-probe.mjs`, `d1-probe2.mjs`)

Supported: `RETURNING` on insert/update/delete, `ON CONFLICT ... DO UPDATE/NOTHING`,
`INSERT OR IGNORE`, `FILTER (WHERE ...)`, `json_extract` / `->` / `->>` / `json_array_length` /
`json_each` / `json_group_array`, CTEs + recursive CTEs, `GLOB`, `LIMIT ? OFFSET ?`, group_concat,
EXISTS, UNION ALL, FK enforcement **is on**, `strftime` parses our `...Z` ISO text, and a column
`DEFAULT` can **generate an RFC-4122 v4 uuid** from `randomblob`/`random` (probe:
`cf-api/tools/d1-uuid-probe.mjs` → 2/2 well-formed, 2/2 distinct, `INSERT … DEFAULT VALUES RETURNING id`
works, so `randomblob` is *not* blocked the way pragma functions are). These exact date_trunc
equivalents also produce Postgres-correct values:

| pg | D1 (verified) |
|---|---|
| `date_trunc('day', x)` | `strftime('%Y-%m-%dT00:00:00.000Z', x)` |
| `date_trunc('month', x)` | `strftime('%Y-%m-01T00:00:00.000Z', x)` |
| `date_trunc('week', x)` | `strftime('%Y-%m-%dT00:00:00.000Z', x, 'weekday 0', '-6 days')` → Monday |
| `NOW() + ($n * INTERVAL '1 second')` | `strftime('%Y-%m-%dT%H:%M:%fZ','now', $n \|\| ' seconds')` |
| `NOW() - INTERVAL '7 days'` | `strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')` |

Blocked / different — design around these:
- **`ON CONFLICT` is only legal after a `VALUES` list, never after a `SELECT` source** (measured on
  node:sqlite: `INSERT … SELECT … ON CONFLICT (a,b) DO NOTHING` → `near "DO": syntax error`, while
  every `VALUES`-sourced upsert form parses, `INSERT OR IGNORE … SELECT` parses, and a CTE-sourced
  insert does not help). Consequence: the adapter converts SELECT-sourced `DO NOTHING` into
  `INSERT OR IGNORE`, which is *broader* — it also swallows non-target constraint failures.
- `sqlite_version()` and **pragma table functions over the HTTP query API** → `SQLITE_AUTH`.
  (Worker binding may differ; verify before relying on it. HTTP API also rejects multi-statement
  scripts with params: params work only with a single statement.)
- The HTTP query API refuses a compound `SELECT` with too many terms: 20 `UNION ALL` arms →
  `code 7500 too many terms in compound SELECT`; 4 is fine. `count-rows.mjs` chunks accordingly.
- `BEGIN` / `COMMIT` / `ROLLBACK` are not part of the documented Workers binding; the atomic unit is
  `env.DB.batch([...])` ("Batched statements are SQL transactions", developer.cloudflare.com/d1/worker-api/d1-database/),
  and `withSession()` gives sequential consistency (`prepare`/`batch`/`getBookmark`), not isolation.
  **The atomicity of that unit is now measured on the live database, including over the REST batch
  (`{batch:[…]}` on `/query`) — see §5.6.**
- Booleans: D1 accepts a JS `true` param and stores the **string** `"true"` → the codec must turn
  booleans into 0/1 before binding. Date params bind as ISO-Z text. `undefined` binds as NULL.
- `json('https://x')` → "malformed JSON". `to_jsonb(text)` must become **`json_quote(...)`**.
- SQLite `LIKE` is ASCII case-insensitive while pg `LIKE` is case-sensitive. Checked: every plain
  `LIKE` in the app is `LOWER(col) LIKE <lowercased pattern>` (30 sites, listed by
  `grep -rn "LIKE " app`), so there is **no behavioural drift**. `ILIKE` → `LIKE` is safe.

### 5.3 Files created for this work stream

```
cf-api/package.json                 {"type":"commonjs"}  (repo root is "type":"module")
cf-api/wrangler.toml                Worker professionalist-api + D1 binding DB (database_id placeholder)
cf-api/compat/live-schema.sql       pg_dump of the real DB
cf-api/compat/schema.sql            generated D1 DDL          <- applied to professionalist-db-v2
cf-api/compat/columns.json          table -> [{name,pg,kind,notNull,default,pk}]
cf-api/tools/pg-to-sqlite.mjs       DDL converter
cf-api/tools/validate-schema.mjs    applies schema.sql to node:sqlite + semantics probes
cf-api/tools/apply-schema.mjs       creates/verifies remote D1 (--dry, --verify)
cf-api/tools/create-db.mjs          create a D1 + re-point the tools' id file (prints names only)
cf-api/tools/cloudflare-audit.mjs   READ-ONLY §2 preflight + account inventory + writes d1-id.txt
cf-api/tools/count-rows.mjs         read-only row census of the live D1 (proves before a rebuild)
cf-api/tools/d1-uuid-probe.mjs      can D1 generate uuids in a column DEFAULT? (yes, verified)
cf-api/tools/d1-probe.mjs           40 SQL-capability probes against real D1
cf-api/tools/d1-probe2.mjs          20 probes: time formats, codecs, binding rules
cf-api/tools/sql-census.mjs         every pg-ism in the app, counted + sampled
cf-api/tools/fn-census.mjs          every function the SQL calls that this SQLite lacks (--translated)
cf-api/tools/test-pg.mjs            replays ALL app SQL through the translator onto real schema
cf-api/tools/verify-live.mjs        runs the adapter + every hand-port against the LIVE D1 (seeds, cleans)
cf-api/tools/d1-batch-probe.mjs     which endpoint takes a batch, and is a batch atomic (measured)
cf-api/src/db.js                    WRITTEN 2026-10-19 — the pg-Pool stand-in on D1 (§6), 25/25 in test-db
cf-api/tools/test-db.mjs            verifies db.js against a stand-in D1 binding over the real schema
cf-api/src/pg-compat.js             the pg -> D1 translation layer (WIP, see §6)
cf-api/src/background.js            ctx.waitUntil queue — keeps mailer's post-answer work alive in a Worker
cf-api/src/shims/express.js         Express subset on Fetch (Router/app/req/res + entity headers), 39/39 in test-express
cf-api/tools/test-express.mjs       mounting order + res.send ETag/304/HEAD semantics vs real express 5 (raw node:http)
cf-api/src/shims/jwt.js             jsonwebtoken 9.0.3 HS256 subset on node:crypto, kept sync, 29/29 in test-jwt
cf-api/tools/test-jwt.mjs           differential vs jsonwebtoken 9.0.3, both directions (VPS token <-> Worker)
cf-api/src/shims/limit.js           express-rate-limit v8 counted by a Durable Object (see §6 DEVIATION), 24/24 in test-limit
cf-api/tools/test-limit.mjs         differential vs express 5 + express-rate-limit 8 over real sockets
cf-api/src/shims/upload.js          multer 2 + express.static/send on R2 (keys, codes, byte ranges), 52/52 in test-upload
cf-api/tools/test-upload.mjs        differential vs the mirror's middleware/upload.js driving real multer + express.static
cf-api/src/shims/helmet.js          helmet 8.3.0 default header set + the four nginx-added headers (NO test file yet)
cf-api/src/shims/cors.js            cors (2.8.x) for server.js's exact options object (NO test file yet)
cf-api/src/shims/https.js           node:https.request port on fetch() so services/mailer.js runs unedited
cf-api/tools/oracle.mjs             finds the real npm packages the differential tests import (§6 tooling note)
cf-api/tools/paths.mjs              resolves token / D1-id / app-mirror paths on Windows and Linux
cf-api/src/worker.js                NOT CREATED — wrangler.toml declares it as `main`, binds only D1 (§6 "Resume here")
cf-api/src/api.js                   NOT CREATED — the lazy-require boot shim that populates process.env first (§6)
cf-api/src/shims/counters DO class  NOT CREATED — limit.js needs env.RATE_COUNTERS; no R2/DO binding declared yet
cf-api/port/ + tools/build.mjs      NOT CREATED — generator that repoints the routes' requires onto these shims (§6)
```

### 5.7 2026-10-19: the Worker runs end to end

**Assembly.** `tools/build.mjs` generates `cf-api/port/` mirror-shaped, and its own report is the
evidence: `files copied: 22, proxies written: 2, manifest entries: 10`, smoke-load `loaded 30`, `_shim`
files `express.js, https.js, jwt.js, redis.js, uuid.js`, and `checks: no fs require survives, no bare
specifier survives, every port file loads`. 22 copies + the 2 proxies (`db.js`, `middleware/upload.js`)
+ `server.js` (excluded — its mounts are the hand transcription in `src/api.js`) = the 25 `.js` files of
§3's census. Only `require`/hand-port lines changed, and the per-file count proves it: every
route/service reads `rewrite 1 handport 0` except `routes/auth.js` (`rewrite 3` — express, jsonwebtoken,
uuid), `routes/onboarding.js` (`rewrite 1 handport 6`) and `routes/spa/ops.js` (`rewrite 1 handport 12`).
`src/api.js` transcribes the mirror `server.js` in its verbatim mount order (helmet, cors, body parsers,
the three limiters, the public routes, `/uploads`, then auth→admin→meta→onboarding→`/api`, then the 404
and error middleware); `src/worker.js` is a thin entry — `fetch()` → `api.handle()` plus the `RateLimiter`
Durable Object that gives `shims/limit.js` a place to count (the `env.RATE_COUNTERS` binding that §5.3's
"NOT CREATED" line still shows as absent is now declared in `cf-api/wrangler.toml`).

**Harness results, re-run today** (`node cf-api/tools/test-*.mjs`): `test-express.mjs` **39/39**,
`test-jwt.mjs` **29/29**, `test-limit.mjs` **24/24**, `test-upload.mjs` **52/52**, `test-db.mjs` **25/25**,
and the new `test-worker.mjs` **73/73** — it asserts the wiring a unit test cannot: the DO class/name pair
(`RATE_COUNTERS` ↔ `RateLimiter`), the deliberate placeholder D1 id kept with the `v2` database name,
every `[vars]` name is one the ported files actually read and none of them is a secret, no `[triggers]`,
and `worker.js` is still the entry the config names with `nodejs_compat` on.

**Media in R2.** The tree pulled from the VPS is `/workspaces/vps-uploads/uploads`: **67 files /
92,394,392 bytes** (avatars 7 / posts 42 / covers 5 / listings 8 / messages 5) — superseding §3's 39 /
26.8 MB read-only estimate. All 67 are in bucket `professionalist-media` with their stored content-types:
`node cf-api/tools/backfill-r2.mjs --verify` reads the bucket back and reports `list: bucket keys=67
(expected 67), bytes=92394392 (expected 92394392)`, `verify problems: 0`, and `VERDICT: all 67 keys
present, sizes match … every stored content-type matches, sampled bytes identical`. `--dry-run` lists the
plan and signs nothing; the writer is idempotent (a HeadObject first, PUT only when size or stored type
differs — never a delete).

**Data in D1.** `professionalist-db-v2` now holds the production rows: **49 app tables / 619 rows**,
primary keys preserved verbatim, `sqlite_sequence` repaired after the explicit-id inserts
(`tools/copy-data.mjs`). `tools/count-rows.mjs` proves it: `rows: 634 across 50 tables`, where the 50th
table is the 15-row `sqlite_sequence` system table (634 − 15 = **619**) and 28 app tables carry rows
(`sqlite_sequence` is the 29th entry in `count-rows`' non-empty list). The
load is FK-ordered — topological on the FK graph, parents first, plus intra-table ordering for the two
self-referential columns — because `PRAGMA foreign_keys=OFF` is **ignored over the D1 HTTP API** (a child
insert with a missing parent still fails `SQLITE_CONSTRAINT_FOREIGNKEY`; `copy-data.mjs:14-23`).
Lossy-by-design type decisions, inherited from the §5.1 DDL mapping: `numeric`→REAL, `jsonb`/`text[]`→
TEXT (stored as the JSON/array text the codec parses back), microsecond fractions truncated to
milliseconds, and every timestamp normalised to `…Z` ISO (`toIsoZ`, `copy-data.mjs:186-195`).

**Four measured workerd facts, each with what it broke:**
- **esbuild's CJS wrapper defines no `__dirname`/`__filename`.** A module-scope read of them threw
  `ReferenceError` on the first request and took the whole `/api` tree down — `routes/onboarding.js:10`
  (`UPLOAD_ROOT = path.join(__dirname, …)`) and `routes/spa/ops.js:32` (`MIGRATIONS_DIR`). `build.mjs` now
  asserts no `__dirname`/`__filename` survives (`build.mjs:481-483`) and its hand ports drop/replace both
  sites. The Node smoke-load cannot catch this because **Node does define them** — only the bundle fails.
- **A function's `name` is configurable but not writable, and esbuild adds `"use strict"`.**
  `shims/limit.js`'s former `middleware.name = …` threw `TypeError: Cannot assign to read only property`
  on the first `rateLimit()` call, so **every request answered 500**; it is now
  `Object.defineProperty(middleware, "name", …)` (`shims/limit.js:252-256`).
- **`wrangler dev --remote` refuses to give a Worker a Durable Object at all.** Because `shims/limit.js`
  deliberately lets a request through when the counter is unreachable (`shims/limit.js:218-222`), the
  symptom was not an error but that **both `RateLimit` headers vanished**. The dev config
  (`tools/runtime-config.mjs --dev`, `runtime-config.mjs:120-131`) therefore keeps the DO **local** and
  reads D1/R2 **remotely** (`remote = true` on the `[[d1_databases]]`/`[[r2_buckets]]` blocks only) —
  local counters are exactly what a parity run must not fake.
- **`shims/cors.js` returned an arity-2 middleware that called a `next()` it was never given** (now the
  arity-3 `(req, res, next)` form, `next()` on a non-preflight — `shims/cors.js:41,59`), and
  `express.json`'s parse failure **reworded** the SyntaxError instead of forwarding it: production answers
  body-parser's own message (measured live — `Expected ':' after property name in JSON at position 9`), so
  `src/shims/express.js:403-408` now forwards `e.message` verbatim with `code: "entity.parse.failed"`.

### 5.8 2026-10-20: `professionalist-api` is DEPLOYED as a preview Worker, and it answers like the VPS

**Two more measured facts, then the evidence.**

- **`cors@2.8.5` sets `Access-Control-Allow-Methods` / `-Headers` / `-Max-Age` on a preflight and on
  nothing else.** The shim had `if (preflight || echo)`, on the strength of a comment claiming the
  nginx layer added them to ordinary allowed-origin requests. It does not: running the real package
  against `server.js`'s exact options object (allowed origin GET → `Allow-Origin`, `Vary`,
  `Allow-Credentials` only; OPTIONS → all three extras, even for an origin off the list and for no
  `Origin` at all) and reading the live API agree. `shims/cors.js` now gates on `preflight` alone and
  `test-worker.mjs` asserts the absence on a GET and the presence on the OPTIONS (**74 checks** now).
  This was the last substantive difference the header comparison found.
- **This account refuses new key-value Durable Object namespaces.** The first deploy failed with Cloudflare
  API code **10099**, "Creating new key-value backed Durable Object namespaces is no longer supported on
  this account. Please create a namespace using a `new_sqlite_classes` migration instead." The fix is
  config-only — `[[migrations]] tag = "v1" / new_sqlite_classes = ["RateLimiter"]` — because
  `src/worker.js` touches nothing but `state.storage.get/put("buckets", snapshot)`, which the
  SQLite-backed class serves identically. Local `wrangler dev` never showed this: it builds the namespace
  itself. **A DO class is therefore only proven by an actual deploy.**
- Related tooling fact: `GET /accounts/{id}/workers/scripts/{name}` returns the **multipart script
  bundle**, not JSON, so `deploy.mjs`'s confirmation step read `/settings` (flat `[{type,name,…}]`) and
  now says so instead of dying on `JSON.parse`.

**Deploy.** `node cf-api/tools/runtime-config.mjs && node cf-api/tools/deploy.mjs --preview` →
`https://professionalist-api.geraldmariba.workers.dev`. §2 preflight ran first (`66 Worker scripts on
this account; professionalist-api is free to create`), the GENERATED config was deployed (never the
committed one, whose `database_id` stays `"placeholder"`), and secrets went after the upload via
`wrangler secret put` piped from `dev.vars` on stdin. `/settings` on the deployed script reads back:
`DB`(d1), `MEDIA`(r2_bucket), `RATE_COUNTERS`(durable_object_namespace, class `RateLimiter`),
plain vars `CORS_ORIGIN, IP_RATE_LIMIT, MAILER_API_URL, MAILER_ENABLED`, secrets
`JWT_SECRET, MAILER_API_TOKEN, OPS_OWNER_ID`, **`routes: (none)`** — no custom hostname points here.
`--preview` forces `--var MAILER_ENABLED:false`, because a public workers.dev address must not be able
to make the account's own mailer deliver a password-reset to a real member's inbox; **re-deploy without
the flag at the hostname flip** (`services/mailer.js:18` turns itself off without changing any response
body, so the preview is otherwise behaviourally identical).

**Verification (`node cf-api/tools/verify-preview.mjs <worker-url> avatars/10-30a033da679031c3.jpg`) —
0 differences, against live `api.proffessionalist.com` from the same process:** `GET /`, `/health`,
`/health/full`, a 404 envelope, the 401 envelope with and without an allowlisted `Origin`, a preflight
OPTIONS, an unmatched `/api` path — every status equal and **every JSON body byte-identical** — plus
the 437299-byte avatar answering the same `content-type/length/cache-control/accept-ranges/CORP`, and
`Range: bytes=0-99` returning `206` with the *same 100 bytes* on both stacks. Only ETag/Last-Modified
and the two `RateLimit` counters differ, and those are asserted by *shape*: the ETag because R2's md5 is
not `send`'s size-mtime, the counters because they carry a live countdown and a `pk=:…:` hash of the
client address the two stacks legitimately see differently. The tool's own first run found three bugs in
the tool (edge headers `connection`/`server-timing` compared as app headers, a `pk` regex that could
never match, and a `Range` header passed in the wrong argument slot so neither stack saw one) — all
fixed here; its assertions are now things the platform actually does.

**Not done, deliberately:** no hostname, no DNS, no cutover, and the VPS still serves 100 % of traffic as
instant rollback. Binding `api.proffessionalist.com` needs the user's explicit go-ahead, and immediately
before it a quiet-window `copy-data.mjs` re-run to pick up rows written since 2026-10-19. `tools/verify-live.mjs`
is superseded (its safety gate insists on an empty D1, which is no longer true).

**One security item for the user:** the Cloudflare API token in `~/.cf_token_tmp` is a single bare line
with no `=`, so an early `set -a; . ~/.cf_token_tmp` **echoed the token itself** into the transcript.
Everything since has been loaded with `export CLOUDFLARE_API_TOKEN=$(cat …)` and every command's output
redacted through `paths.mjs`'s `hideSecrets`. **That token should be rotated.**

---

## 6. In flight right now — task #18, the pg→D1 adapter

**2026-10-19, later — `cf-api/src/db.js` is written and verified, #18 is nearly closed.** It exports
exactly the §6 surface (`init(env)`, `query`, `pool:{query,connect}`, `health`, plus `notes`) and is
measured by `node cf-api/tools/test-db.mjs`: **25 checks, 0 failures**, against a stand-in D1 binding
built on `node:sqlite` + the real `compat/schema.sql`, reproducing the *measured* binding shapes
(`prepare(sql).bind(…).all() -> {results, meta:{changes,last_row_id}}`, `batch()` as one atomic
unit, FK enforcement on). Covered: pg result shape (`rows/rowCount/command`), `$2`-before-`$1`
reorder, int8→string / timestamptz→Date / bool→boolean parity, `rowCount` from `meta.changes`,
deferred writes then a real 2-statement `COMMIT`, `ROLLBACK` and `release()` dropping the buffer,
batch-level abort on a mid-transaction failure, the verbatim `onboarding.js:141` upsert deferring
without tripping the guard, and the guard itself firing for `RETURNING`-inside-a-transaction.
Three findings from writing it:
- **D1 rejects by throwing, so the pg SQLSTATE mapping has to sit on the rejection path.** The first
  version only mapped a `success:false` return — a path a Worker never takes — and every constraint
  error reached routes as a bare SQLite message with `code=ERR_SQLITE_ERROR`. Routes that branch on
  `err.code === "23505"` (duplicate email/username) would have silently turned 409s into 500s.
  `db.js` now wraps both the single-statement and the `COMMIT`/batch calls.
- `health()` must **throw** when the database is unreachable, not return false: `server.js:112-128`
  answers 503 from a `catch`, so a falsy return would have reported `database: "connected"` while
  the D1 was down.
- `routes/onboarding.js:137-200` confirms §6's read of it — and its `INSERT INTO skills … RETURNING id`
  at :165-172 really is the read-your-write that the buffered design cannot serve, so it needs the
  data-modifying-CTE port listed below before that route can go in a Worker.

Remaining in #18: the 5 hand-port edits to app files (§6 table — now each *proven* on live D1, §5.6,
but still to be written into the ported copies), and `spa/ops.js:393`'s migration-file question,
which needs the user's decision (see #20).

**2026-10-19, Linux codespace.** The gate could not be run there: the backend mirror of §3 is not
present, so there is no corpus. What *was* reproduced on that machine, end to end: regenerating
`compat/schema.sql` + `columns.json` from `compat/live-schema.sql` and applying it to `node:sqlite`
matches §5.1 exactly — 0 failed statements, 49/49 tables, 0 column-set mismatches, 49 indexes,
13 inline UNIQUE, view `conn_edges` OK, `uuid self-generating columns: 4 / expected 4`,
`probe failures: 0`. Translator fidelity was checked against a synthetic corpus and behaves as
documented: `date_trunc('week')` → Monday-start `strftime`, `to_char('YYYY-MM')` → `%Y-%m`,
`= ANY($1::bigint[])` → `IN (SELECT value FROM json_each(?))`, `->0` → `json_extract(col,'$[0]')`,
`NOW() - INTERVAL '7 days'` → ISO `strftime`, and the two known hand-port constructs correctly
stay untranslated (`generate_series`, `information_schema`). Nothing on Cloudflare was touched:
no D1 created or modified (an exploratory `create-db professionalist-db-v3` aborted at the
credential read, before any API call), no Worker deployed, no hostname changed.

**Later the same day, that "not yet verified remotely" gap is closed — §5.6.** Accuracy note for the
paragraph above: after it was written, `verify-live.mjs` and `d1-batch-probe.mjs` *did* write to
`professionalist-db-v2` — probe rows only, into a database `count-rows` had just proven empty, each
deleted by the exact `WHERE` that inserted it, with a final census (0 rows / 49 tables), a
`sqlite_master` diff (no probe DDL) and a `sqlite_sequence` clear afterwards. `api.proffessionalist.com`
still serves the VPS, no Worker was deployed, no hostname or DNS was changed, and no R2/KV resource
was created.

`node cf-api/tools/test-pg.mjs --ladder` is the authority. Current run (2026-10-13, after the uuid
DDL defaults landed):

```
files: 25, sql strings: 285, translated: 285, executable: 260, ran: 254,
template fragments skipped: 3, translate throws: 0
SHAPE FAILURES: 3 statements in 2 classes   <- all three are hand-port sites, not adapter bugs
DATA FAILURES (survived every rung of the param ladder): 0
resolved by the param ladder (bind noise): 2  (CHECK follower_id <> following_id, 2 statements)
leftover postgres-isms: interval 2, generate_series 2, information_schema 1
```

`interval 2` is the same two statements as `generate_series 2` — the third `generate_series` argument
(`INTERVAL '1 week'` as a step) is a bare literal with no operand to attach it to, so it is left
for the hand port rather than guessed at.

The three translator bugs diagnosed in the previous draft are **fixed**: the `::type` pattern no
longer eats the following keyword, `FILTER (…)`/`OVER (…)` stay attached to their aggregate, and the
literal-consuming rules run on the whole string in the right pipeline stage.

### How `cf-api/src/pg-compat.js` works now (read this before editing it)

`translateSql(text, params)` runs, in order:
1. `rewritePlaceholders` — `$n` → `?`, and returns the params **reordered by occurrence**, which is
   what the D1 binding must receive.
2. casts — `mapSql` (SQL regions only) → `rewriteCasts`. Unknown types are dropped with a note;
   lossless ones (`::text`, `::jsonb`, `::uuid`) vanish; `::int/::bigint` → `CAST(… AS INTEGER)`,
   `::numeric` → `REAL`, `::timestamptz` → `TEXT`. `operandBefore()` finds the operand and walks
   past `FILTER (…)` / `OVER (…)` so an aggregate's cast wraps the whole aggregate.
3. **`foldCalls(sql, FUNCTIONS)`** — postgres function calls are parsed, not regexed. A regex
   cannot express "argument list, possibly containing calls, with the unit inside quotes", which is
   exactly why the previous draft silently left `date_trunc('week', x)` and
   `to_char(d, 'YYYY-MM-DD')` untouched. `literalShield()` marks characters inside quotes so a call
   that only exists in user data is never folded. Handlers: `left/right`→`substr`,
   `greatest/least`→`max/min`, `to_char`→`strftime`, `date_trunc`→`strftime` (week = Monday),
   `extract(epoch|year|month|day|hour|minute|second|dow|doy)`→`strftime`,
   `array_agg/json_agg`→`json_group_array`, `to_jsonb/to_json`→`json_quote`,
   `json[b]_build_object`→`json_object`. A handler returning `null` leaves the call alone but still
   folds its arguments. `node cf-api/tools/fn-census.mjs` measures the gap: the backend calls 10
   functions this engine lacks, and after translation only `generate_series` remains (the other
   reported names are artifacts: `json_each` is a table function, `by` and `d` are keywords/aliases).
4. `rewriteTime` — `'epoch'`, `n * INTERVAL '1 unit'`, then `<operand> ± INTERVAL 'n unit'`, where
   the operand comes from `operandBefore()` again. This matters: the previous version swept a
   permissive character class for the left operand, which could start mid-token and swallow the
   keywords between it and `INTERVAL`, producing **unbalanced parentheses** — that is what silently
   hid the two `generate_series` statements from validation.
5. `rewriteSets` — `= ANY(…)` → `IN (SELECT value FROM json_each(…))`, `unnest(…) AS a(c)`,
   `ARRAY[…]` → `json_array(…)`; `asJsonArray` turns pg's `'{}'` array literal into `'[]'`.
6. `rewriteJsonOperators` — `col->'k'`, `col->0`, `col->>'k'` → `json_extract(…)`, matched by
   `JSON_ARROW = /(?<!-)->>?/` (the lookbehind keeps `--` comments from reading as an operator).
7. mask literals → `rewriteKeywords` (NOW/CURRENT_TIMESTAMP/`gen_random_uuid`), `rewriteSearch`
   (ILIKE→LIKE), `rewriteBooleans` (TRUE/FALSE→1/0), `rewriteOrdering` (`NULLS LAST/FIRST` →
   `(expr IS NULL) ASC/DESC`), `rewriteUpsert` → unmask.
8. `rewriteUpsert` — SQLite rejects the upsert clause after a `SELECT` source (see §5.2), so a
   SELECT-sourced `DO NOTHING` becomes `INSERT OR IGNORE INTO … SELECT …` with a note; a
   SELECT-sourced `DO UPDATE` is left alone and noted, because it cannot be expressed at all.

Notes and the leftover pattern land in `result.notes`; the harness fails a statement whose notes are
wrong, so a rule that stops firing shows up immediately.

### The harness is now two-stage (this is what made the signal clean)

- **Shape stage**: `db.prepare()` only — no binds. Catches syntax, unknown function/table/column and
  arity, so it is the honest gate on the translator.
- **Data stage**: executes with params built from the real schema — column kind from
  `compat/columns.json`, an allowed value from the schema's own `CHECK (col IN (…))` domains, `'[]'`
  for `::…[]` casts, distinct integers per slot (so `follower_id <> following_id` is not violated by
  the harness itself), ISO strings for timestamps. `--ladder` additionally retries all-`1`, all-`'x'`
  and all-date and only reports a failure that survives every rung.
  Result: every `datatype mismatch` / `CHECK constraint failed` / `malformed JSON` from the previous
  run **was bind noise**, as suspected. Only 2 statements still need the ladder, both
  `follower_id <> following_id` (multi-VALUES tuples swap `$1/$2`, so no single bind plan satisfies
  them). The 2× `conversations.id` NOT NULL failures are **gone** — the uuid DDL default below fixed
  them.
- 3 statements are template *fragments* (a SELECT list interpolated into a bigger query, e.g.
  `routes/spa/market.js:351`) and cannot be validated alone — they are covered by #20's differential
  harness instead. Do not read "0 data failures" as full coverage of those.

### Resolved: the four `gen_random_uuid()` columns self-generate in the DDL

`auth_sessions`, `conversations`, `email_verification_tokens`, `password_reset_tokens` had
`DEFAULT gen_random_uuid()` in pg. The port first made them app-generated, which broke
`INSERT INTO conversations DEFAULT VALUES RETURNING id` (`NOT NULL constraint failed`).
`cf-api/tools/d1-uuid-probe.mjs` settled it against the **live** D1 — `randomblob` and `random()` are
readable there, so the DDL carries the default and the routes stay unedited:

```
ok    randomblob readable / random() readable / uuid expression / uuid uniqueness
ok    DDL with uuid DEFAULT accepted
      VALUES insert   -> "84eafd5b-0849-4858-acd2-c2ec721af99b"
      DEFAULT VALUES  -> "87435f40-e3bd-4624-b84a-2d5faeb8cb57"
      uuid shape ok for 2/2, distinct 2/2
VERDICT: D1 can generate uuids in a column DEFAULT -> routes keep working unedited
```

The expression (`UUID_DEFAULT` in `cf-api/tools/pg-to-sqlite.mjs`, emitted by `mapDefault`'s
`gen_random_uuid()` branch) is
`lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))`.
The `substr(hex(randomblob(2)),2)` groups are load-bearing: taking 1+1 chars instead of one 4-char
group produced 34-character ids on the first attempt. `validate-schema.mjs` now guards this forever.

### SQL that must be hand-ported (no general rewrite is worth it — 12 sites)

Status 2026-10-13: **5 rows still need editing** — the four `generate_series`/`information_schema`
ones plus `routes/spa/chat.js:569` (`json_patch`). The adapter now handles the
`unnest` / `= ANY` / `->` / `'epoch'` / `NULLS LAST` / `to_jsonb` rows on its own and the harness
proves it; those rows are kept here as the record of what was checked. `generate_series` is not
available at all in this engine (`no such table: generate_series`), which is why all three of its
sites are hand-ports rather than translations.

| Site | Postgres-only construct | Port |
|---|---|---|
| `routes/admin.js:146-148` | `generate_series(11,0,-1)`, `interval '1 month' * g`, `to_char(month,'YYYY-MM')` | recursive CTE emitting 12 month-start ISO strings |
| `routes/spa/market.js:552-555` | `generate_series(NOW()-INTERVAL '7 weeks',NOW(),INTERVAL '1 week')` + `date_trunc('week')` join | recursive CTE of 8 ISO week-Monday strings, join on the string |
| `routes/spa/social.js:532-535` | same as above | same fix |
| `routes/spa/ops.js:99-100` | `information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])` | `sqlite_master` + `json_each(?)` |
| `routes/spa/chat.js:569` | `SET data = user_settings.data \|\| EXCLUDED.data` — pg `\|\|` **merges jsonb**, SQLite `\|\|` concatenates text | `json_patch(user_settings.data, excluded.data)`. Enumerated every `\|\|` inside an SQL literal (26 sites): the other 25 are text concatenation, so this is the only jsonb-merge in the app |
| `routes/spa/ops.js:215` | `DELETE ... WHERE id = ANY($1::bigint[])` then `RETURNING` | already handled by the ANY rule; verify D1 DELETE-batch |
| `routes/spa/feed.js:83` | `EXISTS (SELECT 1 FROM unnest(COALESCE(p.hashtags,'{}')) AS t(tag) WHERE LOWER(t.tag)=?)` | `(SELECT value AS tag FROM json_each(COALESCE(p.hashtags,'[]'))) AS t` |
| `routes/spa/social.js:94` | `FROM posts, unnest(COALESCE(hashtags,'{}')) AS tag` | same shape |
| `routes/onboarding.js:191` | `FROM unnest($2::bigint[]) AS candidate(id)` | `(SELECT value AS id FROM json_each($2)) AS candidate` |
| `routes/spa/chat.js:123` | `SELECT $1, u.id, NOW() FROM unnest($2::bigint[]) AS u(id)` | same, plus ISO now |
| `routes/spa/feed.js:359` | `COALESCE(p.media->0, to_jsonb(p.media_url))` | `COALESCE(json_extract(p.media,'$[0]'), json_quote(p.media_url))` |
| `routes/spa/chat.js:55` | `COALESCE(mine.last_read_at,'epoch'::timestamptz)` | `'1970-01-01T00:00:00.000Z'` (adapter handles) |
| `routes/spa/market.js:58` | `... LIKE $2) DESC NULLS LAST` in an ORDER BY fragment | adapter's NULLS rule; verify |

`routes/spa/ops.js` also contains an admin **migration-runner** (`pool.connect()` at :393, applies
`.sql` files from disk) — a filesystem-dependent feature that must be consciously redesigned (D1
migration or dropped from the Worker surface). Decide with the user before porting it.

### Still to design in #18

- **Result decoding parity** is the subtlest part. node-postgres returns `int8` and `numeric` as
  **strings**, `int4` as number, `boolean` as bool, `timestamptz`/`date` as **Date**, `jsonb` as a
  parsed value, `text[]` as an array. The app casts deliberately (`COUNT(*)::int AS n`) which proves
  it was written against those semantics. Plan: `loadColumnKinds(compat/columns.json)` gives a
  column-name→kind map, `resultHints(sql, kinds)` also reads explicit `::int` / `::bigint` /
  `::jsonb` casts in the SELECT/RETURNING list, and `decodeRows()` applies `decodeValue()`.
  Get this wrong and ids flip between `"4"` and `4` in JSON, which the frontend compares with `===`.
  **Status: `loadColumnKinds` / `resultHints` / `decodeRows` exist in `pg-compat.js` and their output
  shape is now measured on live D1 (int8 → string, timestamptz → Date, boolean → bool), §5.6. What is
  left is wiring them into `db.js`, not designing them.**
- **`cf-api/src/db.js` is not written yet.** Inventory of what it must imitate (from
  `C:\Users\Admin\.qoder\tmp\spa-fix\app`): 14 files `require("../db")` and every one of them takes
  `{ query }` except `routes/onboarding.js` (`{pool, query}`) and `server.js` (`{health, query}`).
  Only **2** sites use a transaction: `routes/onboarding.js:137` and `routes/spa/ops.js:393`. So the
  surface is `{ query, pool: { query, connect }, health }` + `init(env)`, and `query` must be a
  stable reference (routes destructure at import time; Worker `env` only exists inside `fetch`).
  D1 has no `BEGIN`/`COMMIT` binding, so `pool.connect()` **buffers writes** and COMMIT runs them as
  one atomic `env.DB.batch([...])`; a `SELECT` or a `RETURNING` asked for *inside* that transaction
  must throw a "needs hand port" error instead of silently returning nothing. Checked by reading
  both sites: onboarding's only read-your-write is `INSERT INTO skills … RETURNING id` at :172-183,
  whose value feeds the next insert — that one statement can be ported to a data-modifying CTE
  (`WITH s AS (INSERT INTO skills … RETURNING id) INSERT INTO profile_skills SELECT $1, s.id FROM s …`),
  which SQLite supports and keeps the whole route inside one batch. `spa/ops.js:396` is different:
  it hands `client.query()` a **whole multi-statement `.sql` file read from disk**, which neither
  `prepare()` nor the HTTP API accepts and which cannot exist on a Worker at all — leave it to the
  migration-runner redesign below, do not shim it.
- `translateSql()` returns `{ sql, params, notes, positional }`; `params` is already reordered by
  occurrence, which is what `.bind(...)` must receive. Value encoding/decoding is
  `encodeParams()` / `decodeRows(rows, resultHints(pgSql, kinds))`. `pg-compat.js` does no `fs`, so
  `db.js` must hand it `compat/columns.json` (wrangler's esbuild can `require` a `.json`).

### Ported shims (`cf-api/src/shims/`) — each differential-tested against the real npm package

A codespace recycle wiped the `/tmp` oracles mid-migration (see the tooling note below), so the packages
now live in `/workspaces/oracles` and every harness imports the **real** package it replaces and compares
*behaviour*, not self-consistency. The four counted ports and their tests as they report today
(`node cf-api/tools/test-*.mjs`, against express 5.3.0 / multer 2.4.0 / express-rate-limit 8.7.1 /
helmet 8.3.0 / cors 2.8.6 / jsonwebtoken 9.0.3):

- **`shims/jwt.js` — `test-jwt.mjs` 29/29.** jsonwebtoken 9.0.3's HS256 subset on `node:crypto`, kept
  synchronous because `issueToken()` (`routes/auth.js:25`) returns `jwt.sign(...)` without awaiting — a
  WebCrypto port would stringify to `[object Promise]`. Tested both directions: a VPS-issued token
  verifies in the Worker and vice-versa (the same `JWT_SECRET` is what keeps nobody signed out), it is
  byte-identical for identical claims (`exp` counts from `payload.iat`, not the wall clock), and every
  rejection matches jsonwebtoken's own message *and* error class.
- **`shims/limit.js` — `test-limit.mjs` 24/24.** express-rate-limit v8's `rateLimit()`: the three
  `server.js` buckets replayed against a real express + rate-limit server on real sockets, matching
  status, the SPA error envelope, and `RateLimit`/`RateLimit-Policy`/`Retry-After` per request, the
  `skipSuccessfulRequests` undo, IPv6 /56 grouping (against the package's own `ipKeyGenerator`), and
  window rollover.
- **`shims/express.js` — `test-express.mjs` 39/39.** Beyond matching/ordering (`server.js:153`'s
  spa-before-platform rule), it reproduces express's **entity headers** exactly: a weak ETag
  `W/"{byte-length hex}-{unpadded base64 sha1}"` on every non-empty body; a conditional GET/HEAD whose
  `If-None-Match` matches gets a **bare 304** with `content-type`/`content-length` stripped; a HEAD
  keeps `content-length` and sends no body; a POST is never answered with 304 however well its
  `If-None-Match` matches; `If-None-Match: *` revalidates anything; and an empty body gets **neither an
  ETag nor a content-type**. All checked against the real package over `node:http`.
- **`shims/upload.js` — `test-upload.mjs` 52/52.** multer + `express.static`/`send` on R2, driven
  against the mirror's own `middleware/upload.js`. Reproduces every multer failure mode
  (`LIMIT_UNEXPECTED_FILE` / `LIMIT_FILE_COUNT` / `LIMIT_FILE_SIZE` / a rejected `fileFilter`), the
  `{directory}/{owner}-{16 hex}{ext}` keys, `removeStored`, and — because the video player depends on it
  — the measured **range semantics**: only a single `bytes=a-b` is honoured, a multi-range or malformed
  request gets the whole file (200), `start >= size` / a reversed range is a **416 delivered through the
  app's error middleware** with `content-range: bytes */N` and the *file's* content-type, and a missing
  object returns nothing so `worker.js` answers the app's **404 envelope**.

Two ports exist but have **no differential test file today**: `shims/helmet.js` (helmet 8.3.0's default
header set plus the four headers the origin nginx added, per its file header) and `shims/cors.js`
(cors 2.8.x for `server.js`'s exact options object). Their behaviour was hand-measured against the
package before `/tmp` was wiped; re-checking them is an open item (see "Resume here"). `shims/https.js`
is the `node:https.request` port on `fetch()`, shaped exactly like the callback API
`services/mailer.js:38-64` uses (`request` / `on("timeout"|"error")` / `end(body)` / `destroy`,
`res.setEncoding` / `on("data"|"end")` / `statusCode`), so `mailer.js` runs byte-for-byte unedited; its
post-answer work is kept alive by `src/background.js` under `ctx.waitUntil`.

### DEVIATION — rate-limit counters live in a Durable Object, not Workers KV

§3 and §4 say "rate limits go to KV" / `KV professionalist-limits`. **That was wrong, and this
supersedes both lines.** `shims/limit.js` counts hits in a **singleton Durable Object**
(`env.RATE_COUNTERS`), not KV, because KV allows roughly **one write per key per second and is only
eventually consistent** — and a page load fires several parallel API calls at the same client IP, so the
dropped writes would **silently under-count** and let a visitor sail past the limit. KV's *shape* matched
the VPS's single in-process `MemoryStore`, but its *consistency* did not; a DO gives one strongly
consistent counter per edge, which is the shape and the guarantee that actually match the package. If the
DO call fails, the request is **allowed through** (`shims/limit.js:219-221`): a bookkeeping outage must
not become an error page for every visitor, and the real brute-force defence is the **account lockout**
`routes/auth.js` keeps in the database (`locked_until` / `failed_login_attempts`, checked at
`routes/auth.js:179`), exactly as `server.js:87-90` documents.

### DEVIATION — Redis is not ported

The mirror uses Redis in only two places: `connectRedis()` at boot (`server.js:177`, defined
`redis.js:11`) and the **`/health/full` payload string**. No route ever reads or writes the client, so
there is nothing to move — `dotenv`/`redis` become Worker vars / nothing. The consequence the operator
must be told at cutover: **`/health/full` keeps reporting `redis: "connected"`** (`server.js:124`) purely
for response-shape parity — VPS and Worker return the same JSON, but on the Worker that field is a
**known cosmetic lie**, not a live dependency; flag it so nobody reads it as a health signal. `/health`
(`server.js:112`) reports only the database and is the honest one.

### Tooling — why the oracles moved out of `/tmp` (`cf-api/tools/oracle.mjs`)

Every differential harness imports the real npm package, and `/tmp` is **not** a durable home for them:
**this codespace was recycled mid-migration and the jwt, rate-limit and multer oracles were wiped with
it**, turning "the package agrees" runs into missing-module errors — that is the reason `oracle.mjs`
exists. It searches, first hit wins, env override always first: **`CF_ORACLE_DIR` → `/workspaces/oracles`
→ `~/.cf-oracles` → `C:/Users/Admin/.qoder/oracles`**; if none carry `node_modules/express` it fails
naming every place it looked plus the one-line `npm --prefix …` that fixes it. Related gotcha that also
cost real time: **differential comparisons of conditional GETs must use raw `node:http`, not `fetch()`.**
Node's undici `fetch` silently drops the WHATWG *forbidden request headers* `If-None-Match` and
`If-Modified-Since`, so asking the VPS with `fetch` made express look like it **ignored revalidation**
when it was only the client refusing to send the header — `test-express.mjs` (`raw()`) and
`test-upload.mjs` (`vpsGet()`) both drive real sockets for exactly this reason.

### Boot order, measured in workerd — what `src/api.js` must exploit

Three facts, all observed in the workerd runtime rather than assumed, are what let the route files move
in unedited:
- **`process.env` is populated from `[vars]` AND writable** at runtime, so the boot shim can set or
  normalise values and routes reading `process.env.X` see them.
- **`node:fs` functions exist but the filesystem is invisible** — every path `ENOENT`s. Anything that
  touches disk (multer's disk storage, the `.sql` migration runner at `routes/spa/ops.js:396`) cannot
  work as written; hence uploads go to R2 and that runner needs the redesign in §7 #20.
- **A literal `require()` written inside a function stays lazy after esbuild bundling** — it is not
  hoisted to module top. That is the mechanism `src/api.js` will use: it sets `process.env` from the
  Worker `env`/vars and *then* requires the route tree, so a route's import-time `require("../db")` /
  `process.env.JWT_SECRET` reads happen only once the environment is real. This ordering is exactly what
  the D1/DO/R2 `init(env)` calls in `db.js`, `shims/limit.js` and `shims/upload.js` depend on, since
  `env` only exists inside `fetch`.

### Resume here — not done yet, in dependency order

None of the following exists on disk yet (verified: no `cf-api/port/`, no `tools/build.mjs`, no
`src/api.js`, no `src/worker.js`, and `wrangler.toml` declares **only** the D1 binding — no R2, no DO, no
`vars`). Ordered so each step unblocks the next; these map onto §7 #19-#22:

- **Step 1 — the port generator.** `cf-api/tools/build.mjs` → emits `cf-api/port/`: copy the mirror's
  route files and repoint only their `require("express"|"jsonwebtoken"|"express-rate-limit"|"helmet"|
  "cors"|"multer"|"https"|"../db")` onto the shims, leaving every route *body* verbatim.
- **Step 2 — the Worker shell.** `src/api.js` (the lazy-require boot order above) + `src/worker.js`
  (`fetch()`; serve `/uploads` straight from R2 via `shims/upload.js`'s `serveUpload`;
  `background.waitUntilWork(ctx)`; the counters DO class `shims/limit.js` calls) + `wrangler.toml`
  bindings: DB (real `database_id`), R2 `MEDIA`, DO `RATE_COUNTERS`, `JWT_SECRET` as a secret (same value
  as the VPS), `CORS_ORIGIN` etc. as `[vars]`.
- **Step 3 — object storage.** Create R2 bucket `professionalist-media` and backfill the **39 files /
  26,790,974 bytes (26.8 MB)** (§3 media inventory) under the current `/uploads/{kind}/{file}` keys,
  **with `contentType` set on every object** — the port prefers `httpMetadata.contentType` and only
  falls back to extension sniffing.
- **Step 4 — relational data.** Copy pg_dump data into `professionalist-db-v2`, **preserving ids**, then
  the **`sqlite_sequence` repair** (`UPDATE sqlite_sequence SET seq=(SELECT max(id) …)`) the AUTOINCREMENT
  tables need after explicit-id inserts — the mechanism already proven in §5.6.
- **Step 5 — route-level differential harness.** Replay all ~119 `EP.*` endpoints (§7 #20) against the
  live VPS and the Worker with the same seeded user and diff status + deep JSON. This harness is also the
  remaining gate on §6's type-decoding/ordering decisions and on the helmet/cors ports that lack a test.
- **Step 6 — deploy (preview only).** Push the new `professionalist-api` Worker to a `*.workers.dev`-free
  preview route. **Do not bind `api.proffessionalist.com` until §2's deploy-preflight passes and the user
  gives explicit go-ahead** — the VPS keeps serving that hostname, so the flip is both cutover and
  rollback.
- **Step 7 — SPA sources (gates the UI phases, not the API).** The `src/` tree is **absent from the repo**
  (confirmed: no `src/`, no `endpoints.ts`; only `index.html`, `vite.config.ts`, `tsconfig.json` and the
  built `dist/` are present). Any frontend redesign step needs that TypeScript source tree copied in
  first.

---

## 7. Remaining tasks

- **Done and verified since the last draft:** the D1 schema (#17, §5.1); the pg→D1 adapter and
  `cf-api/src/db.js` (#18 — `test-db.mjs` 25/25 and the live-D1 run in §5.6); every ported shim (#19 —
  express/jwt/limit/upload, differential-tested 39/29/24/52, §6); the port generator
  `tools/build.mjs` → `cf-api/port/` and the Worker entry `src/worker.js` + `src/api.js` (§5.7,
  `test-worker.mjs` 73/73); the R2 bucket `professionalist-media` with all 67 media files backfilled
  (§5.7); and the D1 data copy — 49 app tables / 619 rows, ids preserved, `sqlite_sequence` repaired
  (§5.7). The §5.3 "NOT CREATED" lines for `worker.js`, `api.js`, the counters DO and the port tree are
  all superseded by §5.7.
- **#20 — route-level differential run (IN PROGRESS NOW).** A concurrent agent is building and running
  `cf-api/tools/diff-routes.mjs`: replay the `EP.*` endpoints against the live VPS and against the Worker
  with the same seeded user, diffing status + JSON (deep, key-sorted). It is also the remaining gate on
  §6's type-decoding/ordering decisions and on the helmet/cors ports that still lack their own
  differential test. §6's in-flight text is deliberately left alone while this runs.
- **#22 (deploy half) — DONE 2026-10-20: `professionalist-api` is deployed as a PREVIEW Worker.** See
  §5.8 for the evidence. `node cf-api/tools/deploy.mjs [--dry-run] [--preview] [--allow-overwrite]`
  lists `/workers/scripts` first (§2 preflight), refuses a name that already exists unless
  `--allow-overwrite`, and deploys the generated `/workspaces/cf-run/wrangler.toml` (never the committed
  placeholder file). The earlier note that "workers.dev does not serve on this account" was wrong for
  this Worker: the subdomain is enabled and
  `https://professionalist-api.geraldmariba.workers.dev` answers production-identical reads (§5.8), so
  the `wrangler dev` sandbox is no longer the only way to exercise a deploy.
- **Action for the operator — rotate the Cloudflare API token.** It leaked into a transcript on 2026-10-20
  when `set -a; . ~/.cf_token_tmp` sourced a file that is one bare token line with no `=`; `set -a` printed
  it. Load it as `export CLOUDFLARE_API_TOKEN=$(cat ~/.cf_token_tmp)` (or `paths.mjs`'s `readTrim`), never
  with `.`, and keep piping output through `hideSecrets`.
- **Gated — the hostname flip.** Binding `api.proffessionalist.com` to the Worker
  (`PUT /accounts/{A}/workers/domains`) needs explicit operator go-ahead; the VPS keeps serving it, so
  the flip is both cutover and the instant rollback path. Immediately before any flip, **re-copy the
  production rows in a short (~5-minute) quiet window** — the VPS is still the live writer, so the D1
  snapshot drifts until cutover (§3 records no cron and no background writers, so a short window
  suffices).
- **Blocked — the SPA redesign phases.** `professionalist/src/` is absent from the repo (only
  `index.html`, `vite.config.ts`, `tsconfig.json` and the built `dist/`), so `src/services/endpoints.ts`
  (the endpoint list #20 replays) and every UI phase stay blocked until that TypeScript source tree is
  copied in.
- **Deliberate decisions that must NOT be "fixed":**
  - `OPS_TOKEN` is not supplied: `routes/spa/ops.js:78` only demands the `x-ops-token` header **when the
    name is set**, and production does not set it — adding it would impose a header no current admin
    sends, a visible change the mandate forbids.
  - `/health/full` keeps reporting `redis: "connected"` purely for response-shape parity even though
    Redis is not ported (mirror `server.js:124`); on the Worker it is a known cosmetic field, not a live
    dependency (see §6 "DEVIATION — Redis is not ported"). `/health` (mirror `server.js:112`) is the
    honest one.
  - `NODE_ENV` is not supplied: grep over the mirror finds **no reader** for it, and it changes only the
    finalhandler wording the app's own error middleware already replaces (`tools/runtime-config.mjs:33-34`).

---

## 8. Commands

```bash
# regenerate + locally validate the D1 schema
node cf-api/tools/pg-to-sqlite.mjs && node cf-api/tools/validate-schema.mjs
# apply/verify against the real D1 database (needs C:\Users\Admin\.cf_token_tmp)
# target database = C:/Users/Admin/.qoder/tmp/d1move/d1-id.txt  (currently professionalist-db-v2)
node cf-api/tools/count-rows.mjs          # read-only: is it empty? check BEFORE any rebuild
node cf-api/tools/cloudflare-audit.mjs    # read-only §2 preflight; run before ANY deploy
node cf-api/tools/create-db.mjs <name>    # new D1 + re-point the id file (old id -> d1-id.previous.txt)
node cf-api/tools/apply-schema.mjs --dry
node cf-api/tools/apply-schema.mjs
node cf-api/tools/apply-schema.mjs --verify
# re-measure D1 behaviour after any adapter change
node cf-api/tools/d1-uuid-probe.mjs
node cf-api/tools/d1-probe.mjs && node cf-api/tools/d1-probe2.mjs
node cf-api/tools/d1-batch-probe.mjs      # batch endpoint + atomicity; --no-write skips the writes
node cf-api/tools/verify-live.mjs         # adapter + 5 hand-ports on LIVE D1; refuses a non-empty start
# the adapter's regression gate
node cf-api/tools/sql-census.mjs
node cf-api/tools/fn-census.mjs --translated   # functions this engine lacks, before/after translation
node cf-api/tools/test-pg.mjs                  # shape stage only
node cf-api/tools/test-pg.mjs --ladder         # shape + data stage with the param ladder (use this)
node cf-api/tools/test-db.mjs                  # db.js against a stand-in D1 binding (no network, no writes)
# the shim differential tests — each imports the REAL package it replaces (see cf-api/tools/oracle.mjs:
# CF_ORACLE_DIR -> /workspaces/oracles -> ~/.cf-oracles), and uses raw node:http for conditional GETs
# because node's fetch drops If-None-Match / If-Modified-Since (§6 tooling note)
node cf-api/tools/test-express.mjs             # shims/express vs express 5.3.0 — mounting + ETag/304/HEAD (39/39)
node cf-api/tools/test-jwt.mjs                 # shims/jwt vs jsonwebtoken 9.0.3, both directions (29/29)
node cf-api/tools/test-limit.mjs               # shims/limit vs express-rate-limit 8.7.1 over real sockets (24/24)
node cf-api/tools/test-upload.mjs              # shims/upload vs multer 2.4.0 + express.static/send (52/52)
node cf-api/tools/test-worker.mjs              # the Worker wiring: DO class/name, placeholder D1 id + v2 name,
                                               # every [vars] name read & none a secret, no [triggers], nodejs_compat (74/74)
# the port generator, the run config, and the Worker commands (§5.7) — these all touch the real account
node cf-api/tools/build.mjs                    # mirror -> cf-api/port/, only require/hand-port lines change per file
node cf-api/tools/runtime-config.mjs [--dev]   # writes /workspaces/cf-run/{wrangler.toml,dev.vars}, mode 600, values never printed;
                                               #   --dev writes wrangler.dev.toml (D1+R2 read remotely, the Durable Object LOCAL)
#   read the Worker locally against real D1/R2 with a LOCAL counter (§5.7 workerd fact c)
npx wrangler dev -c /workspaces/cf-run/wrangler.dev.toml --port 8803 --persist-to /workspaces/cf-run/state
node cf-api/tools/deploy.mjs [--dry-run] [--preview] [--allow-overwrite]   # §2 preflight lists /workers/scripts FIRST; deploys the GENERATED config, not the committed one;
                                               #   --preview forces MAILER_ENABLED:false and is the ONLY mode used so far (§5.8)
node cf-api/tools/verify-preview.mjs <base-url> [uploads-key]   # read-only GET/HEAD/OPTIONS diff against live api.proffessionalist.com:
                                               #   statuses, byte-identical JSON, app headers, RateLimit/pk shape, media + Range parity (§5.8)
# move the production data and media (both idempotent, both additive/never-deleting)
node cf-api/tools/copy-data.mjs --dump=<pg_dump --data-only>   # 49 app tables/619 rows -> D1, ids preserved, sqlite_sequence repaired, FK-ordered (§5.7)
node cf-api/tools/backfill-r2.mjs [--dry-run] [--verify]       # 67 files -> R2 professionalist-media; --verify reads keys/size/stored content-type back
# read-only VPS env pull for runtime-config.mjs — the output is mode 600 and is NEVER printed or committed:
#   ssh -i ~/.ssh/professionalist-vps.key opc@140.245.50.236 "cat /home/opc/professionalist/.env" > /workspaces/cf-run/vps.env
# §2 stays in force for every command above: list /workers/scripts before any deploy; database_id stays
#   "placeholder" in the committed cf-api/wrangler.toml (substituted only in the generated file); never print
#   or commit the SSH key, the account id, the zone id, the API token, the R2 keys, or JWT_SECRET.
```

Every external path is resolved by `cf-api/tools/paths.mjs`, so the same commands work on the
workstation and in a Linux codespace. First existing candidate wins, env override always first:
token `$CF_TOKEN_FILE` → `C:\Users\Admin\.cf_token_tmp` → `~/.cf_token_tmp`; ids `$CF_TMP_DIR` →
`...\d1move` → `~/.qoder/tmp/d1move` (`create-db.mjs` creates that directory if it is absent);
mirror `$APP_MIRROR_DIR` → `/workspaces/app-mirror/app` → the `spa-fix/app` Windows path.
A missing path fails with the list of places searched and never prints a file's contents.
Keep credentials **outside** the repo directory — note that `professionalist/` is currently
entirely untracked, so a broad `git add -A` would sweep in anything copied next to the code.

Inventory evidence (read-only SSH output) is at
`C:\Users\Admin\.qoder\tmp\d1move\inventory.txt` and `inventory2.txt` (3,124 lines; the schema
lives between `== SCHEMA-START` / `== SCHEMA-END`), plus `parity.mjs` for the md5 comparison.

## 9. Document maintenance

The user asked that this file be updated **every time we make an edit** so another agent can pick
up cold. Rule for whoever works next: after any change to `cf-api/**`, the D1 database, or the
deployment topology, update the affected section and the "in flight" section (§6) — including
failing counts from `test-pg.mjs`, which are the honest progress signal. Keep it factual: verified
numbers, file paths, line numbers, and what is still broken. No secrets, ever.
