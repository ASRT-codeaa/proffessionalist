const crypto = require("crypto");
const { query } = require("../db");
const { hashToken } = require("../middleware/security");

/* -------------------------------------------------------------------------- */
/*  Single-use, hashed mail tokens.                                           */
/*                                                                             */
/*  Only the SHA-256 digest is stored, in the same shape auth_sessions and the  */
/*  original security migration already use, so a database leak hands nobody    */
/*  a working link. Tokens are rotated per purpose: issuing a new one marks the */
/*  outstanding ones for that member dead.                                     */
/* -------------------------------------------------------------------------- */

const PURPOSES = {
  verify: { table: "email_verification_tokens", ttl: () => Number(process.env.EMAIL_VERIFY_TTL_HOURS || 24) * 60 },
  reset: { table: "password_reset_tokens", ttl: () => Number(process.env.PASSWORD_RESET_TTL_MINUTES || 60) },
};

function purpose(name) {
  const entry = PURPOSES[name];
  if (!entry) throw new Error(`Unknown mail token purpose: ${name}`);
  return entry;
}

/** Returns the plaintext token once; the caller mails it and forgets it. */
async function issue(name, userId) {
  const { table } = purpose(name);
  const minutes = purpose(name).ttl();
  const token = crypto.randomBytes(32).toString("hex");

  await query(`DELETE FROM ${table} WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  const row = await query(
    `INSERT INTO ${table} (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 minute'))
     RETURNING expires_at`,
    [userId, hashToken(token), minutes]
  );

  return { token, expiresAt: row.rows[0].expires_at, ttlMinutes: minutes };
}

/** Marks the token used and returns its member, or null for a bad/expired link. */
async function consume(name, token) {
  const { table } = purpose(name);
  const text = String(token || "").trim();
  if (!/^[0-9a-f]{16,128}$/i.test(text)) return null;

  const row = await query(
    `UPDATE ${table}
        SET used_at = NOW()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
      RETURNING user_id, token_hash, expires_at, created_at`,
    [hashToken(text)]
  );
  if (!row.rowCount) return null;

  const account = await query(
    `SELECT id, username, email, name, status FROM users WHERE id = $1`,
    [row.rows[0].user_id]
  );
  if (!account.rowCount) return null;

  return { account: account.rows[0], usedAt: row.rows[0].expires_at };
}

/** "Link already used" state for the resend paths. */
async function isVerified(userId) {
  const row = await query(`SELECT email_verified_at FROM users WHERE id = $1`, [userId]);
  return Boolean(row.rowCount && row.rows[0].email_verified_at);
}

function ttlLabel(minutes) {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} day${minutes > 1440 ? "s" : ""}`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} hour${minutes > 60 ? "s" : ""}`;
  return `${Math.max(5, minutes)} minutes`;
}

module.exports = { issue, consume, isVerified, ttlLabel };
