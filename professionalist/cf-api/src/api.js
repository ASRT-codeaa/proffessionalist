/* server.js transcribed by hand.  Line references are to /workspaces/app-mirror/app/server.js, the
   mirror that is byte-identical to the live VPS file (§3 of CLOUDFLARE-MIGRATION-HANDOFF.md), and
   the order of the mounts below IS that file's order: helmet, cors, body parsers, the envelope
   helper, the three limiters, the public routes, /uploads, then auth → admin → meta → onboarding →
   /api, then the 404 fallthrough and the error middleware.  Nothing is reordered, renamed or
   "improved", because the acceptance criterion is that a header-and-body comparison of the two
   stacks comes back clean (the live 404 text, 429 envelope and RateLimit header names were
   re-measured against https://api.proffessionalist.com while this file was written).

   The four things a transcription onto a Worker cannot keep literally are handled here:
     - `require("express")` becomes the frozen Fetch-API subset (src/shims/express.js), whose
       app.handle(request, env, ctx) replaces the request/response pair express gave the stack.
     - `require("./db")` and `require("./middleware/upload")` are taken from src/db.js and
       src/shims/upload.js rather than through port/'s proxies, because port/db.js and
       port/middleware/upload.js are contractually re-exports of those exact objects; reading them
       at the source skips a layer without changing a value, and keeps /health and /uploads working
       while the port tree is still being generated.
     - `express.static(UPLOAD_ROOT, …)` (server.js:132-143) throws in the shim on purpose: the
       bytes are in R2 now, so src/shims/upload.js's serveUpload() answers and the Response it built
       becomes the app's answer.
     - `start()` (server.js:176-186) has no listener to open: connectRedis() is dropped (mirror
       redis.js has no caller — §3, "Redis client exists but is unused by the routes") and the two
       remaining statements, the session revocation and nothing else, run once per isolate from
       handle()'s boot step. */

const express = require("./shims/express");
const cors = require("./shims/cors");
const helmet = require("./shims/helmet");
const limit = require("./shims/limit.js");
const upload = require("./shims/upload.js");
const db = require("./db.js");
const background = require("./background.js");

/* server.js:8's `const { health, query } = require("./db")`.  db.js's exports are stable references
   whose binding to D1 is set by init(), so destructuring at module scope is safe here and keeps the
   two /health handlers character-identical to the mirror. */
const { health, query } = db;

const rateLimit = limit.rateLimit;

/* -------------------------------------------------------------------------- *
 *  boot: bindings, then the environment handoff, then the lazy require
 * -------------------------------------------------------------------------- */

/* Every name below is a process.env read somewhere in the mirror, and this is the whole list —
   built by grepping every .js in /workspaces/app-mirror/app for `process.env.`:
     server.js:29-30,37-38,69,78,94        CORS_ORIGIN BODY_LIMIT IP_RATE_LIMIT USER_RATE_LIMIT
                                           AUTH_RATE_LIMIT
     routes/auth.js:15-17,27-28,220        MAX_LOGIN_FAILURES LOCKOUT_MINUTES SESSION_TTL_SECONDS
                                           JWT_SECRET JWT_EXPIRES_IN
     middleware/authenticate.js:35         JWT_SECRET
     services/emailTokens.js:15-16         EMAIL_VERIFY_TTL_HOURS PASSWORD_RESET_TTL_MINUTES
     services/mailer.js:15-18              MAILER_API_URL MAILER_API_TOKEN MAILER_TIMEOUT_MS
                                           MAILER_ENABLED
     routes/spa/ops.js:72,77,149,150,197   OPS_OWNER_ID OPS_TOKEN
   Deliberately absent: DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD (mirror db.js:4-8) and
   REDIS_URL (mirror redis.js:4).  mirror db.js is replaced by src/db.js, which reads D1 off `env`,
   and redis.js is never called by a route — copying them would put a database password into
   process.env for no reader.  PORT (server.js:181) is the listener's, which a Worker has not got.
   Consequence worth knowing: routes/spa/ops.js:147 reports Object.keys(process.env) filtered by
   /^(DB|REDIS|CORS|JWT|OPS|NODE|PORT)/, so the ops console's `envKeys` list shows fewer names here
   than on the VPS.  It prints key names only, never values.  No value in this list is ever logged. */
const ENV_HANDOFF = [
  "CORS_ORIGIN",
  "BODY_LIMIT",
  "IP_RATE_LIMIT",
  "USER_RATE_LIMIT",
  "AUTH_RATE_LIMIT",
  "JWT_SECRET",
  "JWT_EXPIRES_IN",
  "SESSION_TTL_SECONDS",
  "MAX_LOGIN_FAILURES",
  "LOCKOUT_MINUTES",
  "EMAIL_VERIFY_TTL_HOURS",
  "PASSWORD_RESET_TTL_MINUTES",
  "MAILER_API_URL",
  "MAILER_API_TOKEN",
  "MAILER_TIMEOUT_MS",
  "MAILER_ENABLED",
  "OPS_OWNER_ID",
  "OPS_TOKEN",
];

/* workerd exposes [vars] on process.env and the binding object is writable, so a secret set with
   `wrangler secret put` (which arrives on `env` but not in the file) has to be copied over for the
   ported files' module-scope reads to see it.  Only strings move; a binding object must not become
   the string "[object Object]" under a name a route later Number()s. */
function exportVars(env) {
  for (const name of ENV_HANDOFF) {
    const value = env && env[name];
    if (typeof value === "string") process.env[name] = value;
  }
}

let BOOTED = null;
function boot(env) {
  /* the three inits are idempotent assignments to a module-level binding and they throw when a
     binding is missing, so a mis-edited wrangler.toml fails loudly on the first request instead of
     turning /uploads into a 500 three hours later */
  if (BOOTED !== env) {
    db.init(env);
    limit.init(env);
    upload.init(env);
    exportVars(env);
    BOOTED = env;
  }
  return BOOTED;
}

/* server.js:179 — expired sessions are revoked once at process start; the closest thing a Worker
   has to a process start is the first request an isolate sees.  It is a write, so it runs outside
   the response via ctx.waitUntil and a failure logs the same line the VPS logged (server.js:189)
   without ever reaching the visitor. */
let REVOKED = false;
function revokeExpiredSessions(env, ctx) {
  if (REVOKED) return;
  REVOKED = true;
  const pending = query(`UPDATE auth_sessions SET revoked_at = NOW() WHERE expires_at < NOW() AND revoked_at IS NULL`)
    .catch(err => console.error("API startup failed:", err));
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(pending);
}

/* -------------------------------------------------------------------------- *
 *  the app
 * -------------------------------------------------------------------------- */

/* express.static's own answer wins over anything earlier middleware staged for the same name:
   these are the headers that describe the bytes in the bucket. */
const FILE_OWNED = [
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "cache-control",
  "accept-ranges",
  "content-range",
  "cross-origin-resource-policy",
];

let APP = null;

function assemble() {
  if (APP) return APP;

  /* server.js:8-17.  These requires are literals inside a function on purpose: esbuild bundles the
     port tree into the Worker but only evaluates a module the first time it is required, so the
     route files' module-scope `process.env.JWT_SECRET` reads (routes/auth.js:27) happen AFTER
     exportVars() has filled process.env.  Requiring them at the top of this file would capture the
     secret while it is still undefined and every token issued by the Worker would fail to verify
     against the VPS's — the one failure mode §1's "users stay logged in through the flip" forbids. */
  const { authenticate } = require("../port/middleware/authenticate.js");
  const authRoutes = require("../port/routes/auth.js");
  const authMailRoutes = require("../port/routes/auth-mail.js");
  const adminRoutes = require("../port/routes/admin.js");
  const platformRoutes = require("../port/routes/platform.js");
  /* server.js:17's `require("./routes/spa")`, a directory: port/routes/spa/index.js.  Keeping the
     extensionless form is what lets esbuild and Node both resolve it the way the VPS did. */
  const spaRoutes = require("../port/routes/spa");

  const app = express();

  // Cloudflare terminates TLS and forwards the visitor in X-Forwarded-For, so
  // req.ip is the client, not the proxy. Exactly one hop is trusted.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet());

  /* shims/cors.js is an arity-3 middleware that calls next() on a non-preflight, which is what
     express's own cors does: the header work happens first and the route below answers the request.
     OPTIONS finishes inside cors with a 204 and never reaches the chain. */
  app.use(cors({
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(",").map(x => x.trim())
      : false,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  }));

  app.use(express.json({ limit: process.env.BODY_LIMIT || "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: process.env.BODY_LIMIT || "1mb" }));

  /* ------------------------------------------------------------------------ */
  /*                              error envelope                                */
  /* ------------------------------------------------------------------------ */

  /**
   * The SPA's parseError() reads error.code / error.message / error.fields.
   * A bare string here is what turns every real failure into
   * "Request failed (500)" in the UI, so all responses leave in that shape.
   */
  function envelope(res, status, code, message, fields) {
    if (res.headersSent) return;
    res.status(status).json({ error: { code, message, fields: fields || {} } });
  }

  /* ------------------------------------------------------------------------ */
  /*                              rate limiting                                 */
  /* ------------------------------------------------------------------------ */

  /**
   * Keying is left to express-rate-limit's own generator wherever the request is
   * anonymous: it is IPv6-aware, and a hand-rolled req.ip key trips its
   * ERR_ERL_KEY_GEN_IPV6 validation.
   *
   * Behind Cloudflare many visitors share one egress address, so the IP buckets
   * stay generous and the limit that actually shapes behaviour is the per-user
   * one, applied after authentication.
   */
  const ipLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.IP_RATE_LIMIT || 3000),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) =>
      envelope(res, 429, "rate_limited", "You have sent too many requests. Please wait a moment."),
  });

  const userLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.USER_RATE_LIMIT || 400),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    // Mounted after authenticate, so req.user is always present here.
    keyGenerator: req => "u:" + String((req.user && req.user.sub) || "anonymous"),
    handler: (req, res) =>
      envelope(res, 429, "rate_limited", "You have sent too many requests. Please wait a moment."),
  });

  /**
   * Only failures count towards this bucket, and the account-level lockout in
   * routes/auth (failed_login_attempts / locked_until) stays the real
   * brute-force protection, so a shared proxy address cannot lock out a crowd.
   */
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.AUTH_RATE_LIMIT || 100),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (req, res) =>
      envelope(res, 429, "rate_limited", "Too many attempts. Please try again in a few minutes."),
  });

  app.use(ipLimiter);

  /* ------------------------------------------------------------------------ */
  /*                                  routes                                    */
  /* ------------------------------------------------------------------------ */

  app.get("/", (req, res) => {
    res.json({ name: "Professionalist API", status: "online", version: "1.0.0" });
  });

  app.get("/health", async (req, res) => {
    try {
      await health();
      res.json({ status: "healthy", api: "online", database: "connected" });
    } catch {
      envelope(res, 503, "unavailable", "Database is not reachable");
    }
  });

  app.get("/health/full", async (req, res) => {
    try {
      await health();
      res.json({ status: "healthy", database: "connected", redis: "connected" });
    } catch {
      envelope(res, 503, "unavailable", "Dependencies are not reachable");
    }
  });

  /* User images live on this origin but are embedded by the SPA on another one,
     so helmet's default same-origin resource policy has to be relaxed here.
     server.js:132-143 mounted express.static(UPLOAD_ROOT, {index:false, redirect:false,
     maxAge:"7d", immutable:true, setHeaders: CORP cross-origin}); serveUpload() reproduces that
     header set and send()'s range/304/HEAD/416 answers from R2 (52/52 differential tests in
     tools/test-upload.mjs), so the only thing left to do is hand its Response over. */
  app.use("/uploads", async (req, res, next) => {
    const answered = await upload.serveUpload(req.__raw, req.env);
    /* a missing object is not a 404 of its own: express.static called next() and the fallthrough
       below answered it, measured live on 2026-10-19 as
       {"error":{"code":"not_found","message":"No endpoint for GET /uploads/avatars/does-not-exist.png","fields":{}}} */
    if (!answered) return next();
    /* serveUpload built the answer the way express.static would have; __adopt moves only the
       headers that describe the bytes (FILE_OWNED) onto the response the stack already staged, so
       helmet's eleven, cors's Vary and the limiter's two RateLimit entries survive unchanged —
       including helmet's deliberate duplicate Referrer-Policy/X-Frame-Options lines, which a
       round-trip through a Headers object would have comma-joined into one */
    return res.__adopt(answered, FILE_OWNED);
  });

  app.use("/api/auth", authLimiter, authRoutes);
  // Unmatched /api/auth paths fall through to the authenticated /api catch-all, so
  // the mail routes have to be mounted here while the visitor is still signed out.
  app.use("/api/auth", authLimiter, authMailRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/meta", require("../port/routes/meta.js"));
  app.use("/api/onboarding", authenticate, userLimiter, require("../port/routes/onboarding.js"));

  /**
   * routes/spa answers the paths the client actually calls. It has to come first:
   * platform.js matches /posts/:id and /marketplace/:id, which would otherwise
   * swallow /posts/feed and /marketplace/home before the real handler is reached.
   */
  app.use("/api", authenticate, userLimiter, spaRoutes, platformRoutes);

  app.use((req, res) => {
    envelope(res, 404, "not_found", `No endpoint for ${req.method} ${req.originalUrl}`);
  });

  app.use((err, req, res, next) => {
    console.error("API error:", err);
    if (res.headersSent) return next(err);

    const status = Number(err && err.status) || 500;
    if (status === 404) return envelope(res, 404, "not_found", "Endpoint not found");
    if (status >= 400 && status < 500) {
      return envelope(res, status, "validation_error", String(err.message || "Invalid request"), err.fields);
    }
    envelope(res, 500, "api_error", "Something went wrong on our side. Please try again.");
  });

  APP = app;
  return APP;
}

/* -------------------------------------------------------------------------- *
 *  the entry point
 * -------------------------------------------------------------------------- */

async function handle(request, env, ctx) {
  boot(env);
  revokeExpiredSessions(env, ctx);
  const app = assemble();
  const response = await app.handle(request, env, ctx);
  /* mail retries (services/mailer.js via src/background.js) and the rate limiter's decrement for a
     successful request (shims/limit.js:233) are still in flight when the Response leaves; without
     this the isolate is frozen and a password-reset email is simply never sent */
  background.waitUntilWork(ctx);
  return response;
}

module.exports = { handle, boot, assemble, exportVars, revokeExpiredSessions, ENV_HANDOFF };
