const { query } = require("../db");
const dto = require("./spaDto");

/* -------------------------------------------------------------------------- */
/*  Shared plumbing for the SPA-facing routers: the error envelope the client  */
/*  parses, small input guards, and row hydration helpers.                    */
/* -------------------------------------------------------------------------- */

const KINDS = ["post", "job", "product", "service", "article"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uid(req) {
  return Number(req.user && req.user.sub);
}

function isStaff(req) {
  return ["staff", "admin"].includes(req.user && req.user.role);
}

function fail(res, status, code, message, fields) {
  return res.status(status).json({ error: { code, message, fields: fields || {} } });
}

function invalid(res, fields, message = "Please correct the highlighted fields") {
  return fail(res, 400, "validation_error", message, fields);
}

function missing(res, what) {
  return fail(res, 404, "not_found", `${what} was not found`);
}

function forbidden(res, message) {
  return fail(res, 403, "forbidden", message);
}

class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

/** Express 5 only forwards rejections from middleware chains we control. */
function handle(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      if (err instanceof HttpError && err.status === 400) return invalid(res, err.fields || { value: err.message });
      if (err instanceof HttpError) return fail(res, err.status, "api_error", err.message);
      console.error("spa route error:", err && err.stack);
      return fail(res, 500, "api_error", "Something went wrong on our side. Please try again.");
    });
  };
}

/** Turns a JS value into the next positional parameter and returns "$n". */
function builder(start = []) {
  const params = [...start];
  return {
    params,
    add(value) {
      params.push(value);
      return `$${params.length}`;
    },
    at() {
      return params.length + 1;
    },
  };
}

function toId(value, name = "id") {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, `${name} is invalid`, { [name]: "Not valid" });
  return n;
}

function toUuid(value, name = "id") {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (!UUID.test(text)) throw new HttpError(400, `${name} is invalid`, { [name]: "Not valid" });
  return text;
}

function str(value, max = 4000) {
  return String(value === null || value === undefined ? "" : value).trim().slice(0, max);
}

function list(value, max = 20) {
  if (!Array.isArray(value)) return [];
  return value.map(v => str(v, 200)).filter(Boolean).slice(0, max);
}

function isStoredMedia(url) {
  return typeof url === "string" && (/^\/uploads\/[\w./-]+$/.test(url) || /^https?:\/\//i.test(url));
}

function paging(req, defaultSize = 10) {
  return dto.paging(req, { pageSize: defaultSize });
}

function likeValue(term) {
  return `%${str(term, 100).toLowerCase().replace(/[%_\\]/g, m => `\\${m}`)}%`;
}

async function ensureProfile(userId) {
  await query(
    `INSERT INTO profiles (user_id, username, visibility)
     SELECT $1, u.username, 'public' FROM users u WHERE u.id = $1
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

async function notify({ userId, actorId, type, title, body, entityType, entityId, href }) {
  const target = Number(userId);
  if (!Number.isSafeInteger(target) || target === Number(actorId)) return;
  await query(
    `INSERT INTO notifications (user_id, actor_id, type, entity_type, entity_id, title, body, href)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [target, actorId || null, type, entityType || null,
      entityId === null || entityId === undefined ? null : entityId,
      str(title, 200) || "Notification", str(body, 500) || null, href || null]
  ).catch(err => console.error("notify failed:", err.message));
}

async function businessesFor(rows, viewer) {
  const ids = [...new Set(rows.map(r => r.company_id).filter(Boolean).map(Number))];
  if (!ids.length) return new Map();
  const result = await query(
    `SELECT ${dto.BUSINESS_COLUMNS},
            EXISTS (SELECT 1 FROM company_followers cf WHERE cf.company_id = c.id AND cf.user_id = $2) AS following
       FROM companies c
      WHERE c.id = ANY($1::bigint[])`,
    [ids, viewer]
  );
  const map = new Map();
  for (const row of result.rows) map.set(num(row.id), dto.toBusiness(row));
  return map;
}

function num(value, fallback = 0) {
  return dto.num(value, fallback);
}

/** Person DTO with the openTo field the SPA reads on cards. */
function person(row) {
  const p = require("./userDto").toPerson(row);
  p.openTo = dto.strArray(row.open_to);
  return p;
}

async function peopleQuery({ where, params, viewer, limit = 20, offset = 0, order = "u.id" }) {
  const result = await query(
    `SELECT ${dto.PERSON_COLUMNS}, ${dto.statusColumns(String(viewer))}
       FROM users u
       LEFT JOIN profiles pr ON pr.user_id = u.id
      WHERE ${where}
      ORDER BY ${order}
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params
  );
  return result.rows.map(person);
}

module.exports = {
  KINDS, UUID, HttpError,
  uid, isStaff, handle, builder, fail, invalid, missing, forbidden,
  toId, toUuid, str, list, isStoredMedia, paging, likeValue,
  ensureProfile, notify, businessesFor, person, peopleQuery, num,
};
