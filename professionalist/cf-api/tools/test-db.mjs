/* Verify cf-api/src/db.js against a stand-in D1 binding built on node:sqlite + the real schema.

   Why a stand-in and not the live database: what is under test here is db.js's calling convention
   (parameter reorder, pg-shaped results, the BEGIN/COMMIT emulation, the hand-port guard), and the
   live D1 already gave its SQL verdict in §5.6.  The fake reproduces the binding's MEASURED shapes
   only -- prepare(sql).bind(...).all() -> {results, meta:{changes,last_row_id}, success}, and
   batch() as one atomic transaction -- so a divergence from real D1 is a bug in the fake, and the
   two are checked against each other by d1-batch-probe.mjs / verify-live.mjs.
   node cf-api/tools/test-db.mjs */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const db = require("../src/db.js");

const ROOT = path.join(import.meta.dirname, "..");
const sqlite = new DatabaseSync(":memory:");
/* live D1 enforces foreign keys (§5.2), so the stand-in must too or a whole class of
   route error handling is tested against an engine that does not exist */
sqlite.exec("PRAGMA foreign_keys = ON");
for (const stmt of fs.readFileSync(path.join(ROOT, "compat", "schema.sql"), "utf8")
  .split(";\n").map(s => s.replace(/^\s*(?:--[^\n]*\n)+/, "").trim()).filter(Boolean)) sqlite.exec(stmt);

/* ------------------------------------------------------------------ *
 * the D1 binding shape, as measured in §5.2/§5.6
 * ------------------------------------------------------------------ */
let batchDepth = 0;
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
  /* RETURNING must execute exactly once -- .all() both applies the write and yields the rows */
  if (/\bRETURNING\b/i.test(sql)) {
    const results = stmt.all(...bound);
    return { results, meta: { changes: results.length, last_row_id: 0 } };
  }
  const info = stmt.run(...bound);
  return { results: [], meta: { changes: Number(info.changes) || 0, last_row_id: Number(info.lastInsertRowid) || 0 } };
}
const env = { DB: { prepare: statement, async batch(stmts) {
  /* one atomic unit: any statement failing must leave none of them applied (§5.6) */
  sqlite.exec("BEGIN");
  batchDepth++;
  try {
    const out = [];
    for (const s of stmts) out.push(await s.all());
    sqlite.exec("COMMIT");
    return out;
  } catch (err) {
    sqlite.exec("ROLLBACK");
    throw err;
  } finally { batchDepth--; }
} } };

let PASS = 0; const FAILS = [];
const check = (name, ok, detail) => {
  if (ok) { PASS++; console.log(`  ok    ${name}${detail ? ` -> ${String(detail).slice(0, 110)}` : ""}`); }
  else { FAILS.push(name); console.log(`  FAIL  ${name}${detail ? ` -> ${String(detail).slice(0, 170)}` : ""}`); }
};
const throws = async (fn, test, name, detail) => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  const matches = typeof test === "function" ? !!test(err) : !!err && test.test(String(err.message));
  check(name, matches, err ? `threw: ${String(err.message).slice(0, 90)}` : "did not throw");
};

console.log("== surface ==");
check("the shape §6 inventories: { query, pool:{query,connect}, health }",
  typeof db.query === "function" && typeof db.health === "function" &&
  typeof db.pool === "object" && typeof db.pool.query === "function" && typeof db.pool.connect === "function",
  Object.keys(db).join(","));
check("query survives destructuring at import time (routes do const { query } = require(\"./db\"))",
  (() => { const { query } = db; return typeof query === "function"; })());
await throws(() => db.health(), /not initialised/, "before init() every call refuses rather than answering from no database");

db.init(env);
check("init(env) accepts the Worker env, not just a bare binding", typeof db.query === "function");
db.init({ DB: env.DB });

console.log("\n== plain queries: pg result shape and value parity ==");
{
  const r = await db.query(
    `INSERT INTO users (username,email,password_hash,name,status,account_type)
     VALUES ($1,$2,'h','N','active','individual') RETURNING id, created_at`, ["u1", "u1@x.invalid"]);
  check("insert ... returning -> rows + rowCount + command",
    r.rows.length === 1 && r.rowCount === 1 && r.command === "INSERT", `id=${JSON.stringify(r.rows[0].id)} command=${r.command}`);
  check("int8 id decodes to a string and timestamptz to a Date (the === trap)",
    typeof r.rows[0].id === "string" && r.rows[0].created_at instanceof Date,
    `${typeof r.rows[0].id}, ${Object.prototype.toString.call(r.rows[0].created_at)}`);
  var uid = Number(r.rows[0].id);
}
{
  /* the FK-enforcing engine needs real parents before the child rows below can mean anything */
  const second = await db.query(`INSERT INTO users (username,email,password_hash,name,status,account_type)
     VALUES ('u2','u2@x.invalid','h','Other','active','individual') RETURNING id`, []);
  var uid2 = Number(second.rows[0].id);
  const post = await db.query(`INSERT INTO posts (user_id,content) VALUES ($1,'body') RETURNING id`, [String(uid)]);
  var postId = Number(post.rows[0].id);
}
{
  const r = await db.query(`SELECT COUNT(*)::int AS n FROM users WHERE id = $2 OR id = $1`, [String(uid), String(uid)]);
  check("$2-before-$1 in the text reorders the params for bind()", r.rows[0].n === 1, `n=${r.rows[0].n} (${typeof r.rows[0].n})`);
  check("COUNT(*)::int comes back as a number, not a string", typeof r.rows[0].n === "number");
}
{
  const total = (await db.query(`SELECT COUNT(*)::int AS n FROM users`, [])).rows[0].n;
  const r = await db.query(`UPDATE users SET name = $1 WHERE id > $2`, ["Renamed", 0]);
  check("rowCount for a write is meta.changes, not rows.length",
    r.rows.length === 0 && r.rowCount === total, `rowCount=${r.rowCount}, users=${total}`);
}
{
  await throws(() => db.query(`INSERT INTO users (username,email,password_hash,name) VALUES ($1,$2,'h','dup')`,
    ["u1", "other@x.invalid"]), () => true, "a failing statement rejects the way pool.query does");
  let err = null;
  try { await db.query(`INSERT INTO users (username,email,password_hash,name) VALUES ($1,$2,'h','dup')`, ["u1", "other@x.invalid"]); }
  catch (e) { err = e; }
  check("the SQLite wording is mapped back to the pg SQLSTATE routes branch on",
    err && err.code === "23505", `code=${err && err.code}`);
  let fk = null;
  try { await db.query(`INSERT INTO posts (user_id,content) VALUES ($1,'x')`, ["999999"]); } catch (e) { fk = e; }
  check("and a foreign key violation maps to the pg 23503", fk && fk.code === "23503",
    `got code=${fk && fk.code} (${fk && String(fk.message).slice(0, 44)})`);
}

console.log("\n== the two transaction sites (BEGIN ... writes ... COMMIT) ==");
{
  const client = await db.pool.connect();
  await client.query("BEGIN");
  const d1 = await client.query(`INSERT INTO saved_posts (user_id, post_id) VALUES ($1, $2)`, [uid, postId]);
  const d2 = await client.query(`UPDATE users SET name = $1 WHERE id = $2`, ["Deferred", uid]);
  check("writes are deferred, not executed one by one", d1.rows.length === 0 && d2.rows.length === 0 &&
    d1.d1?.deferred === true && d2.d1?.deferred === true, `deferred=${d1.d1?.deferred}, ${d2.d1?.deferred}`);
  const before = (await db.query(`SELECT name FROM users WHERE id = $1`, [String(uid)])).rows[0].name;
  const savedCount = (await db.query(`SELECT COUNT(*)::int AS n FROM saved_posts`)).rows[0].n;
  check("nothing has landed before COMMIT", before === "Renamed" && savedCount === 0, `name still ${before}, saved_posts=${savedCount}`);
  const done = await client.query("COMMIT");
  check("COMMIT flushes the buffer as one batch", done.command === "COMMIT" && done.d1?.batched === 2,
    `batched=${done.d1?.batched}, touched=${done.rowCount}`);
  const after = (await db.query(`SELECT name FROM users WHERE id = $1`, [String(uid)])).rows[0].name;
  check("and the writes are visible afterwards", after === "Deferred", `name now ${after}`);
  client.release();
}
{
  /* the onboarding.js:172 pattern: a RETURNING whose value feeds the next insert */
  await throws(() => (async () => {
    const c = await db.pool.connect();
    await c.query("BEGIN");
    await c.query(`INSERT INTO skills (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, ["sql"]);
  })(), /needs hand port/, "INSERT ... RETURNING inside a transaction is named, not silently answered");
  await throws(() => (async () => {
    const c = await db.pool.connect();
    await c.query("BEGIN");
    await c.query(`SELECT id FROM skills WHERE name = $1`, ["sql"]);
  })(), /needs hand port/, "a read inside a transaction is named, not answered from the pre-transaction state");
}
{
  const c = await db.pool.connect();
  await c.query("BEGIN");
  await c.query(`INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)`, [uid, uid2]);
  await c.query("ROLLBACK");
  const n = (await db.query(`SELECT COUNT(*)::int AS n FROM follows`)).rows[0].n;
  check("ROLLBACK discards the buffered writes", n === 0, `follows rows=${n}`);
}
{
  const c = await db.pool.connect();
  await c.query("BEGIN");
  await c.query(`INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)`, [uid, uid2]);
  c.release();
  const n = (await db.query(`SELECT COUNT(*)::int AS n FROM follows`)).rows[0].n;
  check("release() with a transaction still open drops it, as pg does", n === 0, `follows rows=${n}`);
}
{
  const c = await db.pool.connect();
  await c.query("BEGIN");
  await c.query(`INSERT INTO skills (name) VALUES ($1)`, ["atomic-a"]);
  let err = null;
  try { await c.query(`INSERT INTO skills (name) VALUES ($1)`, ["atomic-a"]); } catch (e) { err = e; }
  await c.query("COMMIT").catch(() => {});
  const n = (await db.query(`SELECT COUNT(*)::int AS n FROM skills`)).rows[0].n;
  check("one duplicate inside the batch aborts the whole batch (§5.6 atomicity)",
    (err || n === 0) && n === 0, `error=${err ? "raised" : "none"}, skills left=${n}`);
  c.release();
}

console.log("\n== what the adapter had to guess at is reported, not hidden ==");
{
  const r = await db.query(`SELECT id FROM users WHERE username ILIKE $1 ORDER BY created_at DESC NULLS LAST LIMIT 5`, ["u%"]);
  check("ILIKE + NULLS LAST still answers", r.rows.length === 2, `rows=${r.rows.length} (both u-prefixed users)`);
  const before = db.notes.length;
  await db.query(`SELECT week FROM generate_series(NOW() - INTERVAL '7 weeks', NOW(), INTERVAL '1 week') d(week)`).catch(() => {});
  check("a construct the adapter refuses to translate lands in db.notes for the deploy log (timestamp generate_series is a hand port, not a translation)",
    db.notes.length > before && db.notes.some(n => /generate_series|postgres-ism/i.test(n)),
    `notes ${before} -> ${db.notes.length}: ${db.notes.slice(-1)[0] || ""}`.slice(0, 120));
}

console.log("\n== integer generate_series: the translator emits the recursive CTE ==");
{
  const r = await db.query(`SELECT value FROM generate_series(1, 3)`, []);
  check("ascending, bare form: every row addressable as value", r.rows.map(x => x.value).join(",") === "1,2,3",
    JSON.stringify(r.rows));
  const g = await db.query(`SELECT value FROM generate_series(11, 0, -1) AS g`, []);
  check("descending AS g: 12 rows from 11 down to 0, column still value",
    g.rows.length === 12 && g.rows[0].value === 11 && g.rows[11].value === 0, `${g.rows.length} rows: ${JSON.stringify(g.rows.map(x => x.value))}`.slice(0, 110));
  const d = await db.query(`SELECT week FROM generate_series(0, 6, 2) AS d(week)`, []);
  check("column-alias form d(week): the alias names the emitted column", d.rows.map(x => x.week).join(",") === "0,2,4,6",
    JSON.stringify(d.rows));
  const e = await db.query(`SELECT value FROM generate_series(5, 1, 2)`, []);
  check("start beyond stop with a positive step yields zero rows, not one stray 5", e.rows.length === 0, JSON.stringify(e.rows));
  /* the exact statement admin.js monthlySignups() runs */
  const m = await db.query(
    `SELECT to_char(month, 'YYYY-MM') AS ym
       FROM (SELECT date_trunc('month', NOW()) - (interval '1 month' * g) AS month
               FROM generate_series(11, 0, -1) AS g) m
      ORDER BY month`, []);
  const yms = m.rows.map(x => x.ym);
  const now = (await db.query(`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS ym FROM users WHERE username = 'u1'`)).rows[0].ym;
  check("the admin monthlySignups statement answers 12 oldest-first YYYY-MM keys on the stand-in D1",
    yms.length === 12 && yms.every(s => /^\d{4}-\d{2}$/.test(s)) && yms.join() === yms.slice().sort().join() && yms[11] === now,
    JSON.stringify(yms));
  check("and the keys are exactly the shape the sibling GROUP BY statement produces, so the Map join matches",
    now === new Date().toISOString().slice(0, 7) && m.rows[0].ym === (() => { const x = new Date(Date.UTC(now.slice(0, 4), now.slice(5, 7) - 1 - 11, 1)); return x.toISOString().slice(0, 7); })(),
    `oldest=${m.rows[0].ym} newest=${now}`);
  const before = db.notes.length;
  let perr = null;
  let prow = null;
  try { await db.query(`SELECT value FROM generate_series($1, 5) AS g`, ["1"]); prow = "answered"; } catch (err) { perr = err; }
  check("a parameterised generate_series is left alone and reported, never guessed into a CTE " +
        "(if it had been guessed, this would have ANSWERED rows instead of erroring)",
    prow === null && perr && /generate_series/.test(String(perr.message)) && db.notes.some(n => /generate_series/i.test(n)),
    `err=${perr && String(perr.message).slice(0, 60)}, notes has ${db.notes.filter(n => /generate_series/i.test(n)).length} generate_series entries (dedup cap, +${db.notes.length - before} new)`);
}

console.log("\n== the real onboarding.js upsert, inside a transaction ==");
{
  /* taken verbatim from routes/onboarding.js:141 -- the largest VALUES-sourced
     ON CONFLICT DO UPDATE in the app, and the one that must NOT be flagged as a hand port */
  const upsert = `INSERT INTO profiles
       (user_id, job_title, headline, company_name, bio, website, location,
        country, category, avatar_url, cover_url, interests, onboarding_done, visibility)
     VALUES
       ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::text[],'{}'),COALESCE($12,FALSE),'public')
     ON CONFLICT (user_id) DO UPDATE SET
       job_title = COALESCE($2, profiles.job_title),
       bio = COALESCE($4, profiles.bio),
       interests = COALESCE($11::text[], profiles.interests),
       onboarding_done = COALESCE($12, profiles.onboarding_done),
       updated_at = NOW()`;
  const c = await db.pool.connect();
  let flagged = null;
  try {
    await c.query("BEGIN");
    await c.query(upsert, [uid, "Engineer", "Acme", "bio text", null, null, "IN", "cat", null, null, ["a", "b"], true]);
  } catch (err) { flagged = String(err.message).slice(0, 90); }
  const committed = flagged ? null : await c.query("COMMIT");
  c.release();
  check("the app's big upsert defers cleanly instead of tripping the hand-port guard", !flagged, flagged || `batched=${committed?.d1?.batched}`);
  const p = flagged ? null : (await db.query(`SELECT job_title, interests, onboarding_done FROM profiles WHERE user_id = $1`, [String(uid)])).rows[0];
  /* pg returns a boolean column as a JS boolean, so that -- not the stored 0/1 -- is the parity target */
  check("and it landed, with the text[] param round-tripping and a bool decoding to a boolean",
    !flagged && p && p.job_title === "Engineer" && p.onboarding_done === true &&
    Array.isArray(p.interests) && p.interests.join(",") === "a,b",
    p ? `interests=${JSON.stringify(p.interests)} (${Array.isArray(p.interests) ? "array" : typeof p.interests}) done=${JSON.stringify(p.onboarding_done)}` : "no read (see above)");
}

console.log("\n== non-transactional binds of the types D1 has no parameter for (route diff, 2026-10-20) ==");
{
  /* The only text[] case this harness had was the onboarding upsert, which is DEFERRED into a batch
     and therefore encoded (db.js:118).  The single-statement path bound raw, so `routes/meta.js:29`'s
     `key = ANY($1::text[])` answered 0 rows on the Worker while pg answered 3 — a silently empty
     result, not an error, which is the worst kind to miss.  This is that query, on that path. */
  await db.query(`INSERT INTO app_content (key, value, updated_at) VALUES ($1, $2, $3)`,
    ["diff.banner", "hello", new Date("2026-10-20T00:00:00.000Z")]);
  const r = await db.query(`SELECT key, value FROM app_content WHERE key = ANY($1::text[])`,
    [["diff.banner", "absent.key"]]);
  check("a text[] bind on the single-statement path returns the row, the way pg does",
    r.rows.length === 1 && r.rows[0].key === "diff.banner" && r.rows[0].value === "hello",
    `${r.rows.length} rows: ${JSON.stringify(r.rows).slice(0, 80)}`);
  const d = await db.query(`SELECT key, updated_at FROM app_content WHERE key = $1 AND updated_at = $2`,
    ["diff.banner", new Date("2026-10-20T00:00:00.000Z")]);
  check("…and so does a Date bind, compared for equality against the stored ISO text",
    d.rows.length === 1, `${d.rows.length} rows, stored ${JSON.stringify(d.rows[0] && d.rows[0].updated_at)}`);
  const b = await db.query(`SELECT value FROM app_content WHERE key = ANY($1::text[])`, [["absent.key"]]);
  check("an array with nothing matching is still an empty result, not a throw",
    b.rows.length === 0 && b.rowCount === 0, `${b.rows.length}`);
}

console.log(`\nVERDICT: ${PASS} passed, ${FAILS.length} failed`);
if (FAILS.length) { for (const f of FAILS) console.log(`  - ${f}`); process.exit(1); }
console.log("db.js answers the surface §6 inventories, with pg's result shape, SQLSTATEs and transaction rules.");
sqlite.close();
