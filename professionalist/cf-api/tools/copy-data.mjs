/* Copy the production PostgreSQL table data into the shadow D1 database (professionalist-db-v2)
   with zero user-visible change: primary-key values preserved verbatim (the app's SQL joins on ids
   handed out by pg sequences, so the D1 rows must carry the same ids), then every AUTOINCREMENT
   sequence repaired so the app's next insert does not collide. This is migration task #22 step 4.

   WHY a parameter-less INSERT generator and not the D1 /batch params path:
     - The HTTP query API accepts params only with a SINGLE statement (measured, §5.2), so a
       50k-row table cannot be bound as one parameterised request; multi-row VALUES literals are the
       only form that batches. Literals also let one request carry many statements (apply-schema.mjs
       already relies on that), which keeps D1's per-request overhead to a few calls, not one per row.
     - No column value is ever concatenated into SQL by hand: toSqlLiteral() is the single quoting
       site (it doubles the only character SQLite honours inside a string, the single quote). This is
       SQL-injection surface even though the source is our own trusted pg_dump.

   WHY the load is ordered rather than FK-disabled:
     - Measured against the live D1 the HTTP API IGNORES `PRAGMA foreign_keys=OFF` — a child insert
       with a missing parent still fails with SQLITE_CONSTRAINT_FOREIGNKEY even when the pragma is the
       first statement of the same request. D1 therefore always enforces FKs over HTTP, so ordering is
       not optional. Tables go parent-first (topological on the FK graph); the two self-referential
       tables pg_dump itself warned about (`posts.source_post_id`, `comments.parent_comment_id`) are
       additionally topologically ordered WITHIN the table, and a genuine self-cycle is reported
       loudly rather than silently dropped (it cannot be deferred here).

   WHY backslashes are NOT doubled (the obvious-looking "safe" choice):
     - SQLite string literals have no backslash escape mechanism, so doubling would corrupt stored
       data (every json column that contains a `\n` byte-pair, every Windows path, Devanagari text).
       Only ' needs doubling; the transport layer (JSON.stringify of the {sql} body) already handles
       any real escape the wire requires. pg_dump's COPY text backslash escapes are decoded on READ so
       the value reaching the literal is the true original bytes.

   node cf-api/tools/copy-data.mjs --dump=<pg_dump --data-only file[.gz]> [--dry-run]
   ... | --counts   (read D1 per-table counts back)
   ... | --spot     (run the app's own query shapes through src/db.js against the loaded D1)
   ... | --skip=<table,table>  (exclude tables that are not application data) */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { readTrim, hideSecrets } from "./paths.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.join(HERE, "..");

const TOKEN = readTrim("token");
const ACCT = readTrim("tmp", "acct.txt");
const DB_ID = readTrim("tmp", "d1-id.txt");
const hide = hideSecrets;

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = (n, d) => { const m = argv.find(a => a.startsWith(`--${n}=`)); return m ? m.slice(n.length + 3) : d; };
const DRY = flag("dry-run");
const SKIP = new Set(opt("skip", "").split(",").map(s => s.trim()).filter(Boolean));

/* A single 50k-row table must not exceed D1's request ceiling; cap well below the documented
   per-statement size so a fat text/json row can never blow one request up. apply-schema batches by
   statement COUNT; data rows vary wildly in width, so batch by accumulated BYTES. */
const MAX_BYTES = 480_000;
const MAX_ROWS = 500;

/* ------------------------------------------------------------------ *
 * the D1 HTTP query path, identical to apply-schema.mjs / count-rows.mjs
 * ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ *
 * schema: AUTOINCREMENT id column, FK graph, self-referential columns
 * ------------------------------------------------------------------ */
const schemaSql = fs.readFileSync(path.join(ROOT, "compat", "schema.sql"), "utf8");
const columns = require("../compat/columns.json");
const KIND = {};              // table -> { col -> kind }
for (const [t, cols] of Object.entries(columns)) KIND[t] = Object.fromEntries(cols.map(c => [c.name, c.kind === "int" && /bigint/i.test(c.pg) ? "int8" : c.kind]));

const TABLES = {};           // table -> { autoinc, self: [{col, ref}], parents: Set, columns: Set }
for (const m of schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS "([a-z_0-9]+)" \(([\s\S]*?)\n\);/g)) {
  const name = m[1];
  const t = { autoinc: null, self: [], parents: new Set(), columns: new Set() };
  for (const raw of m[2].split("\n")) {
    const line = raw.trim().replace(/,$/, "");
    const col = line.match(/^"([a-z_0-9]+)"\s+/);
    if (col && !/^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK)\b/i.test(line)) t.columns.add(col[1]);
    const ai = line.match(/^"([a-z_0-9]+)"\s+INTEGER PRIMARY KEY AUTOINCREMENT/i);
    if (ai) t.autoinc = ai[1];
    const fk = line.match(/FOREIGN KEY \("([a-z_0-9]+)"\) REFERENCES "([a-z_0-9]+)" \("([a-z_0-9]+)"\)/i);
    if (fk) {
      if (fk[2] === name) t.self.push({ col: fk[1], ref: fk[3] });
      else t.parents.add(fk[2]);
    }
  }
  TABLES[name] = t;
}

/* ------------------------------------------------------------------ *
 * the load order: topological over FK parents (self-edges excluded — handled per table)
 * ------------------------------------------------------------------ */
function topoTables(names) {
  const seen = new Set(), out = [];
  const visit = (n, stack) => {
    if (seen.has(n)) return;
    if (stack.has(n)) throw new Error(`cross-table FK cycle at ${[...stack, n].join(" -> ")} (D1 cannot defer this; needs a schema decision)`);
    stack.add(n);
    for (const p of [...(TABLES[n]?.parents || [])].sort()) if (names.has(p)) visit(p, stack);
    stack.delete(n); seen.add(n); out.push(n);
  };
  for (const n of names) visit(n, new Set());
  return out;
}

/* within a self-referential table put every parent row before its child; report a real cycle. */
function topoRows(rows, cols, self) {
  if (!self.length) return rows;
  const idAt = new Map();
  const selfCols = self.filter(s => cols.includes(s.col) && cols.includes(s.ref));
  if (!selfCols.length) return rows;
  const refCol = selfCols[0].col, pkCol = selfCols[0].ref;
  rows.forEach((r, i) => idAt.set(r[cols.indexOf(pkCol)], i));
  const emitted = new Array(rows.length).fill(false);
  const order = [];
  const visit = (i, stack) => {
    if (emitted[i]) return;
    if (stack.has(i)) throw new Error(`self-referential FK cycle in ${pkCol}->${refCol}: ${[...stack, i].join(",")} (D1 cannot defer this)`);
    stack.add(i);
    const parent = rows[i][cols.indexOf(refCol)];
    if (parent !== null && idAt.has(parent) && idAt.get(parent) !== i) visit(idAt.get(parent), stack);
    stack.delete(i); emitted[i] = true; order.push(i);
  };
  rows.forEach((_, i) => visit(i, new Set()));
  return order.map(i => rows[i]);
}

/* ------------------------------------------------------------------ *
 * COPY text decoding (pg_dump --data-only), then literal building
 * ------------------------------------------------------------------ */
function decodeCopyField(f) {
  if (f === "\\N") return null;               // the two-character backslash-N
  let out = "";
  for (let i = 0; i < f.length; i++) {
    if (f[i] !== "\\") { out += f[i]; continue; }
    const e = f[i + 1];
    if (e === undefined) { out += "\\"; break; }
    if ("01234567".includes(e)) {                     // octal \NNN
      let o = e, k = i + 2;
      while (k < f.length && o.length < 3 && "01234567".includes(f[k])) o += f[k++];
      out += String.fromCodePoint(parseInt(o, 8)); i = k - 1; continue;
    }
    const map = { n: "\n", t: "\t", r: "\r", v: "\v", b: "\b", f: "\f", "\\": "\\" };
    out += e in map ? map[e] : e;                     // unknown: keep the literal character
    i++;
  }
  return out;
}

function toSqlLiteral(v) {
  if (v === null || v === undefined) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;        // SQLite: the ONLY escape is doubling the quote
}

function toNumberLiteral(v, col) {
  if (v === null) return "NULL";
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(v)) throw new Error(`column ${col}: non-numeric value in a numeric/int column`);
  return v;
}

/* pg timestamptz COPY text (session TZ forced to UTC by PGTZ, but honour any offset) -> the exact
   `...Z` ISO-ms string the schema DEFAULT uses and db.js's decodeRows(new Date(...)) expects. */
const TS_RE = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d+))?\s*([+-])(\d\d)(?::?(\d\d))?(?::?\d\d)?$/;
function toIsoZ(v, col) {
  if (v === null) return "NULL";
  if (v === "infinity" || v === "-infinity") return toSqlLiteral(v);
  const m = TS_RE.exec(v.trim());
  if (!m) throw new Error(`column ${col}: unparseable timestamptz text "${v.slice(0, 40)}"`);
  const ms = ((m[7] || "") + "000").slice(0, 3);               // truncate microseconds to ms
  const offMin = (m[8] === "+" ? 1 : -1) * (Number(m[9]) * 60 + Number(m[10] || 0));
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +ms) - offMin * 60_000;
  return toSqlLiteral(new Date(utc).toISOString());
}

/* pg array literal {a,"b c",NULL} -> JSON ["a","b c",null]; {} -> []. text[] only (measured corpus). */
function pgArrayToJson(v, col) {
  if (v === null) return "NULL";
  const s = v.trim();
  if (s === "{}") return toSqlLiteral("[]");
  if (s[0] !== "{" || s[s.length - 1] !== "}") throw new Error(`column ${col}: array text not braced: ${s.slice(0, 30)}`);
  const body = s.slice(1, -1);
  const items = [];
  let i = 0, cur = null;
  while (i < body.length) {
    if (body[i] === '"') {                                            // quoted element
      let str = ""; i++;
      while (i < body.length) {
        if (body[i] === "\\" && i + 1 < body.length) { str += body[i + 1]; i += 2; continue; }
        if (body[i] === '"') { i++; break; }
        str += body[i++];
      }
      items.push(str);
      while (i < body.length && (body[i] === "," || /\s/.test(body[i]))) i++;
      continue;
    }
    let j = i, tok = "";                                             // unquoted element
    while (j < body.length && body[j] !== ",") tok += body[j++];
    items.push(tok === "NULL" ? null : tok);
    i = j + 1;
  }
  if (body.length) return toSqlLiteral(JSON.stringify(items));
  return toSqlLiteral("[]");
}

/* one value -> SQL literal, routed by the codec kind the adapter uses (compat/columns.json) */
function valueLiteral(raw, kind, col) {
  if (raw === null) return "NULL";
  switch (kind) {
    case "bool": return raw === "t" || raw === "true" || raw === "1" ? "1" : raw === "f" || raw === "false" || raw === "0" ? "0" : toNumberLiteral(raw, col);
    case "ts": return toIsoZ(raw, col);
    case "date": return toSqlLiteral(/^\d{4}-\d\d-\d\d$/.test(raw.trim()) ? raw.trim() : (() => { throw new Error(`column ${col}: bad date "${raw.slice(0, 20)}"`); })());
    case "array": return pgArrayToJson(raw, col);
    case "json": return toSqlLiteral(raw);                 // stored as the JSON text decodeRows parses back
    case "int": return toNumberLiteral(raw, col);          // int/bigint keep the exact digits (no float rounding)
    case "int8": return toNumberLiteral(raw, col);         // bigint ids arrive as int8 kind — same exact-digit rule
    case "numeric": return toNumberLiteral(raw, col);
    default: return toSqlLiteral(raw);                      // text, uuid, everything else
  }
}

/* ------------------------------------------------------------------ *
 * read the dump into { table -> { cols, rows } } and the pg sequence values
 * ------------------------------------------------------------------ */
function readDump(p) {
  const buf = fs.readFileSync(p);
  const text = p.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  const lines = text.split("\n");
  const tables = {}, seq = {};
  let cur = null;
  for (const line of lines) {
    if (line.startsWith("SELECT pg_catalog.setval")) {
      const m = /setval\('public\.([a-z_0-9]+)',\s*(\d+),\s*(true|false)\)/.exec(line);
      if (m) seq[m[1]] = { value: Number(m[2]), called: m[3] === "true" };
      continue;
    }
    const hdr = /^COPY public\.([a-z_0-9]+) \(([^)]*)\) FROM stdin;/.exec(line);
    if (hdr) {
      const name = hdr[1];
      const cols = hdr[2].split(",").map(c => c.trim());
      cur = { name, cols, rows: [] };
      tables[name] = cur;
      continue;
    }
    if (line === "\\." || line === "\\.\r") { cur = null; continue; }
    if (!cur) continue;                                   // pg_dump comment/greeting lines between blocks
    if (line.startsWith("--")) continue;
    const fields = line.split("\t");
    if (fields.length !== cur.cols.length) throw new Error(`${cur.name}: row has ${fields.length} fields, header declares ${cur.cols.length}`);
    cur.rows.push(fields.map(decodeCopyField));
  }
  return { tables, seq };
}

/* ------------------------------------------------------------------ *
 * pre-load reconciliation: PG tables/columns vs the D1 schema we already applied
 * ------------------------------------------------------------------ */
function reconcile(dump) {
  const pgTables = Object.keys(dump.tables).sort();
  const d1Tables = Object.keys(TABLES).sort();
  const problems = [];
  const only = (a, b) => a.filter(x => !b.includes(x));
  const missingInD1 = only(pgTables, d1Tables);
  const missingInPg = only(d1Tables, pgTables);
  if (missingInD1.length) problems.push(`in Postgres but NOT in D1 schema: ${missingInD1.join(", ")}`);
  if (missingInPg.length) problems.push(`in D1 schema but NOT dumped from Postgres: ${missingInPg.join(", ")}`);
  for (const t of pgTables) {
    const want = dump.tables[t].cols, have = [...(TABLES[t]?.columns || [])];
    const miss = want.filter(c => !have.includes(c));
    if (miss.length) problems.push(`${t}: dumped columns absent from D1 DDL: ${miss.join(", ")}`);
    for (const c of want) if (!KIND[t] || !KIND[t][c]) problems.push(`${t}.${c}: no codec kind in columns.json`);
  }
  return { pgTables, d1Tables, missingInD1, missingInPg, problems };
}

/* ------------------------------------------------------------------ *
 * build INSERT statements for one table
 * ------------------------------------------------------------------ */
function buildInsert(tbl, cols, row) {
  const list = cols.map(c => `"${c}"`).join(", ");
  const vals = cols.map((c, i) => {
    const kind = KIND[tbl][c] || "text";
    try { return valueLiteral(row[i], kind, `${tbl}.${c}`); }
    catch (err) { throw new Error(`${err.message} (table ${tbl})`); }
  });
  return `INSERT INTO "${tbl}" (${list}) VALUES (${vals.join(", ")});`;
}

/* ------------------------------------------------------------------ *
 * load
 * ------------------------------------------------------------------ */
const dumpPath = opt("dump", "");
if (!dumpPath) { console.error("usage: copy-data.mjs --dump=<pg_dump --data-only file[.gz]> [--dry-run | --counts | --spot]"); process.exit(2); }
const dump = readDump(dumpPath);
const VERIFY_ONLY = flag("counts") || flag("spot");   // reads existing D1 state; must never re-run the load

const recon = reconcile(dump);
console.log(`tables: Postgres=${recon.pgTables.length}  D1 schema=${recon.d1Tables.length}`);
if (recon.problems.length) {
  console.error("SCHEMA RECONCILIATION FAILED — refusing to load:");
  recon.problems.forEach(p => console.error("  ! " + p));
  process.exit(1);
}
console.log("reconciliation: PG table set == D1 table set, every dumped column has a D1 column and a codec kind");

/* secret-shaped columns: never print their failing literal, only the column names + D1 message */
const SECRET_RE = /(_hash|_secret|password|_token|api_key|secret)$/i;
const SECRET_TABLES = new Set(Object.entries(columns).filter(([, cs]) => cs.some(c => SECRET_RE.test(c.name))).map(([t]) => t));
const isSecret = t => SECRET_TABLES.has(t);

const loadNames = new Set(recon.pgTables.filter(t => !SKIP.has(t)));
const order = topoTables(loadNames);

/* -------- dry run: plan only, execute nothing -------- */
if (DRY) {
  console.log(`\ndry run — plan for ${order.length} tables in FK load order (nothing executed):\n`);
  for (const t of order) {
    const d = dump.tables[t];
    const self = TABLES[t].self.map(s => `${s.col}->${s.ref}`).join(",") || "-";
    console.log(`  ${t}: ${d.rows.length} rows  ${TABLES[t].autoinc ? "AUTOINCREMENT(" + TABLES[t].autoinc + ")" : "no-seq"}  selfFK[${self}]${SKIP.has(t) ? "  [SKIPPED]" : ""}`);
    if (d.rows.length) {
      const sample = d.cols.map((c, i) => {
        const kind = KIND[t][c] || "text";
        const raw = d.rows[0][i];
        /* credential-shaped columns (token/secret/password/api_key/hash): sample the COLUMN NAME and
           the value's LENGTH only, never its content — the Worker needs the value, the terminal does not */
        if (SECRET_RE.test(c)) return `${c}:${kind}=<masked len=${raw === null ? "NULL" : String(raw).length}>`;
        let shown = raw === null ? "NULL" : valueLiteral(raw, kind, c);
        return `${c}:${kind}=${shown.length > 34 ? shown.slice(0, 30) + "…" : shown}`;
      });
      console.log(`      row0 -> INSERT INTO "${t}" (${d.cols.map(c => `"${c}"`).join(", ")}) VALUES (${sample.join(" | ")})`);
    }
  }
  console.log(`\nsequences to repair (AUTOINCREMENT tables with rows): ${order.filter(t => TABLES[t].autoinc && dump.tables[t].rows.length).length}`);
  console.log(`pg sequence last-values captured from dump: ${Object.keys(dump.seq).length}`);
  console.log("VERDICT: dry run complete; no statement sent, no rows read back.");
  process.exit(0);
}

/* -------- real load -------- */
if (!VERIFY_ONLY) {
console.log(`\nloading ${order.length} tables into ${DB_ID ? "professionalist-db-v2" : "D1"} (target must be v2; verify count-rows first)\n`);
const perTable = {};
for (const t of order) {
  const d = dump.tables[t];
  perTable[t] = { rows: d.rows.length, batches: 0 };
  if (!d.rows.length) { console.log(`${t}: 0 rows in 0 batches`); continue; }
  const rows = topoRows(d.rows, d.cols, TABLES[t].self);
  let stmts = [], bytes = 0, batchCount = 0;
  const flush = async () => {
    if (!stmts.length) return;
    batchCount++;
    try { await q(stmts.join("\n")); }
    catch (err) {
      /* a batch was rejected — replay single statements to name the row, then abort loudly.
         The D1 message and column names are safe; the offending VALUES literal is NOT printed
         for data-bearing (secret-shaped) tables. */
      let failed = null;
      for (const s of stmts) { try { await q(s); } catch (e2) { failed = e2; break; } }
      const prefix = `INSERT INTO "${t}" (${d.cols.map(c => `"${c}"`).join(", ")}) VALUES (...)`;
      console.error(`\nREJECTED during ${t} batch ${batchCount}: ${String((failed || err).message).slice(0, 200)}`);
      console.error(`  --> ${prefix}`);
      if (!isSecret(t)) console.error(`  --> offending literal: ${String((failed || err).sql || "").slice(0, 240)}`);
      else console.error(`  --> value withheld (${t} has secret-shaped columns)`);
      process.exit(1);
    }
    stmts = []; bytes = 0;
  };
  for (const r of rows) {
    const ins = buildInsert(t, d.cols, r);
    if (bytes + ins.length > MAX_BYTES || stmts.length >= MAX_ROWS) await flush();
    stmts.push(ins); bytes += ins.length;
  }
  await flush();
  perTable[t].batches = batchCount;
  console.log(`${t}: ${d.rows.length} rows in ${batchCount} batches`);
}

/* -------- sequence repair: preserve ids, then move each AUTOINCREMENT counter past max(id) ------ */
console.log("\n== sequence repair ==");
const repairs = [];
for (const t of order) {
  const ai = TABLES[t].autoinc;
  if (!ai || !dump.tables[t].rows.length) continue;               // empty AUTOINCREMENT table: next id starts at 1 naturally
  const maxRes = await q(`SELECT MAX("${ai}") FROM "${t}"`);
  const maxId = Number(maxRes.results[0][`MAX("${ai}")`] ?? maxRes.results[0][Object.keys(maxRes.results[0])[0]]);
  const seqName = `${t}_id_seq`;
  const pgVal = dump.seq[seqName] ? dump.seq[seqName].value : 0;
  const target = Math.max(maxId || 0, pgVal);                      // never below what Postgres already handed out
  await q(`UPDATE sqlite_sequence SET seq=${target} WHERE name=${toSqlLiteral(t)}`);
  await q(`INSERT INTO sqlite_sequence(name,seq) SELECT ${toSqlLiteral(t)}, ${target} WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name=${toSqlLiteral(t)})`);
  repairs.push(`${t}: max_id=${maxId} pg_last=${pgVal} -> seq=${target}`);
}
repairs.forEach(r => console.log("  " + r));

/* -------- proof: a probe row must get an id greater than every copied id, then be deleted -------- */
console.log("\n== sequence repair proof (probe insert + read-back + delete) ==");
{
  const probeTable = order.find(t => t === "skills" && dump.tables[t].rows.length) || order.find(t => TABLES[t].autoinc && dump.tables[t].rows.length);
  const ai = TABLES[probeTable].autoinc;
  const maxBefore = await q(`SELECT MAX("${ai}") AS m FROM "${probeTable}"`);
  const maxCopied = Number(Object.values(maxBefore.results[0])[0]);
  const token = `__cfcopy_probe_${Date.now()}__`;
  const probe = await q(`INSERT INTO "${probeTable}" (name) VALUES (${toSqlLiteral(token)}) RETURNING "${ai}" AS id`);
  const newId = Number(Object.values(probe.results[0])[0]);
  const ok = newId > maxCopied;
  console.log(`  ${probeTable}: max copied id=${maxCopied}  probe id=${newId}  greater=${ok ? "YES" : "NO"}`);
  if (!ok) { console.error("PROBE FAILED: sequence repair did not push the next id past the copied range"); process.exit(1); }
  await q(`DELETE FROM "${probeTable}" WHERE "${ai}"=${newId};`);              // the ONLY DELETE — a row this task created
  // restore the counter so the app resumes exactly at the intended next id, not probe+1
  await q(`UPDATE sqlite_sequence SET seq=(SELECT MAX("${ai}") FROM "${probeTable}") WHERE name=${toSqlLiteral(probeTable)}`);
  const left = await q(`SELECT COUNT(*) AS n FROM "${probeTable}" WHERE "${ai}"=${newId}`);
  console.log(`  probe deleted (rows with id=${newId} now: ${Object.values(left.results[0])[0]}); ${probeTable} counter restored`);
}
}

/* -------- read-back count vs the census we measured from the dump -------- */
if (flag("counts")) {
  console.log("\n== read-back: D1 counts vs dump census ==");
  let mismatches = 0, d1total = 0, pgtotal = 0;
  const names = recon.pgTables;
  for (let i = 0; i < names.length; i += 4) {                      // D1 refuses > ~4 UNION arms (§314)
    const slice = names.slice(i, i + 4);
    const sql = slice.map(t => `SELECT '${t}' AS tbl, (SELECT COUNT(*) FROM "${t}") AS n`).join(" UNION ALL ");
    const res = await q(sql);
    for (const r of res.results) {
      const d1 = Number(r.n), pg = dump.tables[r.tbl].rows.length;
      d1total += d1; pgtotal += pg;
      if (d1 !== pg) { mismatches++; console.log(`  MISMATCH ${r.tbl}: D1=${d1} PG=${pg}`); }
    }
  }
  console.log(`  totals: D1=${d1total} PG=${pgtotal}  mismatches=${mismatches}`);
  console.log(mismatches ? "VERDICT: count read-back FAILED" : "VERDICT: every table's D1 count equals the Postgres census");
}

/* ------------------------------------------------------------------ *
 * --spot: run the app's OWN query shapes through src/db.js against the loaded D1.
 *   src/db.js is unmodified; the fake env.DB is built here over the D1 HTTP query API.
 *   The real Worker binding passes params natively; the HTTP API cannot take params on a
 *   multi-statement body, so prepare(sql).bind(...v).all() inlines each encoded param as a
 *   literal (same encoding pg-compat.encodeParam applies) — for SELECTs the executed SQL and the
 *   decoded rows are identical to what the Worker would return.
 * ------------------------------------------------------------------ */
if (flag("spot")) {
  const compat = require("../src/pg-compat.js");
  const db = require("../src/db.js");
  const inlineParams = (sql, params) => {
    let i = -1;
    return mapSqlOutsideQuotes(sql, seg => seg.replace(/\?/g, () => {
      i++;
      const e = compat.encodeParam(params[i]);
      if (e === null || e === undefined) return "NULL";
      return typeof e === "number" ? String(e) : toSqlLiteral(e);
    }));
  };
  const statement = sql => {
    let params = [];
    const self = {
      bind(...v) { params = v; return self; },
      async all() { const r = await q(inlineParams(sql, params)); return { results: r.results, meta: r.meta || {}, success: true }; },
      async first() { const r = await self.all(); return r.results[0] || null; },
      async run() { return self.all(); },
    };
    return self;
  };
  db.init({ DB: { prepare: statement, async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.all()); return out; } } });

  const queries = [
    `SELECT COUNT(*)::int AS n FROM users WHERE status = 'active'`,
    `SELECT id, username, name, role, verified FROM users ORDER BY id LIMIT 5`,
    `SELECT COUNT(*)::int AS n FROM notifications WHERE read_at IS NULL`,
    `SELECT p.id, p.user_id, json_array_length(p.hashtags) AS tag_count FROM posts p ORDER BY p.id LIMIT 5`,
    `SELECT COUNT(*)::int AS n FROM profile_skills WHERE skill_id IN (SELECT id FROM skills)`,
  ];
  console.log(`\n== adapter spot-check (${queries.length} app query shapes through src/db.js) ==`);
  for (const sql of queries) {
    try {
      const r = await db.query(sql, []);
      console.log(`  Q: ${sql}`);
      console.log(`     -> ${JSON.stringify(r.rows).slice(0, 220)}`);
    } catch (err) {
      console.log(`  Q: ${sql}\n     !! ${String(err.message).slice(0, 160)}`);
    }
  }
}

/* apply fn to every ? that sits outside a quoted literal (so a '?' inside data is never a placeholder) */
function mapSqlOutsideQuotes(sql, fn) {
  let out = "", i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const start = i++;
      for (; i < sql.length; i++) { if (sql[i] === ch) { if (sql[i + 1] === ch) { i++; continue; } i++; break; } }
      out += sql.slice(start, i); continue;
    }
    out += fn(ch); i++;
  }
  return out;
}

if (!flag("spot") && !flag("counts")) {
  console.log("\nload complete. Next: node cf-api/tools/count-rows.mjs  and  node cf-api/tools/copy-data.mjs --dump=<same file> --counts --spot");
}
