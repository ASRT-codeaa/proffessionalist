/* Post-deploy read-only comparison of a deployed Worker against the live VPS.

   diff-routes.mjs covers the whole endpoint surface against the dev sandbox; this is the smaller,
   boring check that answers "did the artifact I just shipped behave", because a `wrangler dev`
   bundle and an uploaded bundle are different things — a binding that only exists in the config, a
   secret that was never put, a Durable Object namespace that was created but not migrated, all
   vanish locally and surface only on the deployed Worker.

   Every request here is GET/HEAD/OPTIONS.  Production is never written to: no credentials, no login
   attempt (a failed one locks a real account), no POST.  Comparisons that can only be made by
   sending something the VPS would act on are left to the dev sandbox.

   node cf-api/tools/verify-preview.mjs <base-url>            # e.g. https://professionalist-api.<sub>.workers.dev */
import http from "node:http";
import https from "node:https";
import { hideSecrets } from "./paths.mjs";

const WORKER = (process.argv[2] || "").replace(/\/+$/, "");
const VPS = "https://api.proffessionalist.com";
if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(WORKER)) {
  throw new Error("pass the deployed Worker url (https, or http for a local dev server) as the first argument");
}

/* node:https rather than fetch: undici drops the WHATWG forbidden headers (If-None-Match,
   If-Modified-Since), which would make a stack look like it ignored revalidation. */
function get(base, at, { headers = {}, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(at, base);
    /* http: only for a local dev server, which is how this tool is tested before anything is
       deployed; everything that reaches the network by default is TLS */
    const lib = url.protocol === "http:" ? http : https;
    const req = lib.request({
      host: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname + url.search,
      method, headers, servername: url.hostname,
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        bytes: Buffer.concat(chunks),
        get body() { return this.bytes.toString(); },
      }));
    });
    req.on("error", reject);
    req.setTimeout(45000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

/* the edge adds its own headers on one side and not the other, and a cache stores the VPS's copy —
   those are environmental, so they are not compared; the app's own headers all are.  `connection`
   and `server-timing` are in it because Cloudflare's proxy terminates and re-originates the TCP
   connection on the VPS side and stamps its own latency, while the Worker's connection is not
   proxied the same way; neither is something server.js wrote. */
const EDGE = /^(cf-ray|cf-cache-status|age|via|server|date|nel|report-to|alt-svc|set-cookie|x-served-by|traceparent|cf-border|connection|server-timing|x-timing|proxy-status)$/;

function appHeaders(h) {
  const out = [];
  for (const [name, value] of Object.entries(h)) {
    if (EDGE.test(name)) continue;
    const list = name === "set-cookie" ? value : Array.isArray(value) ? value : [value];
    for (const v of list) out.push(`${name}: ${v}`);
  }
  return out.sort();
}

const CASES = [
  ["root", "/", {}],
  ["health", "/health", {}],
  ["health/full", "/health/full", {}],
  ["404 envelope", "/no-such-endpoint", {}],
  /* /api/meta/content is the query that proved db.js:67 bound its text[] parameter raw (an empty
     result, not an error — see the handoff §5.8 route-diff finding), so it is a permanent case */
  ["meta content", "/api/meta/content", {}],
  ["401 envelope", "/api/meta", {}],
  ["401 with origin", "/api/meta", { origin: "https://proffessionalist.com" }],
  ["preflight", "/api/auth/login", { "access-control-request-method": "POST", origin: "https://proffessionalist.com" }, "OPTIONS"],
  ["unmatched api", "/api/definitely/not/here", {}],
];

let fails = 0;
const note = (ok, label, detail) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
};

async function compare([label, at, headers, method = "GET"]) {
  const mine = await get(WORKER, at, { headers, method });
  const theirs = await get(VPS, at, { headers, method });
  const sameBody = mine.body === theirs.body;
  const myHeaders = appHeaders(mine.headers);
  const theirHeaders = appHeaders(theirs.headers);
  const missing = theirHeaders.filter(h => !myHeaders.includes(h));
  const extra = myHeaders.filter(h => !theirHeaders.includes(h));
  /* the two RateLimit entries carry a live count and a countdown, and pk=:…: hashes the client
     address the two stacks see differently, so their shape is compared and not their values; the
     media ETag differs by design (R2's md5 vs send's size-mtime) and is covered by the file check */
  const volatile = h => /^ratelimit(-policy)?:/.test(h) || /^etag:/.test(h);
  const kept = list => list.filter(h => !volatile(h));
  note(mine.status === theirs.status, `${label} status`, `${mine.status} vs ${theirs.status}`);
  note(sameBody || at.startsWith("/uploads"), `${label} body byte-identical`,
    sameBody ? "" : `worker ${hideSecrets(mine.body).slice(0, 160)}\n         vps    ${hideSecrets(theirs.body).slice(0, 160)}`);
  note(kept(missing).length === 0 && kept(extra).length === 0, `${label} app headers match`,
    [...kept(missing).map(h => `vps only: ${h}`), ...kept(extra).map(h => `worker only: ${h}`)].join("\n         "));
  /* a request the limiter does not answer — a preflight, which ends inside cors() before
     ipLimiter's counter write (server.js:102 mounts it after cors) — has no RateLimit header on
     either stack, so requiring one here would be this tool inventing a difference */
  const eitherHasRate = Boolean(mine.headers.ratelimit || theirs.headers.ratelimit);
  const form = h => /"3000-in-15min"; r=\d+; t=\d+/.test(String(h.ratelimit || ""))
    && /; pk=(:[^:]{8,64}:)/.test(String(h["ratelimit-policy"] || ""));
  note(!eitherHasRate || (form(mine.headers) && form(theirs.headers)),
    `${label} RateLimit/Policy present in the same form`,
    eitherHasRate
      ? `worker ${mine.headers.ratelimit} | ${mine.headers["ratelimit-policy"]}\n         vps    ${theirs.headers.ratelimit} | ${theirs.headers["ratelimit-policy"]}`
      : "neither stack counted this request");
}

async function main() {
  console.log(`deployed Worker: ${WORKER}\noracle:            ${VPS}\n`);
  for (const c of CASES) await compare(c);

  /* one real object from the bucket, both stacks: the shape the video player sizes a clip with */
  const file = process.argv[3];
  if (file) {
    const path = `/uploads/${file}`;
    const mine = await get(WORKER, path, {});
    const theirs = await get(VPS, path, {});
    note(mine.status === theirs.status && mine.headers["content-type"] === theirs.headers["content-type"]
      && mine.headers["content-length"] === theirs.headers["content-length"]
      && mine.headers["cache-control"] === theirs.headers["cache-control"]
      && mine.headers["accept-ranges"] === theirs.headers["accept-ranges"]
      && mine.headers["cross-origin-resource-policy"] === theirs.headers["cross-origin-resource-policy"],
    `media ${file} served identically apart from the two edge-owned validators`,
      `worker ${mine.status} ${mine.headers["content-type"]} len=${mine.headers["content-length"]}\n         vps    ${theirs.status} ${theirs.headers["content-type"]} len=${theirs.headers["content-length"]}`);
    /* the third argument is an options object, not a header bag — passing `range` there sent no
       Range header at all and both stacks answered a full 200, which looked like a broken Worker */
    const ranged = await get(WORKER, path, { headers: { range: "bytes=0-99" } });
    /* bytes, not string length: a JPEG's body length in characters is not its length in bytes, and
       this check exists precisely because the video player relies on Range arithmetic */
    note(ranged.status === 206 && ranged.bytes.length === 100
      && ranged.headers["content-range"] === `bytes 0-99/${theirs.headers["content-length"]}`,
    "a single range is a 206 of exactly 100 bytes with the right Content-Range",
    `${ranged.status} ${ranged.bytes.length} ${ranged.headers["content-range"]}`);
    const theirRanged = await get(VPS, path, { headers: { range: "bytes=0-99" } });
    note(theirRanged.status === ranged.status && Buffer.compare(theirRanged.bytes, ranged.bytes) === 0,
      "the same range of the same object is the same 100 bytes on both stacks",
      `vps ${theirRanged.status} ${theirRanged.bytes.length} | worker ${ranged.status} ${ranged.bytes.length}`);
  }

  console.log(`\nVERDICT: ${fails === 0 ? "the deployed Worker answers like the VPS" : `${fails} difference(s)`}`);
  process.exit(fails ? 1 : 0);
}

main().catch(err => { console.error(hideSecrets(err.message)); process.exit(1); });
