/* Validate the pg->D1 adapter and every hand-port replacement against the LIVE D1 database.

   Why this exists: §6's adapter and its replacement SQL were proven only against local
   node:sqlite. D1 differs in ways that matter (§5.2: sqlite_version() refused, a JS boolean
   param stored as the string "true", pragma functions unauthorized), and #18's remaining
   unknowns can only be closed remotely — batch atomicity (the pool.connect() design),
   DELETE+RETURNING with params, the measured breadth of INSERT OR IGNORE, the 5 hand-ports,
   int8/boolean decode parity, and the sqlite_sequence repair #22 depends on.

   SAFETY: the target database is verified empty (count-rows: 0 rows across 50 tables). This tool
   seeds a labelled probe graph, deletes exactly what it inserted, then re-censuses all 49 app
   tables and refuses to report success unless the database is back to 0 rows. No DDL is altered
   and no production service is touched.
   node cf-api/tools/verify-live.mjs [--keep] */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { readTrim, hideSecrets } from "./paths.mjs";

const require = createRequire(import.meta.url);
const compat = require("../src/pg-compat.js");

const TOKEN = readTrim("token");
const ACCT = readTrim("tmp", "acct.txt");
const DB_ID = readTrim("tmp", "d1-id.txt");
const KEEP = process.argv.includes("--keep");
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/d1/database/${DB_ID}`;
const columnsJson = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "compat", "columns.json"), "utf8"));
const kinds = compat.loadColumnKinds(columnsJson);

async function send(endpoint, body) {
  const r = await fetch(`${API}/${endpoint}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`${r.status} ${hideSecrets(JSON.stringify(j.errors || j)).slice(0, 200)}`);
  return j.result;
}
const q = async (sql, params) => (await send("query", params ? { sql, params } : { sql }))[0];
/* run a Postgres statement through the real adapter, then execute the translated SQL remotely */
const pg = async (text, params) => {
  const t = compat.translateSql(text, params);
  const res = await q(t.sql, compat.encodeParams(t.params));
  return { t, res, err: null };
};
const note = (name, ok, detail) => {
  if (ok) { PASS++; console.log(`  ok    ${name}${detail ? ` -> ${String(detail).slice(0, 130)}` : ""}`); }
  else { FAILS.push(name); console.log(`  FAIL  ${name}${detail ? ` -> ${String(detail).slice(0, 170)}` : ""}`); }
};
let PASS = 0;
const FAILS = [];
/* sqlite_master object names captured before the first write; the cleanup re-diffs against this */
let objectsBefore = new Set();
/* every row this tool inserts, remembered with the exact WHERE clause that removes it */
const inserts = [];
const remember = (table, where, params) => inserts.push({ table, where, params });

async function census() {
  const tables = Object.keys(columnsJson);
  let total = 0;
  const nonEmpty = [];
  for (let i = 0; i < tables.length; i += 4) {
    const slice = tables.slice(i, i + 4);
    const r = await q(slice.map(t => `SELECT '${t}' AS tbl, (SELECT COUNT(*) FROM "${t}") AS n`).join(" UNION ALL "));
    for (const row of r.results) { total += Number(row.n); if (Number(row.n) > 0) nonEmpty.push(`${row.tbl}=${row.n}`); }
  }
  return { total, nonEmpty };
}

console.log("== baseline census (must be empty before we start) ==");
const base = await census();
note("starting state: 0 rows across all 49 app tables", base.total === 0, base.nonEmpty.join(",") || "empty");
if (base.total !== 0) {
  console.log("\nABORT: the live database already holds rows. This tool only runs against the empty\npre-cutover D1; it would risk real data. Stopping without writing anything.");
  process.exit(2);
}

try {
  /* every sqlite_master object that exists before we write anything, so DDL drift is a measured
     diff and not a remembered number -- sqlite creates sqlite_sequence the first time an
     AUTOINCREMENT table receives a row, and that is expected, not drift */
  objectsBefore = new Set((await q(`SELECT name FROM sqlite_master`)).results.map(r => r.name));

  /* ---------------------------------------------------------------- seed */
  console.log("\n== seed ==");
  const u1 = (await q(`INSERT INTO users (username,email,password_hash,name,status,account_type) VALUES ('zzprobe1','zzprobe1@example.invalid','x','Probe One','active','individual') RETURNING id`)).results[0].id;
  const u2 = (await q(`INSERT INTO users (username,email,password_hash,name,status,account_type) VALUES ('zzprobe2','zzprobe2@example.invalid','x','Probe Two','active','individual') RETURNING id`)).results[0].id;
  remember("users", "id IN (?,?)", [u1, u2]);
  const post = (await q(`INSERT INTO posts (user_id,content,media,hashtags) VALUES (?, ?, ?, ?) RETURNING id`,
    [u1, "probe body text", '["https://cdn.example/y.mp4"]', '["Probe","Hiring"]'])).results[0].id;
  remember("posts", "id = ?", [post]);
  const conv = (await q(`INSERT INTO conversations (subject) VALUES ('zz probe') RETURNING id`)).results[0].id;
  remember("conversations", "id = ?", [conv]);
  for (const uid of [u1, u2]) { await q(`INSERT INTO conversation_members (conversation_id,user_id) VALUES (?,?)`, [conv, uid]); }
  remember("conversation_members", "conversation_id = ?", [conv]);
  const msg = (await q(`INSERT INTO messages (conversation_id,sender_id,body) VALUES (?,?,?) RETURNING id`, [conv, u1, "probe message"])).results[0].id;
  remember("messages", "id = ?", [msg]);
  await q(`INSERT INTO user_settings (user_id,data) VALUES (?,?)`, [u1, '{"a":1}']);
  remember("user_settings", "user_id = ?", [u1]);
  await q(`INSERT INTO follows (follower_id,following_id) VALUES (?,?)`, [u1, u2]);
  remember("follows", "follower_id = ?", [u1]);
  console.log(`  users ${u1}/${u2}, post ${post}, conversation ${String(conv).slice(0, 8)}… (DDL-generated uuid), message ${msg}`);

  /* ---------------------------------------------------------------- 1. adapter */
  console.log("\n== 1. translated app SQL executed on the live engine ==");
  {
    const { t, res } = await pg(`SELECT COUNT(*)::int AS n FROM posts WHERE user_id = $1`, [String(u1)]);
    note("COUNT(*)::int + $1 placeholder", res.results[0]?.n === 1 && !/\$\d|::/.test(t.sql), `n=${res.results[0]?.n}`);
  }
  {
    const { res } = await pg(`SELECT date_trunc('week', created_at) AS wk FROM posts WHERE created_at > NOW() - INTERVAL '7 days'`);
    const wk = res.results[0]?.wk;
    note("date_trunc('week') -> Monday-start ISO", /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(String(wk)), `wk=${wk}`);
    const d = (await q(`SELECT strftime('%w', ?) AS dow`, [wk])).results[0].dow;
    note("  ...that date genuinely falls on a Monday on D1", d === "1", `strftime %w=${d}`);
  }
  {
    const { res } = await pg(`SELECT to_char(created_at,'YYYY-MM') AS m FROM posts`);
    note("to_char('YYYY-MM') -> strftime %Y-%m", /^\d{4}-\d{2}$/.test(String(res.results[0]?.m)), `m=${res.results[0]?.m}`);
  }
  {
    const { t, res } = await pg(`SELECT id FROM posts WHERE user_id = ANY($1::bigint[])`, [`[${u1}]`]);
    note("= ANY($1::bigint[]) -> IN (SELECT value FROM json_each(?))", res.results.length === 1 && /json_each/.test(t.sql), `rows=${res.results.length}`);
  }
  {
    const { t, res } = await pg(`SELECT media->0 AS thumb, hashtags FROM posts WHERE id = $1`, [String(post)]);
    note("json arrow -> json_extract (->>'k' handled identically)", /json_extract/.test(t.sql) && String(res.results[0]?.thumb).includes("y.mp4"), `thumb=${res.results[0]?.thumb}`);
  }
  {
    const { res } = await pg(`SELECT id FROM posts WHERE content ILIKE $1 ORDER BY created_at DESC NULLS LAST`, ["%PROBE%"]);
    note("ILIKE folded to LIKE + NULLS LAST rewritten in ORDER BY", res.results.length === 1, `rows=${res.results.length}`);
  }
  {
    const { t, res } = await pg(
      `INSERT INTO auth_sessions (user_id,token_hash,expires_at,label) VALUES ($1,$2,NOW() + ($3 * INTERVAL '1 second'),$4) RETURNING id, expires_at`,
      [String(u1), "f".repeat(64), "3600", "zz probe"]);
    const id = String(res.results?.[0]?.id ?? "");
    remember("auth_sessions", "id = ?", [id]);
    note("auth_sessions: NOW()+($n*INTERVAL) param form + uuid DDL default + RETURNING",
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) && /\+ |||seconds|strftime/.test(t.sql),
      `id=${id.slice(0, 13)}… expires=${res.results?.[0]?.expires_at}`);
  }

  /* ---------------------------------------------------------------- 2. hand-ports */
  console.log("\n== 2. the §6 hand-port replacements, executed on live D1 ==");
  {
    const r = await q(`WITH RECURSIVE g(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM g WHERE n < 11)
      SELECT strftime('%Y-%m', date('now', '-' || g.n || ' months')) AS month FROM g ORDER BY month`);
    const months = r.results.map(x => x.month);
    note("admin.js:146 generate_series(11,0,-1)+interval -> recursive CTE of 12 months",
      months.length === 12 && new Set(months).size === 12, `${months[11]} .. ${months[0]}`);
  }
  {
    const r = await q(`WITH RECURSIVE g(n) AS (SELECT 7 UNION ALL SELECT n-1 FROM g WHERE n > 0)
      SELECT strftime('%Y-%m-%dT00:00:00.000Z', date('now','-' || g.n || ' days'),'weekday 0','-6 days') AS wk FROM g ORDER BY wk`);
    const first = r.results[0]?.wk, last = r.results.at(-1)?.wk;
    const dows = await q(`SELECT strftime('%w', ?) AS a, strftime('%w', ?) AS b`, [first, last]);
    note("market.js:552 + social.js:532 week series -> 8 ISO week-Mondays",
      r.results.length === 8 && dows.results[0].a === "1" && dows.results[0].b === "1", `${first} .. ${last}`);
  }
  {
    const r = await q(`SELECT name AS t FROM sqlite_master WHERE type='table' AND name IN (SELECT value FROM json_each(?))`,
      ['["users","posts","does_not_exist"]']);
    note("ops.js:99 information_schema -> sqlite_master + json_each", r.results.length === 2, r.results.map(x => x.t).join(","));
  }
  {
    let merged = null, detail = "";
    try {
      const one = await q(`INSERT INTO user_settings (user_id,data) VALUES (?,json_object('a',1))
        ON CONFLICT(user_id) DO UPDATE SET data = json_patch(user_settings.data, excluded.data) RETURNING data`, [u1]);
      const two = await q(`INSERT INTO user_settings (user_id,data) VALUES (?,json_object('b',2))
        ON CONFLICT(user_id) DO UPDATE SET data = json_patch(user_settings.data, excluded.data) RETURNING data`, [u1]);
      merged = JSON.parse(two.results[0].data);
      detail = `after 1st=${one.results[0].data} after 2nd=${two.results[0].data}`;
    } catch (err) { detail = hideSecrets(String(err.message)).slice(0, 140); }
    note("chat.js:569 jsonb || merge -> json_patch keeps BOTH keys (the actual bug class)",
      merged?.a === 1 && merged?.b === 2, detail);
    const naive = await q(`SELECT json_object('a',1) || json_object('b',2) AS bad`);
    note("  ...and confirms SQLite || concatenates text (so pg's || really does need porting)",
      String(naive.results[0]?.bad).startsWith('{"a":1}{'), `naive=${naive.results[0]?.bad}`);
  }

  /* ---------------------------------------------------------------- 3. writes / txn */
  console.log("\n== 3. RETURNING, upsert caveats and batch atomicity ==");
  {
    const { t, res } = await pg(`DELETE FROM messages WHERE id = ANY($1::bigint[]) RETURNING id, body`, [`[${msg}]`]);
    note("ops.js:215 DELETE ... = ANY($1::bigint[]) RETURNING (batch-friendly)",
      res.results.length === 1 && res.meta?.changes === 1 && !/::|ANY\s*\(/.test(t.sql),
      `changes=${res.meta?.changes} returned=${res.results.length}`);
  }
  {
    const { t, res } = await pg(
      `INSERT INTO follows (follower_id,following_id) SELECT u.id, $1 FROM unnest($2::bigint[]) AS u(id) ON CONFLICT (follower_id,following_id) DO NOTHING`,
      [String(u1), `[${u2}]`]);
    const still = (await q(`SELECT COUNT(*) AS n FROM follows WHERE follower_id=?`, [u1])).results[0].n;
    note("SELECT-sourced ON CONFLICT DO NOTHING -> INSERT OR IGNORE, then runs",
      /INSERT OR IGNORE/i.test(t.sql) && still === 1, `notes: ${t.notes.join("; ").slice(0, 80) || "(none)"}`);
  }
  {
    /* §6 flags that INSERT OR IGNORE is BROADER than DO NOTHING. Measure it, don't assume it. */
    /* follows has 3 columns but created_at carries a DDL default, so the tuple is 2 values */
    const ignore = await q(`INSERT OR IGNORE INTO follows (follower_id,following_id) VALUES (?,?)`, [u1, u1]);
    const raising = await q(`INSERT INTO follows (follower_id,following_id) VALUES (?,?)`, [u2, u2]).catch(e => e);
    note("measured caveat: OR IGNORE silently swallows a NON-target failure (CHECK follower_id<>following_id)",
      ignore.meta?.changes === 0 && String(raising?.message ?? raising).includes("CHECK"),
      `OR IGNORE changes=${ignore.meta?.changes}; plain INSERT raised: ${String(raising?.message ?? "n/a").slice(0, 44)}`);
    if (ignore.meta?.changes) remember("follows", "follower_id=? AND following_id=?", [u1, u1]);
  }
  {
    /* the batch envelope lives on /query, not /batch -- an earlier draft of this test "passed" by
       reading a 404 Route-not-found as a rollback.  The error must name the constraint. */
    const before = (await q(`SELECT COUNT(*) AS n FROM search_history`)).results[0].n;
    let outcome = "unknown", detail = "";
    try {
      const r = await send("query", { batch: [
        { sql: `INSERT INTO search_history (user_id,term) VALUES (?,?)`, params: [u1, "committed only if atomic"] },
        { sql: `INSERT INTO users (username,email,password_hash,name) VALUES (?,?,?,?)`, params: ["zzdup", "zzdup@example.invalid", "x", "Dup"] },
        { sql: `INSERT INTO users (username,email,password_hash,name) VALUES (?,?,?,?)`, params: ["zzdup", "zzdup2@example.invalid", "x", "Dup2"] },
      ] });
      const n = (await q(`SELECT COUNT(*) AS n FROM search_history`)).results[0].n;
      outcome = n === before ? "committed-but-ignored-failure" : "partial";
      detail = `batch returned success (result objects=${Array.isArray(r) ? r.length : 1}) yet rows went ${before}->${n}`;
    } catch (err) {
      const msg = hideSecrets(String(err.message));
      const n = (await q(`SELECT COUNT(*) AS n FROM search_history`)).results[0].n;
      detail = `error=${msg.slice(0, 70)} rows ${before}->${n}`;
      outcome = !/UNIQUE constraint failed/i.test(msg) ? "failed-for-another-reason"
        : n === before ? "rolled-back" : "partial";
    }
    note("#18 pool.connect() design: a failing statement rolls the whole batch back (atomicity)",
      outcome === "rolled-back", `${outcome}: ${detail}`);
    if (outcome !== "rolled-back") {
      remember("search_history", "term = ?", ["committed only if atomic"]);
      remember("users", "username = ?", ["zzdup"]);
    }
  }

  /* ---------------------------------------------------------------- 4. decode + sequence */
  console.log("\n== 4. result decoding and sequence repair ==");
  {
    const r = await q(`SELECT id, created_at, username, verified FROM users WHERE id = ?`, [u1]);
    const hints = compat.resultHints(`SELECT id, created_at, username, verified FROM users`, kinds);
    const d = compat.decodeRows(r.results, hints)[0];
    note("int8 id decodes to a pg-shaped STRING (frontend compares with ===)",
      typeof d.id === "string" && /^\d+$/.test(d.id), `id=${JSON.stringify(d.id)} hint=${JSON.stringify(hints.id)}`);
    note("timestamptz decodes to a Date", d.created_at instanceof Date && !Number.isNaN(d.created_at.getTime()), `created_at=${String(d.created_at).slice(0, 33)}`);
    note("boolean decodes to a real JS boolean from stored 0/1", d.verified === false || d.verified === true, `verified=${JSON.stringify(d.verified)} raw=${JSON.stringify(r.results[0].verified)}`);
  }
  {
    const maxBefore = (await q(`SELECT MAX(id) AS m FROM users`)).results[0].m;
    await q(`INSERT INTO users (id,username,email,password_hash,name) VALUES (?,?,?,?,?)`, [987654, "zzprobe3", "zzprobe3@example.invalid", "x", "Probe Three"]);
    remember("users", "id = ?", [987654]);
    const seqBefore = (await q(`SELECT seq FROM sqlite_sequence WHERE name='users'`)).results[0]?.seq;
    await q(`UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM users) WHERE name='users'`);
    const nextId = (await q(`INSERT INTO users (username,email,password_hash,name) VALUES (?,?,?,?) RETURNING id`, ["zzprobe4", "zzprobe4@example.invalid", "x", "Probe Four"])).results[0].id;
    remember("users", "id = ?", [nextId]);
    note("#22 sequence repair: explicit ids then sqlite_sequence fix prevents id collision on cutover",
      Number(nextId) > 987654, `seq before fix=${seqBefore}, max id before=${maxBefore}, next id=${nextId}`);
  }
} catch (err) {
  FAILS.push("ABORT");
  console.log(`\n  ABORT  ${hideSecrets(String(err.message)).slice(0, 300)}`);
}

/* ---------------------------------------------------------------- cleanup */
console.log("\n== cleanup ==");
const CHILD_FIRST = ["messages", "search_history", "conversation_members", "auth_sessions", "follows", "user_settings", "saved_posts", "posts", "conversations", "users"];
for (const table of CHILD_FIRST) {
  for (const row of inserts.filter(i => i.table === table)) {
    try {
      const r = await q(`DELETE FROM "${row.table}" WHERE ${row.where}`, row.params);
      console.log(`  deleted ${r.meta?.changes} row(s) from ${row.table} (${row.where})`);
    } catch (err) { console.log(`  cleanup ${row.table} failed: ${hideSecrets(String(err.message)).slice(0, 90)}`); }
  }
}
if (KEEP) console.log("  --keep: skipping the final census");
else {
  const after = await census();
  note("final census: every app table back to 0 rows", after.total === 0, after.nonEmpty.length ? `non-empty: ${after.nonEmpty.join(",")}` : "empty");
  const nowNames = (await q(`SELECT name FROM sqlite_master`)).results.map(r => r.name);
  const added = nowNames.filter(n => !objectsBefore.has(n));
  const unexpected = added.filter(n => n !== "sqlite_sequence");
  note("no DDL drift: the only object gained is sqlite_sequence, created by the engine on first AUTOINCREMENT insert",
    unexpected.length === 0,
    `objects ${objectsBefore.size}->${nowNames.length}, added=${added.join(",") || "none"}, unexpected=${unexpected.join(",") || "none"}`);
  const leftover = await q(`SELECT name FROM sqlite_master WHERE name LIKE 'zz%' OR name LIKE '%probe%'`);
  note("no probe tables or indexes left behind", leftover.results.length === 0,
    leftover.results.map(x => x.name).join(",") || "none");
}

console.log(`\nVERDICT: ${PASS} passed, ${FAILS.length} failed${FAILS.length ? ` -> ${FAILS.join(", ")}` : ""}`);
console.log(FAILS.length
  ? "Some adapter or hand-port assumption does NOT hold on live D1. Fix it before writing db.js/#19."
  : "Adapter, hand-ports, batch atomicity, decode parity and sequence repair are now measured on live D1.");
process.exit(FAILS.length ? 1 : 0);
