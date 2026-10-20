/* These tools run both on the Windows workstation where the migration evidence was produced
   and in a Linux codespace, so every external path is resolved from candidates rather than
   assumed. Override with CF_TOKEN_FILE, CF_TMP_DIR or APP_MIRROR_DIR.
   Nothing here reads a secret onto a command line or into a printed message. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WIN_TMP = "C:/Users/Admin/.qoder/tmp/d1move";
const WIN_TOKEN = "C:/Users/Admin/.cf_token_tmp";
const WIN_APP = "C:/Users/Admin/.qoder/tmp/spa-fix/app";

const CANDIDATES = {
  tmp: () => [process.env.CF_TMP_DIR, WIN_TMP, path.join(os.homedir(), ".qoder/tmp/d1move")],
  token: () => [process.env.CF_TOKEN_FILE, WIN_TOKEN, path.join(os.homedir(), ".cf_token_tmp")],
  app: () => [
    process.env.APP_MIRROR_DIR,
    "/workspaces/app-mirror/app",
    WIN_APP,
    path.join(os.homedir(), ".qoder/tmp/spa-fix/app"),
  ],
};

function tried(key) {
  return CANDIDATES[key]().filter(Boolean);
}

function notFound(key) {
  return new Error(
    `missing ${key} path. Looked in:\n${tried(key).map(p => `  ${p}`).join("\n")}\n` +
    `Copy it here, or set ${key === "app" ? "APP_MIRROR_DIR" : key === "token" ? "CF_TOKEN_FILE" : "CF_TMP_DIR"}.`
  );
}

/* the first candidate that exists, or a message naming every place we looked */
export function locate(key) {
  const found = tried(key).find(p => fs.existsSync(p));
  if (found) return found;
  throw notFound(key);
}

export function readTrim(key, rel) {
  const file = rel ? path.join(locate(key), rel) : locate(key);
  if (!fs.existsSync(file)) throw new Error(`missing ${rel || key} at ${file}`);
  return fs.readFileSync(file, "utf8").trim();
}

/* a directory a tool may WRITE ids into: the located one, else the homedir default (created).
   Used by create-db.mjs, which establishes d1-id.txt rather than reading it. */
export function writableDir(key) {
  const env = key === "tmp" ? process.env.CF_TMP_DIR : undefined;
  if (env) { fs.mkdirSync(env, { recursive: true }); return env; }
  try { return locate(key); } catch {
    const dir = path.join(os.homedir(), ".qoder/tmp/d1move");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

/* Redact anything secret-shaped out of a string BEFORE it is printed or put in an Error.
   The per-tool redactors this replaces only matched the `cfut_` token prefix; account API
   tokens minted from the R2/dashboard flow are `cfat_`, so an error body would have carried
   the token out unredacted. Also strips the account id and the dashed D1 uuids. */
const HOME = os.homedir();
const SECRET_FILES = [
  process.env.CF_TOKEN_FILE, path.join(HOME, ".cf_token_tmp"), WIN_TOKEN,
  process.env.CF_TMP_DIR ? path.join(process.env.CF_TMP_DIR, "acct.txt") : null,
  path.join(HOME, ".qoder/tmp/d1move/acct.txt"), WIN_TMP + "/acct.txt",
];

export function hideSecrets(text) {
  /* order matters: 32-hex runs before the dashed-uuid rule, or the uuid alternation eats the
     leading 8 hex characters of the account id embedded in an R2 endpoint or zone field */
  let out = String(text)
    .replace(/cf(at|ut)_[A-Za-z0-9]+/g, "[token]")
    .replace(/[0-9a-f]{32}/gi, "[account]")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[uuid]");
  for (const value of SECRET_FILES.map(f => f && fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : null).filter(Boolean)) {
    if (value.length > 6) out = out.split(value).join("[redacted]");
  }
  return out;
}

