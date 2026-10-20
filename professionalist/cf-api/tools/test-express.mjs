/* Verify cf-api/src/shims/express.js by rebuilding server.js's mounting with it.

   The shim is only worth having if the app's route ordering still behaves: server.js:153-158 says
   routes/spa MUST come before platform.js because platform matches /posts/:id and /marketplace/:id,
   which would otherwise swallow /posts/feed and /marketplace/home. That ordering is the single most
   dangerous thing a hand-written router could get wrong, so it is the first test, not a footnote.
   node cf-api/tools/test-express.mjs */
import { createRequire } from "node:module";
import http from "node:http";
import { oracle } from "./oracle.mjs";

const require = createRequire(import.meta.url);
const express = require("../src/shims/express.js");
const expressReal = require(oracle("express"));

let PASS = 0; const FAILS = [];
const check = (name, ok, detail) => {
  if (ok) { PASS++; console.log(`  ok    ${name}${detail ? ` -> ${String(detail).slice(0, 100)}` : ""}`); }
  else { FAILS.push(name); console.log(`  FAIL  ${name}${detail ? ` -> ${String(detail).slice(0, 180)}` : ""}`); }
};
const go = async (app, method, url, { headers = {}, body } = {}) => {
  const request = new Request(`https://api.proffessionalist.com${url}`, {
    method, headers: { ...headers }, body,
  });
  try {
    const res = await app.handle(request, {}, {});
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  } catch (err) {
    return { status: 0, error: err };
  }
};

console.log("== matching and ordering ==");
{
  const app = express();
  const spa = express.Router();
  spa.get("/posts/feed", (req, res) => res.json({ route: "feed" }));
  const platform = express.Router();
  platform.get("/posts/:id", (req, res) => res.json({ route: "post", id: req.params.id }));
  app.use("/api", spa, platform);

  const feed = await go(app, "GET", "/api/posts/feed");
  check("a literal registered first beats the :param route behind it (server.js:153's rule)",
    feed.json?.route === "feed", JSON.stringify(feed.json));
  const one = await go(app, "GET", "/api/posts/42");
  check("...and the :param route still answers everything else", one.json?.route === "post" && one.json.id === "42", JSON.stringify(one.json));
  const missing = await go(app, "GET", "/api/nothing/here");
  check("unmatched falls out of the stack instead of matching wrongly", missing.status === 0 && /No handler answered/.test(String(missing.error?.message)), String(missing.error?.message).slice(0, 60));
}
{
  const app = express();
  const r = express.Router();
  r.get("/a/:x/b/:y", (req, res) => res.json(req.params));
  r.post("/a/:x/b/:y", (req, res) => res.json({ hit: "post" }));
  app.use("/", r);
  const p = await go(app, "GET", "/a/1/b/two");
  check("two params in one path both land", p.json?.x === "1" && p.json?.y === "two", JSON.stringify(p.json));
  const enc = await go(app, "GET", "/a/1/b/two%20words");
  check("params are percent-decoded", enc.json?.y === "two words", JSON.stringify(enc.json));
  const wrong = await go(app, "GET", "/a/1/b/two/extra");
  check("an extra segment is NOT swallowed by a :param route", wrong.status === 0, String(wrong.error?.message).slice(0, 40));
  const off = await go(app, "DELETE", "/a/1/b/two");
  check("method mismatch does not match", off.status === 0, String(off.error?.message).slice(0, 40));
  const on = await go(app, "POST", "/a/1/b/two");
  check("method match does", on.json?.hit === "post", JSON.stringify(on.json));
}

console.log("\n== middleware chain, req.user and error flow ==");
{
  const app = express();
  const seen = [];
  app.use((req, res, next) => { seen.push("one"); req.user = { sub: "7" }; next(); });
  const r = express.Router();
  r.use((req, res, next) => { seen.push("two"); next(); });
  r.get("/me", (req, res) => res.json({ user: req.user, order: seen }));
  app.use("/api", r);
  const me = await go(app, "GET", "/api/me");
  check("req.user set by a middleware outside the router is visible inside it",
    me.json?.user?.sub === "7" && me.json?.order?.join(",") === "one,two", JSON.stringify(me.json));
}
{
  const app = express();
  app.use("/api", (req, res, next) => {
    const err = new Error("session has ended"); err.status = 401; throw err;
  });
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: { message: err.message } }));
  const out = await go(app, "GET", "/api/x");
  check("a thrown error reaches the 4-arity error middleware, not the 500 path",
    out.status === 401 && out.json?.error?.message === "session has ended", `${out.status} ${out.text}`);
}
{
  const app = express();
  const order = [];
  app.use("/api", (req, res, next) => { order.push("m1"); next(); });
  app.use((req, res, next) => { order.push("m2"); res.json({ order }); });
  const out = await go(app, "GET", "/api/z");
  check("middleware that does not match the mount prefix is skipped, matching ones run in order",
    out.json?.order?.join(",") === "m1,m2", JSON.stringify(out.json));
}
{
  /* a handler that answers nothing and calls nothing must end the chain the way Express does */
  const app = express();
  app.get("/quiet", (req, res) => { res.status(204).send(); });
  app.get("/quiet", (req, res) => res.json({ second: true }));
  const out = await go(app, "GET", "/quiet");
  check("the first handler to respond wins; later layers never run", out.status === 204, String(out.status));
}
{
  const app = express();
  app.get("/boom", async () => { throw new Error("rejected async"); });
  app.use((err, req, res, next) => res.status(500).json({ message: err.message }));
  const out = await go(app, "GET", "/boom");
  check("an async handler's rejection is caught (Express 5 behaviour the routes depend on)",
    out.status === 500 && out.json?.message === "rejected async", out.text);
}

console.log("\n== request and response objects ==");
{
  const app = express();
  app.use(express.json({ limit: process.env?.BODY_LIMIT || "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.post("/echo", (req, res) => res.json({
    body: req.body, query: req.query, auth: req.get("Authorization"), ip: req.ip,
    method: req.method, originalUrl: req.originalUrl, params: req.params,
  }));
  const json = await go(app, "POST", "/echo?tag=a&tag=b&n=3", {
    headers: { "content-type": "application/json", authorization: "Bearer tok", "x-forwarded-for": "203.0.113.9, 198.51.100.4" },
    body: JSON.stringify({ hello: "world", deep: { x: 1 } }),
  });
  check("json body parsed, query repeated keys become arrays, originalUrl keeps the query",
    json.json?.body?.hello === "world" && json.json?.body?.deep?.x === 1 &&
    json.json?.query?.tag?.join(",") === "a,b" && json.json?.query?.n === "3" && json.json?.originalUrl === "/echo?tag=a&tag=b&n=3",
    JSON.stringify(json.json?.query));
  check("req.get is case-insensitive and req.ip is the visitor, not the proxy (trust proxy 1)",
    json.json?.auth === "Bearer tok" && json.json?.ip === "203.0.113.9", `ip=${json.json?.ip}`);

  const form = await go(app, "POST", "/echo", {
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=ada&kind=x",
  });
  check("urlencoded body parsed", form.json?.body?.name === "ada", JSON.stringify(form.json?.body));

  const bad = await go(app, "POST", "/echo", { headers: { "content-type": "application/json" }, body: "{oops" });
  /* body-parser forwards the SyntaxError's own text — measured live on api.proffessionalist.com
     2026-10-19: "Expected ':' after property name in JSON at position 9" — and the app's error
     middleware puts it in the envelope the SPA shows, so the shim must not reword it. */
  check("invalid json is a 400 entity.parse.failed whose message is the parser's own",
    bad.status === 0 && bad.error?.code === "entity.parse.failed" && bad.error?.status === 400 &&
    /at position \d+/.test(String(bad.error?.message)), `${bad.error?.code} ${String(bad.error?.message)}`);
}
{
  const parser = express.json({ limit: "1kb" });
  const req = { get: () => "application/json", text: async () => "x".repeat(5000) };
  let err = null;
  await parser(req, {}, e => { err = e; });
  check("the body limit rejects the way body-parser does", err && err.status === 413, err && `${err.status} ${err.message}`);
}
{
  const app = express();
  app.get("/t", (req, res) => res.status(429).set("retry-after", "30").json({ error: { code: "rate_limited" } }));
  const out = await go(app, "GET", "/t");
  check("status + setHeader + json all survive into the Response",
    out.status === 429 && out.headers.get("retry-after") === "30" && /application\/json/.test(out.headers.get("content-type") || ""),
    `${out.status} ${out.headers.get("content-type")}`);
  const app2 = express();
  app2.get("/h", (req, res) => res.send("plain text"));
  const out2 = await go(app2, "GET", "/h");
  check("res.send of a string answers as html, like Express", out2.text === "plain text" && /text\/html/.test(out2.headers.get("content-type")), out2.headers.get("content-type"));
}
{
  const app = express();
  let calls = 0;
  app.get("/multi", (req, res, next) => { calls++; next(); }, (req, res, next) => { calls++; next(); }, (req, res) => { calls++; res.json({ calls }); });
  const out = await go(app, "GET", "/multi");
  check("a route's handler list runs in sequence through next()", out.json?.calls === 3, JSON.stringify(out.json));
}
{
  const app = express();
  check("app.listen refuses instead of pretending to bind a port", (() => { try { app.listen(5000); return false; } catch { return true; } })());
  check("express.static refuses: /uploads is R2's job in the Worker", (() => { try { express.static("/x"); return false; } catch { return true; } })());
}

/* ------------------------------------------------------------------ *
 * the headers Express puts on every answer: ETag, Content-Length, 304
 * ------------------------------------------------------------------ */
{
  /* the same eight handlers on both stacks, so a difference can only be the shim's */
  const HANDLERS = [
    ["json 200", "/json", (res) => res.json({ hello: "world", n: 1 })],
    ["json 201", "/created", (res) => res.status(201).json({ created: true })],
    ["empty object", "/empty", (res) => res.json({})],
    ["unicode body", "/unicode", (res) => res.json({ t: "é✓" })],
    ["string send", "/text", (res) => res.send("plain text")],
    ["error envelope", "/bad", (res) => res.status(400).json({ error: { code: "x" } })],
    ["no content", "/none", (res) => res.status(204).end()],
    ["empty 200", "/zero", (res) => res.status(200).send()],
    ["no-store json", "/nostore", (res) => { res.set("Cache-Control", "no-store"); res.json({ a: 1 }); }],
    ["route-set etag", "/mine", (res) => { res.set("ETag", '"mine"'); res.json({ a: 1 }); }],
  ];

  const real = expressReal();
  real.disable("x-powered-by");
  for (const [label, at, fn] of HANDLERS) { real.get(at, (req, res) => fn(res)); real.post(at, (req, res) => fn(res)); }
  const realServer = http.createServer(real);
  await new Promise(resolve => realServer.listen(0, "127.0.0.1", resolve));
  const raw = (at, { method = "GET", headers = {} } = {}) => new Promise((resolve, reject) => {
    /* node's fetch silently refuses to send If-None-Match (it is on the forbidden-header list),
       which would make the VPS look like it ignored revalidation when only the client did */
    const request = http.request({ host: "127.0.0.1", port: realServer.address().port, path: at, method, headers }, response => {
      const chunks = [];
      response.on("data", c => chunks.push(c));
      response.on("end", () => resolve({
        status: response.statusCode,
        etag: response.headers.etag,
        length: response.headers["content-length"],
        type: response.headers["content-type"],
        cache: response.headers["cache-control"],
        body: Buffer.concat(chunks).toString(),
      }));
    });
    request.on("error", reject);
    request.end();
  });

  const mine = express();
  mine.disable("x-powered-by");
  for (const [label, at, fn] of HANDLERS) { mine.get(at, (req, res) => fn(res)); mine.post(at, (req, res) => fn(res)); }
  const viaShim = async (at, { method = "GET", headers = {} } = {}) => {
    const answer = await mine.handle(new Request(`https://api.proffessionalist.com${at}`, { method, headers }), {}, {});
    const body = await answer.text();
    return {
      status: answer.status,
      etag: answer.headers.get("etag") || undefined,
      length: answer.headers.get("content-length") || undefined,
      type: answer.headers.get("content-type") || undefined,
      cache: answer.headers.get("cache-control") || undefined,
      body,
    };
  };

  console.log("== the entity headers express adds, reproduced ==");
  for (const [label, at] of HANDLERS) {
    const theirs = await raw(at);
    const ours = await viaShim(at);
    check(`${label}: status, etag, content-length, content-type and body all agree`,
      theirs.status === ours.status && theirs.etag === ours.etag && theirs.length === ours.length &&
      theirs.type === ours.type && theirs.body === ours.body,
      `worker ${JSON.stringify(ours)}\n          vps    ${JSON.stringify(theirs)}`);
  }

  const first = await raw("/json");
  const firstMine = await viaShim("/json");
  check("the etag is the body's own: weak, hex length, unpadded base64 sha1",
    /^W\/"[0-9a-f]+-[A-Za-z0-9+/]{27}"$/.test(String(first.etag)) && first.etag === firstMine.etag,
    `${first.etag} vs ${firstMine.etag}`);

  const condVps = await raw("/json", { headers: { "if-none-match": first.etag } });
  const condMine = await viaShim("/json", { headers: { "if-none-match": firstMine.etag } });
  check("a conditional GET gets the same bare 304 on both stacks",
    condVps.status === 304 && condMine.status === 304 && condVps.body === "" && condMine.body === "" &&
    condVps.etag === condMine.etag && condVps.length === condMine.length && condVps.type === condMine.type,
    `worker ${JSON.stringify(condMine)}\n          vps    ${JSON.stringify(condVps)}`);

  const headVps = await raw("/json", { method: "HEAD" });
  const headMine = await viaShim("/json", { method: "HEAD" });
  check("HEAD describes the body without sending it, length included",
    headVps.status === headMine.status && headVps.length === headMine.length && headVps.etag === headMine.etag &&
    headMine.body === "",
    `worker ${headMine.status} len=${headMine.length} | vps ${headVps.status} len=${headVps.length}`);

  const postVps = await raw("/json", { method: "POST", headers: { "if-none-match": first.etag } });
  const postMine = await mine.handle(new Request("https://api.proffessionalist.com/json", { method: "POST", headers: { "if-none-match": firstMine.etag } }), {}, {});
  check("a POST is never answered with a 304, however well its If-None-Match matches",
    postVps.status === postMine.status && postMine.status === 200, `${postVps.status} vs ${postMine.status}`);

  const starMine = await viaShim("/json", { headers: { "if-none-match": "*" } });
  check("If-None-Match: * revalidates anything, as it does on the VPS", starMine.status === 304, String(starMine.status));

  const mismatchVps = await raw("/json", { headers: { "if-none-match": 'W/"7-aaaaaaaaaaaaaaaaaaaaaaaaaaa"' } });
  const mismatchMine = await viaShim("/json", { headers: { "if-none-match": 'W/"7-aaaaaaaaaaaaaaaaaaaaaaaaaaa"' } });
  check("a stale etag gets the full body back from both", mismatchVps.status === mismatchMine.status &&
    mismatchMine.status === 200 && mismatchMine.body === first.body, `${mismatchVps.status} vs ${mismatchMine.status}`);

  realServer.close();
}


console.log(`\nVERDICT: ${PASS} passed, ${FAILS.length} failed`);
if (FAILS.length) { for (const f of FAILS) console.log(`  - ${f}`); process.exit(1); }
console.log("the router reproduces server.js's mounting semantics; route files can move here unedited.");
