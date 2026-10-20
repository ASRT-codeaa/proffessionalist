/* Cross-verify cf-api/src/shims/jwt.js against the real jsonwebtoken package, both directions.
   The point is not that my port is self-consistent — it is that a token issued by the VPS
   (jsonwebtoken 9.0.3, HS256, same JWT_SECRET) verifies in the Worker and vice versa, because the
   whole migration depends on users NOT being logged out when the hostname flips.
   The oracle is installed outside the repo:  cd /tmp/jwt-oracle && npm i jsonwebtoken@9
   node cf-api/tools/test-jwt.mjs */
import { createRequire } from "node:module";
import { oracle } from "./oracle.mjs";

const require = createRequire(import.meta.url);
const mine = require("../src/shims/jwt.js");
const real = require(oracle("jsonwebtoken"));

let PASS = 0; const FAILS = [];
const check = (name, ok, detail) => {
  if (ok) { PASS++; console.log(`  ok    ${name}${detail ? ` -> ${String(detail).slice(0, 110)}` : ""}`); }
  else { FAILS.push(name); console.log(`  FAIL  ${name}${detail ? ` -> ${String(detail).slice(0, 170)}` : ""}`); }
};
const SECRET = "unit-test-secret-not-the-real-one";
/* the exact claims routes/auth.js puts in a session token */
const OPTS = { issuer: "professionalist-api", audience: "professionalist" };
const payload = () => ({ sub: "42", role: "individual", sessionId: "2f6d4d3e-8f0a-4a11-9b2c-1d3e5f7a9b0c" });

console.log("== interop: the two implementations must accept each other's tokens ==");
{
  const t1 = real.sign(payload(), SECRET, Object.assign({ expiresIn: "2h" }, OPTS));
  const p1 = mine.verify(t1, SECRET, OPTS);
  check("a VPS-issued token verifies in the Worker", p1.sub === "42" && p1.role === "individual" && p1.sessionId === payload().sessionId,
    `sub=${p1.sub} exp in ${Math.round((p1.exp - Date.now() / 1000) / 60)}m`);
  const t2 = mine.sign(payload(), SECRET, Object.assign({ expiresIn: "2h" }, OPTS));
  const p2 = real.verify(t2, SECRET, OPTS);
  check("a Worker-issued token verifies on the VPS (rollback must not log anyone out)",
    p2.sub === "42" && p2.iss === "professionalist-api" && p2.aud === "professionalist", `iss=${p2.iss}`);
  const fixed = Object.assign(payload(), { iat: 1700000000, exp: 1700007200 });
  const a = mine.sign(fixed, SECRET, OPTS);
  const b = real.sign(fixed, SECRET, OPTS);
  check("byte-identical for identical claims, so nothing subtle differs in encoding", a === b, a.slice(0, 32) + "…");
  /* the property that actually matters: two machines signing the same payload 1ms apart agree on
     exp because it counts from iat, so a token minted on the VPS and one minted in the Worker
     expire at the same instant */
  const rel = real.sign(Object.assign(payload(), { iat: 1700000000 }), SECRET, Object.assign({ expiresIn: 3600 }, OPTS));
  const relMine = mine.sign(Object.assign(payload(), { iat: 1700000000 }), SECRET, Object.assign({ expiresIn: 3600 }, OPTS));
  check("expiresIn counts from payload.iat, not the wall clock (number form)", rel === relMine,
    `exp=${mine.decode(relMine).exp} iat=1700000000`);
  let collide = null, collideReal = null;
  try { real.sign(Object.assign(payload(), { exp: 1 }), SECRET, Object.assign({ expiresIn: "2h" }, OPTS)); } catch (e) { collideReal = e; }
  try { mine.sign(Object.assign(payload(), { exp: 1 }), SECRET, Object.assign({ expiresIn: "2h" }, OPTS)); } catch (e) { collide = e; }
  check("sign() refuses expiresIn alongside a payload exp instead of quietly ignoring one",
    !!collideReal && !!collide && collide.message === collideReal.message,
    `${collideReal && collideReal.message} / ${collide && collide.message}`);
}

console.log("\n== rejection parity: a wrong answer must fail, and fail like jsonwebtoken ==");
{
  const good = mine.sign(payload(), SECRET, OPTS);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const expired = mine.sign(Object.assign(payload(), { exp: 1000000, iat: 999999 }), SECRET, OPTS);
  const tampered = (() => {
    const [h, , s] = good.split(".");
    return `${h}.${b64({ sub: "1", role: "admin", sessionId: "x", iss: "professionalist-api", aud: "professionalist", exp: 9e9, iat: 1 })}.${s}`;
  })();

  /* [label, token, secret, options, expected message] — each is fed to BOTH libraries. */
  const cases = [
    ["wrong secret", good, "other-secret", OPTS, /signature/i],
    ["tampered payload", tampered, SECRET, OPTS, /signature/i],
    ["wrong audience", good, SECRET, { issuer: "professionalist-api", audience: "someone-else" }, /aud/i],
    ["wrong issuer", good, SECRET, { issuer: "other", audience: "professionalist" }, /iss/i],
    ["expired", expired, SECRET, OPTS, /expired/i],
    ["malformed", "not.a.jwt", SECRET, OPTS, /malformed|invalid token/i],
    ["alg none", `${b64({ alg: "none", typ: "JWT" })}.${b64(payload())}.`, SECRET, OPTS, /signature|alg/i],
  ];

  for (const [name, token, secret, opts, re] of cases) {
    let realErr = null, mineErr = null;
    try { real.verify(token, secret, opts); } catch (e) { realErr = e; }
    try { mine.verify(token, secret, opts); } catch (e) { mineErr = e; }
    const bothRefused = !!realErr && !!mineErr;
    check(`${name}: both libraries refuse`, bothRefused && re.test(String(realErr && realErr.message)),
      `jsonwebtoken="${realErr && realErr.message}" mine="${mineErr && mineErr.message || "ACCEPTED!"}"`);
    if (bothRefused) {
      check(`  ...as the same error class`, realErr.name === mineErr.name, `${realErr.name} vs ${mineErr.name}`);
      /* authenticate.js throws the message away, but the differential harness compares bodies, and
         a wording drift there would look like a behavioural change in the port. */
      check(`  ...with the same message`, String(realErr.message) === String(mineErr.message),
        `${JSON.stringify(realErr.message)} vs ${JSON.stringify(mineErr.message)}`);
    }
  }
}

console.log("\n== the sync contract routes depend on ==");
{
  const t = mine.sign(payload(), SECRET, Object.assign({ expiresIn: "2h" }, OPTS));
  check("sign() returns a string, not a Promise (issueToken does not await it)",
    typeof t === "string" && !t.includes("[object Promise]") && t.split(".").length === 3, String(t).slice(0, 24) + "…");
  const d = mine.decode(t);
  check("decode() reads claims without verifying, as jsonwebtoken's decode does", d.sub === "42" && d.iss === "professionalist-api");
  check("uuid() gives a v4 the auth_sessions uuid column will accept",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(mine.uuid()), mine.uuid());
}

console.log(`\nVERDICT: ${PASS} passed, ${FAILS.length} failed`);
if (FAILS.length) { for (const f of FAILS) console.log(`  - ${f}`); process.exit(1); }
console.log("HS256 tokens move between the VPS and the Worker without re-issuing a single session.");
