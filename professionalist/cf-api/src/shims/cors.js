/* cors 2.8.5's behaviour for the exact options object server.js passes
   ({ origin: <list or false>, credentials: true, methods, allowedHeaders }).
   Verified against the package in /tmp/rl-oracle and against the live API on 2026-10-19:
     - an Origin in the allowlist is echoed back verbatim (never "*" — the site sends credentials)
     - Vary: Origin whenever the list is an array, matched or not, so a shared cache cannot serve
       one site's answer to another
     - Access-Control-Allow-Credentials on every response
     - every OPTIONS ends the chain with 204 and an empty body
     - Access-Control-Allow-Methods / -Headers / -Max-Age on the preflight ONLY.  Measured 2026-10-20
       by running cors@2.8.5 itself against this exact options object: an ordinary GET from an allowed
       origin gets Allow-Origin, Vary and Allow-Credentials and nothing else.  The live API agrees; an
       earlier note here claimed nginx added them to ordinary requests, which it does not.
   server.js reads the list out of CORS_ORIGIN, so the Worker keeps the same variable name and the
   same comma-separated format and its value moves over unchanged. */

function normalize(origin) {
  if (Array.isArray(origin)) return origin.filter(Boolean);
  if (typeof origin === "string") {
    return origin.split(",").map(value => value.trim()).filter(Boolean);
  }
  return origin === true ? true : null;
}

function cors(options = {}) {
  const origins = normalize(options.origin);
  const methods = Array.isArray(options.methods) ? options.methods.join(",") : (options.methods || "");
  const allowedHeaders = Array.isArray(options.allowedHeaders)
    ? options.allowedHeaders.join(",")
    : (options.allowedHeaders || "");
  const exposeHeaders = Array.isArray(options.exposedHeaders)
    ? options.exposedHeaders.join(",")
    : (options.exposedHeaders || "");
  const maxAge = options.maxAge === undefined ? "" : String(options.maxAge);
  const successStatus = options.optionsSuccessStatus || 204;

  const allowed = requestOrigin => {
    if (!requestOrigin) return null;
    if (origins === true) return requestOrigin;
    return Array.isArray(origins) && origins.includes(requestOrigin) ? requestOrigin : null;
  };

  return (req, res, next) => {
    const requestOrigin = req.get("origin");
    const echo = allowed(requestOrigin);
    const preflight = req.method === "OPTIONS";

    if (Array.isArray(origins) || typeof origins === "function") res.setHeader("vary", "Origin");
    if (echo) res.setHeader("access-control-allow-origin", echo);
    if (options.credentials) res.setHeader("access-control-allow-credentials", "true");
    if (exposeHeaders) res.setHeader("access-control-expose-headers", exposeHeaders);

    /* measured against the package: a preflight carries the method and header list whatever the
       origin was — even with no Origin at all — since the browser needs the answer before it learns
       the request was refused; an actual (non-OPTIONS) request never carries them */
    if (preflight) {
      if (methods) res.setHeader("access-control-allow-methods", methods);
      if (allowedHeaders) res.setHeader("access-control-allow-headers", allowedHeaders);
      if (maxAge) res.setHeader("access-control-max-age", maxAge);
    }

    if (!preflight) return next();

    res.statusCode = successStatus;
    res.setHeader("content-length", "0");
    return options.preflightContinue ? next() : res.end();
  };
}

module.exports = cors;
module.exports.cors = cors;
