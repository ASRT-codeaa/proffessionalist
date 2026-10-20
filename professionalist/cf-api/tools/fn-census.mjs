/* Which functions does the backend SQL call that this SQLite (and therefore D1) does not provide?
   Names are tested against a real engine: "no such function" means missing, "wrong number of
   arguments" means present.  Census only -- no schema, no production.  node cf-api/tools/fn-census.mjs [app-dir] */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { locate } from "./paths.mjs";

const require = createRequire(import.meta.url);
const compat = require("../src/pg-compat.js");

const APP = process.argv.slice(2).find(a => !a.startsWith("--")) || locate("app");
const TRANSLATED = process.argv.includes("--translated");

const KEYWORDS = new Set("select insert update delete values into table conflict ignore replace case when then else end and or not in exists any all from where group order limit offset cast interval filter over on using set returning as join inner cross outer lateral with distinct union having if is null between like ilike glob do nothing".split(" "));

/* drop ${ ... } template holes, including JS calls inside them, so only SQL call sites remain */
function stripInterp(s) {
  let out = "", i = 0;
  while (i < s.length) {
    if (s[i] === "$" && s[i + 1] === "{") {
      let depth = 0, j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === "{") depth++;
        else if (s[j] === "}") { depth--; if (!depth) { j++; break; } }
      }
      i = j;
      out += " ";
      continue;
    }
    out += s[i++];
  }
  return out;
}

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
    const text = (m[1] ?? m[2] ?? "").replace(/\\\$/g, "$").replace(/\\`/g, "`");
    /* only strings that *are* a statement: a mis-scoped literal that starts with JS would
       otherwise contribute JS call names to the census */
    if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|BEGIN)\b/i.test(text)) continue;
    if (text.length > 10) out.push(text);
  }
  return out;
}

/* `INSERT INTO follows(...)` reads as a call to a function named "follows" unless the real
   schema vocabulary is excluded first */
const columnsJson = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "compat", "columns.json"), "utf8"));
const SCHEMA_WORDS = new Set(Object.keys(columnsJson));
for (const cols of Object.values(columnsJson)) for (const c of cols) SCHEMA_WORDS.add(c.name);

const tally = {};
for (const file of walk(APP)) {
  const rel = path.relative(APP, file).replace(/\\/g, "/");
  if (/migrations|tools|scripts/.test(rel)) continue;
  for (const text of sqlLiterals(fs.readFileSync(file, "utf8"))) {
    let src = text;
    if (TRANSLATED) {
      const n = (text.match(/\$\d+/g) || []).length;
      try { src = compat.translateSql(text, new Array(n).fill("x")).sql; } catch { continue; }
    }
    const bare = stripInterp(src).replace(/'[^']*'|"[^"]*"/g, " ");   /* quoted data cannot contain a call site */
    for (const m of bare.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)) {
      const name = m[1].toLowerCase();
      if (KEYWORDS.has(name) || SCHEMA_WORDS.has(name)) continue;
      const rec = tally[name] = tally[name] || { count: 0, where: new Set(), sample: "" };
      rec.count++;
      if (rec.where.size < 3) rec.where.add(rel);
      if (!rec.sample) rec.sample = bare.slice(Math.max(0, m.index - 10), m.index + 60).replace(/\s+/g, " ").trim();
    }
  }
}

const db = new DatabaseSync(":memory:");
const missing = [];
for (const [name, rec] of Object.entries(tally).sort((a, b) => b[1].count - a[1].count)) {
  try {
    db.prepare(`SELECT ${name}()`).all();
    continue;                      /* accepts zero args: it exists */
  } catch (err) {
    const msg = String(err.message || err);
    if (/no such function/i.test(msg)) missing.push([name, rec]);
    /* "wrong number of arguments" and parse errors also prove the function exists */
  }
}
db.close();

console.log(`functions called in backend SQL: ${Object.keys(tally).length}, unsupported by this engine: ${missing.length}\n`);
for (const [name, rec] of missing) console.log(`  ${name}  x${rec.count}  ${[...rec.where].join(", ")}\n      ${rec.sample}`);
