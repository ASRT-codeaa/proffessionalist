/* helmet 8.3.0's default header set, plus the four headers the origin nginx added on top of it,
   because the Worker answers where nginx used to and those must not silently disappear.
   Measured from https://api.proffessionalist.com/health on 2026-10-19, and cross-checked against
   helmet's own defaults run under express 5.3.0 (/tmp/rl-oracle).
   The duplicates are real: production sends Referrer-Policy and X-Content-Type-Options twice and
   X-Frame-Options as both SAMEORIGIN (helmet) and DENY (nginx), and browsers honour the stricter
   of the two X-Frame-Options values. They are reproduced so a header-level comparison of the two
   stacks comes back clean, and so the clickjacking posture (DENY) survives the move. */

const HELMET_DEFAULTS = [
  ["content-security-policy", "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests"],
  ["cross-origin-opener-policy", "same-origin"],
  ["cross-origin-resource-policy", "same-origin"],
  ["origin-agent-cluster", "?1"],
  ["referrer-policy", "no-referrer"],
  ["strict-transport-security", "max-age=31536000; includeSubDomains"],
  ["x-content-type-options", "nosniff"],
  ["x-dns-prefetch-control", "off"],
  ["x-download-options", "noopen"],
  ["x-frame-options", "SAMEORIGIN"],
  ["x-permitted-cross-domain-policies", "none"],
  ["x-xss-protection", "0"],
];

/* the nginx layer, in the order it appeared on the live response */
const EDGE_ADDITIONS = [
  ["referrer-policy", "no-referrer"],
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
];

const LAST = [["permissions-policy", "camera=(), microphone=(), geolocation=()"]];

function helmet() {
  return (req, res, next) => {
    for (const [name, value] of HELMET_DEFAULTS) res.setHeader(name, value);
    for (const [name, value] of EDGE_ADDITIONS) res.append(name, value);
    for (const [name, value] of LAST) res.setHeader(name, value);
    next();
  };
}

module.exports = helmet;
module.exports.helmet = helmet;
module.exports.HELMET_DEFAULTS = HELMET_DEFAULTS;
