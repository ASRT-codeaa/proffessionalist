/* Create our second D1 database (non-destructive: the old, empty one is left untouched)
   and record its id for the other tools.  Prints only names/lengths, never ids.
   node cf-api/tools/create-db.mjs <name> */
import fs from "node:fs";
import path from "node:path";
import { readTrim, writableDir, hideSecrets } from "./paths.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const TMP = writableDir("tmp");
const TOKEN = readTrim("token");
const ACCT = readTrim("tmp", "acct.txt");
const hide = hideSecrets;
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/d1/database`;
const get = async (url, init) => {
  const r = await fetch(url, init);
  const j = await r.json();
  if (!j.success) throw new Error(`${r.status} ${hide(JSON.stringify(j.errors || {})).slice(0, 250)}`);
  return j.result;
};
const head = { Authorization: `Bearer ${TOKEN}` };

const name = process.argv[2];
if (!name) { console.log("usage: create-db.mjs <database-name>"); process.exit(1); }

const all = await get(`${API}?per_page=100`, { headers: head });
console.log(`${all.length} databases in the account; looking for "${name}"`);
let db = all.find(d => d.name === name);
/* the D1 API calls the identifier "uuid" on create/list, "id" nowhere */
const dbId = d => d?.uuid ?? d?.id;
if (db) {
  console.log("already exists, reusing");
} else {
  const created = await get(API, { method: "POST", headers: { ...head, "Content-Type": "application/json" },
    body: JSON.stringify({ name }) });
  db = Array.isArray(created) ? created[0] : created;
  console.log("created");
}

/* the create call returns before the instance is queryable - poll with a real statement */
for (let i = 1; i <= 20; i++) {
  try {
    const r = await fetch(`${API}/${dbId(db)}/query`, { method: "POST",
      headers: { ...head, "Content-Type": "application/json" }, body: JSON.stringify({ sql: "SELECT 1 AS one" }) });
    const j = await r.json();
    if (j.success && j.result?.[0]?.results?.[0]?.one === 1) { console.log(`queryable after ${i} poll(s)`); break; }
  } catch { /* not ready yet */ }
  await new Promise(s => setTimeout(s, 1000));
}

const idFile = path.join(TMP, "d1-id.txt");
if (fs.existsSync(idFile)) {
  const prev = fs.readFileSync(idFile, "utf8").trim();
  fs.writeFileSync(path.join(TMP, "d1-id.previous.txt"), prev + "\n");
  if (prev === dbId(db)) console.log("pointer file already targets this database");
  else console.log(`re-pointed tools from the previous database to "${name}" (old id saved to d1-id.previous.txt)`);
}
fs.writeFileSync(idFile, dbId(db));
fs.writeFileSync(path.join(TMP, "d1-name.txt"), name);
console.log(`tools now target "${name}" (id length ${dbId(db).length})`);
