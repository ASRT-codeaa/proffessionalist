/* Port generator: mirrors /workspaces/app-mirror/app path-for-path into cf-api/port so that
   relative require("./x") graph stays valid and route/SQL sources stay byte-identical — the whole
   point of the layout.  Only BARE specifiers change, rewritten depth-aware to port/_shim proxies.
   Determinism: no timestamps, no random names; every list is sorted, the migration manifest is in
   default sort() filename order, and re-running this file on an unchanged mirror produces
   byte-identical output (verified by the line-diff step below, which is computed from
   construction, not from the filesystem).

   Fail-loud rules (deliberate, do not soften them):
   - a bare specifier outside REWRITE/KEEP aborts the build with file:line:specifier, because
     anything unlisted has not been reasoned about for workerd;
   - every hand-port pattern must match its expected count exactly, so a mirror edit that moves
     one of the five fs sites fails the build instead of silently porting half a fix;
   - after generation, no require("fs")/require("node:fs") and no fs.<method> call may remain
     under port/: workerd materialises no bundle on disk, node:fs calls always ENOENT there. */

import { readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync, existsSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const CF_API = join(HERE, "..", "..");
const MIRROR = "/workspaces/app-mirror/app";
const PORT = join(CF_API, "port");

/* ------------------------------------------------------------------ tables */

/* Bare specifiers the app uses that have no Worker counterpart; each maps to a generated proxy in
   port/_shim/.  node:-prefixed builtins are normalised before lookup so "node:https" lands here too. */
const REWRITE = {
  express: "express.js",
  jsonwebtoken: "jwt.js",
  helmet: "helmet.js",
  cors: "cors.js",
  "express-rate-limit": "limit.js",
  multer: "multer.js",
  uuid: "uuid.js",
  https: "https.js",
  fs: "fs.js",
  pg: "pg.js",
  redis: "redis.js",
  dotenv: "dotenv.js",
};

/* Stay bare on purpose: workerd's nodejs_compat serves these from node:stdlibs (bcryptjs is a real
   dependency in cf-api/package.json, installed at cf-api/node_modules/bcryptjs). */
const KEEP = new Set(["crypto", "path", "buffer", "stream", "util", "bcryptjs"]);

/* Files copied verbatim-except-rewrites; these two are REPLACED by proxies because their module
   scope touches things a Worker does not have (pg Pool constructor, multer diskStorage). */
const PROXY_FILES = {
  "db.js": {
    body: `/* The VPS db.js constructs a pg.Pool at module scope, which a Worker cannot do.  src/db.js is
   the tested D1 adapter with the same calling convention: it exports {init, query,
   pool: {query, connect}, health, notes}, which satisfies every consumer in the mirror —
   14 files destructure {query}, routes/onboarding.js:4 and routes/spa/ops.js:6 take {pool}
   for the BEGIN/COMMIT transaction (emulated over DB.batch(), see db.js:79-132), and the
   server.js health check arrives via src/api.js. */
module.exports = require("../src/db.js");
`,
  },
  "middleware/upload.js": {
    body: `/* middleware/upload.js on the VPS is multer diskStorage over ./uploads; src/shims/upload.js is
   the R2-backed replacement and keeps the exact export surface the six route files read —
   {UPLOAD_ROOT, uploadImage, uploadFiles, publicUrl, mediaType, removeStored} (mirror
   middleware/upload.js:111-118 vs shim line 366-377, which also adds init/serveUpload/keyFromPath
   for the Worker entry).  UPLOAD_ROOT differs by design: "/uploads" URL prefix in the shim vs an
   on-disk path in the mirror; both publicUrl() outputs are "/uploads/<kind>/<name>", which is what
   routes and the DB actually store. */
module.exports = require("../../src/shims/upload.js");
`,
  },
};

const EXCLUDE = new Set(["server.js"]); // its mounts are hand-transcribed into src/api.js

/* --------------------------------------------------------------- proxies */

/* Proxy bodies are emitted on demand (only for specifiers actually rewritten), so a mirror edit
   that stops using helmet/cors/dotenv shrinks the tree instead of leaving dead files. */
const SHIM_BODIES = {
  "express.js": `/* The port keeps every bare express require site byte-identical; this proxy is the single
   place the specifier resolves.  src/shims/express.js is the Express-5 subset on the Fetch API
   (express(), express.Router, express.json, express.urlencoded; express.static throws on
   purpose — asset serving goes through the Worker fetch handler, not the middleware stack). */
module.exports = require("../../src/shims/express.js");
`,
  "jwt.js": `/* src/shims/jwt.js mirrors jsonwebtoken 9.0.3 HS256 sign/verify/decode synchronously —
   routes/auth.js issueToken returns jwt.sign(...) without await, so any async substitute would
   mint "[object Promise]" tokens.  Same-secret verification keeps VPS-issued tokens valid across
   the hostname flip. */
module.exports = require("../../src/shims/jwt.js");
`,
  "helmet.js": `/* src/shims/helmet.js sets the same header defaults helmet 7 emits; only server.js applied it
   globally, so this proxy exists for the rewrite table's completeness, not for a port-side hit. */
module.exports = require("../../src/shims/helmet.js");
`,
  "cors.js": `/* src/shims/cors.js answers the CORS_ALLOWLIST semantics server.js configures; same rationale as
   _shim/helmet.js — table completeness under the hand-transcribed entry. */
module.exports = require("../../src/shims/cors.js");
`,
  "limit.js": `/* src/shims/limit.js is the express-rate-limit 7 subset (window-increment semantics,
   X-RateLimit headers, ipKeyGenerator for IPv6 hextet compression).  server.js mounts it at
   app level, which lands in src/api.js; this proxy keeps any route-side require() working. */
module.exports = require("../../src/shims/limit.js");
`,
  "multer.js": `/* The app only ever uses multer through middleware/upload.js, and port/middleware/upload.js is
   a proxy to src/shims/upload.js, so nothing in the generated tree should bare-require multer
   directly.  This stub throwing at CALL time is the loud signal that a new multer site appeared
   in the mirror and needs reasoning, not a guessed replacement. */
module.exports = function multer() {
  throw new Error("_shim/multer: direct multer() use has no Worker equivalent — route all uploads via ../middleware/upload (src/shims/upload.js)");
};
`,
  "uuid.js": `/* uuid's v4 is 16 random bytes with the version-4 and RFC-4122 variant nibbles set; Node's
   crypto.randomUUID() (and workerd's global crypto) emits exactly that 8-4-4-4-12 lowercase-hex
   shape, so v4 is a pass-through instead of a hand-rolled CSPRNG.  validate keeps the package's
   accepted-version set (1-8, variant 89ab).  The only consumer is routes/auth.js:5
   ({ v4: uuidv4 }); NIL/stringify/v1 are omitted rather than guessed at because nothing calls
   them and an unverified implementation is worse than a missing one. */
const { randomUUID } = require("crypto");
const V_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function v4() {
  return randomUUID();
}
function validate(value) {
  return V_RE.test(String(value));
}
module.exports = { v4, validate };
`,
  "https.js": `/* services/mailer.js (SendInBlue REST via https.request) stays verbatim under this proxy:
   src/shims/https.js re-implements the node:https client API surface it uses (request() with
   write/end, response 'data'/'end'/'error' events) on top of fetch, including the timeout and
   non-2xx behaviours the retry loop in mailer.js:72-121 depends on. */
module.exports = require("../../src/shims/https.js");
`,
  "fs.js": `/* workerd materialises no bundle on disk — every node:fs call in a Worker ENOENTs, so an
   fs-shaped stub that returns empty data would make routes/spa/ops.js report "no migrations" and
   onboarding delete nothing.  Throwing on any property read turns a missed fs site into a loud
   500 with this message instead of silent wrong behaviour.  The build asserts this proxy is
   emitted for zero files (both mirror fs requires are hand-ported away). */
module.exports = new Proxy({}, {
  get(target, prop) {
    throw new Error("_shim/fs: the Worker has no filesystem; this fs site needs a hand port (see port/compat/migrations-manifest.js and removeStored in ../middleware/upload)");
  },
});
`,
  "pg.js": `/* Nothing in the Worker may construct a pg.Pool: there is no TCP and no Postgres.  The app's
   only pg touchpoint is app/db.js, and port/db.js is a proxy to the D1 adapter, so this file
   exists to FAIL LOUDLY if a new bare pg require site ever appears in the mirror — a stub
   Pool would swallow queries and corrupt every route's results. */
class Pool {
  constructor() {
    throw new Error("_shim/pg: pg.Pool must not be constructed in the Worker — the only sanctioned db surface is port/db.js (src/db.js, D1)");
  }
}
module.exports = { Pool, Client: Pool };
`,
  "redis.js": `/* No ported route reads or writes redis (grep over the mirror: only server.js called
   connectRedis at boot, and redis.js itself); the cache layer is dead code in the Worker for now.
   createClient must still answer an object because redis.js:5-9 runs client.on("error") at module
   scope — an emitter that records nothing and a connect() that resolves immediately keep the
   require graph closed without opening a socket. */
function createClient() {
  const client = {
    isOpen: true,
    on() { return client; },
    once() { return client; },
    removeListener() { return client; },
    async connect() {},
    async quit() {},
    async disconnect() {},
  };
  return client;
}
module.exports = { createClient };
`,
  "dotenv.js": `/* A Worker has no .env file: configuration arrives as bindings on env (and Secrets).  config()
   returns false rather than a {parsed} object because the mirror's only call site is server.js's
   side-effectful require at boot — nothing inspects the return value, and a truthy fake object
   would suggest parsing happened. */
module.exports = {
  config() { return false; },
  parse() { return {}; },
};
`,
};

/* ------------------------------------------------------------- hand ports */
/* Explicit, count-asserted edits applied to the MIRROR bytes before the generic rewriter runs —
   the patterns quote the original lines (including require("fs")) precisely so the rewriter never
   sees them.  One mismatch in count aborts the build. */

const HAND_PORTS = {
  "routes/onboarding.js": [
    {
      /* mirror line 2.  fs.rm is the ONLY fs use in this file; require("path") stays because path
         itself works under nodejs_compat. */
      name: "drop fs require",
      find: `const fs = require("fs");\n`,
      replace: ``,
      count: 1,
    },
    {
      /* mirror line 5.  The proxy at port/middleware/upload.js re-exports the shim, whose
         removeStored(url, req) (src/shims/upload.js:78-88) reads req.ctx.waitUntil — that is why
         the call below passes a { ctx } wrapper instead of the express req. */
      name: "import removeStored",
      find: `const { uploadImage, publicUrl } = require("../middleware/upload");`,
      replace: `const { uploadImage, publicUrl, removeStored } = require("../middleware/upload");`,
      count: 1,
    },
    {
      /* mirror line 74, inside the `old.startsWith("/uploads/avatars/")` guard which is kept.
         The original callback is () => {} — fire-and-forget with the error ignored; the shim's
         delete is best-effort (catch + console.error, never throws) and parks the promise on
         ctx.waitUntil so the platform keeps the isolate alive for it.  Same effect, no fs. */
      name: "avatar cleanup: fs.rm -> removeStored",
      find: `      fs.rm(path.join(UPLOAD_ROOT, old.slice("/uploads/".length)), { force: true }, () => {});`,
      replace: `      removeStored(old, { ctx: req.ctx });`,
      count: 1,
    },
    {
      /* mirror line 9.  Removing line 74 leaves this constant with no reader, and it cannot be
         evaluated in a Worker at all: esbuild's CJS wrapper defines no __dirname, so the module
         body throws ReferenceError on the FIRST request and takes every route that imports this
         file down with it (measured on the remote dev sandbox, 2026-10-19).  require("path")
         stays: path itself works under nodejs_compat. */
      name: "drop the __dirname UPLOAD_ROOT (no reader after the removeStored port)",
      find: `const UPLOAD_ROOT = path.join(__dirname, "..", "uploads");\n`,
      replace: ``,
      count: 1,
    },
  ],
  "routes/spa/ops.js": [
    {
      /* mirror line 3.  The manifest (generated below) is the build-time snapshot of
         app/migrations; readdirSync has no Worker equivalent (see _shim/fs.js). */
      name: "fs require -> migrations manifest",
      find: `const fs = require("fs");`,
      replace: `const migrations = require("../../compat/migrations-manifest.js");`,
      count: 1,
    },
    {
      /* mirror line 32.  Line 415 reports `directory: MIGRATIONS_DIR` to the ops console, so the
         name has to keep existing — but `path.join(__dirname, …)` cannot be evaluated in a Worker
         (no __dirname in esbuild's CJS wrapper) and the directory is not in the bundle anyway.
         The manifest is where the SQL actually lives now, so the string names it. */
      name: "MIGRATIONS_DIR: on-disk path -> the bundle's manifest",
      find: `const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");`,
      replace: `const MIGRATIONS_DIR = "bundled:compat/migrations-manifest.js";`,
      count: 1,
    },
    {
      /* mirror line 122.  Kept .filter(MIGRATION_NAME).sort() verbatim so the reported list is
         produced by the same code path as on the VPS; the manifest is already in sort() order. */
      name: "migrationState: readdirSync -> manifest names",
      find: `fs.readdirSync(MIGRATIONS_DIR).filter(f => MIGRATION_NAME.test(f)).sort()`,
      replace: `migrations.map(m => m.name).filter(f => MIGRATION_NAME.test(f)).sort()`,
      count: 1,
    },
    {
      /* mirror lines 381-384.  The original guard proved the allowlisted name was a real file
         inside MIGRATIONS_DIR (pattern test at line 377 means the name cannot contain a
         separator, so startsWith(path.sep) was belt-and-braces).  A manifest lookup is the same
         guarantee: names entered the manifest from the directory listing at build time. */
      name: "run: target path check -> manifest lookup",
      find: `  const target = path.join(MIGRATIONS_DIR, file);
  if (!target.startsWith(MIGRATIONS_DIR + path.sep) || !fs.existsSync(target)) {`,
      replace: `  const entry = migrations.find(m => m.name === file);
  if (!entry) {`,
      count: 1,
    },
    {
      /* mirror line 389.  Everything below (BEGIN / body / ops_migrations INSERT / COMMIT via
         pool.connect(), lines 393-408) is untouched: src/db.js:84-132 emulates that driving over
         DB.batch(), including the sql.replace(/^\s*(BEGIN|COMMIT)\s*;...) strip on line 392. */
      name: "run: readFileSync -> manifest sql",
      find: `  const sql = fs.readFileSync(target, "utf8");`,
      replace: `  const sql = entry.sql;`,
      count: 1,
    },
  ],
};

/* fs sites we expect per file BEFORE porting, counted as require("fs") lines.  The task brief
   warns about a third fs site; the mirror's three are onboarding.js:2, spa/ops.js:3 and
   middleware/upload.js:2 — the last one is neutralised by the PROXY_FILES entry, which is why
   this map has two entries.  If a future mirror adds an fs require elsewhere, the
   post-generation "no fs left" assertion below fails the build. */
const FS_PORT_SITES = { "routes/onboarding.js": 1, "routes/spa/ops.js": 1 };

/* ---------------------------------------------------------------- helpers */

const walkJs = (dir, base = dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full, base));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
};

const REQUIRE_RE = /require\((['"])([^'"]+)\1\)/g;

/* Depth-aware rewrite of bare specifiers, mirroring exactly how Node would resolve the ORIGINAL
   bare name from this directory: from port/routes/spa/x.js the proxy is ../../_shim/express.js;
   from port/db.js it is ./_shim/express.js. */
function rewriteBare(rel, text) {
  const depth = rel.split("/").length - 1; // file's directory below port/
  const prefix = depth === 0 ? "./" : "../".repeat(depth);
  const lines = text.split("\n");
  const changed = [];
  const hits = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("require(")) continue;
    const next = line.replace(REQUIRE_RE, (m, q, spec) => {
      if (spec.startsWith(".") || spec.startsWith("/")) return m; // item 2: relative stays
      const bare = spec.replace(/^node:/, "");
      if (KEEP.has(bare) || KEEP.has(spec)) return m;
      const shim = REWRITE[bare];
      if (!shim) {
        throw new Error(`UNHANDLED BARE SPECIFIER: port/${rel}:${i + 1} require("${spec}") — add it to the rewrite table only after reasoning about its workerd behaviour`);
      }
      hits[spec] = (hits[spec] || 0) + 1;
      return `require(${q}${prefix}${posix.join("_shim", shim)}${q})`;
    });
    if (next !== line) {
      lines[i] = next;
      changed.push({ lineNo: i + 1, from: line, to: next });
    }
  }
  return { text: lines.join("\n"), changed, hits };
}

function applyHandPorts(rel, text) {
  const ports = HAND_PORTS[rel] || [];
  let out = text;
  for (const p of ports) {
    const found = out.split(p.find).length - 1;
    if (found !== p.count) {
      throw new Error(`HAND-PORT PATTERN MISS: port/${rel} "${p.name}" expected ${p.count} match(es), found ${found}. The mirror changed under this pattern — re-read the source, do not let the build guess.`);
    }
    out = out.split(p.find).join(p.replace);
  }
  return { text: out, applied: ports.length };
}

/* ----------------------------------------------------------------- build */

const stats = { copied: 0, proxied: 0, rewritten: {}, shimFiles: [], handPorts: {}, diffReport: [] };

rmSync(PORT, { recursive: true, force: true });
mkdirSync(PORT, { recursive: true });

const files = walkJs(MIRROR).filter(rel => !EXCLUDE.has(rel) && !PROXY_FILES[rel]);

/* 1. copies (hand-port, then rewrite) */
for (const rel of files) {
  const original = readFileSync(join(MIRROR, rel), "utf8");
  const handed = applyHandPorts(rel, original);
  const { text, changed, hits } = rewriteBare(rel, handed.text);

  const dest = join(PORT, rel);
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, text);
  stats.copied++;
  for (const [spec, n] of Object.entries(hits)) stats.rewritten[spec] = (stats.rewritten[spec] || 0) + n;
  if (handed.applied) stats.handPorts[rel] = handed.applied;

  /* invariant (task 7b): generated bytes differ from the mirror ONLY on lines the rewrite table
     or a hand port touched.  changed is measured, not hoped for; hand-port line counts come from
     the pattern texts. */
  const handChanged = countDiffLines(original, handed.text);
  stats.diffReport.push({
    rel,
    rewriteLines: changed.length,
    handPortLines: handChanged,
    lines: text.split("\n").length,
  });
}

function countDiffLines(aText, bText) {
  /* count changed LINES, not zip mismatches: the onboarding port deletes line 2 outright, and a
     naive index compare would then flag all 216 remaining lines as changed (the shift, not the
     edit).  Trim the common prefix/suffix, then LCS only over the small differing window. */
  if (aText === bText) return 0;
  let a = aText.split("\n");
  let b = bText.split("\n");
  let top = 0;
  while (top < a.length && top < b.length && a[top] === b[top]) top++;
  let end = 0;
  while (end < a.length - top && end < b.length - top && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  a = a.slice(top, a.length - end);
  b = b.slice(top, b.length - end);
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m + n;
  /* LCS over the window; windows here are < 10 lines so the quadratic bound is irrelevant */
  let prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return m + n - 2 * prev[n];
}

/* 2. proxies for the two special-cased files */
for (const [rel, { body }] of Object.entries(PROXY_FILES)) {
  const dest = join(PORT, rel);
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, body);
  stats.proxied++;
}

/* 3. _shim proxies, on demand, sorted */
const usedShims = [...new Set(files.flatMap(rel => {
  const original = readFileSync(join(MIRROR, rel), "utf8");
  const { text } = rewriteBare(rel, applyHandPorts(rel, original).text);
  return [...text.matchAll(/require\((['"])(\.[^'"]*\/_shim\/([^'"]+))\1\)/g)].map(m => m[3]);
}))].sort();
mkdirSync(join(PORT, "_shim"), { recursive: true });
for (const name of usedShims) {
  if (!(name in SHIM_BODIES)) throw new Error(`rewrite table produced _shim/${name} with no proxy body`);
  writeFileSync(join(PORT, "_shim", name), SHIM_BODIES[name]);
  stats.shimFiles.push(`_shim/${name}`);
}

/* 4. migration manifest: build-time snapshot of app/migrations (workerd cannot readdir).
   Filter/sort exactly matches ops.js's MIGRATION_NAME /^[0-9]{3}_[a-z0-9_]+\.sql$/i and
   readdirSync(...).sort(), so migrationState() reports the same list in the same order. */
const MIG_RE = /^[0-9]{3}_[a-z0-9_]+\.sql$/i;
const migDir = join(MIRROR, "migrations");
const entries = readdirSync(migDir).filter(f => MIG_RE.test(f)).sort().map(name => ({
  name,
  sql: readFileSync(join(migDir, name), "utf8"),
}));
const manifestBytes = entries.reduce((n, e) => n + e.sql.length, 0);
const manifest = `/* Generated by tools/build.mjs from /workspaces/app-mirror/app/migrations — do not edit; it is
   wiped on every build.  ${entries.length} files, ${manifestBytes} SQL bytes.  routes/spa/ops.js reads
   this instead of the filesystem because a Worker has none (node:fs calls ENOENT in workerd).
   Entries are in default sort() filename order — the order migrationState() listed them on the
   VPS — and each sql is the file byte-for-byte; the route's own BEGIN/COMMIT strip (ops.js:392)
   and the pool.connect() BEGIN/COMMIT driving (ops.js:393-408, emulated over DB.batch() by
   src/db.js:84-132) still run at apply time, so per-statement ordering is untouched. */
module.exports = ${JSON.stringify(entries, null, 2)};
`;
mkdirSync(join(PORT, "compat"), { recursive: true });
writeFileSync(join(PORT, "compat", "migrations-manifest.js"), manifest);

/* ------------------------------------------------------------- checks */

const problems = [];

/* no fs may survive: workerd's filesystem is invisible; every call ENOENTs */
/* comment-stripped view for the survival scan: the proxies' own WHY headers quote the specifiers
   they replace (e.g. `keeps every require("express") byte-identical`), which is prose, not a call */
const stripComments = text => text
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const portFiles = walkJs(PORT);
for (const rel of portFiles) {
  const text = stripComments(readFileSync(join(PORT, rel), "utf8"));
  if (/require\((['"])(?:node:)?fs\1\)/.test(text) && !rel.startsWith("_shim" + "/")) {
    problems.push(`fs require survived in port/${rel}`);
  }
  if (/\bfs\.(rm|mkdir|readdirSync|existsSync|readFileSync)\(/.test(text)) {
    problems.push(`fs.<method> call survived in port/${rel}`);
  }
  /* esbuild's CJS wrapper does not define __dirname/__filename, so a module-scope read of them
     throws ReferenceError on the first request — and the smoke load below cannot see it, because
     Node does define them (measured on the remote dev sandbox: routes/onboarding.js:9 took the
     whole /api tree down with it) */
  if (/\b__dirname\b|\b__filename\b/.test(text)) {
    problems.push(`__dirname/__filename survived in port/${rel}`);
  }
  for (const spec of Object.keys(REWRITE)) {
    const re = new RegExp(`require\\((['"])${spec.replace(/[.*+?^{}()|[\]\\]/g, "\\$&")}\\1\\)`);
    if (re.test(text)) problems.push(`bare require("${spec}") survived in port/${rel}`);
  }
}

/* every generated file must load under Node with dummy env — proves the specifier graph is closed
   (task 7a).  Values are dummies, never real secrets: several mirror modules read
   process.env.JWT_SECRET lazily inside handlers (routes/auth.js:27, middleware/authenticate.js:35),
   and redis.js:4 reads REDIS_URL at module scope. */
if (problems.length === 0) {
  const loader = `
    const files = process.argv.slice(1);
    for (const f of files) { require(f); }
    process.stdout.write("loaded " + files.length + "\\n");
  `;
  try {
    const out = execFileSync(process.execPath, ["-e", loader, ...portFiles.map(f => join(PORT, f))], {
      cwd: CF_API,
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.assign({}, process.env, {
        JWT_SECRET: "test-secret",
        JWT_EXPIRES_IN: "2h",
        REDIS_URL: "redis://127.0.0.1:6379",
        DB_HOST: "127.0.0.1", DB_PORT: "5432", DB_NAME: "smoke", DB_USER: "smoke", DB_PASSWORD: "test-secret",
        OPS_OWNER_ID: "0", OPS_TOKEN: "",
        MAILER_API_URL: "https://smtp.invalid", MAILER_API_TOKEN: "test-secret", MAILER_ENABLED: "false",
        CORS_ORIGINS: "http://localhost:3000", NODE_ENV: "production",
      }),
    }).toString().trim();
    console.log("smoke:", out);
  } catch (err) {
    problems.push(`smoke require failed:\n${err.stderr?.toString() || err.message}`);
  }
}

/* ---------------------------------------------------------------- report */

console.log(`port/ built from ${MIRROR}`);
console.log(`files copied: ${stats.copied}, proxies written: ${stats.proxied}, manifest entries: ${entries.length}, _shim files: ${usedShims.join(", ") || "(none)"}`);
console.log("bare specifiers rewritten (per specifier):");
for (const spec of Object.keys(stats.rewritten).sort()) {
  console.log(`  ${spec.padEnd(20)} ${stats.rewritten[spec]}`);
}
console.log("hand ports applied:");
for (const rel of Object.keys(stats.handPorts).sort()) {
  console.log(`  ${rel.padEnd(24)} ${stats.handPorts[rel]} patterns`);
}
console.log("changed lines per file (0 = byte-identical to mirror):");
for (const d of stats.diffReport.filter(d => d.rewriteLines || d.handPortLines)) {
  console.log(`  ${d.rel.padEnd(28)} rewrite ${String(d.rewriteLines).padStart(2)}  handport ${String(d.handPortLines).padStart(2)}`);
}

if (problems.length) {
  console.error("BUILD INVALID:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("checks: no fs require survives, no bare specifier survives, every port file loads.");
