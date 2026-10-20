/* The VPS db.js constructs a pg.Pool at module scope, which a Worker cannot do.  src/db.js is
   the tested D1 adapter with the same calling convention: it exports {init, query,
   pool: {query, connect}, health, notes}, which satisfies every consumer in the mirror —
   14 files destructure {query}, routes/onboarding.js:4 and routes/spa/ops.js:6 take {pool}
   for the BEGIN/COMMIT transaction (emulated over DB.batch(), see db.js:79-132), and the
   server.js health check arrives via src/api.js. */
module.exports = require("../src/db.js");
