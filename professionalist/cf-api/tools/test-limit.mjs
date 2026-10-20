/* Differential harness for shims/limit.js: the same limiter options are mounted on a real
   express 5 + express-rate-limit 8 app over HTTP, and on shims/express + the DO counter, then the
   two answers are compared request by request (status, SPA error envelope, RateLimit /
   RateLimit-Policy / Retry-After headers).
   Anything the visitor or their HTTP client can see has to match, because the whole migration is
   judged on users not noticing the hostname flip.
   Oracles live outside the repo:  cd /tmp/rl-oracle && npm i express@5 express-rate-limit@8
   node cf-api/tools/test-limit.mjs */
import { createRequire } from "node:module";
import { oracle } from "./oracle.mjs";
import { createHash } from "node:crypto";
import http from "node:http";

const require = createRequire(import.meta.url);
const expressReal = require(oracle("express"));
const rateLimitReal = require(oracle("express-rate-limit"));
const upstreamKeyGenerator = rateLimitReal.ipKeyGenerator;
const shim = require("../src/shims/express.js");
const limit = require("../src/shims/limit.js");

let PASS = 0; const FAILS = [];
const check = (name, ok, detail) => {
  if (ok) { PASS++; console.log(`  ok    ${name}`); }
  else { FAILS.push(name); console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

const ENVELOPE = (res, status, code, message) =>
  res.status(status).json({ error: { code, message, fields: {} } });

const DRAFT8 = { standardHeaders: "draft-8", legacyHeaders: false };
const settle = () => new Promise(done => setTimeout(done, 15));

/* ------------------------------------------------------------------ *
 * the Worker side: a fake Durable Object running the shipped counter code
 * ------------------------------------------------------------------ */
function fakeCounters() {
  const state = new Map();
  const env = {
    RATE_COUNTERS: {
      idFromName: () => "fake-id",
      /* a real DO stub normalises (url, init) into a Request before the class sees it */
      get: () => ({
        fetch: async (input, init) =>
          Response.json(limit.handleCountMessage(state, await new Request(input, init).json())),
      }),
    },
  };
  return { env, state };
}

function workerApp(limiters) {
  const app = shim.createApp();
  app.set("trust proxy", 1);
  for (const options of limiters) app.use(limit.rateLimit(options));
  app.get("/ok", (req, res) => res.json({ ok: true }));
  app.get("/bad", (req, res) => res.status(404).json({ error: { code: "not_found", message: "nope", fields: {} } }));
  return app;
}

/* ------------------------------------------------------------------ *
 * the VPS side: real express, real express-rate-limit, real sockets
 * ------------------------------------------------------------------ */
function realApp(limiters) {
  const app = expressReal();
  app.set("trust proxy", 1);
  for (const options of limiters) app.use(rateLimitReal(options));
  app.get("/ok", (req, res) => res.json({ ok: true }));
  app.get("/bad", (req, res) => res.status(404).json({ error: { code: "not_found", message: "nope", fields: {} } }));
  return new Promise(resolve => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      url: path => `http://127.0.0.1:${server.address().port}${path}`,
    }));
  });
}

const RATE_HEADERS = ["ratelimit", "ratelimit-policy", "retry-after"];
const interesting = headers => {
  const out = {};
  for (const name of RATE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
};

/**
 * Replay one scripted visit against both stacks, in the same order, so the two counters see the
 * same sequence.  The 15 ms gap lets a skipSuccessfulRequests decrement (which runs after the
 * answer is on its way) land before the next request reads the bucket.
 */
async function againstBoth(limiters, requests) {
  const { env, state } = fakeCounters();
  limit.init(env);
  const app = workerApp(limiters);
  const { server, url } = await realApp(limiters);
  const mine = [], theirs = [];
  try {
    for (const { ip, path } of requests) {
      const answer = await app.handle(
        new Request(`https://api.proffessionalist.com${path}`, { headers: { "x-forwarded-for": ip } }),
        env, { waitUntil: () => {} });
      mine.push({ status: answer.status, body: await answer.text(), headers: interesting(answer.headers) });
      await settle();

      const real = await fetch(url(path), { headers: { "x-forwarded-for": ip } });
      theirs.push({ status: real.status, body: await real.text(), headers: interesting(real.headers) });
      await settle();
    }
  } finally {
    server.close();
  }
  return { mine, theirs, state };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (a, b) => `worker: ${JSON.stringify(a)}\n          vps:    ${JSON.stringify(b)}`;

/* ------------------------------------------------------------------ *
 * 1. the three server.js buckets, hit the way the SPA would
 * ------------------------------------------------------------------ */
console.log("== server.js's buckets, mounted in its order ==");
{
  const limiters = [
    { windowMs: 15 * 60 * 1000, limit: 3000, ...DRAFT8,
      handler: (req, res) => ENVELOPE(res, 429, "rate_limited", "You have sent too many requests. Please wait a moment.") },
    { windowMs: 60 * 1000, limit: 2, ...DRAFT8,
      keyGenerator: req => "u:" + (req.get("x-user") || "anonymous"),
      handler: (req, res) => ENVELOPE(res, 429, "rate_limited", "You have sent too many requests. Please wait a moment.") },
  ];
  const script = [
    { ip: "203.0.113.9", path: "/ok" },
    { ip: "203.0.113.9", path: "/ok" },
    { ip: "203.0.113.9", path: "/ok" },
    { ip: "203.0.113.9", path: "/ok" },
    { ip: "198.51.100.4", path: "/ok" },
  ];
  const { mine, theirs } = await againstBoth(limiters, script);
  check("statuses agree request for request, including where the per-user bucket closes",
    same(mine.map(r => r.status), theirs.map(r => r.status)), show(mine.map(r => r.status), theirs.map(r => r.status)));
  check("the error envelope the SPA parses is byte-identical",
    same(mine.map(r => r.body), theirs.map(r => r.body)), show(mine.map(r => r.body), theirs.map(r => r.body)));
  for (let i = 0; i < script.length; i++) {
    check(`request ${i + 1}: RateLimit / RateLimit-Policy agree, including both buckets on one response`,
      same(mine[i].headers, theirs[i].headers), show(mine[i].headers, theirs[i].headers));
  }
  check("the blocked request carries the same Retry-After",
    !!mine[3].headers["retry-after"] && mine[3].headers["retry-after"] === theirs[3].headers["retry-after"],
    show(mine[3].headers, theirs[3].headers));
  check("and an unblocked request carries none",
    !("retry-after" in mine[0].headers) && !("retry-after" in theirs[0].headers));
}

/* ------------------------------------------------------------------ *
 * 2. per-client isolation
 * ------------------------------------------------------------------ */
console.log("\n== one address's traffic never spends another's allowance ==");
{
  const limiters = [{ windowMs: 60_000, limit: 1, ...DRAFT8,
    handler: (req, res) => ENVELOPE(res, 429, "rate_limited", "slow down") }];
  const { mine, theirs } = await againstBoth(limiters, [
    { ip: "203.0.113.9", path: "/ok" }, { ip: "198.51.100.4", path: "/ok" },
    { ip: "203.0.113.9", path: "/ok" }, { ip: "198.51.100.4", path: "/ok" },
  ]);
  check("each address gets one hit, then one block",
    mine.map(r => r.status).join() === "200,200,429,429" && same(mine.map(r => r.status), theirs.map(r => r.status)),
    show(mine.map(r => r.status), theirs.map(r => r.status)));
  check("two distinct partition keys, matching the package's",
    same(mine.map(r => r.headers), theirs.map(r => r.headers)), show(mine.map(r => r.headers), theirs.map(r => r.headers)));
}

/* ------------------------------------------------------------------ *
 * 3. IPv6 grouping — measured against the package's own key generator
 * ------------------------------------------------------------------ */
console.log("\n== IPv6 /56 grouping ==");
{
  const addresses = [
    "2600:1f14:abcd:ef01::11", "2600:1f14:abcd:ef02::22", "2600:1f14:abcd:ff01::33",
    "2001:db8:abcd:1234::1", "2001:db8::", "::1", "::", "::ffff:203.0.113.9",
    "203.0.113.9", "fe80::1", "fd00:1234:5678:9abc:def0::",
  ];
  /* rateLimitReal.ipKeyGenerator is the very function the package's default keyGenerator calls */
  const drift = addresses
    .map(ip => ({ ip, upstream: upstreamKeyGenerator(ip), mine: limit.ipKeyGenerator(ip) }))
    .filter(r => r.upstream !== r.mine);
  check(`the same address yields the same bucket key on both stacks (${addresses.length} addresses)`,
    drift.length === 0, drift.map(d => `${d.ip}: vps=${d.upstream} worker=${d.mine}`).join("\n          "));

  const limiters = [{ windowMs: 60_000, limit: 1, ...DRAFT8,
    handler: (req, res) => ENVELOPE(res, 429, "rate_limited", "slow down") }];
  const { mine, theirs } = await againstBoth(limiters, [
    { ip: "2600:1f14:abcd:ef01::11", path: "/ok" },
    { ip: "2600:1f14:abcd:ef02::22", path: "/ok" },
    { ip: "2600:1f14:abcd:ff01::33", path: "/ok" },
  ]);
  check("a renumbered home address does not buy a second request, on either stack",
    mine.map(r => r.status).join() === "200,429,200" && same(mine.map(r => r.status), theirs.map(r => r.status)),
    show(mine.map(r => r.status), theirs.map(r => r.status)));
  check("and the header strings for IPv6 visitors match too",
    same(mine.map(r => r.headers), theirs.map(r => r.headers)), show(mine.map(r => r.headers), theirs.map(r => r.headers)));
}

/* ------------------------------------------------------------------ *
 * 4. skipSuccessfulRequests — the auth bucket counts failures only
 * ------------------------------------------------------------------ */
console.log("\n== the auth bucket counts failures only ==");
{
  const auth = [{ windowMs: 15 * 60 * 1000, limit: 2, ...DRAFT8, skipSuccessfulRequests: true,
    handler: (req, res) => ENVELOPE(res, 429, "rate_limited", "Too many attempts. Please try again in a few minutes.") }];
  const failures = ["/bad", "/bad", "/ok", "/ok", "/bad"];
  const { mine, theirs } = await againstBoth(auth, failures.map(path => ({ ip: "203.0.113.9", path })));
  check("two failed logins and what follows behave the same",
    same(mine.map(r => r.status), theirs.map(r => r.status)), show(mine.map(r => r.status), theirs.map(r => r.status)));

  const busy = ["/bad", "/ok", "/ok", "/ok", "/ok", "/ok", "/ok", "/bad", "/bad"];
  const second = await againstBoth(auth, busy.map(path => ({ ip: "198.51.100.7", path })));
  check("a successful login gives its slot back, so normal use never hits this limit",
    same(second.mine.map(r => r.status), second.theirs.map(r => r.status)) &&
    second.mine.slice(0, 8).every(r => r.status !== 429),
    show(second.mine.map(r => r.status), second.theirs.map(r => r.status)));
  check("but the third failure in the window is refused identically",
    second.mine[8].status === second.theirs[8].status && second.mine[8].status === 429,
    show(second.mine[8], second.theirs[8]));
}

/* ------------------------------------------------------------------ *
 * 5. the window rolls over
 * ------------------------------------------------------------------ */
console.log("\n== window expiry ==");
{
  /* limit 2 rather than 1, so a restarted count (r=1) is distinguishable from a continuing one */
  const limiters = [{ windowMs: 1200, limit: 2, ...DRAFT8,
    handler: (req, res) => ENVELOPE(res, 429, "rate_limited", "slow down") }];
  const first = await againstBoth(limiters, [1, 2, 3].map(() => ({ ip: "203.0.113.9", path: "/ok" })));
  check("blocked once the window is full, on both sides",
    first.mine.map(r => r.status).join() === "200,200,429" &&
    same(first.mine.map(r => r.status), first.theirs.map(r => r.status)),
    show(first.mine.map(r => r.status), first.theirs.map(r => r.status)));

  const { env } = fakeCounters();
  limit.init(env);
  const app = workerApp(limiters);
  await new Promise(done => setTimeout(done, 1300));
  const after = await app.handle(
    new Request("https://api.proffessionalist.com/ok", { headers: { "x-forwarded-for": "203.0.113.9" } }),
    env, { waitUntil: () => {} });
  const afterHeaders = interesting(after.headers);
  check("served again once the window has passed", after.status === 200, `worker=${after.status}`);
  check("on a count that started over, not one added to the old window",
    /^"2-in-1\.2sec"; r=1; t=(1|2)$/.test(afterHeaders.ratelimit || ""), JSON.stringify(afterHeaders));
}

/* ------------------------------------------------------------------ *
 * 6. draft-8 header internals, derived rather than copied
 * ------------------------------------------------------------------ */
console.log("\n== draft-8 header internals ==");
{
  const { env } = fakeCounters();
  limit.init(env);
  const app = workerApp([{ windowMs: 90_000, limit: 7, ...DRAFT8 }]);
  const answer = await app.handle(
    new Request("https://api.proffessionalist.com/ok", { headers: { "x-forwarded-for": "203.0.113.9" } }),
    env, { waitUntil: () => {} });
  const policy = answer.headers.get("ratelimit-policy");
  const rate = answer.headers.get("ratelimit");
  const expectPk = Buffer.from(createHash("sha256").update("203.0.113.9").digest("hex").slice(0, 12)).toString("base64");
  check('the bucket name is the default "{limit}-in-{duration}" identifier',
    /^"7-in-1\.5min"; /.test(policy), policy);
  check("q=, w= and pk= carry the limit, the rounded window and the sha256 partition key",
    policy.includes(`q=7; w=90; pk=:${expectPk}:`), `${policy}\n          expected pk=:${expectPk}:`);
  check("the RateLimit entry counts the hit down and puts the reset inside the window",
    /^"7-in-1\.5min"; r=6; t=(89|90)$/.test(rate), rate);
  check("a single limiter leaves exactly one entry per header",
    !rate.includes(",") && !policy.includes(","), `${rate} | ${policy}`);
}

console.log(`\nVERDICT: ${PASS} passed, ${FAILS.length} failed`);
if (FAILS.length) { for (const f of FAILS) console.log(`  - ${f}`); process.exit(1); }
console.log("the three server.js buckets behave identically on the Worker, headers included.");
