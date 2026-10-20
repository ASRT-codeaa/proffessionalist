/* services/mailer.js (SendInBlue REST via https.request) stays verbatim under this proxy:
   src/shims/https.js re-implements the node:https client API surface it uses (request() with
   write/end, response 'data'/'end'/'error' events) on top of fetch, including the timeout and
   non-2xx behaviours the retry loop in mailer.js:72-121 depends on. */
module.exports = require("../../src/shims/https.js");
