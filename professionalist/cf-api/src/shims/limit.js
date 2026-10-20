/* express-rate-limit v8's rateLimit(), counted by a Durable Object instead of process memory.
   server.js declares three buckets and their option objects move to the Worker verbatim, so this
   file reproduces what the package does with them rather than the app's own logic:
     - a fixed window that starts at the client's first hit and lasts windowMs
     - draft-8 RateLimit / RateLimit-Policy headers on every answered request, Retry-After on a 429
     - skipSuccessfulRequests: a request that ends 2xx/3xx is counted and then given back
   Why a Durable Object and not Workers KV: KV allows roughly one write per key per second and is
   eventually consistent, and a page load fires several parallel API calls at the same client IP —
   the writes that get rejected would silently under-count. A singleton DO gives one strongly
   consistent counter per edge, which is the same shape as the VPS's one MemoryStore in one process.
   If the DO call itself fails the request is allowed through: a bookkeeping outage must not turn
   into an error page for every visitor, and the real brute-force defence is the account lockout
   that routes/auth keeps in the database. */
const { createHash } = require("crypto");

let ENV = null;

function init(env) {
  ENV = env;
  if (!env || !env.RATE_COUNTERS) {
    throw new Error("shims/limit: env.RATE_COUNTERS is not bound — declare the Durable Object in wrangler.toml");
  }
}

function resetRequired() {
  if (!ENV) throw new Error("shims/limit: not initialised — call limit.init(env) before mounting the app");
}

/* ------------------------------------------------------------------ *
 * the counter store (runs inside the Durable Object)
 * ------------------------------------------------------------------ */

/**
 * Pure so the same code is testable without a DO: `state` is a Map of key -> {hits, resetTime}.
 * resetTime is milliseconds since the epoch, matching MemoryStore's Date.
 */
function countHit(state, key, windowMs, now = Date.now()) {
  let client = state.get(key);
  if (!client || client.resetTime <= now) {
    client = { hits: 0, resetTime: now + windowMs };
    state.set(key, client);
  }
  client.hits += 1;
  return { totalHits: client.hits, resetTime: client.resetTime };
}

function countDecrement(state, key, windowMs, now = Date.now()) {
  const client = state.get(key);
  if (!client || client.resetTime <= now) return { totalHits: 0, resetTime: now + windowMs };
  if (client.hits > 0) client.hits -= 1;
  return { totalHits: client.hits, resetTime: client.resetTime };
}

/** Handles one DO request: {op, key, windowMs} -> {totalHits, resetTime}. */
function handleCountMessage(state, message) {
  const windowMs = Number(message.windowMs);
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("shims/limit: windowMs must be positive");
  const info = message.op === "decrement"
    ? countDecrement(state, String(message.key), windowMs)
    : countHit(state, String(message.key), windowMs);
  return info;
}

async function callStore(op, key, windowMs) {
  resetRequired();
  const id = ENV.RATE_COUNTERS.idFromName("buckets");
  const stub = ENV.RATE_COUNTERS.get(id);
  const answer = await stub.fetch("https://limit.internal/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, key, windowMs }),
  });
  if (!answer.ok) throw new Error(`shims/limit: counter answered ${answer.status}`);
  return answer.json();
}

/* ------------------------------------------------------------------ *
 * keys (source/ip-key-generator.ts)
 * ------------------------------------------------------------------ */

const HEXTET = /^[0-9a-fA-F]{1,4}$/;
const DOTTED = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Parse a colon-delimited piece into 16-bit groups; a trailing dotted quad counts as two. */
function parseGroups(text) {
  if (text === "") return [];
  const out = [];
  for (const part of text.split(":")) {
    if (HEXTET.test(part)) { out.push(parseInt(part, 16)); continue; }
    const dotted = DOTTED.exec(part);
    if (!dotted) return null;
    const bytes = dotted.slice(1).map(Number);
    if (bytes.some(b => b > 255)) return null;
    out.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
  }
  return out;
}

/** Expand an IPv6 text form to eight 16-bit groups, or null when it is not an IPv6 address. */
function hextetsOf(ip) {
  const full = String(ip || "");
  if (!full.includes(":")) return null;
  let body = full;
  const zone = body.indexOf("%");
  if (zone >= 0) body = body.slice(0, zone);
  const gapAt = body.indexOf("::");
  if (gapAt < 0) {
    const groups = parseGroups(body);
    return groups && groups.length === 8 ? groups : null;
  }
  if (body.indexOf("::", gapAt + 1) >= 0) return null;
  const head = parseGroups(body.slice(0, gapAt));
  const tail = parseGroups(body.slice(gapAt + 2));
  if (!head || !tail || head.length + tail.length > 7) return null;
  return [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
}

/** RFC 5952 compression: the leftmost longest run of at least two zero groups becomes "::". */
function compress(groups) {
  let best = -1, bestLen = 0, i = 0;
  while (i < groups.length) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = list => list.map(g => g.toString(16)).join(":");
  if (bestLen < 2) return hex(groups);
  return `${hex(groups.slice(0, best))}::${hex(groups.slice(best + bestLen))}`;
}

/**
 * express-rate-limit groups IPv6 visitors by /56 so one user with a rotating address cannot
 * multiply their allowance. An embedded IPv4 collapses to its dotted form instead — upstream tells
 * that apart by notation (a trailing dotted quad), which is why ::1 stays ::/56 below.
 */
function ipKeyGenerator(ip, ipv6Subnet = 56) {
  const groups = hextetsOf(ip);
  if (!groups) return String(ip || "");

  const dotted = DOTTED.exec(String(ip).split("%")[0].split(":").pop() || "");
  if (dotted) {
    const bytes = dotted.slice(1).map(Number);
    const mapped = groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff;
    const compatible = groups.slice(0, 6).every(g => g === 0);
    if (mapped || compatible) return bytes.join(".");
  }

  if (!ipv6Subnet) return compress(groups);
  const masked = groups.slice();
  const keep = Math.floor(ipv6Subnet / 16);
  const spare = ipv6Subnet % 16;
  if (spare) masked[keep] &= ~((1 << spare) - 1) & 0xffff;
  for (let i = keep + (spare ? 1 : 0); i < 8; i++) masked[i] = 0;
  return `${compress(masked)}/${ipv6Subnet}`;
}

/* ------------------------------------------------------------------ *
 * headers (source/headers.ts, draft-8)
 * ------------------------------------------------------------------ */

function resetSecondsOf(windowMs, resetTime) {
  if (resetTime) return Math.max(0, Math.ceil((resetTime - Date.now()) / 1000));
  return Math.ceil(windowMs / 1000);
}

const partitionKeyOf = key =>
  Buffer.from(createHash("sha256").update(String(key)).digest("hex").slice(0, 12)).toString("base64");

/* ------------------------------------------------------------------ *
 * the middleware
 * ------------------------------------------------------------------ */

function rateLimit(passed = {}) {
  const config = Object.assign({
    windowMs: 60 * 1000,
    limit: 5,
    message: "Too many requests, please try again later.",
    statusCode: 429,
    legacyHeaders: false,
    standardHeaders: "draft-8",
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
    requestWasSuccessful: (_req, res) => res.statusCode < 400,
    keyGenerator: req => ipKeyGenerator(req.ip, 56),
    handler: (req, res) => res.status(config.statusCode).send(config.message),
  }, passed);

  if (!Number.isFinite(config.windowMs) || config.windowMs <= 0) {
    throw new Error(`shims/limit: windowMs must be a positive number, got ${config.windowMs}`);
  }
  if (!Number.isFinite(config.limit) || config.limit <= 0) {
    throw new Error(`shims/limit: limit must be a positive number, got ${config.limit}`);
  }

  /* MemoryStore is per-instance upstream, so one edge DO is shared by all three buckets and the
     keys have to say which bucket they belong to. The default draft-8 name is exactly that. */
  const seconds = config.windowMs / 1000;
  const minutes = config.windowMs / 60000;
  const hours = config.windowMs / 3600000;
  const days = config.windowMs / 86400000;
  const duration = seconds < 60 ? `${seconds}sec`
    : minutes < 60 ? `${minutes}min`
      : hours < 24 ? `${hours}hr${hours > 1 ? "s" : ""}`
        : `${days}day${days > 1 ? "s" : ""}`;
  const name = config.name || `${config.limit}-in-${duration}`;
  const bucket = `${config.limit}-in-${config.windowMs}`;

  const middleware = async (req, res, next) => {
    let key;
    try { key = String(await config.keyGenerator(req, res)); }
    catch (error) { return next(error); }
    if (!key) return next(new Error("shims/limit: keyGenerator returned an empty key"));

    const storageKey = `${bucket}|${key}`;
    let info;
    try { info = await callStore("hit", storageKey, config.windowMs); }
    catch (error) {
      console.error("shims/limit: counter unavailable, allowing the request through:", error && error.message);
      return next();
    }

    const remaining = Math.max(0, config.limit - info.totalHits);
    const resetTime = new Date(info.resetTime);
    req.rateLimit = { limit: config.limit, current: info.totalHits, remaining, resetTime, key };

    /* setDraft8Headers: both headers are appended, so the other mounted buckets survive */
    res.append("RateLimit", `"${name}"; r=${remaining}; t=${resetSecondsOf(config.windowMs, info.resetTime)}`);
    res.append("RateLimit-Policy", `"${name}"; q=${config.limit}; w=${Math.ceil(config.windowMs / 1000)}; pk=:${partitionKeyOf(key)}:`);

    if (config.skipSuccessfulRequests || config.skipFailedRequests) {
      res.on("finish", async () => {
        const successful = await config.requestWasSuccessful(req, res);
        const shouldUndo = config.skipSuccessfulRequests ? successful : !successful;
        if (!shouldUndo) return;
        try { await callStore("decrement", storageKey, config.windowMs); }
        catch (error) { console.error("shims/limit: could not undo a counted request:", error && error.message); }
      });
    }

    if (info.totalHits > config.limit) {
      res.setHeader("Retry-After", String(resetSecondsOf(config.windowMs, info.resetTime)));
      const deny = Promise.resolve(config.handler(req, res, next, config));
      return deny.catch(error => next(error));
    }
    return next();
  };

  middleware.windowMs = config.windowMs;
  middleware.limit = config.limit;
  /* a function's own `name` is configurable but NOT writable, so `middleware.name = …` is silently
     ignored in the package's CommonJS build and throws TypeError: Cannot assign to read only
     property in a strict one — and esbuild bundles this Worker as strict ESM, which is how the whole
     API started answering 500 on the first request.  defineProperty keeps the intended value. */
  Object.defineProperty(middleware, "name", { value: name, configurable: true });
  return middleware;
}

module.exports = { init, rateLimit, ipKeyGenerator, hextetsOf, compress, handleCountMessage, countHit, countDecrement };
