const express = require("express");
const { query } = require("../../db");
const kit = require("../../services/spaKit");
const dto = require("../../services/spaDto");

/* -------------------------------------------------------------------------- *
 *  Support tickets, mounted at /api ahead of the spa/platform catch-all.
 *
 *  The client (src/services/api.ts supportApi) has always called these paths;
 *  this file is the router that finally answers them.  Report flows from the
 *  messages, profile and business pages reuse POST /support/tickets too.
 *
 *  Convention for support_messages.from_user — 1 = the visitor (the ticket
 *  owner), 0 = the support team; dto.toTicket surfaces it as fromUser.  A staff
 *  reply therefore writes 0, an owner reply writes 1, and the page's polling
 *  picks the team's answer up as a new message.
 * -------------------------------------------------------------------------- */

const router = express.Router();

const { handle, invalid, missing, toId, uid, str, isStaff } = kit;

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

function ticketBody(req) {
  const subject = str(req.body.subject, 200).trim();
  const category = str(req.body.category, 40).trim() || "general";
  const text = str(req.body.text, 4000).trim();
  const attachmentUrl = req.body.attachmentUrl ? str(req.body.attachmentUrl, 500) : null;
  return { subject, category, text, attachmentUrl };
}

async function ticketWithMessages(id) {
  const ticket = await query(
    `SELECT id, subject, category, status, created_at, updated_at
       FROM support_tickets WHERE id = $1`,
    [id]
  );
  if (!ticket.rowCount) return null;
  const messages = await query(
    `SELECT id, from_user, body, attachment_url, created_at
       FROM support_messages WHERE ticket_id = $1
      ORDER BY created_at ASC, id ASC`,
    [id]
  );
  return dto.toTicket(ticket.rows[0], messages.rows);
}

router.get("/support/tickets", handle(async (req, res) => {
  const tickets = await query(
    `SELECT id, subject, category, status, created_at, updated_at
       FROM support_tickets WHERE user_id = $1
      ORDER BY updated_at DESC, id DESC`,
    [uid(req)]
  );
  if (!tickets.rowCount) return res.json([]);
  const ids = tickets.rows.map(row => dto.num(row.id));
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
  const messages = await query(
    `SELECT id, ticket_id, from_user, body, attachment_url, created_at
       FROM support_messages WHERE ticket_id IN (${placeholders})
      ORDER BY created_at ASC, id ASC`,
    ids
  );
  const grouped = new Map();
  for (const message of messages.rows) {
    const key = dto.num(message.ticket_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(message);
  }
  res.json(tickets.rows.map(row => dto.toTicket(row, grouped.get(dto.num(row.id)) || [])));
}));

router.post("/support/tickets", handle(async (req, res) => {
  const { subject, category, text, attachmentUrl } = ticketBody(req);
  const fields = {};
  if (!subject) fields.subject = "Add a short subject";
  if (!text) fields.text = "Describe what you need help with";
  if (Object.keys(fields).length) return invalid(res, fields);

  const me = uid(req);
  const created = await query(
    `INSERT INTO support_tickets (user_id, subject, category, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'open', ${NOW}, ${NOW}) RETURNING id`,
    [me, subject, category]
  );
  const ticketId = dto.num(created.rows[0].id);
  await query(
    `INSERT INTO support_messages (ticket_id, from_user, body, attachment_url)
     VALUES ($1, 1, $2, $3)`,
    [ticketId, text, attachmentUrl]
  );
  res.status(201).json(await ticketWithMessages(ticketId));
}));

router.get("/support/tickets/:id", handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return invalid(res, { id: "Expected a numeric ticket id" });
  const who = await query(`SELECT user_id FROM support_tickets WHERE id = $1`, [id]);
  if (!who.rowCount || (!isStaff(req) && dto.num(who.rows[0].user_id) !== uid(req))) return missing(res, "Ticket");
  res.json(await ticketWithMessages(id));
}));

/** Owner replies land as from_user=1; a staff reply lands as 0 — the team's voice. */
router.post("/support/tickets/:id/reply", handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return invalid(res, { id: "Expected a numeric ticket id" });
  const text = str(req.body.text, 4000).trim();
  if (!text) return invalid(res, { text: "Write a message first" });
  const attachmentUrl = req.body.attachmentUrl ? str(req.body.attachmentUrl, 500) : null;

  const who = await query(`SELECT user_id, status FROM support_tickets WHERE id = $1`, [id]);
  const staff = isStaff(req);
  if (!who.rowCount || (!staff && dto.num(who.rows[0].user_id) !== uid(req))) return missing(res, "Ticket");

  await query(
    `INSERT INTO support_messages (ticket_id, from_user, body, attachment_url) VALUES ($1, $2, $3, $4)`,
    [id, staff ? 0 : 1, text, attachmentUrl]
  );
  const current = dto.text(who.rows[0].status);
  const status = staff ? "pending" : current === "resolved" ? "open" : current;
  await query(`UPDATE support_tickets SET updated_at = ${NOW}, status = $2 WHERE id = $1`, [id, status]);
  res.json(await ticketWithMessages(id));
}));

/* No agents table exists; this is the honest static answer the widget renders.
   Change it here, one place, when staffing becomes data. */
router.get("/support/availability", handle(async (req, res) => {
  res.json({
    online: true,
    hours: "Mon–Fri, 09:00–18:00 UTC",
    avgResponse: "under 4 hours",
    agents: [
      { name: "Support Team", avatarUrl: "", role: "Member support" },
      { name: "Trust & Safety", avatarUrl: "", role: "Reports and accounts" },
    ],
  });
}));

module.exports = router;
