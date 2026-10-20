/* The D1-backed stand-in for the app's pg Pool.  Routes destructure {query} from this module at
   import time, so every export is a stable reference and the Worker's env arrives later, via init().
   Surface required by §6: { query, pool: { query, connect }, health } — 14 files take { query },
   onboarding.js takes { pool, query }, server.js takes { health, query }.
   The SQL dialect is pg-compat.js's job; what lives here is the calling convention: pg-shaped
   results, and the BEGIN/COMMIT emulation the two transaction sites need, because D1 refuses those
   statements and its atomic unit is DB.batch(). */
const compat = require("./pg-compat.js");
const columnsJson = require("../compat/columns.json");

const kinds = compat.loadColumnKinds(columnsJson);

let DB = null;

/* translation notes collected while serving, deduplicated and capped: the deploy log reads this to
   find app SQL the adapter guessed at instead of saying nothing */
const notes = [];
function collect(t) {
  for (const n of t.notes) if (notes.length < 200 && !notes.includes(n)) notes.push(n);
}

function sqlState(message) {
  if (/UNIQUE constraint failed/i.test(message)) return "23505";
  if (/FOREIGN KEY constraint failed/i.test(message)) return "23503";
  if (/CHECK constraint failed/i.test(message)) return "23514";
  if (/NOT NULL constraint failed/i.test(message)) return "23502";
  if (/datatype mismatch/i.test(message)) return "42804";
  return undefined;
}

function fail(message, sql) {
  const err = new Error(message);
  err.code = sqlState(message);
  err.sql = sql;
  return err;
}

/* D1 rejects a failed statement by throwing (a Worker never sees a success:false return the way a
   hand-written REST caller might), so the SQLSTATE mapping has to happen on the rejection path or
   routes that branch on err.code get an unrecognisable error */
async function d1(fn, sql) {
  try {
    return await fn();
  } catch (err) {
    const message = String((err && err.message) || err);
    if (!sqlState(message)) throw err;
    const mapped = fail(message, sql);
    mapped.cause = err;
    throw mapped;
  }
}

const firstWord = sql => (String(sql).trim().match(/^[a-z_]+/i) || [""])[0].toUpperCase();
const isRead = sql => /^(SELECT|WITH|VALUES|SHOW|EXPLAIN)\b/.test(sql.trim().toUpperCase());

function result(sql, rows, meta, command) {
  const rowCount = isRead(sql) ? rows.length : meta && meta.changes !== undefined ? meta.changes : rows.length;
  return { rows, rowCount, command: command || firstWord(sql) };
}

/* one statement, straight to D1 */
async function run(text, params) {
  const sql = String(text);
  const t = compat.translateSql(sql, params == null ? [] : params);
  collect(t);
  const stmt = DB.prepare(t.sql);
  /* encodeParams, not the raw list: D1 has no array/Date/jsonb parameter type, so binding a JS array
     is what the batched path below already avoids and what this path did not — proven 2026-10-20 by
     the route diff, where `routes/meta.js`'s `= ANY($1::text[])` answered 0 rows here (and the
     unencoded bind can also fail outright with "malformed JSON") while the transaction path, which
     encodes at db.js:118, returned rows.  pg accepts arrays natively, so every route that binds one
     was silently reading an empty result on the Worker. */
  const bind = compat.encodeParams(t.params);
  const res = await d1(() => (bind.length ? stmt.bind(...bind).all() : stmt.all()), t.sql);
  if (res && res.success === false) throw fail(String((res.error && res.error.message) || "D1 refused the statement"), t.sql);
  return Object.assign(
    result(sql, compat.decodeRows(res.results || [], compat.resultHints(sql, kinds)), res.meta),
    { d1: { sql: t.sql, notes: t.notes, meta: res.meta } });
}

async function query(text, params) {
  if (!DB) throw new Error("db not initialised: call init(env) first");
  return run(text, params);
}

/* The two transaction sites (routes/onboarding.js:137, routes/spa/ops.js:393) drive
   BEGIN ... writes ... COMMIT.  Writes are buffered here and flushed as one DB.batch(), measured in
   §5.6 to roll the whole batch back if any statement fails.  A read inside the transaction would
   have to see the buffered writes, and a batch cannot be read before it lands, so those are named
   for hand porting rather than answered with the pre-transaction state. */
function connect() {
  let open = false;
  let pending = [];
  const client = {
    query: async (text, params) => {
      if (!DB) throw new Error("db not initialised: call init(env) first");
      const sql = String(text).trim().replace(/;+$/, "");
      const head = firstWord(sql);
      if (head === "BEGIN" || /^START\s+TRANSACTION\b/i.test(sql)) {
        if (open) throw new Error("db.connect: D1 cannot nest transactions");
        open = true; pending = [];
        return { rows: [], rowCount: 0, command: head };
      }
      if (head === "COMMIT") {
        if (!open) return { rows: [], rowCount: 0, command: "COMMIT" };
        const batch = pending;
        open = false; pending = [];
        if (!batch.length) return { rows: [], rowCount: 0, command: "COMMIT" };
        const results = await d1(() => DB.batch(batch.map(s => DB.prepare(s.sql).bind(...s.params))),
          batch.map(s => s.sql).join("; ").slice(0, 200));
        const touched = results.reduce((n, r) => n + (r.meta ? r.meta.changes || 0 : 0), 0);
        return { rows: [], rowCount: touched, command: "COMMIT",
          d1: { batched: batch.length, notes: batch.flatMap(s => s.notes) } };
      }
      if (head === "ROLLBACK") {
        const discarded = pending.length;
        open = false; pending = [];
        return { rows: [], rowCount: 0, command: "ROLLBACK", d1: { discarded } };
      }
      const t = compat.translateSql(sql, params == null ? [] : params);
      collect(t);
      if (open) {
        const deferrable = /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(t.sql) && !/\bRETURNING\b/i.test(sql);
        if (deferrable) {
          pending.push({ sql: t.sql, params: compat.encodeParams(t.params), notes: t.notes });
          return { rows: [], rowCount: 0, command: firstWord(sql), d1: { deferred: true, notes: t.notes } };
        }
        throw fail(`needs hand port: ${isRead(t.sql)
          ? "a read inside a transaction cannot see the writes still buffered for COMMIT"
          : "this statement cannot be deferred into the batch"} -- ${sql.slice(0, 140)}`, t.sql);
      }
      return run(sql, params);
    },
    /* pg releases the connection and its open transaction dies with it */
    release: () => { open = false; pending = []; },
    end: () => { open = false; pending = []; },
  };
  return Promise.resolve(client);
}

/* server.js wraps health() in try/catch and answers 503 from the catch, so an unreachable database
   has to reject the way pool.query("SELECT 1") does — returning false would report "connected" */
async function health() {
  if (!DB) throw new Error("db not initialised: call init(env) first");
  const r = await run("SELECT 1 AS ok", []);
  if (Number(r.rows[0] && r.rows[0].ok) !== 1) throw new Error("health: unexpected reply to SELECT 1");
  return true;
}

const db = {
  init(env) {
    DB = (env && env.DB) || env || null;
    if (!DB || typeof DB.prepare !== "function") throw new Error("db.init: env.DB is not a D1 binding");
    return db;
  },
  query,
  pool: { query, connect },
  health,
  notes,
};

module.exports = db;
