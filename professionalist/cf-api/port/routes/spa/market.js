const express = require("../../_shim/express.js");
const { query } = require("../../db");
const dto = require("../../services/spaDto");
const kit = require("../../services/spaKit");
const { uploadFiles, publicUrl } = require("../../middleware/upload");

const router = express.Router();

const {
  handle, builder, invalid, missing, forbidden, toId, uid, str, list, num, paging,
  likeValue, isStoredMedia, isStaff, notify, businessesFor,
} = kit;

const PRICE_TYPES = ["fixed", "hourly", "starting_at", "negotiable", "free"];
const CONDITIONS = ["new", "like_new", "used", "n/a"];
const AVAILABILITY = ["available", "limited", "sold_out"];
const LISTING_STATUS = ["active", "paused", "sold", "removed"];
const OPPORTUNITY_KINDS = ["job", "freelance", "partnership", "business", "event", "project"];

/** One round trip per page: the sellers and companies behind a listing set. */
async function toListings(rows, viewer) {
  if (!rows.length) return [];
  const [people, businesses] = await Promise.all([
    dto.loadPeople(rows.map(r => r.seller_id), viewer),
    businessesFor(rows, viewer),
  ]);
  return rows.map(r => dto.toListing(r, people, businesses));
}

const CATEGORY_SELECT = `
  SELECT lc.id::int AS id, lc.slug, lc.name, lc.icon,
         (SELECT COUNT(*) FROM marketplace_listings m
           WHERE m.category_id = lc.id AND m.status = 'active')::int AS count
    FROM listing_categories lc
   ORDER BY lc.name`;

/* -------------------------------------------------------------------------- */
/*                                marketplace                                 */
/* -------------------------------------------------------------------------- */

router.get("/marketplace/categories", handle(async (req, res) => {
  const rows = await query(CATEGORY_SELECT);
  res.json(rows.rows);
}));

/** Sections the marketplace home page renders, each with its own ranking. */
const HOME_SECTIONS = {
  featured: `m.status = 'active'`,
  recommended: `m.status = 'active'
                AND NOT EXISTS (SELECT 1 FROM listing_favorites lf WHERE lf.listing_id = m.id AND lf.user_id = $2)`,
  nearby: `m.status = 'active' AND COALESCE(m.location, '') <> ''`,
  new: `m.status = 'active'`,
  popular: `m.status = 'active'`,
};

function sectionOrder(name) {
  if (name === "featured") return `(SELECT COUNT(*) FROM listing_favorites lf WHERE lf.listing_id = m.id) DESC, m.created_at DESC`;
  if (name === "nearby") return `(LOWER(COALESCE(m.location, '')) LIKE $2) DESC NULLS LAST, m.created_at DESC`;
  if (name === "popular") return `COALESCE(m.views, 0) DESC, m.created_at DESC`;
  return `m.created_at DESC`;
}

router.get("/marketplace/home", handle(async (req, res) => {
  const me = uid(req);

  const [categories, home] = await Promise.all([
    query(CATEGORY_SELECT),
    query(`SELECT LOWER(COALESCE(NULLIF(location, ''), country, '')) AS location FROM profiles WHERE user_id = $1`, [me]),
  ]);
  const viewerLocation = str(home.rows[0] && home.rows[0].location, 180);

  const sections = await Promise.all(Object.keys(HOME_SECTIONS).map(name => {
    const where = HOME_SECTIONS[name].replace(/\$2/g, "$1");
    const params = [me];
    // sectionOrder("nearby") always binds $2, so the parameter must always exist:
    // an unknown viewer location becomes a match-all pattern and lets recency rule.
    if (name === "nearby") params.push(viewerLocation ? `%${viewerLocation}%` : "%%");
    return query(
      `SELECT ${dto.LISTING_COLUMNS}
         FROM marketplace_listings m
         ${dto.listingJoins("$1")}
        WHERE ${where}
        ORDER BY ${sectionOrder(name)}
        LIMIT 8`,
      params
    ).then(rows => toListings(rows.rows, me));
  }));

  res.json({
    categories: categories.rows,
    featured: sections[0],
    recommended: sections[1],
    nearby: sections[2],
    new: sections[3],
    popular: sections[4],
  });
}));

router.get("/marketplace/listings", handle(async (req, res) => {
  const me = uid(req);
  const { page, pageSize, offset } = paging(req, 12);
  const q = str(req.query.q, 100);
  const kind = req.query.kind === "service" || req.query.kind === "product" ? req.query.kind : null;
  const minPrice = req.query.minPrice === undefined || req.query.minPrice === "" ? null : Number(req.query.minPrice);
  const maxPrice = req.query.maxPrice === undefined || req.query.maxPrice === "" ? null : Number(req.query.maxPrice);
  const condition = CONDITIONS.includes(req.query.condition) ? req.query.condition : null;
  const location = str(req.query.location, 120);
  const section = ["featured", "recommended", "nearby", "new", "popular"].includes(req.query.section) ? req.query.section : null;

  const b = builder([me]);
  const where = [`m.status = 'active'`];
  if (q) {
    const like = b.add(likeValue(q));
    where.push(`(LOWER(m.title) LIKE ${like} OR LOWER(m.description) LIKE ${like} OR LOWER(COALESCE(m.location, '')) LIKE ${like})`);
  }
  if (req.query.categoryId) where.push(`m.category_id = ${b.add(toId(req.query.categoryId, "categoryId"))}`);
  if (kind) where.push(`m.listing_type = ${b.add(kind)}`);
  if (Number.isFinite(minPrice)) where.push(`m.price >= ${b.add(minPrice)}`);
  if (Number.isFinite(maxPrice)) where.push(`m.price <= ${b.add(maxPrice)}`);
  if (condition) where.push(`m.condition = ${b.add(condition)}`);
  if (["true", "1"].includes(String(req.query.near)) || section === "nearby") where.push(`COALESCE(m.location, '') <> ''`);
  if (location) where.push(`LOWER(COALESCE(m.location, '')) LIKE ${b.add(likeValue(location))}`);
  const clause = where.join(" AND ");

  const sortSql = {
    price_asc: `m.price ASC NULLS LAST`,
    price_desc: `m.price DESC NULLS LAST`,
    popular: `COALESCE(m.views, 0) DESC, m.created_at DESC`,
  }[req.query.sort] || `m.created_at DESC`;

  // The count query has no joins, so nothing in it mentions the viewer
  // placeholder $1. pg still has to be handed that value, and an unreferenced
  // parameter has no inferable type, so the count names it explicitly.
  const countParams = [...b.params];
  const [rows, total] = await Promise.all([
    query(
      `SELECT ${dto.LISTING_COLUMNS}
         FROM marketplace_listings m
         ${dto.listingJoins("$1")}
        WHERE ${clause}
        ORDER BY ${sortSql}
        LIMIT ${b.add(pageSize)} OFFSET ${b.add(offset)}`,
      b.params
    ),
    query(`SELECT COUNT(*)::int AS total FROM marketplace_listings m
            WHERE ${clause} AND ($1::bigint) IS NOT NULL`, countParams),
  ]);

  res.json(dto.paginate(await toListings(rows.rows, me), total.rows[0].total, page, pageSize));
}));

async function listingById(id, viewer) {
  const rows = await query(
    `SELECT ${dto.LISTING_COLUMNS}
       FROM marketplace_listings m
       ${dto.listingJoins("$1")}
      WHERE m.id = $2`,
    [viewer, id]
  );
  const [listing] = await toListings(rows.rows, viewer);
  return listing || null;
}

router.get("/marketplace/listings/:id", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const listing = await listingById(id, me);
  if (!listing) return missing(res, "Listing");
  await query(`UPDATE marketplace_listings SET views = COALESCE(views, 0) + 1 WHERE id = $1`, [id]);
  res.json(listing);
}));

router.get("/marketplace/listings/:id/related", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const rows = await query(
    `SELECT ${dto.LISTING_COLUMNS}
       FROM marketplace_listings m
       ${dto.listingJoins("$1")}
      WHERE m.status = 'active' AND m.id <> $2
        AND (m.category_id = (SELECT category_id FROM marketplace_listings WHERE id = $2)
             OR COALESCE(m.location, '') = COALESCE((SELECT location FROM marketplace_listings WHERE id = $2), ''))
      ORDER BY m.created_at DESC LIMIT 8`,
    [me, id]
  );
  res.json(await toListings(rows.rows, me));
}));

function imageList(body) {
  return (Array.isArray(body.images) ? body.images : []).map(u => str(u, 500)).filter(isStoredMedia);
}

router.post("/marketplace/listings", handle(async (req, res) => {
  const me = uid(req);
  const body = req.body || {};
  const title = str(body.title, 200);
  const description = str(body.description, 4000);
  const price = Number(body.price);

  const errors = {};
  if (!title) errors.title = "Give the listing a title";
  if (!description) errors.description = "Describe what you are offering";
  if (body.price !== undefined && body.price !== null && !Number.isFinite(price)) errors.price = "Price must be a number";
  if (Object.keys(errors).length) return invalid(res, errors);

  const images = imageList(body);

  const created = await query(
    `INSERT INTO marketplace_listings
       (seller_id, company_id, title, description, price, currency, location, listing_type,
        category_id, price_type, condition, availability, summary, tags, images, media_url, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'active')
     RETURNING id::int AS id`,
    [me, body.businessId ? toId(body.businessId, "businessId") : null,
      title, description, Number.isFinite(price) ? price : null,
      str(body.currency, 10).toUpperCase() || "USD", str(body.location, 180) || null,
      body.kind === "service" ? "service" : "product",
      body.categoryId ? toId(body.categoryId, "categoryId") : null,
      PRICE_TYPES.includes(body.priceType) ? body.priceType : "fixed",
      CONDITIONS.includes(body.condition) ? body.condition : "n/a",
      AVAILABILITY.includes(body.availability) ? body.availability : "available",
      str(body.summary, 500) || null, list(body.tags, 20), images, images[0] || null]
  );

  res.status(201).json(await listingById(created.rows[0].id, me));
}));

router.patch("/marketplace/listings/:id", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const body = req.body || {};
  const images = imageList(body);

  // A PATCH must not touch the columns the client did not send. str() turns an
  // absent value into "", which would blank the row, so every read is gated on
  // the key actually being present in the body.
  const sent = key => body[key] !== undefined && body[key] !== null;
  const text = (key, max) => (sent(key) ? str(body[key], max) : null);
  const currency = text("currency", 10);

  const candidates = {
    title: text("title", 200),
    description: text("description", 4000),
    price: sent("price") && Number.isFinite(Number(body.price)) ? Number(body.price) : null,
    currency: currency ? currency.toUpperCase() : null,
    location: text("location", 180),
    listing_type: sent("kind") && (body.kind === "service" || body.kind === "product") ? body.kind : null,
    category_id: sent("categoryId") ? toId(body.categoryId, "categoryId") : null,
    price_type: PRICE_TYPES.includes(body.priceType) ? body.priceType : null,
    condition: CONDITIONS.includes(body.condition) ? body.condition : null,
    availability: AVAILABILITY.includes(body.availability) ? body.availability : null,
    summary: text("summary", 500),
    tags: Array.isArray(body.tags) ? list(body.tags, 20) : null,
    media_url: images[0] || null,
    status: LISTING_STATUS.includes(body.status) ? body.status : null,
  };

  const b = builder();
  const idParam = b.add(id);
  const sets = [];
  for (const [column, value] of Object.entries(candidates)) {
    if (value === null || value === undefined) continue;
    sets.push(`${column} = ${b.add(value)}`);
  }
  if (images.length) sets.push(`images = ${b.add(images)}`);
  if (!sets.length) return res.json(await listingById(id, me));

  const meParam = b.add(me);
  const updated = await query(
    `UPDATE marketplace_listings
        SET ${sets.join(", ")}, updated_at = NOW()
      WHERE id = ${idParam}
        AND (seller_id = ${meParam} OR company_id IN
             (SELECT company_id FROM company_members WHERE user_id = ${meParam}))
      RETURNING id`,
    b.params
  );
  if (!updated.rowCount) return missing(res, "Listing");
  res.json(await listingById(id, me));
}));

router.delete("/marketplace/listings/:id", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const removed = isStaff(req)
    ? await query(`DELETE FROM marketplace_listings WHERE id = $1 RETURNING id`, [id])
    : await query(
        `DELETE FROM marketplace_listings
          WHERE id = $1 AND (seller_id = $2 OR company_id IN
                (SELECT company_id FROM company_members WHERE user_id = $2))
          RETURNING id`,
        [id, me]
      );
  if (!removed.rowCount) return missing(res, "Listing");
  res.json({ ok: true });
}));

router.post("/marketplace/listings/:id/favorite", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const found = await query(
    `SELECT ml.id, COALESCE(ml.company_id, -1)::int AS company_id, ml.seller_id::int AS seller_id, c.owner_id::int AS owner_id
       FROM marketplace_listings ml
       LEFT JOIN companies c ON c.id = ml.company_id
      WHERE ml.id = $1`,
    [id]
  );
  if (!found.rowCount) return missing(res, "Listing");

  const existing = await query(`SELECT 1 FROM listing_favorites WHERE listing_id = $1 AND user_id = $2`, [id, me]);
  if (existing.rowCount) {
    await query(`DELETE FROM listing_favorites WHERE listing_id = $1 AND user_id = $2`, [id, me]);
  } else {
    await query(`INSERT INTO listing_favorites (listing_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, me]);
    const row = found.rows[0];
    await notify({
      userId: row.owner_id > 0 ? row.owner_id : row.seller_id, actorId: me, type: "listing",
      title: "Someone favourited your listing", entityType: "listing", entityId: id, href: `/marketplace/${id}`,
    });
  }

  const count = await query(`SELECT COUNT(*)::int AS total FROM listing_favorites WHERE listing_id = $1`, [id]);
  res.json({ favorited: !existing.rowCount, favoriteCount: count.rows[0].total });
}));

router.post("/marketplace/images", uploadFiles("listing", "files", 8), handle(async (req, res) => {
  const files = req.files || [];
  if (!files.length) return invalid(res, { files: "Choose at least one image" });
  res.json({ urls: files.map(f => publicUrl("listing", f.filename)) });
}));

router.get("/marketplace/my-listings", handle(async (req, res) => {
  const me = uid(req);
  const rows = await query(
    `SELECT ${dto.LISTING_COLUMNS}
       FROM marketplace_listings m
       ${dto.listingJoins("$1")}
      WHERE m.seller_id = $2
         OR m.company_id IN (SELECT company_id FROM company_members WHERE user_id = $2)
      ORDER BY m.created_at DESC LIMIT 100`,
    [me, me]
  );
  res.json(await toListings(rows.rows, me));
}));

/* -------------------------------------------------------------------------- */
/*                                opportunities                               */
/* -------------------------------------------------------------------------- */

const OPPORTUNITY_SELECT = `
  SELECT j.id::int AS id, j.title, j.description, j.location, j.workplace_type,
         COALESCE(j.remote, FALSE) AS remote, j.compensation, j.opportunity_kind,
         j.organization, j.organization_logo, j.salary_min, j.salary_max, j.currency,
         j.application_deadline, j.created_at,
         COALESCE(j.organization, c.name, 'Independent') AS company_name,
         c.logo_url AS company_logo,
         EXISTS (SELECT 1 FROM job_applications ja
                  WHERE ja.job_id = j.id AND ja.applicant_id = $1) AS applied`;

router.get("/opportunities", handle(async (req, res) => {
  const me = uid(req);
  const { page, pageSize, offset } = paging(req, 10);
  const q = str(req.query.q, 100);
  const kind = OPPORTUNITY_KINDS.includes(req.query.kind) ? req.query.kind : null;
  const location = str(req.query.location, 120);

  const b = builder([me]);
  const where = [`j.status = 'open'`];
  if (kind) where.push(`j.opportunity_kind = ${b.add(kind)}`);
  if (req.query.remote === true || req.query.remote === "true") {
    where.push(`(COALESCE(j.remote, FALSE) OR LOWER(COALESCE(j.workplace_type, '')) = 'remote')`);
  }
  if (location) where.push(`LOWER(COALESCE(j.location, '')) LIKE ${b.add(likeValue(location))}`);
  if (q) {
    const like = b.add(likeValue(q));
    where.push(`(LOWER(j.title) LIKE ${like} OR LOWER(j.description) LIKE ${like} OR LOWER(COALESCE(j.organization, '')) LIKE ${like})`);
  }
  const clause = where.join(" AND ");
  const countParams = [...b.params];

  const [rows, total] = await Promise.all([
    query(
      `${OPPORTUNITY_SELECT}
         FROM job_listings j
         LEFT JOIN companies c ON c.id = j.company_id
        WHERE ${clause}
        ORDER BY j.created_at DESC
        LIMIT ${b.add(pageSize)} OFFSET ${b.add(offset)}`,
      b.params
    ),
    query(`SELECT COUNT(*)::int AS total FROM job_listings j
            WHERE ${clause} AND ($1::bigint) IS NOT NULL`, countParams),
  ]);

  res.json(dto.paginate(rows.rows.map(dto.toOpportunity), total.rows[0].total, page, pageSize));
}));

router.post("/opportunities/:id/apply", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const job = await query(`SELECT id FROM job_listings WHERE id = $1 AND status = 'open'`, [id]);
  if (!job.rowCount) return missing(res, "Opportunity");

  const existing = await query(`SELECT 1 FROM job_applications WHERE job_id = $1 AND applicant_id = $2`, [id, me]);
  if (existing.rowCount) {
    await query(`DELETE FROM job_applications WHERE job_id = $1 AND applicant_id = $2`, [id, me]);
    return res.json({ applied: false });
  }
  await query(`INSERT INTO job_applications (job_id, applicant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, me]);
  res.json({ applied: true });
}));

/* -------------------------------------------------------------------------- */
/*                                  businesses                                 */
/* -------------------------------------------------------------------------- */

async function oneBusiness(whereSql, value, viewer) {
  const rows = await query(
    `SELECT ${dto.BUSINESS_COLUMNS},
            EXISTS (SELECT 1 FROM company_followers cf WHERE cf.company_id = c.id AND cf.user_id = $2) AS following
       FROM companies c
      WHERE ${whereSql}`,
    [value, viewer]
  );
  if (!rows.rowCount) return null;
  const business = dto.toBusiness(rows.rows[0]);
  business.team = await teamFor(business.id);
  return business;
}

async function teamFor(companyId) {
  const team = await query(
    `SELECT cm.user_id::int AS user_id, cm.role, COALESCE(u.name, u.username) AS name,
            COALESCE(p.avatar_url, '') AS avatar_url,
            COALESCE(p.job_title, p.headline, '') AS role_title
       FROM company_members cm
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN profiles p ON p.user_id = cm.user_id
      WHERE cm.company_id = $1
      ORDER BY cm.created_at LIMIT 12`,
    [companyId]
  );
  return team.rows.map(r => ({ userId: r.user_id, name: r.name, role: r.role_title || r.role, avatarUrl: r.avatar_url }));
}

function slugify(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** Owners and staff can manage a company page. */
async function canManage(req, companyId) {
  if (isStaff(req)) return true;
  const ok = await query(
    `SELECT 1 FROM companies c
      WHERE c.id = $1 AND (c.owner_id = $2 OR EXISTS
            (SELECT 1 FROM company_members cm WHERE cm.company_id = c.id AND cm.user_id = $2))`,
    [companyId, uid(req)]
  );
  return Boolean(ok.rowCount);
}

router.get("/businesses/manage", handle(async (req, res) => {
  const me = uid(req);
  const rows = await query(
    `SELECT ${dto.BUSINESS_COLUMNS}, TRUE AS following
       FROM companies c
      WHERE c.owner_id = $1
         OR c.id IN (SELECT company_id FROM company_members WHERE user_id = $1)
      ORDER BY c.created_at DESC LIMIT 40`,
    [me]
  );
  res.json(rows.rows.map(dto.toBusiness));
}));

router.post("/businesses", handle(async (req, res) => {
  const me = uid(req);
  const name = str((req.body || {}).name, 180);
  if (!name) return invalid(res, { name: "Business name is required" });

  const base = slugify(name) || "business";
  let slug = base;
  for (let attempt = 2; attempt <= 30; attempt += 1) {
    const clash = await query(`SELECT 1 FROM companies WHERE slug = $1`, [slug]);
    if (!clash.rowCount) break;
    if (attempt === 30) return invalid(res, { name: "That business name is already taken" });
    slug = `${base}-${attempt}`;
  }

  const body = req.body || {};
  const created = await query(
    `INSERT INTO companies
       (owner_id, name, slug, description, tagline, industry, category, location, website,
        email, phone, logo_url, cover_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id::int AS id`,
    [me, name, slug, str(body.description, 4000) || null, str(body.tagline, 220) || null,
      str(body.industry, 120) || str(body.category, 120) || null, str(body.category, 120) || null,
      str(body.location, 180) || null, str(body.website, 255) || null, str(body.email, 160) || null,
      str(body.phone, 40) || null, str(body.logoUrl, 500) || null, str(body.coverUrl, 500) || null]
  );
  await query(`INSERT INTO company_members (company_id, user_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING`,
    [created.rows[0].id, me]);

  res.status(201).json(await oneBusiness(`c.id = $1`, created.rows[0].id, me));
}));

router.patch("/businesses/:id", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  if (!(await canManage(req, id))) return forbidden(res, "Only an owner or administrator can manage this business");

  const body = req.body || {};
  await query(
    `UPDATE companies SET
        name = COALESCE($2, name),
        description = COALESCE($3, description),
        tagline = COALESCE($4, tagline),
        industry = COALESCE($5, industry),
        category = COALESCE($6, category),
        location = COALESCE($7, location),
        website = COALESCE($8, website),
        email = COALESCE($9, email),
        phone = COALESCE($10, phone),
        logo_url = COALESCE($11, logo_url),
        cover_url = COALESCE($12, cover_url),
        updated_at = NOW()
      WHERE id = $1`,
    [id, str(body.name, 180) || null, str(body.description, 4000) || null, str(body.tagline, 220) || null,
      str(body.industry, 120) || null, str(body.category, 120) || null, str(body.location, 180) || null,
      str(body.website, 255) || null, str(body.email, 160) || null, str(body.phone, 40) || null,
      str(body.logoUrl, 500) || null, str(body.coverUrl, 500) || null]
  );

  res.json(await oneBusiness(`c.id = $1`, id, me));
}));

router.get("/businesses/:id/analytics", handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!(await canManage(req, id))) return forbidden(res, "Only an owner or administrator can view analytics");

  const [stats, trend, top] = await Promise.all([
    query(
      `SELECT (SELECT COUNT(*) FROM company_followers WHERE company_id = $1)::int AS followers,
              (SELECT COALESCE(SUM(views), 0)::int FROM marketplace_listings WHERE company_id = $1) AS visitors,
              (SELECT COUNT(*) FROM post_likes l JOIN posts p ON p.id = l.post_id WHERE p.company_id = $1)::int AS engagement,
              (SELECT COUNT(*) FROM listing_favorites lf JOIN marketplace_listings m ON m.id = lf.listing_id
                WHERE m.company_id = $1)::int AS saved`,
      [id]
    ),
    query(
      `SELECT COALESCE(x.n, 0)::int AS n
         FROM (WITH RECURSIVE d(k) AS (SELECT 7 UNION ALL SELECT k - 1 FROM d WHERE k > 0)
               SELECT strftime('%Y-%m-%dT00:00:00.000Z', 'now', '-' || (d.k * 7) || ' days', 'weekday 0', '-6 days') AS week FROM d) gen
         LEFT JOIN (SELECT strftime('%Y-%m-%dT00:00:00.000Z', created_at, 'weekday 0', '-6 days') AS week, COUNT(*) AS n
                      FROM posts WHERE company_id = $1 AND deleted_at IS NULL GROUP BY 1) x
                ON x.week = gen.week
        ORDER BY gen.week`,
      [id]
    ),
    query(
      `SELECT title, COALESCE(views, 0)::int AS views
         FROM marketplace_listings WHERE company_id = $1 AND status = 'active'
        ORDER BY COALESCE(views, 0) DESC LIMIT 5`,
      [id]
    ),
  ]);

  const s = stats.rows[0];
  res.json({
    visitors: num(s.visitors),
    followers: s.followers,
    engagement: s.engagement,
    revenue: 0,
    trend: trend.rows.map(r => r.n),
    topListings: top.rows,
  });
}));

router.get("/businesses/:id/employees", handle(async (req, res) => {
  res.json(await teamFor(toId(req.params.id)));
}));

router.get("/businesses/:id/reviews", handle(async (req, res) => {
  const me = uid(req);
  const rows = await query(
    `SELECT id::int AS id, author_id::int AS author_id, rating, body, created_at
       FROM reviews WHERE subject_type = 'company' AND subject_id = $1
      ORDER BY created_at DESC LIMIT 50`,
    [toId(req.params.id)]
  );
  const people = await dto.loadPeople(rows.rows.map(r => r.author_id).filter(Boolean), me);
  res.json(rows.rows.map(r => dto.toReview(r, people)));
}));

router.post("/businesses/:id/reviews", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const body = req.body || {};
  const rating = Math.round(Number(body.rating));
  const text = str(body.text, 2000);

  const errors = {};
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) errors.rating = "Choose a rating between 1 and 5";
  if (!text) errors.text = "Write a few words about your experience";
  if (Object.keys(errors).length) return invalid(res, errors);

  const business = await query(
    `SELECT id, slug, name, owner_id::int AS owner_id FROM companies WHERE id = $1`,
    [id]
  );
  if (!business.rowCount) return missing(res, "Business");

  const created = await query(
    `INSERT INTO reviews (subject_type, subject_id, author_id, rating, body)
     VALUES ('company',$1,$2,$3,$4)
     RETURNING id::int AS id, author_id::int AS author_id, rating, body, created_at`,
    [id, me, rating, text]
  );
  await notify({
    userId: business.rows[0].owner_id, actorId: me, type: "review",
    title: `New ${rating}-star review for ${business.rows[0].name}`,
    entityType: "company", entityId: id, href: `/business/${business.rows[0].slug}`,
  });

  const people = await dto.loadPeople([me], me);
  res.status(201).json(dto.toReview(created.rows[0], people));
}));

/* Company pages are addressed by slug, so this stays last among /businesses/*. */
router.get("/businesses/:slug", handle(async (req, res) => {
  const me = uid(req);
  const slug = str(req.params.slug, 220).toLowerCase();
  const business = await oneBusiness(`LOWER(c.slug) = $1`, slug, me);
  if (!business) return missing(res, "Business");

  const [postRows, listingRows, reviewRows] = await Promise.all([
    query(
      `SELECT ${dto.POST_COLUMNS}
         FROM posts p
         JOIN users u ON u.id = p.user_id
         ${dto.postJoins("$1")}
        WHERE p.company_id = $2 AND p.deleted_at IS NULL AND p.scheduled_at IS NULL
        ORDER BY p.created_at DESC LIMIT 20`,
      [me, business.id]
    ),
    query(
      `SELECT ${dto.LISTING_COLUMNS}
         FROM marketplace_listings m
         ${dto.listingJoins("$1")}
        WHERE m.company_id = $2 AND m.status = 'active'
        ORDER BY m.created_at DESC LIMIT 24`,
      [me, business.id]
    ),
    query(
      `SELECT id::int AS id, author_id::int AS author_id, rating, body, created_at
         FROM reviews WHERE subject_type = 'company' AND subject_id = $1
        ORDER BY created_at DESC LIMIT 20`,
      [business.id]
    ),
  ]);

  const [postPeople, listingPeople, reviewPeople] = await Promise.all([
    dto.loadPeople(postRows.rows.map(r => r.user_id), me),
    dto.loadPeople(listingRows.rows.map(r => r.seller_id), me),
    dto.loadPeople(reviewRows.rows.map(r => r.author_id).filter(Boolean), me),
  ]);

  const map = new Map([[business.id, business]]);
  const listings = listingRows.rows.map(r => dto.toListing(r, listingPeople, map));

  res.json({
    business,
    posts: postRows.rows.map(r => dto.toPost(r, postPeople, map, null)),
    products: listings.filter(l => l.kind !== "service"),
    services: listings.filter(l => l.kind === "service"),
    reviews: reviewRows.rows.map(r => dto.toReview(r, reviewPeople)),
  });
}));

/* -------------------------------------------------------------------------- */
/*                             saved collections                              */
/* -------------------------------------------------------------------------- */

router.get("/saved", handle(async (req, res) => {
  const me = uid(req);
  const itemType = str(req.query.type, 20);
  const collection = str(req.query.collection, 80);

  const b = builder([me]);
  const where = [`s.user_id = $1`];
  if (itemType && itemType !== "all") where.push(`s.item_type = ${b.add(itemType)}`);
  if (collection) where.push(`s.collection = ${b.add(collection)}`);
  const clause = where.join(" AND ");

  const [rows, collections] = await Promise.all([
    query(
      `SELECT s.id::int AS id, s.item_type, s.ref_id, s.collection, s.title, s.subtitle,
              s.image_url, s.href, s.saved_at
         FROM saved_items s
        WHERE ${clause}
        ORDER BY s.saved_at DESC LIMIT 200`,
      b.params
    ),
    query(`SELECT collection FROM saved_items WHERE user_id = $1 GROUP BY collection ORDER BY MAX(saved_at) DESC`, [me]),
  ]);

  res.json({ items: rows.rows.map(dto.toSavedItem), collections: collections.rows.map(r => r.collection) });
}));

/* Only the names, for clients that fill a collection picker without wanting
   the saved rows themselves. */
router.get("/saved/collections", handle(async (req, res) => {
  const collections = await query(
    `SELECT collection FROM saved_items WHERE user_id = $1 GROUP BY collection ORDER BY MAX(saved_at) DESC`,
    [uid(req)]
  );
  res.json(collections.rows.map(r => r.collection));
}));

router.delete("/saved/:id", handle(async (req, res) => {
  const removed = await query(`DELETE FROM saved_items WHERE id = $1 AND user_id = $2 RETURNING id`,
    [toId(req.params.id), uid(req)]);
  if (!removed.rowCount) return missing(res, "Saved item");
  res.json({ ok: true });
}));

module.exports = router;
