/* Convert the live PostgreSQL DDL (pg_dump --schema-only) into D1/SQLite DDL.
   Emits compat/schema.sql plus compat/columns.json, which the pg-compat layer uses
   to encode params and decode rows so route code keeps seeing pg-shaped values.
   node cf-api/tools/pg-to-sqlite.mjs */
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.join(HERE, "..");
const INPUT = path.join(ROOT, "compat", "live-schema.sql");
const OUT_SQL = path.join(ROOT, "compat", "schema.sql");
const OUT_JSON = path.join(ROOT, "compat", "columns.json");

const raw = fs.readFileSync(INPUT, "utf8");
const cleaned = raw
  .split(/\r?\n/)
  .filter(l => !l.startsWith("--") && !l.startsWith("SELECT pg_catalog.setval") && !/^(SET|COMMENT ON)/.test(l))
  .join("\n");

const statements = cleaned
  .split(/;\s*(?:\r?\n)+/)
  .map(s => s.trim())
  .filter(s => /^(CREATE|ALTER)/i.test(s));

const notes = [];
const seenKinds = new Set();

function splitTopLevel(body) {
  const parts = [];
  let depth = 0, quote = null, cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function unquote(s) {
  return s.replace(/^"|"$/g, "").replace(/^public\./, "");
}

/* strip postgres cast suffixes like ::text, ::character varying, ::regclass */
function stripCasts(s) {
  let out = s;
  let guard = 0;
  while (/::(text|character varying|integer|bigint|boolean|jsonb|json|date|timestamp with time zone|uuid|numeric|regclass|interval)(\[\])?/.test(out) && guard++ < 40) {
    out = out.replace(/::(text|character varying|integer|bigint|boolean|jsonb|json|date|timestamp with time zone|uuid|numeric|regclass|interval)(\[\])?/g, "");
  }
  return out.replace(/\(\s*\(([^()]*)\)\s*\)/g, "($1)");
}

const TYPE_MAP = [
  [/^timestamp with time zone$/i, "TEXT", "ts"],
  [/^timestamp without time zone$/i, "TEXT", "ts"],
  [/^date$/i, "TEXT", "date"],
  [/^time$/i, "TEXT", "text"],
  [/^character varying(\(\d+\))?$/i, "TEXT", "text"],
  [/^character\((\d+)\)$/i, "TEXT", "text"],
  [/^text$/i, "TEXT", "text"],
  [/^uuid$/i, "TEXT", "uuid"],
  [/^jsonb$/i, "TEXT", "json"],
  [/^json$/i, "TEXT", "json"],
  [/^(\w+\[\])$/i, "TEXT", "array"],
  [/^boolean$/i, "INTEGER", "bool"],
  [/^numeric(\([\d,]+\))?$/i, "REAL", "numeric"],
  [/^double precision$/i, "REAL", "numeric"],
  [/^real$/i, "REAL", "numeric"],
  [/^bigint$/i, "INTEGER", "int"],
  [/^integer$/i, "INTEGER", "int"],
  [/^smallint$/i, "INTEGER", "int"],
  [/^money$/i, "REAL", "numeric"],
  [/^inet$/i, "TEXT", "text"],
  [/^bytea$/i, "BLOB", "bytes"],
];

function mapType(t) {
  const base = t.trim().replace(/\s+COLLATE\s+"[^"]+"/i, "").replace(/"C"/g, "");
  for (const [re, sql, kind] of TYPE_MAP) {
    const m = base.match(re);
    if (m) {
      if (kind === "array" && m[1] !== "text[]" && !/^[a-z_]+\[\]$/i.test(m[1])) notes.push(`array type ${t} mapped as JSON text`);
      return { sql, kind };
    }
  }
  return null;
}

/* D1 generates a real uuid when the column carries this DEFAULT (verified remotely by
   tools/d1-uuid-probe.mjs: shape 2/2, distinct, and INSERT ... DEFAULT VALUES RETURNING id works).
   Keeping it in the DDL means the routes that used gen_random_uuid() need no edits at all.
   hex(n) returns 2n characters, so groups are built from 2-byte tails to land on 8-4-4-4-12. */
const UUID_DEFAULT = "DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||"
  + " substr(hex(randomblob(2)), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||"
  + " substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))))";

function mapDefault(expr, kind) {
  const e = expr.trim();
  if (/^nextval\(/i.test(e)) return { sql: null, dflt: "sequence" };
  if (/^gen_random_uuid\(\)/i.test(e)) return { sql: UUID_DEFAULT, dflt: "uuid" };
  if (/^now\(\)/i.test(e) || /^CURRENT_TIMESTAMP/i.test(e) || /^CURRENT_DATE$/i.test(e)) {
    return { sql: "DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))", dflt: "now" };
  }
  if (/^'(\{\}|NULL|null)'::text\[\]$/i.test(e) || /^'{}'::[^ ]*\[\]$/i.test(e)) return { sql: "DEFAULT '[]'", dflt: "emptyarray" };
  if (/^'{}'::jsonb$/i.test(e)) return { sql: "DEFAULT '{}'", dflt: "emptyjson" };
  if (/^B'(.+)'$/s.test(e)) return { sql: `DEFAULT '${e.slice(3, -2).replace(/'/g, "''")}'`, dflt: "blob" };
  const cast = e.match(/^'((?:[^']|'')*)'::[a-z ]+(\(\d+\))?(\[\])?$/i);
  if (cast) {
    if (/\[\]$/.test(e)) return { sql: "DEFAULT '[]'", dflt: "emptyarray" };
    return { sql: `DEFAULT '${cast[1]}'`, dflt: "literal" };
  }
  if (/^(true|false)$/i.test(e)) return { sql: `DEFAULT ${/true/i.test(e) ? 1 : 0}`, dflt: "bool" };
  if (/^-?[\d.]+$/.test(e)) return { sql: `DEFAULT ${e}`, dflt: "literal" };
  if (/^NULL$/i.test(e)) return { sql: null, dflt: null };
  if (/^CURRENT_USER/i.test(e)) return { sql: null, dflt: "ignored" };
  notes.push(`unmapped default: ${e} (kind ${kind})`);
  return { sql: null, dflt: "unknown" };
}

function convertCheck(expr) {
  let e = stripCasts(expr);
  let guard = 0;
  for (;;) {
    const m = /(=)\s*ANY\s*\(/i.exec(e);
    if (!m || guard++ > 20) break;
    const open = m.index + m[0].length - 1;
    const close = matchParen(e, open);
    if (close === -1) { notes.push(`unbalanced ANY in check: ${e.slice(0, 80)}`); break; }
    const right = unwrapAll(e.slice(open + 1, close));
    const arr = right.match(/^ARRAY\s*\[([\s\S]*)\]$/i);
    if (!arr) { notes.push(`check ANY not on an ARRAY literal: ${right.slice(0, 60)}`); break; }
    const leftStart = findOperandStart(e, m.index);
    const col = unwrapAll(e.slice(leftStart, m.index)).replace(/"/g, "").trim();
    const values = splitTopLevel(arr[1]).filter(Boolean);
    e = `${e.slice(0, leftStart)}${col} IN (${values.join(", ")})${e.slice(close + 1)}`;
  }
  if (/ANY\s*\(/i.test(e)) notes.push(`check left with ANY: ${e.slice(0, 90)}`);
  return dropRedundantParens(e);
}

function matchParen(s, open) {
  let depth = 0, quote = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/* start of the comparison operand ending just before `pos` (skips one wrapping paren) */
function findOperandStart(s, pos) {
  let i = pos - 1;
  while (i >= 0 && /\s/.test(s[i])) i--;
  if (i >= 0 && s[i] === ")") {
    const close = i;
    let depth = 0;
    for (; i >= 0; i--) {
      if (s[i] === ")") depth++;
      if (s[i] === "(") { depth--; if (depth === 0) break; }
    }
    let j = i - 1;
    while (j >= 0 && /\s/.test(s[j])) j--;
    if (j >= 0 && s[j] === "(" && s.slice(i, close + 1).match(/^\(([^()]+)\)$/)) i = j;
  }
  let k = i;
  while (k >= 0 && /[A-Za-z0-9_."]|\s/.test(s[k])) k--;
  return k + 1;
}

function unwrapAll(s) {
  let e = s.trim();
  while (e.startsWith("(") && e.endsWith(")") && matchParen(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
  return e;
}

/* peel outer paren pairs that wrap the whole expression */
function dropRedundantParens(s) {
  let e = s.trim();
  while (e.startsWith("(") && e.endsWith(")")) {
    let depth = 0, wraps = true;
    for (let i = 0; i < e.length; i++) {
      if (e[i] === "(") depth++;
      else if (e[i] === ")") { depth--; if (depth === 0 && i < e.length - 1) { wraps = false; break; } }
    }
    if (!wraps) break;
    e = e.slice(1, -1).trim();
  }
  return e;
}

const tables = new Map();
const indexes = [];
const views = [];

function table(name) {
  if (!tables.has(name)) tables.set(name, { name, columns: [], checks: [], uniques: [], fks: [], pk: null });
  return tables.get(name);
}

for (const s of statements) {
  const createTable = s.match(/^CREATE\s+TABLE\s+(?:IF NOT EXISTS\s+)?public\.([a-z_][a-z0-9_]*)\s*\(([\s\S]*)\)$/i);
  if (createTable) {
    const t = table(unquote(createTable[1]));
    for (const item of splitTopLevel(createTable[2])) {
      const con = item.match(/^CONSTRAINT\s+([a-z0-9_]+)\s+CHECK\s*\(([A-ZZ\s\S]*)\)$/i);
      if (con) { t.checks.push({ name: con[1], expr: convertCheck(con[2]) }); continue; }
      if (/^CONSTRAINT/.test(item)) { notes.push(`skipped table constraint: ${item.slice(0, 80)}`); continue; }
      const m = item.match(/^"?([a-z_][a-z0-9_]*)"?\s+(.+)$/i);
      if (!m) { notes.push(`unparsed column item: ${item.slice(0, 80)}`); continue; }
      const rest = m[2];
      const defMatch = rest.match(/\bDEFAULT\s+(.+?)(?=\s+(NOT\s+NULL|NULL)\b|$)/i);
      const typePart = defMatch ? rest.slice(0, rest.search(/\bDEFAULT\b/i)) : rest.replace(/\s+(NOT\s+NULL|NULL)\b.*$/i, "");
      const mapped = mapType(typePart);
      if (!mapped) { notes.push(`UNMAPPED TYPE ${typePart} for ${m[1]}`); continue; }
      const notNull = /\bNOT\s+NULL\b/i.test(rest);
      const d = defMatch ? mapDefault(defMatch[1], mapped.kind) : { sql: null, dflt: null };
      t.columns.push({ name: unquote(m[1]), pg: typePart.trim(), sql: mapped.sql, kind: mapped.kind, notNull, dflt: d.dflt, dfltSql: d.sql });
    }
    continue;
  }

  const alterDefault = s.match(/^ALTER\s+TABLE\s+ONLY\s+public\.([a-z_]+)\s+ALTER\s+COLUMN\s+([a-z_]+)\s+SET\s+DEFAULT\s+([\s\S]+)$/i);
  if (alterDefault) {
    const t = table(unquote(alterDefault[1]));
    const col = t.columns.find(c => c.name === unquote(alterDefault[2]));
    if (!col) { notes.push(`default for unknown column ${alterDefault[1]}.${alterDefault[2]}`); continue; }
    const d = mapDefault(alterDefault[3], col.kind);
    col.dflt = d.dflt; col.dfltSql = d.sql;
    continue;
  }

  const addCon = s.match(/^ALTER\s+TABLE\s+(?:ONLY\s+)?public\.([a-z_]+)\s+ADD\s+CONSTRAINT\s+([a-z0-9_]+)\s+([\s\S]+)$/i);
  if (addCon) {
    const t = table(unquote(addCon[1]));
    const body = addCon[3].replace(/\s+(NOT\s+DEFERRABLE|INITIALLY\s+DEFERRED|DEFERRABLE)$/i, "").trim();
    const pk = body.match(/^PRIMARY\s+KEY\s*\(([^)]*)\)/i);
    if (pk) { t.pk = splitTopLevel(pk[1]).map(unquote); continue; }
    const uq = body.match(/^UNIQUE\s*\(([^)]*)\)/i);
    if (uq) { t.uniques.push(splitTopLevel(uq[1]).map(unquote)); continue; }
    const fk = body.match(/^FOREIGN\s+KEY\s*\(([^)]*)\)\s+REFERENCES\s+(?:public\.)?([a-z_]+)\s*\(([^)]*)\)([\s\S]*)$/i);
    if (fk) {
      const actions = (fk[4] || "").replace(/MATCH\s+FULL|MATCH\s+PARTIAL|MATCH\s+SIMPLE/gi, "").trim();
      t.fks.push({ cols: splitTopLevel(fk[1]).map(unquote), refTable: unquote(fk[2]), refCols: splitTopLevel(fk[3]).map(unquote), actions });
      continue;
    }
    const chk = body.match(/^CHECK\s*\(([A-Za-z0-9_\s\S]*)\)$/i);
    if (chk) { t.checks.push({ name: addCon[2], expr: convertCheck(chk[1]) }); continue; }
    notes.push(`skipped constraint ${addCon[2]}: ${body.slice(0, 80)}`);
    continue;
  }

  const idx = s.match(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)\s+ON\s+(?:ONLY\s+)?(?:public\.)?([a-z_]+)\s*(USING\s+\w+\s*)?\(([\s\S]*?)\)\s*(WHERE\s+([\s\S]*))?$/i);
  if (idx) {
    const cols = splitTopLevel(idx[5]).map(c =>
      dropRedundantParens(stripCasts(c))
        .replace(/COLLATE\s+"[^"]+"/gi, "")
        .replace(/\b(?:varchar|text)_pattern_ops\b/gi, "")
        .replace(/\s+(ASC|DESC)\s*(?:NULLS\s+(?:FIRST|LAST))?/gi, "")
        .trim()
    ).filter(Boolean);
    if (idx[5].includes("ARRAY")) notes.push(`expression index ${idx[2]}: ${idx[5].slice(0, 60)}`);
    if (idx[7]) notes.push(`partial index kept: ${idx[2]} WHERE ${idx[7].slice(0, 60)}`);
    indexes.push({ unique: !!idx[1], name: idx[2], table: unquote(idx[3]), cols, where: idx[7] ? stripCasts(idx[7]).trim() : null });
    seenKinds.add("index");
    continue;
  }

  const view = s.match(/^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?([a-z_]+)(?:\s*\([^)]*\))?\s+AS\s+([\s\S]+)$/i);
  if (view) {
    let body = stripCasts(view[2]).trim().replace(/\bpublic\./g, "");
    body = body.replace(/\s+WITH\s*\(\s*security_barrier[^)]*\)\s*$/i, "");
    views.push({ name: view[1], body });
    continue;
  }

  if (/^CREATE\s+(SEQUENCE|TYPE|FUNCTION|TRIGGER|DOMAIN|EXTENSION)/i.test(s)) continue;
  if (/^ALTER\s+SEQUENCE/i.test(s)) continue;
  notes.push(`unhandled statement: ${s.slice(0, 90).replace(/\s+/g, " ")}`);
}

const out = [];
out.push("-- Generated by cf-api/tools/pg-to-sqlite.mjs from compat/live-schema.sql (PostgreSQL 16.15, db professionalist).");
out.push("-- Do not edit by hand: regenerate, then re-apply with tools/apply-schema.mjs.");
out.push("");

const columnsJson = {};
for (const t of [...tables.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  /* only a real postgres sequence becomes rowid autoincrement; a supplied pk (e.g. profiles.user_id) stays a plain key */
  const singleIntPk = t.pk && t.pk.length === 1
    ? t.columns.find(c => c.name === t.pk[0] && c.kind === "int" && c.dflt === "sequence")
    : null;
  const rows = [];
  for (const c of t.columns) {
    let decl = `"${c.name}"`;
    if (singleIntPk && c.name === t.pk[0]) {
      decl += " INTEGER PRIMARY KEY AUTOINCREMENT";
      if (!c.notNull) notes.push(`${t.name}.${c.name} became NOT NULL as rowid alias`);
      rows.push(`${decl} NOT NULL`);
      continue;
    }
    decl += ` ${c.sql}`;
    if (c.dfltSql) decl += ` ${c.dfltSql}`;
    if (c.notNull) decl += " NOT NULL";
    rows.push(decl);
  }
  if (!singleIntPk && t.pk) rows.push(`PRIMARY KEY (${t.pk.map(p => `"${p}"`).join(", ")})`);
  for (const u of t.uniques) rows.push(`UNIQUE (${u.map(c => `"${c}"`).join(", ")})`);
  for (const chk of t.checks) rows.push(`CHECK (${chk.expr})`);
  for (const fk of t.fks) rows.push(`FOREIGN KEY (${fk.cols.map(c => `"${c}"`).join(", ")}) REFERENCES "${fk.refTable}" (${fk.refCols.map(c => `"${c}"`).join(", ")})${fk.actions ? " " + fk.actions : ""}`);
  out.push(`CREATE TABLE IF NOT EXISTS "${t.name}" (`);
  out.push("  " + rows.join(",\n  "));
  out.push(");");
  out.push("");
  columnsJson[t.name] = t.columns.map(c => ({
    name: c.name, pg: c.pg, kind: c.kind, notNull: !!c.notNull, default: c.dflt || undefined,
    pk: t.pk && t.pk.includes(c.name) ? (t.pk.length === 1 ? "auto" : "pk") : undefined,
  }));
}

for (const i of indexes) {
  const cols = i.cols.map(c => (/^[a-z_][a-z0-9_]*$/i.test(c) ? `"${c}"` : c));
  out.push(`CREATE ${i.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${i.name}" ON "${i.table}" (${cols.join(", ")})${i.where ? ` WHERE ${i.where}` : ""};`);
}
out.push("");
for (const v of views) out.push(`CREATE VIEW IF NOT EXISTS "${v.name}" AS ${v.body};`);
out.push("");

fs.writeFileSync(OUT_SQL, out.join("\n"));
fs.writeFileSync(OUT_JSON, JSON.stringify(columnsJson, null, 1) + "\n");

const flat = Object.values(columnsJson).reduce((n, c) => n + c.length, 0);
console.log(`tables: ${tables.size}, columns: ${flat}, indexes: ${indexes.length}, views: ${views.length}`);
console.log(`kinds: ${[...new Set(Object.values(columnsJson).flat().map(c => c.kind))].join(", ")}`);
const counts = {};
for (const c of Object.values(columnsJson).flat()) counts[c.kind] = (counts[c.kind] || 0) + 1;
console.log("column counts:", JSON.stringify(counts));
console.log("uuid columns with a DDL-generated id:", Object.values(columnsJson).flat().filter(c => c.default === "uuid").map(c => `${c.name}`).length, "(no app-side generation needed)");
console.log(`notes (${notes.length}):`);
[...new Set(notes)].slice(0, 30).forEach(n => console.log("  ! " + n));
