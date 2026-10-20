const express = require("../../_shim/express.js");
const { query } = require("../../db");
const kit = require("../../services/spaKit");

/* -------------------------------------------------------------------------- *
 *  Safety reads/writes, mounted at /api ahead of the spa/platform catch-all.
 *
 *  Mutes are this feature's only new concept: one viewer silencing one creator,
 *  read by GET /api/mutes and honoured as an exclusion in GET /posts/feed and the
 *  videos ranking (app-new/routes/spa/feed.js, app-new/services/videoKit.js).  They
 *  differ from blocks on purpose — a mute changes no relationship and is invisible
 *  to the muted author — so the two lists live side by side here rather than merged.
 *
 *  The BLOCK WRITE already exists on the platform router (POST/DELETE /api/blocks/:userId,
 *  which also tears down follows and connections); this file adds only the missing READ
 *  (GET /api/blocks) so the Settings surface can offer an Unblock button.  Do not add
 *  POST/DELETE /blocks here: platform.js:907/:948 owns the write path.
 * -------------------------------------------------------------------------- */

const router = express.Router();

const { handle, invalid, missing, toId, uid, str, num } = kit;

const personRow = row => ({
  id: num(row.id),
  username: str(row.username, 60),
  name: str(row.name, 120),
  avatarUrl: str(row.avatar_url, 500),
});

router.get("/mutes", handle(async (req, res) => {
  const rows = await query(
    `SELECT u.id::int AS id, u.username, COALESCE(u.name, u.username) AS name,
            COALESCE(pr.avatar_url, '') AS avatar_url
       FROM mutes mu
       JOIN users u ON u.id = mu.muted_id
       LEFT JOIN profiles pr ON pr.user_id = u.id
      WHERE mu.user_id = $1
      ORDER BY mu.created_at DESC, mu.muted_id DESC`,
    [uid(req)]
  );
  res.json({ items: rows.rows.map(personRow) });
}));

/** Mute is idempotent by design: a repeat POST answers the same as the first. */
router.post("/mutes/:userId", handle(async (req, res) => {
  const me = uid(req);
  const target = toId(req.params.userId);
  if (!target || target === me) return invalid(res, { userId: "Choose a creator other than yourself" });
  const who = await query(`SELECT id FROM users WHERE id = $1`, [target]);
  if (!who.rowCount) return missing(res, "User");
  await query(
    `INSERT INTO mutes (user_id, muted_id) VALUES ($1,$2) ON CONFLICT (user_id, muted_id) DO NOTHING`,
    [me, target]
  );
  res.status(201).json({ muted: true, userId: target });
}));

router.delete("/mutes/:userId", handle(async (req, res) => {
  const target = toId(req.params.userId);
  if (!target) return invalid(res, { userId: "Expected a numeric user id" });
  await query(`DELETE FROM mutes WHERE user_id = $1 AND muted_id = $2`, [uid(req), target]);
  res.json({ muted: false, userId: target });
}));

/** Read-only companion to platform.js's writes; a one-way view (whom I blocked). */
router.get("/blocks", handle(async (req, res) => {
  const rows = await query(
    `SELECT u.id::int AS id, u.username, COALESCE(u.name, u.username) AS name,
            COALESCE(pr.avatar_url, '') AS avatar_url
       FROM blocks bl
       JOIN users u ON u.id = bl.blocked_id
       LEFT JOIN profiles pr ON pr.user_id = u.id
      WHERE bl.blocker_id = $1
      ORDER BY bl.created_at DESC, bl.blocked_id DESC`,
    [uid(req)]
  );
  res.json({ items: rows.rows.map(personRow) });
}));

module.exports = router;
