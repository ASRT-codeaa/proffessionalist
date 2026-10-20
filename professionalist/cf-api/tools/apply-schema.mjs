/* Apply compat/schema.sql to the D1 database and verify the resulting objects.
   node cf-api/tools/apply-schema.mjs [--dry]  (default target: remote D1) */
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

const schema = fs.readFileSync(path.join(ROOT, "compat", "schema.sql"), "utf8");
const statements = schema.split(";\n").map(s => s.replace(/^\s*(?:--[^\n]*\n)+/, "").trim()).filter(Boolean);

if (process.argv.includes("--dry")) {
  console.log(`would apply ${statements.length} statements to the D1 database`);
  process.exit(0);
}

const verifyOnly = process.argv.includes("--verify");
const before = await q("SELECT name, type FROM sqlite_master WHERE name NOT LIKE '_cf_%'");
const realObjects = before.results.length;
if (realObjects > 0 && !verifyOnly) {
  console.log(`database already holds ${realObjects} objects (${before.results.map(r => `${r.type} ${r.name}`).slice(0, 6).join(", ")}). Refusing to double-apply; use --verify to only check.`);
  process.exit(1);
}

const BATCH = 25;
const applyOne = async sql => { await q(sql); };
if (!verifyOnly) for (let i = 0; i < statements.length; i += BATCH) {
  const chunk = statements.slice(i, i + BATCH);
  try {
    await q(chunk.join(";\n") + ";");
    console.log(`  applied ${i + chunk.length}/${statements.length}`);
  } catch (batchErr) {
    /* a batch failed - replay one statement at a time to name the culprit */
    console.log(`  batch ${i + 1}-${i + chunk.length} failed (${String(batchErr.message).slice(0, 120)}), replaying singly`);
    for (const stmt of chunk) {
      try {
        await applyOne(stmt.endsWith(";") ? stmt : stmt + ";");
      } catch (err) {
        console.log(`  FAILED: ${String(err.message).slice(0, 200)}`);
        console.log(`  --> ${stmt.slice(0, 220).replace(/\s+/g, " ")}`);
        process.exit(1);
      }
    }
  }
}

/* D1's HTTP query endpoint rejects pragma table functions, so verify by reading
   sqlite_master DDL text and diffing it against compat/columns.json. */
const master = await q("SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE '_cf_%' ORDER BY type, name");
const byType = {};
for (const r of master.results) byType[r.type] = (byType[r.type] || 0) + 1;
console.log("objects:", Object.entries(byType).map(([t, n]) => `${t}=${n}`).join(", "));

const columns = JSON.parse(fs.readFileSync(path.join(ROOT, "compat", "columns.json"), "utf8"));
const ddlTables = master.results.filter(r => r.type === "table");
const ddlViews = master.results.filter(r => r.type === "view");
const problems = [];
for (const [t, cols] of Object.entries(columns)) {
  const row = ddlTables.find(r => r.name === t);
  if (!row) { problems.push(`${t}: absent in D1`); continue; }
  const body = row.sql.slice(row.sql.indexOf("(") + 1, row.sql.lastIndexOf(")"));
  let depth = 0, quote = null, parts = [], cur = "";
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  const have = parts.map(p => p.trim().match(/^"([a-z_0-9]+)"/i)?.[1]).filter(Boolean);
  const want = cols.map(c => c.name);
  const miss = want.filter(w => !have.includes(w));
  const extra = have.filter(h => !want.includes(h));
  if (miss.length) problems.push(`${t}: missing columns ${miss.join(",")}`);
  if (extra.length) problems.push(`${t}: unexpected columns ${extra.join(",")}`);
  if (!/PRIMARY KEY/i.test(row.sql)) problems.push(`${t}: no primary key`);
}
console.log(`tables in D1: ${ddlTables.length}, views: ${ddlViews.map(v => v.name).join(",") || "(none)"}`);
const extraTables = ddlTables.map(r => r.name).filter(n => !columns[n]);
if (extraTables.length) console.log(`  D1-only tables (not from our schema): ${extraTables.join(", ")}`);
console.log(`column-set diffs: ${problems.length}`);
problems.slice(0, 12).forEach(p => console.log("  ! " + p));
console.log(`named indexes in D1: ${master.results.filter(r => r.type === "index" && r.sql && !r.sql.startsWith("CREATE SQLITE_AUTOINDEX") && !r.sql.startsWith("sqlite_autoindex")).length}`);
