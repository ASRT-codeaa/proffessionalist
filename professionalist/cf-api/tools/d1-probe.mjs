/* Probe what this D1 actually supports, so the pg-compat layer is written against facts.
   Uses a scratch table and drops it at the end.
   node cf-api/tools/d1-probe.mjs */
import fs from "node:fs";
import path from "node:path";
import { readTrim, hideSecrets } from "./paths.mjs";

const TOKEN = readTrim("token");
const ACCT = readTrim("tmp", "acct.txt");
const DB_ID = readTrim("tmp", "d1-id.txt");
const hide = hideSecrets;

async function q(sql, params, attempt = 1) {
  let r, j;
  try {
    r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/d1/database/${DB_ID}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(params ? { sql, params } : { sql }),
    });
    j = await r.json();
    if (!j.success) throw new Error(`${r.status} ${hide(JSON.stringify(j.errors || j)).slice(0, 160)}`);
  } catch (err) {
    if (attempt < 4 && /timeout|fetch failed|429|5[0-9][0-9]/i.test(String(err.message))) {
      await new Promise(s => setTimeout(s, attempt * 700));
      return q(sql, params, attempt + 1);
    }
    throw err;
  }
  return j.result[0];
}

const cases = [
  ["RETURNING on insert", `INSERT INTO probe_t (a, b) VALUES (?, ?) RETURNING id, a, b, ts`, ["x", 1], r => r.results.length === 1 && r.results[0].a === "x"],
  ["ON CONFLICT DO UPDATE", `INSERT INTO probe_t (a, b) VALUES (?, ?) ON CONFLICT (a) DO UPDATE SET b = excluded.b RETURNING b`, ["x", 5], r => r.results[0].b === 5],
  ["INSERT OR IGNORE", `INSERT OR IGNORE INTO probe_t (a, b) VALUES (?, ?)`, ["x", 9], r => r.meta.changes === 0],
  ["UPDATE RETURNING", `UPDATE probe_t SET b = ? WHERE a = ? RETURNING id, b`, [7, "x"], r => r.results[0].b === 7],
  ["iso now default", `INSERT INTO probe_t (a) VALUES (?) RETURNING ts`, ["t"], r => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.results[0].ts)],
  ["strftime date_trunc month", `SELECT strftime('%Y-%m', ts) AS m FROM probe_t LIMIT 1`, null, r => /^\d{4}-\d{2}$/.test(r.results[0].m)],
  ["json_extract", `SELECT json_extract(?, '$.a') AS v`, ['{"a":7}'], r => r.results[0].v === 7],
  ["json arrow operator", `SELECT ? ->> '$.a' AS v`, ['{"a":7}'], r => String(r.results[0].v) === "7"],
  ["json_array_length", `SELECT json_array_length(?) AS n`, ['[1,2,3]'], r => r.results[0].n === 3],
  ["json_each join", `SELECT count(*) AS n FROM json_each('[1,2,3]')`, null, r => r.results[0].n === 3],
  ["json_group_array", `SELECT json_group_array(b) AS j FROM probe_t`, null, r => Array.isArray(r.results[0].j) || typeof r.results[0].j === "string"],
  ["FILTER aggregate", `SELECT count(*) FILTER (WHERE b > ?) AS n FROM probe_t`, [1], r => typeof r.results[0].n === "number"],
  ["group_concat", `SELECT group_concat(a, ',') AS s FROM probe_t`, null, r => typeof r.results[0].s === "string"],
  ["ILIKE absent (uses LIKE)", `SELECT 'AbC' LIKE '%abc%' COLLATE NOCASE AS ok`, null, r => r.results[0].ok === 1],
  ["GLOB", `SELECT 'abc' GLOB 'a*' AS ok`, null, r => r.results[0].ok === 1],
  ["CTE", `WITH c AS (SELECT 1 AS n) SELECT n FROM c`, null, r => r.results[0].n === 1],
  ["recursive CTE", `WITH RECURSIVE f(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM f WHERE n < 5) SELECT count(*) AS n FROM f`, null, r => r.results[0].n === 5],
  ["LIMIT/OFFSET params", `SELECT a FROM probe_t ORDER BY id LIMIT ? OFFSET ?`, [1, 0], r => r.results.length === 1],
  ["CASE WHEN", `SELECT CASE WHEN b > ? THEN 'hi' ELSE 'lo' END AS v FROM probe_t LIMIT 1`, [1], r => typeof r.results[0].v === "string"],
  ["COALESCE/NULLIF", `SELECT coalesce(NULL, 'd') AS a, nullif(1,1) AS b`, null, r => r.results[0].a === "d" && r.results[0].b === null],
  ["string funcs", `SELECT instr('abc','b') AS i, substr('abcdef',2,3) AS s, replace('aXb','X','-') AS r, upper('a') AS u`, null, r => r.results[0].i === 2 && r.results[0].s === "bcd"],
  ["IN list", `SELECT count(*) AS n FROM probe_t WHERE a IN (?, ?, ?)`, ["x", "y", "t"], r => r.results[0].n >= 1],
  ["IS NULL compare", `SELECT count(*) AS n FROM probe_t WHERE b IS NOT NULL`, null, r => typeof r.results[0].n === "number"],
  ["boolean as 0/1", `SELECT 1 AS ok WHERE ? = 1`, [1], r => r.results[0].ok === 1],
  ["CAST", `SELECT CAST(? AS INTEGER) AS n`, ["42"], r => r.results[0].n === 42],
  ["REAL money math", `SELECT ROUND(CAST(? AS REAL) * 0.1, 2) AS n`, ["100"], r => r.results[0].n === 10],
  ["delete returning", `DELETE FROM probe_t WHERE a = ? RETURNING id`, ["x"], r => r.results.length === 1],
  ["UNION ALL", `SELECT 1 AS n UNION ALL SELECT 2`, null, r => r.results.length === 2],
  ["DEFAULT VALUES", `INSERT INTO probe_t DEFAULT VALUES RETURNING id`, null, r => r.results[0].id > 0],
  ["rowid alias count", `SELECT count(*) AS n FROM probe_t`, null, r => typeof r.results[0].n === "number"],
  ["subquery EXISTS", `SELECT EXISTS(SELECT 1 FROM probe_t WHERE b = ?) AS e`, [404], r => r.results[0].e === 0],
  ["multi-statement script", `INSERT INTO probe_t (a,b) VALUES ('m',1); INSERT INTO probe_t (a,b) VALUES ('m',2)`, null, r => r.meta.changes === 1],
  ["max text ts", `SELECT max(ts) AS m FROM probe_t`, null, r => typeof r.results[0].m === "string"],
  ["now compare", `SELECT ? < strftime('%Y-%m-%dT%H:%M:%fZ','now') AS expired`, ["2000-01-01T00:00:00.000Z"], r => r.results[0].expired === 1],
  ["hex/randomblob", `SELECT length(hex(randomblob(16))) AS n`, null, r => r.results[0].n === 32],
  ["typeof", `SELECT typeof(?) AS t`, ["7"], r => typeof r.results[0].t === "string"],
  ["collate nocase index order", `SELECT a FROM probe_t ORDER BY a COLLATE NOCASE`, null, r => Array.isArray(r.results)],
  ["pragma table_info via fn", `SELECT name FROM pragma_table_info('probe_t')`, null, r => r.results.length >= 3],
  ["foreign key enforcement", `INSERT INTO probe_child (p) VALUES (999999)`, null, () => false, "expected FK rejection"],
  ["d1 sqlite version", `SELECT sqlite_version() AS v`, null, r => Number(r.results[0].v.split(".")[0]) >= 3],
];

await q("DROP TABLE IF EXISTS probe_t");
await q(`CREATE TABLE probe_t (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT UNIQUE, b INTEGER, ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`, undefined);
await q("DROP TABLE IF EXISTS probe_child");
await q("CREATE TABLE probe_child (id INTEGER PRIMARY KEY AUTOINCREMENT, p INTEGER NOT NULL REFERENCES probe_t(id) ON DELETE CASCADE)");

const pass = [];
const fail = [];
for (const [label, sql, params, check, expectFail] of cases) {
  if (sql === null) { /* filled dynamically below */ }
  try {
    if (sql === null) { pass.push(`${label} (n/a)`); continue; }
    const res = await q(sql, params);
    const ok = check(res, res.meta || {});
    (ok ? pass : fail).push(`${label}${expectFail ? "" : ""}`);
  } catch (err) {
    if (expectFail) pass.push(`${label} (rejected as expected)`);
    else fail.push(`${label}: ${String(err.message).slice(0, 110)}`);
  }
}
console.log(`PASS (${pass.length}):`);
pass.forEach(p => console.log("  ok  " + p));
console.log(`FAIL (${fail.length}):`);
fail.forEach(f => console.log("  !   " + f));

await q("DROP TABLE IF EXISTS probe_child");
await q("DROP TABLE IF EXISTS probe_t");
console.log("scratch tables dropped");
