/* Apply compat/schema.sql to a throwaway SQLite database and report anything that fails.
   node cf-api/tools/validate-schema.mjs */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const schemaPath = path.join(HERE, "..", "compat", "schema.sql");
const columns = JSON.parse(fs.readFileSync(path.join(HERE, "..", "compat", "columns.json"), "utf8"));
const schema = fs.readFileSync(schemaPath, "utf8");

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");

const failures = [];
for (const raw of schema.split(";\n")) {
  const body = raw.replace(/^\s*(?:--[^\n]*\n)+/, "").trim();
  if (!body) continue;
  try {
    db.exec(body);
  } catch (err) {
    failures.push({ stmt: body.slice(0, 120).replace(/\s+/g, " "), error: String(err.message || err) });
  }
}

console.log(`statements failed: ${failures.length}`);
for (const f of failures) console.log(`  ! ${f.error}\n    ${f.stmt}`);

const actualTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
console.log(`tables created: ${actualTables.length} / expected ${Object.keys(columns).length}`);
const missing = Object.keys(columns).filter(t => !actualTables.includes(t));
if (missing.length) console.log("  missing tables:", missing.join(", "));

let colMismatch = 0;
for (const [t, cols] of Object.entries(columns)) {
  if (!actualTables.includes(t)) continue;
  const have = db.prepare(`PRAGMA table_info("${t}")`).all().map(r => r.name);
  const want = cols.map(c => c.name);
  const miss = want.filter(w => !have.includes(w));
  const extra = have.filter(h => !want.includes(h));
  if (miss.length || extra.length) {
    colMismatch++;
    console.log(`  ! ${t}: missing [${miss.join(",")}] extra [${extra.join(",")}]`);
  }
}
console.log(`column-set mismatches: ${colMismatch}`);

const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
const inlineUnique = (schema.match(/^\s*UNIQUE \(/gm) || []).length;
console.log(`explicit indexes: ${idx.length}, inline UNIQUE constraints: ${inlineUnique}`);

const views = db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all().map(r => r.name);
console.log(`views: ${views.join(", ") || "(none)"}`);
for (const v of views) {
  try { db.prepare(`SELECT * FROM "${v}" LIMIT 1`).all(); console.log(`  view ${v} selects OK`); }
  catch (err) { console.log(`  ! view ${v} fails: ${err.message}`); }
}

/* exercise the semantics the routes rely on */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/* the four columns that were gen_random_uuid() in Postgres must now self-generate,
   so pull their DEFAULT expression straight out of the applied DDL and run it */
function balanced(text, open) {
  let depth = 0, quote = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === "'") quote = false; continue; }
    if (ch === "'") { quote = true; continue; }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}
const uuidDefaults = [];
for (const row of db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%randomblob%'").all()) {
  const re = /"([a-z_0-9]+)"\s+\w+\s+DEFAULT\s*\(/gi;
  let m;
  while ((m = re.exec(row.sql))) {
    const expr = balanced(row.sql, m.index + m[0].length - 1);
    if (expr && expr.includes("randomblob")) uuidDefaults.push({ table: row.name, col: m[1], expr });
  }
}

const probes = [
  ["timestamp default fills ISO text", `INSERT INTO audit_logs (action) VALUES ('probe') RETURNING id, created_at`, r => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(String(r.created_at))],
  ["ts lexical compare", `SELECT (strftime('%Y-%m-%dT%H:%M:%fZ','now') > '2020-01-01T00:00:00.000Z') AS ok`, r => r.ok === 1],
  ["case-insensitive like", `SELECT 'ABC' LIKE '%abc%' COLLATE NOCASE AS ok`, r => r.ok === 1],
  ["json roundtrip", `SELECT json_extract('{"a":1}', '$.a') AS ok`, r => r.ok === 1],
  ["array stored as json text", `SELECT count(*) AS ok FROM json_each('[1,2,3]')`, r => r.ok === 3],
  ["upsert", `INSERT INTO user_settings (user_id, data) VALUES (1, '{"theme":"dark"}') ON CONFLICT (user_id) DO UPDATE SET data = excluded.data`, () => true],
  ["view over seeded data", `SELECT * FROM conn_edges`, () => true],
];
for (const d of uuidDefaults) {
  probes.push([`uuid default ${d.table}.${d.col}`, `SELECT ${d.expr} AS a, ${d.expr} AS b`,
    r => UUID_RE.test(String(r.a)) && UUID_RE.test(String(r.b)) && r.a !== r.b]);
}
const wantUuid = [];
for (const [t, cols] of Object.entries(columns)) for (const c of cols) if (c.default === "uuid") wantUuid.push(`${t}.${c.name}`);
const haveUuid = uuidDefaults.map(d => `${d.table}.${d.col}`);
const noDefault = wantUuid.filter(w => !haveUuid.includes(w));
console.log(`uuid self-generating columns: ${haveUuid.length} / expected ${wantUuid.length}`);
if (noDefault.length) console.log(`  ! no DEFAULT for ${noDefault.join(", ")}`);
db.exec("INSERT INTO users (id, email, username, password_hash, status, account_type, role) VALUES (1, 'p@p.p', 'probe', 'x', 'active', 'individual', 'user')");
let probeFails = noDefault.length ? 1 : 0;
for (const [label, sql, check] of probes) {
  try {
    const rows = db.prepare(sql).all();
    const ok = rows.length === 0 || check(rows[0]);
    if (!ok) probeFails++;
    console.log(`  ${ok ? "ok " : "!  "} ${label}${rows.length ? " -> " + JSON.stringify(rows[0]).slice(0, 80) : ""}`);
  } catch (err) {
    probeFails++;
    console.log(`  !   ${label}: ${String(err.message || err).slice(0, 90)}`);
  }
}
console.log(`probe failures: ${probeFails}`);
db.close();
