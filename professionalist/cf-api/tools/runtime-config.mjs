/* Builds the config a real Worker actually runs with, outside the repository.

   wrangler.toml in cf-api/ is the reviewed, committed description of the Worker: it carries the
   D1 database_name and an id placeholder, because a uuid is a routing fact that belongs to one
   account and the handoff's §2 rule is that it is substituted at deploy time and never printed or
   committed.  Neither `wrangler dev` nor `wrangler deploy` accepts that placeholder, so every
   command that talks to Cloudflare reads the generated file this tool writes instead:

     <RUN_DIR>/wrangler.toml   the committed file + the real database_id + the production vars,
                               with `main` made absolute because the file now lives elsewhere
     <RUN_DIR>/dev.vars        the names `wrangler dev` feeds to env/process.env in place of
                               secrets, so a local sandbox issues tokens that verify against the
                               VPS's (same JWT_SECRET) — §2 forbids those values in the repo

   The var values come from the VPS's own environment file (the app reads process.env at module
   scope in 14 files, so a name the Worker does not supply falls back to the code's default, which
   is only correct if production never overrode it).  Read-only pull, cached at <RUN_DIR>/vps.env:
     ssh -i ~/.ssh/professionalist-vps.key opc@140.245.50.236 "cat /home/opc/professionalist/.env"
   Override the location with CF_VPS_ENV; override the output directory with CF_RUN_DIR.

   Nothing here prints a value.  The summary names the keys, says whether production's value agrees
   with the reviewed default in cf-api/wrangler.toml, and reports lengths only. */
import fs from "node:fs";
import path from "node:path";
import { readTrim, hideSecrets } from "./paths.mjs";

const API = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const RUN_DIR = process.env.CF_RUN_DIR || "/workspaces/cf-run";
const VPS_ENV = process.env.CF_VPS_ENV || path.join(RUN_DIR, "vps.env");
const COMMITTED = path.join(API, "wrangler.toml");

/* The names a Worker must answer with, split by how much they cost to leak.  Secrets go to
   dev.vars / `wrangler secret put`; the rest are ordinary [vars].  NODE_ENV is deliberately absent:
   grep over the mirror finds no reader for it, and the only thing it changes in Express is the
   wording of the finalhandler page the app's own error middleware already replaces. */
const SECRET_NAMES = ["JWT_SECRET", "MAILER_API_TOKEN", "OPS_OWNER_ID"];
const VAR_NAMES = ["CORS_ORIGIN", "MAILER_API_URL", "MAILER_ENABLED", "BODY_LIMIT", "USER_RATE_LIMIT",
  "AUTH_RATE_LIMIT", "IP_RATE_LIMIT", "JWT_EXPIRES_IN", "SESSION_TTL_SECONDS", "MAX_LOGIN_FAILURES",
  "LOCKOUT_MINUTES", "EMAIL_VERIFY_TTL_HOURS", "PASSWORD_RESET_TTL_MINUTES", "MAILER_TIMEOUT_MS"];

/* Database credentials and the listener's port have no reader in the Worker: src/db.js takes D1 off
   the binding, src/shims/https.js takes fetch, and a Worker has no app.listen.  Copying them over
   would put a live Postgres password into a Worker's environment for nothing. */
const DROPPED = ["DATABASE_URL", "DB_HOST", "DB_PORT", "DB_USER", "DB_NAME", "DB_PASSWORD", "REDIS_URL", "PORT", "NODE_ENV"];

function parseEnv(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out.set(m[1], m[2].replace(/^["']|["']$/g, ""));
  }
  return out;
}

/* the [vars] block of the committed file, so a production override that disagrees with the value
   reviewed into wrangler.toml is reported instead of silently winning */
function committedVars(toml) {
  const block = /^\[vars\]$/m.exec(toml);
  if (!block) return new Map();
  const rest = toml.slice(block.index + block[0].length);
  const end = /^\[[a-z_]+(\.|\])/m.exec(rest);
  const lines = (end ? rest.slice(0, end.index) : rest).split(/\r?\n/);
  const map = new Map();
  for (const line of lines) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/.exec(line.trim());
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

function main() {
  const toml = fs.readFileSync(COMMITTED, "utf8");
  const dbId = readTrim("tmp", "d1-id.txt");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dbId)) {
    throw new Error("d1-id.txt is not a uuid; re-establish it with create-db.mjs");
  }
  if (!fs.existsSync(VPS_ENV)) {
    throw new Error(`missing the VPS environment cache at ${VPS_ENV}. Pull it read-only:\n` +
      `  ssh -i ~/.ssh/professionalist-vps.key opc@140.245.50.236 "cat /home/opc/professionalist/.env" > ${VPS_ENV}\n` +
      `or point CF_VPS_ENV at an existing copy.  This tool never prints its contents.`);
  }
  const vps = parseEnv(fs.readFileSync(VPS_ENV, "utf8"));
  const have = committedVars(toml);

  const config = toml
    .replace(/^database_id = "placeholder"$/m, `database_id = "${dbId}"`)
    .replace(/^main = "src\/worker\.js"$/m, `main = "${path.join(API, "src", "worker.js")}"`);
  if (config.includes("placeholder")) throw new Error("the committed wrangler.toml no longer carries `database_id = \"placeholder\"` on its own line");

  const vars = [];
  const notes = [];
  for (const name of VAR_NAMES) {
    if (vps.has(name)) {
      vars.push([name, vps.get(name)]);
      if (have.has(name) && have.get(name) !== vps.get(name)) {
        notes.push(`${name}: production overrides the reviewed value (length ${vps.get(name).length})`);
      }
    } else if (have.has(name)) {
      notes.push(`${name}: kept at the reviewed wrangler.toml value (production does not set it)`);
    }
  }
  const secrets = SECRET_NAMES.filter(n => vps.has(n));
  const unexpected = [...vps.keys()].filter(n => !VAR_NAMES.includes(n) && !SECRET_NAMES.includes(n) && !DROPPED.includes(n));

  fs.mkdirSync(RUN_DIR, { recursive: true });
  const dev = process.argv.includes("--dev");
  const outFile = path.join(RUN_DIR, dev ? "wrangler.dev.toml" : "wrangler.toml");
  /* one [vars] table, not two, and no key twice inside it: TOML rejects a repeated table AND a
     repeated key, and the committed file already declares the names whose production value happens
     to be the reviewed default (CORS_ORIGIN, IP_RATE_LIMIT).  So each generated line takes the name
     out of the committed block first — the production value is the one that wins, which is the whole
     point of reading it off the VPS rather than trusting the comment above it. */
  let out = config;
  for (const [name, value] of vars) {
    out = out.replace(new RegExp(`^${name}\\s*=.*\\n`, "m"), "");
  }
  const generated = vars.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n");
  out = out.replace(/^\[vars\]$/m, `[vars]\n# generated by tools/runtime-config.mjs from the VPS environment;\n# do not edit and do not commit this file (it also carries the real D1 uuid)\n${generated}`);

  /* `node cf-api/tools/runtime-config.mjs --dev` writes wrangler.dev.toml instead: the same
     Worker, but with D1 and R2 read from the real account while the Durable Object runs locally.
     That is the only shape wrangler dev can offer — `wrangler dev --remote` refuses to give a
     Worker a Durable Object at all ("no longer supported for Durable Objects"), which measured as
     every request losing both RateLimit headers, because shims/limit.js lets a request through when
     the counter is unreachable.  Local counters are exactly what a parity run must not fake, so the
     object is local and the data is not. */
  if (process.argv.includes("--dev")) {
    out = out
      .replace(/^(\[\[d1_databases\]\])$/m, "$1\nremote = true")
      .replace(/^(\[\[r2_buckets\]\])$/m, "$1\nremote = true");
  }
  fs.writeFileSync(outFile, out.replace(/\s+$/, "") + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(RUN_DIR, "dev.vars"), `${secrets.map(k => `# ${k} — copied from the VPS environment by tools/runtime-config.mjs\n${k} = ${vps.get(k)}`).join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(outFile, 0o600);
  fs.chmodSync(path.join(RUN_DIR, "dev.vars"), 0o600);

  console.log(`wrote ${outFile} and ${path.join(RUN_DIR, "dev.vars")} (mode 600)${dev ? "  [dev: D1 and R2 read remotely, the Durable Object local]" : ""}`);
  console.log(`  d1: professionalist-db-v2, id substituted (${dbId.length} chars, not printed)`);
  console.log(`  [vars]: ${vars.map(([k]) => k).join(", ") || "(none)"} — values not printed`);
  console.log(`  dev.vars secrets: ${secrets.join(", ") || "(none)"}`);
  console.log(`  dropped: ${DROPPED.filter(n => vps.has(n)).join(", ")}`);
  if (unexpected.length) console.log(`  names on the VPS this tool does not map: ${unexpected.join(", ")} — add them deliberately`);
  for (const n of notes) console.log(`  note: ${hideSecrets(n)}`);
  const missing = SECRET_NAMES.filter(n => !vps.has(n));
  if (missing.length) console.log(`  WARNING: production sets none of ${missing.join(", ")}; a deploy without them runs the code's own fallback`);
  /* OPS_TOKEN is deliberately not in SECRET_NAMES: routes/spa/ops.js:78 only demands it when the
     name is set, and production does not set it, so setting it here would add a header requirement
     no current admin sends — a visible change, which the mandate forbids. */
}

main();
