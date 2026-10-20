/* multer + express.static replaced by R2, keeping the contract the route files already use.
   middleware/upload.js exports { UPLOAD_ROOT, uploadImage, uploadFiles, publicUrl, mediaType,
   removeStored } and the six routes that mount them read req.file/req.files as
   { filename, originalname, mimetype, size }, so those names and their meaning are preserved
   exactly — a ported route does not learn that the bytes moved off the disk.

   Every multer answer measured against the real package (/tmp/rl-oracle/multer-probe.cjs):
     - a field name nobody asked for  -> LIMIT_UNEXPECTED_FILE
     - a second file for single()     -> LIMIT_FILE_COUNT;  more than maxFiles for array() -> LIMIT_UNEXPECTED_FILE
     - a body over fileSize           -> LIMIT_FILE_SIZE
     - fileFilter refusing a mimetype -> the plain Error the middleware raised, flagged rejected
     - a multipart form with no file  -> no req.file at all, next() still runs
     - a non-multipart request        -> the middleware does nothing and the route reports "Choose an image to upload"
   All of those leave this file as the SPA's error envelope, exactly as upload.js's wrapper did.

   Keys keep the VPS naming so an existing /uploads/… URL in the database still resolves:
   {directory}/{user id}-{16 random hex}{extension from the sniffed mimetype}. */
const path = require("path");
const crypto = require("crypto");

const UPLOAD_ROOT = "/uploads";

const KINDS = {
  avatar: { directory: "avatars", maxBytes: 6 * 1024 * 1024 },
  cover: { directory: "covers", maxBytes: 12 * 1024 * 1024 },
  post: { directory: "posts", maxBytes: 12 * 1024 * 1024 },
  listing: { directory: "listings", maxBytes: 12 * 1024 * 1024 },
  message: { directory: "messages", maxBytes: 12 * 1024 * 1024 },
};

/* Extension comes from the sniffed mimetype only — never from the client's filename. */
const IMAGE_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const DOCUMENT_EXTENSIONS = { "application/pdf": ".pdf" };

const VIDEO_EXTENSIONS = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

const ALLOWED = Object.assign({}, IMAGE_EXTENSIONS, DOCUMENT_EXTENSIONS, VIDEO_EXTENSIONS);

let ENV = null;

function init(env) {
  ENV = env;
  if (!env || !env.MEDIA) {
    throw new Error("shims/upload: env.MEDIA is not bound — declare the R2 bucket in wrangler.toml");
  }
  return env.MEDIA;
}

function bucket() {
  if (!ENV || !ENV.MEDIA) throw new Error("shims/upload: not initialised — call upload.init(env) before mounting the app");
  return ENV.MEDIA;
}

const isFile = value => value && typeof value === "object" && typeof value.arrayBuffer === "function";

function publicUrl(kind, filename) {
  return `${UPLOAD_ROOT}/${KINDS[kind].directory}/${filename}`;
}

function mediaType(mimetype) {
  if (/^video\//.test(mimetype)) return "video";
  if (/^image\//.test(mimetype)) return "image";
  return "document";
}

/** Delete a stored object. Best-effort and never throws: routes call it without awaiting.
    Like middleware/upload.js, a url that is not an upload is simply ignored, returning nothing. */
function removeStored(url, req) {
  if (!url || typeof url !== "string" || !url.startsWith(`${UPLOAD_ROOT}/`)) return;
  const relative = url.slice(UPLOAD_ROOT.length + 1);
  if (relative.includes("..") || relative.includes("\\")) return;
  const waiter = (req && req.ctx && req.ctx.waitUntil) || (ENV && ENV.__waitUntil);
  const pending = bucket().delete(relative).catch(error => {
    console.error("shims/upload: could not delete", relative, error && error.message);
  });
  if (typeof waiter === "function") waiter(pending);
  return pending;
}

/** multer's own error shape, so the wrapper below stays the only place messages are chosen. */
class MulterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MulterError";
    this.code = code;
  }
}

function rejectedError(message) {
  const error = new Error(message);
  error.rejected = true;
  return error;
}

function kindOf(kind) {
  const config = KINDS[kind];
  if (!config) throw new Error(`shims/upload: unknown upload kind "${kind}"`);
  return config;
}

const newFilename = req => {
  const owner = Number(req.user && req.user.sub) || 0;
  return `${owner}-${crypto.randomBytes(8).toString("hex")}`;
};

/**
 * Read the multipart body, apply multer's limits and fileFilter in stream order, and put each
 * accepted file in R2 under {directory}/{owner}-{random}{ext}.
 * Failures come back as the SPA's envelope with the field name the form used, like upload.js did.
 */
function uploader(kind, field, maxFiles, mode) {
  const config = kindOf(kind);
  const limitMb = Math.round(config.maxBytes / 1024 / 1024);

  return async (req, res, next) => {
    const contentType = req.get("content-type") || "";
    /* multer only engages with a multipart body; anything else falls through to the route, which
       answers "Choose an image to upload" */
    if (!/^multipart\/form-data/i.test(contentType)) return next();

    let form;
    try {
      form = await req.__raw.formData();
    } catch (error) {
      const declared = Number(req.get("content-length") || 0);
      if (declared > config.maxBytes * maxFiles + 1024 * 1024) {
        return refuse(res, field, `Keep each file under ${limitMb} MB.`);
      }
      return refuse(res, field, "Upload failed. Please try again.");
    }

    const entries = [...form.entries()];
    const body = {};
    const files = [];
    let failure = null;

    for (const [name, value] of entries) {
      if (!isFile(value)) {
        /* multer collects text fields in arrival order and turns a repeated name into an array */
        body[name] = name in body ? (Array.isArray(body[name]) ? [...body[name], value] : [body[name], value]) : value;
        continue;
      }
      if (failure) continue;
      const mimetype = value.type || "";
      const extension = ALLOWED[mimetype];

      if (name !== field) {
        failure = new MulterError("LIMIT_UNEXPECTED_FILE", "Unexpected file field");
        continue;
      }
      if (files.length >= maxFiles) {
        /* the code multer raises differs between the two helpers — single() calls it too many
           files, array() calls the extra file unexpected — although both become one message */
        failure = mode === "single"
          ? new MulterError("LIMIT_FILE_COUNT", "Too many files")
          : new MulterError("LIMIT_UNEXPECTED_FILE", "Unexpected file field");
        continue;
      }
      /* fileFilter runs before the bytes are read, so a refused type beats a size complaint */
      if (!extension) {
        failure = rejectedError("Use a PNG, JPG, WEBP, GIF, MP4 or PDF file");
        continue;
      }
      if (value.size > config.maxBytes) {
        failure = new MulterError("LIMIT_FILE_SIZE", "File too large");
        continue;
      }

      const filename = `${newFilename(req)}${extension}`;
      const bytes = await value.arrayBuffer();
      await bucket().put(`${config.directory}/${filename}`, bytes, {
        httpMetadata: { contentType: mimetype },
      });
      files.push({
        fieldname: name,
        originalname: value.name,
        encoding: "7bit",
        mimetype,
        size: value.size,
        destination: `${UPLOAD_ROOT}/${config.directory}`,
        filename,
        path: publicUrl(kind, filename),
      });
    }

    if (failure) {
      /* multer aborts the whole request on the first problem; nothing already uploaded is kept */
      await Promise.all(files.map(f => bucket().delete(`${config.directory}/${f.filename}`).catch(() => {})));
      return refuse(res, field, messageFor(failure, limitMb, maxFiles));
    }

    req.body = Object.assign({}, req.body, body);
    if (maxFiles === 1) req.file = files[0] || undefined;
    else req.files = files;
    return next();
  };
}

/** multer's own code for "one file too many" depends on which helper was used — see the probe. */
function messageFor(error, limitMb, maxFiles) {
  if (error.code === "LIMIT_FILE_SIZE") return `Keep each file under ${limitMb} MB.`;
  if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE") {
    return `Attach up to ${maxFiles} file${maxFiles > 1 ? "s" : ""}.`;
  }
  if (error.rejected) return error.message;
  return "Upload failed. Please try again.";
}

function refuse(res, field, message) {
  return res.status(400).json({
    error: { code: "validation_error", message, fields: { [field]: message } },
  });
}

/* ------------------------------------------------------------------ *
 *   serving /uploads
 * ------------------------------------------------------------------ */

/* what express.static would have answered, kept for the backfill's sake: an object uploaded
   before contentType was recorded still has to render as an image rather than download as
   application/octet-stream */
const EXTENSION_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

/** Turn /uploads/<file> into an R2 key, or null when the path tries to leave the bucket root. */
function keyFromPath(pathname) {
  const prefix = `${UPLOAD_ROOT}/`;
  if (!pathname.startsWith(prefix)) return null;
  const relative = decodeURIComponent(pathname.slice(prefix.length));
  if (!relative || relative.includes("..") || relative.includes("\\") || relative.startsWith("/")) return null;
  const normalised = path.posix.normalize(relative);
  if (normalised.startsWith("..") || path.posix.isAbsolute(normalised)) return null;
  return normalised;
}

const utc = date => new Date(date).toUTCString();

/**
 * send()'s range parser (measured against express.static, probe in cf-api/tools/test-upload.mjs):
 * only a single `bytes=a-b` request is honoured, and anything else — a list, a unit that is not
 * bytes, spaces around the '=', an empty or bare-dash value — is ignored and the whole file is
 * served.  Getting this wrong in the strict direction would turn a browser's multi-range probe
 * into a 416 the VPS never produced.
 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] === "" || m[2] === "" ? size - 1 : Number(m[2]);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start, end: Math.min(end, size - 1) };
}

/** the app's own error middleware (server.js:164) answers a send() error with this envelope */
function rangeUnsatisfiable(size, type, staged) {
  const body = JSON.stringify({ error: { code: "validation_error", message: "Range Not Satisfiable", fields: {} } });
  /* send() had already staged content-type, etag and last-modified on the response before the
     range was found unsatisfiable, and the app's envelope leaves those in place — which is why the
     content-type of this error is the video's, not application/json */
  const headers = new Headers(staged);
  headers.set("content-type", `${type}; charset=utf-8`);
  headers.set("content-range", `bytes */${size}`);
  headers.set("content-length", String(new TextEncoder().encode(body).length));
  return new Response(body, { status: 416, headers });
}

/**
 * Serve one object from R2 with the headers express.static produced: range support for the video
 * player, conditional revalidation, and Cross-Origin-Resource-Policy relaxed so the SPA can embed
 * the image from another origin. Returns null when the object does not exist, which lets
 * worker.js answer with the same 404 envelope the app's fallthrough produced on the VPS.
 */
async function serveUpload(request, env) {
  const url = new URL(request.url);
  const key = keyFromPath(url.pathname);
  if (!key) return null;
  const media = (env || ENV) && (env || ENV).MEDIA;
  if (!media) throw new Error("shims/upload: serveUpload needs env.MEDIA");

  const head = await media.head(key);
  if (!head) return null;

  const size = head.size;
  const type = typeOf(head, key);
  /* express.static's default etag is the weak W/"{size in hex}-{mtime in hex}" form; R2 hands back
     its own opaque etag, which serves the same purpose as long as it is stable per object */
  const etag = `"${String(head.etag || "").replace(/^"|"$/g, "")}"`;
  const lastModified = head.uploaded ? utc(head.uploaded) : null;

  /* send()'s revalidation order: an ETag match wins, then If-Modified-Since */
  const headers = new Headers();
  headers.set("cache-control", "public, max-age=604800, immutable");
  headers.set("accept-ranges", "bytes");
  headers.set("cross-origin-resource-policy", "cross-origin");
  if (lastModified) headers.set("last-modified", lastModified);
  if (etag) headers.set("etag", etag);
  /* a 304 carries these and nothing else — express.static removes the content-type it had staged */
  const withBody = extra => {
    const out = new Headers(headers);
    for (const [k, v] of Object.entries(extra || {})) out.set(k, String(v));
    return out;
  };

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && (ifNoneMatch.trim() === "*" || ifNoneMatch === etag || looseEtagMatch(ifNoneMatch, etag))) {
    return new Response(null, { status: 304, headers });
  }
  const ifModifiedSince = request.headers.get("if-modified-since");
  if (!ifNoneMatch && ifModifiedSince && lastModified && Date.parse(ifModifiedSince) >= Date.parse(lastModified)) {
    return new Response(null, { status: 304, headers });
  }

  const wanted = parseRange(request.headers.get("range"), size);
  if (wanted && (wanted.start < 0 || wanted.start > wanted.end || wanted.start >= size)) {
    return rangeUnsatisfiable(size, type, headers);
  }

  headers.set("content-type", type);
  const extra = wanted
    ? { "content-range": `bytes ${wanted.start}-${wanted.end}/${size}`, "content-length": wanted.end - wanted.start + 1 }
    : { "content-length": size };
  /* a HEAD carries the same headers and no body, which is how a player sizes the clip before
     it commits to the download */
  let body = null;
  if (request.method !== "HEAD") {
    const object = wanted
      ? await media.get(key, { range: { offset: wanted.start, length: wanted.end - wanted.start + 1 } })
      : await media.get(key);
    if (!object) return null;
    body = object.body;
  }
  return new Response(body, { status: wanted ? 206 : 200, headers: withBody(extra) });
}

/* RFC 9110: a conditional GET compares If-None-Match against the strong form of a weak ETag. */
function looseEtagMatch(given, ours) {
  const strip = value => String(value).split(",").map(part => part.trim().replace(/^W\//, "")).join(",");
  return strip(given) === strip(ours);
}

function typeOf(head, key) {
  const declared = head.httpMetadata && head.httpMetadata.contentType;
  if (declared && declared !== "application/octet-stream") return declared;
  return EXTENSION_TYPES[path.extname(key).toLowerCase()] || "application/octet-stream";
}

module.exports = {
  UPLOAD_ROOT,
  KINDS,
  init,
  uploadImage: (kind, field = "file") => uploader(kind, field, 1, "single"),
  uploadFiles: (kind, field = "files", maxFiles = 8) => uploader(kind, field, maxFiles, "array"),
  publicUrl,
  mediaType,
  removeStored,
  serveUpload,
  keyFromPath,
};
