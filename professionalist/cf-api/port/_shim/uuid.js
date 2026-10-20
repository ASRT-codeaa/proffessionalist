/* uuid's v4 is 16 random bytes with the version-4 and RFC-4122 variant nibbles set; Node's
   crypto.randomUUID() (and workerd's global crypto) emits exactly that 8-4-4-4-12 lowercase-hex
   shape, so v4 is a pass-through instead of a hand-rolled CSPRNG.  validate keeps the package's
   accepted-version set (1-8, variant 89ab).  The only consumer is routes/auth.js:5
   ({ v4: uuidv4 }); NIL/stringify/v1 are omitted rather than guessed at because nothing calls
   them and an unverified implementation is worse than a missing one. */
const { randomUUID } = require("crypto");
const V_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function v4() {
  return randomUUID();
}
function validate(value) {
  return V_RE.test(String(value));
}
module.exports = { v4, validate };
