/* Second probe: the exact expressions the pg-compat layer will emit, and D1's binding rules.
   node cf-api/tools/d1-probe2.mjs */
import fs from "node:fs";

import { readTrim } from "./paths.mjs";

const TOKEN = readTrim("token");
const ACCT = readTrim("tmp", "acct.txt");
const DB_ID = readTrim("tmp", "d1-id.txt");

async function q(sql, params) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/d1/database/${DB_ID}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(params ? { sql, params } : { sql }),
  });
  const j = await r.json();
  if (!j.success) throw new Error(String(JSON.stringify(j.errors || j)).slice(0, 200));
  return j.result[0];
}

const T = "2026-10-08T13:05:00.123Z";
const probes = [
  ["strftime parses our Z timestamp", `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?) AS v`, [T], r => r[0].v === T],
  ["date() with Z + weekday trick", `SELECT date(?, 'weekday 0', '-6 days') AS v`, [T], r => /^\d{4}-\d{2}-\d{2}$/.test(r[0].v)],
  ["month trunc", `SELECT strftime('%Y-%m-01T00:00:00.000Z', ?) AS v`, [T], r => r[0].v === "2026-10-01T00:00:00.000Z"],
  ["day trunc", `SELECT strftime('%Y-%m-%dT00:00:00.000Z', ?) AS v`, [T], r => r[0].v === "2026-10-08T00:00:00.000Z"],
  ["week trunc is Monday", `SELECT strftime('%Y-%m-%dT00:00:00.000Z', ?, 'weekday 0', '-6 days') AS v`, [T], r => r[0].v === "2026-10-05T00:00:00.000Z"],
  ["strftime %s epoch", `SELECT strftime('%s', ?) AS v`, [T], r => /^\d+$/.test(String(r[0].v))],
  ["interval modifier from number param", `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds') > ? AS v`, [3600, "2000-01-01T00:00:00Z"], r => r[0].v === 1],
  ["negative months modifier", `SELECT strftime('%Y-%m-01T00:00:00.000Z', 'now', '-' || ? || ' months') AS v`, [3], r => /^\d{4}-\d{2}-01T00:00:00.000Z$/.test(r[0].v)],
  ["json_extract on TEXT column", `SELECT json_extract(?, '$[0]') AS v`, ['["a","b"]'], r => r[0].v === "a"],
  ["json wraps a text value", `SELECT json(?) AS v`, ["https://x/y.png"], r => typeof r[0].v === "string"],
  ["ts text ordering vs param", `SELECT (? > ?) AS v`, ["2026-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z"], r => r[0].v === 1],
  ["boolean param binding", `SELECT ? AS v`, [true], () => true, "does D1 accept a JS boolean?"],
  ["date object param binding", `SELECT ? AS v`, [new Date()], () => true, "does D1 accept a Date?"],
  ["undefined param binding", `SELECT ? AS v`, [undefined], () => true, "does D1 accept undefined?"],
  ["number param in LIKE concat", `SELECT ? LIKE '%' || ? || '%' AS v`, ["hello world", "WORL"], r => r[0].v === 0],
  ["lower-like pattern", `SELECT lower(?) LIKE lower(?) AS v`, ["hello world", "%WORL%"], r => r[0].v === 1],
  ["row JSON shape", `SELECT id AS n, username FROM users LIMIT 0`, null, r => Array.isArray(r)],
  ["changes meta on update", `UPDATE users SET name = COALESCE(name, ?) WHERE id = ?`, ["active", 1], (r, s, meta) => meta.changes === 0],
];

for (const [label, sql, params, check, note] of probes) {
  try {
    const res = await q(sql, params);
    const ok = check(res.results, res, res.meta || {});
    console.log(`  ${ok ? "ok " : "!! "} ${label}${note ? ` — ${note}` : ""} -> ${JSON.stringify(res.results).slice(0, 90)}`);
  } catch (err) {
    console.log(`  ERR  ${label}${note ? ` — ${note}` : ""}: ${String(err.message).slice(0, 120)}`);
  }
}
