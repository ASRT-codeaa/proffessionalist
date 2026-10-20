const express = require("../../_shim/express.js");
const bcrypt = require("bcryptjs");
const { query } = require("../../db");
const mailer = require("../../services/mailer");
const dto = require("../../services/spaDto");
const kit = require("../../services/spaKit");
const { uploadImage, publicUrl, mediaType } = require("../../middleware/upload");

const router = express.Router();

const {
  handle, builder, invalid, missing, forbidden, toId, toUuid, uid, str, num, paging,
  likeValue, isStoredMedia, isStaff, notify,
} = kit;

const PRIORITIES = ["low", "medium", "high"];
const TASK_STATUS = ["todo", "in_progress", "done"];

/* -------------------------------------------------------------------------- */
/*                                   messages                                  */
/* -------------------------------------------------------------------------- */

/** Both members of a direct conversation, with the viewer first. */
async function members(conversationId, viewer) {
  const rows = await query(
    `SELECT cm.user_id::int AS user_id, cm.last_read_at
       FROM conversation_members cm
      WHERE cm.conversation_id = $1`,
    [conversationId]
  );
  if (!rows.rows.some(r => r.user_id === viewer) && !isStaff({ user: { sub: viewer } })) return null;
  const mine = rows.rows.find(r => r.user_id === viewer);
  const peer = rows.rows.find(r => r.user_id !== viewer);
  return { mine: mine || { user_id: viewer, last_read_at: null }, peer: peer || null, all: rows.rows };
}

// Postgres only substitutes an output alias into ORDER BY when the whole
// expression is that bare alias, so the ordering repeats the subquery.
const LAST_MESSAGE_AT = `(SELECT msg.created_at FROM messages msg
           WHERE msg.conversation_id = c.id AND msg.deleted_at IS NULL
           ORDER BY msg.created_at DESC LIMIT 1)`;

const CONVERSATION_SELECT = `
  SELECT c.id::text AS id,
         COALESCE(c.subject, '') AS subject,
         c.created_at,
         peer.user_id AS peer_id,
         (SELECT msg.body FROM messages msg
           WHERE msg.conversation_id = c.id AND msg.deleted_at IS NULL
           ORDER BY msg.created_at DESC LIMIT 1) AS last_message,
         ${LAST_MESSAGE_AT} AS last_message_at,
         (SELECT COUNT(*)::int FROM messages msg
           WHERE msg.conversation_id = c.id AND msg.deleted_at IS NULL
             AND msg.sender_id = peer.user_id
             AND msg.created_at > COALESCE(mine.last_read_at, 'epoch'::timestamptz)) AS unread_count
    FROM conversations c
    JOIN conversation_members mine ON mine.conversation_id = c.id AND mine.user_id = $1
    JOIN conversation_members peer ON peer.conversation_id = c.id AND peer.user_id <> $1`;

router.get("/messages/conversations", handle(async (req, res) => {
  const me = uid(req);
  const like = likeValue(str(req.query.q, 100));

  const rows = await query(
    `${CONVERSATION_SELECT}
      JOIN users peer_user ON peer_user.id = peer.user_id
      WHERE c.kind = 'direct'
        AND ($2 = '' OR LOWER(COALESCE(c.subject, '')) LIKE $2
             OR LOWER(COALESCE(peer_user.name, '')) LIKE $2
             OR LOWER(COALESCE(peer_user.username, '')) LIKE $2)
      ORDER BY COALESCE(${LAST_MESSAGE_AT}, c.created_at) DESC
      LIMIT 60`,
    [me, like]
  ).then(r => r.rows);

  const people = await dto.loadPeople(rows.map(r => r.peer_id), me);
  res.json(rows.map(r => dto.toConversation(r, people, me)));
}));

async function loadConversation(conversationId, viewer) {
  const rows = await query(
    `${CONVERSATION_SELECT} WHERE c.id = $2 LIMIT 1`,
    [viewer, conversationId]
  );
  if (!rows.rowCount) return null;
  const people = await dto.loadPeople([rows.rows[0].peer_id], viewer);
  return { row: rows.rows[0], dtoValue: dto.toConversation(rows.rows[0], people, viewer) };
}

router.post("/messages/conversations", handle(async (req, res) => {
  const me = uid(req);
  const target = toId((req.body || {}).userId, "userId");
  if (target === me) return invalid(res, { userId: "Choose someone else to message" });

  const account = await query(`SELECT id::int AS id FROM users WHERE id = $1 AND status = 'active'`, [target]);
  if (!account.rowCount) return missing(res, "Person");

  const existing = await query(
    `SELECT c.id::text AS id
       FROM conversations c
       JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = $1
       JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = $2
      WHERE c.kind = 'direct'
      LIMIT 1`,
    [me, target]
  );

  const first = str((req.body || {}).firstMessage, 4000);

  if (existing.rowCount) {
    const conversationId = existing.rows[0].id;
    if (first) await sendMessage(conversationId, me, { text: first });
    const loaded = await loadConversation(conversationId, me);
    return res.json(loaded.dtoValue);
  }

  const created = await query(
    `INSERT INTO conversations (kind) VALUES ('direct') RETURNING id::text AS id`
  );
  const conversationId = created.rows[0].id;
  await query(
    `INSERT INTO conversation_members (conversation_id, user_id, last_read_at)
     SELECT $1, u.id, NOW() FROM unnest($2::bigint[]) AS u(id)
     ON CONFLICT (conversation_id, user_id) DO NOTHING`,
    [conversationId, [me, target]]
  );
  if (first) await sendMessage(conversationId, me, { text: first });

  const loaded = await loadConversation(conversationId, me);
  res.status(201).json(loaded.dtoValue);
}));

async function sendMessage(conversationId, senderId, payload) {
  const text = str(payload.text, 4000);
  const mediaUrl = str(payload.mediaUrl, 500);
  const attachmentName = str(payload.attachmentName, 200);
  const sharedListing = payload.sharedListingId ? toId(payload.sharedListingId, "sharedListingId") : null;
  const sharedProfile = payload.sharedProfileUserId ? toId(payload.sharedProfileUserId, "sharedProfileUserId") : null;

  if (!text && !mediaUrl && !sharedListing && !sharedProfile) {
    throw new kit.HttpError(400, "Write a message or attach something first", { text: "Write a message first" });
  }

  const created = await query(
    `INSERT INTO messages
       (conversation_id, sender_id, body, attachment_url, attachment_name, shared_listing_id, shared_profile_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id::int AS id, conversation_id::text AS conversation_id, sender_id::int AS sender_id,
               body, attachment_url, attachment_name, reaction, created_at`,
    [conversationId, senderId, text || " ", mediaUrl || null, attachmentName || null, sharedListing, sharedProfile]
  );

  await query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversationId]);
  await query(
    `UPDATE conversation_members SET last_read_at = NOW()
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, senderId]
  );

  const peer = await query(
    `SELECT user_id::int AS user_id FROM conversation_members
      WHERE conversation_id = $1 AND user_id <> $2`,
    [conversationId, senderId]
  );
  for (const row of peer.rows) {
    await notify({
      userId: row.user_id, actorId: senderId, type: "message",
      title: "You have a new message", body: (text || attachmentName || "Shared an item").slice(0, 140),
      // entity_id is BIGINT and a conversation is keyed by UUID, so the thread is
      // only carried in the href.
      entityType: "conversation", entityId: null, href: `/messages/${conversationId}`,
    });
  }

  return created.rows[0];
}

/** Shared listing / profile cards are resolved into the SPA's nested DTOs. */
async function hydrateMessages(rows, viewer) {
  if (!rows.length) return [];
  const listingIds = [...new Set(rows.map(r => r.shared_listing_id).filter(Boolean))];
  const profileIds = [...new Set(rows.map(r => r.shared_profile_id).filter(Boolean))];

  const [sellers, businesses, listed, people] = await Promise.all([
    dto.loadPeople([...rows.map(r => r.sender_id), ...profileIds], viewer),
    Promise.resolve(new Map()),
    listingIds.length
      ? query(
          `SELECT ${dto.LISTING_COLUMNS} FROM marketplace_listings m ${dto.listingJoins("$1")} WHERE m.id = ANY($2::bigint[])`,
          [viewer, listingIds]
        ).then(r => r.rows)
      : [],
    dto.loadPeople(profileIds, viewer),
  ]);

  const listingMap = new Map();
  for (const row of listed) {
    const [listing] = await kit.businessesFor([row], viewer).then(map =>
      [dto.toListing(row, sellers, map)]
    );
    listingMap.set(listing.id, listing);
  }

  return rows.map(r => {
    const message = dto.toMessage(r, viewer);
    message.sharedListing = r.shared_listing_id ? listingMap.get(num(r.shared_listing_id)) || undefined : undefined;
    message.sharedProfile = r.shared_profile_id ? dto.personFrom(people, r.shared_profile_id) : undefined;
    return message;
  });
}

router.get("/messages/conversations/:id", handle(async (req, res) => {
  const me = uid(req);
  const conversationId = toUuid(req.params.id);
  const { pageSize } = paging(req, 30);
  const before = req.query.before === undefined ? null : Number(req.query.before);

  const room = await loadConversation(conversationId, me);
  if (!room) return missing(res, "Conversation");

  const peerRead = room.row.peer_id
    ? await query(
        `SELECT last_read_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, room.row.peer_id]
      ).then(r => r.rows[0] && r.rows[0].last_read_at)
    : null;

  const rows = await query(
    `SELECT m.id::int AS id, m.conversation_id::text AS conversation_id, m.sender_id::int AS sender_id,
            m.body, m.attachment_url, m.attachment_name, COALESCE(m.reaction, '') AS reaction,
            m.shared_listing_id::int AS shared_listing_id, m.shared_profile_id::int AS shared_profile_id,
            (m.sender_id = $4 OR m.created_at <= $5::timestamptz) AS read,
            m.created_at
       FROM messages m
      WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
        AND ($3::bigint IS NULL OR m.id < $3)
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $2`,
    [conversationId, pageSize + 1, Number.isSafeInteger(before) ? before : null, me, peerRead || "epoch"]
  );

  const items = (await hydrateMessages(rows.rows, me)).reverse();
  res.json({ items, hasMore: rows.rows.length > pageSize });
}));

router.post("/messages/conversations/:id/messages", handle(async (req, res) => {
  const me = uid(req);
  const conversationId = toUuid(req.params.id);
  const room = await loadConversation(conversationId, me);
  if (!room) return missing(res, "Conversation");

  const row = await sendMessage(conversationId, me, req.body || {});
  const [message] = await hydrateMessages([Object.assign(row, {
    shared_listing_id: (req.body || {}).sharedListingId || null,
    shared_profile_id: (req.body || {}).sharedProfileUserId || null,
    reaction: "",
    read: true,
  })], me);
  res.status(201).json(message);
}));

router.post("/messages/conversations/:id/read", handle(async (req, res) => {
  const me = uid(req);
  const conversationId = toUuid(req.params.id);
  const updated = await query(
    `UPDATE conversation_members SET last_read_at = NOW()
      WHERE conversation_id = $1 AND user_id = $2 RETURNING user_id`,
    [conversationId, me]
  );
  if (!updated.rowCount) return missing(res, "Conversation");
  res.json({ ok: true });
}));

router.post("/messages/messages/:id/reaction", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const reaction = str((req.body || {}).reaction, 20);

  const room = await query(
    `SELECT 1 FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
      WHERE m.id = $1 AND m.deleted_at IS NULL`,
    [id, me]
  );
  if (!room.rowCount) return missing(res, "Message");

  await query(`UPDATE messages SET reaction = NULL WHERE id = $1`, [id]);
  if (reaction) await query(`UPDATE messages SET reaction = $1 WHERE id = $2`, [reaction, id]);
  res.json({ reaction });
}));

router.delete("/messages/messages/:id", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const removed = isStaff(req)
    ? await query(`UPDATE messages SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id])
    : await query(
        `UPDATE messages SET deleted_at = NOW()
          WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL RETURNING id`,
        [id, me]
      );
  if (!removed.rowCount) return missing(res, "Message");
  res.json({ ok: true });
}));

router.get("/messages/search", handle(async (req, res) => {
  const me = uid(req);
  const q = str(req.query.q, 100);
  if (!q) return res.json({ messages: [] });

  const rows = await query(
    `SELECT m.id::int AS id, m.conversation_id::text AS conversation_id, m.sender_id::int AS sender_id,
            m.body, m.attachment_url, m.attachment_name, COALESCE(m.reaction, '') AS reaction,
            m.created_at,
            peer.user_id AS peer_id,
            COALESCE(c.subject, '') AS subject, c.created_at AS conversation_created_at
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN conversation_members mine ON mine.conversation_id = c.id AND mine.user_id = $1
       JOIN conversation_members peer ON peer.conversation_id = c.id AND peer.user_id <> $1
      WHERE m.deleted_at IS NULL AND LOWER(m.body) LIKE $2
      ORDER BY m.created_at DESC LIMIT 40`,
    [me, likeValue(q)]
  );

  const people = await dto.loadPeople(rows.rows.map(r => r.peer_id), me);
  const messages = await hydrateMessages(rows.rows, me);
  res.json({
    messages: messages.map((message, i) => {
      const row = rows.rows[i];
      return {
        ...message,
        conversation: dto.toConversation({
          id: message.conversationId,
          subject: row.subject,
          peer_id: row.peer_id,
          last_message: message.text,
          last_message_at: row.created_at,
          conversation_created_at: row.conversation_created_at,
          unread_count: 0,
        }, people, me),
      };
    }),
  });
}));

router.post("/messages/upload", uploadImage("message", "file"), handle(async (req, res) => {
  if (!req.file) return invalid(res, { file: "Choose a file to attach" });
  res.json({
    url: publicUrl("message", req.file.filename),
    name: str(req.file.originalname || "attachment", 200),
    type: mediaType(req.file.mimetype) === "image" ? "image" : "document",
  });
}));

/* -------------------------------------------------------------------------- */
/*                                    tasks                                    */
/* -------------------------------------------------------------------------- */

const TASK_SELECT = `
  SELECT t.id::int AS id, t.title, t.description, t.due_date, t.priority, t.category,
         t.status, t.completed_at, t.created_at, t.assignee_id::int AS assignee_id`;

router.get("/tasks", handle(async (req, res) => {
  const me = uid(req);
  const view = str(req.query.view, 20);

  const b = builder([me]);
  const where = [`t.user_id = $1`];
  if (view === "today") where.push(`(t.due_date IS NULL OR t.due_date::date = CURRENT_DATE) AND t.status <> 'done'`);
  if (view === "upcoming") where.push(`t.due_date::date > CURRENT_DATE AND t.status <> 'done'`);
  if (view === "overdue") where.push(`t.due_date < NOW() AND t.status <> 'done'`);
  if (view === "completed") where.push(`t.status = 'done'`);
  const clause = where.join(" AND ");

  const rows = await query(
    `${TASK_SELECT} FROM user_tasks t
      WHERE ${clause}
      ORDER BY (t.status = 'done'), COALESCE(t.due_date, 'infinity'::timestamptz), t.id DESC
      LIMIT 200`,
    b.params
  );
  const people = await dto.loadPeople(rows.rows.map(r => r.assignee_id).filter(Boolean), me);
  res.json(rows.rows.map(r => dto.toTask(r, people)));
}));

function taskInput(body, existing) {
  // A PATCH may send only the field it changes, so an absent title falls back to
  // the stored one instead of failing validation.
  const title = str(body.title, 220) || (existing ? str(existing.title, 220) : "");
  if (!title) throw new kit.HttpError(400, "Give the task a title", { title: "Title is required" });
  const due = body.dueDate === undefined ? (existing ? existing.due_date : null)
    : body.dueDate ? new Date(body.dueDate).toISOString() : null;
  const dueDate = due && Number.isNaN(new Date(due).getTime()) ? null : due;
  const status = body.status === undefined && existing ? existing.status
    : TASK_STATUS.includes(body.status) ? body.status : (existing ? existing.status : "todo");
  return {
    title,
    description: body.description === undefined ? (existing ? existing.description : "") : str(body.description, 2000),
    dueDate,
    priority: PRIORITIES.includes(body.priority) ? body.priority : (existing ? existing.priority : "medium"),
    category: body.category === undefined ? (existing ? existing.category : "") : str(body.category, 80),
    status,
    assigneeId: body.assigneeId ? toId(body.assigneeId, "assigneeId") : (existing ? existing.assignee_id : null),
  };
}

router.post("/tasks", handle(async (req, res) => {
  const me = uid(req);
  const task = taskInput(req.body || {});
  const inserted = await query(
    `INSERT INTO user_tasks (user_id, title, description, due_date, priority, category, status, assignee_id, completed_at)
     VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7,$8,$9) RETURNING id::int AS id`,
    [me, task.title, task.description || null, task.dueDate, task.priority, task.category || null,
      task.status, task.assigneeId, task.status === "done" ? new Date().toISOString() : null]
  );

  const rows = await query(`${TASK_SELECT} FROM user_tasks t WHERE t.id = $1`, [inserted.rows[0].id]);
  const people = await dto.loadPeople([task.assigneeId].filter(Boolean), me);
  res.status(201).json(dto.toTask(rows.rows[0], people));
}));

router.patch("/tasks/:id", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const before = await query(
    `${TASK_SELECT}, t.user_id::int AS owner FROM user_tasks t WHERE t.id = $1 AND t.user_id = $2`,
    [id, me]
  );
  if (!before.rowCount) return missing(res, "Task");

  const task = taskInput(req.body || {}, before.rows[0]);
  const completedAt = task.status === "done"
    ? (before.rows[0].completed_at ? before.rows[0].completed_at.toISOString() : new Date().toISOString())
    : null;

  await query(
    `UPDATE user_tasks SET title=$2, description=$3, due_date=$4::timestamptz, priority=$5,
            category=$6, status=$7, assignee_id=$8, completed_at=$9::timestamptz
      WHERE id = $1`,
    [id, task.title, task.description || null, task.dueDate, task.priority, task.category || null,
      task.status, task.assigneeId, completedAt]
  );

  const rows = await query(`${TASK_SELECT} FROM user_tasks t WHERE t.id = $1`, [id]);
  const people = await dto.loadPeople([task.assigneeId].filter(Boolean), me);
  res.json(dto.toTask(rows.rows[0], people));
}));

router.post("/tasks/:id/toggle", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const updated = await query(
    `UPDATE user_tasks SET
        status = CASE WHEN status = 'done' THEN 'todo' ELSE 'done' END,
        completed_at = CASE WHEN status = 'done' THEN NULL ELSE NOW() END
      WHERE id = $1 AND user_id = $2
      RETURNING status, completed_at`,
    [id, me]
  );
  if (!updated.rowCount) return missing(res, "Task");
  res.json({
    status: updated.rows[0].status,
    completedAt: dto.iso(updated.rows[0].completed_at),
  });
}));

router.delete("/tasks/:id", handle(async (req, res) => {
  const removed = await query(`DELETE FROM user_tasks WHERE id = $1 AND user_id = $2 RETURNING id`,
    [toId(req.params.id), uid(req)]);
  if (!removed.rowCount) return missing(res, "Task");
  res.json({ ok: true });
}));

/* -------------------------------------------------------------------------- */
/*                                   settings                                  */
/* -------------------------------------------------------------------------- */

const SETTING_DEFAULTS = {
  theme: "light",
  language: "English",
  contentPreferences: [],
  messagePermission: "everyone",
  connectionPermission: "everyone",
  activityVisible: true,
  pushNotifications: true,
  emailNotifications: true,
  notifyMessages: true,
  notifyMarketplace: true,
  notifyNetwork: true,
  twoFactorEnabled: false,
};

const SETTING_KEYS = Object.keys(SETTING_DEFAULTS);

router.get("/settings", handle(async (req, res) => {
  const me = uid(req);
  const [account, stored, sessions, logins] = await Promise.all([
    query(`SELECT username, email FROM users WHERE id = $1`, [me]),
    query(`SELECT data FROM user_settings WHERE user_id = $1`, [me]),
    query(
      `SELECT id::text AS id, COALESCE(user_agent, 'Unknown device') AS device,
              COALESCE(ip_address::text, 'Unknown location') AS location,
              last_seen_at
         FROM auth_sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
        ORDER BY last_seen_at DESC LIMIT 20`,
      [me]
    ),
    query(
      `SELECT id::text AS id, event_type, ip_address::text AS ip, COALESCE(user_agent, '') AS device, created_at
         FROM security_events
        WHERE user_id = $1 AND event_type IN ('login_success','login_failed')
        ORDER BY created_at DESC LIMIT 20`,
      [me]
    ),
  ]);

  const a = account.rows[0] || {};
  const profile = await query(`SELECT phone, location, visibility FROM profiles WHERE user_id = $1`, [me]);
  const p = profile.rows[0] || {};
  const data = stored.rows[0] && stored.rows[0].data ? stored.rows[0].data : {};

  res.json(Object.assign({}, SETTING_DEFAULTS, pick(data), {
    email: a.email || "",
    username: a.username || "",
    phone: p.phone || "",
    location: p.location || "",
    visibility: ["public", "connections", "private"].includes(p.visibility) ? p.visibility : "public",
    sessions: sessions.rows.map(s => ({
      id: s.id,
      device: s.device.slice(0, 60),
      location: s.location,
      lastActive: dto.iso(s.last_seen_at),
      current: s.id === String(req.user.sessionId),
    })),
    loginHistory: logins.rows.map(l => ({
      id: l.id,
      time: dto.iso(l.created_at),
      ip: l.ip || "",
      device: l.device.slice(0, 60),
      success: l.event_type === "login_success",
    })),
  }));
}));

function pick(data) {
  const out = {};
  for (const key of SETTING_KEYS) if (data[key] !== undefined) out[key] = data[key];
  return out;
}

router.patch("/settings", handle(async (req, res) => {
  const me = uid(req);
  const body = req.body || {};

  const updates = {};
  for (const key of SETTING_KEYS) {
    if (body[key] === undefined) continue;
    if (key === "theme" && !["light", "dark", "system"].includes(body[key])) continue;
    if (key === "twoFactorEnabled") continue;
    updates[key] = key === "contentPreferences" ? (Array.isArray(body[key]) ? body[key].map(v => str(v, 60)) : []) : body[key];
  }

  if (Object.keys(updates).length) {
    await query(
      `INSERT INTO user_settings (user_id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET data = user_settings.data || EXCLUDED.data, updated_at = NOW()`,
      [me, JSON.stringify(updates)]
    );
  }

  if (body.visibility && ["public", "connections", "private"].includes(body.visibility)) {
    await query(`UPDATE profiles SET visibility = $1, updated_at = NOW() WHERE user_id = $2`, [body.visibility, me]);
  }
  if (body.phone !== undefined) {
    await query(`UPDATE profiles SET phone = $1, updated_at = NOW() WHERE user_id = $2`, [str(body.phone, 40) || null, me]);
  }
  if (body.language !== undefined && body.email === undefined) {
    // language only lives in the settings blob; nothing else to write here.
  }

  const fresh = await query(`SELECT data FROM user_settings WHERE user_id = $1`, [me]);
  const account = await query(
    `SELECT u.username, u.email, p.phone, p.location, p.visibility
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`,
    [me]
  );
  const a = account.rows[0] || {};

  res.json(Object.assign({}, SETTING_DEFAULTS, pick(fresh.rows[0] ? fresh.rows[0].data : {}), {
    email: a.email || "",
    username: a.username || "",
    phone: a.phone || "",
    location: a.location || "",
    visibility: a.visibility || "public",
    sessions: [],
    loginHistory: [],
  }));
}));

router.post("/settings/password", handle(async (req, res) => {
  const me = uid(req);
  const body = req.body || {};
  const next = String(body.next || "");
  if (next.length < 8) return invalid(res, { next: "Use at least 8 characters" });

  const account = await query(`SELECT password_hash, email, name FROM users WHERE id = $1`, [me]);
  if (!account.rowCount) return missing(res, "Account");

  const ok = await bcrypt.compare(String(body.current || ""), account.rows[0].password_hash);
  if (!ok) return invalid(res, { current: "Your current password is not correct" }, "Current password is incorrect");

  await query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [await bcrypt.hash(next, 12), me]);
  await query(
    `UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = $1 AND id <> $2`,
    [me, req.user.sessionId]
  );
  mailer.send("password-changed", {
    to: account.rows[0].email,
    name: account.rows[0].name,
    params: {},
    idempotencyKey: `password-changed:${me}:${Date.now()}`,
  });
  await kit.ensureProfile(me);
  res.json({ ok: true });
}));

router.delete("/settings/sessions/:id", handle(async (req, res) => {
  const me = uid(req);
  const id = toUuid(req.params.id, "sessionId");
  if (id === req.user.sessionId) return invalid(res, { sessionId: "Sign out to end this session" });
  const revoked = await query(
    `UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, me]
  );
  if (!revoked.rowCount) return missing(res, "Session");
  res.json({ ok: true });
}));

module.exports = router;
