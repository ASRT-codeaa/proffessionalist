/* PostgreSQL -> D1/SQLite translation layer.
   Pure and dependency-free so it can be unit tested against node:sqlite with the real schema
   before it ever runs in a Worker.  Regression gate: cf-api/tools/test-pg.mjs
   Exports: translateSql, encodeParam, encodeParams, decodeRows, resultHints, loadColumnKinds */

const ISO_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const ISO_FMT = "'%Y-%m-%dT%H:%M:%fZ'";

/* ------------------------------------------------------------------ *
 * string-literal walking
 * ------------------------------------------------------------------ */

/* run fn over the SQL regions of a string, leaving quoted data untouched */
function mapSql(text, fn) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const start = i++;
      for (; i < text.length; i++) {
        if (text[i] === ch) {
          if (text[i + 1] === ch) { i++; continue; }
          i++;
          break;
        }
      }
      out += text.slice(start, i);
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      const end = nl === -1 ? text.length : nl;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    let j = i;
    while (j < text.length && text[j] !== "'" && text[j] !== '"' && !(text[j] === "-" && text[j + 1] === "-")) j++;
    out += fn(text.slice(i, j));
    i = j;
  }
  return out;
}

const SENTINEL = n => `\u0001${n}\u0001`;

/* replace every quoted literal with an opaque token so later rules cannot damage data */
function maskLiterals(text) {
  const table = [];
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const start = i++;
      for (; i < text.length; i++) {
        if (text[i] === ch) {
          if (text[i + 1] === ch) { i++; continue; }
          i++;
          break;
        }
      }
      table.push(text.slice(start, i));
      out += SENTINEL(table.length - 1);
      continue;
    }
    out += ch;
    i++;
  }
  return { masked: out, table };
}

function unmaskLiterals(text, table) {
  return text.replace(/\u0001(\d+)\u0001/g, (_, n) => table[Number(n)] ?? "");
}

/* ------------------------------------------------------------------ *
 * placeholders: $n -> ? with parameter reordering
 * ------------------------------------------------------------------ */
function rewritePlaceholders(text, params) {
  const order = [];
  const out = mapSql(text, chunk => chunk.replace(/\$(\d+)/g, (_, n) => {
    order.push(Number(n));
    return "?";
  }));
  return { text: out, params: order.map(i => (params ? params[i - 1] : undefined)), positional: order.length > 0 };
}

/* ------------------------------------------------------------------ *
 * casts: expr::type -> CAST(expr AS type), dropped when lossless
 * ------------------------------------------------------------------ */
const CAST_TARGET = {
  int: "INTEGER", int2: "INTEGER", int4: "INTEGER", integer: "INTEGER", smallint: "INTEGER", serial: "INTEGER", serial4: "INTEGER",
  bigint: "INTEGER", int8: "INTEGER", bigserial: "INTEGER", serial8: "INTEGER",
  numeric: "REAL", decimal: "REAL", real: "REAL", float: "REAL", float4: "REAL", float8: "REAL", "double precision": "REAL", money: "REAL",
  boolean: "INTEGER", bytea: "BLOB",
  text: null, varchar: null, char: null, bpchar: null, name: null, citext: null, "character varying": null, "character": null,
  json: null, jsonb: null, uuid: null, inet: null, cidr: null, macaddr: null,
  date: "TEXT", time: "TEXT", timetz: "TEXT", interval: "TEXT",
  timestamp: "TEXT", timestamptz: "TEXT", "timestamp with time zone": "TEXT", "timestamp without time zone": "TEXT",
};

/* the multi-word spellings must be tried before the bare-identifier alternative,
   and the bare alternative must not contain a space or it eats the next SQL keyword */
const CAST_RE = /::\s*(timestamp with time zone|timestamp without time zone|double precision|character varying|character|bit varying|[a-z_][a-z0-9_]*)(\s*\(\s*[\d,]+\s*\))?(\s*\[\])?/i;

function backParen(text, close) {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (text[i] === ")") depth++;
    else if (text[i] === "(") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/* Start index of the expression ending just before `end` (the ':' of a ::cast or the '-' of ->).
   Walks back over FILTER (...) / OVER (...) so they stay attached to their aggregate. */
function operandBefore(text, end) {
  let i = end - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return -1;
  for (;;) {
    if (text[i] === ")") {
      const open = backParen(text, i);
      if (open === -1) return -1;
      let k = open - 1;
      while (k >= 0 && /[a-z0-9_]/i.test(text[k])) k--;
      const name = text.slice(k + 1, open).toUpperCase();
      if (name === "FILTER" || name === "OVER") {
        i = k;
        while (i >= 0 && /\s/.test(text[i])) i--;
        continue;
      }
      return k + 1;
    }
    let j = i;
    while (j >= 0 && /[a-z0-9_.?]/i.test(text[j])) j--;
    return j < i ? j + 1 : -1;
  }
}

function rewriteCasts(text) {
  const casts = [];
  let guard = 0;
  for (;;) {
    const m = CAST_RE.exec(text);
    if (!m || guard++ > 200) break;
    const base = m[1].toLowerCase();
    const isArray = !!m[3];
    const known = Object.prototype.hasOwnProperty.call(CAST_TARGET, base);
    const target = known ? CAST_TARGET[base] : undefined;
    const start = operandBefore(text, m.index);
    if (start === -1 || !known) {
      /* no identifiable operand, or a type we do not model: dropping keeps the SQL parseable */
      if (!known) casts.push({ base, isArray, dropped: true });
      text = text.slice(0, m.index) + text.slice(m.index + m[0].length);
      continue;
    }
    const operand = text.slice(start, m.index);
    const casted = isArray || target === null ? operand : `CAST(${operand} AS ${target})`;
    casts.push({ operand: operand.trim(), base, isArray, sqlType: target });
    text = text.slice(0, start) + casted + text.slice(m.index + m[0].length);
  }
  return { text, casts };
}

/* ------------------------------------------------------------------ *
 * rewrites that must see quoted literals (run before masking)
 * ------------------------------------------------------------------ */
const UNITS = { second: "seconds", minute: "minutes", hour: "hours", day: "days", week: "weeks", month: "months", year: "years" };
const unitOf = u => UNITS[String(u).toLowerCase()] || String(u).toLowerCase();

function isoWrap(expr, modifier) {
  const e = expr.trim();
  if (/^(NOW\s*\(\s*\)|CURRENT_TIMESTAMP|CURRENT_DATE)$/i.test(e)) return `strftime(${ISO_FMT}, 'now', ${modifier})`;
  return `strftime(${ISO_FMT}, ${e}, ${modifier})`;
}

const TRUNC_FORMAT = {
  year: "'%Y-01-01T00:00:00.000Z'",
  month: "'%Y-%m-01T00:00:00.000Z'",
  day: "'%Y-%m-%dT00:00:00.000Z'",
  hour: "'%Y-%m-%dT%H:00:00.000Z'",
  minute: "'%Y-%m-%dT%H:%M:00.000Z'",
  second: ISO_FMT,
};

function dateTrunc(unitName, expr) {
  if (unitName === "week") return `strftime('%Y-%m-%dT00:00:00.000Z', ${expr}, 'weekday 0', '-6 days')`;
  return `strftime(${TRUNC_FORMAT[unitName] || TRUNC_FORMAT.second}, ${expr})`;
}

function pgToSqliteFormat(f) {
  return f
    .replace(/YYYY/g, "%Y").replace(/YY/g, "%y")
    .replace(/MM/g, "%m").replace(/DD/g, "%d")
    .replace(/HH24/g, "%H").replace(/HH12/g, "%H").replace(/HH/g, "%H")
    .replace(/MI/g, "%M").replace(/SS/g, "%S").replace(/MS/g, "%f")
    .replace(/Mon/g, "%b").replace(/Month/g, "%B")
    .replace(/DY/g, "%a").replace(/Day/g, "%A")
    .replace(/TZ/g, "");
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

/* 1 for every character that sits inside a quoted literal, so a scanner can ignore call
   syntax that only exists in user data */
function literalShield(text) {
  const shield = new Uint8Array(text.length);
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const start = i++;
      for (; i < text.length; i++) {
        if (text[i] === ch) {
          if (text[i + 1] === ch) { i++; continue; }
          i++;
          break;
        }
      }
      for (let k = start; k < i; k++) shield[k] = 1;
      continue;
    }
    i++;
  }
  return shield;
}

/* Replace postgres function calls with SQLite equivalents, arguments parsed rather than
   regexed: the argument list may itself contain calls, and date_trunc/to_char carry their
   format inside quotes, which a blanket regex either misses or corrupts.
   handlers: { name: args => replacement | null }; null leaves the call alone (args still folded). */
function foldCalls(text, handlers) {
  const names = Object.keys(handlers).join("|");
  const re = new RegExp(`\\b(${names})\\s*\\(`, "gi");
  const shield = literalShield(text);
  let out = "", i = 0, m;
  while ((m = re.exec(text))) {
    if (shield[m.index] || m.index < i) { re.lastIndex = Math.max(re.lastIndex, i); continue; }
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close === -1) { re.lastIndex = open + 1; continue; }
    out += text.slice(i, m.index);
    const args = splitTop(text.slice(open + 1, close)).map(a => foldCalls(a.trim(), handlers));
    const rep = handlers[m[1].toLowerCase()](args);
    out += rep === null || rep === undefined ? `${m[1]}(${args.join(", ")})` : rep;
    i = close + 1;
    re.lastIndex = i;
  }
  return out + text.slice(i);
}

/* a postgres empty-array literal is '{}' but json_each needs the json spelling */
function asJsonArray(expr) {
  return expr
    .replace(/'NULL'/gi, "'[]'")
    .replace(/'\{\}'/g, "'[]'")
    .replace(/\{\}/g, "[]");
}

/* <expr> +/- INTERVAL '<n> <unit>'.  The left operand is found with the same balanced scan the
   casts use: a permissive character class here once started mid-statement and swallowed the
   keywords between the operand and INTERVAL, producing unbalanced parentheses. */
function rewriteInterval(text) {
  let t = text;
  const RE = /\s+([+-])\s+INTERVAL\s*'([\d.]+)\s+(\w+)'/i;
  for (let guard = 0; guard < 40; guard++) {
    const m = RE.exec(t);
    if (!m) break;
    const start = operandBefore(t, m.index);
    const head = start === -1 ? m.index : start;
    const lhs = start === -1 ? "" : t.slice(start, m.index);
    t = t.slice(0, head) + isoWrap(lhs, `'${m[1]}${m[2]} ${unitOf(m[3])}'`) + t.slice(m.index + m[0].length);
  }
  return t;
}

function rewriteTime(text) {
  let t = text;
  t = t.replace(/'epoch'(?![\w'])/gi, "'1970-01-01T00:00:00.000Z'");
  /* (expr * INTERVAL '1 unit') and INTERVAL '1 unit' * expr carry a non-constant count.
     The app writes the keyword in both cases, so these must be case-insensitive. */
  t = t.replace(/\(\s*([^()]+?)\s*\*\s*INTERVAL\s*'1\s+(\w+)'\s*\)/gi, (m, n, u) => `(${n} || ' ${unitOf(u)}')`);
  t = t.replace(/INTERVAL\s*'1\s+(\w+)'\s*\*\s*([A-Za-z_][\w.]*)/gi, (m, u, n) => `(${n} || ' ${unitOf(u)}')`);
  return rewriteInterval(t);
}

/* ------------------------------------------------------------------ *
 * function calls postgres has and SQLite does not
 * ------------------------------------------------------------------ */
const EXTRACT_FORMAT = {
  year: "'%Y'", month: "'%m'", day: "'%d'", hour: "'%H'", minute: "'%M'", second: "'%S'",
  dow: "'%w'", doy: "'%j'", week: "%W",
};

const FUNCTIONS = {
  /* SQLite has no LEFT()/RIGHT(); substr covers both */
  left: a => a.length === 2 ? `substr(${a[0]}, 1, ${a[1]})` : null,
  right: a => a.length === 2 ? `substr(${a[0]}, -(${a[1]}))` : null,
  greatest: a => a.length ? `max(${a.join(", ")})` : null,
  least: a => a.length ? `min(${a.join(", ")})` : null,
  to_char: ([expr, fmt]) => {
    const f = /^'(.*)'$/s.exec(fmt || "");
    if (!expr || !f) return null;
    return `strftime('${pgToSqliteFormat(f[1])}', ${expr})`;
  },
  date_trunc: ([unit, expr]) => {
    const u = /^'(\w+)'$/i.exec(unit || "");
    if (!expr || !u) return null;
    return dateTrunc(u[1].toLowerCase(), expr);
  },
  extract: ([arg]) => {
    const m = /^\s*(\w+)\s+FROM\s+([\s\S]+)$/i.exec(arg || "");
    if (!m) return null;
    const unit = m[1].toLowerCase(), expr = m[2].trim();
    if (unit === "epoch") return `(strftime('%s', ${expr}) + 0)`;
    const fmt = EXTRACT_FORMAT[unit];
    return fmt ? `(CAST(strftime(${fmt}, ${expr}) AS INTEGER) + 0)` : null;
  },
  array_agg: a => `json_group_array(${a.join(", ")})`,
  json_agg: a => `json_group_array(${a.join(", ")})`,
  /* to_jsonb(text) yields a json string value, which is json_quote's exact job */
  to_jsonb: a => `json_quote(${a.join(", ")})`,
  to_json: a => `json_quote(${a.join(", ")})`,
  jsonb_build_object: a => `json_object(${a.join(", ")})`,
  json_build_object: a => `json_object(${a.join(", ")})`,
};

function rewriteSets(text) {
  let t = text;
  let guard = 0;
  /* x = ANY(<array expr>) -> x IN (SELECT value FROM json_each(<array expr>)) */
  while (/=\s*ANY\s*\(/i.test(t) && guard++ < 40) {
    const m = /=\s*ANY\s*\(/i.exec(t);
    const open = m.index + m[0].length - 1;
    const close = matchParen(t, open);
    if (close === -1) break;
    let inner = t.slice(open + 1, close).trim();
    while (inner.startsWith("(") && matchParen(inner, 0) === inner.length - 1) inner = inner.slice(1, -1).trim();
    if (/^ARRAY\s*\[/i.test(inner)) inner = `json_array(${inner.replace(/^ARRAY\s*\[|\]$/gi, "")})`;
    const lhsStart = operandBefore(t, m.index);
    const head = lhsStart === -1 ? m.index : lhsStart;
    const lhs = lhsStart === -1 ? "" : t.slice(lhsStart, m.index).trim();
    t = `${t.slice(0, head)}${lhs} IN (SELECT value FROM json_each(${asJsonArray(inner)}))${t.slice(close + 1)}`;
  }
  /* FROM unnest(<arr>) AS alias(col) */
  t = t.replace(/\bUNNEST\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s+AS\s+([a-z_][\w]*)\s*\(\s*([a-z_][\w]*)\s*\)/gi,
    (m, arr, alias, col) => `(SELECT value AS ${col} FROM json_each(${asJsonArray(arr.trim())})) AS ${alias}`);
  t = t.replace(/\bUNNEST\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s+AS\s+([a-z_][\w]*)\b(?!\s*\()/gi,
    (m, arr, alias) => `(SELECT value FROM json_each(${asJsonArray(arr.trim())})) AS ${alias}`);
  t = t.replace(/\bUNNEST\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gi,
    (m, arr) => `(SELECT value FROM json_each(${asJsonArray(arr.trim())}))`);
  t = t.replace(/\bARRAY\s*\[([^\]]*)\]/gi, (m, inner) => `json_array(${inner.trim() || "NULL"})`);
  return t;
}

/* col -> 'key' / col -> 0  =>  json_extract(col, '$.key' / '$[0]'); ->> behaves the same here.
   The lookbehind keeps SQL line comments (--) from being read as the json operator. */
const JSON_ARROW = /(?<!-)->>?/;
function rewriteJsonOperators(text) {
  let t = text;
  let guard = 0;
  while (JSON_ARROW.test(t) && guard++ < 60) {
    const m = JSON_ARROW.exec(t);
    const lhsStart = operandBefore(t, m.index);
    if (lhsStart === -1) { t = `${t.slice(0, m.index)}${t.slice(m.index + m[0].length)}`; continue; }
    const lhs = t.slice(lhsStart, m.index).trim();
    let j = m.index + m[0].length;
    while (/\s/.test(t[j])) j++;
    let key, end;
    if (t[j] === "'") {
      const k = t.indexOf("'", j + 1);
      if (k === -1) break;
      key = `'$.${t.slice(j + 1, k).replace(/"/g, "")}'`;
      end = k + 1;
    } else {
      const num = /^\d+/.exec(t.slice(j));
      if (!num) break;
      key = `'$[${num[0]}]'`;
      end = j + num[0].length;
    }
    t = `${t.slice(0, lhsStart)}json_extract(${lhs}, ${key})${t.slice(end)}`;
  }
  return t;
}

/* ------------------------------------------------------------------ *
 * rewrites that must never touch data (run on masked text)
 * ------------------------------------------------------------------ */

/* SQLite accepts ON CONFLICT only after a VALUES list, never after a SELECT source
   (verified against node:sqlite: 'near "DO": syntax error').  For DO NOTHING the
   statement prefix INSERT OR IGNORE does the same job, so SELECT-sourced inserts are
   rewritten that way.  DO UPDATE after a SELECT cannot be expressed and is reported
   instead of guessed at. */
function hasTopLevelSelect(text, insertAt, clauseAt) {
  let depth = 0;
  for (let i = insertAt; i < clauseAt; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /^\bSELECT\b/i.test(text.slice(i, i + 8)) && !/[A-Za-z0-9_]/.test(text[i - 1] || "")) return true;
  }
  return false;
}

function rewriteUpsert(text, notes) {
  let t = text;
  for (let guard = 0; guard < 40; guard++) {
    const m = /\bON\s+CONFLICT\b/i.exec(t);
    if (!m) break;
    let insertAt = -1;
    const ins = /\bINSERT\s+INTO\b/gi;
    for (let im; (im = ins.exec(t.slice(0, m.index))); ) insertAt = im.index;
    const rest = t.slice(m.index);
    const selectSourced = insertAt !== -1 && hasTopLevelSelect(t, insertAt, m.index);
    const nothing = /^ON\s+CONFLICT\b(\s*\([^)]*\))?\s+DO\s+NOTHING\b/i.exec(rest);
    if (nothing && selectSourced) {
      t = t.slice(0, insertAt) + "INSERT OR IGNORE INTO"
        + t.slice(insertAt + "INSERT INTO".length, m.index)
        + rest.slice(nothing[0].length);
      notes.push("upsert after SELECT became INSERT OR IGNORE (it also swallows non-target constraint failures)");
      continue;
    }
    if (selectSourced && /^ON\s+CONFLICT\b(\s*\([^)]*\))?\s+DO\s+UPDATE\b/i.test(rest)) {
      notes.push("ON CONFLICT DO UPDATE after a SELECT source: SQLite cannot express it, needs a hand port");
    }
    break;
  }
  return t;
}

function rewriteKeywords(text) {
  return text
    .replace(/\bNOW\s*\(\s*\)/gi, ISO_NOW)
    .replace(/\bCURRENT_TIMESTAMP\b/gi, ISO_NOW)
    .replace(/\bCURRENT_DATE\b/gi, "date('now')")
    .replace(/\bGEN_RANDOM_UUID\s*\(\s*\)/gi, "/*APP-UUID*/");
}

/* SQLite LIKE already folds ASCII case, so ILIKE -> LIKE keeps the same rows */
const rewriteSearch = text => text.replace(/\bILIKE\b/gi, "LIKE");

const rewriteBooleans = text => text.replace(/\bTRUE\b/gi, "1").replace(/\bFALSE\b/gi, "0");

/* pg puts NULL last for ASC and first for DESC; SQLite sorts NULL below every value */
function rewriteOrdering(text) {
  const t = text.replace(/([A-Za-z_][\w.]*(?:\([^()]*\))?)\s+(ASC|DESC)\s+NULLS\s+(FIRST|LAST)/gi,
    (m, e, dir, where) => where.toUpperCase() === "LAST"
      ? `(${e} IS NULL) ASC, ${e} ${dir}`
      : `(${e} IS NULL) DESC, ${e} ${dir}`);
  return t.replace(/\bNULLS\s+(FIRST|LAST)\b/gi, "");
}

/* ------------------------------------------------------------------ *
 * public translate
 * ------------------------------------------------------------------ */
function translateSql(text, params) {
  const ph = rewritePlaceholders(text, params);
  let sql = ph.text;
  const notes = [];

  sql = mapSql(sql, chunk => {
    const r = rewriteCasts(chunk);
    notes.push(...r.casts.filter(c => c.dropped).map(c => `unknown cast ::${c.base} dropped`));
    return r.text;
  });

  /* these rules read quoted literals, so they run while the literals are still visible */
  sql = foldCalls(sql, FUNCTIONS);
  sql = rewriteTime(sql);
  sql = rewriteSets(sql);
  sql = rewriteJsonOperators(sql);

  const mask = maskLiterals(sql);
  sql = [rewriteKeywords, rewriteSearch, rewriteBooleans, rewriteOrdering, t => rewriteUpsert(t, notes)]
    .reduce((acc, fn) => fn(acc), mask.masked);
  sql = unmaskLiterals(sql, mask.table);

  if (/\u0001/.test(sql)) notes.push("literal sentinel left in output");
  if (/\$\d/.test(sql)) notes.push("placeholder survived");
  const leftover = sql.match(/\bANY\s*\(|\bUNNEST\s*\(|\bARRAY\s*\[|\bILIKE\b|\bDATE_TRUNC\s*\(|\bTO_CHAR\s*\(|\bINTERVAL\b|\bNULLS\s+(?:FIRST|LAST)\b|::|\bNOW\s*\(|\bGENERATE_SERIES\s*\(|\bINFORMATION_SCHEMA\b/i);
  if (leftover) notes.push(`postgres-ism survived: ${leftover[0].trim()}`);
  sql = sql.replace(/\s+/g, " ").trim().replace(/;+$/, "");
  return { sql, params: ph.params, notes, positional: ph.positional };
}

/* ------------------------------------------------------------------ *
 * value codecs
 * ------------------------------------------------------------------ */
function encodeParam(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof ArrayBuffer !== "undefined" && (v instanceof ArrayBuffer || ArrayBuffer.isView(v))) return v;
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

const encodeParams = params => (params || []).map(encodeParam);

/* pg's own output rules: int8 and numeric arrive as strings, dates as Date, jsonb parsed, text[] as array */
function decodeValue(raw, kind) {
  if (raw === null || raw === undefined) return null;
  switch (kind) {
    case "bool": return raw === 1 || raw === true || raw === "1" || raw === "t";
    case "int8": return String(raw);
    case "numeric": return typeof raw === "number" ? String(raw) : raw;
    case "ts": return raw instanceof Date ? raw : new Date(String(raw));
    case "date": return raw instanceof Date ? raw : new Date(`${String(raw).slice(0, 10)}T00:00:00.000Z`);
    case "json":
    case "array":
      if (typeof raw !== "string") return raw;
      try { return JSON.parse(raw); } catch { return raw; }
    default: return raw;
  }
}

function decodeRows(rows, hints) {
  if (!hints || !Object.keys(hints).length) return rows;
  return rows.map(row => {
    const out = {};
    for (const key of Object.keys(row)) {
      const kind = hints[key] && hints[key][0];
      out[key] = kind ? decodeValue(row[key], kind) : row[key];
    }
    return out;
  });
}

/* column name -> pg kinds, most common first, from compat/columns.json */
function loadColumnKinds(columnsJson) {
  const tally = {};
  for (const cols of Object.values(columnsJson)) {
    for (const c of cols) {
      const kind = c.kind === "int" && /bigint/i.test(c.pg) ? "int8" : c.kind;
      (tally[c.name] = tally[c.name] || {})[kind] = (tally[c.name][kind] || 0) + 1;
    }
  }
  const byName = {};
  for (const [name, kinds] of Object.entries(tally)) {
    byName[name] = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(e => e[0]);
  }
  return byName;
}

/* result column name -> kind, read off the SELECT/RETURNING list (explicit casts win) */
function resultHints(pgSql, columnKinds) {
  const hints = {};
  const m = pgSql.match(/\b(?:SELECT\s+(?:DISTINCT\s+)?|RETURNING\s+)([\s\S]*?)(?:\bFROM\b|\bWHERE\b|\bORDER\b|\bGROUP\b|\bLIMIT\b|\bON\s+CONFLICT\b|\bDO\b|$)/i);
  if (!m) return hints;
  if (/^\s*\*\s*$/.test(m[1])) return columnKinds;
  for (const item of splitTop(m[1])) {
    const asMatch = item.match(/\s+AS\s+([a-z_][\w]*)\s*$/i) || item.match(/^([a-z_][\w]*)\s*$/i);
    if (!asMatch) continue;
    const name = asMatch[1];
    const tail = item.replace(/\s+AS\s+[a-z_][\w]*\s*$/i, "");
    let kind = null;
    if (/::\s*(int|integer|smallint|serial4?|int4|int2)\b/i.test(tail)) kind = "int";
    else if (/::\s*(bigint|int8|bigserial|serial8?)\b/i.test(tail)) kind = "int8";
    else if (/::\s*(numeric|decimal|double precision|real|float[48]?|float|money)\b/i.test(tail)) kind = "numeric";
    else if (/::\s*boolean\b/i.test(tail)) kind = "bool";
    else if (/::\s*jsonb?/i.test(tail)) kind = "json";
    else if (/::\s*(text|bigint|int)\[\]/i.test(tail)) kind = "array";
    else if (/::\s*(date)\b/i.test(tail)) kind = "date";
    else if (/::\s*(timestamptz|timestamp(?: with time zone)?|time)\b/i.test(tail)) kind = "ts";
    else if (/::\s*(text|varchar|character varying|uuid|inet|citext|char|name)\b/i.test(tail)) kind = "text";
    if (!kind && /\bCOUNT\s*\(/i.test(tail)) kind = "int8";
    if (!kind && /json_group_array|json_array|to_json|json_quote|jsonb_build|json_build/i.test(tail)) kind = "json";
    hints[name] = kind ? [kind] : columnKinds[name] || [];
  }
  return hints;
}

function splitTop(s) {
  const parts = [];
  let depth = 0, quote = null, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

module.exports = {
  translateSql, encodeParam, encodeParams, decodeRows, decodeValue, resultHints, loadColumnKinds,
  rewritePlaceholders, rewriteCasts, operandBefore, splitTop, mapSql, maskLiterals, CAST_TARGET,
};
