/* The port keeps every bare express require site byte-identical; this proxy is the single
   place the specifier resolves.  src/shims/express.js is the Express-5 subset on the Fetch API
   (express(), express.Router, express.json, express.urlencoded; express.static throws on
   purpose — asset serving goes through the Worker fetch handler, not the middleware stack). */
module.exports = require("../../src/shims/express.js");
