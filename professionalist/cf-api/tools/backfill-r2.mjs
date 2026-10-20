/* Backfill the pulled VPS upload tree into the R2 bucket professionalist-media.
   WHY this exists: object storage moves from /home/opc/professionalist/app/uploads on the VPS to
   R2, and R2 keys must equal the app's public paths so an existing /uploads/{kind}/{file} URL in the
   database still resolves after cutover. shims/upload.js serves a stored key back by reading the
   object's httpMetadata.contentType (see typeOf() there), so a wrong type is not cosmetic — the
   serving path treats a stored "application/octet-stream" as "not declared" and falls back to
   sniffing bytes by extension, and a mis-declared type (say an mp4 the browser downloads instead of
   plays) is a real user-visible bug.

   WHY the content-type is taken from the extension rather than guessed:
   express 5's express.static (via send/mime-types) mapped the VPS's /uploads Content-Type purely
   from the file's extension. Measured against the live server on 127.0.0.1:5000 (2026-10, one
   representative file per extension, all HTTP 200): .png=image/png .jpg=image/jpeg .webp=image/webp
   .gif=image/gif .pdf=application/pdf .mp4=video/mp4. So the extension table below reproduces the
   bytes the VPS actually served, key-for-key. libmagic sniffing was rejected as the source of truth:
   the app assigned each extension by sniffing the upload's declared mimetype, so the extension IS
   the type the VPS served; a magic-vs-extension divergence would mean diverging from production.

   WHY SigV4 by hand instead of a dependency or wrangler:
   no npm deps are permitted in this tool, and `wrangler r2 object put` cannot set a Content-Type
   reliably at scale and is forbidden for this task. R2 speaks the S3 wire protocol, so a plain
   HTTPS PUT with AWS Signature v4 (HMAC-SHA256, region "auto", service "s3") writes the object and
   its httpMetadata.contentType directly. x-amz-content-sha256 carries each object's own digest, not
   UNSIGNED-PAYLOAD, because R2 requires the signed-payload form.

   Safety: strictly additive. It never deletes an object. Re-running is cheap and correct — if an
   object already exists with the same size and the same stored content-type it is reported "already
   present" and left untouched; a size or type mismatch re-PUTs (a PUT to an existing key is a create,
   not a delete). --dry-run lists exactly what it would write and signs nothing. Secrets (the account
   id, the token, the S3 keys) never reach console.log or an Error message: every string printed is
   run through hideSecrets first.

     node cf-api/tools/backfill-r2.mjs [--dry-run] [--verify]
     source tree: env BACKFILL_SRC, default /workspaces/vps-uploads/uploads */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readTrim, hideSecrets } from "./paths.mjs";

const hide = hideSecrets;
const DRY = process.argv.includes("--dry-run");
const VERIFY = process.argv.includes("--verify");
const SRC = process.env.BACKFILL_SRC || "/workspaces/vps-uploads/uploads";
const BUCKET = "professionalist-media";
const REGION = "auto";
const SERVICE = "s3";
const EMPTY_SHA256 = crypto.createHash("sha256").update("").digest("hex");

/* extension -> the Content-Type express.static served on the VPS (measured above). */
const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mov": "video/quicktime",
  ".json": "application/json",
  ".txt": "text/plain",
};

const ACCOUNT = readTrim("tmp", "acct.txt");
const ACCESS_KEY = readTrim("tmp", "r2-access-key-id.txt");
const SECRET_KEY = readTrim("tmp", "r2-secret-access-key.txt");
const HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;

function typeFor(filename) {
  const type = CONTENT_TYPES[path.extname(filename).toLowerCase()];
  if (!type) throw new Error(`cannot decide a Content-Type for "${filename}" — no extension mapping; refusing to upload a guessed type`);
  return type;
}

/* ---- AWS SigV4 (HMAC-SHA256), no dependencies ---------------------------------------- */
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data, "utf8").digest();
const hex = buf => buf.toString("hex");
const sha256hex = data => crypto.createHash("sha256").update(data).digest("hex");
/* S3 path encoding: encode each segment, never the "/" between them; keys here are alphanumeric
   plus - . _ so this is a no-op, but correctness must not depend on the current data set. */
const uriEncodeSegment = s => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function sign(method, segments, { body, contentType, query } = {}) {
  const payloadHash = method === "PUT" ? sha256hex(body) : EMPTY_SHA256;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const canonicalUri = "/" + segments.map(uriEncodeSegment).join("/");
  const params = query || {};
  const canonicalQuery = Object.keys(params).sort()
    .map(k => `${uriEncodeSegment(k)}=${uriEncodeSegment(params[k])}`).join("&");

  const headers = {
    host: HOST,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headers["content-type"] = contentType;
  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map(n => `${n}:${String(headers[n]).trim()}\n`).join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest),
  ].join("\n");

  const key = hmac(hmac(hmac(hmac("AWS4" + SECRET_KEY, dateStamp), REGION), SERVICE), "aws4_request");
  const signature = hex(hmac(key, stringToSign));
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const qs = canonicalQuery ? `?${canonicalQuery}` : "";
  return { url: `https://${HOST}${canonicalUri}${qs}`, headers, payloadHash, scope, signedHeaders, signature, amzDate };
}

async function s3(method, segments, opts = {}) {
  const req = sign(method, segments, opts);
  const init = { method, headers: req.headers };
  if (method === "PUT") init.body = opts.body;
  const res = await fetch(req.url, init);
  return res;
}

/* ---- pull the local tree into {key, bytes, size, contentType} ------------------------- */
function collectFiles() {
  if (!fs.existsSync(SRC)) throw new Error(`upload source tree not found at "${SRC}" — set BACKFILL_SRC or run the ssh pull first`);
  const rel = fs.readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => path.join(e.parentPath ?? e.path, e.name))
    .map(abs => path.relative(SRC, abs).split(path.sep).join("/"))
    .filter(k => k.includes("/")); /* every object lives under a {kind}/ subdir */
  rel.sort();
  if (!rel.length) throw new Error(`no files found under "${SRC}" — refusing to report a successful empty backfill`);
  return rel;
}

/* ---- one pass over the tree ----------------------------------------------------------- */
async function backfill() {
  const keys = collectFiles();
  let uploaded = 0, present = 0, failed = 0;
  const failures = [];

  for (const key of keys) {
    const file = path.join(SRC, key);
    const bytes = fs.readFileSync(file);
    const contentType = typeFor(key);
    const size = bytes.length;

    if (DRY) {
      console.log(`DRY ${key} ${size} ${contentType}`);
      continue;
    }

    let res;
    try {
      /* idempotency probe: a HeadObject first — only PUT when absent, or when size/type differ. */
      const head = await s3("HEAD", [BUCKET, ...key.split("/")]);
      if (head.status === 200) {
        const remoteSize = Number(head.headers.get("content-length") || "-1");
        const remoteType = (head.headers.get("content-type") || "").split(";")[0].trim();
        if (remoteSize === size && remoteType === contentType) {
          console.log(`already present  ${key} ${size} ${contentType}`);
          present++;
          continue;
        }
      } else if (head.status !== 404) {
        throw new Error(`HEAD ${key} returned ${head.status}: ${hide((await head.text()).slice(0, 200))}`);
      }

      res = await s3("PUT", [BUCKET, ...key.split("/")], { body: bytes, contentType });
      if (!res.ok) {
        throw new Error(`PUT ${key} returned ${res.status}: ${hide((await res.text()).slice(0, 200))}`);
      }
      console.log(`uploaded         ${key} ${size} ${contentType}`);
      uploaded++;
    } catch (err) {
      failed++;
      failures.push(key);
      console.log(`FAILED           ${key} ${size} ${contentType}  ${hide(err.message).slice(0, 200)}`);
    }
  }

  if (!DRY) {
    console.log(`\nbackfill summary: uploaded=${uploaded} already_present=${present} failed=${failed} total=${keys.length}`);
    if (failed) throw new Error(`backfill had ${failed} failure(s): ${failures.join(", ")}`);
  } else {
    console.log(`\ndry-run: would write ${keys.length} object(s) to r2://${BUCKET} (nothing signed, nothing uploaded)`);
  }
}

/* ---- read-back verification ----------------------------------------------------------- */
async function verify() {
  const keys = collectFiles();
  const expected = new Map();
  for (const key of keys) {
    expected.set(key, { size: fs.statSync(path.join(SRC, key)).size, type: typeFor(key) });
  }
  const expectedBytes = [...expected.values()].reduce((n, v) => n + v.size, 0);

  /* list-type=2, paging past the 1000-object default cap */
  const listed = new Map();
  let token = "";
  do {
    const q = token ? { "list-type": "2", "continuation-token": token } : { "list-type": "2" };
    const res = await s3("GET", [BUCKET], { query: q });
    if (!res.ok) throw new Error(`LIST returned ${res.status}: ${hide((await res.text()).slice(0, 300))}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)) {
      listed.set(decodeXml(m[1]), Number(m[2]));
    }
    const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
    token = next ? decodeXml(next[1]) : "";
  } while (token);

  const listedBytes = [...listed.values()].reduce((n, v) => n + v, 0);
  console.log(`list: bucket keys=${listed.size} (expected ${expected.size}), bytes=${listedBytes} (expected ${expectedBytes})`);

  const problems = [];
  for (const [key, want] of expected) {
    if (!listed.has(key)) problems.push(`MISSING key ${key}`);
    else if (listed.get(key) !== want.size) problems.push(`SIZE mismatch ${key}: listed=${listed.get(key)} want=${want.size}`);
  }
  for (const key of listed.keys()) if (!expected.has(key)) problems.push(`EXTRA key in bucket, not in tree: ${key}`);

  /* stored content-type must equal what we sent, for every object */
  for (const key of expected.keys()) {
    const res = await s3("HEAD", [BUCKET, ...key.split("/")]);
    if (!res.ok) { problems.push(`HEAD ${key} -> ${res.status}`); continue; }
    const got = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (got !== expected.get(key).type) problems.push(`TYPE mismatch ${key}: stored=${got || "(none)"} want=${expected.get(key).type}`);
  }

  /* byte-compare 3 representative objects: an image, a video, the smallest file */
  const byExt = ext => [...expected.keys()].find(k => k.toLowerCase().endsWith(ext));
  const smallest = [...expected.entries()].sort((a, b) => a[1].size - b[1].size)[0][0];
  const samples = [...new Set([byExt(".png") || byExt(".jpg"), byExt(".mp4"), smallest].filter(Boolean))];
  for (const key of samples) {
    const res = await s3("GET", [BUCKET, ...key.split("/")]);
    if (!res.ok) { problems.push(`GET ${key} -> ${res.status}`); continue; }
    const remote = Buffer.from(await res.arrayBuffer());
    const local = fs.readFileSync(path.join(SRC, key));
    const same = remote.length === local.length && crypto.createHash("sha256").update(remote).digest("hex")
      === crypto.createHash("sha256").update(local).digest("hex");
    console.log(`byte-compare ${key} remote=${remote.length} local=${local.length} ${same ? "IDENTICAL" : "DIFFERS"}`);
    if (!same) problems.push(`BYTE mismatch ${key}`);
  }

  console.log(`\nverify problems: ${problems.length}`);
  problems.slice(0, 20).forEach(p => console.log("  ! " + hide(p)));
  if (problems.length) throw new Error(`verification FAILED with ${problems.length} problem(s)`);
  console.log(`VERDICT: all ${listed.size} keys present, sizes match (${listedBytes} bytes), every stored content-type matches, sampled bytes identical`);
}

function decodeXml(s) {
  return String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

try {
  if (VERIFY) await verify();
  else await backfill();
} catch (err) {
  console.error(hide(err.message).slice(0, 400));
  process.exit(1);
}
