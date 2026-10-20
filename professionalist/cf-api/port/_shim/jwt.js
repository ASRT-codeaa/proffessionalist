/* src/shims/jwt.js mirrors jsonwebtoken 9.0.3 HS256 sign/verify/decode synchronously —
   routes/auth.js issueToken returns jwt.sign(...) without await, so any async substitute would
   mint "[object Promise]" tokens.  Same-secret verification keeps VPS-issued tokens valid across
   the hostname flip. */
module.exports = require("../../src/shims/jwt.js");
