const express = require("../_shim/express.js");
const bcrypt = require("bcryptjs");
const { query } = require("../db");
const { hashToken } = require("../middleware/security");
const { securityEvent } = require("../services/audit");
const tokens = require("../services/emailTokens");
const mailer = require("../services/mailer");

/* -------------------------------------------------------------------------- */
/*  The mail-driven half of authentication.                                   */
/*                                                                             */
/*  Mounted on /api/auth ahead of the authenticated /api catch-all, because     */
/*  every one of these calls is made by someone who cannot sign in yet.         */
/*  Responses never reveal whether an address is registered.                    */
/* -------------------------------------------------------------------------- */

const router = express.Router();

const GENERIC_RESET = "If an account exists for that address, a reset link is on its way.";
const GENERIC_VERIFY = "If that address needs verifying, a link is on its way.";

function envelope(res, status, code, message, fields) {
  return res.status(status).json({ error: { code, message, fields: fields || {} } });
}

function emailOf(req) {
  return String((req.body && req.body.email) || "").trim().toLowerCase();
}

function ip(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || null;
}

async function findAccount(email) {
  if (!email || email.length > 320) return null;
  const row = await query(
    `SELECT id, username, email, name, status, email_verified_at
       FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1`,
    [email]
  );
  return row.rowCount ? row.rows[0] : null;
}

/** Account exists, is usable, and the mailer accepted the job. */
function mailable(account) {
  return Boolean(account && account.status === "active");
}

router.post("/forgot-password", async (req, res) => {
  try {
    const account = await findAccount(emailOf(req));

    if (mailable(account)) {
      const issued = await tokens.issue("reset", account.id);
      mailer.send("reset-password", {
        to: account.email,
        name: account.name,
        params: { token: issued.token, expires_in: tokens.ttlLabel(issued.ttlMinutes) },
        idempotencyKey: `reset:${account.id}:${hashToken(issued.token)}`,
      });
      await securityEvent({
        userId: account.id,
        eventType: "password_reset_requested",
        ip: ip(req),
        userAgent: req.get("user-agent"),
      });
    }

    res.json({ message: GENERIC_RESET });
  } catch (err) {
    console.error("forgot-password failed:", err);
    // The visitor's inbox is not the thing that broke: answer as if it worked.
    res.json({ message: GENERIC_RESET });
  }
});

router.post("/resend-verification", async (req, res) => {
  try {
    const account = await findAccount(emailOf(req));

    if (mailable(account) && !account.email_verified_at) {
      const issued = await tokens.issue("verify", account.id);
      mailer.send("verify-email", {
        to: account.email,
        name: account.name,
        params: { token: issued.token, expires_in: tokens.ttlLabel(issued.ttlMinutes) },
        idempotencyKey: `verify:${account.id}:${hashToken(issued.token)}`,
      });
    }

    res.json({ message: GENERIC_VERIFY });
  } catch (err) {
    console.error("resend-verification failed:", err);
    res.json({ message: GENERIC_VERIFY });
  }
});

router.post("/recover-account", async (req, res) => {
  const message = "If we can find the account behind that address, recovery instructions are on their way.";
  try {
    const account = await findAccount(emailOf(req));

    if (mailable(account)) {
      const issued = await tokens.issue("reset", account.id);
      mailer.send("reset-password", {
        to: account.email,
        name: account.name,
        params: { token: issued.token, expires_in: tokens.ttlLabel(issued.ttlMinutes) },
        idempotencyKey: `recover:${account.id}:${hashToken(issued.token)}`,
      });
      await securityEvent({
        userId: account.id,
        eventType: "account_recovery_requested",
        ip: ip(req),
        userAgent: req.get("user-agent"),
      });
    }

    res.json({ message });
  } catch (err) {
    console.error("recover-account failed:", err);
    res.json({ message });
  }
});

router.post("/verify-email", async (req, res) => {
  try {
    const token = String((req.body && req.body.token) || "").trim();
    const used = await tokens.consume("verify", token);

    if (!used || !used.account) {
      return envelope(res, 400, "invalid_token", "This verification link is invalid or has expired.");
    }
    if (used.account.status !== "active") {
      return envelope(res, 403, "account_inactive", "This account is not active.");
    }

    await query(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW() WHERE id = $1`,
      [used.account.id]
    );
    await securityEvent({
      userId: used.account.id,
      eventType: "email_verified",
      ip: ip(req),
      userAgent: req.get("user-agent"),
    });

    res.status(204).end();
  } catch (err) {
    console.error("verify-email failed:", err);
    envelope(res, 500, "api_error", "Verification failed. Please try again.");
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const token = String((req.body && req.body.token) || "").trim();
    const password = String((req.body && req.body.password) || "");

    if (password.length < 8) {
      return envelope(res, 422, "validation_error", "Password must contain at least 8 characters", {
        password: "Too short",
      });
    }

    const used = await tokens.consume("reset", token);
    if (!used || !used.account) {
      return envelope(res, 400, "invalid_token", "This reset link is invalid or has expired.");
    }
    if (used.account.status !== "active") {
      return envelope(res, 403, "account_inactive", "This account is not active.");
    }

    await query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [
      await bcrypt.hash(password, 12),
      used.account.id,
    ]);
    await query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
      [used.account.id]
    );
    // The link is spent and the old password is gone, so every live session goes with it.
    await query(`UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = $1`, [used.account.id]);
    await securityEvent({
      userId: used.account.id,
      eventType: "password_reset",
      ip: ip(req),
      userAgent: req.get("user-agent"),
    });

    mailer.send("password-changed", {
      to: used.account.email,
      name: used.account.name,
      params: {},
      idempotencyKey: `password-changed:${used.account.id}:${Date.now()}`,
    });

    res.status(204).end();
  } catch (err) {
    console.error("reset-password failed:", err);
    envelope(res, 500, "api_error", "Password reset failed. Please try again.");
  }
});

module.exports = router;
