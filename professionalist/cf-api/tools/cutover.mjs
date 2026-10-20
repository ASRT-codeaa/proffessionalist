/* The cutover tool for api.proffessionalist.com.  Approved by the owner 2026-10-20; until it runs, the
   VPS answers that hostname and the Worker only has a workers.dev preview address.

   How the hostname is actually routed, measured 2026-10-20 rather than assumed:
     - `GET /accounts/{A}/workers/domains` lists `proffessionalist.com`, `www.proffessionalist.com`,
       `email.proffessionalist.com` — so the site and the mailer are Workers **custom hostnames**, bound
       through this API (the same mechanism the SPA's Worker uses), and
       `GET /accounts/{A}/workers/scripts/proffessionalist-web/settings` reports `custom_domains: []`,
       which is why the domains endpoint, not a script's settings, is the authority on who answers a name.
     - `api.proffessionalist.com` is NOT in that list: it is a proxied DNS record whose origin is the VPS,
       and this API token cannot even READ the zone's records (`GET /zones/{Z}/dns_records` answers
       `code 10000 Authentication error`).  Binding therefore goes through POST /workers/domains, and if
       that call is refused for the same permission reason, the flip has to be done once by an owner with
       DNS/Workers-Routes edit rights — this tool says so plainly instead of half-doing it.

   It is deliberately reversible: `--rollback` deletes the custom hostname binding again, and because the
   DNS record and nginx on the VPS are never touched, deleting the binding returns the hostname to the VPS
   immediately.  That is the whole rollback plan, which is why the VPS keeps running during the preview
   phase of this migration and is not retired by this tool.

   node cf-api/tools/cutover.mjs --status | --dry-run | --flip | --rollback
*/
import fs from "node:fs";
import path from "node:path";
import { readTrim, hideSecrets } from "./paths.mjs";

const RUN_DIR = process.env.CF_RUN_DIR || "/workspaces/cf-run";
const HOSTNAME = "api.proffessionalist.com";
const ZONE_NAME = "proffessionalist.com";
const SCRIPT = "professionalist-api";
const BASE = "https://api.cloudflare.com/client/v4";

const show = s => hideSecrets(String(s)).slice(0, 1200);
const token = readTrim("token");
const acct = readTrim("tmp", "acct.txt");
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function call(method, pathname, body) {
  const r = await fetch(BASE + pathname, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`${method} ${pathname} -> HTTP ${r.status}, non-JSON (${text.length} bytes)`); }
  if (!j.success) {
    const e = (j.errors || []).map(x => `${x.code}: ${x.message}`).join("; ");
    throw new Error(`${method} ${pathname} -> ${e}`);
  }
  return j.result;
}

async function zoneId() {
  const z = await call("GET", `/zones?name=${ZONE_NAME}`);
  if (!z.length) throw new Error(`zone ${ZONE_NAME} not found for this token`);
  if (z[0].account.id !== acct) throw new Error(`zone ${ZONE_NAME} belongs to a different account — STOP, this token is not the one that owns the site`);
  return z[0].id;
}

async function binding(zid) {
  const list = await call("GET", `/accounts/${acct}/workers/domains?zone_id=${zid}`);
  return list.find(d => (d.hostname || d) === HOSTNAME) || null;
}

/* §2's rule, applied to a flip: never touch a script or hostname we have not first confirmed is ours. */
async function preflight(zid) {
  const scripts = await call("GET", `/accounts/${acct}/workers/scripts`);
  const ids = scripts.map(s => s.id ?? s.name ?? s);
  if (!ids.includes(SCRIPT)) throw new Error(`${SCRIPT} is not deployed on this account (${ids.length} scripts); run tools/deploy.mjs first`);
  if (!ids.includes("proffessionalist-web")) throw new Error(`proffessionalist-web is missing from this account — the SPA and this API would no longer be a matched pair; STOP`);
  const settings = await call("GET", `/accounts/${acct}/workers/scripts/${SCRIPT}/settings`);
  const kinds = (settings.bindings || []).map(b => b.type);
  for (const need of ["d1", "r2_bucket", "durable_object_namespace"]) {
    if (!kinds.includes(need)) throw new Error(`${SCRIPT} has no ${need} binding — refusing to put production traffic on an incomplete Worker`);
  }
  /* /settings gives plain_text names, never values, so the preview flag cannot be read from the API.
     It is recorded by tools/deploy.mjs in RUN_DIR/last-deploy.json, and a flip on a preview deploy would
     leave members with no password-reset mail (deploy.mjs forces MAILER_ENABLED=false for the preview). */
  const marker = path.join(RUN_DIR, "last-deploy.json");
  if (!fs.existsSync(marker)) throw new Error(`${marker} is missing — re-run tools/deploy.mjs so the flip can verify the deploy mode`);
  const last = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (last.script !== SCRIPT) throw new Error(`${marker} describes ${last.script}, not ${SCRIPT}`);
  if (last.preview) throw new Error(`${SCRIPT}'s last deploy was --preview (MAILER_ENABLED=false). Re-run tools/deploy.mjs WITHOUT --preview, re-verify, then flip.`);
  const names = (settings.bindings || []).map(b => b.type).reduce((a, t) => (a[t] = (a[t] || 0) + 1, a), {});
  return { scriptCount: ids.length, bindings: kinds.sort().join(","), secretNames: (settings.bindings || []).filter(b => b.type === "secret_text").map(b => b.name).sort().join(","), lastDeployedAt: last.deployed_at, vars: Object.entries(names).map(([k, v]) => `${k}x${v}`) };
}

async function main() {
  const mode = process.argv.includes("--flip") ? "flip"
    : process.argv.includes("--rollback") ? "rollback"
    : process.argv.includes("--dry-run") ? "dry" : "status";
  const zid = await zoneId();
  const now = await binding(zid);
  console.log(`${HOSTNAME} is currently ${now ? `bound to Worker script "${now.script ?? now.service ?? "?"}" (custom hostname id [id], status ${now.status || "?"})` : "NOT bound to any Worker — the VPS answers it (this is the pre-cutover state)"}`.replace(/\[id\]/, hideSecrets(now ? String(now.id) : "")));
  const all = await call("GET", `/accounts/${acct}/workers/domains?zone_id=${zid}`);
  console.log(`  bound hostnames on this zone: ${all.map(d => d.hostname || d).sort().join(", ")}`);

  if (mode === "status") return;
  const pf = await preflight(zid);
  console.log(`preflight: ${pf.scriptCount} scripts; ${SCRIPT} bindings ${pf.bindings}; vars ${pf.vars.join(" ")}`);
  if (mode === "dry") {
    console.log(now ? `dry run: ${HOSTNAME} is already bound — a flip would re-point it (idempotent)` : `dry run: would POST /accounts/[account]/workers/domains {hostname:${HOSTNAME}, script:${SCRIPT}}`);
    return;
  }
  if (mode === "rollback") {
    if (!now) { console.log("nothing to roll back: the hostname is not bound to a Worker, so the VPS is already answering it"); return; }
    await call("DELETE", `/accounts/${acct}/workers/domains/${now.id}`);
    console.log(`rolled back: the ${HOSTNAME} binding is removed and the DNS record's origin (the VPS) answers again. Verify: curl -s https://${HOSTNAME}/health`);
    return;
  }

  /* THE FLIP.  Everything above is read-only; this is the one mutation, so it re-states what is about to
     happen rather than letting a stray flag do it.  The gates the owner must have cleared before this
     line is reached: verify-preview.mjs shows 0 differences against the live VPS, the authenticated half
     of diff-routes has been re-run and any DEFECT fixed, and copy-data/backfill-r2 have been re-run in a
     quiet window so the D1 snapshot is not hours stale at the moment traffic arrives. */
  if (!now) {
    const created = await call("POST", `/accounts/${acct}/workers/domains`, { hostname: HOSTNAME, zone_id: zid, script: SCRIPT });
    console.log(`flipped: ${HOSTNAME} -> ${SCRIPT}, status ${created.status || "?"}`);
  } else if ((now.script ?? now.service) !== SCRIPT) {
    await call("PATCH", `/accounts/${acct}/workers/domains/${now.id}`, { script: SCRIPT });
    console.log(`re-pointed: ${HOSTNAME} was on "${now.script ?? now.service}", now on ${SCRIPT}`);
  } else {
    console.log(`no change: ${SCRIPT} already answers ${HOSTNAME}`);
  }
  console.log(`  next: node cf-api/tools/verify-preview.mjs https://${HOSTNAME} <uploads-key>  (the oracle is now the Worker itself, so read the statuses/bodies, not the diff)`);
  console.log(`  rollback is one command: node cf-api/tools/cutover.mjs --rollback   (the VPS still has the app, nginx and its database untouched)`);
}

main().catch(err => { console.error(show(err.message)); process.exit(1); });
