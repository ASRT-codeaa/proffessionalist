const crypto = require("crypto");

/** Same envelope as middleware/authenticate.js — the SPA parses error.code. */
function deny(res, status, code, message) {
  return res.status(status).json({ error: { code, message, fields: {} } });
}

/**
 * /api/admin used to decode the JWT and take the role from its payload, so a
 * promoted, demoted or suspended account kept whatever rights the token was
 * minted with until it expired. The role therefore comes from the session
 * lookup in middleware/authenticate.js instead.
 *
 * That module pulls hashToken from here, so it is required lazily: requiring it
 * at load time would hand authenticate.js this file's half-initialised exports.
 */
function authenticate(req, res, next) {
  return require("./authenticate").authenticate(req, res, next);
}

function requireStaff(req, res, next) {
  if (!req.user || !["staff", "admin"].includes(req.user.role)) {
    return deny(res, 403, "forbidden", "This area needs staff access");
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return deny(res, 403, "forbidden", "This area needs administrator access");
  }

  next();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = {
  authenticate,
  requireStaff,
  requireAdmin,
  hashToken
};
