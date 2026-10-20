/* Task #20 — route-level differential harness.  Compares the ported Cloudflare Worker (running at
   127.0.0.1:8803 with LOCAL DO counters + the REAL professionalist-db-v2 D1 + REAL professionalist-media R2)
   against production https://api.proffessionalist.com (Express 5 behind nginx behind Cloudflare), which
   is the oracle.

   Rules enforced (see CLOUDFLARE-MIGRATION-HANDOFF.md §1/§2/§6 and the task brief):
     - Production is read-only: only GET/HEAD/OPTIONS, never with credentials, never a login attempt.
       Enforced in prodRequest(); the whole run is capped at 250 production requests.
     - Every endpoint comes from the ported source, enumerated by diff-support.mjs (never guesswork).
     - For every endpoint we compare status, the exact body where it is data-independent (envelopes /
       static payloads), and the response header NAME-set with duplicate counts.
     - Data-bearing anonymous GETs are compared on CONTENT.
     - Authenticated/written surface is exercised Worker-only against a single throwaway account, and
       the resulting D1 rows are asserted, then cleaned up.
     - Nothing secret is ever printed: external values pass through hideSecrets(); no token, hash, JWT,
       Authorization header, password, or the D1 uuid.

   node cf-api/tools/diff-routes.mjs [--only=<regex>] [--list] [--prod-direct] [--worker-live]

   Post-flip (§5.13): with NO new flags the harness still compares the hostname (now the Worker)
   against the local sandbox.  After the api.proffessionalist.com flip, a meaningful run needs
   --prod-direct (oracle = the still-running VPS at 140.245.50.236) and --worker-live (subject =
   the deployed Worker behind the real hostname).  See diff-support.mjs applyTargetArgs(). */
import crypto from "node:crypto";
import {
  prodRequest, workerRequest, hideSecrets, enumerateEndpoints, classifyGroup, probePath,
  compareHeaders, headerCounts, headerValue, budget, d1Read, d1WriteBatch, applyTargetArgs,
} from "./diff-support.mjs";

const ARGS = process.argv.slice(2);
const ONLY = (() => { const m = ARGS.find(a => a.startsWith("--only=")); return m ? new RegExp(m.slice(7)) : null; })();
const LIST = ARGS.includes("--list");
/* --phase-a-only: stop after the read-only phases.  Used post-flip when the Cloudflare API token is
   unavailable (Phase B asserts/cleans its throwaway rows through the D1 HTTP API, and its register
   step writes a live row we could not delete without that access — so it must not run at all). */
const PHASE_A_ONLY = ARGS.includes("--phase-a-only");
const TARGETS = applyTargetArgs(ARGS);
if (TARGETS.edge || PROD_DIRECT()) console.log(`targets: prod=${PROD_DIRECT() ? "vps-direct 140.245.50.236:80" : "hostname"} worker=${TARGETS.edge ? "live (deployed, via edge)" : "local sandbox 127.0.0.1:8803"}`);
function PROD_DIRECT() { return ARGS.includes("--prod-direct"); }

let DEFECTS = 0;
const defects = [];
function defect(id, detail) { DEFECTS++; defects.push({ id, detail }); }
const blockers = [];
function blocker(id, detail) { blockers.push({ id, detail }); }

/* ------------------------------------------------------------------ *
 *  enumeration
 * ------------------------------------------------------------------ */
const { routerEndpoints, appLevel } = enumerateEndpoints();
const allEndpoints = [...routerEndpoints, ...appLevel];
const definitions = routerEndpoints.length;
const uniqMethodPath = [...new Set(routerEndpoints.map(e => `${e.method} ${e.full}`))];
const uniqPaths = [...new Set(allEndpoints.map(e => e.full))];
/* app-new-only paths (group "worker-only"): production has no such route, so Phase A must not probe
   prod for them.  They are still exercised — see the authenticated GET sweep, which runs on group
   guard rather than group and therefore covers them against the Worker and real D1. */
const WORKER_ONLY = new Set(allEndpoints.filter(e => e.group === "worker-only").map(e => e.full));

if (LIST) {
  const groups = {};
  for (const e of allEndpoints) (groups[e.group] = groups[e.group] || []).push(e);
  console.log(`router definitions parsed from cf-api/port: ${definitions}`);
  console.log(`unique (method,path) endpoints: ${uniqMethodPath.length}  (shadowed dupes: ${definitions - uniqMethodPath.length})`);
  console.log(`unique paths (production GET probes + 3): ${uniqPaths.length}`);
  for (const g of ["public", "anonymous-guarded", "authenticated", "admin-ops", "worker-only"]) {
    console.log(`\n## ${g} (${(groups[g] || []).length} endpoints)`);
    for (const e of (groups[g] || []).sort((a, b) => (a.full + a.method).localeCompare(b.full + b.method)))
      console.log(`  ${e.method.padEnd(6)} ${e.full}   [${e.file}]`);
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 *  helpers
 * ------------------------------------------------------------------ */
const safe = p => p.startsWith("/uploads") ? "/uploads/avatars/does-not-exist.png" : probePath(p);
function tryJson(t) { try { return JSON.parse(t); } catch { return null; } }
function isEnvelope(o) { return o && o.error && typeof o.error === "object"
  && typeof o.error.code === "string" && typeof o.error.message === "string" && o.error.fields && typeof o.error.fields === "object"; }

/* ------------------------------------------------------------------ *
 *  PHASE A — production differential, one GET probe per unique path
 * ------------------------------------------------------------------ */
console.log("=== PHASE A: production read-only differential (GET probe per unique path) ===");
const rows = [];
const contentDiffs = [];
const cleanCount = { status: 0, body: 0, headers: 0 };

for (const p of uniqPaths) {
  if (ONLY && !ONLY.test(p)) continue;
  if (WORKER_ONLY.has(p)) continue;
  const at = safe(p);
  const pr = await prodRequest("GET", at).catch(e => ({ error: String(e.message) }));
  const wr = await workerRequest("GET", at, { timeoutMs: 45000 }).catch(e => ({ error: String(e.message) }));
  if (pr.error || wr.error) { rows.push({ p, note: `probe error prod=${pr.status || pr.error} work=${wr.status || wr.error}` }); continue; }

  const hdr = compareHeaders(pr.rawHeaders, wr.rawHeaders, pr.status, wr.status);
  let bodyClass;
  if (pr.status === wr.status) {
    if (pr.bodyText === wr.bodyText) bodyClass = "byte-identical";
    else {
      const pj = tryJson(pr.bodyText), wj = tryJson(wr.bodyText);
      if (pj && wj && JSON.stringify(pj) === JSON.stringify(wj)) bodyClass = "byte-differs/json-equal";
      else bodyClass = "content-differs";
    }
  } else bodyClass = "status-differs";

  // classify
  let klass = "ok";
  if (!hdr.match) klass = "header-set-diff";
  if (bodyClass === "content-differs" || bodyClass === "status-differs") {
    // /uploads ETag/Last-Modified are ENVIRONMENTAL, but those show in headers/body only for real bytes;
    // our /uploads probe is the 404 fallthrough (data-independent), so a diff here is real.
    klass = bodyClass === "status-differs" ? "DEFECT(status)" : "DEFECT(content)";
    contentDiffs.push({ p, prod: { s: pr.status, b: pr.bodyText.slice(0, 400) }, work: { s: wr.status, b: wr.bodyText.slice(0, 400) }, hdrIssues: hdr.issues });
    defect(`A:${p}`, `status prod=${pr.status} work=${wr.status}; body prod=${hideSecrets(pr.bodyText).slice(0, 200)} work=${hideSecrets(wr.bodyText).slice(0, 200)}; hdr=${hdr.issues.join("; ")}`);
  } else if (!hdr.match) {
    // header diff, but if every prod-only name is ENV-allowed compareHeaders already said match
    defect(`A-hdr:${p}`, hdr.issues.join("; "));
    klass = "DEFECT(headers)";
  }
  if (klass === "ok") { cleanCount.status++; if (bodyClass.startsWith("byte") || bodyClass === "byte-differs/json-equal") cleanCount.body++; cleanCount.headers++; }
  rows.push({ p, prod: pr.status, work: wr.status, body: bodyClass, hdr: hdr.match ? "match" : "DIFF", klass });
}

for (const r of rows) {
  const line = `${String(r.prod ?? "-").padStart(3)} ${String(r.work ?? "-").padStart(3)}  ${(r.body || "").padEnd(24)} ${(r.hdr || "").padEnd(6)} ${(r.klass || "").padEnd(16)} ${r.p}${r.note ? `  (${r.note})` : ""}`;
  if (r.klass && r.klass.startsWith("DEFECT")) console.log("  !! " + line);
  else if (r.klass !== "ok") console.log("  ?  " + line);
}
const prodClean = rows.filter(r => r.klass === "ok").length;
console.log(`  probed ${rows.length} paths against production; ${prodClean} fully clean; production requests used: ${budget.prod}/${budget.max}`);
console.log(`  content/status/header DEFECTS from Phase A: ${contentDiffs.length + rows.filter(r => r.klass === "DEFECT(headers)").length}`);

/* CORS preflight + RateLimit format comparison + a real /uploads object (one OPTIONS, a few GETs). */
console.log("\n=== PHASE A.2: preflight, RateLimit FORMAT, and a real /uploads object ===");
{
  const at = "/api/meta/countries";
  const pr = await prodRequest("OPTIONS", at, { headers: { origin: "https://proffessionalist.com", "access-control-request-method": "GET" } });
  const wr = await workerRequest("OPTIONS", at, { headers: { origin: "https://proffessionalist.com", "access-control-request-method": "GET" } });
  const acam = r => headerValue(r.rawHeaders, "access-control-allow-methods");
  console.log(`  OPTIONS ${at}: prod ${pr.status} [${acam(pr)}]  worker ${wr.status} [${acam(wr)}]`);
  if (pr.status !== wr.status) defect("A-preflight-status", `OPTIONS prod=${pr.status} worker=${wr.status}`);
  if (acam(pr) !== acam(wr)) defect("A-preflight-cors", `allow-methods prod="${acam(pr)}" worker="${acam(wr)}"`);

  // RateLimit/RateLimit-Policy FORMAT must match (values are live counters; the SHAPE is what matters)
  const pget = await prodRequest("GET", at);
  const wget = await workerRequest("GET", at);
  const pat = /"\d+-in-[a-z0-9]+";\s*q=\d+;\s*w=\d+;\s*pk=:[^:]*:/i;
  const prodPol = headerValue(pget.rawHeaders, "ratelimit-policy");
  const workPol = headerValue(wget.rawHeaders, "ratelimit-policy");
  const prodRl = headerValue(pget.rawHeaders, "ratelimit");
  const workRl = headerValue(wget.rawHeaders, "ratelimit");
  console.log(`  prod RateLimit-Policy: ${hideSecrets(prodPol)}`);
  console.log(`  work RateLimit-Policy: ${hideSecrets(workPol)}`);
  console.log(`  RateLimit present on both: ${!!prodRl && !!workRl}; pk partition on both: ${/pk=:[^:]*:/.test(prodPol) && /pk=:[^:]*:/.test(workPol)}`);
  if (pat.test(prodPol) && pat.test(workPol)) console.log("  ok  RateLimit-Policy FORMAT (limit-window; q; w; pk=:..:) matches on both stacks");
  else defect("A-ratelimit-format", `pattern mismatch prod="${hideSecrets(prodPol)}" work="${hideSecrets(workPol)}"`);

  // a real object that exists in BOTH production disk and the R2 backfill: compare status + content-type;
  // ETag/Last-Modified are documented ENVIRONMENTAL (send's W/"size-mtime" vs R2's md5 + upload date).
  const realKey = await d1Read("SELECT avatar_url FROM profiles WHERE avatar_url LIKE '/uploads/%' ORDER BY user_id LIMIT 1")
    .then(r => r[0] && r[0].avatar_url).catch(() => null);
  if (realKey) {
    const pu = await prodRequest("GET", realKey), wu = await workerRequest("GET", realKey);
    const pct = headerValue(pu.rawHeaders, "content-type"), wct = headerValue(wu.rawHeaders, "content-type");
    const pet = headerValue(pu.rawHeaders, "etag"), wet = headerValue(wu.rawHeaders, "etag");
    console.log(`  GET ${realKey}: prod ${pu.status}/${pct} vs worker ${wu.status}/${wct}; etag prod=${hideSecrets(pet)} work=${hideSecrets(wet)} (ETag/Last-Modified are ENVIRONMENTAL)`);
    if (pu.status !== wu.status) defect("A-upload-status", `${realKey} prod=${pu.status} worker=${wu.status}`);
    if (pct !== wct) defect("A-upload-content-type", `${realKey} prod="${pct}" worker="${wct}"`);
  }
}

/* ------------------------------------------------------------------ *
 *  PHASE B — Worker-only authenticated surface with ONE throwaway account
 * ------------------------------------------------------------------ */
if (PHASE_A_ONLY) {
  console.log("\n=== PHASE B / CLEANUP: SKIPPED (--phase-a-only) ===");
  console.log("  Phase B writes a throwaway user/post/avatar/message set through the live Worker and asserts");
  console.log("  then deletes those rows via the D1 HTTP API. With the Cloudflare API token unavailable the");
  console.log("  rows could not be cleaned up, so the phase is refused rather than run dirty. Re-run without");
  console.log("  --phase-a-only once a working token is back in place.");
} else {
console.log("\n=== PHASE B: Worker-only authenticated surface ===");
const RUN = "diff-" + crypto.randomBytes(3).toString("hex");
const EMAIL = `zz-${RUN}@example.com`;
const PASSWORD = "diffprobe-Passw0rd!";
const UA = "professionalist-diff-harness/1.0";
let created = { email: EMAIL };

async function j(method, at, body, headers = {}) {
  const r = await workerRequest(method, at, {
    headers: Object.assign({ "content-type": "application/json", "user-agent": UA }, headers),
    body: body == null ? undefined : JSON.stringify(body), timeoutMs: 60000,
  });
  return { status: r.status, json: tryJson(r.bodyText), text: r.bodyText, rawHeaders: r.rawHeaders };
}

// B.0 mail failure cannot hang the run: time the register (mailer outbound will fail in-process)
const t0 = Date.now();
const reg = await j("POST", "/api/auth/register", { username: RUN, email: EMAIL, password: PASSWORD, name: "Diff Probe", accountType: "individual" });
const regMs = Date.now() - t0;
console.log(`  register -> ${reg.status} in ${regMs}ms (mail failure drained, did not hang): user=${reg.json?.user?.username} token=${reg.json?.token ? "issued" : "none"}`);
if (regMs > 58000) defect("B-mail-hang", `register took ${regMs}ms — mail drain may be blocking the response`);
created.userRow = await d1Read(`SELECT id, username, role, status, email_verified_at FROM users WHERE email = LOWER('${EMAIL}')`).then(r => r[0]).catch(() => null);
const uid = created.userRow && created.userRow.id;
const sessionRows = uid ? await d1Read(`SELECT COUNT(*) n FROM auth_sessions WHERE user_id = ${uid}`).then(r => r[0].n).catch(() => 0) : 0;
let authBlocked = false;
if (reg.status === 500 && uid && !sessionRows) {
  // The user + profile + security_event rows landed, but createSession's jwt.sign threw: in this dev
  // env process.env.JWT_SECRET is not populated (no .dev.vars; wrangler.toml [vars] has only
  // CORS_ORIGIN/IP_RATE_LIMIT), so src/shims/jwt.js:100 createHmac('sha256', undefined) throws.
  authBlocked = true;
  blocker("B-auth-env", `register/login return 500 and mint no auth_sessions row because JWT_SECRET is absent from the running Worker's env (createHmac 'key must be string'); authenticated surface cannot be exercised here. Config gap, not a port-code defect.`);
} else if (reg.status !== 201 || !reg.json?.token) {
  defect("B-register", `register status=${reg.status} body=${hideSecrets(reg.text).slice(0, 200)}`);
}
if (!uid) { console.log("  (no user row found in D1 — aborting Phase B writes)"); }
else created.uid = uid;
created.uid = uid;
let bearer = reg.json?.token || null;
const auth = () => ({ authorization: `Bearer ${bearer}` });
if (authBlocked) console.log("  AUTH BLOCKED: no bearer token obtainable in this environment; the /me, authenticated-GET sweep, writes (profile/avatar/post/message) and refresh/logout steps are SKIPPED (see blockers).");

// B.1 /me
if (bearer) {
  const me = await j("GET", "/api/auth/me", null, auth());
  const okMe = me.status === 200 && me.json && String(me.json.id ?? me.json.user_id ?? "") === String(uid);
  console.log(`  GET /api/auth/me -> ${me.status} ok=${okMe} keys=[${me.json ? Object.keys(me.json).sort().join(",") : ""}]`);
  if (!okMe) defect("B-me", `status=${me.status} body=${hideSecrets(me.text).slice(0, 200)}`);
  // type-drift sample on the auth DTO
  if (me.json) {
    const t = {}; for (const k of Object.keys(me.json)) t[k] = Array.isArray(me.json[k]) ? "array" : typeof me.json[k];
    console.log(`      field types: id=${t.id} verified=${t.verified} created_at=${t.created_at}`);
    if (t.created_at === "string" && !/[Z+]/.test(String(me.json.created_at))) defect("B-ts-no-offset", `me.created_at has no tz marker: ${me.json.created_at}`);
    if ("verified" in me.json && t.verified !== "boolean") defect("B-bool-type", `me.verified is ${t.verified} (${JSON.stringify(me.json.verified)}), pg boolean should decode to true/false`);
  }
}

// B.2 /verify-email — only the SHA-256 hash is stored (emailTokens.issue), so the plaintext from the
// failed mail cannot be read back out of D1. To still exercise the real consume() path we insert a
// known token's hash for OUR user, POST /verify-email with the plaintext, then assert users.email_verified_at.
if (uid) {
  const bogus = await j("POST", "/api/auth/verify-email", { token: "deadbeefdeadbeefdeadbeef" });
  console.log(`  POST /api/auth/verify-email (bogus) -> ${bogus.status} envelope=${isEnvelope(bogus.json)} code=${bogus.json?.error?.code}`);
  if (bogus.status !== 400 || !isEnvelope(bogus.json) || bogus.json.error.code !== "invalid_token")
    defect("B-verify-envelope", `bogus verify-email status=${bogus.status} body=${hideSecrets(bogus.text).slice(0, 200)}`);

  const plain = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(plain).digest("hex");
  const exp = new Date(Date.now() + 15 * 60000).toISOString();
  await d1WriteBatch([{ sql: "INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (?,?,?)", params: [uid, hash, exp] }]);
  const v = await j("POST", "/api/auth/verify-email", { token: plain });
  const verified = await d1Read(`SELECT email_verified_at FROM users WHERE id = ${uid}`).then(r => r[0]);
  console.log(`  POST /api/auth/verify-email (real, inserted hash) -> ${v.status}; users.email_verified_at set=${!!(verified && verified.email_verified_at)}`);
  if (v.status !== 204) defect("B-verify-204", `status=${v.status} body=${hideSecrets(v.text).slice(0, 200)}`);
  if (!(verified && verified.email_verified_at)) defect("B-verify-row", "verify-email returned success but users.email_verified_at is still null");
  await d1WriteBatch([{ sql: "DELETE FROM email_verification_tokens WHERE user_id = ?", params: [uid] }]);
}

// B.3 authenticated GET sweep (bearer-guarded, no body needed; param paths use :1)
const authGets = [...new Set(routerEndpoints
  .filter(e => e.method === "GET" && (e.guard === "bearer") )
  .map(e => e.full))];
let gets200 = 0, gets4xx = 0, gets5xx = 0;
const gets500 = [];
if (bearer) {
  for (const p of authGets) {
    if (ONLY && !ONLY.test(p)) continue;
    const at = p.replace(/:([A-Za-z_]+)/g, seg => /username|slug/i.test(seg) ? RUN : "1");
    const r = await j("GET", at, null, auth());
    if (r.status >= 500) { gets5xx++; gets500.push({ p, status: r.status, env: isEnvelope(r.json), body: hideSecrets(r.text).slice(0, 120) }); }
    else if (r.status >= 400) { gets4xx++; if (!isEnvelope(r.json) && r.json) gets500.push({ p, status: r.status, env: false, body: "4xx not an envelope" }); }
    else gets200++;
  }
}
if (bearer) console.log(`  authenticated GET sweep: ${authGets.length} paths -> 2xx=${gets200} 4xx=${gets4xx} 5xx=${gets5xx}`);
else console.log(`  authenticated GET sweep: SKIPPED (no bearer token; ${authGets.length} guarded GET paths would be exercised)`);
for (const g of gets500.filter(x => x.status >= 500)) {
  defect(`B-get500:${g.p}`, `worker 5xx ${g.status} envelope=${g.env} body=${g.body}`);
}

// B.4 important writes, asserting BOTH response and the resulting D1 row
// profile update (PUT /api/onboarding — the transactional path, which encodes params correctly)
if (bearer && uid) {
  const pu = await j("PUT", "/api/onboarding", { title: "Diff Engineer", company: "ProbeCo", bio: "harness", website: "https://example.com", onboardingDone: true }, auth());
  const prow = await d1Read(`SELECT job_title, headline, company_name, onboarding_done FROM profiles WHERE user_id = ${uid}`).then(r => r[0]);
  console.log(`  PUT /api/onboarding -> ${pu.status}; profile row: job_title=${prow && prow.job_title} onboarding_done=${prow && prow.onboarding_done}`);
  if (pu.status !== 200) defect("B-profile", `status=${pu.status} body=${hideSecrets(pu.text).slice(0, 200)}`);
  if (!prow || prow.job_title !== "Diff Engineer") defect("B-profile-row", `expected job_title='Diff Engineer', got ${JSON.stringify(prow)}`);

  // post create
  const pc = await j("POST", "/api/posts", { content: `diff post ${RUN}` }, auth());
  const postId = pc.json && (pc.json.post?.id ?? pc.json.id ?? pc.json.data?.id);
  console.log(`  POST /api/posts -> ${pc.status} postId=${postId} idType=${typeof postId}`);
  if (pc.status >= 200 && pc.status < 300 && postId) {
    created.postId = Number(postId);
    const postRow = await d1Read(`SELECT id, user_id, content FROM posts WHERE id = ${Number(postId)}`).then(r => r[0]);
    console.log(`      posts row: user_id=${postRow && postRow.user_id} contentMatch=${!!(postRow && /diff post/.test(String(postRow.content)))}`);
    if (!postRow) defect("B-post-row", `POST returned id=${postId} but no posts row exists`);
    else if (String(postRow.user_id) !== String(uid)) defect("B-post-owner", `posts.user_id=${postRow.user_id} != our uid=${uid}`);
  } else defect("B-post", `POST /api/posts status=${pc.status} body=${hideSecrets(pc.text).slice(0, 200)}`);

  // avatar upload through the R2 path (multipart)
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
  const bd = "----diff" + RUN;
  const mp = Buffer.concat([
    Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
    png, Buffer.from(`\r\n--${bd}--\r\n`),
  ]);
  const av = await workerRequest("POST", "/api/users/me/avatar", {
    headers: Object.assign({ "content-type": `multipart/form-data; boundary=${bd}`, "user-agent": UA }, auth()),
    body: mp, timeoutMs: 60000,
  });
  const avJson = tryJson(av.bodyText);
  console.log(`  POST /api/users/me/avatar (multipart) -> ${av.status} url=${avJson && avJson.url}`);
  if (av.status >= 200 && av.status < 300 && avJson && avJson.url) {
    created.avatarUrl = avJson.url;
    const arow = await d1Read(`SELECT avatar_url FROM profiles WHERE user_id = ${uid}`).then(r => r[0]);
    const served = await workerRequest("GET", avJson.url, {});
    console.log(`      profiles.avatar_url=${arow && arow.avatar_url}; GET ${avJson.url} -> ${served.status} bytes=${served.bodyBytes} ct=${(headerCounts(served.rawHeaders).get("content-type")) ? served.rawHeaders.filter((_, i) => i % 2 === 1 && String(served.rawHeaders[i - 1]).toLowerCase() === "content-type").pop() : "?"}`);
    if (!arow || arow.avatar_url !== avJson.url) defect("B-avatar-row", `profiles.avatar_url=${arow && arow.avatar_url} != ${avJson.url}`);
    if (served.status !== 200) defect("B-avatar-r2", `uploaded object not served back (GET ${avJson.url} -> ${served.status})`);
  } else defect("B-avatar", `avatar upload status=${av.status} body=${hideSecrets(av.bodyText).slice(0, 200)}`);

  /* message send (conversation then message).  chat.js:92 reads body.userId and body.firstMessage;
     this step used to post {participant, message}, which the route rejects with
     fields.userId="Not valid" — the port behaving CORRECTLY, the harness sending the wrong keys
     (confirmed 2026-10-20 by replaying both shapes against the Worker: {participant,…} -> 400,
     {userId, firstMessage} -> 201).  The peer is a real active user read from D1 rather than a
     hard-coded id, and the conversation is deleted again in CLEANUP below (created.convId). */
  const peer = (await d1Read(`SELECT id FROM users WHERE status = 'active' AND id <> ${uid} ORDER BY id LIMIT 1`)
    .catch(() => []))[0];
  if (peer) {
    const conv = await j("POST", "/api/messages/conversations", { userId: peer.id, firstMessage: `diff msg ${RUN}` }, auth());
    const cid = conv.json && (conv.json.conversation?.id ?? conv.json.id ?? conv.json.conversationId);
    console.log(`  POST /api/messages/conversations (peer ${peer.id}) -> ${conv.status} convId=${cid}`);
    if (cid) created.convId = String(cid);
    else defect("B-conversation", `conversation create ${conv.status}: ${hideSecrets(conv.text).slice(0, 160)}`);
    const sent = cid ? await j("POST", `/api/messages/conversations/${created.convId}/messages`, { text: `diff msg 2 ${RUN}` }, auth()) : { status: 0, text: "" };
    console.log(`  POST /api/messages/conversations/{id}/messages -> ${sent.status}`);
    if (sent.status !== 200 && sent.status !== 201) defect("B-message-send", `send ${sent.status}: ${hideSecrets(sent.text).slice(0, 160)}`);
    else {
      /* the row must be readable back through the same route the app uses (chat.js:133 writes body
         from payload.text, so an empty text here would mean the write or the read is broken) */
      const room = await j("GET", `/api/messages/conversations/${created.convId}`, null, auth());
      const txt = JSON.stringify(room.json || {});
      if (!txt.includes(`diff msg 2 ${RUN}`)) defect("B-message-read", `sent message not in GET /conversations/:id (${room.status})`);
    }
  } else console.log("  POST /api/messages/conversations: SKIPPED (no active peer row in D1)");

  // admin / ops reads as a plain 'user' -> expect the guard's 403 (data is admin-only, out of scope)
  for (const p of ["/api/admin/users", "/api/admin/ops/status"]) {
    const r = await j("GET", p, null, auth());
    console.log(`  GET ${p} (role=user) -> ${r.status} code=${r.json?.error?.code}`);
    if (r.status !== 403) defect(`B-guard:${p}`, `expected 403 forbidden for non-staff, got ${r.status}`);
    else if (!isEnvelope(r.json) || r.json.error.code !== "forbidden") defect(`B-guard-env:${p}`, `403 not a forbidden envelope: ${hideSecrets(r.text).slice(0, 160)}`);
  }
}

// B.4b admin-ops GET sweep — WORKER-ONLY, adds ZERO production requests. The 403 checks above prove
// a role=user token is DENIED this surface; they prove nothing about the SQL an admin actually runs
// (§5.9: generate_series in routes/admin.js has no SQLite equivalent — a latent 500 class). So:
// promote the throwaway user by a direct D1 write through the same d1WriteBatch the verify-email
// test already uses, re-mint a token the same way the register step did (POST /api/auth/login on the
// Worker — same createSession/jwt.sign path; if login yields no token the register bearer still
// works because middleware/authenticate.js re-reads users.role on every request), sweep every GET
// endpoint in group admin-ops, then demote. CLEANUP deletes the session/audit rows this creates.
const adminGets = [...new Set(routerEndpoints
  .filter(e => e.group === "admin-ops" && e.method === "GET")
  .map(e => e.full))];
if (bearer && uid) {
  const targets = ONLY ? adminGets.filter(p => ONLY.test(p)) : adminGets;
  if (targets.length) {
    await d1WriteBatch([{ sql: "UPDATE users SET role = 'admin' WHERE id = ?", params: [uid] }]);
    const promoted = await d1Read(`SELECT role FROM users WHERE id = ${uid}`).then(r => r[0] && r[0].role).catch(() => null);
    console.log(`  promoted throwaway user (direct D1 write) -> role=${promoted}`);
    if (promoted !== "admin") defect("B-admin-promote", `role after UPDATE is ${promoted}, expected admin; sweep would 403`);
    let adminBearer = bearer;
    const lg = await j("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
    if (lg.status === 200 && lg.json && lg.json.token) { adminBearer = lg.json.token; console.log(`  login re-minted a token for the promoted user -> ${lg.status}`); }
    else console.log(`  login -> ${lg.status}; reusing register bearer (role is read from the DB per request)`);
    let a2xx = 0, a4xx = 0, a5xx = 0;
    for (const p of targets) {
      const at = p.replace(/:([A-Za-z_]+)/g, seg => /username|slug/i.test(seg) ? RUN : "1");
      const r = await j("GET", at, null, { authorization: `Bearer ${adminBearer}` });
      const mark = r.status >= 500 ? "<-- 5xx DEFECT" : r.status >= 400 ? "4xx" : "ok";
      console.log(`  GET ${at} (role=admin) -> ${String(r.status).padEnd(3)} ${mark}`);
      if (r.status >= 500) {
        a5xx++;
        const body = hideSecrets(r.text).slice(0, 400);
        console.log(`      body: ${body}`);
        defect(`B-admin500:${p}`, `worker 5xx ${r.status} envelope=${isEnvelope(r.json)} body=${body}`);
      } else if (r.status >= 400) a4xx++; else a2xx++;
    }
    console.log(`  admin-ops GET sweep: ${targets.length} paths -> 2xx=${a2xx} 4xx=${a4xx} 5xx=${a5xx}; production requests used by this sweep: 0`);
    await d1WriteBatch([{ sql: "UPDATE users SET role = 'user' WHERE id = ?", params: [uid] }])
      .catch(e => console.log(`  demote skipped: ${hideSecrets(String(e.message)).slice(0, 80)}`));
  }
}

// B.5 refresh then logout then re-verify /me is expired
if (bearer) {
  const rf = await j("POST", "/api/auth/refresh", { refreshToken: bearer });
  console.log(`  POST /api/auth/refresh -> ${rf.status} rotated=${!!rf.json?.token}`);
  if (rf.status === 200 && rf.json?.token) {
    // old token must now be invalid (token_hash rotated)
    const stale = await j("GET", "/api/auth/me", null, { authorization: `Bearer ${bearer}` });
    const fresh = await j("GET", "/api/auth/me", null, { authorization: `Bearer ${rf.json.token}` });
    console.log(`      stale token /me -> ${stale.status} (${stale.json?.error?.code}); fresh token /me -> ${fresh.status}`);
    if (fresh.status !== 200) defect("B-refresh-fresh", `refreshed token rejected: /me=${fresh.status}`);
    bearer = rf.json.token;
    if (stale.status !== 401) console.log(`      note: old token still valid after refresh (status=${stale.status}) — matches the mirror's UPDATE-by-session semantics only if hash rotated; reported for review`);
  } else if (rf.status !== 401) defect("B-refresh", `refresh status=${rf.status} body=${hideSecrets(rf.text).slice(0, 160)}`);

  const lo = await j("POST", "/api/auth/logout", {}, auth());
  const after = await j("GET", "/api/auth/me", null, auth());
  console.log(`  POST /api/auth/logout -> ${lo.status}; /me after logout -> ${after.status} (${after.json?.error?.code})`);
  if (lo.status !== 200) defect("B-logout", `logout status=${lo.status}`);
  if (after.status !== 401) defect("B-logout-revoked", `session not revoked after logout: /me=${after.status}`);
}

// B.6 trip the auth bucket Worker-side to compare the 429 envelope + Retry-After (0 production calls).
console.log("\n=== PHASE B.6: rate-limit 429 envelope (Worker-side trip only) ===");
{
  const markerIp = "203.0.113." + (7 + Math.floor(Math.random() * 3)); // TEST-NET, our own bucket
  let got429 = null, retry = null, pol = "";
  for (let i = 0; i < 130; i++) {
    const r = await workerRequest("POST", "/api/auth/login", {
      headers: { "content-type": "application/json", "user-agent": UA, "x-forwarded-for": markerIp },
      body: JSON.stringify({ email: `nope-${RUN}-${i}@example.invalid`, password: "wrongpassword" }), timeoutMs: 30000,
    });
    if (r.status === 429) { got429 = r; const hc = headerCounts(r.rawHeaders);
      const grab = n => r.rawHeaders.filter((_, k) => k % 2 === 1 && String(r.rawHeaders[k - 1]).toLowerCase() === n).pop() || "";
      retry = grab("retry-after"); pol = grab("ratelimit-policy");
      break; }
  }
  if (got429) {
    const j429 = tryJson(got429.bodyText);
    console.log(`  tripped after N failed logins -> 429 envelope=${isEnvelope(j429)} code=${j429?.error?.code} message="${hideSecrets(j429?.error?.message)}"`);
    console.log(`  Retry-After=${hideSecrets(retry)} RateLimit-Policy="${hideSecrets(pol)}" pk-partition=${/pk=:[^:]*:/.test(pol)}`);
    if (!isEnvelope(j429) || j429.error.code !== "rate_limited") defect("B-429-env", `429 not rate_limited envelope: ${hideSecrets(got429.bodyText).slice(0, 200)}`);
    if (!retry) defect("B-429-retry", "429 without Retry-After header");
    // clean the login_failed security_events this run wrote (window-scoped; never touches copied rows)
    const start = new Date(Date.now() - 30 * 60000).toISOString();
    await d1WriteBatch([{ sql: "DELETE FROM security_events WHERE event_type = 'login_failed' AND user_id IS NULL AND created_at > ?", params: [start] }]).catch(() => {});
  } else console.log("  (auth bucket not tripped within 130 attempts — configured AUTH_RATE_LIMIT is higher; RateLimit FORMAT compared on normal responses in A.2)");
}

/* ------------------------------------------------------------------ *
 *  CLEANUP — delete every row this harness created (by id / by unique email)
 * ------------------------------------------------------------------ */
console.log("\n=== CLEANUP ===");
if (created.uid) {
  const u = created.uid;
  const stmts = [
    ...(created.postId ? [{ sql: "DELETE FROM posts WHERE id = ?", params: [created.postId] }] : []),
    ...(created.convId ? [{ sql: "DELETE FROM messages WHERE conversation_id = ?", params: [created.convId] },
                          { sql: "DELETE FROM conversation_members WHERE conversation_id = ?", params: [created.convId] },
                          { sql: "DELETE FROM conversations WHERE id = ?", params: [created.convId] }] : []),
    { sql: "DELETE FROM profile_skills WHERE user_id = ?", params: [u] },
    { sql: "DELETE FROM email_verification_tokens WHERE user_id = ?", params: [u] },
    { sql: "DELETE FROM password_reset_tokens WHERE user_id = ?", params: [u] },
    { sql: "DELETE FROM profiles WHERE user_id = ?", params: [u] },
    { sql: "DELETE FROM auth_sessions WHERE user_id = ?", params: [u] },
    { sql: "DELETE FROM security_events WHERE user_id = ?", params: [u] },
    { sql: "DELETE FROM audit_logs WHERE actor_user_id = ?", params: [u] },
    { sql: "DELETE FROM notifications WHERE user_id = ?", params: [u] },
    { sql: "DELETE FROM users WHERE id = ?", params: [u] },
  ];
  for (const s of stmts) await d1WriteBatch([s]).catch(e => console.log(`  cleanup skip ${hideSecrets(e.message).slice(0, 80)}`));
  const gone = await d1Read(`SELECT COUNT(*) n FROM users WHERE id = ${u}`).then(r => r[0].n).catch(() => "?");
  console.log(`  deleted throwaway user ${u} (${EMAIL}); remaining users with that id = ${gone}`);
  const goneByEmail = await d1Read(`SELECT COUNT(*) n FROM users WHERE email = LOWER('${EMAIL}')`).then(r => r[0].n).catch(() => "?");
  console.log(`  CLEANUP PROOF: rows in users with email ${EMAIL} = ${goneByEmail} (must be 0; includes the admin-promoted throwaway)`);
  console.log(`  LEFT BEHIND (named, not removable without wrangler): R2 object ${created.avatarUrl || "(none)"}`);
} else console.log("  (no throwaway user created — nothing to clean)");

} /* end of the (!PHASE_A_ONLY) guard around Phase B .. CLEANUP */

/* ------------------------------------------------------------------ *
 *  SUMMARY
 * ------------------------------------------------------------------ */
console.log("\n=== SUMMARY ===");
console.log(`endpoints: ${definitions} router definitions, ${uniqMethodPath.length} unique (method,path), ${uniqPaths.length} unique paths`);
const gcount = {}; for (const e of allEndpoints) gcount[e.group] = (gcount[e.group] || 0) + 1;
console.log(`grouping: public=${gcount.public} anonymous-guarded=${gcount["anonymous-guarded"]} authenticated=${gcount.authenticated} admin-ops=${gcount["admin-ops"]} worker-only=${gcount["worker-only"] || 0}`);
console.log(`production requests used: ${budget.prod}/${budget.max}`);
console.log(`DEFECTS: ${DEFECTS}   BLOCKERS: ${blockers.length}`);
for (const d of defects) console.log(`  DEFECT ${d.id}: ${d.detail}`);
for (const b of blockers) console.log(`  BLOCKER ${b.id}: ${b.detail}`);
if (contentDiffs.length) {
  console.log(`\ncontent-differs detail (${contentDiffs.length}):`);
  for (const c of contentDiffs) {
    console.log(`  ${c.p}`);
    console.log(`    prod(${c.prod.s}): ${hideSecrets(c.prod.b)}`);
    console.log(`    work(${c.work.s}): ${hideSecrets(c.work.b)}`);
  }
}
process.exit((DEFECTS || blockers.length) ? 1 : 0);
