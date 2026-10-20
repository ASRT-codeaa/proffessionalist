/* Differential harness for shims/upload.js.
   Left: the VPS's own middleware/upload.js (copied out of the mirror so its UPLOAD_ROOT lands in a
   temp directory) driving real multer 2 and real express.static over real sockets.
   Right: shims/upload.js against a fake R2, mounted on shims/express.
   Both apps mount the same paths and echo the same thing about what they received, so a difference
   can only come from the middleware itself.
   Compared: the status and error envelope of each multer failure mode, the shape of req.file /
   req.files, the bytes that get stored, the object key naming, the headers a browser receives when
   it asks for the file back (Range and conditional revalidation included, because the video player
   depends on them), and removeStored.
   node cf-api/tools/test-upload.mjs */
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { oracle, scratch } from "./oracle.mjs";

const require = createRequire(import.meta.url);
const expressReal = require(oracle("express"));
const shim = require("../src/shims/express.js");
const upload = require("../src/shims/upload.js");

/* middleware/upload.js puts its files at path.join(__dirname, "..", "uploads"), so the copy that
   drives real multer lives one directory below the scratch root it writes into */
const ORACLE = path.join(scratch("upload-run"), "app");
fs.mkdirSync(path.join(ORACLE, "middleware"), { recursive: true });
fs.copyFileSync("/workspaces/app-mirror/app/middleware/upload.js", path.join(ORACLE, "middleware", "upload.js"));
fs.rmSync(path.join(ORACLE, "uploads"), { recursive: true, force: true });
const realUpload = require(path.join(ORACLE, "middleware", "upload.js"));

let PASS = 0; const FAILS = [];
const check = (name, ok, detail) => {
  if (ok) { PASS++; console.log(`  ok    ${name}`); }
  else { FAILS.push(name); console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

/* an object name is {owner}-{16 random hex}{ext}; only the random half may differ between runs */
const steady = text => String(text).replace(/(\d+-)[0-9a-f]{16}(\.\w+)/g, "$1HASH$2");
const steadyJson = record => record.json && Object.keys(record.json).length === 0
  ? { status: record.status, json: {} }
  : { status: record.status, json: JSON.parse(steady(JSON.stringify(record.json))) };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (a, b) => `worker: ${JSON.stringify(a)}\n          vps:    ${JSON.stringify(b)}`;

/* every route in the mirror that touches a file, reduced to what it reads off req */
const ROUTES = [
  { at: "/users/me/avatar", kind: "avatar", middleware: realUpload => realUpload.uploadImage("avatar"), mode: "one" },
  { at: "/users/me/cover", kind: "cover", middleware: realUpload => realUpload.uploadImage("cover"), mode: "one" },
  { at: "/messages/upload", kind: "message", middleware: realUpload => realUpload.uploadImage("message", "file"), mode: "one" },
  { at: "/posts/media", kind: "post", middleware: realUpload => realUpload.uploadFiles("post", "files", 8), mode: "many" },
  { at: "/marketplace/images", kind: "listing", middleware: realUpload => realUpload.uploadFiles("listing", "files", 8), mode: "many" },
  { at: "/onboarding/avatar", kind: "avatar", middleware: realUpload => realUpload.uploadImage("avatar"), mode: "one" },
];

const echo = (uploadModule, kind, mode) => (req, res) => {
  const list = mode === "many" ? (req.files || []) : (req.file ? [req.file] : []);
  res.json({
    urls: list.map(f => ({
      url: uploadModule.publicUrl(kind, f.filename),
      type: uploadModule.mediaType(f.mimetype),
      name: f.originalname,
      size: f.size,
      mime: f.mimetype,
      field: f.fieldname,
    })),
    body: req.body === undefined ? null : req.body,
  });
};

/* ------------------------------------------------------------------ *
 * the VPS side
 * ------------------------------------------------------------------ */
let OWNER = "42";
function realServer() {
  const app = expressReal();
  app.disable("x-powered-by");
  app.use(expressReal.json({ limit: "1mb" }));
  app.use((req, res, next) => { req.user = OWNER === null ? undefined : { sub: OWNER }; next(); });
  for (const route of ROUTES) {
    app.post(route.at, route.middleware(realUpload), echo(realUpload, route.kind, route.mode));
  }
  app.use("/uploads", expressReal.static(realUpload.UPLOAD_ROOT, {
    index: false, redirect: false, maxAge: "7d", immutable: true,
    setHeaders(res) { res.setHeader("Cross-Origin-Resource-Policy", "cross-origin"); },
  }));
  /* server.js:160-174 verbatim: a 416 from send() is an error with a status, and the app's own
     middleware turns it into the SPA envelope rather than express's HTML page */
  app.use((req, res) => res.status(404).json({ error: { code: "not_found", message: `No endpoint for ${req.method} ${req.originalUrl}`, fields: {} } }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number(error && error.status) || 500;
    if (status === 404) return res.status(404).json({ error: { code: "not_found", message: "Endpoint not found", fields: {} } });
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: { code: "validation_error", message: String(error.message || "Invalid request"), fields: error.fields || {} } });
    }
    res.status(500).json({ error: { code: "api_error", message: "Something went wrong on our side. Please try again.", fields: {} } });
  });
  return new Promise(resolve => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      url: p => `http://127.0.0.1:${server.address().port}${p}`,
    }));
  });
}

/* ------------------------------------------------------------------ *
 * the Worker side: the same routes over a fake R2
 * ------------------------------------------------------------------ */
function fakeBucket() {
  const objects = new Map();
  const bytesOf = async body => body instanceof ArrayBuffer ? new Uint8Array(body)
    : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
      : new Uint8Array(await new Response(body).arrayBuffer());
  const MEDIA = {
    put: async (key, body, options = {}) => {
      const bytes = await bytesOf(body);
      objects.set(key, {
        bytes,
        contentType: (options.httpMetadata || {}).contentType || "application/octet-stream",
        uploaded: new Date("2026-10-19T00:00:00Z"),
        etag: `FAKE${bytes.length}`,
      });
      return { key };
    },
    get: async (key, options = {}) => {
      const object = objects.get(key);
      if (!object) return null;
      const offset = (options.range && options.range.offset) || 0;
      const length = options.range ? options.range.length : object.bytes.length - offset;
      return {
        body: object.bytes.slice(offset, offset + length),
        httpMetadata: { contentType: object.contentType },
        size: length,
      };
    },
    head: async key => {
      const object = objects.get(key);
      if (!object) return null;
      return {
        size: object.bytes.length,
        etag: object.etag,
        uploaded: object.uploaded,
        httpMetadata: { contentType: object.contentType },
      };
    },
    delete: async key => { objects.delete(key); },
  };
  return { env: { MEDIA }, objects };
}

function workerApp() {
  const { env, objects } = fakeBucket();
  upload.init(env);
  const app = shim.createApp();
  app.use(shim.json({ limit: "1mb" }));
  app.use((req, res, next) => { req.user = OWNER === null ? undefined : { sub: OWNER }; next(); });
  for (const route of ROUTES) {
    const middleware = route.at === "/messages/upload"
      ? upload.uploadImage("message", "file")
      : route.mode === "many"
        ? upload.uploadFiles(route.kind, route.kind === "listing" || route.kind === "post" ? "files" : "file", 8)
        : upload.uploadImage(route.kind);
    app.post(route.at, middleware, echo(upload, route.kind, route.mode));
  }
  app.use((error, req, res, next) => res.status(500).json({ leaked: String(error && error.message) }));
  return { app, env, objects };
}

/* ------------------------------------------------------------------ *
 * drive one request through both stacks
 * ------------------------------------------------------------------ */
/* what a Worker would keep running after the answer was returned: awaited here so a deleted object
   is not mistaken for a delete that had not happened yet */
const background = [];
const settle = () => Promise.allSettled(background.splice(0));

const file = (name, type, size) => new File([new Uint8Array(size).fill(7)], name, { type });

function formOf(spec) {
  const form = new FormData();
  for (const entry of spec) {
    if (entry.text !== undefined) form.append(entry.field, entry.text);
    else form.append(entry.field, file(entry.name || `${entry.field}.bin`, entry.type, entry.size));
  }
  return form;
}

async function both(at, spec, owner) {
  const previous = OWNER;
  OWNER = owner === undefined ? "42" : owner;
  try {
    const answer = await worker(at, spec);
    const theirs = await vps(at, spec);
    return Object.assign({}, answer, theirs);
  } finally {
    OWNER = previous;
  }
}

let app = null, env = null, objects = null, real = null;
const vps = async (at, spec) => {
  const response = await fetch(real.url(at), { method: "POST", body: formOf(spec) });
  return { vps: { status: response.status, json: await response.json().catch(() => null) } };
};

const worker = async (at, spec) => {
  const request = new Request(`https://api.proffessionalist.com${at}`, { method: "POST", body: formOf(spec) });
  const answer = await app.handle(request, env, { waitUntil: p => background.push(Promise.resolve(p)) });
  return { mine: { status: answer.status, json: await answer.json().catch(() => null) }, response: answer };
};

/* node's fetch follows the WHATWG forbidden-header list, which silently DROPS If-None-Match and
   If-Modified-Since — asking the VPS with fetch would have looked like express.static ignoring
   revalidation when it was the client refusing to send the header.  Raw http sends what it is told,
   which is what a browser does. */
function vpsGet(p, { headers = {}, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const socket = http.request({ host: "127.0.0.1", port: real.server.address().port, path: p, method, headers }, response => {
      const chunks = [];
      response.on("data", c => chunks.push(c));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    socket.on("error", reject);
    socket.end();
  });
}

console.log("== the file routes the SPA calls: same answer from multer and from R2 ==");
{
  const server = await realServer();
  real = server;
  const built = workerApp();
  app = built.app; env = built.env; objects = built.objects;

  const png = { field: "file", type: "image/png", size: 1200 };
  const cases = [
    ["an accepted avatar", "/users/me/avatar", [png]],
    ["a cover image", "/users/me/cover", [{ ...png, field: "file" }]],
    ["a pdf as a chat attachment", "/messages/upload", [{ field: "file", type: "application/pdf", size: 900 }]],
    ["an mp4 for a post", "/posts/media", [{ field: "files", type: "video/mp4", size: 500 }]],
    ["eight post files, which is the allowance", "/posts/media", new Array(8).fill(0).map(() => ({ field: "files", type: "image/png", size: 100 }))],
    ["a ninth file, which is one too many", "/posts/media", new Array(9).fill(0).map(() => ({ field: "files", type: "image/png", size: 100 }))],
    ["a jpeg listing image", "/marketplace/images", [{ field: "files", type: "image/jpeg", size: 400 }]],
    ["a text/plain upload", "/users/me/avatar", [{ field: "file", type: "text/plain", size: 40 }]],
    ["an svg, which no mimetype table admits", "/users/me/avatar", [{ field: "file", type: "image/svg+xml", size: 40 }]],
    ["an avatar over the 6 MB bucket", "/users/me/avatar", [{ field: "file", type: "image/png", size: 6 * 1024 * 1024 + 1024 }]],
    ["a 12 MB post image, which the post bucket allows", "/posts/media", [{ field: "files", type: "image/png", size: 12 * 1024 * 1024 - 4096 }]],
    ["a file in a field the route never asked for", "/users/me/avatar", [{ field: "other", type: "image/png", size: 40 }]],
    ["a second file for a single-file route", "/users/me/avatar", [png, png]],
    ["a form with only text fields", "/users/me/avatar", [{ field: "caption", text: "no file here" }]],
    ["text fields beside a file, repeated ones becoming an array", "/messages/upload", [png, { field: "caption", text: "hi" }, { field: "tag", text: "a" }, { field: "tag", text: "b" }]],
    ["a gif and a webp in one listing", "/marketplace/images", [{ field: "files", type: "image/gif", size: 40 }, { field: "files", type: "image/webp", size: 60 }]],
    ["a quicktime clip for a post", "/posts/media", [{ field: "files", type: "video/quicktime", size: 300 }]],
    ["an oversized file arriving before an accepted one", "/posts/media", [{ field: "files", type: "image/png", size: 12 * 1024 * 1024 + 10 }, { field: "files", type: "image/png", size: 100 }]],
    ["a bad type arriving before an accepted one", "/posts/media", [{ field: "files", type: "application/zip", size: 10 }, { field: "files", type: "image/png", size: 100 }]],
  ];

  for (const [label, at, spec] of cases) {
    const { mine, vps: theirs } = await both(at, spec);
    check(label, same(steadyJson(mine), steadyJson(theirs)), show(steadyJson(mine), steadyJson(theirs)));
  }

  console.log("\n== what lands in storage ==");
  {
    objects.clear();
    const { mine } = await both("/users/me/avatar", [png]);
    const key = [...objects.keys()].pop();
    check("the object key is {directory}/{user id}-{16 hex}.png, the VPS naming",
      /^avatars\/42-[0-9a-f]{16}\.png$/.test(key || ""), key);
    const stored = objects.get(key);
    check("the stored bytes are what was sent", stored && stored.bytes.length === 1200 && stored.bytes[0] === 7,
      `${stored && stored.bytes.length} bytes`);
    check("the object carries its content type, so an <img> renders it instead of downloading it",
      stored && stored.contentType === "image/png", stored && stored.contentType);
    check("the url the database stores is the same string on both stacks",
      mine.json.urls[0].url === `/uploads/${key}`, `${mine.json.urls[0].url} vs /uploads/${key}`);

    const anonymous = await both("/users/me/avatar", [png], null);
    check("a request with no signed-in user is owned by 0, as multer's storage did",
      anonymous.mine.status === 200 && anonymous.mine.json.urls[0].url.startsWith("/uploads/avatars/0-"),
      JSON.stringify(anonymous.mine.json));

    const rejected = await both("/posts/media", [{ field: "files", type: "application/zip", size: 10 }, { field: "files", type: "image/png", size: 100 }]);
    const leftovers = [...objects.keys()].filter(k => k.startsWith("posts/"));
    check("a refused upload leaves nothing half-written in the bucket",
      rejected.mine.status === 400 && leftovers.every(k => !objects.has(k)) && leftovers.length === 0,
      `${leftovers.length} post objects left`);
  }

  console.log("\n== serving the file back ==");
  {
    objects.clear();
    const stored = await both("/posts/media", [{ field: "files", type: "video/mp4", size: 4096 }]);
    const url = stored.mine.json.urls[0].url;
    /* the same clip on the other stack, named by the echo rather than guessed from the directory */
    const vpsUrl = stored.vps.json.urls[0].url;

    /* the headers a client may not be allowed to differ on.  etag and last-modified are excluded
       because one stack hashes a disk inode and the other an R2 object, so only their PRESENCE and
       their effect (a 304) can be compared, not their value. */
    const POLICY = ["content-type", "cache-control", "cross-origin-resource-policy", "accept-ranges", "content-length", "content-range"];
    const policyOf = headers => {
      const out = {};
      for (const name of POLICY) if (headers[name] !== undefined) out[name] = String(headers[name]);
      return out;
    };
    const mineHeaders = response => {
      const out = {};
      for (const name of POLICY) { const value = response.headers.get(name); if (value !== null) out[name] = value; }
      return out;
    };

    const FORMS = [
      ["an ordinary GET", {}],
      ["a byte range", { range: "bytes=100-199" }],
      ["a suffix range", { range: "bytes=-50" }],
      ["an open-ended range", { range: "bytes=2048-" }],
      ["a range past the end", { range: "bytes=9000-" }],
      ["a range starting exactly at the end", { range: "bytes=4096-" }],
      ["a range longer than the file", { range: "bytes=0-999999" }],
      ["a one-byte range", { range: "bytes=10-10" }],
      ["a multi-range request, which send ignores", { range: "bytes=0-9, 20-29" }],
      ["a range with a unit nobody knows", { range: "kilobytes=1" }],
      ["an empty range value", { range: "bytes=" }],
      ["a bare dash", { range: "bytes=-" }],
      ["a reversed range", { range: "bytes=200-100" }],
      ["a range with spaces in it", { range: "bytes = 10 - 20" }],
    ];
    for (const [label, headers] of FORMS) {
      const mine = await upload.serveUpload(new Request(`https://api.proffessionalist.com${url}`, { headers }), env);
      const theirs = await vpsGet(vpsUrl, { headers });
      const bytes = await mine.arrayBuffer();
      check(`${label}: ${theirs.status} with the same body length and headers`,
        mine.status === theirs.status && bytes.byteLength === theirs.body.length &&
        same(mineHeaders(mine), policyOf(theirs.headers)),
        `worker ${mine.status}/${bytes.byteLength}b ${JSON.stringify(mineHeaders(mine))}\n          vps    ${theirs.status}/${theirs.body.length}b ${JSON.stringify(policyOf(theirs.headers))}`);
    }

    for (const [label, init] of [
      ["a cached copy revalidates to 304", "etag"],
      ["a copy from the future revalidates to 304", "modified"],
    ]) {
      const ours = await upload.serveUpload(new Request(`https://api.proffessionalist.com${url}`), env);
      const theirs = await vpsGet(vpsUrl);
      const mineCondition = init === "etag" ? { "if-none-match": ours.headers.get("etag") } : { "if-modified-since": theirs.headers["last-modified"] };
      const theirsCondition = init === "etag" ? { "if-none-match": theirs.headers.etag } : { "if-modified-since": theirs.headers["last-modified"] };
      const mineAgain = await upload.serveUpload(new Request(`https://api.proffessionalist.com${url}`, { headers: mineCondition }), env);
      const theirsAgain = await vpsGet(vpsUrl, { headers: theirsCondition });
      check(`${label} on both stacks`,
        ours.headers.get("etag") !== null && theirs.headers.etag !== undefined &&
        mineAgain.status === 304 && theirsAgain.status === 304 && mineAgain.status === theirsAgain.status,
        `worker ${mineAgain.status} (etag ${ours.headers.get("etag")}) | vps ${theirsAgain.status} (etag ${theirs.headers.etag})`);
    }

    const head = await upload.serveUpload(new Request(`https://api.proffessionalist.com${url}`, { method: "HEAD" }), env);
    const headVps = await vpsGet(vpsUrl, { method: "HEAD" });
    check("HEAD answers with the headers and no body, so a player can size the clip",
      head.status === headVps.status && head.headers.get("content-length") === headVps.headers["content-length"] &&
      (await head.arrayBuffer()).byteLength === 0 && headVps.body.length === 0,
      `worker ${head.status} len=${head.headers.get("content-length")} | vps ${headVps.status} len=${headVps.headers["content-length"]}`);

    const headRanged = await upload.serveUpload(new Request(`https://api.proffessionalist.com${url}`, { method: "HEAD", headers: { range: "bytes=0-9" } }), env);
    const headRangedVps = await vpsGet(vpsUrl, { method: "HEAD", headers: { range: "bytes=0-9" } });
    check("HEAD with a range keeps the 206 and its content-range",
      headRanged.status === headRangedVps.status &&
      headRanged.headers.get("content-range") === headRangedVps.headers["content-range"],
      `${headRanged.status} ${headRanged.headers.get("content-range")} | ${headRangedVps.status} ${headRangedVps.headers["content-range"]}`);

    const missing = await upload.serveUpload(new Request(`https://api.proffessionalist.com${url.replace(/[^/]*$/, "nope.png")}`), env);
    const missingVps = await vpsGet("/uploads/posts/nope.png");
    check("a missing object answers nothing, leaving worker.js to emit the 404 envelope",
      missing === null && missingVps.status === 404, `${missing} vs ${missingVps.status}`);

    for (const attack of ["/uploads/..%2F..%2Fetc%2Fpasswd", "/uploads/%2e%2e/%2e%2e/server.js", "/uploads//etc/passwd"]) {
      const refused = await upload.serveUpload(new Request(`https://api.proffessionalist.com${attack}`), env);
      check(`a traversal attempt is refused before the bucket is asked: ${attack}`, refused === null, String(refused));
    }
  }

  console.log("\n== removing the previous avatar ==");
  {
    objects.clear();
    await both("/users/me/avatar", [png]);
    const key = [...objects.keys()].pop();
    const url = `/uploads/${key}`;
    await settle();
    /* routes/….js call removeStored without awaiting it, so the only thing that keeps the delete
       alive is the ctx.waitUntil the shim is handed — the harness settles that queue and then looks */
    upload.removeStored(url, { ctx: { waitUntil: p => background.push(Promise.resolve(p)) } });
    await settle();
    check("the old file is gone from the bucket", !objects.has(key), `still present: ${key}`);

    /* a sentinel that must survive every one of these calls: an assertion about an empty bucket
       proves nothing */
    objects.set("avatars/42-0000000000000000.png", {
      bytes: new Uint8Array(8), contentType: "image/png", uploaded: new Date(), etag: "SENTINEL",
    });
    const before = objects.size;

    /* middleware/upload.js returns nothing when the url is not one of its uploads, so the port has
       to do the same: a route that awaits the result of an ignored url must not gain a promise */
    const elsewhere = upload.removeStored("https://elsewhere.example/a.png", {});
    check("a url that is not an upload is ignored, like the module being replaced ignores it",
      elsewhere === undefined && objects.size === before, `${typeof elsewhere}, ${objects.size} objects`);

    const traversal = upload.removeStored("/uploads/../../server.js", { ctx: {} });
    check("so is a traversal, and nothing else is deleted",
      traversal === undefined && objects.size === before, `${typeof traversal}, ${objects.size} vs ${before}`);

    const vpsBefore = fs.readdirSync(path.join(ORACLE, "uploads", "avatars")).length;
    realUpload.removeStored("/uploads/avatars/nope.png");
    check("the mirror's own removeStored tolerates a missing file the same way",
      fs.readdirSync(path.join(ORACLE, "uploads", "avatars")).length === vpsBefore);

    const missing = upload.removeStored("/uploads/avatars/nope.png", { ctx: {} });
    await (missing || Promise.resolve());
    check("a real delete of a missing object resolves quietly and leaves the bucket alone",
      missing instanceof Promise && objects.size === before, `${typeof missing}, ${objects.size} vs ${before}`);
  }

  server.server.close();
}

console.log(`\nVERDICT: ${PASS} passed, ${FAILS.length} failed`);
if (FAILS.length) { for (const f of FAILS) console.log(`  - ${f}`); process.exit(1); }
console.log("every multer outcome and every static-file header the VPS produced is reproduced from R2.");
