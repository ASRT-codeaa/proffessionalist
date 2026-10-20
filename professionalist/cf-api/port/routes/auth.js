const express = require("../_shim/express.js");
const bcrypt = require("bcryptjs");
const jwt = require("../_shim/jwt.js");
const crypto = require("crypto");
const { v4: uuidv4 } = require("../_shim/uuid.js");
const { query } = require("../db");
const { authenticate } = require("../middleware/security");
const { securityEvent } = require("../services/audit");
const { loadAuthUser } = require("../services/userDto");
const tokens = require("../services/emailTokens");
const mailer = require("../services/mailer");

const router = express.Router();

const MAX_LOGIN_FAILURES = Number(process.env.MAX_LOGIN_FAILURES || 5);
const LOCKOUT_MINUTES = Number(process.env.LOCKOUT_MINUTES || 15);
const SESSION_TTL = () => Number(process.env.SESSION_TTL_SECONDS || 604800);
const JWT_OPTS = { issuer: "professionalist-api", audience: "professionalist" };

function ip(req) {
  return req.ip || req.socket.remoteAddress || null;
}

function issueToken(user, sessionId) {
  return jwt.sign(
    { sub: String(user.id), role: user.role, sessionId },
    process.env.JWT_SECRET,
    Object.assign({ expiresIn: process.env.JWT_EXPIRES_IN || "2h" }, JWT_OPTS)
  );
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function createSession(user, req) {
  const sessionId = uuidv4();
  const token = issueToken(user, sessionId);
  const tokenHash = hashToken(token);
  await query(
    `INSERT INTO auth_sessions
     (id,user_id,token_hash,expires_at,ip_address,user_agent)
     VALUES ($1,$2,$3,NOW()+($4 * INTERVAL '1 second'),$5,$6)`,
    [sessionId, user.id, tokenHash, SESSION_TTL(), ip(req), req.get("user-agent") || null]
  );
  return { token, sessionId };
}

async function registerProfile(uid, { firstName, lastName, company, jobTitle, country, category, website }) {
  await query(
    `INSERT INTO profiles
       (user_id, first_name, last_name, company_name, job_title, headline, country, category, website)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8)
     ON CONFLICT (user_id) DO NOTHING`,
    [
      uid,
      String(firstName || "").trim().slice(0, 80) || null,
      String(lastName || "").trim().slice(0, 80) || null,
      String(company || "").trim().slice(0, 180) || null,
      String(jobTitle || "").trim().slice(0, 180) || null,
      String(country || "").trim().slice(0, 120) || null,
      String(category || "").trim().slice(0, 120) || null,
      String(website || "").trim().slice(0, 255) || null,
    ]
  ).catch(err => console.error("Profile bootstrap failed:", err.message));
}

router.post("/register", async (req, res) => {
  try {
    const {
      username, email, password, name, firstName, lastName,
      accountType, company, jobTitle, country, category, website,
    } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: "username, email and password are required" });
    }
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "Password must contain at least 8 characters" });
    }

    const type = accountType === "company" ? "company" : "individual";
    if (type === "company" && !(company && String(company).trim())) {
      return res.status(400).json({
        error: { code: "validation_error", message: "Company name is required", fields: { company: "Company name is required" } },
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedUsername = String(username).trim();

    const existing = await query(
      `SELECT id FROM users
       WHERE LOWER(email)=LOWER($1) OR LOWER(username)=LOWER($2)
       LIMIT 1`,
      [normalizedEmail, normalizedUsername]
    );
    if (existing.rows.length) {
      return res.status(409).json({
        error: { code: "validation_error", message: "Account already exists", fields: { email: "Email already registered" } },
      });
    }

    const fullName =
      (name && String(name).trim()) ||
      [firstName, lastName].filter(Boolean).join(" ").trim() ||
      normalizedUsername;

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await query(
      `INSERT INTO users
       (username,email,password_hash,name,role,status,account_type)
       VALUES ($1,$2,$3,$4,'user','active',$5)
       RETURNING id,username,email,name,role,status,account_type,created_at`,
      [normalizedUsername, normalizedEmail, passwordHash, fullName, type]
    );
    const user = result.rows[0];

    await securityEvent({
      userId: user.id,
      eventType: "registration",
      ip: ip(req),
      userAgent: req.get("user-agent"),
    });

    await registerProfile(user.id, { firstName, lastName, company, jobTitle, country, category, website });

    // Signup succeeds even if the mail side is broken; the link can be resent.
    try {
      const issued = await tokens.issue("verify", user.id);
      mailer.send("verify-email", {
        to: user.email,
        name: fullName,
        params: { token: issued.token, expires_in: tokens.ttlLabel(issued.ttlMinutes) },
        idempotencyKey: `verify:${user.id}:${hashToken(issued.token)}`,
      });
    } catch (err) {
      console.error("verification mail skipped:", err.message);
    }

    const { token } = await createSession(user, req);
    const authUser = await loadAuthUser(user.id);

    res.status(201).json({ user: authUser, token, refreshToken: token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const result = await query(
      `SELECT id,username,email,password_hash,name,role,status,account_type,
              failed_login_attempts,locked_until
       FROM users
       WHERE LOWER(email)=LOWER($1)
       LIMIT 1`,
      [String(email).trim().toLowerCase()]
    );

    if (!result.rows.length) {
      await securityEvent({ eventType: "login_failed", ip: ip(req), userAgent: req.get("user-agent"), details: { reason: "invalid_credentials" } });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = result.rows[0];

    if (user.status !== "active") {
      return res.status(403).json({ error: "Account is not active" });
    }
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      return res.status(429).json({ error: "Account temporarily locked" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const failures = Number(user.failed_login_attempts || 0) + 1;
      if (failures >= MAX_LOGIN_FAILURES) {
        await query(
          `UPDATE users SET failed_login_attempts=0, locked_until=NOW()+($1 * INTERVAL '1 minute') WHERE id=$2`,
          [LOCKOUT_MINUTES, user.id]
        );
      } else {
        await query(`UPDATE users SET failed_login_attempts=$1 WHERE id=$2`, [failures, user.id]);
      }
      await securityEvent({ userId: user.id, eventType: "login_failed", ip: ip(req), userAgent: req.get("user-agent"), details: { failures } });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    await query(
      `UPDATE users SET failed_login_attempts=0, locked_until=NULL, last_login_at=NOW() WHERE id=$1`,
      [user.id]
    );

    const { token } = await createSession(user, req);
    await securityEvent({ userId: user.id, eventType: "login_success", ip: ip(req), userAgent: req.get("user-agent") });

    res.json({ token, refreshToken: token, user: await loadAuthUser(user.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(401).json({ error: "No refresh token" });

    let payload;
    try {
      payload = jwt.verify(refreshToken, process.env.JWT_SECRET, JWT_OPTS);
    } catch {
      return res.status(401).json({ error: "Session expired" });
    }

    const result = await query(
      `SELECT id::int AS id, username, email, name, role, status, account_type
         FROM users WHERE id = $1`,
      [payload.sub]
    );
    if (!result.rows.length || result.rows[0].status !== "active") {
      return res.status(401).json({ error: "Session expired" });
    }

    const user = result.rows[0];
    const sessionId = payload.sessionId || uuidv4();
    const token = issueToken(user, sessionId);

    // The session-aware middleware matches the bearer token against this hash,
    // so a rotated token has to be recorded or every later request looks revoked.
    await query(
      `UPDATE auth_sessions
          SET token_hash = $1, expires_at = NOW() + ($2 * INTERVAL '1 second'), last_seen_at = NOW()
        WHERE id = $3 AND user_id = $4 AND revoked_at IS NULL`,
      [hashToken(token), SESSION_TTL(), sessionId, user.id]
    );

    res.json({ token, refreshToken: token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Refresh failed" });
  }
});

router.post("/logout", authenticate, async (req, res) => {
  await query(
    `UPDATE auth_sessions SET revoked_at=NOW() WHERE id=$1 AND user_id=$2`,
    [req.user.sessionId, req.user.sub]
  );
  res.json({ success: true });
});

router.get("/me", authenticate, async (req, res) => {
  try {
    const authUser = await loadAuthUser(req.user.sub);
    if (!authUser) return res.status(404).json({ error: "User not found" });
    res.json(authUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to load your account" });
  }
});

module.exports = router;
