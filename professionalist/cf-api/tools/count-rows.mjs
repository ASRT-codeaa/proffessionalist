/* Read-only census: how many rows does each table of the live D1 hold?
   Used to prove that a schema change can be landed without touching user data. */
import fs from "node:fs";
import path from "node:path";
import { readTrim, hideSecrets } from "./paths.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.join(HERE, "..");

const TOKEN = readTrim("token");
const ACCT = readTrim("tmp", "acct.txt");
const DB_ID = readTrim("tmp", "d1-id.txt");
const hide = hideSecrets;

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

const master = await q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' ORDER BY name");
const tables = master.results.map(r => r.name);
console.log(`tables in the live database: ${tables.length}`);
if (!tables.length) {
  console.log("VERDICT: database holds no tables - nothing to lose by applying a fresh schema");
  process.exit(0);
}

let total = 0, nonEmpty = [];
const CHUNK = 4; /* D1's SQLITE_LIMIT_COMPOUND_SELECT is low - 20 terms is refused */
for (let i = 0; i < tables.length; i += CHUNK) {
  const slice = tables.slice(i, i + CHUNK);
  const sql = slice.map(t => `SELECT '${t}' AS tbl, (SELECT COUNT(*) FROM "${t}") AS n`).join(" UNION ALL ");
  const res = await q(sql);
  for (const r of res.results) {
    total += Number(r.n);
    if (Number(r.n) > 0) nonEmpty.push(`${r.tbl}=${r.n}`);
  }
}
console.log(`rows: ${total} across ${tables.length} tables`);
console.log(`non-empty tables: ${nonEmpty.length ? nonEmpty.join(", ") : "(none)"}`);
console.log(nonEmpty.length
  ? "VERDICT: the live database holds data - any schema rebuild here needs explicit approval"
  : "VERDICT: every table is empty - a fresh schema can be landed without touching user data");
