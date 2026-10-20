/* Scan the backend's SQL strings and list every construct the pg->D1 adapter must rewrite.
   Output drives cf-api/src/pg.js and its unit tests.
   node cf-api/tools/sql-census.mjs */
import fs from "node:fs";
import path from "node:path";
import { locate } from "./paths.mjs";

const APP = process.argv[2] || locate("app");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.js$/.test(e.name) ? [p] : [];
  });
}

const PATTERNS = {
  "positional $n": /\$\d+/g,
  "::cast": /::\s*[a-z_ ]+(\([^)]*\))?(\[\])?/gi,
  "NOW()": /\bNOW\s*\(\s*\)/gi,
  "CURRENT_TIMESTAMP": /\bCURRENT_TIMESTAMP\b/gi,
  "ILIKE": /\bILIKE\b/gi,
  "ANY(": /\bANY\s*\(/gi,
  "ARRAY[": /\bARRAY\s*\[/gi,
  "array_agg": /\bARRAY_AGG\s*\(/gi,
  "json_agg": /\bJSON_AGG\s*\(/gi,
  "jsonb_build_object": /\bJSONB?_BUILD_OBJECT\s*\(/gi,
  "->>": /->>/g,
  "->": /(?<!=)->(?!>)/g,
  "#>": /#>/g,
  "jsonb ops @>/?:": /@>|<@|\?|jsonb_/gi,
  "date_trunc": /\bDATE_TRUNC\s*\(/gi,
  "to_char": /\bTO_CHAR\s*\(/gi,
  "extract": /\bEXTRACT\s*\(/gi,
  "INTERVAL": /\bINTERVAL\s*('|\()/gi,
  "make_interval": /\bMAKE_INTERVAL\s*\(/gi,
  "at time zone": /\bAT\s+TIME\s+ZONE\b/gi,
  "gen_random_uuid": /\bGEN_RANDOM_UUID\s*\(/gi,
  "RETURNING": /\bRETURNING\b/gi,
  "ON CONFLICT": /\bON\s+CONFLICT\b/gi,
  "FILTER (": /\bFILTER\s*\(/gi,
  "OVER (": /\bOVER\s*\(/gi,
  "DISTINCT ON": /\bDISTINCT\s+ON\s*\(/gi,
  "LATERAL": /\bLATERAL\b/gi,
  "GROUPING SETS": /\bGROUPING\s+SETS\b/gi,
  "COALESCE": /\bCOALESCE\s*\(/gi,
  "NULLIF": /\bNULLIF\s*\(/gi,
  "string_agg": /\bSTRING_AGG\s*\(/gi,
  "bool_and/or": /\bBOOL_(AND|OR)\s*\(/gi,
  "percentile": /\bPERCENTILE_/gi,
  " unnest(": /\bUNNEST\s*\(/gi,
  "generate_series": /\bGENERATE_SERIES\s*\(/gi,
  "SUBSTRING( FROM": /\bSUBSTRING\s*\([^)]*\bFROM\b/gi,
  "SIMILAR TO": /\bSIMILAR\s+TO\b/gi,
  "REGEXP/~/ !~": /(?<![!<>])~(?!~)|!~/g,
  "IS DISTINCT FROM": /\bIS\s+DISTINCT\s+FROM\b/gi,
  "CONCAT_WS": /\bCONCAT_WS\s*\(/gi,
  "LEFT/RIGHT JOIN": /\b(LEFT|RIGHT|FULL)\s+(OUTER\s+)?JOIN\b/gi,
  "CROSS JOIN": /\bCROSS\s+JOIN\b/gi,
  "SERIAL/nextval": /\bNEXTVAL\s*\(|\bSERIAL\b/gi,
  "FOR UPDATE": /\bFOR\s+UPDATE\b/gi,
  "BEGIN/COMMIT in sql": /\b(BEGIN|COMMIT|ROLLBACK)\b/gi,
  "EXTRACT EPOCH": /\bEPOCH\b/gi,
  "TRUE/FALSE literals": /\b(TRUE|FALSE)\b/gi,
};

const hits = {};
const files = walk(APP);
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(APP, file).replace(/\\/g, "/");
  for (const sql of sqlLiterals(src)) {
    for (const [label, re] of Object.entries(PATTERNS)) {
      const m = sql.text.match(re);
      if (!m) continue;
      const h = (hits[label] = hits[label] || { count: 0, samples: [], files: new Set() });
      h.count += m.length;
      h.files.add(rel);
      for (const match of m) {
        const idx = sql.text.indexOf(match);
        const ctx = sql.text.slice(Math.max(0, idx - 48), idx + 62).replace(/\s+/g, " ").trim();
        if (h.samples.length < 40 && !h.samples.some(s => s.ctx === ctx)) {
          h.samples.push({ ctx, where: `${sql.offsetInFile ? rel : rel}` });
        }
      }
    }
  }
}

/* pull SQL out of template literals, single and double quoted strings */
function sqlLiterals(src) {
  const out = [];
  const re = /(?:`((?:[^`\\]|\\.)*)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/gs;
  let m;
  while ((m = re.exec(src))) {
    const text = m[1] ?? m[2] ?? m[3];
    if (!/\b(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER)\b/i.test(text)) continue;
    if (/\$\d|NOW\(|FROM |JOIN |WHERE |VALUES|SET |=|\(/i.test(text) === false) continue;
    out.push({ text, index: m.index });
  }
  return out;
}

const sorted = Object.entries(hits).sort((a, b) => b[1].count - a[1].count);
console.log(`scanned ${files.length} files under ${APP}\n`);
for (const [label, h] of sorted) {
  const must = /[A-Z]/.test(label) && !/COALESCE|NULLIF|RETURNING|ON CONFLICT|TRUE\/FALSE|CURRENT_TIMESTAMP|LEFT\/RIGHT JOIN|BEGIN\/COMMIT/.test(label);
  console.log(`${must ? "!!" : "  "} ${label.padEnd(22)} ${String(h.count).padStart(4)}  in ${h.files.size} file(s)`);
  if (must) h.samples.slice(0, 6).forEach(s => console.log(`       ${s.ctx.slice(0, 105)}`));
}
