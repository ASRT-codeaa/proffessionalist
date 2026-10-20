/* Apply app-new/migrations-d1/012_videos.sql to the real D1 database and verify.
   The DDL is read from the generated bundle manifest (port/compat/migrations-manifest.js), so this
   tool exercises Step 1's manifest merge end-to-end.  Idempotent: every statement is CREATE ... IF
   NOT EXISTS or INSERT ... ON CONFLICT DO NOTHING, so re-running is safe and touches nothing.

   node cf-api/tools/apply-videos-schema.mjs [--dry]

   Security: never print a token, the account id, or the D1 uuid.  Credentials are loaded by
   substitution only, and every error string passes through hideSecrets. */
import path from "node:path";
import { readTrim, hideSecrets } from "./paths.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.join(HERE, "..");

const TOKEN = readTrim("token");
const ACCT = readTrim("tmp", "acct.txt");
const DB_ID = readTrim("tmp", "d1-id.txt");
const hide = hideSecrets;

const manifest = await import(path.join(ROOT, "port", "compat", "migrations-manifest.js"));
const entry = (manifest.default || manifest).find(m => m.name === "012_videos.sql");
if (!entry) {
  console.error("012_videos.sql is not in port/compat/migrations-manifest.js — run `node cf-api/tools/build.mjs` first.");
  process.exit(1);
}

/* split the same way apply-schema.mjs and test-videos.mjs do */
const statements = entry.sql
  .split(";\n")
  .map(s => s.replace(/^\s*(?:--[^\n]*\n)+/, "").replace(/^--.*$/gm, "").trim())
  .filter(Boolean);

async function q(sql, attempt = 1) {
  let j;
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/d1/database/${DB_ID}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    j = await r.json();
    if (!j.success) throw new Error(`${r.status} ${hide(JSON.stringify(j.errors || j)).slice(0, 300)}`);
  } catch (err) {
    if (attempt < 4 && /timeout|network|fetch failed|5[0-9][0-9]/i.test(String(err.message))) {
      await new Promise(s => setTimeout(s, attempt * 700));
      return q(sql, attempt + 1);
    }
    throw err;
  }
  return j.result[0];
}

const VIDEOS_TABLES = [
  "videos", "video_topics", "video_interests", "video_activity",
  "video_rank_config", "video_sources", "video_discovery_log",
];

if (process.argv.includes("--dry")) {
  console.log(`would apply ${statements.length} statements (idempotent) to the D1 database`);
  process.exit(0);
}

/* D1's HTTP query endpoint accepts multiple statements joined by ';' in one call; send the DDL in
   one batch, then the seed INSERTs, and replay singly if a batch is refused. */
const ddl = statements.filter(s => /^(CREATE|PRAGMA)/i.test(s));
const seeds = statements.filter(s => /^(INSERT|UPDATE|DELETE)/i.test(s));

const applyGroup = async (label, stmts) => {
  if (!stmts.length) return;
  try {
    await q(stmts.join(";\n") + ";");
    console.log(`  ${label}: applied ${stmts.length} statement(s)`);
  } catch (batchErr) {
    console.log(`  ${label}: batch refused (${String(batchErr.message).slice(0, 120)}), replaying singly`);
    for (const stmt of stmts) {
      try {
        await q(stmt.endsWith(";") ? stmt : stmt + ";");
      } catch (err) {
        console.error(`  FAILED: ${String(err.message).slice(0, 200)}`);
        console.error(`  --> ${stmt.slice(0, 200).replace(/\s+/g, " ")}`);
        process.exit(1);
      }
    }
    console.log(`  ${label}: applied ${stmts.length} statement(s) one at a time`);
  }
};

await applyGroup("DDL", ddl);
await applyGroup("seeds", seeds);

/* verify: read sqlite_master, print ONLY table names (never data, never ids) */
const master = await q("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
const names = master.results.map(r => r.name);
console.log(`tables in D1: ${names.length}`);
console.log(`  ${names.join(", ")}`);

const missing = VIDEOS_TABLES.filter(t => !names.includes(t));
if (missing.length) {
  console.error(`MISSING video tables: ${missing.join(", ")}`);
  process.exit(1);
}

/* confirm the six rank weights seeded, printing only the count and sum, not per-key values */
const cfg = await q("SELECT COUNT(*) AS n, SUM(weight) AS total FROM video_rank_config");
const topics = await q("SELECT COUNT(*) AS n FROM video_topics");
console.log(`video_rank_config rows: ${cfg.results[0].n}, weight sum: ${Number(cfg.results[0].total).toFixed(3)}`);
console.log(`video_topics rows: ${topics.results[0].n}`);
console.log("OK: all 7 video tables present and idempotent.");
