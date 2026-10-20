/* Replay every SQL string found in the backend through the translator and validate it against
   the real schema in a throwaway in-memory SQLite database.  Two stages:
     shape  -- prepare() only.  Catches syntax, unknown function/table/column and arity bugs.
               Bind-independent, so this is the real gate on the translator.
     data   -- execute with type-appropriate params (kind from compat/columns.json, allowed value
               from the schema's own CHECK (col IN (...))).  A data failure only counts as real if
               no rung of the param ladder gets through, so guessed-param noise cannot mask bugs.
   Nothing here touches production.  node cf-api/tools/test-pg.mjs [app-dir] */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { locate } from "./paths.mjs";

const require = createRequire(import.meta.url);
const compat = require("../src/pg-compat.js");

const ARGS = process.argv.slice(2).filter(a => !a.startsWith("--"));
const APP = ARGS[0] || locate("app");
const LADDER = process.argv.includes("--ladder");
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.join(HERE, "..");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.js$/.test(e.name) ? [p] : [];
  });
}

function sqlLiterals(src) {
  const out = [];
  const re = /(?:`((?:[^`\\]|\\[\s\S])*)`|'((?:[^'\\]|\\[\s\S])*)')/gs;
  let m;
  while ((m = re.exec(src))) {
    const text = (m[1] ?? m[2] ?? "").replace(/\\\$/g, "$").replace(/\\`/g, "`").replace(/\\\//g, "/");
    if (!/\b(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|BEGIN|COMMIT|ROLLBACK|GRANT|TRUNCATE)\b/i.test(text)) continue;
    if (/\$\{\s*\w/.test(text)) continue;
    if (!/^[\s\S]{10,}$/.test(text)) continue;
    out.push(text);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * schema knowledge: column kinds and enum CHECK domains
 * ------------------------------------------------------------------ */
const schemaSql = fs.readFileSync(path.join(ROOT, "compat", "schema.sql"), "utf8");
const columnsJson = JSON.parse(fs.readFileSync(path.join(ROOT, "compat", "columns.json"), "utf8"));
const kinds = compat.loadColumnKinds(columnsJson);

const kindOfTableCol = {};
for (const [table, cols] of Object.entries(columnsJson)) {
  for (const c of cols) kindOfTableCol[`${table}.${c.name}`] = c.kind === "int" && /bigint/i.test(c.pg) ? "int8" : c.kind;
}

/* one allowed value per enum-ish column, read off the generated CHECK (col IN ('a', 'b')) */
const enumOfTableCol = {};
{
  let table = null;
  for (const line of schemaSql.split("\n")) {
    const t = line.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][\w]*)"?\s*\(/i);
    if (t) table = t[1];
    const c = line.match(/CHECK\s*\(\s*"?([a-z_][\w]*)"?\s+IN\s*\(\s*'([^']+)'/i);
    if (c && table) enumOfTableCol[`${table}.${c[1]}`] = c[2];
  }
}

const PG_TYPE_KIND = {
  bigint: "int8", int8: "int8", integer: "int", int: "int", int4: "int", smallint: "int", serial: "int",
  numeric: "numeric", decimal: "numeric", real: "numeric", double: "numeric", float: "numeric",
  boolean: "bool", text: "text", varchar: "text", citext: "text", char: "text", name: "text",
  timestamptz: "ts", timestamp: "ts", date: "date", time: "ts", uuid: "uuid", json: "json", jsonb: "json",
};

const SAMPLE = {
  int: i => 100 + i,
  int8: i => String(100 + i),
  numeric: () => "1",
  bool: () => 1,
  ts: () => "2026-01-02T03:04:05.000Z",
  date: () => "2026-01-02",
  json: () => "{}",
  array: () => "[]",
  uuid: i => `00000000-0000-4000-8000-0000000000${String(i % 10)}`,
  text: () => "x",
};

function valueForKind(kind, i) {
  const fn = SAMPLE[kind] || SAMPLE.text;
  return fn(i);
}

/* ------------------------------------------------------------------ *
 * bind plan: one plausible value per placeholder
 * ------------------------------------------------------------------ */
function insertColumnMap(sql) {
  /* slot -> "table.col" for placeholders inside the first VALUES tuple of an INSERT */
  const m = sql.match(/\bINSERT\s+INTO\s+"?([a-z_][\w]*)"?\s*\(([^()]*)\)\s*(?:VALUES|SELECT)\s*\(/i);
  if (!m) return {};
  const cols = compat.splitTop(m[2]).map(c => c.replace(/^"|"$/g, "").trim());
  const open = m.index + m[0].length - 1;
  let depth = 0, close = -1;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close === -1) return {};
  const items = compat.splitTop(sql.slice(open + 1, close));
  if (items.length !== cols.length) return {};
  const map = {};
  let slot = 0;
  for (let i = 0; i < items.length; i++) {
    const n = (items[i].match(/\?/g) || []).length;
    if (n === 1) map[slot] = `${m[1]}.${cols[i]}`;
    slot += n;
  }
  return map;
}

function bindPlan(t) {
  const slots = (t.sql.match(/\?/g) || []).length;
  const occurrences = [...t.text.matchAll(/\$\d+/g)];
  const colMap = insertColumnMap(t.sql);
  const out = [];
  for (let i = 0; i < slots; i++) {
    const at = occurrences[i];
    const before = at ? t.text.slice(Math.max(0, at.index - 70), at.index) : "";
    const after = at ? t.text.slice(at.index + at[0].length, at.index + at[0].length + 34) : "";
    const cast = /^\s*::\s*([a-z_][\w ]*)(\s*\[\s*\])?/i.exec(after);
    if (/json_each\s*\($|unnest\s*\($|=\s*ANY\s*\($|\bIN\s*\($|\bALL\s*\($/i.test(before)) { out.push("[]"); continue; }
    if (/\b(LIMIT|OFFSET)\s+$/i.test(before)) { out.push(10); continue; }
    if (/\|\|\s*$/.test(before) || (cast && cast[2])) { out.push(cast && cast[2] ? "[]" : 1); continue; }
    let kind = cast ? PG_TYPE_KIND[cast[1].trim().toLowerCase()] : null;
    /* a column with a CHECK (col IN (...)) domain only accepts its own values */
    const enumValue = colMap[i] && !cast ? enumOfTableCol[colMap[i]] : null;
    if (enumValue) { out.push(enumValue); continue; }
    if (!kind) {
      const cmp = /([a-z_][\w]*)\s*(?:=|<>|!=|>=|<=|>|<|IN\s+|LIKE\s+|ILIKE\s+)\s*$/i.exec(before);
      if (cmp && kinds[cmp[1]]) kind = kinds[cmp[1]][0];
    }
    if (!kind && colMap[i]) kind = kindOfTableCol[colMap[i]];
    out.push(valueForKind(kind || "text", i));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = OFF");
for (const stmt of schemaSql.split(";\n").map(s => s.replace(/^\s*(?:--[^\n]*\n)+/, "").trim()).filter(Boolean)) db.exec(stmt);

const corpus = [];
for (const file of walk(APP)) {
  const rel = path.relative(APP, file).replace(/\\/g, "/");
  if (/migrations|tools|scripts/.test(rel)) continue;
  for (const text of sqlLiterals(fs.readFileSync(file, "utf8"))) corpus.push({ rel, text });
}

const translated = [];
const translateErrors = [];
for (const c of corpus) {
  const n = (c.text.match(/\$\d+/g) || []).length;
  try {
    translated.push({ ...c, ...compat.translateSql(c.text, new Array(n).fill("x")) });
  } catch (err) {
    translateErrors.push({ ...c, error: String(err.message || err) });
  }
}

const executable = translated.filter(t => /^(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|BEGIN|COMMIT|ROLLBACK)/i.test(t.sql));
const DATA_ERROR = /^(datatype mismatch|CHECK constraint failed|UNIQUE constraint failed|FOREIGN KEY constraint failed|NOT NULL constraint failed|malformed JSON|table \w+ has no column named )/i;

const shapeFail = [];
const dataFail = [];
const bindOnly = [];
const fragments = [];
let ran = 0;

/* an interpolated template piece (SELECT list with no FROM) cannot be validated on its own */
function hasTopLevelFrom(sql) {
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /^FROM\b/i.test(sql.slice(i, i + 5)) && !/[A-Za-z0-9_]/.test(sql[i - 1] || "")) return true;
  }
  return false;
}

for (const t of executable) {
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(t.sql)) continue;
  if (/\bNEXTVAL\b|\bSETVAL\b|\bLOCK\b|\bANALYZE\b|\bVACUUM\b|\bGRANT\b/i.test(t.sql)) continue;
  if (/^\s*(SELECT|WITH)\b/i.test(t.sql) && /\b[a-z_]\w*\.[a-z_]\w*\b/i.test(t.sql) && !hasTopLevelFrom(t.sql)) { fragments.push(t.rel); continue; }
  let prepared = null;
  try {
    prepared = db.prepare(t.sql);
  } catch (err) {
    shapeFail.push({ ...t, error: String(err.message || err).replace(/\s+/g, " ") });
    continue;
  }
  const slots = (t.sql.match(/\?/g) || []).length;
  const rungs = [];
  if (LADDER) rungs.push(new Array(slots).fill(1), new Array(slots).fill("x"), new Array(slots).fill("2026-01-02T03:04:05.000Z"));
  const plan = bindPlan(t);
  db.exec("BEGIN");
  let lastErr = null;
  for (const vals of [plan, ...rungs]) {
    try {
      prepared.all(...vals.map(compat.encodeParam));
      lastErr = null;
      break;
    } catch (err) {
      lastErr = String(err.message || err).replace(/\s+/g, " ");
      if (!DATA_ERROR.test(lastErr)) break;
    }
  }
  try { db.exec("ROLLBACK"); } catch { /* already aborted */ }
  ran++;
  if (!lastErr) continue;
  if (DATA_ERROR.test(lastErr)) (LADDER ? bindOnly : dataFail).push({ ...t, error: lastErr, params: plan });
  else shapeFail.push({ ...t, error: lastErr, params: plan });
}

function group(list) {
  const g = new Map();
  for (const f of list) {
    const key = f.error.slice(0, 70);
    if (!g.has(key)) g.set(key, []);
    g.get(key).push(f);
  }
  return g;
}

function report(label, list) {
  const g = group(list);
  console.log(`\n${label}: ${list.length} statements in ${g.size} classes`);
  for (const [key, fs2] of g) {
    console.log(`\n  ${key}  x${fs2.length}`);
    for (const f of fs2.slice(0, 3)) {
      console.log(`    ${f.rel}`);
      console.log(`    pg: ${f.text.replace(/\s+/g, " ").slice(0, 170)}`);
      console.log(`    d1: ${f.sql.slice(0, 170)}`);
      if (f.params) console.log(`    bind: ${JSON.stringify(f.params).slice(0, 120)}`);
    }
  }
}

console.log(`files: ${walk(APP).length}, sql strings: ${corpus.length}, translated: ${translated.length}, executable: ${executable.length}, ran: ${ran}, template fragments skipped: ${fragments.length}`);
console.log(`translate throws: ${translateErrors.length}`);
if (fragments.length) console.log(`  fragments live in: ${[...new Set(fragments)].join(", ")}`);
translateErrors.slice(0, 8).forEach(e => console.log(`  ! ${e.rel}: ${e.error.slice(0, 120)}\n      ${e.text.slice(0, 110).replace(/\s+/g, " ")}`));

report("SHAPE FAILURES (translator bugs)", shapeFail);
report(LADDER ? "DATA FAILURES (survived every rung of the param ladder)" : "DATA FAILURES (param ladder off; rerun with --ladder)", dataFail);
if (LADDER) {
  console.log(`\nresolved by the param ladder (bind noise, not translator bugs): ${bindOnly.length}`);
  for (const [key, list] of group(bindOnly)) console.log(`  ${key}  x${list.length}`);
}

/* leftover postgres-isms that survived translation */
const leftovers = {};
for (const t of executable) {
  for (const [label, re] of Object.entries({
    "$n placeholder": /\$\d/, "::cast": /::/, "NOW()": /\bNOW\s*\(/i, ILIKE: /\bILIKE\b/i,
    "ANY(": /\bANY\s*\(/i, "ARRAY[": /\bARRAY\s*\[/i, unnest: /\bUNNEST\b/i, date_trunc: /\bDATE_TRUNC\b/i,
    to_char: /\bTO_CHAR\b/i, interval: /\bINTERVAL\b/i, "generate_series": /\bGENERATE_SERIES\b/i,
    information_schema: /\bINFORMATION_SCHEMA\b/i, "->": /(^|[^-])->>*/,
    "NULLS LAST/FIRST": /\bNULLS\s+(FIRST|LAST)\b/i, jsonb: /\bJSONB\b/i, "AT TIME ZONE": /\bAT\s+TIME\s+ZONE\b/i,
    "to_jsonb": /\bTO_JSONB\b/i, "left():": /\bLEFT\s*\(/i,
  })) {
    if (re.test(t.sql)) (leftovers[label] = leftovers[label] || []).push(`${t.rel}: ${t.sql.slice(0, 130)}`);
  }
}
console.log("\nleftover postgres-isms after translation:");
for (const [label, list] of Object.entries(leftovers)) {
  console.log(`  ${label}: ${list.length}`);
  list.slice(0, 2).forEach(s => console.log(`     ${s}`));
}
if (!Object.keys(leftovers).length) console.log("  (none)");

/* decode smoke test: a real insert then a select through the codec */
db.exec("INSERT INTO users (username,email,password_hash,name,status,account_type) VALUES ('a','a@a','h','N','active','individual')");
const row = db.prepare("SELECT id, username, created_at, status FROM users LIMIT 1").get();
const hints = compat.resultHints("SELECT id, username, created_at, status FROM users", kinds);
console.log("\ncodec:", JSON.stringify(compat.decodeRows([row], hints)[0]).slice(0, 160));

/* ------------------------------------------------------------------ *
 * explicit assertions for the integer generate_series -> recursive CTE rule
 * translate, then run the emitted SQL on the schema database and check the rows
 * ------------------------------------------------------------------ */
let A_PASS = 0; const A_FAIL = [];
function assert(name, ok, detail) {
  if (ok) { A_PASS++; console.log(`  ok    ${name}`); }
  else { A_FAIL.push(name); console.log(`  FAIL  ${name} -> ${String(detail).slice(0, 160)}`); }
}
const run = (sql, params = []) => { try { return db.prepare(sql).all(...params); } catch (err) { return `ERR ${err.message}`; } };
console.log("\n== generate_series translation assertions ==");
{
  const asc = compat.translateSql("SELECT value FROM generate_series(1, 5) AS s", []);
  const ascRows = run(asc.sql);
  assert("ascending with AS alias: translated away, no notes, rows 1..5",
    !/generate_series/i.test(asc.sql) && asc.notes.length === 0 &&
    JSON.stringify(ascRows) === '[{"value":1},{"value":2},{"value":3},{"value":4},{"value":5}]', `${asc.sql} | ${JSON.stringify(ascRows)}`);

  const desc = compat.translateSql("SELECT value FROM generate_series(11, 0, -1) AS g", []);
  const descRows = run(desc.sql);
  assert("descending 11..0 step -1: 12 rows, first 11 last 0, column addressable as value",
    Array.isArray(descRows) && descRows.length === 12 && descRows[0].value === 11 && descRows[11].value === 0,
    JSON.stringify(descRows));
  const bare = compat.translateSql("SELECT g FROM generate_series(11, 0, -1) AS g", []);
  const bareRows = run(bare.sql);
  assert("bare table alias is also a column reference, the way pg names a function RTE (the admin query depends on it)",
    Array.isArray(bareRows) && bareRows.length === 12 && bareRows[0].g === 11 && bare.notes.length === 0,
    `${bare.sql} | ${JSON.stringify(bareRows)}`);

  const col = compat.translateSql("SELECT week FROM generate_series(0, 6, 2) d(week)", []);
  const colRows = run(col.sql);
  assert("column-alias form d(week): the emitted column carries the given name",
    JSON.stringify(colRows) === '[{"week":0},{"week":2},{"week":4},{"week":6}]', JSON.stringify(colRows));

  const empty = compat.translateSql("SELECT COUNT(*) AS n FROM generate_series(5, 1, 2)", []);
  const emptyRows = run(empty.sql);
  assert("empty case (start > stop, positive step): zero rows, not one stray start",
    JSON.stringify(emptyRows) === '[{"n":0}]', JSON.stringify(emptyRows));

  const neg = compat.translateSql("SELECT value FROM generate_series(-3, 2)", []);
  assert("negative literal start allowed: 6 rows -3..2",
    JSON.stringify(run(neg.sql)) === '[{"value":-3},{"value":-2},{"value":-1},{"value":0},{"value":1},{"value":2}]',
    JSON.stringify(run(neg.sql)));

  const ts = compat.translateSql(
    `SELECT COALESCE(x.n, 0)::int AS n FROM generate_series(NOW() - INTERVAL '7 weeks', NOW(), INTERVAL '1 week') d(week) LEFT JOIN (SELECT 1 AS n) x ON TRUE`, []);
  assert("timestamp form is NOT touched by the rule and the leftover scan reports it",
    /\bgenerate_series\s*\(/.test(ts.sql) && ts.notes.some(n => /generate_series/i.test(n)), `${ts.sql} | ${ts.notes}`);

  const pm = compat.translateSql("SELECT value FROM generate_series($1, 5) AS g", ["x"]);
  assert("parameter args are NOT guessed: text preserved, postgres-ism noted",
    /generate_series\(\?, 5\)/.test(pm.sql) && pm.notes.some(n => /generate_series/i.test(n)), `${pm.sql} | ${pm.notes}`);

  const zero = compat.translateSql("SELECT value FROM generate_series(1, 5, 0) AS g", []);
  assert("step 0 (a pg error) is refused rather than turned into an infinite CTE",
    /\bgenerate_series\s*\(/.test(zero.sql) && zero.notes.some(n => /generate_series/i.test(n)), `${zero.sql} | ${zero.notes}`);

  const admin = compat.translateSql(
    `SELECT to_char(month, 'YYYY-MM') AS ym
       FROM (SELECT date_trunc('month', NOW()) - (interval '1 month' * g) AS month
               FROM generate_series(11, 0, -1) AS g) m
      ORDER BY month`, []);
  const adminRows = run(admin.sql);
  const yms = Array.isArray(adminRows) ? adminRows.map(r => r.ym) : adminRows;
  assert("the whole admin monthlySignups statement translates without notes and yields 12 oldest-first YYYY-MM keys",
    admin.notes.length === 0 && Array.isArray(yms) && yms.length === 12 &&
    yms.every(s => /^\d{4}-\d{2}$/.test(s)) && yms[11] === run(`SELECT strftime('%Y-%m', 'now') AS ym`)[0].ym &&
    yms.join() === yms.slice().sort().join(), `${admin.sql} | ${JSON.stringify(yms)}`);
}
console.log(`\nVERDICT: ${A_PASS} passed, ${A_FAIL.length} failed` + (A_FAIL.length ? ` (${A_FAIL.join("; ")})` : ""));
db.close();
if (A_FAIL.length) process.exit(1);
