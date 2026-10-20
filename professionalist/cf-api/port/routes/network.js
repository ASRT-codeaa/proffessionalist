const express = require("../_shim/express.js");
const { query } = require("../db");
const { toPerson } = require("../services/userDto");

const router = express.Router();

function text(value, max) {
  return String(value === null || value === undefined ? "" : value).trim().slice(0, max);
}

const SELECT = `
  SELECT
    u.id::int AS id,
    u.username,
    u.name,
    p.first_name,
    p.last_name,
    COALESCE(p.job_title, p.headline) AS title,
    p.company_name AS company,
    p.location,
    p.avatar_url,
    COALESCE(u.verified, FALSE) AS verified,
    COALESCE(u.verified_badge, '') AS verified_badge,
    p.category,
    COALESCE(
      (SELECT array_agg(s.name)
         FROM profile_skills ps
         JOIN skills s ON s.id = ps.skill_id
        WHERE ps.user_id = u.id),
      '{}'
    ) AS skills,
    EXISTS (
      SELECT 1 FROM connections c
       WHERE c.status = 'accepted'
         AND ((c.requester_id = $1 AND c.recipient_id = u.id)
           OR (c.requester_id = u.id AND c.recipient_id = $1))
    ) AS connected,
    EXISTS (
      SELECT 1 FROM connections c
       WHERE c.status = 'pending' AND c.recipient_id = $1 AND c.requester_id = u.id
    ) AS pending_in,
    EXISTS (
      SELECT 1 FROM connections c
       WHERE c.status = 'pending' AND c.requester_id = $1 AND c.recipient_id = u.id
    ) AS pending_out,
    EXISTS (
      SELECT 1 FROM follows f
       WHERE f.follower_id = $1 AND f.following_id = u.id
    ) AS following,
    (
      SELECT COUNT(*)
        FROM connections m
       WHERE m.status = 'accepted'
         AND (m.requester_id = u.id OR m.recipient_id = u.id)
         AND (CASE WHEN m.requester_id = u.id THEN m.recipient_id ELSE m.requester_id END) IN (
             SELECT CASE WHEN c.requester_id = $1 THEN c.recipient_id ELSE c.requester_id END
               FROM connections c
              WHERE c.status = 'accepted'
                AND (c.requester_id = $1 OR c.recipient_id = $1)
         )
    )::int AS mutual_connections
  FROM users u
  LEFT JOIN profiles p ON p.user_id = u.id
 WHERE u.id <> $1
   AND u.status = 'active'
   AND COALESCE(p.visibility, 'public') = 'public'
   AND NOT EXISTS (
     SELECT 1 FROM blocks b
      WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
         OR (b.blocker_id = u.id AND b.blocked_id = $1)
   )
   AND ($4 = '' OR u.username ILIKE '%' || $4 || '%'
                   OR u.name ILIKE '%' || $4 || '%'
                   OR COALESCE(p.job_title, p.headline) ILIKE '%' || $4 || '%'
                   OR p.company_name ILIKE '%' || $4 || '%')
   AND ($5 = '' OR p.category ILIKE '%' || $5 || '%'
               OR COALESCE(p.job_title, p.headline) ILIKE '%' || $5 || '%')
   AND ($6 = '' OR p.location ILIKE '%' || $6 || '%')
`;

router.get("/suggestions", async (req, res) => {
  try {
    const uid = Number(req.user.sub);
    const search = text(req.query.search, 120);
    const profession = text(req.query.profession, 120) || text(req.query.industry, 120);
    const location = text(req.query.location, 120);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 8, 1), 50);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const result = await query(
      `${SELECT}
       ORDER BY (p.avatar_url IS NOT NULL) DESC,
                (COALESCE(p.job_title, p.headline) IS NOT NULL) DESC,
                u.created_at DESC
       LIMIT $2 OFFSET $3`,
      [uid, pageSize, (page - 1) * pageSize, search, profession, location]
    );

    res.json(result.rows.map(toPerson));
  } catch (error) {
    console.error("Suggestions error:", error);
    res.status(500).json({ error: { code: "api_error", message: "Unable to load suggestions" } });
  }
});

module.exports = router;
