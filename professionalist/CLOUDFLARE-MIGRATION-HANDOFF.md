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

### 5.9 2026-10-20: the route-level differential harness (#20) ran, found one real DEFECT, and it is fixed

`cf-api/tools/diff-routes.mjs` (+ `diff-support.mjs`, report in `cf-api/tools/diff-report.md`) enumerates the
ported surface rather than guessing it: **196 router definitions → 185 unique reachable `METHOD path`
endpoints** (11 `platform` routes are shadowed by `spa` mounted ahead of them), 149 unique paths — public 8,
anonymous-guarded 8, authenticated 153, admin-ops 31. It probed every unique path against production
(GET/HEAD/OPTIONS only, no credentials, ≤250 requests) and compared status, the data-independent bodies, and
the header **name multiset including duplicate counts**; RateLimit/`pk=:…:` matched in form and the real
`/uploads` object matched. **148 of 149 paths fully clean, stable across two byte-identical runs.**

- **DEFECT, found and fixed: `cf-api/src/db.js:67` bound parameters raw on the single-statement path.**
  The batched/transaction path encodes through `compat.encodeParams` (`db.js:118`); the direct path did not.
  D1 has no array/Date/jsonb bind type, so `routes/meta.js:29`'s `WHERE key = ANY($1::text[])` returned
  **0 rows** and `/api/meta/content` answered from `CONTENT_DEFAULTS` — a silently empty result, not an
  error, which is the worst failure mode to meet in a differential run. Reproduced against live D1 (encoded:
  rows; raw: `malformed JSON` or nothing), then fixed by encoding on both paths. `GET /api/meta/content` is
  now byte-identical on the two stacks, it is a permanent case in `tools/verify-preview.mjs`, and
  `tools/test-db.mjs` gained three checks for exactly this shape (text[] bind, Date bind, empty array) —
  **28/28**, and the pre-fix line was re-run to confirm those checks actually throw without the fix.
  Anything that binds an array/Date/jsonb outside a transaction was affected; only `meta.js` was provable,
  because authentication was blocked (below).
- **BLOCKER, config only, now fixed: the `wrangler dev` sandbox had no `JWT_SECRET`.**
  `runtime-config.mjs` wrote `dev.vars`, but wrangler reads **`.dev.vars`** (leading dot) next to the config
  file, so `shims/jwt.js:100` called `createHmac("sha256", undefined)` and `POST /api/auth/register` and a
  correct-credential `login` both 500-ed without minting a token (the user/profile/security_event rows did
  land). That blocked every authenticated GET, every write, refresh/logout and the admin-ops 403 boundary —
  i.e. 153 of the 185 endpoints were untested, not clean. The deployed Worker never had this problem (its
  secrets are real), which is precisely why a sandbox is not a substitute for a deploy and vice versa.
  `runtime-config.mjs` now writes both spellings; `dev.log` reads `Using secrets defined in .dev.vars` with
  `env.JWT_SECRET ("(hidden)")`. **The authenticated half of the diff has to be re-run against this** — the
  harness already does it Worker-only with one throwaway account, asserting then deleting the rows it made.
- Also worth keeping: the run cleaned up after itself (D1 back to the 7-user baseline, no probe ids left,
  nothing added to R2), and reset-password was confirmed to fail at the mail call without hanging.

**One security item for the user:** the Cloudflare API token in `~/.cf_token_tmp` is a single bare line
with no `=`, so an early `set -a; . ~/.cf_token_tmp` **echoed the token itself** into the transcript.
Everything since has been loaded with `export CLOUDFLARE_API_TOKEN=$(cat …)` and every command's output
redacted through `paths.mjs`'s `hideSecrets`. **That token should be rotated.**

### 5.10 2026-10-20 — the refresh path, and three latent 500s the anonymous sweep could not see

**Traffic flip is authorised** (the owner said so in this session), so the work moved from "prove parity" to
"make the flip safe to execute and re-executable". Four things were measured and fixed:

- **The VPS has no PostgreSQL client tools.** `command -v pg_dump psql` is empty and
  `find / -xdev -name pg_dump` returns nothing; postgres runs in the **`professionalist-postgres`
  container** (`postgres:16`, same image family the `live-schema.sql` header names), redis in
  `professionalist-redis`. The dump therefore runs as
  `docker exec -i -e PGPASSWORD=… professionalist-postgres pg_dump -U … -d … --data-only --no-owner --no-privileges | gzip -9`,
  with the five DB_* values read out of the app `.env` by `sed -n "s/^KEY=//p"` — **never** by
  `set -a; . .env`, which on this file executes junk (`use: command not found`, `37952: command not found`)
  because a value is not a single shell word, and produced an 11-byte empty gzip on the first attempt.
  Script: `/tmp/vpsdump.sh`; target `/workspaces/cf-run/prod-dump.sql.gz`, mode 600, contents never printed.
  `--column-inserts` must NOT be used: `copy-data.mjs`'s reader parses `COPY … FROM stdin` blocks
  (`readDump`, lines 246-274), not INSERT statements.
- **`copy-data.mjs --refresh`** exists and has been run. The old loader could only ever append, so a
  re-copy into a non-empty D1 was impossible — exactly the quiet-window step the flip needs. It clears
  the 49 snapshot tables in the **reverse** of the FK load order (children first), and a
  self-referential table is peeled leaf by leaf (`DELETE FROM posts WHERE post_id NOT IN (SELECT
  source_post_id FROM posts WHERE source_post_id IS NOT NULL)`, repeated) because D1 enforces FKs over
  HTTP and `PRAGMA foreign_keys=OFF` is ignored (§5.2) — a plain `DELETE FROM posts` aborts on the first
  parent row whose child is still present. Three refusals guard it, each overridable only by `--force`:
  an `api.*` hostname already bound (that is "traffic is live, users would see the gap"), a dump that
  holds less than half the rows D1 holds (a truncated dump would DELETE the difference permanently), and
  a **D1-only feature table that still references a table being cleared** — the videos tables arrive via
  `tools/apply-videos-schema.mjs`, so `compat/schema.sql` does not describe them and the FK graph here
  cannot order them. Result of the real run: D1 went 619 → **621** rows, `--counts` reported
  `totals: D1=621 PG=621 mismatches=0`, `--spot` answered all five app query shapes correctly, and
  sequence repair put every `sqlite_sequence` counter at `max(id, pg_last_value)`.
- **Three authenticated endpoints 500-ed on the Worker and were invisible to the 149-path anonymous
  sweep** — the sweep cannot see them because they require a bearer token, and the token was unavailable
  until the `.dev.vars` fix (§5.9). Reproduced and root-caused against live D1, with the engine facts
  measured rather than assumed:
  - `GET /api/search/suggestions` → `no such column: hashtags at offset 93`. pg-compat rewrites
    `FROM unnest(x) AS alias` to `(SELECT value FROM json_each(x)) AS alias`, and SQLite will not let a
    **subquery in FROM** reference a column of another FROM item (no LATERAL). The correlated form that
    does work is the **table-valued function itself**: `FROM posts, json_each(COALESCE(posts.hashtags,'[]')) jt`
    (measured, returned real hashtag rows). D1 stores `text[]` as JSON array text, so the empty default
    is `'[]'`, never PostgreSQL's `'{}'`.
  - `GET /api/users/me/progress` → `near "'1 week'": syntax error at offset 165`, and
    `GET /api/admin/stats` → **`no such table: generate_series`** (found by the new admin-ops sweep,
    which promoted a throwaway user to `role='admin'` by a direct D1 write and re-minted a token — 15
    admin GETs, 10×200, 4 legitimate 403s from `requireOps`' `OPS_OWNER_ID` lock, 1×500). D1 has **no**
    `generate_series` at all; a recursive CTE **inside a parenthesised subquery in FROM** does work
    (measured: 12 rows 11..0). The weekly-bucket form uses the same Monday truncation pg-compat already
    applies to `date_trunc('week')` (`pg-compat.js:190`, `strftime('%Y-%m-%dT00:00:00.000Z', …, 'weekday 0',
    '-6 days')`), so the join keys on both sides line up; measured against live data it returned 8 rows
    oldest-first with the right per-week counts.
  Four sites are hand-ported in `build.mjs`'s `HAND_PORTS` (social.js ×2, market.js ×1, feed.js ×1 —
  `?hashtag=` is the same correlated-unnest bug, unreachable unless the parameter is sent) and the
  integer `generate_series` form goes into pg-compat as a generic rule that matches **numeric-literal
  arguments only**, so it can never half-translate the timestamp form. Both endpoints now report
  `DEFECTS: 0` and the two paths return 2xx.
- **The harness itself had a bug, and saying so matters more than a green run.**
  `POST /api/messages/conversations -> 400 fields:{userId:"Not valid"}` looked like a port defect; it is
  the harness posting `{participant, message}` while `chat.js:92` reads `body.userId` /
  `body.firstMessage`. Replaying both shapes settled it: `{participant,…}` → 400, `{userId, firstMessage}`
  → **201**, `{userId:"35"}` (string) → 200 existing-conversation branch, self → 400, unknown → 404. The
  mirror and the port are byte-identical over those lines, and D1 coerces the id the way PostgreSQL did —
  so the port was never wrong. `diff-routes.mjs` now sends the real keys, posts a follow-up message
  through `POST /conversations/:id/messages` (payload field `text`, `chat.js:134`) and asserts the text is
  readable back through `GET /conversations/:id` before deleting the rows.

**Two environment facts worth keeping:** `wrangler r2 object delete/get` defaults to **`--local`**
(miniflare state) and prints `Resource location: local` while still saying `Delete complete` — the first
prune pass deleted four test avatars from the sandbox and nothing from the real bucket. Add `--remote`
(and `CLOUDFLARE_ACCOUNT_ID`, loaded from `acct.txt`, never printed) for the real one. And every
`diff-routes` run leaves exactly one orphan avatar (`avatars/<throwaway-uid>-<hash>.png`, named in its own
output) because the harness signs no S3 delete; prune those after the final run, not during, or the count
just climbs — `--verify` currently reports `EXTRA key in bucket` for them while all 67 real objects byte-compare
IDENTICAL.

**The videos vertical slice (#6 of the platform spec) is green:** `node cf-api/tools/test-videos.mjs` →
**48 passed, 0 failed** (rank-config weights reorder the feed, per-feature score movement, the
`MAX_PER_AUTHOR=2` diversity guard, cursor pagination without repeats, interests round trip, admin
role gating). One prior assertion was wrong rather than the code: it compared a **weighted sum** of all
six features against a single weight, which can never hold for a video created this second
(`quality_freshness` = 1.0). It now asserts the bounded thing — the `engagement` feature ≤ 1 and a
hundredfold surge past saturation buys no more than `W.engagement`.

### 5.11 2026-10-20 — the Worker is deploy-complete and waiting on one token permission

Everything up to the hostname flip is done and evidenced. The flip itself is **blocked by the API
token's permission set, not by anything in this repo** — recorded here with the exact codes so the
next session does not re-discover them.

**Differential, final clean run** (`node cf-api/tools/diff-routes.mjs`, log `/workspaces/cf-run/diff-final.log`):

```
probed 149 paths against production; 149 fully clean; production requests used: 149/250
endpoints: 203 router definitions, 192 unique (method,path), 156 unique paths
grouping: public=8 anonymous-guarded=8 authenticated=153 admin-ops=31 worker-only=7
DEFECTS: 0   BLOCKERS: 0
```

The three latent 500s are closed, each by a port-level fix rather than a route change: the hashtag
`json_each` correlation, the weekly-trend recursive CTE, and `GET /api/admin/stats` — the last needed
`pg-compat.js`'s new `rewriteGenerateSeries()` (integer `generate_series` as a FROM item → a recursive
CTE, because D1 answers `SELECT * FROM generate_series(1,5)` with *no such table*) plus
`rewriteVariableIntervalMul()`, which fixes the neighbouring `X ± (interval '1 unit' * n)` product that
previously translated into numeric garbage. `GET /api/admin/stats (role=admin) -> 200 ok`, and the
admin-ops sweep used **0 production requests** (it promotes a throwaway user directly in D1 and demotes
it afterwards).

`/api/videos` is now enumerated: `diff-support.mjs` maps `spa/videos.js` → `/api/videos` (its own mount
base, `src/api.js:310`) and classifies those 7 endpoints as group **`worker-only`**, because the VPS has
no such route — probing production would compare a real answer against the VPS's 404 fallthrough and
call that a defect. They are still exercised over HTTP, inside the authenticated sweep
(60 GETs → 2xx=48 4xx=12 5xx=0, the 4xx being `:id` misses and all envelopes).

**Media**: the 5 harness-orphan avatars (`avatars/41..45-*.png`) are gone — `wrangler r2 object delete`
must carry `--remote`, its default silently deletes from miniflare's local state while printing
"Delete complete". `backfill-r2.mjs --verify` now reads `list: bucket keys=67 (expected 67)` and
`verify problems: 0`, with the real objects byte-comparing IDENTICAL.

**Quiet-window data step, executed at 07:24Z**: fresh read-only dump from the container
(`/tmp/vpsdump.sh`, `pg_dump 16.15`, 29 KB gz) → `copy-data.mjs --dump=… --refresh --dry-run`
(`every refresh gate passes`) → `--refresh`. D1 held 632 rows in the 49 snapshot tables, the dump
carried 624; after the refresh `--counts` reads `totals: D1=624 PG=624 mismatches=0` and the sequence
repair probe re-confirmed `skills: max copied id=45 probe id=50 greater=YES` then deleted its probe.
The D1-only video tables (`video_topics=8`, `video_rank_config=6`, `video_sources=3`) were left alone,
as designed — `videos=0` is correct, since the VPS has no video content to copy.

**Deploy**: `node cf-api/tools/deploy.mjs --allow-overwrite` (the script-name guard needs that flag on a
re-deploy) recorded `last-deploy.json: preview=false`, shipped `MAILER_ENABLED=true` with the
`CORS_ORIGIN`/`MAILER_API_URL`/`IP_RATE_LIMIT` vars and the `JWT_SECRET`/`MAILER_API_TOKEN`/`OPS_OWNER_ID`
secrets, and `d1=DB r2=MEDIA do=RATE_COUNTERS(RateLimiter)`. Live proof from the deployed script, not
the local sandbox: `/health` 200, `/api/meta/countries` 200 (186 B), `/api/meta/categories` 200, and
`/api/meta/stats` → the `unauthorized` envelope, i.e. auth still gates.

**The blocker.** `api.proffessionalist.com` is still answered by the VPS — nothing user-visible changed.
The token in use is account-scoped for Workers/D1/R2/DO and carries **no Zone resource**, so every API
path that could bind the hostname is refused. Measured, in order:

| attempt | endpoint | result |
|---|---|---|
| `cutover.mjs --flip` | `POST /accounts/{a}/workers/domains` | `10405 Method not allowed for this authentication scheme` (the identical GET is 200) |
| `wrangler deploy --domains` | `POST …/scripts/professionalist-api/domains/records` | `100117 Hostname 'api.proffessionalist.com' already has externally managed DNS records (A, CNAME, etc). Delete them first` |
| `wrangler deploy --routes --x-route-zones` | `POST …/scripts/professionalist-api/routes` | `No access to the specified resource` |
| (why DNS is not a workaround) | `GET /zones/{z}/dns_records`, `GET /zones/{z}/custom_hostnames` | `403 / 10000 Authentication error`; `GET /user/tokens/verify` → `401 1000` |

Deleting that A record is deliberately *not* considered: it is the instant-rollback path back to the VPS,
and the token cannot restore it. So the flip needs one of these two user-side actions, after which
everything else is already in place:

1. **Widen the token** — Cloudflare dashboard → My Profile → API Tokens → Edit → add
   `Zone / proffessionalist.com / Read` (Workers Scripts: Edit is already there; the bulk-domains POST
   requires both). Then: `node cf-api/tools/cutover.mjs --flip`.
2. **Or click it in the dashboard** — Workers & Pages → `professionalist-api` → Settings →
   *Domains & Routes* → Add → Custom domain → `api.proffessionalist.com`. Cloudflare converts the proxied
   record into a Worker-bound custom hostname; *Remove* is the rollback.

Either way, verify afterwards through the real hostname (`/health`, `/api/meta/countries`, an
unauthenticated 401 envelope, and a signed-in page), keep `node cf-api/tools/cutover.mjs --rollback`
ready, and re-run `diff-routes.mjs` — its Phase A compares prod against the Worker, and once the
hostname points at the Worker both sides are the same origin, so re-read §5.11 before trusting a
post-flip differential.

### 5.12 2026-10-20 — two agents reported the same phantom defect; it does not exist

Two parallel agents independently concluded that D1's query API returns no rows for
`UPDATE … RETURNING` / `DELETE … RETURNING`, and that this silently erodes ~12 write endpoints (or
500s them) — one of them "fixed" it with a `_shim/pg-recovery.js` and hand-ports in five overlay route
files. **None of that is on disk** (`app-new/` contains only the four videos files; there is no
`chat_conv_unique` migration, no `probes/`, no `seed-videos.sql`), and the premise does not survive a
direct test, because `src/db.js` does not pass D1's response through — it builds the pg result from
`meta.changes` as well as from `results`.

`node cf-api/tools/probe-returning.mjs` (new; Worker on 8803 + the real `professionalist-db-v2`, zero
production requests) mints its own rows and asserts the response shape *and* the resulting D1 row state:

```
VERDICT: 23 passed, 0 failed
POST /api/posts/:id/comments -> 201 {"id":11,"postId":45,…}
DELETE /api/posts/:id        -> 200 {"ok":true}   posts.deleted_at=2026-10-20T07:39:03.804Z
POST /api/tasks/:id/toggle   -> 200 {"status":"done","completedAt":"2026-10-20T07:40:27.520Z"}
DELETE /api/marketplace/listings/:id -> 200 {"ok":true}   rows=0
DELETE /api/messages/messages/:id    -> 200 {"ok":true}
DELETE /api/saved/:id                -> 200 {"ok":true}
leftover rows: users=0 posts=0 tasks=0 listings=0 follows=0
```

So the `rowCount` branch (`if (!result.rowCount) return missing(res, …)`) and the `rows[0]` branch
(`status: updated.rows[0].status`) both behave as they do on PostgreSQL. If a future agent again claims
silent RETURNING erosion, run this probe first — its own report is the evidence, not the D1 docs.

One honest caveat: the probe covers the SPA write surface it can reach with a single throwaway member.
It does not exercise `POST /api/messages/upload` or `POST /api/marketplace/images` (multipart, so they
leave an R2 object behind — the same orphan issue as the avatar step), `ops.js`'s two `RETURNING` sites
(admin-only writes), or `videos.js`'s seven (covered by `test-videos.mjs` instead).

The mirror's `app/routes/spa/*.js` are still byte-identical to what the VPS runs, which is the property
that makes the differential meaningful; had the phantom fix been applied, the Worker and the VPS would
have diverged in five files while every test still said green.

### 5.13 2026-10-20 — ground truth for the two things agents disagree about

Written because three agents reported contradictory state for the videos vertical slice and for the
frontend. These are the measurements, taken directly, not summaries of what an agent said it did.

**Videos / media serving is intact on the deployed Worker.**

```
GET https://professionalist-api.geraldmariba.workers.dev/uploads/avatars/12-3082824f10d21743.png
  -> 200 image/png 89377 bytes
GET https://api.proffessionalist.com/uploads/avatars/12-3082824f10d21743.png   (the VPS)
  -> 200 89377 bytes                                   ← same bytes, both sides
```

**D1's `videos` table is empty and still on the original self-managed contract** — no `src_kind` column
exists, so the "external-URL-only" redesign that one agent described is *not* the live state:

```
videos rows = 0
videos cols = id,post_id,kind,provider,canonical_url,media_key,embed_url,duration_ms,width,height,
              thumbnail_key,topic_ids,moderation_state,availability,source_user_id,indexed_at,
              last_checked_at,deleted_at
```

`cf-api/compat/schema.sql` contains **no** `videos` table at all (`grep -n "CREATE TABLE.*videos"` →
empty), and the live D1 columns above do not match it either — that snapshot predates the video feature,
so it cannot be used to validate video migrations. If a future session applies a video migration,
re-derive `compat/schema.sql`/`live-schema.sql` rather than trusting them. `app-new/services/videoKit.js`
and several `src/components/video/*` files are currently `AM` (modified in the working tree, staged
version differs) — resolve that before trusting `npm run build` output for the videos UI.

**The frontend has no entry point.** `src/` holds 79 files (services, context, hooks, routes, pages,
components), but `src/main.tsx` and `src/App.tsx` **do not exist**, so nothing mounts: only
`LandingPage`, `VideosPage`, `CreateVideoPage`, `VideoInterestsPage` are present, while
`src/services/` already has feed/social/market/jobs/messages/tasks/notifications/settings/admin/onboarding
clients. The real production SPA is the Cloudflare Worker script `proffessionalist-web` (the deploy
preflight confirms it exists on this account, and the VPS has no frontend source at all — nginx only
holds `server_name api.proffessionalist.com` + `proxy_pass http://127.0.0.1:5000`). So the missing spine
is ordinary code, not a credential problem: any agent claim that it "cannot write main.tsx because the
environment is blocked" is wrong. §15 of the upgrade brief is therefore still substantially unbuilt —
backend §6 is built, the UI on top of it is not.

**THE FLIP HAPPENED (2026-10-20 ~07:50Z).** A fresh token with `Zone / DNS / Read + Edit` was supplied, so
the managed-DNS path went through: `/workspaces/cf-run/flip-managed.mjs` saved the proxied `A` record (in
`/workspaces/cf-run/api-dns-record.json`, mode 600 — that file *is* the rollback recipe), deleted it, ran
`wrangler deploy -c /workspaces/cf-run/wrangler.toml --domains api.proffessionalist.com`, and would have
POSTed the record straight back if the bind had failed. Measured through the real hostname afterwards,
with `server: cloudflare` proving the Worker answers:

```
/health 200 (58 B)   /api/meta/countries 200 (186 B)   /api/meta/categories 200 (255 B)
/api/meta/stats      -> {"error":{"code":"unauthorized",…}}          (auth still gating)
POST /api/auth/register {"email":"not-an-email"} -> 400 envelope     (validation, no 500)
POST /api/auth/login  (wrong password)           -> 401 + two RateLimit/RateLimit-Policy headers
OPTIONS /api/auth/login from https://proffessionalist.com -> access-control-allow-origin echoed
HSTS includeSubDomains, x-content-type-options nosniff, x-frame-options SAMEORIGIN all present
```

Rollback is now a two-step, not a no-op: `DELETE /accounts/{acct}/workers/scripts/professionalist-api/domains/records/{id}`,
then re-POST the record from `api-dns-record.json`. The VPS itself is untouched and still runs the app,
nginx and PostgreSQL, so restoring that record returns the hostname to it. The token that was pasted into
the chat must be rotated (it also replaced `/home/codespace/.cf_token_tmp`, mode 600); the R2 S3 keys in
`~/.qoder/tmp/d1move/` predate it and are unchanged.

Also still true after the flip: the frontend has **no** `src/main.tsx` or `src/App.tsx`, so the SPA in this
workspace cannot build or deploy, and `proffessionalist-web` on the account is the site the users see —
§15 of the upgrade brief is unbuilt. And `videos` in D1 is empty with the original self-managed column
set (no `src_kind`), while `cf-api/compat/schema.sql` has no `videos` table at all.

### 5.14 2026-10-20 (post-flip, ~08:00Z) — first differential of the live Worker against the VPS oracle: 149/149 clean; the flip-time token is now dead

**What this session verified through the real hostname (no credentials used):**
- `GET /health` → 200 `{"status":"healthy","api":"online","database":"connected"}` with
  `server: cloudflare` + `cf-ray`, so the edge really answers the hostname.
- `GET /api/meta/countries` / `/api/meta/categories` → 200; `GET /api/meta/stats` → the
  `unauthorized` envelope; `GET /api/no-such-path-zz` → 401 on **both** stacks with byte-identical
  ETag (`W/"54-…"`), i.e. the /api auth guard runs before routing, same as the VPS.
- Header multisets (names + duplicate counts) on 200 and 401 match the VPS-direct answers exactly,
  except pure edge/transport names: Worker-only `server: cloudflare`, `cf-ray`, `nel`, `report-to`,
  `alt-svc`; VPS-only `server: nginx`, `connection: keep-alive`. App headers — including the doubled
  `x-content-type-options` / `referrer-policy` and the RateLimit pair — match, and both stacks emit
  the **same** `pk=:M2JlZDYxYTZhMGYw:` partition hash, i.e. the Worker rate limiter hashes the same
  client IP the VPS hashes (cf-connecting-ip flows through correctly).

**The post-flip differential re-run (§5.11's "re-run diff-routes" instruction).** Two new capabilities
were added to the harness so a post-flip run cannot diff the Worker against itself:
- `diff-support.mjs` gained `applyTargetArgs(argv)`:
  - `--prod-direct` re-points the oracle at the still-running VPS directly — `140.245.50.236:80`,
    plain HTTP, `Host: api.proffessionalist.com` (new `hostHeader` field on the target; nginx routes
    by Host, confirmed 200 before the run). `prodRequest()` still enforces read-only GET/HEAD/OPTIONS.
  - `--worker-live` re-points the Worker side at the deployed `https://api.proffessionalist.com`, and
    sets an EDGE flag so `compareHeaders` treats `ENV_PROD_ONLY` names as environmental **on the
    Worker side too** (cf-ray/nel/report-to/alt-svc/server). `compareHeaders` also learned
    `workerStatus` so the edge's 404 `cache-control` is environmental on either side.
- `diff-routes.mjs` gained `--phase-a-only` (skips Phase B/CLEANUP entirely, with a printed reason) —
  required right now because the D1 HTTP API is unreachable (below); Phase B must not run if its
  throwaway rows cannot be cleaned up.

Run: `node cf-api/tools/diff-routes.mjs --prod-direct --worker-live --phase-a-only`
(log `/workspaces/cf-run/diff-postflip.log`):

```
targets: prod=vps-direct 140.245.50.236:80 worker=live (deployed, via edge)
probed 149 paths against production; 149 fully clean; production requests used: 149/250
content/status/header DEFECTS from Phase A: 0
OPTIONS /api/meta/countries: 204 both, allow-methods identical
RateLimit-Policy FORMAT matches on both stacks (same pk hash)
DEFECTS: 0   BLOCKERS: 0
```

The A.2 real-object check self-skipped because its D1 key lookup needs the API token; run manually
against `avatars/10-30a033da679031c3.jpg` instead: **200, `image/jpeg`, 437,299 B, bytes identical;
`Range: bytes=0-99` → 206 with the same 100 bytes on both stacks.**

**The flip-time token blocker is RESOLVED (2026-10-20, ~08:25Z).** The owner supplied fresh
credentials (written to `~/.cf_token_tmp` + `~/.qoder/tmp/d1move/*`, mode 600; the dead values were
kept aside as `*.old*` files). Everything HTTP-facing is unchanged; with the new token the three
deferred items were all executed:

- **Stray `notifications` rows: DISPROVEN.** The §5.14 suspicion came from code inspection of
  `platform.js:2505` — but the live mount order routes the harness's message sends through
  `spa/chat.js`, which performs **no** notification insert. A live D1 query for rows whose `body`
  matches the harness pattern or whose `actor_id` points at deleted users returned **0 rows**.
  Nothing to clean; earlier full runs left no notification debris.
- **Full authenticated run against the live Worker** (`node cf-api/tools/diff-routes.mjs --prod-direct
  --worker-live`, log `/workspaces/cf-run/diff-postflip-full.log`): Phase A 149/149 clean again;
  Phase B exercised the real surface — throwaway registration 201, email verify, admin promotion,
  stale-vs-fresh token `/me` 401/200, multipart avatar upload round-trip, admin-ops GET sweep
  (15 paths: 11×2xx, 4×4xx, 0×5xx), Worker-side rate-limit 429 envelope.
  **DEFECTS: 0, BLOCKERS: 0; 152/250 production requests used.**
- **CLEANUP verified:** throwaway user 38 deleted, proof query returns 0 rows; the one left-behind
  object (`uploads/avatars/38-dc017a07c9ae119e.png` in R2) was deleted via
  `wrangler r2 object delete professionalist-media/…`.

- API-side rollback readiness: `cutover.mjs --rollback` (DELETE the Worker domain + re-POST
  `api-dns-record.json`) now works with the fresh token. Dashboard rollback remains possible without one: Workers & Pages
  → `professionalist-api` → Settings → Domains & Routes → remove `api.proffessionalist.com`, then
  re-create the saved proxied A record from `/workspaces/cf-run/api-dns-record.json` (mode 600).

**Operator items carried forward:** THREE tokens have now appeared in chat/transcripts — §5.9's
original, the flip-time one (since dead), and the fresh one supplied 2026-10-20 — rotate all after
this work stream closes; the R2 S3 keys in `~/.qoder/tmp/d1move/` predate them all and are unchanged.


### 5.15 2026-10-20 (post-flip) — the SPA source arrived, merged with the videos/landing slice, and is now LIVE on `proffessionalist-web`

The missing `src/**` (§7 "SPA redesign phases") turned up at `professionalist/dist/brand/src/` —
the **full recovered source of the deployed SPA**: 52 files, all 24 pages + `pages/auth/*`,
`components/shell/*`, 3 contexts, `services/{api,config,endpoints,http,types}.ts`, `App.tsx`,
`main.tsx`. The owner directed that these pages are the app ("THE OTHER PAGES ARE IN THE BRANDING
FOLDER IN SRC USE THEM"). The earlier hybrid dual-SPA plan (old bundle under `/legacy/` + routing
Worker script) is **superseded**: one merged source tree builds one bundle.

**Merge (in `src/`):**
- `brand/src` copied over the vertical-slice tree; the 5 colliding files resolved as: old wins for
  `services/http.ts`, `context/AuthContext.tsx`, `hooks/useAsync.ts`, `index.css`; **new wins for
  `pages/LandingPage.tsx`** (the editorial landing, docs/landing-page.md).
- Deleted the now-unconsumed shim layer: `services/{admin,auth,feed,jobs,market,messages,meta,
  notifications,onboarding,settings,social,tasks}.ts`, `types/api.ts`, `hooks/useSession.ts`,
  `components/ui/`, `lib/cn.ts` (the videos subtree never imported them — it talks only to
  `services/videos.ts` → `videoHttp.ts`, and the landing subtree is self-contained).
- Old CSS kept as the base: it already defines `--ring`, `.card`, `.skeleton`, `.anim-*` — everything
  the videos components reference by class name. `src/landing/landing.css` ships with the landing page.

**Seam edits (the only behavior changes to old files):**
- `services/http.ts` `tokenStore.access/refresh` now read localStorage **on every access** (and
  `request()` sources the Bearer header from it). Both transports rotate the same
  `professionalist.token`/`professionalist.refresh` keys; the old module-level cache would serve a
  stale refresh token after a video-side rotation and end the session.
- `services/videoHttp.ts` exports `notifySessionExpired()`.
- `main.tsx` bridges the app-side broadcast into the video listener set.
- `context/AuthContext.tsx` subscribes to **both** session-expired sets (dedupe window on the toast,
  since the bridge means one expiry can reach it twice).
- `App.tsx`: `/videos`, `/videos/create`, `/videos/interests` under `AppShell`+`RequireAuth`;
  `/videos/admin` under `RequireAdmin` → `VideoAdminPanel`; `VideoAppBridgeInstaller` injects the real
  session into `configureVideoApp` (getSession from `useAuth`, `requireLogin` → `/login?next=`,
  `toggleFollow` → `networkApi.follow/unfollow`). `reportVideo`/`blockUser` deliberately keep the
  honest `notWired` defaults — the backend has no public reports intake (feature-inventory §7) and
  the app owns no block route for videos.
- `pages/auth/LoginPage.tsx` now honors `?next=` (in-app paths only) in addition to `state.from`.
- `shell/nav-items.tsx`: Videos (Clapperboard) in PRIMARY_NAV and MOBILE_NAV. PWA: manifest gains a
  Videos shortcut; `sw.js` VERSION bumped to `professionalist-v2` so `activate` purges v1 caches.

**Build:** `VITE_API_URL=https://api.proffessionalist.com VITE_APP_URL=https://proffessionalist.com
npx vite build --outDir /workspaces/cf-run/spa-build --emptyOutDir`. `tsc --noEmit` exit 0 over the
merged tree (strict + noUnusedLocals). The repo `dist/` stays untouched as the prod mirror / rollback tree.

**Deploy — `proffessionalist-web` (assets-only Worker, custom hostnames proffessionalist.com + www):**
generated config `/workspaces/cf-run/web-deploy/wrangler.web.toml` (never committed), two failures
recorded on the way:
1. first attempt shipped `public/brand/src/**.tsx` (the recovered source had been copied into
   `public/` along with the brand PNGs) and Cloudflare **rejected publishing** the old
   `/* /index.html 200` `_redirects` with code 100324 "Infinite loop detected" — the version never
   went live and prod was unaffected. Fix: delete `public/brand/src`, drop `_redirects` entirely.
2. assets-only without fallback → deep links 404. Fix: `[assets] not_found_handling =
   "single-page-application"` in the deploy config.

Version `54eabc27-a0a9-4b61-92a6-ce2930536f79` live. Verified from the edge: `/`, `/home`, `/videos`,
`/videos/create`, `/login`, `/marketplace`, `/admin`, `/settings`, `/nonexistent-page-xyz` all 200
serving the new entry `assets/index-bBUkfHt9.js` on **both apices**; `sw.js` reports v2; manifest,
robots, brand PNGs 200; `/brand/src/App.tsx` returns the SPA shell — no source exposure.

**Rollback:** same config with `directory = "<repo>/professionalist/dist"` (verified byte-identical to
pre-deploy prod — the live entry was captured as `index-kP6wg8PP.js` immediately before the flip of assets).

**Not verified:** interactive browser flows (login round-trip, feed scroll, upload) — no browser in
this environment; proof here is typecheck + build + edge HTTP behavior.

### 5.16 2026-10-20 — /videos now shows already-posted videos and gated embedded links (intake hook + backfill, LIVE)

Request: "make it so that the videos page also shows already posted videos and imbeded links."
The `/videos` feed reads only the `videos` table, so pre-existing mp4 posts and provider-link posts
were invisible there. Closed with one shared classifier plus two consumers.

* `app-new/services/videoKit.js`: `VIDEO_FILE` (`/uploads/**.mp4|webm|mov|m4v`) and
  `fromPostRow(post)` → `{kind, provider, canonicalUrl, mediaKey, embedUrl, thumbnailKey}` or null:
  an mp4 attachment becomes `upload/self`, else a `link_url` that passes `gateUrl()` becomes
  `link/<provider>`. Exported.
* `app-new/routes/spa/feed.js` — the overlay now carries `POST /posts` too. Authored on PORTED
  bytes (the `unnest→json_each` D1 fix at :84 must survive; overlay copies get no hand ports —
  `build.mjs` EXTRA_FILES comment says so). After the post INSERT: plain public unscheduled posts
  are classified and enrolled as `approved`/`ok` unless `canonical_url` or `post_id` already exists;
  whole hook is try/catch (enrolment must never fail a committed post). `build.mjs` EXTRA_FILES
  gained the feed.js entry.
* `cf-api/tools/backfill-post-videos.mjs` (new): same `fromPostRow` via `createRequire` on
  `port/services/videoKit.js`, D1 HTTP pattern of apply-videos-schema.mjs (note: result rows are
  `j.result[0].results`, not `.rows`). Dry-run default, `--apply` INSERTs only
  (`ON CONFLICT (canonical_url) DO NOTHING`, `INSERT OR IGNORE` fallback). Idempotent by proof.
* Verification: build clean; `test-worker.mjs` 74/74; `test-videos.mjs` 48/48; redeployed
  `professionalist-api` (name re-checked against /workers/scripts first). Backfill live:
  27 candidate posts → 13 enrolled, 2 already indexed, then re-run dry = 0 to enrol / 15 indexed.
  Live `/api/videos/feed` via a throwaway session returned 4 items — the correct page under the
  max-2-per-author guard (the 13 clips belong to 2 authors); links: the 2 pre-existing `link_url`
  posts are weforum/verify domains the gate rejects by design, so links enrol prospectively.
  Hook proven end-to-end at the edge: probe POST /posts with an mp4 → 201 → videos row appeared in
  the feed. Cleanup proven: probe videos/post/2 users/auth_sessions/email_verification_tokens/
  security_events all deleted, residue scan across every `user_id`-bearing table returned only the
  pre-existing rows, `videos=15` (13 backfilled + the 2 original pending rows), `users=7`.
* Not verified: interactive browser scroll-through of /videos (no browser here) — edge HTTP + D1
  counts are the evidence.
* The VPS keeps no equivalent hook (mirror is read-only; rollback simply stops enrolling, it never
  un-indexes). Contract: docs/videos-api-contract.md "Automatic enrolment from posts".

### 5.17 2026-10-20 — enrolment switched to review-first: every auto-enrolled video lands as `pending`

Operator decision after §5.16 shipped: "All pending — admin reviews first." Nothing reaches the
videos feed until staff approve it in `/videos/admin`.

* Intake hook (`app-new/routes/spa/feed.js`) INSERT now writes `moderation_state='pending'`
  (comment updated); backfill tool (`backfill-post-videos.mjs`) INSERT changed to `'pending'` and
  its closing check now reports the index grouped by state instead of an approved count.
  Rebuilt (test-videos 48/48) and redeployed `professionalist-api`.
* Live D1: `UPDATE videos SET moderation_state='pending' WHERE moderation_state='approved'` —
  13 changes (all from the §5.16 backfill; no staff-approved row existed, so nothing intentional
  was demoted). Index now `pending:15, approved:0` → the videos feed is empty until a first
  approval, by design.
* Approving is the existing staff path (`/videos/admin` → the console's approve action, guarded by
  `requireStaff` on `users.role`); interactive browser use of the console is still unverified here.

### 5.18 2026-10-20 — feed endless scroll, working embeds, server-side mute/unmute + block, and a Following filter — LIVE on both Workers

One merged feature pass over five operator asks. Server half shipped first (safety routes, mutes
migration, feed filters, embedUrl DTO), client half (endless scroll, iframe facade, mute/block
wiring, Settings undo lists, Following chip) went with it; the `scope=following` clause arrived last
and is what the final rebuild + redeploy carried.

* **Schema**: `mutes(user_id, muted_id)` — migration `013_mutes.sql` in both dialects
  (`app-new/migrations/` for parity, `app-new/migrations-d1/` live; PK on the pair, FKs cascade to
  `users`, `CHECK user_id <> muted_id`). Applied to the live D1 (`CREATE TABLE IF NOT EXISTS`,
  additive only); verified present, 0 rows before probes.
* **Safety API** (`app-new/routes/spa/safety.js`, NEW so bare specifiers are fine): `GET /api/mutes`,
  `POST|DELETE /api/mutes/:userId` (self 400, unknown 404, idempotent insert), `GET /api/blocks`.
  Mounted INTO the single chain `app.use("/api", authenticate, userLimiter, safetyRoutes, spaRoutes,
  platformRoutes)` — a second `/api` line would double-count every request against the rate limiter.
  `POST/DELETE /api/blocks` were already live in `platform.js`; nothing duplicated, and the SPA's
  block button (which hit a `notWired` stub before) now calls them through the app bridge
  (`App.tsx` `blockUser` override). `reportVideo` stays unwired: no user-facing reports endpoint
  exists on either stack.
* **Feed exclusions, server-side, both feeds**: videos `PUBLIC_CLAUSE` and the `GET /posts/feed`
  WHERE list each gained `NOT EXISTS mutes` (one-way) and a symmetric `NOT EXISTS blocks`
  (two-way — first draft was wrong in one direction; the test caught it). Consequence: mute/unmute
  works from any surface on any device and hides creators from both feeds; blocking hides both ways.
* **Public `embedUrl`**: `toVideoItem` now ships `embedUrl`/`canonicalUrl` for `kind='link'` rows to
  every viewer (they are public provider URLs; uploads keep the admin-only rule). The player
  (`VideoPlayer.tsx`) renders a poster facade that swaps to a click-to-play provider iframe on the
  user gesture (`autoplay=1`, vimeo chrome params off, `allow` list + `allowFullScreen`); LinkedIn
  has `embed:null` by design and keeps the external-link treatment.
* **Endless scroll**: `/videos` was already cursor-paged (verified, no change). `HomePage.tsx`
  replaced the doubled-pageSize "Load older posts" trick with accumulating IntersectionObserver
  paging against the unchanged `page/pageSize` API — dedupe by post id, generation counter drops
  stale sort/kind answers, sentinel keeps the button as the visible fallback.
* **Following filter**: `GET /api/posts/feed?scope=following` narrows to creators the viewer follows
  (same `follows` table as the videos "following" tab); the feed page exposes it as a "Following"
  chip. `FeedFilters.scope` added client-side.
* **Settings**: new "Muted & blocked creators" section (`SafetyLists`) lists both server lists with
  Unmute/Unblock buttons — the "able to unmute" surface; the videos menu's mute toast now says
  "on every device", and a successful Block force-mutes (fixing a latent toggle bug).
* **Deploys**: `professionalist-api` redeployed twice this pass (safety/mutes build, then the
  `scope=following` rebuild — build.mjs EXTRA_FILES now carries videos/videoKit/feed/safety, feed.js
  authored on PORTED bytes); `proffessionalist-web` version `c94e097a-8762-42d7-9c94-64080b2ccbc6`
  (assets-only, 44 files, `not_found_handling="single-page-application"`, no `_redirects`).
  Deep links `/ /home /videos /settings /admin` all 200 and the served entry is the new
  `index-BHqVtI5z.js`.
* **Verification**: `test-videos.mjs` 61/61 (new §7b: approved youtube link carries `embedUrl` in
  the public feed; mute round-trip; dupe mute idempotent; muted creator vanishes from the videos
  feed; direct-inserted block hides both ways; `GET /api/blocks` one-way); `test-worker.mjs` 74/74
  (safety router stand-in + updated mount-order needle). Live: mute→feed-30→11→unmute→30 round-trip
  (earlier probe), then `probe-final.mjs` 10/10 — register probe, follow author 17,
  `scope=following` returned 19 posts all by author 17, link submit → own row approved in D1 →
  public feed item carried `embedUrl` (`https://www.youtube.com/embed/…`) and `canonicalUrl`;
  residue scan `{"u":0,"s":0,"f":0,"mu":0,"v":0,"p":0}` after deleting probe rows from
  users/auth_sessions/email_verification_tokens/security_events/profiles/follows/mutes/blocks/
  videos/posts.
* **Not verified here**: any interactive browser flow — iframe playback against real YouTube/Vimeo,
  the observer's live paging feel, Settings buttons, and the `/videos/admin` approve click-through.
  Type-level correctness + API responses only.
* **Operator actions**: the videos feed is EMPTY until staff approve the 16 pending rows in
  `/videos/admin` (by design, §5.17); and the three Cloudflare tokens that appeared in chat during
  this work stream must be rotated before it closes.

### 5.19 2026-10-20 — the admin queue never listed anything: the `$1`-shift bug, uncapped queue, LIVE

Operator report: a posted short (`youtube.com/shorts/atmjulQ0BkU`) "appears as a link in the feed,
not on the videos page", and the video admin review page "is not functioning". Both are one bug
plus one design flaw, and the enrolment itself was fine — live D1 had `videos` id 17,
`kind=link/provider=youtube`, canonical rewritten to `watch?v=…`, `embed_url` set, `pending`.

* **Root cause 1 — the parameter shift.** `videoKit.selectVideos` binds `[viewer, ...params]`, so
  `$1` in any caller WHERE clause is the viewer id. Three routes in `routes/spa/videos.js` built
  params with `builder()`, whose first `add()` returns `$1`:
  `GET /admin/index` (`v.moderation_state = $1` → TEXT vs integer id → **pending/approved/removed
  queues always empty**, only "all" worked); `GET /search` (every LIKE matched the viewer id →
  search found nothing); `GET /feed?tab=trending` (`created_at >= $1` with an int is always true in
  SQLite type order → the 7-day window silently off). The `/search` builder garbage line
  (`builder([videos.likeValue ? undefined : undefined]); b.params.length = 0;`) was residue of an
  earlier failed fix for the same thing.
  **Why tests missed it:** the harness only exercised the 403 path of `/admin/index` (requireStaff
  short-circuits before the route body) and never called `/search` or `?tab=trending` at all.
* **Fix:** a `routeParams()` helper in `videos.js` — same builder shape but numbering from `$2`,
  applied at all three call sites; `$1::bigint` viewer references untouched (they are the viewer).
* **Root cause 2 — the queue was capped, and so was reachability.** `rankedPage`'s
  `MAX_PER_AUTHOR=2` dedupe applied to the whole ranking window, for every consumer. The admin
  queue listed 2 per author out of 15+ rows; worse, over-ceiling rows were **unreachable via
  pagination** (19 approved clips by 2 authors answered `/videos` with 4 items). Fixes:
  `rankCandidates` takes a `perAuthor` option — admin index and search pass `Infinity` (a queue or
  lookup that hides rows is breakage, not diversity); and the feed's ceiling now *relaxes* when
  every other candidate has been taken (it shapes page order — 42,42,7,42 — instead of dropping
  content). `test-videos.mjs` gained section 7c (queue correct per state and complete for one
  author, search positive hits incl. same-author pairs, trending 7-day window actually excludes a
  30-day-old clip, for-you lists all of a lone author's approved clips) and the diversity-guard
  section was rewritten to pin the new ordering semantics. **70/70 + 74/74.**
* **Deploys:** `professionalist-api` redeployed twice in this pass (the `$2` fix, then the cap
  change); no schema changes. Client: `RequireAdmin` sent logged-out visitors to `/login?from=/admin`
  even from `/videos/admin` — now uses the live pathname; `proffessionalist-web` redeployed with it.
* **Live verification** (`/workspaces/cf-run/probe-admin.mjs`, temp admin = the probe's OWN users
  row elevated/deleted with residue scan `{"u":0,"s":0,"e":0,"ev":0,"pr":0,"vi":0}`): pending queue
  listed 2 of 2 pending (the operator had approved the rest via the console's "all" tab — which is
  how video 17 got approved, `changed:false` on our approve call proves it); approved queue listed
  19 of 19 including 17; `GET /api/videos/17` → `embedUrl https://www.youtube.com/embed/atmjulQ0BkU`;
  `GET /api/videos/feed?limit=30` → **19 items, video 17 at slot 5** (was 4 items before the cap
  fix); search/trending 200.
* **Still not verified here**: the browser experience of `/videos/admin` (now unblocked server-side)
  and iframe playback of the shorts embed. The `/videos` feed shows approved items only; 2 rows are
  still pending review in the console.
* Note the durable lesson: any consumer of `selectVideos` numbers parameters from `$2`; the contract
  doc says so, and the tests now cover the happy paths that were once only tested as 403s.

### 5.20 2026-10-20 — feed inline video players, pause/seek on every tile, and real support/ads/AI routers, LIVE

Operator asks: (1) embedded links on the feed must show the *video*, not a plain link card;
(2) embedded and direct videos must pause and seek; (3) "make every endpoint for support messages,
advertising and ai assistant".

* **Root cause of (3) — the routers never existed.** `src/services/api.ts` has always called
  `/api/support/*`, `/api/ads/*`, `/api/ai/*` (`endpoints.ts:142-159`), and the five D1 tables are
  live (`support_tickets/messages`, `ad_campaigns`, `ai_conversations/messages`), and the ported
  `spaDto` already exports matching `toTicket/toCampaign/toAiConversation` — but no router existed
  on either stack, so every call fell through to the catch-all 404 (`cf-api/src/api.js`). Fix: three
  overlay routers, NEW files (bare specifiers fine) — `app-new/routes/spa/support.js`,
  `ads.js`, `ai.js`, copied by `build.mjs EXTRA_FILES` and mounted into the ONE `/api` chain ahead
  of spa/platform, same ride-along pattern (and the same warning) as safety.js §5.18. Contracts,
  enums, the `from_user` 1=visitor/0=team convention, the TEXT-JSON audience/metrics handling, and
  the AI provider env are pinned in **`docs/surfaces-api-contract.md`**.
* **(1) is client-only:** `src/services/embeds.ts` `classifyLink()` mirrors the server's
  `videoKit` youtubeId/Vimeo regexes (youtube.com/watch|shorts|embed|live, youtu.be, vimeo.com/ID,
  player form); `PostCard.tsx` renders a matching link post as a 16:9 facade (provider thumb +
  play button) that swaps to the autoplay iframe on tap — the tap is the user gesture autoplay
  demands, same shape as `VideoPlayer.tsx`'s embed — with the "Watch on YouTube/Vimeo" link kept
  under the player; non-matching links (LinkedIn etc.) keep today's anchor card unchanged.
* **(2):** iframe embeds carry the provider's own pause/seek controls; the feed's *direct* videos
  in the 3-up `MediaGrid` secondary tiles rendered `<video>` **without `controls`** — now
  `controls playsInline preload="metadata"` (the primary tile had them all along). `/videos`
  already had pause + a seek bar (`VideoPlayer.tsx`); nothing changed there.
* **AI provider proxy:** `POST /api/ai/messages` inserts the user turn, calls an OpenAI-compatible
  `${AI_API_BASE}/chat/completions` (Worker global fetch, bearer `AI_API_TOKEN`, `AI_MODEL`,
  system prompt + last 20 turns, 20 s abort) and persists the assistant turn. Degradation is
  contractual: no key / non-2xx / timeout stores the fixed fallback reply and still answers 200.
  `ENV_HANDOFF` grew `AI_API_BASE/AI_MODEL/AI_API_TOKEN` (test-worker census + wrangler.toml
  comments updated); `deploy.mjs` uploads `AI_API_TOKEN` from `~/.qoder/tmp/d1move/ai_token.txt`
  **only if that file exists**, value piped on stdin, never printed. The operator uploaded a
  DeepSeek key mid-pass (it had briefly sat in the repo as `professionalist/api_token_ai` — moved
  into the secure store and removed from the repo, which is the §8 rule about keeping credentials
  out of the untracked tree). **Live state: the key is valid but the DeepSeek account answers
  402 Insufficient Balance, so live replies are the fallback until the balance is topped up — no
  code change needed.** Defaults point at `api.deepseek.com/v1`/`deepseek-chat`.
* **Tests:** new `cf-api/tools/test-surfaces.mjs` — **39/39** — and it follows the §5.19 lesson:
  happy paths, not just 403s. Support create→list→owner reply→staff reply flips `fromUser` and
  moves the ticket to pending, stranger 404s, availability shape; ads create→patch(status)→list
  with the audience TEXT-JSON round-trip, bad enum/negative budget 400s, other-user 404s, one-field
  patch leaves the stored audience untouched; AI keyless fallback persists, a **local fake
  OpenAI-compatible server** exercises the real proxy path (bearer/model/system+history asserted),
  provider 5xx still stores the fallback, thread stays continuous, delete cascades, strangers 404.
  `test-videos.mjs` 70/70; `test-worker.mjs` **77/77** after adding the three port stand-ins +
  mount-reach probes + the new mount-order needle; SPA `tsc --noEmit` clean.
* **Deploys:** `professionalist-api` — preflight 67 scripts, `professionalist-api EXISTS` (ours),
  `--allow-overwrite`; secrets JWT_SECRET/MAILER_API_TOKEN/OPS_OWNER_ID/**AI_API_TOKEN** uploaded;
  bindings/vars unchanged (`last-deploy.json` preview=false). `proffessionalist-web` redeployed
  from the generated config; live entry hash `index-CZbB9kgW.js` matches the local build and
  `/videos/admin`, `/settings`, `/home` deep links are 200.
* **Live verification** (`/workspaces/cf-run/probe-surfaces.mjs`, two throwaway accounts, full
  cleanup by user delete + residue scan `{"t":0,"c":0,"v":0,"u":0}` and zero orphan messages):
  all 21 checks passed — 401 without a session, ticket create/reply/list with `fromUser=true`,
  availability shape, campaign create with audience round-trip + live 400 on a bad enum +
  PATCH pause + own-only list, suggestions, conversation create with **fallback reply persisted
  (the 402 state above)**, second turn appended, 4-message thread, both cross-account 404 walls,
  and the report flows' create path (a `category:"report"` ticket from account B) answering 201.
* **Not verified here, honestly:** the browser experience — the feed iframe actually playing,
  pausing and seeking, and the new tiles' native controls — cannot be exercised from this
  environment; it is type-checked, built and served, and the logic mirrors the already-working
  `/videos` player. The assistant stays in fallback until the DeepSeek balance is topped up (or a
  funded key lands in `ai_token.txt` and `deploy.mjs` re-runs). **Reminder, strengthened: the
  Cloudflare API tokens must be rotated — a token fragment appeared in command output again during
  this pass (a malformed sed filter), on top of the three earlier exposures; and 2 video rows are
  still pending operator review in `/videos/admin`.**

### 5.21 2026-10-20 — video controls take two: pause sticks, the seek bar is reachable, embeds stop and take transport, LIVE

Operator report (again): "continue fixing the issues especially the video controls". Batch 3 shipped
feed embeds and native tile controls, but `/videos` itself was broken underneath — an audit found
five root causes, all client-side, all fixed in this pass:

* **Pause never stuck (every mp4 on `/videos`).** The autoplay effect in `VideoPlayer.tsx` listed
  `status` in its deps and called `el.play()` unconditionally while the slot was active: tapping
  pause flipped status to `"paused"`, the effect re-ran, playback resumed instantly. Fix: a
  `wantPlayRef` intent flag (user pause sets it false; slot deactivation, item change, unmute and
  retry reset it to true) and the effect now reads status through `statusRef`, never as a dep.
  The two stale-ref windows (item change, "Try again") set the ref inline.
* **The transport strip was covered.** `VideoCard.tsx`'s meta layer (`absolute inset-x-0 bottom-0
  z-20`, full width) sat over the player's bottom bar and swallowed every tap on the seek strip,
  times and Unmute. The container is now `pointer-events-none` with `pointer-events-auto` on the
  three things that need it (author button, caption More, VideoRail), and the player's bottom bar
  is `z-30` plus a `data-transport-zone` marker — the card's 550 ms long-press sheet now bails when
  the pointer starts inside that zone (scrubbing must not open the report sheet). Page toasts moved
  from `bottom-3` to `bottom-20` so they no longer sit on the strip.
* **The seek bar was invisible.** `VideoProgressBar.tsx`'s `input[type=range]` was `opacity-0`
  while the painted fill was `pointer-events-none` — nothing to aim at. The input is now the
  visible control: transparent track, white 14 px thumb via `[&::-webkit-slider-thumb]` /
  `[&::-moz-range-thumb]` arbitrary variants (thumb hidden while `disabled`), focus-visible ring,
  the 44 px strip still the hit target.
* **Embeds had no transport and misbehaved offscreen.** The transport registry only accepted
  `directPlayback`, so space / the desktop buttons were dead (`disabled={!transport}`) for
  YouTube/Vimeo slots. Now: `embedSrc` adds `enablejsapi=1&playsinline=1` (youtube) /
  `api=1&dnt=1&playsinline=1` (vimeo); a launched embed registers a postMessage transport
  (YouTube `{event:"command",func:"playVideo"|"pauseVideo"}`, Vimeo `{method:"play"|"pause"}`,
  targetOrigin = the frame's own origin; seek/duration are honest no-ops — the provider's own
  controls scrub). `embedLaunched` resets when the slot deactivates, so leaving unmounts the
  iframe (audio stops) and returning replays from a fresh gesture instead of a refused
  autoplay=1 remount. The feed's `LinkVideo` got the same treatment via an IntersectionObserver
  that drops it back to the facade below 30% visible.
* **Smaller holes:** keyboard ArrowLeft/ArrowRight seek ±5 s on `/videos` (guarded on
  `durationMs() > 0`, so embed transports skip instead of jumping to 0); the primary feed tile
  `<video>` (`PostCard.tsx:90`) gained `playsInline preload="metadata"` (iOS was opening the
  native fullscreen player).

No API change — nothing redeployed on `professionalist-api`. Client only:
`VideoPlayer.tsx`, `VideoCard.tsx`, `VideoProgressBar.tsx`, `VideosPage.tsx`, `PostCard.tsx`.

* **Verification:** `npm run typecheck` clean; `vite build` → entry `index-CCci_0SN.js`;
  `proffessionalist-web` redeployed (44 assets uploaded, wrangler output passed through
  `hideSecrets` with the env vars set *before* the command — the §5.20 sed mistake is the standing
  warning). Live: `https://proffessionalist.com/` serves `index-CCci_0SN.js`, deep links
  `/videos /home /settings` all 200.
* **Not verified here, honestly:** same caveat as §5.20 — tap-pause sticking, thumb dragging,
  space on a YouTube slot, the offscreen embed going quiet, iOS inline playback cannot be
  exercised from this environment; these are type-checked, built and served fixes of defects
  identified at exact lines in source.
* **Standing reminders (unchanged):** rotate the Cloudflare API tokens (4+ exposures on record);
  DeepSeek key answers 402 Insufficient Balance so the assistant stays in its fallback until the
  balance is topped up; 2 video rows still pending review in `/videos/admin`.

### 5.22 2026-10-20 — password-reset emails were never leaving the Worker: the https shim fired before `end(body)`, LIVE

Operator report: "there is an error with password reset emails". Diagnosis, step by step, because
every layer *looked* healthy until the logs were read:

* **API side is fine.** Live throwaway probe (`/workspaces/cf-run/probe-mail.mjs`, 10/10 twice,
  cleanup residue `{"u":0,"t":0,"s":0,"e":0}`): register → `POST /api/auth/forgot-password` answers
  the generic 200 and inserts a live `password_reset_tokens` row (expiry = created +60 min, so the
  pg→SQLite `NOW() + ($3 * INTERVAL '1 minute')` translation is correct); a minted known-plaintext
  token consumed through the real route → 204, old password 401, new password 200, spent token
  400. The operator's 09:49 token (user 32) sat unused — the email never arrived.
* **Mail Worker is fine.** `email.proffessionalist.com` (a **foreign-but-ours-account** script,
  `proffessionalist-email`) answers a direct signed `POST /send` with 200 + message_id; its source
  (read via the CF API, saved 0600 to `/workspaces/cf-run/email-worker-source.txt`, never
  committed) shows the reset template links `https://proffessionalist.com/reset-password?token=…`
  — a route the SPA really has. It sends through the Cloudflare Email Service binding
  (`env.EMAIL.send`), and the zone is enabled for Email Sending.
* **The bug was the bridge.** `wrangler tail` caught every send from the API Worker being
  rejected: `[mailer] rejected reset-password for … (400) {"error":"bad_json","message":"body
  must be valid JSON"}` — verify-email, reset-password and password-changed alike. Root cause:
  `cf-api/src/shims/https.js` — the fetch() stand-in that lets the VPS's `mailer.js` run
  byte-for-byte unedited — called `_send(options)` **in the constructor**. `https.request()`
  in Node buffers until `req.end(body)`, and `mailer.js:64` calls `end(body)` *after*
  construction, so the Worker always fired the POST with an **empty body**. The mail Worker
  parsed `""`, answered 400, the mailer short-circuits 4xx without retry, and every message died
  in a fire-and-forget `console.error` nobody read. (My direct curl had signed the same call by
  hand — which is exactly why the endpoint looked healthy.)
* **Fix:** the shim now stores the options at construction and sends on the first `end()` — the
  contract Node users get from `https.request`. One file, no mailer change (it must stay
  VPS-identical).
* **Regression coverage the migration had never had** — `cf-api/tools/test-mailer.mjs` (4 checks,
  the whole mail path against a local stand-in mail Worker): the full JSON body + auth +
  idempotency headers arrive verbatim at `end(body)` (this check FAILS with "Unexpected end of
  JSON input" on the old shim — verified by reverting and re-running), 4xx is tried once, 5xx is
  retried 3× with backoff, and a shim GET round-trips. Suites after the change: 4 + 77 + 70 + 39,
  all green.
* **Deploy:** `professionalist-api` redeployed 11:37:34Z (`deploy.mjs --allow-overwrite`,
  preview=false, bindings unchanged). Live proof in the same tail: the identical three sends went
  from `rejected … (400) bad_json` (11:29–11:30) to `sent … (200)` (11:37) for the probe account.
* **Known limitation, not papered over:** the mailer's retry sleep (1.5 s / 6 s between attempts)
  happens *outside* any tracked promise, so `background.drain()` resolves during the gap and a
  cold isolate can freeze mid-retry — attempt 1 is now reliable, attempts 2–3 are opportunistic.
  Left as-is deliberately: fixing it means either changing `mailer.js` (VPS-identity rule) or a
  per-request waitUntil grace window billed on every API response.
  **Superseded same day — §5.23 ships the grace window, armed only on retryable outcomes.**
* **Operator action needed:** the reset email from 09:49 was never delivered, so request a fresh
  one — it will arrive now. Final inbox delivery (spam folders, SPF) cannot be verified from this
  environment; the mail Worker accepted the message with a provider message_id, and
  `/email/sending/messages` history needs a token scope we do not have.
* **Standing reminders unchanged:** rotate the Cloudflare API tokens; DeepSeek 402 top-up; 2
  pending video rows.

### 5.23 2026-10-20 — mail retries now survive the isolate freeze: an armed quiet window in `background.js`, LIVE

* **What §5.22 left open:** `services/mailer.js:10` retries with `RETRY_DELAYS [0, 1500, 6000]`,
  and those between-attempt sleeps belong to no promise `background.track()` can see. After
  attempt 1 the queue looked empty, `drain()` returned, `ctx.waitUntil` finished, and the isolate
  could freeze before attempt 2's timer fired — so only the first try was dependable.
* **Design constraint honored:** `mailer.js` stays byte-for-byte the VPS file, and the grace window
  must not be billed on healthy responses. So the knowledge sits in the two Worker-owned files:
  `cf-api/src/shims/https.js` is the only party that sees an attempt's outcome, and
  `cf-api/src/background.js` owns the queue `worker.js` drains.
* **The fix:** `background.js` gains `armRetryWindow()` — a deadline `windowUntil` (default
  `RETRY_ARM_MS = 7700`, which covers the worst single gap: from a 5xx at t≈0 the third attempt
  fires at 1500+6000 = 7500 ms, and every further retryable outcome re-arms) — and `drain()` now
  returns only when the queue is empty **and** the window has passed; otherwise it sleeps out the
  remaining window and re-checks. The shim arms on exactly the outcomes that send `mailer.js` into
  another sleep: `response.status >= 500` in `_send` (checked before the body is read, so arming
  strictly precedes the tracked promise settling) and any transport failure / the mailer's own
  timeout in `_fail` (guarded by `if (this._started)` so a never-sent request cannot arm). 4xx
  does **not** arm, because `mailer.js:112` returns without retry there.
* **Cost, honestly bounded:** a healthy send pays nothing (no arming; `drain` returns as before —
  scenarios 1 and 2 assert this, including elapsed time). A send whose *final* attempt fails still
  holds the isolate ~7.7 s of post-response wall-clock after that attempt, because a re-arm can't
  know it was the last one; waitUntil wall-time is not billed CPU, so this is idle time, not cost,
  and it stays inside the 30 s request ceiling (`drain`'s own 20 s cap is untouched).
* **Harness:** `cf-api/tools/test-mailer.mjs` is now 5 checks — the new scenario 5 (server 503 then
  200, one `await drain(20000)`, expects both hits) **FAILS on the pre-fix code**, verified by
  neutralizing `armRetryWindow` and re-running (it returned after attempt 1: "saw 1 hit(s)").
  Scenario 2 additionally asserts a 4xx does not stall `drain`. Debugging note baked into the
  harness: the fresh-require filter must also clear `port/_shim/https.js`, not just
  `src/shims/https.js` — a cached forwarder silently keeps re-exporting the *first* scenario's
  shim wired to the first scenario's queue, which is how scenario 5 initially saw 0 hits.
* **Suites:** 5 + 77 + 70 + 39 all green after the change (`test-worker.mjs` boots the real
  `api.js`, so the armed window is exercised by every request it replays).
* **Deploy:** `professionalist-api` redeployed 11:51:38Z (`deploy.mjs --allow-overwrite`,
  preview=false, bindings unchanged: D1 `DB`, R2 `MEDIA`, DO `RATE_COUNTERS`, 4 vars + 4 secrets
  re-uploaded). Live sanity after: `probe-mail.mjs` 10/10 (throwaway user 50, full token
  lifecycle, reset mail accepted `sent (200)`), residue `{u:0,t:0,s:0,e:0}`. The retry path itself
  cannot be exercised against the real mail Worker from here — it answers 200 — so attempts 2–3
  survival rests on the node harness.
* **Operator action unchanged from §5.22:** request a fresh reset email; it will arrive.
* **Standing reminders unchanged:** rotate the Cloudflare API tokens (4+ exposures); DeepSeek 402
  top-up; 2 pending video rows.
* **2026-10-20 later — token rotation DONE (operator).** `/user/tokens/verify` with the stored
  token now returns 401 code 1000 "Invalid API Token", confirming the old token is dead — which
  also means every tool in `cf-api/tools/` is broken until the NEW token is written to the file
  `paths.mjs` resolves (here: `/home/codespace/.cf_token_tmp`, mode 600; override with
  `CF_TOKEN_FILE`).  The new value must reach that file from the dashboard directly — never
  through a chat message or a command line where it could be echoed or logged.  Account id is
  unchanged by rotation.  Remaining reminders: DeepSeek 402 top-up; 2 pending video rows.


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
- **Action for the operator — rotate the Cloudflare API tokens.** THREE have leaked into
  transcripts: §5.9's original, the flip-time one (owner already deadened it), and the fresh one
  supplied 2026-10-20 (pasted in chat). Rotate all after this work stream closes. Load the token as
  `export CLOUDFLARE_API_TOKEN=$(cat ~/.cf_token_tmp)` (or `paths.mjs`'s `readTrim`), never with
  `.`, and keep piping output through `hideSecrets`.
- **DONE 2026-10-20 ~07:50Z — the hostname flip.** `api.proffessionalist.com` is bound to the
  `professionalist-api` Worker via the managed-DNS path (§5.13); the VPS still runs as the rollback
  path. Post-flip verification: §5.14.
- **DONE 2026-10-20 — Phase B authenticated re-run + cleanup follow-ups (§5.14).** Fresh owner
  credentials unblocked everything: full `--prod-direct --worker-live` run finished
  **0 DEFECTS / 0 BLOCKERS**; the notification-debris suspicion was disproven by live query (the
  live message path inserts none); the orphan R2 avatar was deleted; `cutover.mjs --rollback` is
  executable with the current token. The authenticated surface is now proven end-to-end through the
  live Worker, not just the sandbox.
- **DONE 2026-10-20 — the SPA redesign phases (§5.15).** The recovered old-SPA source at
  `dist/brand/src/` is merged into `src/` (all 24 pages + videos/landing) and **deployed live** to
  `proffessionalist-web` → proffessionalist.com. `endpoints.ts` (what #20 replays) is back in the
  tree. Remaining frontend work is now ordinary feature development, not migration archaeology:
  browser-level interaction testing of the merged app (login flow, video feed, uploads) is still
  owed.
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
# post-flip differential (§5.14): --prod-direct = oracle is the VPS at 140.245.50.236:80 (Host: api.proffessionalist.com),
#   --worker-live = subject is the DEPLOYED Worker via the real hostname (edge headers env-allowed);
#   --phase-a-only = read-only phases when the CF API token is unavailable (Phase B must not run if its
#   D1 cleanup cannot run). Without flags the harness still compares the hostname (now the Worker) vs the
#   local sandbox — meaningless post-flip.
node cf-api/tools/diff-routes.mjs --prod-direct --worker-live [--phase-a-only]
# web frontend deploy (§5.15): merged SPA build → assets-only Worker proffessionalist-web.
#   config is GENERATED at /workspaces/cf-run/web-deploy/wrangler.web.toml (never committed);
#   not_found_handling="single-page-application" is what serves the deep links — do not add a
#   `/* /index.html 200` _redirects, Cloudflare refuses to publish it (code 100324, loop detection).
#   Rollback = same deploy with directory = the repo dist/ (byte-identical old prod tree).
cd professionalist && VITE_API_URL=https://api.proffessionalist.com VITE_APP_URL=https://proffessionalist.com \
  npx vite build --outDir /workspaces/cf-run/spa-build --emptyOutDir
npx --yes wrangler deploy -c /workspaces/cf-run/web-deploy/wrangler.web.toml
# move the production data and media (both idempotent, both additive/never-deleting)
node cf-api/tools/copy-data.mjs --dump=<pg_dump --data-only>   # 49 app tables/619 rows -> D1, ids preserved, sqlite_sequence repaired, FK-ordered (§5.7)
# the quiet-window refresh (§5.10): re-dump, then re-copy into the NON-EMPTY D1.
# pg_dump is not on the VPS host — it lives in the professionalist-postgres container, and the .env is
# parsed with sed (never `set -a; . .env`, which executes junk). --column-inserts is NOT usable here:
# readDump() parses COPY blocks. Output is mode 600 and its contents are never printed.
ssh -i ~/.ssh/professionalist-vps.key opc@140.245.50.236 'bash -s' < /tmp/vpsdump.sh > /workspaces/cf-run/prod-dump.sql.gz
node cf-api/tools/copy-data.mjs --dump=/workspaces/cf-run/prod-dump.sql.gz --dry-run --refresh  # read-only gates, prints what would refuse
node cf-api/tools/copy-data.mjs --dump=/workspaces/cf-run/prod-dump.sql.gz --refresh           # clears 49 tables (reverse FK order, self-FKs peeled) then re-inserts
node cf-api/tools/copy-data.mjs --dump=/workspaces/cf-run/prod-dump.sql.gz --counts --spot     # proof: counts equal, app query shapes correct
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
