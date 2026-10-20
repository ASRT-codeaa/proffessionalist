const express = require("../../_shim/express.js");
const { query } = require("../../db");
const kit = require("../../services/spaKit");
const dto = require("../../services/spaDto");

/* -------------------------------------------------------------------------- *
 *  AI assistant, mounted at /api ahead of the spa/platform catch-all.
 *
 *  POST /api/ai/messages answers in the exact shape src/services/api.ts aiApi
 *  expects: {conversationId, reply:{id, role, text, createdAt}}.
 *
 *  Replies come from an OpenAI-compatible chat-completions endpoint through the
 *  Worker's global fetch.  The operator's uploaded key is DeepSeek, so the
 *  defaults below point at api.deepseek.com; AI_API_BASE / AI_MODEL (plain
 *  vars) and AI_API_TOKEN (secret) override them.  While no token is set — or
 *  the provider errors or times out — the conversation still works: a fixed
 *  fallback assistant message is persisted and a 200 is returned, so the thread
 *  stays continuous and the page never shows a send failure for a service
 *  problem the user cannot fix.
 * -------------------------------------------------------------------------- */

const router = express.Router();

const { handle, invalid, missing, toId, uid, str } = kit;

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const FALLBACK_REPLY = "The AI service is unavailable right now — try again in a bit.";
const SYSTEM_PROMPT = "You are the AI assistant inside Professionalist, a professional networking app. Be brief, practical and professional.";
const HISTORY_WINDOW = 20;
const PROVIDER_TIMEOUT_MS = 20000;

function conversationWithMessages(id) {
  return fetchConversation(id, true);
}

async function fetchConversation(id, withMessages) {
  const row = await query(
    `SELECT id, title, created_at, updated_at FROM ai_conversations WHERE id = $1`,
    [id]
  );
  if (!row.rowCount) return null;
  const messages = withMessages
    ? (await query(
      `SELECT id, role, body, created_at FROM ai_messages WHERE conversation_id = $1
        ORDER BY created_at ASC, id ASC`,
      [id]
    )).rows
    : [];
  return dto.toAiConversation(row.rows[0], messages);
}

router.get("/ai/conversations", handle(async (req, res) => {
  const rows = await query(
    `SELECT id, title, created_at, updated_at FROM ai_conversations
      WHERE user_id = $1 ORDER BY updated_at DESC, id DESC`,
    [uid(req)]
  );
  if (!rows.rowCount) return res.json([]);
  const ids = rows.rows.map(row => dto.num(row.id));
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
  const messages = await query(
    `SELECT id, conversation_id, role, body, created_at FROM ai_messages
      WHERE conversation_id IN (${placeholders})
      ORDER BY created_at ASC, id ASC`,
    ids
  );
  const grouped = new Map();
  for (const message of messages.rows) {
    const key = dto.num(message.conversation_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(message);
  }
  res.json(rows.rows.map(row => dto.toAiConversation(row, grouped.get(dto.num(row.id)) || [])));
}));

router.get("/ai/conversations/:id", handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return invalid(res, { id: "Expected a numeric conversation id" });
  const owns = await query(`SELECT id FROM ai_conversations WHERE id = $1 AND user_id = $2`, [id, uid(req)]);
  if (!owns.rowCount) return missing(res, "Conversation");
  res.json(await conversationWithMessages(id));
}));

router.delete("/ai/conversations/:id", handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return invalid(res, { id: "Expected a numeric conversation id" });
  const owns = await query(`SELECT id FROM ai_conversations WHERE id = $1 AND user_id = $2`, [id, uid(req)]);
  if (!owns.rowCount) return missing(res, "Conversation");
  await query(`DELETE FROM ai_conversations WHERE id = $1`, [id]);
  res.json({ deleted: true });
}));

/* The page buckets these client-side; this list is the whole feature. */
router.get("/ai/suggestions", handle(async (req, res) => {
  res.json({
    prompts: [
      "Write a headline that makes recruiters stop scrolling",
      "Draft an introduction message for a hiring manager",
      "Turn my last project into three achievement bullets",
      "Suggest hashtags for a product launch post",
      "How should I ask for a referral at a company I admire?",
      "Review my bio for clarity and tone",
      "Write a thank-you note after an interview",
      "Outline a plan to grow my following in 30 days",
    ],
  });
}));

/** OpenAI-compatible chat completions; null means "use the fallback". */
async function providerReply(history) {
  const token = process.env.AI_API_TOKEN;
  if (!token) return null;
  const base = process.env.AI_API_BASE || "https://api.deepseek.com/v1";
  const model = process.env.AI_MODEL || "deepseek-chat";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history] }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const text = payload && payload.choices && payload.choices[0] && payload.choices[0].message
      ? str(payload.choices[0].message.content, 8000)
      : "";
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

router.post("/ai/messages", handle(async (req, res) => {
  const text = str(req.body.text, 6000).trim();
  if (!text) return invalid(res, { text: "Type a message first" });

  const me = uid(req);
  /* toId THROWS on junk, and a null conversationId is the "start a thread" signal, not an error */
  const declared = req.body.conversationId;
  let id = declared === null || declared === undefined || declared === 0 || declared === "" ? null : toId(declared, "conversationId");
  if (id) {
    const owns = await query(`SELECT id FROM ai_conversations WHERE id = $1 AND user_id = $2`, [id, me]);
    if (!owns.rowCount) return missing(res, "Conversation");
  } else {
    const created = await query(
      `INSERT INTO ai_conversations (user_id, title, created_at, updated_at)
       VALUES ($1, $2, ${NOW}, ${NOW}) RETURNING id`,
      [me, text.slice(0, 42)]
    );
    id = dto.num(created.rows[0].id);
  }

  await query(
    `INSERT INTO ai_messages (conversation_id, role, body) VALUES ($1, 'user', $2)`,
    [id, text]
  );

  /* last window of the thread, oldest first — the user message just inserted is included */
  const history = (await query(
    `SELECT role, body FROM (
       SELECT id, role, body FROM ai_messages WHERE conversation_id = $1
        ORDER BY id DESC LIMIT ${HISTORY_WINDOW})
      ORDER BY id ASC`,
    [id]
  )).rows.map(row => ({ role: dto.text(row.role), content: dto.text(row.body) }));

  const answer = (await providerReply(history)) || FALLBACK_REPLY;
  const inserted = await query(
    `INSERT INTO ai_messages (conversation_id, role, body, created_at)
     VALUES ($1, 'assistant', $2, ${NOW}) RETURNING id, created_at`,
    [id, answer]
  );
  await query(`UPDATE ai_conversations SET updated_at = ${NOW} WHERE id = $1`, [id]);

  res.json({
    conversationId: id,
    reply: {
      id: dto.num(inserted.rows[0].id),
      role: "assistant",
      text: answer,
      createdAt: dto.iso(inserted.rows[0].created_at) || new Date().toISOString(),
    },
  });
}));

module.exports = router;
