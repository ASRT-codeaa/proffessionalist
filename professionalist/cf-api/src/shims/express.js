/* The Express subset the app actually uses, running on the Fetch API.
   Written against a census of the mirror rather than against Express's documentation:
   196 route definitions whose paths are only literals and :params (no regex, no wildcards, no
   optional markers), res.json x188, res.status x175, req.body/params/query/user/file(s)/ip/get,
   router.use x9, app.use x14, one res.setHeader, and express.static used solely for /uploads
   (served from R2 by worker.js instead).  Route files keep importing "express"; build.mjs
   repoints that import here, so what is under test is their behaviour, not their source. */

const { createHash } = require("crypto");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
const PARAM = /^:([A-Za-z_]\w*)$/;

function compile(pattern) {
  if (!pattern || pattern === "/" || pattern === "*") return { segments: [], keys: [], any: pattern === "*" };
  const parts = String(pattern).split("/").filter(s => s !== "");
  /* keys align with segments (null where the segment is a literal), so /a/:x/b/:y cannot
     hand :y's value to :x -- an earlier version indexed keys separately and did exactly that */
  const keys = parts.map(p => {
    const m = PARAM.exec(p);
    if (m) return m[1];
    if (/[:*()?+{}\\]/.test(p)) {
      throw new Error(`shims/express: unsupported path pattern "${pattern}" — the app has none like it, so add support deliberately rather than matching wrongly`);
    }
    return null;
  });
  return { segments: parts, keys };
}

/* prefix=true for mounts ("/api" must match /api/x but not /apixy) */
function matchPath(compiled, path, prefix) {
  const got = String(path).split("/").filter(s => s !== "");
  const want = compiled.segments;
  if (compiled.any) return { params: {}, rest: "/" + got.join("/") };
  if (want.length > got.length) return null;
  const params = {};
  for (let i = 0; i < want.length; i++) {
    const key = compiled.keys[i];
    if (key) params[key] = decodeSafe(got[i]);
    else if (want[i] !== got[i]) return null;
  }
  if (!prefix && want.length !== got.length) return null;
  return { params, rest: "/" + got.slice(want.length).join("/") };
}

function decodeSafe(v) {
  try { return decodeURIComponent(String(v)); } catch { return String(v); }
}

const handlersOf = list => list.flat(Infinity).filter(fn => typeof fn === "function");

/* One layer per (path, method, handler), the way Express's own stack works: a route with three
   handlers is three layers, and an error bubbles forward through them by arity. */
function makeStack(owner) {
  const stack = [];
  const add = (entry, paths, handlers) => {
    for (const p of paths) {
      const compiled = compile(p);
      for (const handler of handlers) stack.push({ ...entry, path: p, compiled, handler });
    }
    return owner;
  };
  const api = {
    _stack: stack,
    use(...args) {
      const path = typeof args[0] === "string" ? args[0] : "";
      const handlers = handlersOf(typeof args[0] === "string" ? args.slice(1) : args);
      return add({ mount: true }, [path], handlers);
    },
  };
  for (const method of HTTP_METHODS) {
    api[method] = (...args) => {
      const path = typeof args[0] === "string" ? args[0] : "";
      const handlers = handlersOf(typeof args[0] === "string" ? args.slice(1) : args);
      return add({ method: method.toUpperCase() }, [path], handlers);
    };
  }
  api.all = (...args) => {
    const path = typeof args[0] === "string" ? args[0] : "";
    const handlers = handlersOf(typeof args[0] === "string" ? args.slice(1) : args);
    for (const m of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) add({ method: m }, [path], handlers);
    return owner;
  };
  return api;
}

function Router() {
  const api = makeStack({});
  const router = (req, res, next) => runStack(api._stack, req, res, next);
  for (const k of Object.keys(api)) router[k] = api[k];
  router.__router = true;
  return router;
}

/* ------------------------------------------------------------------ *
 * the chain
 * ------------------------------------------------------------------ */

/* Layers are consumed in order.  A layer runs only when the path applies, the method matches (for
   routes), and its arity fits the current state: ordinary handlers while nothing failed, 4-arity
   error handlers once something has.  A handler that neither calls next() nor responds ends the
   chain silently, exactly as Express does.
   path/params are saved and restored on the SAME req object rather than shadowed by a child:
   middleware like authenticate() hangs req.user on the request, and every later layer has to see
   it — which is also how Express behaves, since it mutates one req per connection. */
async function runStack(layers, req, res, done) {
  let err = null;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const isError = layer.handler.length === 4;
    if (err ? !isError : isError) continue;
    if (layer.method && layer.method !== req.method && !(layer.method === "GET" && req.method === "HEAD")) continue;
    const hit = matchPath(layer.compiled, req.path, layer.mount);
    if (!hit) continue;
    const before = { path: req.path, params: req.params, baseUrl: req.baseUrl };
    req.path = hit.rest === "" ? "/" : hit.rest;
    req.params = Object.assign({}, before.params, hit.params);
    if (layer.mount) req.baseUrl = (before.baseUrl || "") + (layer.path === "/" ? "" : layer.path);
    let called = false;
    const next = (arg) => { called = true; if (arg instanceof Error) err = arg; };
    try {
      const out = isError ? layer.handler(err, req, res, next) : layer.handler(req, res, next);
      if (out && typeof out.then === "function") await out;
    } catch (e) {
      err = e;
    }
    req.path = before.path; req.params = before.params; req.baseUrl = before.baseUrl;
    if (res.__sent) return;
    if (err) continue;
    if (called) continue;
    return;
  }
  return done(err);
}

/* ------------------------------------------------------------------ *
 * request and response over Fetch
 * ------------------------------------------------------------------ */
function parseBodySize(limit) {
  if (!limit) return 1024 * 1024;
  const m = /^([\d.]+)\s*(kb|mb|gb|b)?$/i.exec(String(limit));
  if (!m) return 1024 * 1024;
  const mult = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 ** 3 }[(m[2] || "b").toLowerCase()];
  return Number(m[1]) * mult;
}

/* Express 5's 'simple' query parser: repeated keys become arrays, no prototype access, no nesting */
function queryOf(searchParams) {
  const out = {};
  for (const [k, v] of searchParams) {
    if (k in out) out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
    else out[k] = v;
  }
  return out;
}

function makeRequest(request, env, ctx) {
  const url = new URL(request.url);
  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
  let bodyText = null;
  const req = {
    __raw: request,
    method: request.method,
    headers,
    env,
    ctx,
    url: url.pathname + url.search,
    originalUrl: url.pathname + url.search,
    path: url.pathname,
    baseUrl: "",
    hostname: url.hostname,
    protocol: url.protocol.replace(":", ""),
    secure: url.protocol === "https:",
    ip: clientIp(request),
    socket: { remoteAddress: clientIp(request) },
    params: {},
    query: queryOf(url.searchParams),
    body: {},
    get(name) { return headers[String(name).toLowerCase()] || undefined; },
    is(...types) { const type = request.headers.get("content-type") || ""; return types.find(t => type.includes(t)) || false; },
    accepts(...types) {
      const accept = headers.accept || "*/*";
      return types.find(t => accept.includes(t) || accept.includes("*")) || false;
    },
    /* the body parsers fill this once; routes read req.body as if Express had done it */
    async text() {
      if (bodyText === null) bodyText = await request.text();
      return bodyText;
    },
  };
  /* with trust proxy 1 (server.js:23) Express resolves req.ip from the rightmost trusted hop;
     Cloudflare + nginx put the visitor first in X-Forwarded-For, so that is the first entry */
  return req;
}

function clientIp(request) {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) { const first = xff.split(",")[0].trim(); if (first) return first; }
  return request.headers.get("cf-connecting-ip") || "0.0.0.0";
}

function makeResponse(req) {
  /* Express's default etag setting, measured against express 5.3.0 (/tmp etag probe): a weak tag of
     "{byte length in hex}-{base64 sha1 of the body, padding stripped}" — W/"17-C4BnPbms…" — emitted
     for every non-empty string body on 200, 201 and 400 alike, skipped for an empty body, never
     overwriting one a route set itself.  A conditional GET/HEAD whose If-None-Match matches gets a
     bare 304 with the content headers removed; a POST with the same header gets the full body.
     The SPA's image and JSON caching depends on these, and so does any comparison of the two stacks
     made with curl -i. */
  const weakTag = body => `W/"${Buffer.byteLength(body).toString(16)}-${
    createHash("sha1").update(body).digest("base64").replace(/=+$/, "")}"`;

  const res = {
    statusCode: 200,
    __sent: false,
    headersSent: false,
    headers: new Headers({ "content-type": "application/json; charset=utf-8" }),
    status(code) { res.statusCode = code; return res; },
    setHeader(k, v) { res.headers.set(String(k), String(v)); return res; },
    /* express's res.append adds a value to an existing header instead of replacing it, which is how
       two mounted limiters both contribute a RateLimit entry to one response */
    append(k, v) { res.headers.append(String(k), String(v)); return res; },
    get(name) { return res.headers.get(String(name)) || undefined; },
    set(field, value) {
      if (typeof field === "object") { for (const [k, v] of Object.entries(field)) res.headers.set(k, String(v)); return res; }
      res.headers.set(String(field), String(value)); return res;
    },
    type(v) { return res.setHeader("content-type", String(v)); },
    location(v) { return res.setHeader("location", String(v)); },
    json(payload) {
      if (res.__sent) throw new Error("shims/express: res.json after the response was sent");
      res.headers.set("content-type", "application/json; charset=utf-8");
      return res.__entity(payload === undefined ? "" : JSON.stringify(payload));
    },
    send(payload) {
      if (res.__sent) return res;
      if (payload === undefined || payload === null) return res.__entity("");
      if (typeof payload === "object") return res.json(payload);
      res.headers.set("content-type", "text/html; charset=utf-8");
      return res.__entity(String(payload));
    },
    /* the last step of express's res.send(): stamp the entity tag, honour a conditional request,
       then mark the response finished */
    __entity(body) {
      res.body = body;
      if (!body) {
        /* res.send() with nothing to send takes its own content-type back off, and a status that
           forbids a body (204) states no length either — measured against express 5.3.0 */
        res.headers.delete("content-type");
        if (res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304) {
          res.headers.delete("content-length");
        } else {
          res.headers.set("content-length", "0");
        }
      } else {
        if (!res.headers.get("etag")) res.headers.set("etag", weakTag(body));
        if (res.__stale() === false) {
          res.statusCode = 304;
          res.headers.delete("content-type");
          res.headers.delete("content-length");
          res.body = null;
        } else {
          /* express states the length of whatever it sends, including the length of the body a HEAD
             only describes */
          res.headers.set("content-length", String(Buffer.byteLength(body)));
        }
      }
      res.__sent = true; res.headersSent = true;
      return res;
    },
    /* true when the body must be sent, false when the client's copy is still good */
    __stale() {
      if (!req) return true;
      if (req.method !== "GET" && req.method !== "HEAD") return true;
      const given = req.headers["if-none-match"];
      if (!given) return true;
      const ours = res.headers.get("etag");
      if (given.trim() === "*") return false;
      if (!ours) return true;
      const strip = value => String(value).split(",").map(part => part.trim().replace(/^W\//, "")).join(",");
      return strip(given) !== strip(ours);
    },
    sendStatus(code) { return res.status(code).send(String(code)); },
    end(payload) { return payload === undefined ? res.send() : res.send(payload); },
    redirect(...args) {
      const to = typeof args[0] === "number" ? args[1] : args[0];
      res.statusCode = typeof args[0] === "number" ? args[0] : 302;
      res.headers.set("location", String(to));
      res.__sent = true; res.headersSent = true;
      return res;
    },
    /* multer/express-rate-limit hooks the app relies on */
    locals: {},
    /* express-rate-limit decrements a successful request on the response 'finish' event, which in
       a Worker is after the Response object has been returned. The callback is queued here and
       drained by app.handle() under ctx.waitUntil, so the answer is never delayed by it. */
    __finish: [],
    on(name, fn) {
      if (name === "finish" || name === "close") res.__finish.push(fn);
      return res;
    },
    once(name, fn) { return res.on(name, fn); },
    __response() {
      /* a Response with status 204/205/304 must carry a null body or the runtime throws,
         and a HEAD answer never has a body */
      const nullBody = res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304 || res.__head;
      /* Response(body, {headers}) invents `content-type: text/plain;charset=UTF-8` for a string body
         when the headers name no type; express answers an empty body with no type at all, so a zero
         length goes out as a null body, which the runtime describes without inventing anything */
      const raw = res.body === undefined ? "" : res.body;
      const content = nullBody || raw === "" ? null : raw;
      if (res.__adopted) {
        return new Response(nullBody ? null : res.__adopted, {
          status: res.statusCode, statusText: res.statusText || "", headers: res.headers,
        });
      }
      return new Response(content, {
        status: res.statusCode, statusText: res.statusText || "", headers: res.headers,
      });
    },
    /* worker.js serves /uploads straight out of R2: the Response shims/upload.js built becomes the
       app's answer.  `owned` names the headers that answer describes — content-type/-length, etag,
       last-modified, cache-control, accept-ranges, content-range, the CORP express.static's
       setHeaders wrote — and ONLY those are transplanted, each one deleted first so a staged value
       cannot survive as a second value.  Everything else the stack already put on the response
       (helmet's eleven, cors's Vary, the limiter's two RateLimit entries) stays exactly as it was
       staged, which is what express.static did too: setHeader over the same res, never a new one.
       Replacing the whole header set instead — and re-staging what survived by iterating a Headers
       object — silently merged helmet's intentional duplicates into one comma-joined line, because
       a Headers getter combines a name's values by specification. */
    __adopt(response, owned) {
      res.statusCode = response.status;
      for (const name of owned) {
        res.headers.delete(name);
        const value = response.headers.get(name);
        if (value !== null) res.headers.set(name, value);
      }
      res.__adopted = response.body;
      res.__sent = true; res.headersSent = true;
      return res;
    },
  };
  return res;
}

/* ------------------------------------------------------------------ *
 * the app
 * ------------------------------------------------------------------ */
function createApp() {
  const api = makeStack({});
  const settings = { "trust proxy": false, "x-powered-by": false };
  const app = {};
  Object.assign(app, api);
  app.set = (k, v) => { settings[k] = v === undefined ? true : v; return app; };
  app.get = api.get;
  app.disable = k => { settings[k] = false; return app; };
  app.enable = k => { settings[k] = true; return app; };
  app.engine = () => app;
  app.listen = () => { throw new Error("shims/express: a Worker has no listener; export fetch() instead"); };
  app.settings = settings;
  app.handle = async (request, env, ctx) => {
    const req = makeRequest(request, env, ctx);
    const res = makeResponse(req);
    res.__head = request.method === "HEAD";
    const leftover = await runStack(api._stack, req, res, err => err);
    if (leftover instanceof Error) throw leftover;
    if (!res.__sent) {
      const err = new Error(`No handler answered ${request.method} ${req.path}`);
      err.status = 404;
      throw err;
    }
    const response = res.__response();
    /* 'finish' handlers (the rate limiter's decrement for skipSuccessfulRequests) run once the
       answer is on its way out; waitUntil keeps them alive after the Response is returned, so a
       visitor never waits for the bookkeeping */
    if (res.__finish.length) {
      const settle = Promise.resolve().then(async () => {
        const pending = [];
        for (const fn of res.__finish.splice(0)) {
          try { const out = fn(); if (out && typeof out.then === "function") pending.push(out); } catch { /* already answered */ }
        }
        await Promise.allSettled(pending);
      });
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(settle);
    }
    return response;
  };
  return app;
}

function express() { return createApp(); }

express.Router = Router;
express.json = (opts = {}) => async (req, res, next) => {
  const type = req.get("content-type") || "";
  if (!/application\/json/i.test(type) && !/application\/[^+]*\+json/i.test(type)) return next();
  const text = await req.text();
  if (!text) { req.body = {}; return next(); }
  if (text.length > parseBodySize(opts.limit)) {
    const err = new Error("request entity too large"); err.status = 413; err.code = "entity.too.large"; return next(err);
  }
  try { req.body = JSON.parse(text); }
  /* body-parser does not reword a failed JSON.parse: the SyntaxError's own message is what reaches
     the app's error middleware, and server.js's 4xx branch puts it in the envelope the SPA shows.
     Measured live 2026-10-19: "Expected ':' after property name in JSON at position 9".  A generic
     "Invalid JSON body" would be the one visible difference on a malformed request. */
  catch (e) { const err = new Error(String(e.message)); err.status = 400; err.code = "entity.parse.failed"; return next(err); }
  next();
};
express.urlencoded = (opts = {}) => async (req, res, next) => {
  if (!/application\/x-www-form-urlencoded/i.test(req.get("content-type") || "")) return next();
  const text = await req.text();
  if (!text) { req.body = {}; return next(); }
  if (text.length > parseBodySize(opts.limit)) {
    const err = new Error("request entity too large"); err.status = 413; return next(err);
  }
  req.body = queryOf(new URLSearchParams(text));
  next();
};
express.static = () => { throw new Error("shims/express: static files live in R2, worker.js serves /uploads"); };

module.exports = express;
module.exports.Router = Router;
module.exports.createApp = createApp;
module.exports.makeRequest = makeRequest;
module.exports.makeResponse = makeResponse;
module.exports.runStack = runStack;
module.exports.matchPath = matchPath;
module.exports.compile = compile;
module.exports.clientIp = clientIp;
