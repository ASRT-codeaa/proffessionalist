/* Read-only Cloudflare account audit. Two jobs:
   1. §2 preflight — before ANY deploy/secret put, list /workers/scripts and /workers/domains and
      confirm the target name belongs to this project. This account hosts unrelated production
      Workers; a deploy under a taken name once overwrote another project's live secret.
   2. Establish d1-id.txt for professionalist-db-v2 so apply-schema/count-rows work here.
   Prints names, statuses and lengths only. Never prints a token, account id, uuid or key.

   Note on the token: this is an ACCOUNT-scoped token, so GET /user/tokens/verify returns
   401 "Invalid API Token" (code 1000) even when access is good. Verify against /accounts/{id}.
   node cf-api/tools/cloudflare-audit.mjs */
import fs from "node:fs";
import path from "node:path";
import { readTrim, locate, hideSecrets } from "./paths.mjs";

const TOKEN = readTrim("token");
const ACCT = readTrim("tmp", "acct.txt");
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const BASE = "https://api.cloudflare.com/client/v4";
const PROJECT_DB = "professionalist-db-v2";
const PROJECT_OLD_DB = "professionalist-db";
const PROJECT_MEDIA_BUCKET = "professionalist-media";
const PROJECT_LIMITS_KV = "professionalist-limits";
const OUR_WORKERS = ["proffessionalist-web", "professionalist-api"];

const show = s => hideSecrets(String(s)).slice(0, 200);

async function get(pathname) {
  const r = await fetch(`${BASE}${pathname}`, { headers: H });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`${r.status} ${pathname} -> ${show(JSON.stringify(j.errors || j))}`);
  return j.result;
}

const list = async (pathname, label) => {
  try {
    const result = await get(pathname);
    const arr = Array.isArray(result) ? result : (result?.result ?? result?.buckets ?? result?.namespaces ?? []);
    return { label, ok: true, count: arr.length, items: arr };
  } catch (err) {
    return { label, ok: false, error: show(err.message) };
  }
};

/* /workers/scripts puts the script NAME in `id`, queues in `queue_name`, KV in `title` */
const nameOf = i => i.name ?? i.id ?? i.queue_name ?? i.title ?? "?";

/* the check that actually works for an account token */
try {
  const acct = await get(`/accounts/${ACCT}`);
  console.log(`account access: OK (account name length ${String(acct.name ?? "").length}), token length ${TOKEN.length} not printed`);
} catch (err) {
  console.log(`account access: FAILED -> ${show(err.message)}`);
  process.exit(1);
}

const workers = await list(`/accounts/${ACCT}/workers/scripts`, "workers");
const d1 = await list(`/accounts/${ACCT}/d1/database`, "d1 databases");
const r2 = await list(`/accounts/${ACCT}/r2/buckets`, "r2 buckets");
const kv = await list(`/accounts/${ACCT}/storage/kv/namespaces`, "kv namespaces");
const domains = await list(`/accounts/${ACCT}/workers/domains`, "worker custom hostnames");
const queues = await list(`/accounts/${ACCT}/queues`, "queues");
const pages = await list(`/accounts/${ACCT}/pages/projects`, "pages projects");

for (const g of [workers, d1, r2, kv, queues]) {
  if (!g.ok) { console.log(`\n${g.label}: UNAVAILABLE -> ${g.error}`); continue; }
  const names = g.items.map(nameOf).filter(Boolean);
  console.log(`\n${g.label}: ${g.count}`);
  if (names.length) console.log(`   ${names.slice(0, 40).join(", ")}${names.length > 40 ? ` ...(${names.length - 40} more)` : ""}`);
  else console.log("   (none)");
}
if (pages.ok) console.log(`\npages projects: ${pages.count}${pages.count ? ` -> ${pages.items.map(p => p.name).join(", ")}` : " (none; §14's Pages option has no project yet)"}`);

/* hostname bindings are the real blast-radius map: they show what live traffic each script serves */
console.log("\nworker custom hostnames (live traffic map):");
if (!domains.ok) console.log(`  UNAVAILABLE -> ${domains.error}`);
else for (const d of domains.items) {
  const script = d.service ?? d.script ?? d.route_pattern ?? "?";
  const ours = OUR_WORKERS.includes(script);
  console.log(`  ${ours ? "[ours ]" : "[other]"} ${d.hostname} -> ${script}${d.zone_name ? ` (zone ${d.zone_name})` : ""}`);
}

/* ---- §2 preflight: does the deploy target belong to this project? ---- */
console.log("\n--- deploy preflight (handoff §2) ---");
/* Existence is decided by a DIRECT per-script request, not by parsing the list: an earlier draft
   of this tool trusted the list's wrong naming field and reported the live SPA script absent,
   which is exactly the "deploy under a name that is already taken" incident vector in §2. */
const scriptExists = async name => {
  const r = await fetch(`${BASE}/accounts/${ACCT}/workers/scripts/${name}`, { headers: H });
  await r.text().catch(() => "");
  if (r.status === 404) return { exists: false };
  let detail = {};
  try { detail = await get(`/accounts/${ACCT}/workers/scripts/${name}/settings`); } catch { /* settings may need extra scope */ }
  return {
    exists: true,
    assets: detail?.assets?.binding ?? null,
    bindings: (detail?.bindings ?? []).map(b => b.name),
    compat: detail?.compatibility_date,
  };
};
const workerNames = workers.ok ? workers.items.map(nameOf) : [];
for (const want of OUR_WORKERS) {
  const s = await scriptExists(want);
  const inList = workerNames.includes(want);
  const disagree = s.exists === inList ? "" : "   <-- list disagrees, trust the direct probe";
  console.log(`  ${want}: ${s.exists ? "EXISTS - deploying under this name REPLACES live code" : "free to create"}`
    + (s.exists ? ` (assets binding: ${s.assets ?? "none"}, bindings: ${s.bindings.length ? s.bindings.join("/") : "none"}, compat ${s.compat ?? "?"})` : "")
    + disagree);
}
const foreign = workerNames.filter(n => !OUR_WORKERS.includes(n));
console.log(`  project-owned scripts present: ${workerNames.filter(n => OUR_WORKERS.includes(n)).join(", ") || "(none)"}`);
console.log(`  OTHER scripts on this account (must not be touched): ${foreign.length} -> ${foreign.slice(0, 30).join(", ")}${foreign.length > 30 ? " ..." : ""}`);

const dbItems = d1.ok ? d1.items : [];
const target = dbItems.find(i => i.name === PROJECT_DB);
const old = dbItems.find(i => i.name === PROJECT_OLD_DB);
console.log(`\n  ${PROJECT_DB}: ${target ? "present" : "MISSING - §5.1 says it holds the current schema"}`);
console.log(`  ${PROJECT_OLD_DB}: ${old ? "still present (left untouched per §5.4)" : "absent"}`);

if (target) {
  const dir = locate("tmp");
  const idFile = path.join(dir, "d1-id.txt");
  const had = fs.existsSync(idFile);
  const prev = had ? fs.readFileSync(idFile, "utf8").trim() : null;
  fs.writeFileSync(idFile, target.uuid);
  fs.writeFileSync(path.join(dir, "d1-name.txt"), PROJECT_DB);
  if (prev && prev !== target.uuid) fs.writeFileSync(path.join(dir, "d1-id.previous.txt"), prev + "\n");
  console.log(`  d1-id.txt: ${had ? (prev === target.uuid ? "already correct" : "re-pointed (old id saved to d1-id.previous.txt)") : "created for this codespace"} (id length ${target.uuid.length}, not printed)`);
}

console.log(`\n  ${PROJECT_MEDIA_BUCKET}: ${r2.ok && r2.items.some(i => i.name === PROJECT_MEDIA_BUCKET) ? "exists" : "not created yet (#21)"}`);
console.log(`  ${PROJECT_LIMITS_KV}: ${kv.ok && kv.items.some(i => i.title === PROJECT_LIMITS_KV) ? "exists" : "not created yet (#19)"}`);
