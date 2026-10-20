/* Shared plumbing for the route-level differential harness (task #20).

   Everything here is deliberately tiny and side-effect-free: cf-api/tools/diff-routes.mjs owns the
   decisions, this file owns the two ways to talk to a stack and the enumeration of the surface from
   the PORTED source (never from guesswork).

   Two hard invariants this module enforces so the harness cannot accidentally violate §2:
     - Production is only ever reached through prodRequest(), which refuses any method other than
       GET/HEAD/OPTIONS and refuses to send Authorization or Cookie. It counts every call against a
       global budget so a run can never storm the live VPS.
     - The Worker is reached through workerRequest(), which has no such restriction (it is our own
       sandbox) but shares the exact same response shape so the two sides are comparable.

   The reason we use raw node:http/node:https and NOT undici fetch for conditional/edge work is the
   documented trap in the handoff: Node's fetch silently drops the forbidden headers
   If-None-Match/If-Modified-Since (and Host, Cookie, Authorization are only forwarded by node:http
   when we pass them explicitly), so a stack would look like it ignored revalidation. raw headers
   come back as a flat array so helmet's intentional duplicate lines (Referrer-Policy, the two
   RateLimit/RateLimit-Policy entries) can be compared as counts, not comma-joined by a Headers
   object. */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hideSecrets, readTrim } from "./paths.mjs";

export { hideSecrets };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PORT_ROOT = path.join(HERE, "..", "port", "routes");

export const PROD = { host: "api.proffessionalist.com", port: 443, secure: true };
export const WORKER = { host: "127.0.0.1", port: 8803, secure: false };

/* ------------------------------------------------------------------ *
 *  HTTP clients
 * ------------------------------------------------------------------ */
function rawRequest(target, method, at, { headers = {}, body, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = target.secure ? https : http;
    const allHeaders = Object.assign({ "user-agent": "professionalist-diff-harness/1.0", host: target.host }, headers);
    if (body != null && !("content-length" in lowerKeys(allHeaders))) {
      allHeaders["Content-Length"] = Buffer.byteLength(body);
    }
    const req = mod.request(
      { host: target.host, port: target.port, method, path: at, headers: allHeaders, timeout: timeoutMs },
      res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode,
          rawHeaders: res.rawHeaders || [],
          bodyText: Buffer.concat(chunks).toString("utf8"),
          bodyBytes: Buffer.concat(chunks).length,
        }));
      }
    );
    req.on("timeout", () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    req.on("error", err => reject(new Error(hideSecrets(String(err.message || err)))));
    if (body != null) req.write(body);
    req.end();
  });
}

function lowerKeys(h) {
  const out = {};
  for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
  return out;
}

/* Production budget: a single mutable counter shared by the whole run. */
export const budget = { prod: 0, max: 250 };

/** The ONLY way to reach the live VPS. Enforces §rule-1 (read-only, no credentials). */
export async function prodRequest(method, at, opts = {}) {
  const M = String(method).toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(M)) {
    throw new Error(`prod request refused: method ${M} is not GET/HEAD/OPTIONS (production is read-only)`);
  }
  const hdrs = lowerKeys(opts.headers || {});
  if (hdrs.authorization || hdrs.cookie) {
    throw new Error("prod request refused: no credentials may be sent to production");
  }
  if (budget.prod >= budget.max) throw new Error(`prod request budget (${budget.max}) exhausted`);
  budget.prod++;
  return rawRequest(PROD, M, at, { headers: opts.headers, body: opts.body, timeoutMs: opts.timeoutMs });
}

export async function workerRequest(method, at, opts = {}) {
  return rawRequest(WORKER, String(method).toUpperCase(), at, {
    headers: opts.headers, body: opts.body, timeoutMs: opts.timeoutMs || 60000,
  });
}

/* ------------------------------------------------------------------ *
 *  header comparison
 * ------------------------------------------------------------------ */
/* Names the Cloudflare edge / node transport injects that the Worker (wrangler dev) does not.
   Documented as accepted ENVIRONMENTAL differences; a header in this set on production but absent
   on the Worker is NOT a defect. Anything else missing on the Worker is a defect. */
export const ENV_PROD_ONLY = new Set([
  "date", "connection", "server", "keep-alive", "transfer-encoding",
  "age", "cf-cache-status", "cf-ray", "via", "alt-svc", "server-timing",
  "nel", "report-to", "set-cookie",
]);

/** name(lower) -> occurrence count, straight from rawHeaders so duplicates survive. */
export function headerCounts(rawHeaders) {
  const m = new Map();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const n = String(rawHeaders[i]).toLowerCase();
    m.set(n, (m.get(n) || 0) + 1);
  }
  return m;
}
export function headerNames(rawHeaders) {
  return headerCounts(rawHeaders).keys ? [...headerCounts(rawHeaders).keys()].sort() : [];
}

/** Compare two responses' header name-sets (with duplicate counts). Returns {match, notes}.
   status lets Cloudflare's edge-injected 404 error-page `cache-control: max-age=14400` count as
   ENVIRONMENTAL (measured live: production 404 has it, the Worker's app-level 404 does not; on real
   /uploads 200 responses BOTH set the app's own `public, max-age=604800, immutable`, so that
   difference is not masked). */
export function compareHeaders(prodRaw, workerRaw, prodStatus) {
  const p = headerCounts(prodRaw), w = headerCounts(workerRaw);
  const issues = [];
  const envOk = n => ENV_PROD_ONLY.has(n) || (prodStatus === 404 && n === "cache-control");
  for (const [name, pc] of p) {
    const wc = w.get(name) || 0;
    if (wc === 0) {
      if (!envOk(name)) issues.push(`prod-only header not env-allowed: ${name} (x${pc})`);
    } else if (wc !== pc) {
      issues.push(`count differs: ${name} prod=${pc} worker=${wc}`);
    }
  }
  for (const name of w.keys()) {
    if (!p.has(name)) issues.push(`worker-only header absent on prod: ${name}`);
  }
  return { match: issues.length === 0, issues };
}

/** the first value for a header name, straight from the rawHeaders flat array (keeps duplicates). */
export function headerValue(rawHeaders, name) {
  const want = String(name).toLowerCase();
  let out = "";
  for (let i = 0; i < rawHeaders.length; i += 2) if (String(rawHeaders[i]).toLowerCase() === want) out = rawHeaders[i + 1];
  return out;
}

/* ------------------------------------------------------------------ *
 *  endpoint enumeration, from the ported source
 * ------------------------------------------------------------------ */
/* The mount table is the one hand-transcribed in cf-api/src/api.js (assemble()): /api/auth twice
   (auth.js + auth-mail.js, both authLimiter), /api/admin (admin.js guards itself with
   authenticate+requireStaff), /api/meta (public), /api/onboarding (authenticate+userLimiter),
   then /api (authenticate+userLimiter, spa then platform). routes/spa/index.js mounts network.js at
   /network and ops.js at /admin/ops, so their real bases are /api/network and /api/admin/ops. */
const FILE_PREFIX = {
  "auth.js": "/api/auth",
  "auth-mail.js": "/api/auth",
  "admin.js": "/api/admin",
  "meta.js": "/api/meta",
  "onboarding.js": "/api/onboarding",
  "network.js": "/api/network",
  "platform.js": "/api",
  "spa/feed.js": "/api",
  "spa/social.js": "/api",
  "spa/market.js": "/api",
  "spa/chat.js": "/api",
  "spa/ops.js": "/api/admin/ops",
};
const ROUTE_FILES = Object.keys(FILE_PREFIX);

function joinPath(prefix, sub) {
  if (sub === "/" || sub === "") return prefix;
  return (prefix + sub).replace(/\/{2,}/g, "/").replace(/\/+$/, "") || prefix;
}

export function classifyGroup(endpoint) {
  const { file, full } = endpoint;
  if (full === "/" || full === "/health" || full === "/health/full") return "public";
  if (full.startsWith("/uploads") || full.startsWith("/api/meta")) return "public";
  if (file === "auth-mail.js") return "anonymous-guarded";
  if (file === "auth.js") {
    return ["/api/auth/register", "/api/auth/login", "/api/auth/refresh"].includes(full)
      ? "anonymous-guarded" : "authenticated";
  }
  if (full.startsWith("/api/admin")) return "admin-ops";
  return "authenticated";
}

/** Parse every router.<method>('<path>') out of the ported route files and prefix it by the mount. */
export function enumerateEndpoints() {
  const endpoints = [];
  for (const file of ROUTE_FILES) {
    const src = fs.readFileSync(path.join(PORT_ROOT, file), "utf8");
    const re = /router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
    for (const m of src.matchAll(re)) {
      const full = joinPath(FILE_PREFIX[file], m[2]);
      const e = { method: m[1].toUpperCase(), full, file, guard: guessGuard(file, full, m[1]) };
      e.group = classifyGroup(e);
      endpoints.push(e);
    }
  }
  /* the three app-level public GETs + the /uploads static handler (GET/HEAD), straight from api.js */
  const appLevel = [
    { method: "GET", full: "/", file: "api.js", group: "public", guard: "public" },
    { method: "GET", full: "/health", file: "api.js", group: "public", guard: "public" },
    { method: "GET", full: "/health/full", file: "api.js", group: "public", guard: "public" },
    { method: "GET", full: "/uploads/*", file: "api.js", group: "public", guard: "public" },
  ];
  return { routerEndpoints: endpoints, appLevel };
}

function guessGuard(file, full, method) {
  if (file === "meta.js") return "public";
  if (file === "admin.js") return "staff";
  if (file === "spa/ops.js") return "admin-ops";
  if (file === "auth.js") return (["/api/auth/register", "/api/auth/login", "/api/auth/refresh"].includes(full)) ? "anon" : "bearer";
  if (file === "auth-mail.js") return "anon";
  if (full.startsWith("/api")) return "bearer";
  return "public";
}

/* substitute a probe-able concrete path for a template that contains :params, so we can GET it.
   The value is irrelevant to the outcome: every bearer-guarded /api path answers 401 before routing,
   and the two stack guards are what we are comparing. */
export function probePath(full) {
  return full.replace(/:([A-Za-z_]+)/g, seg => {
    if (/username|slug/i.test(seg)) return "Sam";
    return "1";
  });
}

/* ------------------------------------------------------------------ *
 *  D1 access (read + small controlled writes for the Worker-only phase)
 * ------------------------------------------------------------------ */
/* Same HTTP-query pattern as tools/count-rows.mjs. Never prints a token, hash, the D1 uuid or the
   account id: readTrim() pulls them from disk and hideSecrets() scrubs every error body. */
let D1IDS = null;
function d1ids() {
  if (!D1IDS) D1IDS = { token: readTrim("token"), acct: readTrim("tmp", "acct.txt"), db: readTrim("tmp", "d1-id.txt") };
  return D1IDS;
}
async function d1Call(bodyObj, attempt = 1) {
  const { token, acct, db } = d1ids();
  let j;
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/d1/database/${db}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj),
    });
    j = await r.json();
    if (!j.success) throw new Error(`${r.status} ${hideSecrets(JSON.stringify(j.errors || j)).slice(0, 300)}`);
  } catch (err) {
    if (attempt < 4 && /timeout|network|fetch failed|5[0-9][0-9]/i.test(String(err.message))) {
      await new Promise(s => setTimeout(s, attempt * 700));
      return d1Call(bodyObj, attempt + 1);
    }
    throw err;
  }
  return j.result[0];
}
export async function d1Read(sql) {
  const r = await d1Call({ sql });
  return r.results || [];
}
/** params must already be encoded the way the harness chooses (JSON.stringify for arrays/objects). */
export async function d1WriteBatch(statements) {
  return d1Call({ batch: statements.map(s => ({ sql: s.sql, params: s.params || [] })) });
}
