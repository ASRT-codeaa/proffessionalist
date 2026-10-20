/* jsonwebtoken's HS256 subset, on node:crypto instead of npm.
   It has to stay SYNCHRONOUS: routes/auth.js's issueToken() returns jwt.sign(...) without await,
   so a WebCrypto-based port would hand back a Promise and every token would become
   "[object Promise]".  node:crypto's createHmac is sync and available in a Worker under
   nodejs_compat, which keeps the calling convention identical to the package being replaced.
   Verifying with the SAME secret is what lets tokens issued by the VPS keep working after the
   hostname flips, so a mismatch here logs every signed-in user out mid-migration.
   Claim order, error messages and error classes mirror jsonwebtoken 9.0.3 so the differential
   harness comparing VPS and Worker responses sees no difference. */
const { createHmac, timingSafeEqual, randomUUID } = require("crypto");

class JsonWebTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "JsonWebTokenError";
  }
}
class TokenExpiredError extends Error {
  constructor(message = "jwt expired", expiredAt) {
    super(message);
    this.name = "TokenExpiredError";
    this.expiredAt = expiredAt;
  }
}

const b64url = buf => Buffer.from(buf).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = str => {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
};

/* jsonwebtoken takes expiresIn as seconds or an ms-format string; the app's only value is
   "2h" (or $JWT_EXPIRES_IN), so support the units that can actually appear and refuse the rest
   rather than silently defaulting an expiry to something else */
const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR, WEEK = 7 * DAY;
function durationOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value * SECOND;
  const m = /^(-?(?:\d+)?\.?\d+)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)$/i.exec(String(value || "").trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (/^(years?|yrs?|y)$/.test(unit)) return n * 365 * DAY;
  if (/^(weeks?|w)$/.test(unit)) return n * WEEK;
  if (/^(days?|d)$/.test(unit)) return n * DAY;
  if (/^(hours?|hrs?|h)$/.test(unit)) return n * HOUR;
  if (/^(minutes?|mins?|m)$/.test(unit)) return n * MINUTE;
  if (/^(seconds?|secs?|s)$/.test(unit)) return n * SECOND;
  return n;
}

/* lib/timespan.js: a number is already seconds from the base, a string is ms-format.
   An unparseable value yields undefined upstream, which sign() turns into this message. */
function offsetOf(time, timestamp, option) {
  let seconds;
  if (typeof time === "number" && Number.isFinite(time)) seconds = time;
  else if (typeof time === "string") seconds = durationOf(time) / 1000;
  else seconds = undefined;
  if (seconds === undefined || !Number.isFinite(seconds)) {
    throw new JsonWebTokenError(`"${option}" should be a number of seconds or string representing a timespan eg: "1d", "20h", 60`);
  }
  return Math.floor(timestamp + seconds);
}

function sign(payload, secret, options = {}) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new JsonWebTokenError("payload must be an object");
  }
  /* jsonwebtoken refuses an option that would overwrite a claim already present in the payload,
     rather than silently preferring one of the two, so a caller mistake surfaces here instead of
     shipping a token whose exp is not the one the caller asked for. Its two wordings differ by a
     full stop; both are mirrored so the port never shows an error-message drift. */
  const collide = (claim, option, capital) => {
    if (payload[claim] === undefined || options[option] === undefined) return;
    throw new JsonWebTokenError(
      `Bad "options.${option}" option${capital ? ". The" : " the"} payload already has an "${claim}" property.`);
  };
  collide("exp", "expiresIn", false);
  collide("nbf", "notBefore", false);
  collide("aud", "audience", true);
  collide("iss", "issuer", true);
  collide("sub", "subject", true);
  collide("jti", "jwtid", true);

  const body = Object.assign({}, payload);
  /* exp counts from payload.iat when the caller supplied one, not from the wall clock — that is
     what makes signing the same claims twice produce the same string, in both implementations. */
  const timestamp = body.iat || Math.floor(Date.now() / 1000);
  if (options.noTimestamp) delete body.iat;
  else body.iat = timestamp;
  if (options.notBefore !== undefined) body.nbf = offsetOf(options.notBefore, timestamp, "notBefore");
  if (options.expiresIn !== undefined) body.exp = offsetOf(options.expiresIn, timestamp, "expiresIn");
  /* in jsonwebtoken's own key order, so a byte-for-byte comparison with the package is meaningful */
  if (options.audience !== undefined) body.aud = options.audience;
  if (options.issuer !== undefined) body.iss = options.issuer;
  if (options.subject !== undefined) body.sub = options.subject;
  if (options.jwtid !== undefined) body.jti = options.jwtid;

  const signingInput = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(body))}`;
  const signature = b64url(createHmac("sha256", secret).update(signingInput, "utf8").digest());
  return `${signingInput}.${signature}`;
}

function verify(token, secret, options = {}) {
  if (token === undefined || token === null || token === "") throw new JsonWebTokenError("jwt must be provided");
  if (typeof token !== "string") throw new JsonWebTokenError("jwt must be a string");

  const parts = token.split(".");
  if (parts.length !== 3) throw new JsonWebTokenError("jwt malformed");

  const header = jsonOf(parts[0], "invalid token");
  if (header.alg !== "HS256") {
    /* alg=none reaches here as an unsigned token; jsonwebtoken reports it as a missing signature */
    if (String(header.alg).toLowerCase() === "none") throw new JsonWebTokenError("jwt signature is required");
    throw new JsonWebTokenError("invalid algorithm");
  }

  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`, "utf8").digest();
  const given = fromB64url(parts[2]);
  /* constant-time compare, and never compare two buffers of different length with timingSafeEqual
     (node throws, which would surface as a 500 rather than a 401 for a truncated token) */
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new JsonWebTokenError("invalid signature");
  }

  const payload = jsonOf(parts[1], "invalid token");
  const now = Math.floor(Date.now() / 1000);
  const clock = options.clockTimestamp ? Math.floor(options.clockTimestamp / 1000) : now;
  const skew = options.clockTolerance || 0;

  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== "number") throw new JsonWebTokenError("invalid nbf value");
    if (clock + skew < payload.nbf) throw new JsonWebTokenError("jwt not active: " + new Date(payload.nbf * 1000).toISOString());
  }
  if (payload.exp !== undefined) {
    if (typeof payload.exp !== "number") throw new JsonWebTokenError("invalid exp value");
    if (clock >= payload.exp + skew) throw new TokenExpiredError("jwt expired", new Date(payload.exp * 1000));
  }
  if (options.audience !== undefined && !oneOf(payload.aud, options.audience)) {
    const wanted = Array.isArray(options.audience) ? options.audience : [options.audience];
    throw new JsonWebTokenError(`jwt audience invalid. expected: ${wanted.join(" or ")}`);
  }
  if (options.issuer !== undefined && payload.iss !== options.issuer) {
    throw new JsonWebTokenError(`jwt issuer invalid. expected: ${options.issuer}`);
  }
  if (options.subject !== undefined && payload.sub !== options.subject) {
    throw new JsonWebTokenError(`jwt subject invalid. expected: ${options.subject}`);
  }
  if (options.jwtid !== undefined && payload.jti !== options.jwtid) {
    throw new JsonWebTokenError(`jwt jwtid invalid. expected: ${options.jwtid}`);
  }
  return payload;
}

function decode(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try { return jsonOf(parts[1], ""); } catch { return null; }
}

function jsonOf(segment, failure) {
  let text;
  try { text = fromB64url(segment).toString("utf8"); } catch { throw new JsonWebTokenError(failure || "invalid json"); }
  try { return JSON.parse(text); } catch { throw new JsonWebTokenError(failure || "invalid json"); }
}
function oneOf(value, wanted) {
  const list = Array.isArray(wanted) ? wanted : [wanted];
  const have = Array.isArray(value) ? value : [value];
  return have.some(v => list.includes(v));
}

module.exports = { sign, verify, decode, TokenExpiredError, JsonWebTokenError,
  uuid: () => randomUUID(), durationOf };
