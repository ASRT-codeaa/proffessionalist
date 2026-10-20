const express = require("../_shim/express.js");
const { query } = require("../db");
const { authenticate, requireStaff, requireAdmin } = require("../middleware/security");
const { audit } = require("../services/audit");
const mailer = require("../services/mailer");
const dto = require("../services/spaDto");
const kit = require("../services/spaKit");

const router = express.Router();

const { handle, builder, missing, toId, str, likeValue, businessesFor, num } = kit;

router.use(authenticate);
router.use(requireStaff);

router.get("/users", async (req, res) => {
  const result = await query(
    `SELECT id,username,email,name,role,status,created_at,last_login_at,
            COALESCE(verified, FALSE) AS verified,
            COALESCE(verified_badge, '') AS verified_badge
     FROM users
     ORDER BY created_at DESC
     LIMIT 500`
  );

  res.json({ users: result.rows });
});

router.get("/security-events", async (req, res) => {
  const result = await query(
    `SELECT id,user_id,event_type,ip_address,user_agent,details,created_at
     FROM security_events
     ORDER BY created_at DESC
     LIMIT 500`
  );

  res.json({ events: result.rows });
});

router.get("/audit-logs", async (req, res) => {
  const result = await query(
    `SELECT id,actor_user_id AS actor_id,action,target_user_id,details,created_at
     FROM audit_logs
     ORDER BY created_at DESC
     LIMIT 500`
  );

  res.json({ logs: result.rows });
});

router.patch("/users/:id/status", requireAdmin, async (req, res) => {
  const { status } = req.body;

  if (!["active", "suspended", "deactivated"].includes(status)) {
    return res.status(400).json({
      error: "Invalid account status"
    });
  }

  const result = await query(
    `UPDATE users
     SET status=$1
     WHERE id=$2
     RETURNING id,username,email,name,role,status`,
    [status, req.params.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: "User not found" });
  }

  await query(
    `UPDATE auth_sessions
     SET revoked_at=NOW()
     WHERE user_id=$1 AND $2<>'active'`,
    [req.params.id, status]
  );

  await audit({
    actorId: req.user.sub,
    action: "account_status_changed",
    targetUserId: req.params.id,
    ip: req.ip,
    details: { status }
  });

  res.json({ user: result.rows[0] });
});

router.patch("/users/:id/role", requireAdmin, async (req, res) => {
  const { role } = req.body;

  if (!["user", "staff", "admin"].includes(role)) {
    return res.status(400).json({
      error: "Invalid role"
    });
  }

  if (String(req.user.sub) === String(req.params.id) && role !== "admin") {
    return res.status(400).json({
      error: "Administrators cannot remove their own administrator role"
    });
  }

  const result = await query(
    `UPDATE users
     SET role=$1
     WHERE id=$2
     RETURNING id,username,email,name,role,status`,
    [role, req.params.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: "User not found" });
  }

  await audit({
    actorId: req.user.sub,
    action: "role_changed",
    targetUserId: req.params.id,
    ip: req.ip,
    details: { role }
  });

  res.json({ user: result.rows[0] });
});

/* -------------------------------------------------------------------------- */
/*                          console read models                               */
/* -------------------------------------------------------------------------- */

/*
 * The console tabs below answer with the camelCase row shapes the client's
 * AdminStats / AdminBusinessRow / AdminReportRow / SupportTicket / Campaign
 * types declare, so the page renders straight from these responses. Everything
 * is built from fixed SQL plus bound parameters; no identifier comes from the
 * request. There is no payments schema, so transactions is deliberately empty
 * rather than invented.
 */

const ADMIN_WINDOW = 300;

/** Signup counts for the trailing 12 months, oldest first, always 12 values. */
async function monthlySignups() {
  const months = await query(
    `SELECT to_char(month, 'YYYY-MM') AS ym
       FROM (SELECT date_trunc('month', NOW()) - (interval '1 month' * g) AS month
               FROM generate_series(11, 0, -1) AS g) m
      ORDER BY month`
  );
  const counts = await query(
    `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS ym, COUNT(*)::int AS n
       FROM users
      GROUP BY 1`
  );
  const byMonth = new Map(counts.rows.map(r => [r.ym, num(r.n)]));
  return months.rows.map(r => byMonth.get(r.ym) || 0);
}

router.get("/stats", handle(async (req, res) => {
  const [totals, categories, trend] = await Promise.all([
    query(
      `SELECT
         (SELECT COUNT(*) FROM users)::int AS users,
         (SELECT COUNT(*) FROM users WHERE status = 'active')::int AS active_users,
         (SELECT COUNT(*) FROM users
           WHERE created_at >= date_trunc('day', NOW()))::int AS signups_today,
         (SELECT COUNT(*) FROM companies)::int AS businesses,
         (SELECT COUNT(*) FROM marketplace_listings)::int AS products,
         (SELECT COUNT(*) FROM posts WHERE deleted_at IS NULL)::int AS posts,
         (SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL)::int AS messages,
         (SELECT COUNT(*) FROM reports)::int AS reports`
    ),
    query(
      `SELECT lc.name, COUNT(*)::int AS count
         FROM marketplace_listings m
         JOIN listing_categories lc ON lc.id = m.category_id
        GROUP BY lc.id, lc.name
        ORDER BY count DESC, lc.name
        LIMIT 6`
    ),
    monthlySignups(),
  ]);
  const t = totals.rows[0];

  res.json({
    totals: {
      users: t.users,
      activeUsers: t.active_users,
      businesses: t.businesses,
      products: t.products,
      posts: t.posts,
      messages: t.messages,
      reports: t.reports,
      revenue: 0,
    },
    userTrend: trend,
    revenueTrend: trend.map(() => 0),
    signupsToday: t.signups_today,
    topCategories: categories.rows.map(r => ({ name: r.name, count: r.count })),
  });
}));

router.get("/businesses", handle(async (req, res) => {
  const needle = str(req.query.q, 120).toLowerCase();
  const b = builder([needle]);
  const like = b.add(likeValue(needle));

  const rows = await query(
    `SELECT c.id::int AS id,
            c.name,
            COALESCE(NULLIF(c.industry, ''), NULLIF(c.category, ''), '') AS industry,
            COALESCE(NULLIF(u.name, ''), u.username, '') AS owner,
            COALESCE(c.verified, FALSE) AS verified,
            (SELECT COUNT(*) FROM marketplace_listings ml WHERE ml.company_id = c.id)::int AS listings,
            (SELECT COUNT(*) FROM company_followers cf WHERE cf.company_id = c.id)::int AS followers,
            c.created_at
       FROM companies c
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE $1 = ''
         OR LOWER(c.name) LIKE ${like}
         OR LOWER(COALESCE(c.industry, c.category, '')) LIKE ${like}
         OR LOWER(COALESCE(u.name, u.username, '')) LIKE ${like}
      ORDER BY c.created_at DESC
      LIMIT ${ADMIN_WINDOW}`,
    b.params
  );

  res.json(rows.rows.map(r => ({
    id: num(r.id),
    name: str(r.name, 180),
    industry: str(r.industry, 120),
    owner: str(r.owner, 120),
    verified: Boolean(r.verified),
    listings: num(r.listings),
    followers: num(r.followers),
    createdAt: dto.iso(r.created_at) || new Date().toISOString(),
  })));
}));

/**
 * Businesses are addressed by their company id here, not the public slug the
 * owner-facing routes use, and the caller already passed requireAdmin.
 */
async function setVerified(req, res) {
  const id = toId(req.params.id);
  const body = req.body || {};
  const wanted = body.verified === undefined
    ? ["verify", "unverify"].includes(str(body.action, 20)) ? body.action === "verify" : null
    : Boolean(body.verified);
  if (wanted === null) return res.status(400).json({ error: "verified is required" });

  const updated = await query(
    `UPDATE companies SET verified = $2
      WHERE id = $1
      RETURNING id::int AS id, name, verified`,
    [id, wanted]
  );
  if (!updated.rowCount) return missing(res, "Business");

  await audit({
    actorId: req.user.sub,
    action: wanted ? "business_verified" : "business_unverified",
    ip: req.ip,
    details: { companyId: id },
  });

  res.json({ business: { id: updated.rows[0].id, name: updated.rows[0].name, verified: Boolean(updated.rows[0].verified) } });
}

router.post("/businesses/:id/verify", requireAdmin, handle(setVerified));
router.patch("/businesses/:id/verify", requireAdmin, handle(setVerified));

router.get("/listings", handle(async (req, res) => {
  const rows = await query(
    `SELECT ${dto.LISTING_COLUMNS}
       FROM marketplace_listings m
       ${dto.listingJoins(null)}
      ORDER BY m.created_at DESC
      LIMIT ${ADMIN_WINDOW}`
  );
  const found = rows.rows;
  const [people, businesses] = await Promise.all([
    dto.loadPeople(found.map(r => r.seller_id).filter(Boolean), null),
    businessesFor(found, null),
  ]);
  const items = found.map(r => dto.toListing(r, people, businesses));

  const needle = str(req.query.q, 120).toLowerCase();
  res.json(needle
    ? items.filter(l => `${l.title} ${l.seller.name} ${l.category?.name ?? ""}`.toLowerCase().includes(needle))
    : items);
}));

router.get("/posts", handle(async (req, res) => {
  const rows = await query(
    `SELECT ${dto.POST_COLUMNS}
       FROM posts p
       ${dto.postJoins(null)}
      WHERE p.deleted_at IS NULL
      ORDER BY p.created_at DESC
      LIMIT ${ADMIN_WINDOW}`
  );
  const found = rows.rows;
  const [people, businesses] = await Promise.all([
    dto.loadPeople(found.map(r => r.user_id).filter(Boolean), null),
    businessesFor(found, null),
  ]);
  const items = found.map(r => dto.toPost(r, people, businesses, null));

  const needle = str(req.query.q, 120).toLowerCase();
  res.json(needle
    ? items.filter(p => `${p.text} ${"username" in p.author ? p.author.username : p.author.name}`
      .toLowerCase().includes(needle))
    : items);
}));

const REPORT_STATUS = { open: "open", resolve: "resolved", resolved: "resolved", dismiss: "dismissed", dismissed: "dismissed", review: "reviewing", reviewing: "reviewing" };

router.get("/reports", handle(async (req, res) => {
  const status = str(req.query.status, 20);
  const b = builder([]);
  const where = ["1 = 1"];
  if (REPORT_STATUS[status]) where.push(`r.status = ${b.add(REPORT_STATUS[status])}`);

  const rows = await query(
    `SELECT r.id::int AS id,
            r.target_type,
            COALESCE(NULLIF(r.target_label, ''),
                     r.target_type || ' #' || COALESCE(r.target_id::text, 'unknown')) AS target,
            COALESCE(NULLIF(u.name, ''), NULLIF(u.username, ''), 'Someone') AS reporter,
            r.reason, r.status, r.created_at
       FROM reports r
       LEFT JOIN users u ON u.id = r.reporter_id
      WHERE ${where.join(" AND ")}
      ORDER BY r.created_at DESC
      LIMIT 200`,
    b.params
  );

  res.json(rows.rows.map(r => ({
    id: num(r.id),
    targetType: str(r.target_type, 20),
    target: str(r.target, 220),
    reporter: str(r.reporter, 120),
    reason: str(r.reason, 60),
    status: ["open", "reviewing", "resolved", "dismissed"].includes(r.status) ? r.status : "open",
    createdAt: dto.iso(r.created_at) || new Date().toISOString(),
  })));
}));

async function reportAction(req, res) {
  const id = toId(req.params.id);
  const action = str(req.body?.action || req.body?.status, 20).toLowerCase();
  const status = REPORT_STATUS[action];
  if (!status) return res.status(400).json({ error: "Unknown report action" });

  const updated = await query(
    `UPDATE reports SET status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id::int AS id, status`,
    [id, status]
  );
  if (!updated.rowCount) return missing(res, "Report");

  await audit({
    actorId: req.user.sub,
    action: "report_status_changed",
    ip: req.ip,
    details: { reportId: id, status },
  });

  res.json({ ok: true, report: { id: updated.rows[0].id, status: updated.rows[0].status } });
}

router.post("/reports/:id/action", requireAdmin, handle(reportAction));
router.patch("/reports/:id/action", requireAdmin, handle(reportAction));

/**
 * No payments or ledger table exists in this schema, so the transactions tab
 * reports an honest empty list instead of manufacturing amounts.
 */
router.get("/transactions", handle(async (req, res) => {
  res.json([]);
}));

router.get("/tickets", handle(async (req, res) => {
  const tickets = await query(
    `SELECT t.id::int AS id, t.subject, t.category, t.status, t.updated_at
       FROM support_tickets t
      ORDER BY t.updated_at DESC
      LIMIT 200`
  );
  const ids = tickets.rows.map(t => t.id);
  if (!ids.length) return res.json([]);

  const messages = await query(
    `SELECT m.id::int AS id, m.ticket_id::int AS ticket_id, m.from_user, m.body,
            m.attachment_url, m.created_at
       FROM support_messages m
      WHERE m.ticket_id = ANY($1::bigint[])
      ORDER BY m.created_at`,
    [ids]
  );
  const byTicket = new Map();
  for (const m of messages.rows) {
    if (!byTicket.has(m.ticket_id)) byTicket.set(m.ticket_id, []);
    byTicket.get(m.ticket_id).push(m);
  }

  res.json(tickets.rows.map(t => dto.toTicket(t, byTicket.get(t.id) || [])));
}));

router.get("/ads", handle(async (req, res) => {
  const rows = await query(
    `SELECT id::int AS id, name, objective, audience, budget, spend,
            start_date, end_date, format, creative_url, creative_text,
            destination, status, metrics, created_at
       FROM ad_campaigns
      ORDER BY created_at DESC
      LIMIT 200`
  );
  res.json(rows.rows.map(dto.toCampaign));
}));

/**
 * The console's single action button posts a verb instead of a status, so this
 * maps the verbs onto the same account fields /users/:id/status and /role do.
 */
const USER_ACTIONS = {
  suspend: { status: "suspended" },
  block: { status: "suspended" },
  unsuspend: { status: "active" },
  activate: { status: "active" },
  unblock: { status: "active" },
  delete: { status: "deactivated" },
  verify: { verified: true },
  unverify: { verified: false, verified_badge: null },
};

/* Badge colours the console can hand out. "brand" and an empty column both
   mean the app accent, so a granted badge never depends on theme tokens. */
const BADGE_COLORS = ["brand", "blue", "green", "gold", "purple", "red", "teal"];

/* The mail template names the badge, so the colour column needs a word. */
const BADGE_LABELS = {
  brand: "Professionalist",
  blue: "Blue",
  green: "Green",
  gold: "Gold",
  purple: "Purple",
  red: "Red",
  teal: "Teal",
};

async function userAction(req, res) {
  const id = toId(req.params.id);
  const action = str(req.body?.action || req.body?.status, 20).toLowerCase();
  /* Own-property test: a plain lookup would answer for "constructor" etc. with
     an inherited value and build an UPDATE out of nothing. */
  if (!Object.prototype.hasOwnProperty.call(USER_ACTIONS, action)) {
    return res.status(400).json({ error: "Unknown user action" });
  }
  const patch = { ...USER_ACTIONS[action] };

  if (action === "verify") {
    const color = str(req.body?.badge ?? req.body?.color, 20).toLowerCase();
    patch.verified_badge = BADGE_COLORS.includes(color) ? color : null;
  }

  if (String(req.user.sub) === String(id) && patch.status && patch.status !== "active") {
    return res.status(400).json({ error: "You cannot lock your own account from here" });
  }

  const keys = Object.keys(patch);
  const params = keys.map(k => patch[k]);
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const updated = await query(
    `UPDATE users SET ${setClause}
      WHERE id = $${keys.length + 1}
      RETURNING id, username, email, name, role, status,
                COALESCE(verified, FALSE) AS verified,
                COALESCE(verified_badge, '') AS verified_badge`,
    [...params, id]
  );
  if (!updated.rowCount) return missing(res, "User");

  if (patch.status && patch.status !== "active") {
    await query(`UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = $1`, [id]);
  }

  await audit({
    actorId: req.user.sub,
    action: `user_${action}`,
    targetUserId: id,
    ip: req.ip,
    details: patch,
  });

  const member = updated.rows[0];

  if (action === "verify") {
    mailer.send("badge-granted", {
      to: member.email,
      name: member.name,
      params: {
        badge: BADGE_LABELS[patch.verified_badge] || "Verified",
        username: member.username,
      },
      idempotencyKey: `badge:${id}:${patch.verified_badge || "brand"}:${Date.now()}`,
    });
  }

  if (patch.status === "suspended") {
    mailer.send("account-suspended", {
      to: member.email,
      name: member.name,
      params: { reason: str(req.body?.reason || req.body?.note, 200) || "a policy review" },
      idempotencyKey: `suspend:${id}:${Date.now()}`,
    });
  }

  res.json({ ok: true, user: member });
}

router.post("/users/:id/action", requireAdmin, handle(userAction));
router.patch("/users/:id/action", requireAdmin, handle(userAction));

module.exports = router;
