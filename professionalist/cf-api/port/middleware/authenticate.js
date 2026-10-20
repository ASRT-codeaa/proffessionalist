const crypto = require("crypto");
const jwt = require("../_shim/jwt.js");
const { query } = require("../db");

function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

/**
 * The SPA reads error.code / error.message / error.fields off every failure, so
 * these rejections have to use that envelope — a bare string degrades to
 * "Request failed (401)" and the UI can tell the user nothing about why.
 */
function deny(res, status, code, message) {
  return res.status(status).json({ error: { code, message, fields: {} } });
}

async function authenticate(req, res, next) {
  const header = req.get("authorization") || "";

  if (!header.startsWith("Bearer ")) {
    return deny(res, 401, "unauthorized", "Please sign in to continue");
  }

  const token = header.slice(7).trim();

  if (!token) {
    return deny(res, 401, "unauthorized", "Please sign in to continue");
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const userId = payload.sub;
    const sessionId = payload.sessionId || payload.sid;

    if (!userId || !sessionId) {
      return deny(res, 401, "unauthorized", "This sign-in is not valid. Please sign in again.");
    }

    const result = await query(
      `SELECT
         s.id AS session_id,
         u.id,
         u.username,
         u.email,
         u.name,
         u.role,
         u.status
       FROM auth_sessions s
       INNER JOIN users u ON u.id = s.user_id
       WHERE s.id = $1
         AND s.user_id = $2
         AND s.token_hash = $3
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()
       LIMIT 1`,
      [sessionId, userId, hashToken(token)]
    );

    if (result.rowCount === 0) {
      return deny(res, 401, "session_expired", "Your session has ended. Please sign in again.");
    }

    const user = result.rows[0];

    if (user.status !== "active") {
      return deny(res, 403, "forbidden", "This account is not active");
    }

    await query(
      `UPDATE auth_sessions SET last_seen_at = NOW() WHERE id = $1`,
      [user.session_id]
    ).catch(() => {});

    req.user = {
      sub: String(user.id),
      id: String(user.id),
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      sessionId: String(user.session_id)
    };

    next();
  } catch {
    return deny(res, 401, "unauthorized", "This sign-in is not valid. Please sign in again.");
  }
}

module.exports = { authenticate, hashToken };
