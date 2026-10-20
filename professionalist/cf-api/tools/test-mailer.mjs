/* tools/test-mailer.mjs — regression harness for the one mail path every earlier suite missed:
   services/mailer.js driving src/shims/https.js.  Production symptom (2026-10-20): every
   password-reset mail was answered 400 "bad_json" by the mail Worker, because the shim fired its
   fetch in the constructor — before mailer's req.end(body) — so the body was always empty.
   Run: node cf-api/tools/test-mailer.mjs   (no D1, no network beyond 127.0.0.1) */
import http from "node:http";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let passed = 0;
const fails = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { fails.push(name); console.log(`  FAIL  ${name}: ${err.message}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A stand-in for the mail Worker: records every hit and can answer any behaviour. */
function startServer(handler) {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits.push({ method: req.method, url: req.url, headers: req.headers, body });
        handler(req, res, hits.length);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, hits, port: server.address().port }));
  });
}

/* Fresh require per scenario so nothing leaks between env changes.  The filter must catch BOTH
   the shim (src/shims/https.js) and its port forwarder (port/_shim/https.js, which
   services/mailer.js actually requires): a cached forwarder keeps re-exporting the FIRST
   scenario's shim, still wired to that scenario's background module, so arm/track calls from a
   later scenario's drain() would watch an empty queue. */
function loadMailer() {
  for (const key of Object.keys(require.cache)) {
    if (/shims?[/\\]https|services[/\\]mailer|background\.js/.test(key)) delete require.cache[key];
  }
  return require("../port/services/mailer.js");
}

async function scenario(name, handler, mutateEnv, probe) {
  const { server, hits, port } = await startServer(handler);
  const mailer = loadMailer();
  const envBackup = {};
  for (const k of ["MAILER_API_URL", "MAILER_API_TOKEN", "MAILER_ENABLED", "MAILER_TIMEOUT_MS"]) {
    envBackup[k] = process.env[k];
  }
  process.env.MAILER_API_URL = `http://127.0.0.1:${port}/send`;
  process.env.MAILER_API_TOKEN = "test-mailer-token";
  process.env.MAILER_ENABLED = "true";
  delete process.env.MAILER_TIMEOUT_MS;
  try {
    await probe({ mailer, hits, port });
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err.message}`);
    fails.push(name);
  } finally {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    server.close();
  }
}

const okHandler = (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); };

/* 1 — THE regression itself: end(body) must arrive verbatim at the mail Worker. */
await scenario("send delivers the full JSON body", okHandler, null, async ({ mailer, hits }) => {
  const accepted = mailer.send("reset-password", {
    to: "someone@example.com",
    name: "Someone",
    params: { token: "a".repeat(64), expires_in: "1 hour" },
    idempotencyKey: "reset:7:abc",
  });
  assert(accepted, "mailer.send should return true (it accepted the job)");
  const background = require("../src/background.js");
  await background.drain(4000);
  assert.strictEqual(hits.length, 1, `expected exactly 1 hit, saw ${hits.length}`);
  const hit = hits[0];
  assert.strictEqual(hit.method, "POST");
  assert.strictEqual(hit.url, "/send");
  const payload = JSON.parse(hit.body); // threw before the fix: body was ""
  assert.strictEqual(payload.template, "reset-password");
  assert.strictEqual(payload.to, "someone@example.com");
  assert.strictEqual(payload.params.token.length, 64);
  assert.strictEqual(hit.headers.authorization, "Bearer test-mailer-token");
  assert.strictEqual(hit.headers["x-idempotency-key"], "reset:7:abc");
  assert.strictEqual(hit.headers["content-type"], "application/json");
});

/* 2 — non-2xx: logged, no retry storm (4xx short-circuit in mailer.js:112), and a 4xx must NOT
       arm the retry window — drain has to come back promptly. */
await scenario("4xx answer is tried once, not retried", (req, res) => {
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end('{"ok":false,"error":"forbidden"}');
}, null, async ({ mailer, hits }) => {
  mailer.send("verify-email", { to: "x@example.com", params: { token: "b".repeat(64) } });
  const background = require("../src/background.js");
  const t0 = Date.now();
  await background.drain(4000);
  assert(Date.now() - t0 < 2500, "4xx must not arm the retry window");
  await sleep(200);
  assert.strictEqual(hits.length, 1, `403 should not be retried, saw ${hits.length} hits`);
});

/* 3 — 5xx: retried with the documented backoff (3 attempts total).  Polled on the server side
       rather than via drain: drain(20000) would also cover it now that a 5xx arms the retry
       window (scenario 5), but the all-503 case keeps arming the window after every attempt and
       polling stays independent of that bookkeeping. */
await scenario("5xx answer is retried up to 3 attempts", (req, res) => {
  res.writeHead(503);
  res.end("nope");
}, null, async ({ mailer, hits }) => {
  mailer.send("welcome", { to: "y@example.com", params: {} });
  const start = Date.now();
  while (hits.length < 3 && Date.now() - start < 15000) await sleep(200);
  assert.strictEqual(hits.length, 3, `expected 3 attempts, saw ${hits.length}`);
});

/* 4 — the get()-style flow of the shim must also actually send and read the response. */
await scenario("shim GET reaches the server and the body comes back", okHandler, null, async ({ hits, port }) => {
  const https = require("../src/shims/https.js");
  const text = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: "127.0.0.1", port, path: "/sentinel", method: "GET" }, (res) => {
      let acc = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (acc += c));
      res.on("end", () => resolve(acc));
    });
    req.on("error", reject);
    req.end();
  });
  assert.strictEqual(JSON.parse(text).ok, true);
  assert.strictEqual(hits.length, 1, `GET should land once, saw ${hits.length}`);
  assert.strictEqual(hits[0].method, "GET");
});

/* 5 — the §5.22 limitation itself: drain() used to resolve inside mailer's untracked 1500 ms
       backoff and freeze attempts 2-3 with it.  A 5xx must arm the retry window so a single
       drain(20000) waits through the sleep and sees the second attempt land.
       Against the pre-fix background.js this fails with "saw 1 hit". */
await scenario("drain survives the 5xx retry gap (503 then 200)", (req, res, n) => {
  if (n === 1) { res.writeHead(503); res.end("nope"); }
  else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); }
}, null, async ({ mailer, hits }) => {
  mailer.send("reset-password", { to: "z@example.com", params: { token: "c".repeat(64) } });
  const background = require("../src/background.js");
  const t0 = Date.now();
  await background.drain(20000);
  assert.strictEqual(hits.length, 2, `drain should have waited out the retry, saw ${hits.length} hit(s)`);
  assert(Date.now() - t0 >= 1400, "drain returning before the 1500ms backoff even elapsed means it ignored the window");
});

console.log(`\ntest-mailer: ${passed}/${passed + fails.length} passed${fails.length ? ` — FAILED: ${fails.join(", ")}` : ""}`);
process.exit(fails.length ? 1 : 0);
