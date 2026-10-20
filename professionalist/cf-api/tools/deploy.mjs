/* Deploys the Worker as `professionalist-api`, after the §2 preflight that a 2026-10-12 incident
   made non-negotiable: this account hosts 65 other people's Workers, and a deploy under a name that
   already belongs to one of them replaces live code and its secrets.  So this tool lists
   /workers/scripts FIRST, refuses if the target exists unless --allow-overwrite is passed, and
   refuses if the name is not exactly professionalist-api — proffessionalist-web is the SPA and is
   never a deploy target from here.

   It deploys the GENERATED config (/workspaces/cf-run/wrangler.toml from tools/runtime-config.mjs),
   never the committed one: the committed file carries `database_id = "placeholder"` on purpose (§2),
   and only the generated file has the real uuid plus the values read off the VPS's own environment.
   Neither generated file is ever printed, and neither is in the repository.

   Secrets go through `wrangler secret put` with the value piped on stdin from /workspaces/cf-run/
   dev.vars, which tools/runtime-config.mjs wrote from the VPS environment: a secret never appears on
   a command line, in this process's arguments, or in anything this tool prints.  OPS_TOKEN is
   deliberately absent — routes/spa/ops.js:78 only demands x-ops-token when the name is set and
   production does not set it, so setting it would add a requirement no current admin satisfies.

     node cf-api/tools/deploy.mjs [--dry-run] [--allow-overwrite] */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readTrim, hideSecrets } from "./paths.mjs";

const RUN_DIR = process.env.CF_RUN_DIR || "/workspaces/cf-run";
const CONFIG = path.join(RUN_DIR, "wrangler.toml");
const DEV_VARS = path.join(RUN_DIR, "dev.vars");
const SCRIPT = "professionalist-api";
const FORBIDDEN = ["proffessionalist-web"];
const SECRET_NAMES = ["JWT_SECRET", "MAILER_API_TOKEN", "OPS_OWNER_ID"];
const BASE = "https://api.cloudflare.com/client/v4";

const show = s => hideSecrets(String(s)).slice(0, 4000);

async function api(pathname, token, acct) {
  const r = await fetch(`${BASE}${pathname}`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  const text = await r.text();
  /* GET /workers/scripts/{name} answers the multipart script bundle itself, not JSON — its metadata
     lives under /settings.  A non-JSON answer must be named as such rather than thrown through
     JSON.parse, which is what made a finished deploy look like it had failed. */
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`${pathname} answered HTTP ${r.status} with ${text.length} bytes of non-JSON — script metadata is at /settings, not at the script url`);
  }
  if (!j.success) throw new Error(`CF API ${pathname} failed: ${(j.errors || []).map(e => e.message).join("; ")}`);
  return j.result;
}

function secretValue(name) {
  const m = new RegExp(`^${name}\\s*=\\s*(.*)$`, "m").exec(fs.readFileSync(DEV_VARS, "utf8"));
  if (!m) throw new Error(`dev.vars has no ${name}; re-run tools/runtime-config.mjs`);
  return m[1].replace(/^["']|["']$/g, "");
}

function wrangler(args, stdin, env) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: path.join(RUN_DIR, ".."),
    encoding: "utf8",
    input: stdin,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: env.token, CLOUDFLARE_ACCOUNT_ID: env.acct },
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  const allowOverwrite = process.argv.includes("--allow-overwrite");
  for (const f of [CONFIG, DEV_VARS]) {
    if (!fs.existsSync(f)) throw new Error(`${f} is missing — run: node cf-api/tools/runtime-config.mjs`);
  }
  const token = readTrim("token");
  const acct = readTrim("tmp", "acct.txt");

  /* §2 preflight */
  const scripts = await api(`/accounts/${acct}/workers/scripts`, token, acct);
  const names = scripts.map(s => s.id ?? s.name ?? s);
  const target = names.includes(SCRIPT);
  console.log(`preflight: ${names.length} Worker scripts on this account; ${FORBIDDEN.includes(SCRIPT) ? "TARGET IS FORBIDDEN" : `${SCRIPT} ${target ? "EXISTS" : "is free to create"}`}`);
  for (const f of FORBIDDEN) if (f === SCRIPT) throw new Error(`refusing: ${SCRIPT} is a name this project never deploys to`);
  if (target && !allowOverwrite) {
    throw new Error(`${SCRIPT} already exists. Confirm it is OURS (created by an earlier run of this tool) and re-run with --allow-overwrite.`);
  }

  if (dry) {
    console.log(`dry run: would deploy ${CONFIG}`);
    console.log(`  secrets to set: ${SECRET_NAMES.join(", ")} (values read from dev.vars, never printed)`);
    console.log(`  command: npx wrangler deploy -c ${CONFIG}`);
    return;
  }

  console.log("deploying…");
  /* --preview is the mode this migration ships in first: the Worker gets a workers.dev address, so
     a stranger who finds it could call /api/auth/forgot-password with any real member's address and
     make the account's own mailer deliver to them.  services/mailer.js:18 turns itself off on
     MAILER_ENABLED=false without changing any response body (the route answers the same way whether
     or not the send happened), so the preview is behaviourally identical apart from the delivery
     that a preview must not do.  Drop the flag at the hostname flip, when only real traffic
     reaches the Worker. */
  const preview = process.argv.includes("--preview");
  const deployArgs = ["deploy", "-c", CONFIG];
  if (preview) deployArgs.push("--var", "MAILER_ENABLED:false");
  console.log(show(wrangler(deployArgs, undefined, { token, acct })));
  if (preview) console.log("  preview: MAILER_ENABLED=false — re-deploy WITHOUT the flag before any hostname points here");

  /* secrets must go AFTER the first deploy: `wrangler secret put` on a script that does not exist
     yet fails, and the Worker cannot answer a request until JWT_SECRET exists, so the order is
     deploy → secrets and any re-deploy keeps them (they live on the script, not the bundle) */
  for (const name of SECRET_NAMES) {
    if (!fs.readFileSync(DEV_VARS, "utf8").includes(name)) {
      console.log(`  secret ${name}: not in dev.vars (production does not set it) — the code's own fallback applies`);
      continue;
    }
    const out = wrangler(["secret", "put", name, "-c", CONFIG], secretValue(name), { token, acct });
    console.log(show(out).split(/\r?\n/).slice(-2)[0] || `  secret ${name}: set`);
  }

  const after = await api(`/accounts/${acct}/workers/scripts/${SCRIPT}/settings`, token, acct);
  /* /settings returns bindings as a flat [{type, name, ...}] array, not the keyed shape the older
     script endpoint used — printing the type names is what makes "is the D1 uuid really substituted,
     did the DO namespace get created" answerable from this output alone */
  const list = Array.isArray(after.bindings) ? after.bindings : [];
  const byType = t => list.filter(x => x.type === t).map(x => x.name ?? x.binding).sort().join(",") || "-";
  console.log(`deployed ${SCRIPT}: d1=${byType("d1")} r2=${byType("r2_bucket")} `
    + `do=${list.filter(x => x.type === "durable_object_namespace").map(x => `${x.name}(${x.class_name})`).join(",") || "-"}`);
  console.log(`  plain vars: ${list.filter(x => x.type === "plain_text" || x.type === "v1_alpha").map(x => x.name).sort().join(", ") || "(none)"}; `
    + `secrets: ${list.filter(x => x.type === "secret_text").map(x => x.name).sort().join(", ") || "(none reported)"}`);
  console.log(`  routes: ${(after.routes || []).map(r => r.pattern ?? r).join(", ") || "(none — workers.dev preview only, no custom hostname points here)"}`);
}

main().catch(err => { console.error(show(err.message)); process.exit(1); });
