/* probe-returning.mjs — the write class the read-only differential cannot reach.

   Every route below branches on `result.rowCount` or reads `result.rows[0]` out of a statement of the
   form `UPDATE … RETURNING` / `DELETE … RETURNING`.  On PostgreSQL those always answer with the affected
   rows; D1's HTTP /query returns no rows for UPDATE and DELETE at all (measured 2026-10-20), so if
   src/db.js does not synthesise rowCount/rows from D1's `meta.changes`, the drift is not a wrong number
   but a wrong *shape* of answer:

     DELETE /api/posts/:id      rowCount 0  -> 404 {"error":"not_found"}  AFTER the row was soft-deleted
     POST   /api/tasks/:id/toggle rows[0]   -> TypeError inside the route -> 500
     DELETE /api/marketplace/listings/:id  -> 404 after the row was deleted

   Both of those are invisible to diff-routes: Phase A is GET-only against production, and Phase B would
   report a 404/500 as a defect but never produces the rows these statements match on unless they exist
   first.  So this tool creates its own rows, then asserts each response is the success shape AND the D1
   row state agrees, then deletes everything it made.  Zero production requests. */
import crypto from "node:crypto";
import { workerRequest, d1Read, d1WriteBatch, hideSecrets } from "./diff-support.mjs";

const RUN = "rt-" + crypto.randomBytes(3).toString("hex");
const EMAIL = `zz-${RUN}@example.com`;
const PASSWORD = "returningprobe-Passw0rd!";
const UA = "professionalist-returning-probe/1.0";
let PASSES = 0, FAILS = 0;
function check(name, ok, detail) {
  if (ok) { PASSES++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`); }
  else { FAILS++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
async function j(method, at, body, bearer) {
  const headers = { "content-type": "application/json", "user-agent": UA };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const r = await workerRequest(method, at, { headers, body: body == null ? undefined : JSON.stringify(body), timeoutMs: 60000 });
  let json = null; try { json = JSON.parse(r.bodyText); } catch { /* non-json */ }
  return { status: r.status, json, text: r.bodyText };
}
const shown = t => hideSecrets(String(t)).replace(/\s+/g, " ").slice(0, 150);

/* ---- throwaway member, created through the Worker so the session is real ---- */
const reg = await j("POST", "/api/auth/register", { username: RUN, email: EMAIL, password: PASSWORD, name: "Returning Probe", accountType: "individual" });
const userRow = await d1Read(`SELECT id FROM users WHERE email = LOWER('${EMAIL}')`).then(r => r[0]).catch(() => null);
if (!userRow || !reg.json || !reg.json.token) {
  console.log(`register -> ${reg.status}; user row ${userRow && userRow.id}; token ${reg.json && reg.json.token ? "issued" : "NONE"}`);
  console.log(`  body ${shown(reg.text)}`);
  console.log("\nVERDICT: cannot run — no throwaway session (is the Worker on 127.0.0.1:8803 up with JWT_SECRET?)");
  process.exit(1);
}
const uid = userRow.id, bearer = reg.json.token;
console.log(`=== RETURNING-dependent writes (Worker + real D1, throwaway user ${uid}) ===`);
const made = { posts: [], comments: [], listings: [], tasks: [], convs: [], messages: [], follows: [] };
const peer = (await d1Read(`SELECT id FROM users WHERE status = 'active' AND id <> ${uid} ORDER BY id LIMIT 1`).catch(() => []))[0];

/* ---- 1. UPDATE … RETURNING id behind a soft delete: the rowCount branch ---- */
const post = await j("POST", "/api/posts", { content: `returning probe post ${RUN}` }, bearer);
const pid = post.json && (post.json.id ?? (post.json.post && post.json.post.id));
if (pid) made.posts.push(pid);
check("POST /api/posts mints a row to delete", !!pid, `status=${post.status} body=${shown(post.text)}`);

if (pid) {
  const del = await j("DELETE", `/api/posts/${pid}`, null, bearer);
  const rowState = await d1Read(`SELECT deleted_at FROM posts WHERE id = ${pid}`).then(r => r[0]);
  check("DELETE /api/posts/:id answers ok:true (not the rowCount-0 404)", del.status === 200 && del.json && del.json.ok === true,
    `status=${del.status} body=${shown(del.text)}`);
  check("  and the row really is soft-deleted", !!(rowState && rowState.deleted_at), `posts.deleted_at=${rowState && rowState.deleted_at}`);
}

const cmtParent = await j("POST", "/api/posts", { content: `comment host ${RUN}` }, bearer);
const hostId = cmtParent.json && (cmtParent.json.id ?? (cmtParent.json.post && cmtParent.json.post.id));
if (hostId) made.posts.push(hostId);
if (hostId) {
  const c = await j("POST", `/api/posts/${hostId}/comments`, { content: `probe comment ${RUN}` }, bearer);
  const cid = c.json && (c.json.id ?? (c.json.comment && c.json.comment.id));
  if (cid) made.comments.push(cid);
  check("POST /api/posts/:id/comments mints a row", !!cid, `status=${c.status} body=${shown(c.text)}`);
  if (cid) {
    const d = await j("DELETE", `/api/posts/comments/${cid}`, null, bearer);
    const state = await d1Read(`SELECT deleted_at FROM comments WHERE id = ${cid}`).then(r => r[0]);
    check("DELETE /api/posts/comments/:id answers ok:true", d.status === 200 && d.json && d.json.ok === true,
      `status=${d.status} body=${shown(d.text)}`);
    check("  and the comment really is soft-deleted", !!(state && state.deleted_at), `comments.deleted_at=${state && state.deleted_at}`);
  }
}

/* ---- 2. UPDATE … RETURNING status, completed_at: the rows[0] branch (a 500 if rows is empty) ---- */
const task = await j("POST", "/api/tasks", { title: `probe task ${RUN}` }, bearer);
const tid = task.json && (task.json.id ?? (task.json.task && task.json.task.id));
if (tid) made.tasks.push(tid);
check("POST /api/tasks mints a row", !!tid, `status=${task.status} body=${shown(task.text)}`);
if (tid) {
  const tog = await j("POST", `/api/tasks/${tid}/toggle`, {}, bearer);
  check("POST /api/tasks/:id/toggle returns the RETURNING row (status/completedAt)",
    tog.status === 200 && tog.json && typeof tog.json.status === "string", `status=${tog.status} body=${shown(tog.text)}`);
  const tdel = await j("DELETE", `/api/tasks/${tid}`, null, bearer);
  check("DELETE /api/tasks/:id answers ok:true", tdel.status === 200 && tdel.json && tdel.json.ok === true,
    `status=${tdel.status} body=${shown(tdel.text)}`);
  const still = await d1Read(`SELECT COUNT(*) n FROM user_tasks WHERE id = ${tid}`).then(r => r[0].n);
  check("  and the task row is gone", String(still) === "0", `rows=${still}`);
}

/* ---- 3. DELETE … RETURNING id on a hard delete ---- */
const listing = await j("POST", "/api/marketplace/listings", {
  title: `probe listing ${RUN}`, description: "probe body", price: 10, currency: "USD", category: "services",
}, bearer);
const lid = listing.json && (listing.json.id ?? (listing.json.listing && listing.json.listing.id));
if (lid) made.listings.push(lid);
check("POST /api/marketplace/listings mints a row", !!lid, `status=${listing.status} body=${shown(listing.text)}`);
if (lid) {
  const pat = await j("PATCH", `/api/marketplace/listings/${lid}`, { price: 11 }, bearer);
  check("PATCH /api/marketplace/listings/:id returns a body", pat.status === 200 && !!pat.json, `status=${pat.status} body=${shown(pat.text)}`);
  const fav = await j("POST", `/api/marketplace/listings/${lid}/favorite`, {}, bearer);
  check("POST /api/marketplace/listings/:id/favorite returns a body", fav.status < 400 && !!fav.json, `status=${fav.status} body=${shown(fav.text)}`);
  const ldel = await j("DELETE", `/api/marketplace/listings/${lid}`, null, bearer);
  check("DELETE /api/marketplace/listings/:id answers ok:true (not the rowCount-0 404)",
    ldel.status === 200 && ldel.json && ldel.json.ok === true, `status=${ldel.status} body=${shown(ldel.text)}`);
  const gone = await d1Read(`SELECT COUNT(*) n FROM marketplace_listings WHERE id = ${lid}`).then(r => r[0].n);
  check("  and the listing row is really gone", String(gone) === "0", `rows=${gone}`);
}

/* ---- 4. follow / unfollow and the conversation read receipts ---- */
if (peer) {
  const fol = await j("POST", "/api/network/follow", { userId: peer.id }, bearer);
  check("POST /api/network/follow -> 2xx", fol.status < 400, `peer=${peer.id} status=${fol.status} body=${shown(fol.text)}`);
  const unf = await j("POST", "/api/network/unfollow", { userId: peer.id }, bearer);
  check("POST /api/network/unfollow -> 2xx (RETURNING-dependent)", unf.status < 400, `status=${unf.status} body=${shown(unf.text)}`);
  const conv = await j("POST", "/api/messages/conversations", { userId: peer.id, firstMessage: `returning probe ${RUN}` }, bearer);
  const cid = conv.json && (conv.json.id ?? conv.json.conversationId);
  if (cid) made.convs.push(String(cid));
  check("POST /api/messages/conversations echoes the new id", conv.status < 400 && !!cid, `status=${conv.status} body=${shown(conv.text)}`);
  if (cid) {
    const read = await j("POST", `/api/messages/conversations/${cid}/read`, {}, bearer);
    check("POST /api/messages/conversations/:id/read -> 2xx with a count", read.status < 400, `status=${read.status} body=${shown(read.text)}`);
    const msgs = await d1Read(`SELECT id FROM messages WHERE conversation_id = '${cid}' ORDER BY id LIMIT 1`).then(r => r[0]).catch(() => null);
    if (msgs) {
      made.messages.push(msgs.id);
      const mdel = await j("DELETE", `/api/messages/messages/${msgs.id}`, null, bearer);
      check("DELETE /api/messages/messages/:id -> 2xx (UPDATE RETURNING id)", mdel.status < 400, `status=${mdel.status} body=${shown(mdel.text)}`);
    }
  }
} else console.log("  (no peer user available — follow/conversation steps skipped)");

/* ---- 5. the saved-post toggle: INSERT … ON CONFLICT … RETURNING and its delete ---- */
if (hostId) {
  const save = await j("POST", `/api/posts/${hostId}/save`, {}, bearer);
  check("POST /api/posts/:id/save -> 2xx", save.status < 400, `status=${save.status} body=${shown(save.text)}`);
  const saved = await d1Read(`SELECT id FROM saved_items WHERE user_id = ${uid} AND ref_id = '${hostId}'`).then(r => r[0]).catch(() => null);
  if (saved) {
    const un = await j("DELETE", `/api/saved/${saved.id}`, null, bearer);
    check("DELETE /api/saved/:id -> 2xx (DELETE RETURNING id)", un.status < 400, `status=${un.status} body=${shown(un.text)}`);
  } else console.log("  (save produced no saved_items row — unsave step skipped)");
}

/* ---- cleanup: everything this run made, and proof nothing is left ---- */
console.log("\n=== cleanup ===");
const stmts = [
  ...made.messages.map(id => ({ sql: "DELETE FROM messages WHERE id = ?", params: [id] })),
  ...made.convs.map(c => ({ sql: "DELETE FROM conversation_members WHERE conversation_id = ?", params: [c] })),
  ...made.convs.map(c => ({ sql: "DELETE FROM messages WHERE conversation_id = ?", params: [c] })),
  ...made.convs.map(c => ({ sql: "DELETE FROM conversations WHERE id = ?", params: [c] })),
  ...made.comments.map(id => ({ sql: "DELETE FROM comments WHERE id = ?", params: [id] })),
  ...made.posts.map(id => ({ sql: "DELETE FROM post_likes WHERE post_id = ?", params: [id] })),
  ...made.posts.map(id => ({ sql: "DELETE FROM comments WHERE post_id = ?", params: [id] })),
  ...made.posts.map(id => ({ sql: "DELETE FROM posts WHERE id = ?", params: [id] })),
  ...made.listings.map(id => ({ sql: "DELETE FROM listing_favorites WHERE listing_id = ?", params: [id] })),
  ...made.listings.map(id => ({ sql: "DELETE FROM marketplace_listings WHERE id = ?", params: [id] })),
  ...made.tasks.map(id => ({ sql: "DELETE FROM user_tasks WHERE id = ?", params: [id] })),
  { sql: "DELETE FROM follows WHERE follower_id = ? OR following_id = ?", params: [uid, uid] },
  { sql: "DELETE FROM saved_items WHERE user_id = ?", params: [uid] },
  { sql: "DELETE FROM notifications WHERE user_id = ?", params: [uid] },
  { sql: "DELETE FROM profile_skills WHERE user_id = ?", params: [uid] },
  { sql: "DELETE FROM email_verification_tokens WHERE user_id = ?", params: [uid] },
  { sql: "DELETE FROM password_reset_tokens WHERE user_id = ?", params: [uid] },
  { sql: "DELETE FROM profiles WHERE user_id = ?", params: [uid] },
  { sql: "DELETE FROM auth_sessions WHERE user_id = ?", params: [uid] },
  { sql: "DELETE FROM security_events WHERE user_id = ?", params: [uid] },
  { sql: "DELETE FROM audit_logs WHERE actor_user_id = ?", params: [uid] },
  { sql: "DELETE FROM users WHERE id = ?", params: [uid] },
];
for (const s of stmts) await d1WriteBatch([s]).catch(e => console.log(`  cleanup skip: ${hideSecrets(e.message).slice(0, 90)}`));
const leftovers = await d1Read(`SELECT (SELECT COUNT(*) FROM users WHERE id = ${uid}) u,
  (SELECT COUNT(*) FROM posts WHERE user_id = ${uid}) p,
  (SELECT COUNT(*) FROM user_tasks WHERE user_id = ${uid}) t,
  (SELECT COUNT(*) FROM marketplace_listings WHERE seller_id = ${uid}) l,
  (SELECT COUNT(*) FROM follows WHERE follower_id = ${uid}) f`).catch(() => [{}]);
const L = leftovers[0] || {};
console.log(`  leftover rows: users=${L.u} posts=${L.p} tasks=${L.t} listings=${L.l} follows=${L.f} (all must be 0)`);
check("cleanup leaves no rows behind", [L.u, L.p, L.t, L.l, L.f].every(v => String(v) === "0"), JSON.stringify(L));

console.log(`\nVERDICT: ${PASSES} passed, ${FAILS} failed`);
process.exit(FAILS ? 1 : 0);
