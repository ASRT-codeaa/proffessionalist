/* Verify /api/support, /api/ads and /api/ai (app-new/routes/spa/{support,ads,ai}.js) end-to-end
   against a node:sqlite stand-in D1, running the REAL authenticate and the port's pg→SQLite
   translation.  The five surface tables come from compat/schema.sql, the D1 snapshot — measured
   byte-identical to the live database's sqlite_master (2026-10-20).  The AI provider is faked
   with a local OpenAI-compatible server so the proxy's happy path, error path and keyless
   fallback are all exercised.  Every scenario resets the database.

   node cf-api/tools/test-surfaces.mjs */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = "test-secret";
delete process.env.AI_API_TOKEN;
delete process.env.AI_API_BASE;
delete process.env.AI_MODEL;

const ROOT = path.join(import.meta.dirname, "..");
const db = require("../src/db.js");
const express = require("../src/shims/express.js");
const jwt = require("../src/shims/jwt.js");
const { hashToken } = require("../port/middleware/authenticate.js");

/* ------------------------------------------------------------------ *
 * the D1 stand-in (same measured shapes as test-videos.mjs)
 * ------------------------------------------------------------------ */
function makeBinding() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const load = text => {
    for (const stmt of text.split(";\n")
      .map(s => s.replace(/^\s*(?:--[^\n]*\n)+/, "").replace(/^--.*$/gm, "").trim())
      .filter(Boolean)) sqlite.exec(stmt);
  };
  load(fs.readFileSync(path.join(ROOT, "compat", "schema.sql"), "utf8"));

  function statement(sql) {
    let params = [];
    const self = {
      bind(...vals) { params = vals; return self; },
      async all() { return { ...exec(sql, params), success: true }; },
      async first() { const r = await self.all(); return r.results[0] || null; },
      async run() { return { ...exec(sql, params), success: true }; },
    };
    return self;
  }
  function exec(sql, params) {
    const stmt = sqlite.prepare(sql);
    const bound = params.map(p => (p === undefined ? null : p));
    if (/^\s*(SELECT|WITH|VALUES|PRAGMA|EXPLAIN)\b/i.test(sql)) {
      return { results: stmt.all(...bound), meta: { changes: 0, last_row_id: 0 } };
    }
    if (/\bRETURNING\b/i.test(sql)) {
      const results = stmt.all(...bound);
      return { results, meta: { changes: results.length, last_row_id: 0 } };
    }
    const info = stmt.run(...bound);
    return { results: [], meta: { changes: Number(info.changes) || 0, last_row_id: Number(info.lastInsertRowid) || 0 } };
  }
  const env = {
    DB: {
      prepare: statement,
      async batch(stmts) {
        sqlite.exec("BEGIN");
        try {
          const out = [];
          for (const s of stmts) out.push(await s.all());
          sqlite.exec("COMMIT");
          return out;
        } catch (err) { sqlite.exec("ROLLBACK"); throw err; }
      },
    },
  };
  return { env, close: () => sqlite.close() };
}

let CURRENT = null;
function resetDb() {
  if (CURRENT && CURRENT.close) CURRENT.close();
  CURRENT = makeBinding();
  db.init(CURRENT.env);
}

/* ------------------------------------------------------------------ *
 * the app under test: authenticate + pass-through limiter + the three routers
 * ------------------------------------------------------------------ */
const app = express();
app.use(express.json());
const { authenticate } = require("../port/middleware/authenticate.js");
const supportRouter = require("../port/routes/spa/support.js");
const adsRouter = require("../port/routes/spa/ads.js");
const aiRouter = require("../port/routes/spa/ai.js");
const passthroughLimiter = (req, res, next) => next();
/* the production chain (api.js): one /api mount, routers in mount order */
app.use("/api", authenticate, passthroughLimiter, supportRouter, adsRouter, aiRouter);
const ctx = { waitUntil: () => {} };

async function call(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const request = new Request(`http://localhost${url}`, { method, headers, body: payload });
  const response = await app.handle(request, CURRENT.env, ctx);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: response.status, json, text };
}

/* ------------------------------------------------------------------ *
 * seed helpers
 * ------------------------------------------------------------------ */
const FUTURE = "2999-01-01T00:00:00.000Z";
async function insertUser(username, { role = "user", status = "active" } = {}) {
  const r = await db.query(
    `INSERT INTO users (username,email,password_hash,name,role,status,account_type)
     VALUES ($1,$2,'h',$1,$3,$4,'individual') RETURNING id`,
    [username, `${username}@x.invalid`, role, status]
  );
  return Number(r.rows[0].id);
}
let SEQ = 0;
async function tokenFor(userId) {
  SEQ += 1;
  const sid = `sess-${userId}-${SEQ}`;
  const tok = jwt.sign({ sub: userId, sessionId: sid }, process.env.JWT_SECRET, { expiresIn: "2h" });
  await db.query(
    `INSERT INTO auth_sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)`,
    [sid, String(userId), hashToken(tok), FUTURE]
  );
  return tok;
}

/* ------------------------------------------------------------------ *
 * the tiny assertion runner
 * ------------------------------------------------------------------ */
let PASS = 0;
const FAILS = [];
function check(name, ok, detail) {
  if (ok) { PASS++; console.log(`  ok    ${name}`); }
  else { FAILS.push(name); console.log(`  FAIL  ${name}${detail ? `\n          ${String(detail).slice(0, 400)}` : ""}`); }
}

/* ================================================================== *
 *  1. support: create -> list -> owner reply -> staff reply flips from_user
 * ================================================================== */
console.log("== support tickets: the thread, its voices, and its owners ==");
{
  resetDb();
  const alice = await insertUser("sp_alice");
  const mallory = await insertUser("sp_mallory");
  const staff = await insertUser("sp_staff", { role: "admin" });
  const aTok = await tokenFor(alice);
  const mTok = await tokenFor(mallory);
  const sTok = await tokenFor(staff);

  const anon = await call("GET", "/api/support/tickets");
  check("GET /support/tickets without a session is refused", anon.status === 401 || anon.status === 403, `${anon.status}`);

  const empty = await call("GET", "/api/support/tickets", { token: aTok });
  check("a fresh viewer has no tickets", empty.status === 200 && Array.isArray(empty.json) && empty.json.length === 0, `${empty.status} ${empty.text.slice(0, 160)}`);

  const bad = await call("POST", "/api/support/tickets", { token: aTok, body: { subject: "  ", text: "" } });
  check("create without subject or text is a 400 with field errors", bad.status === 400 && bad.json.error.fields.subject && bad.json.error.fields.text, `${bad.status} ${bad.text.slice(0, 200)}`);

  const created = await call("POST", "/api/support/tickets", {
    token: aTok,
    body: { subject: "Billing question", category: "billing", text: "I was charged twice.", attachmentUrl: "https://example.com/receipt.png" },
  });
  check("POST /support/tickets answers 201 with the full ticket DTO",
    created.status === 201 && created.json.subject === "Billing question" && created.json.status === "open"
      && created.json.messages.length === 1 && created.json.messages[0].fromUser === true
      && created.json.messages[0].attachmentUrl === "https://example.com/receipt.png",
    `${created.status} ${created.text.slice(0, 300)}`);
  const ticketId = created.json && created.json.id;

  const list = await call("GET", "/api/support/tickets", { token: aTok });
  check("the ticket appears in the list with its message", list.status === 200 && list.json.length === 1 && list.json[0].messages.length === 1, `${list.status}`);

  const peek = await call("GET", `/api/support/tickets/${ticketId}`, { token: mTok });
  check("a stranger cannot read someone else's ticket (404, not a leak)", peek.status === 404, `${peek.status}`);

  const stolen = await call("POST", `/api/support/tickets/${ticketId}/reply`, { token: mTok, body: { text: "mine now" } });
  check("a stranger cannot reply to someone else's ticket", stolen.status === 404, `${stolen.status}`);

  const ownerReply = await call("POST", `/api/support/tickets/${ticketId}/reply`, { token: aTok, body: { text: "Any news?" } });
  check("owner reply appends with fromUser=true and keeps the thread ordered",
    ownerReply.status === 200 && ownerReply.json.messages.length === 2 && ownerReply.json.messages[1].fromUser === true,
    `${ownerReply.status} ${ownerReply.text.slice(0, 300)}`);

  const staffReply = await call("POST", `/api/support/tickets/${ticketId}/reply`, { token: sTok, body: { text: "Refund issued." } });
  check("staff reply lands as the team voice (fromUser=false) and moves the ticket to pending",
    staffReply.status === 200 && staffReply.json.messages.length === 3 && staffReply.json.messages[2].fromUser === false && staffReply.json.status === "pending",
    `${staffReply.status} ${staffReply.text.slice(0, 300)}`);

  const avail = await call("GET", "/api/support/availability", { token: aTok });
  check("availability answers the widget's exact shape",
    avail.status === 200 && typeof avail.json.online === "boolean" && typeof avail.json.hours === "string"
      && typeof avail.json.avgResponse === "string" && Array.isArray(avail.json.agents)
      && avail.json.agents.every(a => typeof a.name === "string" && typeof a.avatarUrl === "string" && typeof a.role === "string"),
    `${avail.status} ${avail.text.slice(0, 240)}`);

  const staffRead = await call("GET", `/api/support/tickets/${ticketId}`, { token: sTok });
  check("staff may read any ticket (the console's review path)", staffRead.status === 200 && staffRead.json.id === ticketId, `${staffRead.status}`);
}

/* ================================================================== *
 *  2. ads: create -> JSON round-trip -> patch -> ownership walls
 * ================================================================== */
console.log("\n== ad campaigns: the form whitelist and the TEXT-JSON round-trip ==");
{
  resetDb();
  const alice = await insertUser("ad_alice");
  const mallory = await insertUser("ad_mallory");
  const aTok = await tokenFor(alice);
  const mTok = await tokenFor(mallory);

  const none = await call("GET", "/api/ads/campaigns", { token: aTok });
  check("a fresh viewer has no campaigns", none.status === 200 && Array.isArray(none.json) && none.json.length === 0, `${none.status}`);

  const badObjective = await call("POST", "/api/ads/campaigns", { token: aTok, body: { name: "X", objective: "hypnosis" } });
  check("an unknown objective is rejected with a field error", badObjective.status === 400 && badObjective.json.error.fields.objective, `${badObjective.status} ${badObjective.text.slice(0, 200)}`);

  const nameless = await call("POST", "/api/ads/campaigns", { token: aTok, body: { objective: "leads" } });
  check("create requires a name", nameless.status === 400 && nameless.json.error.fields.name, `${nameless.status}`);

  const created = await call("POST", "/api/ads/campaigns", {
    token: aTok,
    body: {
      name: "Autumn launch", objective: "leads", format: "banner", status: "active", budget: 250,
      startDate: "2026-10-01", endDate: "2026-10-31", creativeUrl: "https://cdn.example/banner.png",
      creativeText: "Ship faster", destination: "https://example.com/buy",
      audience: { industries: ["design"], locations: ["EU"], interests: ["ads", "growth"], ageRange: "25-34" },
      ownerBusinessId: 5,
    },
  });
  check("POST /ads/campaigns answers 201 with the DTO the page renders",
    created.status === 201 && created.json.name === "Autumn launch" && created.json.status === "active"
      && created.json.budget === 250 && created.json.spend === 0,
    `${created.status} ${created.text.slice(0, 300)}`);
  check("audience survives the TEXT-JSON round-trip in the form's exact shape",
    created.json.audience.industries.join() === "design" && created.json.audience.locations.join() === "EU"
      && created.json.audience.interests.join() === "ads,growth" && created.json.audience.ageRange === "25-34",
    JSON.stringify(created.json && created.json.audience));
  check("metrics come back as the four zeros and daily stays empty",
    created.json.metrics.impressions === 0 && created.json.metrics.clicks === 0
      && created.json.metrics.engagement === 0 && created.json.metrics.conversions === 0
      && Array.isArray(created.json.daily) && created.json.daily.length === 0,
    JSON.stringify(created.json && created.json.metrics));
  const campaignId = created.json && created.json.id;

  const junkAudience = await call("POST", "/api/ads/campaigns", { token: aTok, body: { name: "Junky", audience: "not-an-object" } });
  check("a non-object audience normalises to the empty shape instead of throwing",
    junkAudience.status === 201 && junkAudience.json.audience.industries.length === 0 && junkAudience.json.audience.ageRange === "",
    `${junkAudience.status} ${junkAudience.text.slice(0, 240)}`);

  const paused = await call("PATCH", `/api/ads/campaigns/${campaignId}`, { token: aTok, body: { status: "paused" } });
  check("PATCH {status} — the Pause button's call — updates and returns the DTO",
    paused.status === 200 && paused.json.status === "paused", `${paused.status} ${paused.text.slice(0, 200)}`);

  const badBudget = await call("PATCH", `/api/ads/campaigns/${campaignId}`, { token: aTok, body: { budget: -5 } });
  check("a negative budget is a 400", badBudget.status === 400 && badBudget.json.error.fields.budget, `${badBudget.status}`);

  const foreignPatch = await call("PATCH", `/api/ads/campaigns/${campaignId}`, { token: mTok, body: { status: "completed" } });
  check("someone else's campaign is a 404 to patch", foreignPatch.status === 404, `${foreignPatch.status}`);

  const own = await call("GET", "/api/ads/campaigns", { token: aTok });
  const theirs = await call("GET", "/api/ads/campaigns", { token: mTok });
  check("the list is own-only", own.status === 200 && own.json.length === 2 && theirs.status === 200 && theirs.json.length === 0,
    `own=${own.json && own.json.length} theirs=${theirs.json && theirs.json.length}`);

  const patchedStillAudience = await call("PATCH", `/api/ads/campaigns/${campaignId}`, { token: aTok, body: { name: "Autumn launch v2" } });
  check("a patch of one field leaves the stored audience JSON untouched",
    patchedStillAudience.status === 200 && patchedStillAudience.json.name === "Autumn launch v2"
      && patchedStillAudience.json.audience.interests.join() === "ads,growth",
    JSON.stringify(patchedStillAudience.json && patchedStillAudience.json.audience));
}

/* ================================================================== *
 *  3. ai: fallback without a key, real provider round-trip, errors, ownership
 * ================================================================== */
console.log("\n== ai assistant: fallback, provider proxy, threads and walls ==");
{
  resetDb();
  const alice = await insertUser("ai_alice");
  const mallory = await insertUser("ai_mallory");
  const aTok = await tokenFor(alice);
  const mTok = await tokenFor(mallory);

  const suggestions = await call("GET", "/api/ai/suggestions", { token: aTok });
  check("suggestions answer {prompts:[...]}", suggestions.status === 200 && Array.isArray(suggestions.json.prompts) && suggestions.json.prompts.length >= 6, `${suggestions.status}`);

  const empty = await call("GET", "/api/ai/conversations", { token: aTok });
  check("a fresh viewer has no conversations", empty.status === 200 && empty.json.length === 0, `${empty.status}`);

  /* no AI_API_TOKEN in this block's env — the documented pre-key state */
  const long = "Write a headline that makes recruiters stop scrolling, please, all 50+ characters of it";
  const fallbackSend = await call("POST", "/api/ai/messages", { token: aTok, body: { conversationId: null, text: long } });
  check("send(null) without a key creates the conversation and answers the client's exact shape",
    fallbackSend.status === 200 && typeof fallbackSend.json.conversationId === "number"
      && fallbackSend.json.reply.role === "assistant" && typeof fallbackSend.json.reply.id === "number"
      && typeof fallbackSend.json.reply.createdAt === "string",
    `${fallbackSend.status} ${fallbackSend.text.slice(0, 300)}`);
  check("the keyless reply is the stored fallback text",
    fallbackSend.json.reply.text === "The AI service is unavailable right now — try again in a bit.",
    JSON.stringify(fallbackSend.json.reply && fallbackSend.json.reply.text));
  const convId = fallbackSend.json && fallbackSend.json.conversationId;

  const conv = await call("GET", "/api/ai/conversations", { token: aTok });
  check("the conversation carries the title from the first 42 characters and both messages",
    conv.json[0].title === long.slice(0, 42) && conv.json[0].messages.length === 2
      && conv.json[0].messages[0].role === "user" && conv.json[0].messages[1].role === "assistant",
    JSON.stringify(conv.json[0] && { title: conv.json[0].title, n: conv.json[0].messages.length }));

  const blank = await call("POST", "/api/ai/messages", { token: aTok, body: { conversationId: convId, text: "   " } });
  check("a blank message is a 400", blank.status === 400 && blank.json.error.fields.text, `${blank.status}`);

  const strangerRead = await call("GET", `/api/ai/conversations/${convId}`, { token: mTok });
  check("a stranger's conversation is a 404", strangerRead.status === 404, `${strangerRead.status}`);
  const strangerSend = await call("POST", "/api/ai/messages", { token: mTok, body: { conversationId: convId, text: "hi" } });
  check("a stranger cannot post into someone else's conversation", strangerSend.status === 404, `${strangerSend.status}`);

  /* the fake OpenAI-compatible provider, so the proxy's happy path runs for real */
  let lastRequest = null;
  let mode = "ok";
  const provider = await new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        lastRequest = { url: req.url, auth: req.headers.authorization, json: JSON.parse(body || "{}") };
        if (mode === "ok") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "  Recruiter-magnet headline.  " } }] }));
        } else {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "overloaded" } }));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  process.env.AI_API_TOKEN = "sk-test-key";
  process.env.AI_API_BASE = `http://127.0.0.1:${provider.address().port}/v1`;
  process.env.AI_MODEL = "test-model";

  const liveSend = await call("POST", "/api/ai/messages", { token: aTok, body: { conversationId: convId, text: "Now with a provider" } });
  check("with a key the provider's answer is stored and returned, trimmed",
    liveSend.status === 200 && liveSend.json.reply.text === "Recruiter-magnet headline.",
    `${liveSend.status} ${liveSend.text.slice(0, 300)}`);
  check("the proxy posts chat/completions with the bearer key, the model, the system prompt and the history",
    lastRequest && lastRequest.url === "/v1/chat/completions" && lastRequest.auth === "Bearer sk-test-key"
      && lastRequest.json.model === "test-model"
      && lastRequest.json.messages[0].role === "system"
      && lastRequest.json.messages.some(m => m.role === "user" && m.content === "Now with a provider"),
    JSON.stringify(lastRequest && { url: lastRequest.url, auth: lastRequest.auth, model: lastRequest.json.model, n: lastRequest.json.messages.length }));

  mode = "fail";
  const errored = await call("POST", "/api/ai/messages", { token: aTok, body: { conversationId: convId, text: "Provider is down" } });
  check("a provider 5xx still answers 200 with the fallback stored",
    errored.status === 200 && errored.json.reply.text === "The AI service is unavailable right now — try again in a bit.",
    `${errored.status} ${errored.text.slice(0, 240)}`);

  const thread = await call("GET", `/api/ai/conversations/${convId}`, { token: aTok });
  check("the thread stayed continuous across fallback, live and error turns",
    thread.status === 200 && thread.json.messages.length === 6,
    `n=${thread.json && thread.json.messages.length}`);

  delete process.env.AI_API_TOKEN;
  delete process.env.AI_API_BASE;
  delete process.env.AI_MODEL;
  await new Promise(resolve => provider.close(resolve));

  const removed = await call("DELETE", `/api/ai/conversations/${convId}`, { token: aTok });
  check("DELETE removes the conversation", removed.status === 200 && removed.json.deleted === true, `${removed.status}`);
  const afterDelete = await call("GET", "/api/ai/conversations", { token: aTok });
  check("…and it is gone from the list (messages cascade with it)",
    afterDelete.status === 200 && afterDelete.json.length === 0
      && afterDelete.json.every(c => c.id !== convId),
    `${afterDelete.status} ${afterDelete.text.slice(0, 200)}`);
  const gone = await call("GET", `/api/ai/conversations/${convId}`, { token: aTok });
  check("a deleted conversation is a 404", gone.status === 404, `${gone.status}`);
  const foreignDelete = await call("DELETE", `/api/ai/conversations/${convId}`, { token: mTok });
  check("…and a stranger's DELETE of it is a 404 too", foreignDelete.status === 404, `${foreignDelete.status}`);
}

/* ------------------------------------------------------------------ */
console.log(`\nVERDICT: ${PASS} passed, ${FAILS.length} failed`);
if (FAILS.length) { for (const f of FAILS) console.log(`  - ${f}`); process.exit(1); }
console.log("/api/support threads with two voices, /api/ads whitelists the form's fields through TEXT JSON, /api/ai proxies its provider and never loses a message when the provider is away.");
