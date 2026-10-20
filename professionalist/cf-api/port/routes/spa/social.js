const express = require("../../_shim/express.js");
const { query } = require("../../db");
const dto = require("../../services/spaDto");
const { loadAuthUser, splitName } = require("../../services/userDto");
const kit = require("../../services/spaKit");
const { uploadImage, publicUrl, removeStored } = require("../../middleware/upload");

const router = express.Router();

const {
  handle, builder, invalid, missing, toId, uid, str, list, num,
  paging, peopleQuery, ensureProfile,
} = kit;

/* ------------------------------- notifications ------------------------------ */

const CATEGORY_TYPES = {
  connection: ["connection", "connection_request", "connection_accepted", "follow"],
  message: ["message"],
  marketplace: ["sale", "listing", "review"],
  mention: ["mention", "share"],
  like: ["like"],
  comment: ["comment"],
  business: ["business"],
  task: ["task"],
  system: ["system", "welcome"],
};

router.get("/notifications", handle(async (req, res) => {
  const me = uid(req);
  const { pageSize, offset } = paging(req, 20);
  const types = CATEGORY_TYPES[req.query.category];

  const b = builder([me]);
  const where = [`n.user_id = $1`];
  if (types) where.push(`n.type = ANY(${b.add(types)}::text[])`);
  const clause = where.join(" AND ");
  // Snapshot before the paging placeholders are appended to the same builder.
  const countParams = [...b.params];

  const [rows, total] = await Promise.all([
    query(
      `SELECT n.id::int AS id, n.type, n.title, n.body, n.read_at, n.created_at,
              n.actor_id::int AS actor_id, n.entity_type, n.entity_id::int AS entity_id, n.href
         FROM notifications n
        WHERE ${clause}
        ORDER BY n.created_at DESC
        LIMIT ${b.add(pageSize)} OFFSET ${b.add(offset)}`,
      b.params
    ),
    query(`SELECT COUNT(*)::int AS total FROM notifications n WHERE ${clause}`, countParams),
  ]);

  const people = await dto.loadPeople(rows.rows.map(r => r.actor_id).filter(Boolean), me);
  res.json(dto.paginate(
    rows.rows.map(r => dto.toNotification(r, people)),
    total.rows[0].total, req.query.page || 1, pageSize
  ));
}));

router.get("/notifications/unread-count", handle(async (req, res) => {
  const rows = await query(
    `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [uid(req)]
  );
  res.json({ count: rows.rows[0].count });
}));

router.post("/notifications/read-all", handle(async (req, res) => {
  await query(`UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`, [uid(req)]);
  res.json({ ok: true });
}));

router.patch("/notifications/:id/read", handle(async (req, res) => {
  await query(`UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2`,
    [toId(req.params.id), uid(req)]);
  res.json({ ok: true });
}));

/* ---------------------------------- search --------------------------------- */

router.get("/search/suggestions", handle(async (req, res) => {
  const me = uid(req);
  const term = str(req.query.q, 80);
  const like = kit.likeValue(term);
  const peopleSql = dto.statusColumns("$1::bigint");

  const recent = await query(
    `SELECT term FROM search_history WHERE user_id = $1 GROUP BY term ORDER BY MAX(created_at) DESC LIMIT 6`,
    [me]
  );
  const tags = await query(
    `SELECT jt.value AS tag, COUNT(*)::int AS n
       FROM posts, json_each(COALESCE(posts.hashtags, '[]')) AS jt
      WHERE deleted_at IS NULL ${term ? "AND LOWER(jt.value) LIKE $1" : ""}
      GROUP BY jt.value ORDER BY n DESC LIMIT 6`,
    term ? [like] : []
  );

  if (!term) {
    return res.json({
      people: [],
      businesses: [],
      hashtags: tags.rows.map(r => r.tag),
      recent: recent.rows.map(r => r.term),
    });
  }

  const MATCH = `(LOWER(u.username) LIKE $2 OR LOWER(COALESCE(u.name, '')) LIKE $2
                  OR LOWER(COALESCE(pr.job_title, '')) LIKE $2 OR LOWER(COALESCE(pr.headline, '')) LIKE $2
                  OR LOWER(COALESCE(pr.company_name, '')) LIKE $2)`;

  const [people, businesses] = await Promise.all([
    query(
      `SELECT ${dto.PERSON_COLUMNS}, ${peopleSql}
         FROM users u LEFT JOIN profiles pr ON pr.user_id = u.id
        WHERE u.status = 'active' AND COALESCE(pr.visibility, 'public') <> 'private'
          AND ${MATCH}
        ORDER BY u.id LIMIT 6`,
      [me, like]
    ),
    query(
      `SELECT ${dto.BUSINESS_COLUMNS}, FALSE AS following
         FROM companies c
        WHERE LOWER(c.name) LIKE $1 OR LOWER(COALESCE(c.industry, '')) LIKE $1
        ORDER BY c.id LIMIT 5`,
      [like]
    ),
  ]);

  res.json({
    people: people.rows.map(kit.person),
    businesses: businesses.rows.map(dto.toBusiness),
    hashtags: tags.rows.map(r => r.tag),
    recent: recent.rows.map(r => r.term),
  });
}));

router.get("/search/recent", handle(async (req, res) => {
  const rows = await query(
    `SELECT term FROM search_history WHERE user_id = $1 GROUP BY term ORDER BY MAX(created_at) DESC LIMIT 10`,
    [uid(req)]
  );
  res.json({ recent: rows.rows.map(r => r.term) });
}));

router.delete("/search/recent", handle(async (req, res) => {
  await query(`DELETE FROM search_history WHERE user_id = $1`, [uid(req)]);
  res.json({ ok: true });
}));

router.get("/search", handle(async (req, res) => {
  const me = uid(req);
  const term = str(req.query.q, 100);
  const tab = str(req.query.tab, 20);
  const want = name => !tab || tab === name;

  if (term) {
    await query(`INSERT INTO search_history (user_id, term) VALUES ($1,$2)`, [me, term]).catch(() => {});
  }

  const like = kit.likeValue(term);
  const empty = Promise.resolve({ rows: [] });

  const [people, businesses, listings, posts, opportunities] = await Promise.all([
    want("people") ? query(
      `SELECT ${dto.PERSON_COLUMNS}, ${dto.statusColumns("$1::bigint")}
         FROM users u LEFT JOIN profiles pr ON pr.user_id = u.id
        WHERE u.status = 'active' AND COALESCE(pr.visibility,'public') <> 'private'
          AND (LOWER(u.username) LIKE $2 OR LOWER(COALESCE(u.name,'')) LIKE $2
               OR LOWER(COALESCE(pr.job_title,'')) LIKE $2 OR LOWER(COALESCE(pr.headline,'')) LIKE $2
               OR LOWER(COALESCE(pr.company_name,'')) LIKE $2)
        ORDER BY u.id LIMIT 30`, [me, like]) : empty,
    want("businesses") ? query(
      `SELECT ${dto.BUSINESS_COLUMNS},
              EXISTS (SELECT 1 FROM company_followers cf WHERE cf.company_id = c.id AND cf.user_id = $2) AS following
         FROM companies c
        WHERE LOWER(c.name) LIKE $1 OR LOWER(COALESCE(c.industry,'')) LIKE $1 OR LOWER(COALESCE(c.tagline,'')) LIKE $1
        ORDER BY c.id LIMIT 20`, [like, me]) : empty,
    want("products") ? query(
      `SELECT ${dto.LISTING_COLUMNS}
         FROM marketplace_listings m
         ${dto.listingJoins("$1")}
        WHERE m.status = 'active'
          AND (LOWER(m.title) LIKE $2 OR LOWER(m.description) LIKE $2 OR LOWER(COALESCE(m.location,'')) LIKE $2)
        ORDER BY m.created_at DESC LIMIT 20`, [me, like]) : empty,
    want("posts") ? query(
      `SELECT ${dto.POST_COLUMNS}
         FROM posts p JOIN users u ON u.id = p.user_id ${dto.postJoins("$1")}
        WHERE p.deleted_at IS NULL AND p.visibility = 'public' AND LOWER(p.content) LIKE $2
        ORDER BY p.created_at DESC LIMIT 20`, [me, like]) : empty,
    want("opportunities") ? query(
      `SELECT j.id::int AS id, j.title, j.description, j.location, j.workplace_type, j.remote,
              j.compensation, j.opportunity_kind, j.organization, j.organization_logo,
              COALESCE(c.name, j.organization, 'Independent') AS company_name, c.logo_url AS company_logo,
              j.salary_min, j.salary_max, j.currency, j.application_deadline, j.created_at,
              EXISTS (SELECT 1 FROM job_applications ja WHERE ja.job_id = j.id AND ja.applicant_id = $2) AS applied
         FROM job_listings j
         LEFT JOIN companies c ON c.id = j.company_id
        WHERE j.status = 'open'
          AND (LOWER(j.title) LIKE $1 OR LOWER(j.description) LIKE $1 OR LOWER(COALESCE(j.location,'')) LIKE $1)
        ORDER BY j.created_at DESC LIMIT 20`, [like, me]) : empty,
  ]);

  const [sellerMap, postMap] = await Promise.all([
    dto.loadPeople(listings.rows.map(r => r.seller_id), me),
    dto.loadPeople(posts.rows.map(r => r.user_id), me),
  ]);
  const [listingBusinesses, postBusinesses] = await Promise.all([
    kit.businessesFor(listings.rows, me),
    kit.businessesFor(posts.rows, me),
  ]);

  res.json({
    people: people.rows.map(kit.person),
    businesses: businesses.rows.map(r => dto.toBusiness(r)),
    products: listings.rows.map(r => dto.toListing(r, sellerMap, listingBusinesses)),
    posts: posts.rows.map(r => dto.toPost(r, postMap, postBusinesses, null)),
    opportunities: opportunities.rows.map(r => dto.toOpportunity(r)),
  });
}));

/* ---------------------------------- network -------------------------------- */

const NOT_SELF = `u.status = 'active' AND COALESCE(pr.visibility,'public') = 'public' AND u.id <> $1`;
const NOT_BLOCKED = `NOT EXISTS (SELECT 1 FROM blocks bl
                 WHERE (bl.blocker_id = $1 AND bl.blocked_id = u.id)
                    OR (bl.blocker_id = u.id AND bl.blocked_id = $1))`;

router.get("/network/overview", handle(async (req, res) => {
  const me = uid(req);

  const requestRows = await query(
    `SELECT c.id::int AS request_id, ${dto.PERSON_COLUMNS}, ${dto.statusColumns(String(me))}
       FROM connections c
       JOIN users u ON u.id = c.requester_id
       LEFT JOIN profiles pr ON pr.user_id = u.id
      WHERE c.recipient_id = $1 AND c.status = 'pending' AND u.status = 'active'
      ORDER BY c.created_at DESC LIMIT 20`,
    [me]
  );
  const requests = requestRows.rows.map(r => Object.assign(kit.person(r), { requestId: r.request_id }));

  const suggestions = await peopleQuery({
    where: `${NOT_SELF}
       AND NOT EXISTS (SELECT 1 FROM connections c
                        WHERE (c.requester_id = $1 AND c.recipient_id = u.id) OR (c.recipient_id = $1 AND c.requester_id = u.id))
       AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.following_id = u.id)
       AND ${NOT_BLOCKED}`,
    params: [me],
    viewer: me,
    limit: 8,
    order: "COALESCE(pr.job_title, '') = '' , u.id",
  });

  res.json({ requests, suggestions, invitations: requests.length });
}));

router.get("/network/connections", handle(async (req, res) => {
  const me = uid(req);
  const { page, pageSize, offset } = paging(req, 12);
  const profession = str(req.query.profession || req.query.industry, 120);
  const location = str(req.query.location, 120);
  const skill = str(req.query.skill, 100);
  const q = str(req.query.q, 100);

  const b = builder([me]);
  const where = [`u.status = 'active'`, `EXISTS (SELECT 1 FROM conn_edges e WHERE e.a = $1 AND e.b = u.id)`];
  if (profession) where.push(`(LOWER(COALESCE(pr.category, '')) LIKE ${b.add(kit.likeValue(profession))}
                             OR LOWER(COALESCE(pr.job_title, '')) LIKE ${b.add(kit.likeValue(profession))})`);
  if (location) where.push(`LOWER(${dto.locationExpr("pr")}) LIKE ${b.add(kit.likeValue(location))}`);
  if (skill) where.push(`EXISTS (SELECT 1 FROM profile_skills ps JOIN skills s ON s.id = ps.skill_id
                                  WHERE ps.user_id = u.id AND LOWER(s.name) = ${b.add(skill.toLowerCase())})`);
  if (q) where.push(`(LOWER(u.username) LIKE ${b.add(kit.likeValue(q))}
                      OR LOWER(COALESCE(u.name, '')) LIKE ${b.add(kit.likeValue(q))})`);
  const clause = where.join(" AND ");

  const from = `FROM users u LEFT JOIN profiles pr ON pr.user_id = u.id`;
  const countParams = [...b.params];
  const [rows, total] = await Promise.all([
    query(
      `SELECT ${dto.PERSON_COLUMNS}, ${dto.statusColumns("$1")}
         ${from}
        WHERE ${clause}
        ORDER BY COALESCE(u.name, u.username) ASC
        LIMIT ${b.add(pageSize)} OFFSET ${b.add(offset)}`,
      b.params
    ),
    query(`SELECT COUNT(*)::int AS total ${from} WHERE ${clause}`, countParams),
  ]);

  res.json(dto.paginate(rows.rows.map(kit.person), total.rows[0].total, page, pageSize));
}));

router.get("/network/requests", handle(async (req, res) => {
  const me = uid(req);
  const rows = await query(
    `SELECT c.id::int AS request_id, ${dto.PERSON_COLUMNS}, ${dto.statusColumns(String(me))}
       FROM connections c
       JOIN users u ON u.id = c.requester_id
       LEFT JOIN profiles pr ON pr.user_id = u.id
      WHERE c.recipient_id = $1 AND c.status = 'pending' AND u.status = 'active'
      ORDER BY c.created_at DESC LIMIT 100`,
    [me]
  );
  res.json(rows.rows.map(r => Object.assign(kit.person(r), { requestId: r.request_id })));
}));

router.post("/network/requests/:id/respond", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const action = str((req.body || {}).action, 10);

  const found = await query(
    `SELECT id, requester_id::int AS requester_id FROM connections WHERE id = $1 AND recipient_id = $2`,
    [id, me]
  );
  if (!found.rowCount) return missing(res, "Request");
  const requester = found.rows[0].requester_id;

  if (action === "accept") {
    await query(`UPDATE connections SET status = 'accepted', updated_at = NOW() WHERE id = $1`, [id]);
    await query(
      `INSERT INTO follows (follower_id, following_id) VALUES ($1,$2),($2,$1)
       ON CONFLICT (follower_id, following_id) DO NOTHING`,
      [me, requester]
    );
    await kit.notify({
      userId: requester, actorId: me, type: "connection_accepted",
      title: "Your connection request was accepted",
      entityType: "user", entityId: me, href: `/profile/${req.user.username}`,
    });
    return res.json({ connected: true });
  }

  await query(`UPDATE connections SET status = 'rejected', updated_at = NOW() WHERE id = $1`, [id]);
  res.json({ connected: false });
}));

router.post("/network/connect", handle(async (req, res) => {
  const me = uid(req);
  const target = toId((req.body || {}).userId, "userId");
  if (target === me) return invalid(res, { userId: "You cannot connect with yourself" });

  const account = await query(`SELECT id::int AS id FROM users WHERE id = $1 AND status = 'active'`, [target]);
  if (!account.rowCount) return missing(res, "Person");

  const existing = await query(
    `SELECT id::int AS id, status, requester_id::int AS requester_id FROM connections
      WHERE (requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1)`,
    [me, target]
  );

  if (existing.rowCount) {
    const found = existing.rows[0];
    if (found.status === "pending" && found.requester_id === target) {
      await query(`UPDATE connections SET status = 'accepted', updated_at = NOW() WHERE id = $1`, [found.id]);
      await query(`INSERT INTO follows (follower_id, following_id) VALUES ($1,$2),($2,$1)
                   ON CONFLICT (follower_id, following_id) DO NOTHING`, [me, target]);
      return res.json({ requestId: found.id, status: "accepted" });
    }
    return res.json({ requestId: found.id, status: found.status });
  }

  const created = await query(
    `INSERT INTO connections (requester_id, recipient_id) VALUES ($1,$2) RETURNING id::int AS id`,
    [me, target]
  );
  await kit.notify({
    userId: target, actorId: me, type: "connection_request",
    title: "You have a new connection request",
    entityType: "user", entityId: me, href: `/profile/${req.user.username}`,
  });
  res.status(201).json({ requestId: created.rows[0].id, status: "pending" });
}));

router.delete("/network/connections/:userId", handle(async (req, res) => {
  const me = uid(req);
  const target = toId(req.params.userId, "userId");
  await query(
    `UPDATE connections SET status = 'rejected', updated_at = NOW()
      WHERE status = 'accepted'
        AND ((requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1))`,
    [me, target]
  );
  res.json({ ok: true });
}));

router.get("/network/following", handle(async (req, res) => {
  const me = uid(req);
  const [people, businesses] = await Promise.all([
    query(
      `SELECT ${dto.PERSON_COLUMNS}, ${dto.statusColumns(String(me))}
         FROM follows f
         JOIN users u ON u.id = f.following_id
         LEFT JOIN profiles pr ON pr.user_id = u.id
        WHERE f.follower_id = $1 AND u.status = 'active'
        ORDER BY f.created_at DESC LIMIT 60`,
      [me]
    ),
    query(
      `SELECT ${dto.BUSINESS_COLUMNS}, TRUE AS following
         FROM company_followers cf
         JOIN companies c ON c.id = cf.company_id
        WHERE cf.user_id = $1
        ORDER BY cf.created_at DESC LIMIT 60`,
      [me]
    ),
  ]);
  res.json({ people: people.rows.map(kit.person), businesses: businesses.rows.map(r => dto.toBusiness(r)) });
}));

router.get("/network/followers", handle(async (req, res) => {
  const me = uid(req);
  const rows = await query(
    `SELECT ${dto.PERSON_COLUMNS}, ${dto.statusColumns(String(me))}
       FROM follows f
       JOIN users u ON u.id = f.follower_id
       LEFT JOIN profiles pr ON pr.user_id = u.id
      WHERE f.following_id = $1 AND u.status = 'active'
      ORDER BY f.created_at DESC LIMIT 100`,
    [me]
  );
  res.json(rows.rows.map(kit.person));
}));

router.post("/network/follow", handle(async (req, res) => {
  const me = uid(req);
  const body = req.body || {};

  if (body.businessId) {
    const companyId = toId(body.businessId, "businessId");
    const company = await query(`SELECT id FROM companies WHERE id = $1`, [companyId]);
    if (!company.rowCount) return missing(res, "Business");
    await query(`INSERT INTO company_followers (company_id, user_id) VALUES ($1,$2)
                 ON CONFLICT (company_id, user_id) DO NOTHING`, [companyId, me]);
    return res.json({ following: true });
  }

  const target = toId(body.userId, "userId");
  if (target === me) return invalid(res, { userId: "You cannot follow yourself" });
  const account = await query(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [target]);
  if (!account.rowCount) return missing(res, "Person");

  await query(`INSERT INTO follows (follower_id, following_id) VALUES ($1,$2)
               ON CONFLICT (follower_id, following_id) DO NOTHING`, [me, target]);
  await kit.notify({
    userId: target, actorId: me, type: "follow", title: "Someone started following you",
    entityType: "user", entityId: me, href: `/profile/${req.user.username}`,
  });
  res.json({ following: true });
}));

router.post("/network/unfollow", handle(async (req, res) => {
  const me = uid(req);
  const body = req.body || {};
  if (body.businessId) {
    await query(`DELETE FROM company_followers WHERE company_id = $1 AND user_id = $2`,
      [toId(body.businessId, "businessId"), me]);
    return res.json({ following: false });
  }
  await query(`DELETE FROM follows WHERE follower_id = $1 AND following_id = $2`, [me, toId(body.userId, "userId")]);
  res.json({ following: false });
}));

/* ----------------------------------- users --------------------------------- */

router.get("/users/me/progress", handle(async (req, res) => {
  const me = uid(req);
  const user = await loadAuthUser(me);
  if (!user) return missing(res, "Account");
  const p = user.profile;

  let score = 0;
  if (p.avatarUrl) score += 15;
  if (p.title) score += 15;
  if (p.company) score += 10;
  score += p.bio.length >= 30 ? 15 : p.bio ? 8 : 0;
  if (p.website) score += 5;
  score += Math.min(1, p.skills.length / 5) * 15;
  score += Math.min(1, p.interests.length / 4) * 10;
  if (p.country || p.location) score += 10;
  score = Math.round(Math.min(100, score));

  const suggestions = [];
  if (!p.avatarUrl) suggestions.push("Add a profile photo");
  if (!p.title) suggestions.push("Add your professional title");
  if (p.bio.length < 30) suggestions.push("Write a short bio");
  if (p.skills.length < 5) suggestions.push("List at least five skills");
  if (!p.interests.length) suggestions.push("Pick topics for your feed");
  if (!p.location && !p.country) suggestions.push("Add your location");

  const [counts, network, activity, engagement, listings, views, goals, skillRows, weeks] = await Promise.all([
    query(
      `SELECT (SELECT COUNT(*) FROM conn_edges WHERE a = $1)::int AS connections,
              (SELECT COUNT(*) FROM follows WHERE following_id = $1)::int AS followers,
              (SELECT COUNT(*) FROM follows WHERE follower_id = $1)::int AS following`,
      [me]
    ),
    query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS weekly
         FROM follows WHERE follower_id = $1`,
      [me]
    ),
    query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS recent
         FROM posts WHERE user_id = $1 AND deleted_at IS NULL`,
      [me]
    ),
    query(
      `SELECT (SELECT COUNT(*) FROM post_likes l JOIN posts p ON p.id = l.post_id WHERE p.user_id = $1)::int AS likes,
              (SELECT COUNT(*) FROM comments c JOIN posts p ON p.id = c.post_id
                WHERE p.user_id = $1 AND c.deleted_at IS NULL)::int AS comments`,
      [me]
    ),
    query(`SELECT COUNT(*)::int AS total FROM marketplace_listings WHERE seller_id = $1`, [me]),
    query(`SELECT COALESCE(SUM(views), 0)::int AS views FROM marketplace_listings WHERE seller_id = $1`, [me]),
    query(
      `SELECT id::int AS id, title, target::float AS target, current::float AS current, due_date
         FROM user_goals WHERE user_id = $1 ORDER BY id`,
      [me]
    ),
    query(
      `SELECT s.name FROM profile_skills ps JOIN skills s ON s.id = ps.skill_id
        WHERE ps.user_id = $1 ORDER BY s.name`,
      [me]
    ),
    query(
      `SELECT COALESCE(x.n, 0)::int AS n
         FROM (WITH RECURSIVE d(k) AS (SELECT 7 UNION ALL SELECT k - 1 FROM d WHERE k > 0)
               SELECT strftime('%Y-%m-%dT00:00:00.000Z', 'now', '-' || (d.k * 7) || ' days', 'weekday 0', '-6 days') AS week FROM d) gen
         LEFT JOIN (SELECT strftime('%Y-%m-%dT00:00:00.000Z', created_at, 'weekday 0', '-6 days') AS week, COUNT(*) AS n
                      FROM posts WHERE user_id = $1 AND deleted_at IS NULL GROUP BY 1) x
                ON x.week = gen.week
        ORDER BY gen.week`,
      [me]
    ),
  ]);

  const now = new Date().toISOString();
  const earned = at => (at ? now : null);

  res.json({
    profileCompletion: score,
    profileSuggestions: suggestions,
    network: {
      growth: network.rows[0].weekly,
      connections: counts.rows[0].connections,
      followers: counts.rows[0].followers,
      weeklyNew: network.rows[0].weekly,
      trend: weeks.rows.map(r => r.n),
    },
    activity: {
      score: Math.min(100, activity.rows[0].recent * 10 + engagement.rows[0].likes + engagement.rows[0].comments),
      posts: activity.rows[0].total,
      engagement: engagement.rows[0].likes + engagement.rows[0].comments,
      trend: weeks.rows.map(r => r.n),
    },
    marketplace: {
      score: Math.min(100, listings.rows[0].total * 20),
      listings: listings.rows[0].total,
      sales: 0,
      views: views.rows[0].views,
      trend: weeks.rows.map(() => 0),
    },
    skills: skillRows.rows.map(r => ({ name: r.name, endorsements: 0 })),
    goals: goals.rows.map(g => ({
      id: g.id,
      title: g.title,
      target: num(g.target),
      current: num(g.current),
      dueDate: dto.iso(g.due_date),
    })),
    achievements: [
      { key: "photo", title: "Face to face", description: "Added a profile photo", icon: "Camera", earnedAt: earned(Boolean(p.avatarUrl)) },
      { key: "first-post", title: "First post", description: "Published a post", icon: "FileText", earnedAt: earned(activity.rows[0].total > 0) },
      { key: "network", title: "Well connected", description: "Followed five professionals", icon: "Users", earnedAt: earned(network.rows[0].total >= 5) },
      { key: "seller", title: "Open for business", description: "Published a listing", icon: "Store", earnedAt: earned(listings.rows[0].total > 0) },
    ],
  });
}));

router.put("/users/me/goals", handle(async (req, res) => {
  const me = uid(req);
  const goals = Array.isArray((req.body || {}).goals) ? (req.body || {}).goals.slice(0, 12) : [];
  await query(`DELETE FROM user_goals WHERE user_id = $1`, [me]);

  const created = [];
  for (const goal of goals) {
    const title = str(goal && goal.title, 220);
    if (!title) continue;
    const row = await query(
      `INSERT INTO user_goals (user_id, title, metric, target, current, due_date)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz) RETURNING id::int AS id`,
      [me, title, str(goal.metric, 60) || null, num(goal.target, 1), num(goal.current),
        goal.dueDate ? new Date(goal.dueDate).toISOString() : null]
    );
    created.push({ id: row.rows[0].id });
  }
  res.json(created);
}));

router.delete("/users/me/goals/:id", handle(async (req, res) => {
  await query(`DELETE FROM user_goals WHERE id = $1 AND user_id = $2`, [toId(req.params.id), uid(req)]);
  res.json({ ok: true });
}));

/** Whitelist of SPA profile keys → columns, so the PATCH can never name a column
    the client invented. */
const PROFILE_COLUMNS = {
  bio: "bio",
  title: "job_title",
  company: "company_name",
  website: "website",
  phone: "phone",
  location: "location",
  country: "country",
  category: "category",
  avatarUrl: "avatar_url",
  coverUrl: "cover_url",
};

router.patch("/users/me/profile", handle(async (req, res) => {
  const me = uid(req);
  const body = req.body || {};
  await ensureProfile(me);

  if (body.firstName || body.lastName) {
    const current = await query(`SELECT name FROM users WHERE id = $1`, [me]);
    const parts = splitName(current.rows[0] && current.rows[0].name);
    const first = str(body.firstName, 80) || parts.firstName;
    const last = str(body.lastName, 80) || parts.lastName;
    await query(`UPDATE users SET name = $1 WHERE id = $2`, [`${first} ${last}`.trim(), me]);
    await query(`UPDATE profiles SET first_name = $1, last_name = $2, updated_at = NOW() WHERE user_id = $3`,
      [first, last, me]);
  }

  if (body.email) {
    const email = str(body.email, 255).toLowerCase();
    const clash = await query(`SELECT 1 FROM users WHERE LOWER(email) = $1 AND id <> $2`, [email, me]);
    if (clash.rowCount) return invalid(res, { email: "That email is already in use" });
    await query(`UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2`, [email, me]);
  }

  if (body.username) {
    const username = str(body.username, 50);
    if (!/^[\w.]{3,20}$/.test(username)) {
      return invalid(res, { username: "3-20 characters: letters, numbers, dots, underscores" });
    }
    const clash = await query(`SELECT 1 FROM users WHERE LOWER(username) = $1 AND id <> $2`, [username.toLowerCase(), me]);
    if (clash.rowCount) return invalid(res, { username: "That username is taken" });
    await query(`UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2`, [username, me]);
    await query(`UPDATE profiles SET username = $1 WHERE user_id = $2`, [username, me]);
  }

  const fields = {
    bio: str(body.bio, 2000),
    title: str(body.title, 180),
    company: str(body.company, 180),
    website: str(body.website, 255),
    phone: str(body.phone, 40),
    location: str(body.location, 180),
    country: str(body.country, 120),
    category: str(body.category, 120),
    avatarUrl: str(body.avatarUrl, 500),
    coverUrl: str(body.coverUrl, 500),
  };
  const sent = Object.keys(PROFILE_COLUMNS).filter(k => Object.prototype.hasOwnProperty.call(body, k));
  if (sent.length) {
    const sets = sent.map((k, i) => `${PROFILE_COLUMNS[k]} = $${i + 1}`);
    const values = sent.map(k => fields[k] || null);
    values.push(me);
    await query(
      `UPDATE profiles SET ${sets.join(", ")}, updated_at = NOW() WHERE user_id = $${sent.length + 1}`,
      values
    );
    if (sent.includes("title")) {
      await query(`UPDATE profiles SET headline = COALESCE(job_title, headline) WHERE user_id = $1`, [me]);
    }
  }

  if (body.visibility && ["public", "connections", "private"].includes(body.visibility)) {
    await query(`UPDATE profiles SET visibility = $1, updated_at = NOW() WHERE user_id = $2`, [body.visibility, me]);
  }
  if (Array.isArray(body.interests)) {
    await query(`UPDATE profiles SET interests = $1, updated_at = NOW() WHERE user_id = $2`, [list(body.interests, 20), me]);
  }
  if (Array.isArray(body.openTo)) {
    await query(`UPDATE profiles SET open_to = $1, updated_at = NOW() WHERE user_id = $2`, [list(body.openTo, 8), me]);
  }
  if (Array.isArray(body.skills)) {
    await query(`DELETE FROM profile_skills WHERE user_id = $1`, [me]);
    for (const name of list(body.skills, 20)) {
      const skill = await query(`INSERT INTO skills (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name]);
      await query(`INSERT INTO profile_skills (user_id, skill_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [me, skill.rows[0].id]);
    }
  }

  res.json(await loadAuthUser(me));
}));

/* Avatar and cover uploads share the profile PATCH's storage rules. */
async function saveImage(req, res, column, kind) {
  const me = uid(req);
  if (!req.file) return invalid(res, { file: "Choose an image to upload" });

  const url = publicUrl(kind, req.file.filename);
  await ensureProfile(me);

  const previous = await query(`SELECT ${column} AS current FROM profiles WHERE user_id = $1`, [me]);
  const old = previous.rows[0] && previous.rows[0].current;

  await query(`UPDATE profiles SET ${column} = $1, updated_at = NOW() WHERE user_id = $2`, [url, me]);
  if (old && old.startsWith("/uploads/")) removeStored(old);

  res.json({ url });
}

router.post("/users/me/avatar", uploadImage("avatar"), handle((req, res) => saveImage(req, res, "avatar_url", "avatar")));
router.post("/users/me/cover", uploadImage("cover"), handle((req, res) => saveImage(req, res, "cover_url", "cover")));

router.get("/users/:username", handle(async (req, res) => {
  const me = uid(req);
  const username = str(req.params.username, 50).toLowerCase();

  const account = await query(
    `SELECT ${dto.PERSON_COLUMNS}, ${dto.statusColumns(String(me))}
       FROM users u
       LEFT JOIN profiles pr ON pr.user_id = u.id
      WHERE LOWER(u.username) = $1 AND u.status = 'active'`,
    [username]
  );
  if (!account.rowCount) return missing(res, "Profile");

  const row = account.rows[0];
  const personDto = kit.person(row);

  const [profile, stats, reviewRows, listingRows] = await Promise.all([
    loadAuthUser(row.id),
    query(
      `SELECT (SELECT COUNT(*) FROM posts WHERE user_id = $1 AND deleted_at IS NULL AND visibility <> 'private')::int AS posts,
              (SELECT COUNT(*) FROM follows WHERE following_id = $1)::int AS followers,
              (SELECT COUNT(*) FROM conn_edges WHERE a = $1)::int AS connections`,
      [row.id]
    ),
    query(
      `SELECT id::int AS id, author_id::int AS author_id, rating, body, created_at
         FROM reviews WHERE subject_type = 'user' AND subject_id = $1
        ORDER BY created_at DESC LIMIT 20`,
      [row.id]
    ),
    query(
      `SELECT ${dto.LISTING_COLUMNS} FROM marketplace_listings m ${dto.listingJoins("$1")}
        WHERE m.seller_id = $2 AND m.status = 'active' ORDER BY m.created_at DESC LIMIT 24`,
      [me, row.id]
    ),
  ]);

  const [reviewPeople, sellerPeople, listingBusinesses] = await Promise.all([
    dto.loadPeople(reviewRows.rows.map(r => r.author_id).filter(Boolean), me),
    dto.loadPeople(listingRows.rows.map(r => r.seller_id), me),
    kit.businessesFor(listingRows.rows, me),
  ]);

  const listings = listingRows.rows.map(r => dto.toListing(r, sellerPeople, listingBusinesses));

  res.json({
    person: personDto,
    profile: profile ? profile.profile : null,
    stats: stats.rows[0],
    reviews: reviewRows.rows.map(r => dto.toReview(r, reviewPeople)),
    services: listings.filter(l => l.kind === "service"),
    products: listings.filter(l => l.kind !== "service"),
  });
}));

module.exports = router;
