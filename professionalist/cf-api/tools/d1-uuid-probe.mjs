/* Can D1 generate a uuid in a column DEFAULT?  This decides whether the four tables that had
   DEFAULT gen_random_uuid() keep SQL that works untouched, or need app-side id generation.
   Creates and drops its own probe table; no app table is written.
   node cf-api/tools/d1-uuid-probe.mjs */
import fs from "node:fs";
import path from "node:path";
import { readTrim, hideSecrets } from "./paths.mjs";

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
    if (!j.success) throw new Error(`${r.status} ${hide(JSON.stringify(j.errors || j)).slice(0, 240)}`);
  } catch (err) {
    if (attempt < 4 && /timeout|network|fetch failed|5[0-9][0-9]/i.test(String(err.message))) {
      await new Promise(s => setTimeout(s, attempt * 700));
      return q(sql, attempt + 1);
    }
    throw err;
  }
  return j.result[0];
}

/* 8-4-4-4-12, with the version-4 and variant nibbles in place, so it matches pg's uuid shape.
   hex(n) yields 2n characters, so the variant group needs a 2-byte hex tail to be 4 long. */
const UUID = `lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))`;

const probes = [
  ["randomblob readable", "SELECT hex(randomblob(4)) AS h"],
  ["random() readable", "SELECT abs(random()) % 4 AS r"],
  ["uuid expression", `SELECT ${UUID} AS id`],
  ["uuid in a DEFAULT", "skip"],      /* filled below, needs its own statement sequence */
  ["uuid uniqueness", `SELECT count(DISTINCT id) AS n FROM (SELECT ${UUID} AS id FROM (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5))`],
];

let failed = 0;
for (const [label, sql] of probes) {
  if (sql === "skip") continue;
  try {
    const r = await q(sql);
    console.log(`  ok    ${label}: ${JSON.stringify(r.results?.[0])?.slice(0, 90)}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${label}: ${String(err.message).slice(0, 140)}`);
  }
}

/* the real question: does a table-level DEFAULT fire on INSERT ... DEFAULT VALUES? */
const table = "_probe_uuid";
try {
  await q(`CREATE TABLE ${table} (id TEXT NOT NULL DEFAULT (${UUID}), k TEXT)`);
  const ins = await q(`INSERT INTO ${table} (k) VALUES ('a') RETURNING id, k`);
  const dv = await q(`INSERT INTO ${table} DEFAULT VALUES RETURNING id`);
  const all = await q(`SELECT id FROM ${table}`);
  const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const ids = (all.results || []).map(r => r.id);
  console.log(`  ok    DDL with uuid DEFAULT accepted`);
  console.log(`        VALUES insert   -> ${JSON.stringify(ins.results?.[0]?.id)}`);
  console.log(`        DEFAULT VALUES  -> ${JSON.stringify(dv.results?.[0]?.id)}  (pg's "INSERT INTO conversations DEFAULT VALUES" shape)`);
  console.log(`        uuid shape ok for ${ids.filter(i => shape.test(i)).length}/${ids.length}, distinct ${new Set(ids).size}/${ids.length}`);
} catch (err) {
  failed++;
  console.log(`  FAIL  uuid DEFAULT: ${String(err.message).slice(0, 200)}`);
} finally {
  try { await q(`DROP TABLE ${table}`); console.log("  probe table dropped"); }
  catch (err) { console.log(`  !! could not drop ${table}: ${String(err.message).slice(0, 120)}`); }
}

const left = await q("SELECT name FROM sqlite_master WHERE name LIKE '_probe_%'");
console.log(`  leftover probe objects: ${left.results.length}`);
console.log(failed ? `\nVERDICT: app-side uuid generation still needed (${failed} failing probe${failed > 1 ? "s" : ""})`
  : "\nVERDICT: D1 can generate uuids in a column DEFAULT -> routes keep working unedited");
