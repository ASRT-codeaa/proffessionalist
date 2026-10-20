/* Every differential harness in this directory compares a port against the REAL npm package it
   replaces, so the packages have to be installed somewhere — outside the repository, because a
   node_modules inside it would be a second dependency tree that nobody updates.
   /tmp is not that somewhere: this codespace was recycled mid-migration and the jwt, rate-limit and
   multer oracles were wiped with it, which is why the default is /workspaces/oracles (the sibling of
   the repository, persistent across restarts).  Override with CF_ORACLE_DIR.
     npm --prefix /workspaces/oracles i express@5.3.0 multer@2.4.0 express-rate-limit@8.7.1 \
       helmet@8.3.0 cors@2.8.6 jsonwebtoken@9.0.3 bcryptjs@3.0.2 uuid@11 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATES = [
  process.env.CF_ORACLE_DIR,
  "/workspaces/oracles",
  path.join(os.homedir(), ".cf-oracles"),
  "C:/Users/Admin/.qoder/oracles",
].filter(Boolean);

export function oracleDir() {
  const found = CANDIDATES.filter(dir => fs.existsSync(path.join(dir, "node_modules", "express")));
  if (found.length) return found[0];
  throw new Error(
    "the npm oracles are not installed. Looked in:\n" +
    CANDIDATES.map(d => `  ${d}`).join("\n") +
    "\nInstall them with the npm --prefix line at the top of cf-api/tools/oracle.mjs."
  );
}

/** an absolute path to require() a real package from, e.g. oracle("express") */
export function oracle(name) {
  return path.join(oracleDir(), "node_modules", name);
}

/** a directory a harness may WRITE into (multer's UPLOAD_ROOT is relative to its own file) */
export function scratch(name) {
  const dir = path.join(oracleDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
