const express = require("../../_shim/express.js");
const crypto = require("crypto");
const migrations = require("../../compat/migrations-manifest.js");
const path = require("path");

const { query, pool } = require("../../db");
const { audit } = require("../../services/audit");
const kit = require("../../services/spaKit");

const { handle, invalid, str, toId, forbidden, fail, likeValue } = kit;

const router = express.Router();

/* -------------------------------------------------------------------------- */
/*  Server operations surface.                                                 */
/*                                                                             */
/*  Everything that used to need an SSH session — inspecting row counts,       */
/*  removing accounts, purging demo content, editing the content the app       */
/*  renders, applying an already-shipped SQL migration — is reachable here.    */
/*                                                                             */
/*  Guard rails, in order:                                                     */
/*   1. /api/admin/* is already behind authenticate + requireStaff (admin.js). */
/*   2. requireOps additionally demands role 'admin' and, when OPS_OWNER_ID is */
/*      set, that the caller is that one designated account.                   */
/*   3. When OPS_TOKEN is set every write also needs a matching x-ops-token   */
/*      header, compared in constant time.                                     */
/*   4. No statement is ever built from caller-supplied SQL: identifiers come  */
/*      from fixed allowlists and values are bound as parameters.              */
/*   5. Every mutation is written to audit_logs and reported back.            */
/* -------------------------------------------------------------------------- */

const MIGRATIONS_DIR = "bundled:compat/migrations-manifest.js";
const MIGRATION_NAME = /^[0-9]{3}_[a-z0-9_]+\.sql$/i;

const CONTENT_KEY = /^[a-z0-9][a-z0-9_.-]{0,59}$/;

/** Row counts for the status panel. Only real table names, so no injection. */
const STATUS_TABLES = [
  "users", "profiles", "posts", "comments", "connections", "follows",
  "marketplace_listings", "listing_categories", "listing_favorites",
  "companies", "job_listings", "job_applications", "conversations", "messages",
  "notifications", "user_tasks", "user_settings", "support_tickets",
  "ad_campaigns", "ai_conversations", "reports", "reviews", "auth_sessions",
];

const PURGE_TARGETS = {
  posts: ["comments", "post_likes", "post_shares", "saved_posts", "poll_votes", "comment_likes", "posts"],
  listings: ["listing_favorites", "marketplace_listings"],
  messages: ["messages", "conversation_members", "conversations"],
  notifications: ["notifications"],
  tasks: ["user_tasks"],
  opportunities: ["job_applications", "job_listings"],
  reviews: ["reviews"],
  reports: ["reports"],
  campaigns: ["ad_campaigns"],
  ai: ["ai_messages", "ai_conversations"],
  support: ["support_messages", "support_tickets"],
  search: ["search_history", "saved_items"],
};

function matches(expected, given) {
  const a = Buffer.from(String(expected), "utf8");
  const b = Buffer.from(String(given), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireOps(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return forbidden(res, "Server operations need administrator access");
  }

  const owner = Number(process.env.OPS_OWNER_ID || 0);
  if (owner && Number(req.user.sub) !== owner) {
    return forbidden(res, "Only the designated operator account can change server contents");
  }

  const token = process.env.OPS_TOKEN;
  if (token && !matches(token, req.headers["x-ops-token"] || "")) {
    return fail(res, 401, "unauthorized", "Missing or wrong x-ops-token header");
  }

  next();
}

router.use(requireOps);

async function log(req, action, details) {
  await audit({
    actorId: Number(req.user.sub),
    action: `ops.${action}`,
    ip: req.ip,
    details: details || {},
  });
}

async function tableCounts() {
  const out = {};
  const found = await query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name = ANY($1::text[])`,
    [STATUS_TABLES]
  );
  for (const row of found.rows) {
    const res = await query(`SELECT COUNT(*)::int AS n FROM ${row.table_name}`);
    out[row.table_name] = res.rows[0].n;
  }
  return out;
}

async function migrationState() {
  let applied = [];
  try {
    const res = await query(`SELECT file, applied_at FROM ops_migrations ORDER BY file`);
    applied = res.rows;
  } catch {
    /* the console's own table is not there yet — report files as unapplied */
  }
  const byFile = new Map(applied.map(a => [a.file, a.applied_at]));

  let onDisk = [];
  try {
    onDisk = migrations.map(m => m.name).filter(f => MIGRATION_NAME.test(f)).sort();
  } catch {
    /* migrations directory missing: report nothing */
  }

  return onDisk.map(file => ({
    file,
    applied: byFile.has(file) ? byFile.get(file) : null,
  }));
}

/* ------------------------------- read-only ------------------------------- */

router.get("/status", handle(async (req, res) => {
  const [tables, migrations, content] = await Promise.all([
    tableCounts(),
    migrationState(),
    listContent().catch(() => []),
  ]);

  res.json({
    server: {
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      envKeys: Object.keys(process.env).filter(k => /^(DB|REDIS|CORS|JWT|OPS|NODE|PORT)/.test(k)).sort(),
      hardening: {
        ownerLock: Boolean(Number(process.env.OPS_OWNER_ID || 0)),
        tokenRequired: Boolean(process.env.OPS_TOKEN),
      },
    },
    tables,
    migrations,
    contentKeys: content.map(c => c.key),
  });
}));

router.get("/audit", handle(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const result = await query(
    `SELECT id, actor_user_id, action, target_user_id, details, created_at
       FROM audit_logs
      WHERE action LIKE 'ops.%'
      ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  res.json({ logs: result.rows });
}));

/* --------------------------------- users --------------------------------- */

/**
 * Delete accounts and everything the schema cascades from them. The caller can
 * name ids or a username/name/email pattern; both resolve to the same guard.
 */
router.post("/users/delete", handle(async (req, res) => {
  const body = req.body || {};
  const ids = Array.isArray(body.ids) ? body.ids.map(v => toId(v, "ids")) : [];
  const pattern = str(body.pattern, 120);
  const dryRun = body.dryRun === true || body.dryRun === "true";

  if (!ids.length && !pattern) {
    return invalid(res, { ids: "Give ids or a pattern to match" });
  }

  const like = likeValue(pattern || "zz_no_match_zz");
  const found = await query(
    ids.length
      ? `SELECT id, username, email, name, role FROM users WHERE id = ANY($1::bigint[]) ORDER BY id`
      : `SELECT id, username, email, name, role FROM users
          WHERE username ILIKE $1 OR name ILIKE $1 OR email ILIKE $1
          ORDER BY id`,
    [ids.length ? ids : like]
  );

  const owner = Number(process.env.OPS_OWNER_ID || 0);
  // node-postgres hands BIGINT columns back as strings, so compare numerically.
  const foundIds = found.rows.map(u => Number(u.id));
  const protectedIds = foundIds
    .filter((id, i) => ["admin", "staff"].includes(found.rows[i].role) || id === owner || id === Number(req.user.sub))
    .map(String);
  const doomed = found.rows.filter(u => !protectedIds.includes(String(u.id)));

  if (!doomed.length) {
    return invalid(res, { match: "No deletable accounts matched — staff, admin and operator accounts are never removed" });
  }
  if (doomed.length > 50 && !body.confirm) {
    return invalid(res, { confirm: `About to delete ${doomed.length} accounts; send confirm:"DELETE" to proceed` });
  }

  if (dryRun) return res.json({ dryRun: true, willDelete: doomed, keptProtected: protectedIds });

  const deleted = await query(
    `DELETE FROM users WHERE id = ANY($1::bigint[])
     RETURNING id, username, email, name`,
    [doomed.map(u => u.id)]
  );

  // Threads can outlive their members: conversations has no owner column.
  await query(`DELETE FROM conversations WHERE NOT EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = conversations.id)`);

  await log(req, "users.delete", { count: deleted.rowCount, ids: deleted.rows.map(r => r.id), pattern: pattern || null });
  res.json({ deleted: deleted.rows, keptProtected: protectedIds });
}));

router.post("/users/role", handle(async (req, res) => {
  const id = toId(req.body && req.body.id, "id");
  const role = str(req.body && req.body.role, 20);

  if (!["user", "staff", "admin"].includes(role)) {
    return invalid(res, { role: "Choose user, staff or admin" });
  }

  const owner = Number(process.env.OPS_OWNER_ID || 0);
  if (owner && id === owner && role !== "admin") {
    return invalid(res, { role: "The operator account must stay an administrator" });
  }

  const result = await query(
    `UPDATE users SET role=$1, updated_at=NOW() WHERE id=$2 RETURNING id, username, role`,
    [role, id]
  );
  if (!result.rowCount) return invalid(res, { id: "No such account" });

  // Role lives inside the signed token, so existing sessions must re-authenticate.
  await query(`UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL`, [id]);

  await log(req, "users.role", { targetUserId: id, role });
  res.json({ user: result.rows[0], sessionsRevoked: true });
}));

/* -------------------------------- content -------------------------------- */

async function listContent() {
  const result = await query(
    `SELECT key, value, updated_at FROM app_content ORDER BY key`
  );
  return result.rows;
}

router.get("/content", handle(async (req, res) => {
  res.json({ items: await listContent() });
}));

router.put("/content", handle(async (req, res) => {
  const key = str(req.body && req.body.key, 60);
  if (!CONTENT_KEY.test(key)) return invalid(res, { key: "Use 1-60 lowercase letters, digits, dot, dash or underscore" });

  const value = req.body && req.body.value;
  if (value === undefined) return invalid(res, { value: "Provide a JSON value" });

  const json = JSON.stringify(value);
  if (json.length > 20000) return invalid(res, { value: "Value is larger than 20 KB" });

  const result = await query(
    `INSERT INTO app_content (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING key, value, updated_at`,
    [key, json, Number(req.user.sub)]
  );

  await log(req, "content.put", { key, bytes: json.length });
  res.json({ item: result.rows[0] });
}));

router.delete("/content/:key", handle(async (req, res) => {
  const key = str(req.params.key, 60);
  if (!CONTENT_KEY.test(key)) return invalid(res, { key: "Unknown key" });

  const result = await query(`DELETE FROM app_content WHERE key=$1 RETURNING key`, [key]);
  if (!result.rowCount) return invalid(res, { key: "No stored value under that key" });

  await log(req, "content.delete", { key });
  res.json({ ok: true });
}));

/** Marketplace categories are server content too. */
router.put("/categories", handle(async (req, res) => {
  const items = Array.isArray(req.body && req.body.categories) ? req.body.categories : [];
  if (!items.length) return invalid(res, { categories: "Send a list of {slug,name,icon}" });
  if (items.length > 100) return invalid(res, { categories: "At most 100 categories at a time" });

  const saved = [];
  for (const raw of items) {
    const slug = str(raw && raw.slug, 80).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    const name = str(raw && raw.name, 120);
    const icon = str(raw && raw.icon, 60) || "Package";
    if (!slug || !name) continue;

    const result = await query(
      `INSERT INTO listing_categories (slug, name, icon) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon
       RETURNING id, slug, name, icon`,
      [slug, name, icon]
    );
    saved.push(result.rows[0]);
  }

  await log(req, "categories.put", { count: saved.length });
  res.json({ categories: saved });
}));

router.delete("/categories/:slug", handle(async (req, res) => {
  const slug = str(req.params.slug, 80);
  const result = await query(
    `DELETE FROM listing_categories WHERE slug=$1 RETURNING id, slug`,
    [slug]
  );
  if (!result.rowCount) return invalid(res, { slug: "No category with that slug" });

  await log(req, "categories.delete", { slug });
  res.json({ removed: result.rows[0] });
}));

/* --------------------------------- data ---------------------------------- */

router.post("/data/purge", handle(async (req, res) => {
  const body = req.body || {};
  const targets = Array.isArray(body.targets) ? body.targets.map(t => str(t, 30)) : [];
  const unknown = targets.filter(t => !PURGE_TARGETS[t]);
  if (!targets.length || unknown.length) {
    return invalid(res, {
      targets: unknown.length
        ? `Unknown target: ${unknown.join(", ")}. Allowed: ${Object.keys(PURGE_TARGETS).join(", ")}`
        : "Pick at least one target",
    });
  }
  if (str(body.confirm, 20).toUpperCase() !== "PURGE") {
    return invalid(res, { confirm: 'Type confirm:"PURGE" to wipe this content' });
  }

  const removed = {};
  for (const target of targets) {
    // Every name here comes from PURGE_TARGETS, never from the request.
    for (const table of PURGE_TARGETS[target]) {
      const result = await query(`DELETE FROM ${table}`);
      removed[table] = (removed[table] || 0) + result.rowCount;
    }
  }

  await log(req, "data.purge", { targets, removed });
  res.json({ targets, removed });
}));

/* ------------------------------- migrations ------------------------------ */

/**
 * Applies one SQL file that already ships inside the app's migrations folder.
 * The name is allowlisted by pattern and re-checked against the directory, so
 * this can never read or execute an attacker-supplied path or statement.
 */
router.post("/migrations/run", handle(async (req, res) => {
  const file = str(req.body && req.body.file, 120);
  if (!MIGRATION_NAME.test(file)) {
    return invalid(res, { file: "Must look like 009_some_name.sql" });
  }

  const entry = migrations.find(m => m.name === file);
  if (!entry) {
    return invalid(res, { file: "That migration is not part of the deployed app" });
  }

  const already = await query(`SELECT 1 FROM ops_migrations WHERE file=$1`, [file]);
  if (already.rowCount) return invalid(res, { file: "Already applied" });

  const sql = entry.sql;
  // The console owns the transaction so a failure rolls the whole file back;
  // a migration's own BEGIN/COMMIT markers would end it early.
  const body = sql.replace(/^\s*(BEGIN|COMMIT)\s*;\s*$/gim, "");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(body);
    await client.query(
      `INSERT INTO ops_migrations (file, applied_by) VALUES ($1, $2)
       ON CONFLICT (file) DO NOTHING`,
      [file, Number(req.user.sub)]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await log(req, "migrations.run", { file, bytes: sql.length });
  res.json({ applied: file, migrations: await migrationState() });
}));

router.get("/migrations", handle(async (req, res) => {
  res.json({ migrations: await migrationState(), directory: MIGRATIONS_DIR });
}));

module.exports = router;
