const express = require("../../_shim/express.js");
const { query } = require("../../db");
const kit = require("../../services/spaKit");
const dto = require("../../services/spaDto");

/* -------------------------------------------------------------------------- *
 *  Ad campaigns, mounted at /api ahead of the spa/platform catch-all.
 *
 *  The advertising page (src/pages/AdvertisingPage.tsx, payloadFromForm) is the
 *  only author of these shapes, so the whitelist mirrors its form fields and
 *  nothing more.  D1 stores audience/metrics as TEXT JSON; dto.toCampaign
 *  expects objects, so every row is parsed on the way out.
 *
 *  The daily-metrics chart stays empty (dto returns daily:[]) — there is no
 *  rollup table, and inventing one was explicitly ruled out.  spend starts at
 *  0 and metrics at zeros; there is no billing pipeline that could move them.
 * -------------------------------------------------------------------------- */

const router = express.Router();

const { handle, invalid, missing, toId, uid, str, list } = kit;

const OBJECTIVES = ["awareness", "traffic", "engagement", "leads", "sales"];
const FORMATS = ["feed", "marketplace", "banner", "sponsored_profile", "sponsored_product"];
const STATUSES = ["draft", "active", "paused", "completed"];

const EMPTY_METRICS = { impressions: 0, clicks: 0, engagement: 0, conversions: 0 };

function parseJson(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeAudience(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    industries: list(source.industries, 30).map(entry => str(entry, 80)).filter(Boolean),
    locations: list(source.locations, 30).map(entry => str(entry, 80)).filter(Boolean),
    interests: list(source.interests, 30).map(entry => str(entry, 80)).filter(Boolean),
    ageRange: str(source.ageRange, 40),
  };
}

/* One whitelist, used whole on create and partially on patch. */
function campaignFields(req) {
  const values = {};
  const fields = {};
  const b = req.body || {};

  if (b.name !== undefined) {
    const name = str(b.name, 120).trim();
    if (!name) fields.name = "Give the campaign a name";
    else values.name = name;
  }
  if (b.objective !== undefined) {
    if (!OBJECTIVES.includes(b.objective)) fields.objective = "Unknown objective";
    else values.objective = b.objective;
  }
  if (b.format !== undefined) {
    if (!FORMATS.includes(b.format)) fields.format = "Unknown format";
    else values.format = b.format;
  }
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) fields.status = "Unknown status";
    else values.status = b.status;
  }
  if (b.budget !== undefined) {
    const budget = Number(b.budget);
    if (!Number.isFinite(budget) || budget < 0) fields.budget = "Budget must be a non-negative number";
    else values.budget = budget;
  }
  if (b.startDate !== undefined) values.startDate = str(b.startDate, 40);
  if (b.endDate !== undefined) values.endDate = str(b.endDate, 40);
  if (b.creativeUrl !== undefined) values.creativeUrl = str(b.creativeUrl, 500);
  if (b.creativeText !== undefined) values.creativeText = str(b.creativeText, 1000);
  if (b.destination !== undefined) values.destination = str(b.destination, 500);
  if (b.audience !== undefined) values.audience = JSON.stringify(normalizeAudience(b.audience));
  /* ownerBusinessId is accepted from the form and ignored: no column exists. */
  return { values, fields };
}

const SELECT = `SELECT id, user_id, name, objective, audience, budget, spend, start_date, end_date,
                       format, creative_url, creative_text, destination, status, metrics, created_at
                  FROM ad_campaigns`;

function campaignRow(row) {
  return dto.toCampaign({
    ...row,
    audience: parseJson(row.audience, {}),
    metrics: parseJson(row.metrics, EMPTY_METRICS),
  });
}

router.get("/ads/campaigns", handle(async (req, res) => {
  const rows = await query(`${SELECT} WHERE user_id = $1 ORDER BY id DESC`, [uid(req)]);
  res.json(rows.rows.map(campaignRow));
}));

router.post("/ads/campaigns", handle(async (req, res) => {
  const { values, fields } = campaignFields(req);
  if (!values.name) fields.name = fields.name || "Give the campaign a name";
  if (Object.keys(fields).length) return invalid(res, fields);

  const created = await query(
    `INSERT INTO ad_campaigns
       (user_id, name, objective, audience, budget, spend, start_date, end_date,
        format, creative_url, creative_text, destination, status, metrics)
     VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      uid(req),
      values.name,
      values.objective || "awareness",
      values.audience || JSON.stringify(normalizeAudience({})),
      values.budget === undefined ? 0 : values.budget,
      values.startDate || "",
      values.endDate || "",
      values.format || "feed",
      values.creativeUrl || "",
      values.creativeText || "",
      values.destination || "",
      values.status || "draft",
      JSON.stringify(EMPTY_METRICS),
    ]
  );
  const id = dto.num(created.rows[0].id);
  const row = await query(`${SELECT} WHERE id = $1`, [id]);
  res.status(201).json(campaignRow(row.rows[0]));
}));

const UPDATABLE = {
  name: "name",
  objective: "objective",
  audience: "audience",
  budget: "budget",
  startDate: "start_date",
  endDate: "end_date",
  format: "format",
  creativeUrl: "creative_url",
  creativeText: "creative_text",
  destination: "destination",
  status: "status",
};

router.patch("/ads/campaigns/:id", handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return invalid(res, { id: "Expected a numeric campaign id" });
  const { values, fields } = campaignFields(req);
  if (Object.keys(fields).length) return invalid(res, fields);

  const owns = await query(`SELECT id FROM ad_campaigns WHERE id = $1 AND user_id = $2`, [id, uid(req)]);
  if (!owns.rowCount) return missing(res, "Campaign");

  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (values[key] !== undefined) {
      params.push(values[key]);
      sets.push(`${column} = $${params.length + 1}`);
    }
  }
  if (sets.length) {
    params.unshift(id);
    await query(`UPDATE ad_campaigns SET ${sets.join(", ")} WHERE id = $1`, params);
  }
  const row = await query(`${SELECT} WHERE id = $1`, [id]);
  res.json(campaignRow(row.rows[0]));
}));

module.exports = router;
