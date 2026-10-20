/* Two things #18's db.js design rests on, measured rather than assumed.

   1. Which HTTP spelling of a D1 batch the REST API accepts.  The Worker calls env.DB.batch();
      our tools go through the REST surface, which is a different implementation.  Note the shape
      asymmetry this script looks for: REST returns ONE result object for a multi-statement batch
      while env.DB.batch() returns one per statement, so a tool that replays app SQL over REST
      cannot read back rows inserted by a later statement.

   2. Is a batch ATOMIC?  pool.connect()/client.query() in the Express app wraps several writes in
      BEGIN...COMMIT, and §5.2 says D1 refuses those.  db.js's answer is "buffer the writes, send
      one batch".  That is only safe if the batch really rolls back the earlier writes when a later
      one fails -- measured here, because "it is atomic" is exactly the assumption that silently
      corrupts data when wrong.

   SAFETY: every probe row is inserted into a table this script first verifies is EMPTY, and is
   deleted by id afterwards; the final census must show that table empty again or the run fails.
   Read-only phase first, writes only after the endpoint is known to exist.
   node cf-api/tools/d1-batch-probe.mjs [--no-write] */
import { readTrim, hideSecrets } from "./paths.mjs";

const TOKEN = readTrim("token");
const ACCT = readTrim("tmp", "acct.txt");
const DB_ID = readTrim("tmp", "d1-id.txt");
const SKIP_WRITE = process.argv.includes("--no-write");
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/d1/database/${DB_ID}`;

async function raw(ep, body) {
  const r = await fetch(`${API}/${ep}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: !!j.success, result: j.result, errors: hideSecrets(JSON.stringify(j.errors || [])) };
}
/* the REST envelope is result: [ {results, meta, success}, ... ] -- one entry per statement */
const q = async (sql, params) => {
  const r = await raw("query", params ? { sql, params } : { sql });
  if (!r.ok) throw new Error(`${r.status} ${r.errors.slice(0, 180)}`);
  return Array.isArray(r.result) ? r.result[0] : r.result;
};
/* every probe row is deleted by hand: the tool must leave the database exactly as it found it */
const cleanup = async () => {
  await q(`DELETE FROM search_history`).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'bp_probe'`).catch(() => {});
};

console.log("== 1. which endpoint accepts a batch? (SELECT only) ==");
const ONE = { sql: "SELECT 1 AS one" };
const batchEndpoints = [];
for (const [label, ep, body] of [
  ["POST /query       {sql}", "query", () => ONE],
  ["POST /query       {batch:[a,b]}", "query", () => ({ batch: [ONE, { sql: "SELECT 2 AS two" }] })],
  ["POST /batch       {batch:[a,b]}", "batch", () => ({ batch: [ONE, { sql: "SELECT 2 AS two" }] })],
  ["POST /query_batch {batch:[a,b]}", "query_batch", () => ({ batch: [ONE, { sql: "SELECT 2 AS two" }] })],
]) {
  const r = await raw(ep, body());
  console.log(`  ${label.padEnd(33)} -> HTTP ${r.status} success=${r.ok} ${r.ok ? "" : r.errors.slice(0, 90)}`);
  if (r.ok) batchEndpoints.push(label + `  [${ep}]`);
}
console.log(`  accepted: ${batchEndpoints.length ? batchEndpoints.join(" | ") : "NONE"}`);

console.log("\n== 2. does a batch run EVERY statement, and how many results come back? ==");
{
  /* a bad second statement proves the second statement was reached; the result shape proves what is returned */
  const bad = await raw("query", { batch: [ONE, { sql: "SELECT * FROM no_such_table_zz" }] });
  const good = await raw("query", { batch: [ONE, { sql: "SELECT 2 AS two" }] });
  const per = Array.isArray(good.result) ? good.result.length : 1;
  const rows = Array.isArray(good.result) ? good.result.map(r => JSON.stringify(r.results)) : [JSON.stringify(good.result?.results)];
  console.log(`  [SELECT 1 ; SELECT <missing table>]  -> HTTP ${bad.status} error=${bad.errors.slice(0, 80)}`);
  console.log(`  [SELECT 1 ; SELECT 2]                -> success=${good.ok} result objects=${per}: ${rows.join(" , ").slice(0, 90)}`);
  console.log(`  => every statement ${bad.ok ? "DID NOT" : "DID"} run; ${per === 2 ? "one result object per statement is returned (same shape as env.DB.batch)" : `only ${per} result object comes back for 2 statements`}`);
  console.log(`     (if the shapes differ, do not port replay code from REST to Worker by analogy)`);
}

if (SKIP_WRITE) { console.log("\n--no-write: skipping the atomicity measurement"); process.exit(0); }

let verdict = "not measured";
console.log("\n== 3. atomicity: does a failing last statement roll back the earlier write? ==");
const TABLE = "search_history";
const PROBE = "bp_probe";
const baseline = (await q(`SELECT COUNT(*) AS n FROM ${TABLE}`)).results[0].n;
const usersBase = (await q(`SELECT COUNT(*) AS n FROM users`)).results[0].n;
if (baseline !== 0 || usersBase !== 0) {
  console.log(`  ABORT: ${TABLE}=${baseline} rows, users=${usersBase} rows; this probe only runs against empty tables`);
  process.exit(1);
}
const uid = (await q(`INSERT INTO users (username,email,password_hash,name,status,account_type)
  VALUES ('${PROBE}','bp@probe.invalid','h','P','active','individual') RETURNING id`)).results[0].id;
const dupSql = `INSERT INTO users (username,email,password_hash,name,status,account_type)
  VALUES ('${PROBE}','bp2@probe.invalid','h','X','active','individual')`;

/* positive control: a batch of two good writes must leave TWO rows.  Without it, "0 rows survived a
   failed batch" cannot be told apart from "D1 validated the batch and never executed any of it". */
{
  const ok = await raw("query", { batch: [
    { sql: `INSERT INTO ${TABLE} (user_id,term) VALUES (?,?)`, params: [uid, "control a"] },
    { sql: `INSERT INTO ${TABLE} (user_id,term) VALUES (?,?)`, params: [uid, "control b"] },
  ] });
  const n = (await q(`SELECT COUNT(*) AS n FROM ${TABLE}`)).results[0].n;
  console.log(`  control  [2 good inserts] -> success=${ok.ok}, rows=${n} ${n === 2 ? "(batch writes really execute)" : "(!! only part ran -- read the atomicity result with doubt)"}`);
  await q(`DELETE FROM ${TABLE}`);
  if (n !== 2) { console.log("  ABORT: the control did not commit, so a rollback result would be meaningless"); await cleanup(); }
}

/* the test: a write that must succeed, then one that must fail on a UNIQUE constraint at run time */
{
  const b = await raw("query", { batch: [
    { sql: `INSERT INTO ${TABLE} (user_id,term) VALUES (?,?)`, params: [uid, "atomic probe"] },
    { sql: dupSql },
  ] });
  const survived = (await q(`SELECT COUNT(*) AS n FROM ${TABLE}`)).results[0].n;
  const why = b.errors.slice(0, 80);
  console.log(`  test     [good insert, UNIQUE-violating insert] -> success=${b.ok} error=${why}`);
  console.log(`           rows left in ${TABLE} = ${survived}`);
  const constraintFired = /UNIQUE constraint failed/i.test(b.errors);
  verdict = !constraintFired
    ? `INCONCLUSIVE: the batch failed for a reason other than the constraint (${why})`
    : b.ok ? "NOT ATOMIC: the batch reported success and skipped the failing statement"
    : survived === 0 ? "ATOMIC: the good write rolled back with the failing one"
    : "NOT ATOMIC: the good write survived a later failure";
  console.log(`  => ${verdict}`);
}

await cleanup();
const cleaned = (await q(`SELECT COUNT(*) AS n FROM ${TABLE}`)).results[0].n;
const usersLeft = (await q(`SELECT COUNT(*) AS n FROM users`)).results[0].n;
console.log(`  cleanup: ${TABLE} rows=${cleaned}, users rows=${usersLeft} (both must be 0)`);
if (cleaned !== 0 || usersLeft !== 0) {
  console.log("  !! probe rows survived -- clean them by hand before trusting the census elsewhere");
  process.exit(1);
}
console.log(`\nendpoints accepting a batch: ${batchEndpoints.length ? batchEndpoints.join(" | ") : "NONE"}`);
console.log(`atomicity verdict: ${verdict}`);
