const express = require("../_shim/express.js");
const crypto = require("crypto");
const { query } = require("../db");

const router = express.Router();

function userId(req) {
  return Number(req.user.sub);
}

function idParam(value, name = "id") {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new Error(`Invalid ${name}`);
    error.status = 400;
    throw error;
  }
  return id;
}

function cleanString(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function requireString(value, field, max = 500) {
  const result = cleanString(value, max);
  if (!result) {
    const error = new Error(`${field} is required`);
    error.status = 400;
    throw error;
  }
  return result;
}

function limitValue(value, fallback = 25, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), max);
}

async function notify({
  targetUserId,
  actorId = null,
  type,
  title,
  body = null,
  entityType = null,
  entityId = null
}) {
  if (!targetUserId) return;

  await query(
    `INSERT INTO notifications
      (user_id, actor_id, type, entity_type, entity_id, title, body)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      targetUserId,
      actorId,
      type,
      entityType,
      entityId,
      title,
      body
    ]
  ).catch(() => {});
}

async function isBlocked(a, b) {
  const result = await query(
    `SELECT 1
       FROM blocks
      WHERE (blocker_id = $1 AND blocked_id = $2)
         OR (blocker_id = $2 AND blocked_id = $1)
      LIMIT 1`,
    [a, b]
  );

  return result.rowCount > 0;
}

async function connectionExists(a, b) {
  const result = await query(
    `SELECT requester_id, recipient_id, status
       FROM connections
      WHERE (requester_id = $1 AND recipient_id = $2)
         OR (requester_id = $2 AND recipient_id = $1)
      ORDER BY id DESC
      LIMIT 1`,
    [a, b]
  );

  return result.rows[0] || null;
}

/* =========================================================
   PROFILE
   ========================================================= */

router.get("/profile/me", async (req, res) => {
  try {
    const result = await query(
      `SELECT
         u.id,
         u.username AS account_username,
         u.email,
         u.name,
         u.role,
         u.status,
         p.*
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [userId(req)]
    );

    res.json({
      profile: result.rows[0]
    });
  } catch (error) {
    console.error("Profile lookup error:", error);
    res.status(500).json({ error: "Unable to load profile" });
  }
});

router.put("/profile/me", async (req, res) => {
  try {
    const uid = userId(req);
    const body = req.body || {};

    const username = cleanString(body.username, 50) || null;
    const firstName = cleanString(body.first_name, 80) || null;
    const lastName = cleanString(body.last_name, 80) || null;
    const headline = cleanString(body.headline, 180) || null;
    const bio = cleanString(body.bio, 5000) || null;
    const location = cleanString(body.location, 180) || null;
    const website = cleanString(body.website, 255) || null;
    const avatarUrl = cleanString(body.avatar_url, 2000) || null;
    const coverUrl = cleanString(body.cover_url, 2000) || null;
    const phone = cleanString(body.phone, 40) || null;
    const companyName = cleanString(body.company_name, 180) || null;
    const jobTitle = cleanString(body.job_title, 180) || null;

    let years = body.years_experience;
    if (years === "" || years === undefined || years === null) {
      years = null;
    } else {
      years = Number(years);
      if (!Number.isInteger(years) || years < 0 || years > 100) {
        return res.status(400).json({
          error: "Invalid years_experience"
        });
      }
    }

    const visibility =
      ["public", "connections", "private"].includes(body.visibility)
        ? body.visibility
        : "public";

    const result = await query(
      `INSERT INTO profiles
        (user_id, username, first_name, last_name, headline, bio,
         location, website, avatar_url, cover_url, phone,
         company_name, job_title, years_experience, visibility)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (user_id)
       DO UPDATE SET
         username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         headline = EXCLUDED.headline,
         bio = EXCLUDED.bio,
         location = EXCLUDED.location,
         website = EXCLUDED.website,
         avatar_url = EXCLUDED.avatar_url,
         cover_url = EXCLUDED.cover_url,
         phone = EXCLUDED.phone,
         company_name = EXCLUDED.company_name,
         job_title = EXCLUDED.job_title,
         years_experience = EXCLUDED.years_experience,
         visibility = EXCLUDED.visibility,
         updated_at = NOW()
       RETURNING *`,
      [
        uid,
        username,
        firstName,
        lastName,
        headline,
        bio,
        location,
        website,
        avatarUrl,
        coverUrl,
        phone,
        companyName,
        jobTitle,
        years,
        visibility
      ]
    );

    res.json({
      profile: result.rows[0]
    });
  } catch (error) {
    console.error("Profile update error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        error: "Username is already in use"
      });
    }

    res.status(500).json({
      error: "Unable to update profile"
    });
  }
});

router.get("/profile/:username", async (req, res) => {
  try {
    const username = cleanString(req.params.username, 50);

    const result = await query(
      `SELECT
         u.id,
         u.username AS account_username,
         u.name,
         u.role,
         p.*
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE LOWER(COALESCE(p.username, u.username)) = LOWER($1)
          OR LOWER(u.username) = LOWER($1)
       LIMIT 1`,
      [username]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Profile not found"
      });
    }

    const profile = result.rows[0];

    if (
      profile.visibility === "private" &&
      String(profile.id) !== String(userId(req))
    ) {
      return res.status(403).json({
        error: "Profile is private"
      });
    }

    if (
      profile.visibility === "connections" &&
      Number(profile.id) !== userId(req)
    ) {
      const c = await connectionExists(userId(req), Number(profile.id));
      if (!c || c.status !== "accepted") {
        return res.status(403).json({
          error: "Profile is visible to connections only"
        });
      }
    }

    res.json({ profile });
  } catch (error) {
    console.error("Profile public lookup error:", error);
    res.status(500).json({
      error: "Unable to load profile"
    });
  }
});

/* =========================================================
   SKILLS / EXPERIENCE / EDUCATION
   ========================================================= */

router.get("/skills", async (req, res) => {
  try {
    const search = cleanString(req.query.q, 100);

    const result = await query(
      `SELECT id, name
         FROM skills
        WHERE $1 = '' OR name ILIKE '%' || $1 || '%'
        ORDER BY name
        LIMIT 50`,
      [search]
    );

    res.json({
      skills: result.rows
    });
  } catch (error) {
    console.error("Skills error:", error);
    res.status(500).json({
      error: "Unable to load skills"
    });
  }
});

router.post("/profile/me/skills", async (req, res) => {
  try {
    const uid = userId(req);
    const name = requireString(req.body?.name, "name", 100);
    const proficiency = cleanString(req.body?.proficiency, 30) || null;

    const skill = await query(
      `INSERT INTO skills (name)
       VALUES ($1)
       ON CONFLICT (name)
       DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name`,
      [name]
    );

    await query(
      `INSERT INTO profile_skills (user_id, skill_id, proficiency)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id, skill_id)
       DO UPDATE SET proficiency = EXCLUDED.proficiency`,
      [uid, skill.rows[0].id, proficiency]
    );

    res.status(201).json({
      skill: {
        id: skill.rows[0].id,
        name: skill.rows[0].name,
        proficiency
      }
    });
  } catch (error) {
    console.error("Add skill error:", error);
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to add skill"
    });
  }
});

router.delete("/profile/me/skills/:skillId", async (req, res) => {
  try {
    const sid = idParam(req.params.skillId, "skillId");

    await query(
      `DELETE FROM profile_skills
       WHERE user_id = $1 AND skill_id = $2`,
      [userId(req), sid]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to remove skill"
    });
  }
});

router.get("/profile/me/experience", async (req, res) => {
  const result = await query(
    `SELECT * FROM experiences
      WHERE user_id = $1
      ORDER BY is_current_role DESC, start_date DESC NULLS LAST, id DESC`,
    [userId(req)]
  );

  res.json({ experience: result.rows });
});

router.post("/profile/me/experience", async (req, res) => {
  try {
    const body = req.body || {};

    const result = await query(
      `INSERT INTO experiences
        (user_id, company_name, title, location, description,
         start_date, end_date, is_current_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        userId(req),
        requireString(body.company_name, "company_name", 180),
        requireString(body.title, "title", 180),
        cleanString(body.location, 180) || null,
        cleanString(body.description, 5000) || null,
        body.start_date || null,
        body.end_date || null,
        Boolean(body.is_current_role)
      ]
    );

    res.status(201).json({
      experience: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to add experience"
    });
  }
});

router.patch("/profile/me/experience/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const result = await query(
      `UPDATE experiences
          SET company_name = COALESCE($1, company_name),
              title = COALESCE($2, title),
              location = COALESCE($3, location),
              description = COALESCE($4, description),
              start_date = COALESCE($5, start_date),
              end_date = COALESCE($6, end_date),
              is_current_role = COALESCE($7, is_current_role)
        WHERE id = $8 AND user_id = $9
      RETURNING *`,
      [
        req.body?.company_name ? cleanString(req.body.company_name, 180) : null,
        req.body?.title ? cleanString(req.body.title, 180) : null,
        req.body?.location ? cleanString(req.body.location, 180) : null,
        req.body?.description ? cleanString(req.body.description, 5000) : null,
        req.body?.start_date || null,
        req.body?.end_date || null,
        req.body?.is_current_role === undefined ? null : Boolean(req.body.is_current_role),
        id,
        userId(req)
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Experience not found" });
    }

    res.json({
      experience: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to update experience"
    });
  }
});

router.delete("/profile/me/experience/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    await query(
      `DELETE FROM experiences WHERE id=$1 AND user_id=$2`,
      [id, userId(req)]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to delete experience"
    });
  }
});

router.get("/profile/me/education", async (req, res) => {
  const result = await query(
    `SELECT * FROM education
      WHERE user_id=$1
      ORDER BY end_date DESC NULLS LAST, id DESC`,
    [userId(req)]
  );

  res.json({ education: result.rows });
});

router.post("/profile/me/education", async (req, res) => {
  try {
    const body = req.body || {};

    const result = await query(
      `INSERT INTO education
        (user_id, institution, qualification, field_of_study,
         start_date, end_date, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        userId(req),
        requireString(body.institution, "institution", 180),
        cleanString(body.qualification, 180) || null,
        cleanString(body.field_of_study, 180) || null,
        body.start_date || null,
        body.end_date || null,
        cleanString(body.description, 5000) || null
      ]
    );

    res.status(201).json({
      education: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to add education"
    });
  }
});

router.patch("/profile/me/education/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const result = await query(
      `UPDATE education
          SET institution = COALESCE($1, institution),
              qualification = COALESCE($2, qualification),
              field_of_study = COALESCE($3, field_of_study),
              start_date = COALESCE($4, start_date),
              end_date = COALESCE($5, end_date),
              description = COALESCE($6, description)
        WHERE id=$7 AND user_id=$8
      RETURNING *`,
      [
        req.body?.institution ? cleanString(req.body.institution, 180) : null,
        req.body?.qualification ? cleanString(req.body.qualification, 180) : null,
        req.body?.field_of_study ? cleanString(req.body.field_of_study, 180) : null,
        req.body?.start_date || null,
        req.body?.end_date || null,
        req.body?.description ? cleanString(req.body.description, 5000) : null,
        id,
        userId(req)
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Education record not found" });
    }

    res.json({
      education: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to update education"
    });
  }
});

router.delete("/profile/me/education/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    await query(
      `DELETE FROM education WHERE id=$1 AND user_id=$2`,
      [id, userId(req)]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to delete education"
    });
  }
});

/* =========================================================
   CONNECTIONS / FOLLOWS / BLOCKS
   ========================================================= */

router.get("/connections", async (req, res) => {
  try {
    const uid = userId(req);

    const result = await query(
      `SELECT
         c.id,
         c.status,
         c.created_at,
         u.id AS user_id,
         u.username,
         u.name,
         p.first_name,
         p.last_name,
         p.headline,
         p.avatar_url
       FROM connections c
       JOIN users u
         ON u.id = CASE
              WHEN c.requester_id=$1 THEN c.recipient_id
              ELSE c.requester_id
            END
       LEFT JOIN profiles p ON p.user_id=u.id
       WHERE (c.requester_id=$1 OR c.recipient_id=$1)
         AND c.status='accepted'
       ORDER BY c.created_at DESC
       LIMIT 500`,
      [uid]
    );

    res.json({
      connections: result.rows
    });
  } catch (error) {
    console.error("Connections error:", error);
    res.status(500).json({
      error: "Unable to load connections"
    });
  }
});

router.get("/connections/requests", async (req, res) => {
  const result = await query(
    `SELECT
       c.id,
       c.created_at,
       u.id AS user_id,
       u.username,
       u.name,
       p.headline,
       p.avatar_url
     FROM connections c
     JOIN users u ON u.id=c.requester_id
     LEFT JOIN profiles p ON p.user_id=u.id
     WHERE c.recipient_id=$1
       AND c.status='pending'
     ORDER BY c.created_at DESC`,
    [userId(req)]
  );

  res.json({
    requests: result.rows
  });
});

router.post("/connections/:userId", async (req, res) => {
  try {
    const target = idParam(req.params.userId, "userId");
    const uid = userId(req);

    if (target === uid) {
      return res.status(400).json({
        error: "You cannot connect with yourself"
      });
    }

    if (await isBlocked(uid, target)) {
      return res.status(403).json({
        error: "Connection unavailable"
      });
    }

    const targetExists = await query(
      `SELECT id FROM users WHERE id=$1 AND status='active'`,
      [target]
    );

    if (!targetExists.rowCount) {
      return res.status(404).json({
        error: "User not found"
      });
    }

    const existing = await connectionExists(uid, target);

    if (existing) {
      if (existing.status === "accepted") {
        return res.status(409).json({
          error: "Already connected"
        });
      }

      if (
        existing.requester_id === target &&
        existing.recipient_id === uid &&
        existing.status === "pending"
      ) {
        await query(
          `UPDATE connections
              SET status='accepted', updated_at=NOW()
            WHERE requester_id=$1 AND recipient_id=$2`,
          [target, uid]
        );

        await notify({
          targetUserId: target,
          actorId: uid,
          type: "connection_accepted",
          title: "Connection accepted",
          body: "Your connection request was accepted.",
          entityType: "user",
          entityId: uid
        });

        return res.json({
          status: "accepted"
        });
      }

      return res.status(409).json({
        error: "Connection request already exists"
      });
    }

    const result = await query(
      `INSERT INTO connections
        (requester_id, recipient_id, status)
       VALUES ($1,$2,'pending')
       RETURNING *`,
      [uid, target]
    );

    await notify({
      targetUserId: target,
      actorId: uid,
      type: "connection_request",
      title: "New connection request",
      body: `${req.user.name || req.user.username || "Someone"} wants to connect with you.`,
      entityType: "user",
      entityId: uid
    });

    res.status(201).json({
      connection: result.rows[0]
    });
  } catch (error) {
    console.error("Connection request error:", error);
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to create connection"
    });
  }
});

router.patch("/connections/:userId", async (req, res) => {
  try {
    const target = idParam(req.params.userId, "userId");
    const status = req.body?.status;

    if (!["accepted", "rejected", "blocked"].includes(status)) {
      return res.status(400).json({
        error: "Invalid connection status"
      });
    }

    let result;

    if (status === "accepted" || status === "rejected") {
      result = await query(
        `UPDATE connections
            SET status=$1, updated_at=NOW()
          WHERE requester_id=$2
            AND recipient_id=$3`,
        [status, target, userId(req)]
      );
    } else {
      await query(
        `UPDATE connections
            SET status='blocked', updated_at=NOW()
          WHERE
             (requester_id=$1 AND recipient_id=$2)
          OR (requester_id=$2 AND recipient_id=$1)`,
        [userId(req), target]
      );

      await query(
        `INSERT INTO blocks(blocker_id, blocked_id)
         VALUES($1,$2)
         ON CONFLICT DO NOTHING`,
        [userId(req), target]
      );

      return res.json({
        status: "blocked"
      });
    }

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Connection request not found"
      });
    }

    if (status === "accepted") {
      await notify({
        targetUserId: target,
        actorId: userId(req),
        type: "connection_accepted",
        title: "Connection accepted",
        body: "Your connection request was accepted.",
        entityType: "user",
        entityId: userId(req)
      });
    }

    res.json({
      connection: result.rows[0]
    });
  } catch (error) {
    console.error("Connection update error:", error);
    res.status(500).json({
      error: "Unable to update connection"
    });
  }
});

router.delete("/connections/:userId", async (req, res) => {
  try {
    const target = idParam(req.params.userId, "userId");

    await query(
      `DELETE FROM connections
       WHERE (requester_id=$1 AND recipient_id=$2)
          OR (requester_id=$2 AND recipient_id=$1)`,
      [userId(req), target]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      error: "Unable to remove connection"
    });
  }
});

router.post("/follows/:userId", async (req, res) => {
  try {
    const target = idParam(req.params.userId);

    if (target === userId(req)) {
      return res.status(400).json({
        error: "You cannot follow yourself"
      });
    }

    if (await isBlocked(userId(req), target)) {
      return res.status(403).json({
        error: "Action unavailable"
      });
    }

    await query(
      `INSERT INTO follows(follower_id, following_id)
       VALUES($1,$2)
       ON CONFLICT DO NOTHING`,
      [userId(req), target]
    );

    await notify({
      targetUserId: target,
      actorId: userId(req),
      type: "follow",
      title: "New follower",
      body: `${req.user.name || req.user.username || "Someone"} followed you.`,
      entityType: "user",
      entityId: userId(req)
    });

    res.status(201).json({ following: true });
  } catch (error) {
    res.status(500).json({
      error: "Unable to follow user"
    });
  }
});

router.delete("/follows/:userId", async (req, res) => {
  try {
    const target = idParam(req.params.userId);

    await query(
      `DELETE FROM follows
       WHERE follower_id=$1 AND following_id=$2`,
      [userId(req), target]
    );

    res.json({ following: false });
  } catch (error) {
    res.status(500).json({
      error: "Unable to unfollow user"
    });
  }
});

router.get("/follows", async (req, res) => {
  const type = req.query.type === "followers" ? "followers" : "following";
  const uid = userId(req);

  const result = await query(
    type === "following"
      ? `SELECT u.id, u.username, u.name, p.headline, p.avatar_url
           FROM follows f
           JOIN users u ON u.id=f.following_id
           LEFT JOIN profiles p ON p.user_id=u.id
          WHERE f.follower_id=$1
          ORDER BY f.created_at DESC`
      : `SELECT u.id, u.username, u.name, p.headline, p.avatar_url
           FROM follows f
           JOIN users u ON u.id=f.follower_id
           LEFT JOIN profiles p ON p.user_id=u.id
          WHERE f.following_id=$1
          ORDER BY f.created_at DESC`,
    [uid]
  );

  res.json({
    users: result.rows
  });
});

router.post("/blocks/:userId", async (req, res) => {
  try {
    const target = idParam(req.params.userId);

    if (target === userId(req)) {
      return res.status(400).json({
        error: "Invalid block target"
      });
    }

    await query(
      `INSERT INTO blocks(blocker_id, blocked_id)
       VALUES($1,$2)
       ON CONFLICT DO NOTHING`,
      [userId(req), target]
    );

    await query(
      `DELETE FROM follows
       WHERE (follower_id=$1 AND following_id=$2)
          OR (follower_id=$2 AND following_id=$1)`,
      [userId(req), target]
    );

    await query(
      `DELETE FROM connections
       WHERE (requester_id=$1 AND recipient_id=$2)
          OR (requester_id=$2 AND recipient_id=$1)`,
      [userId(req), target]
    );

    res.status(201).json({
      blocked: true
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to block user"
    });
  }
});

router.delete("/blocks/:userId", async (req, res) => {
  try {
    const target = idParam(req.params.userId);

    await query(
      `DELETE FROM blocks
       WHERE blocker_id=$1 AND blocked_id=$2`,
      [userId(req), target]
    );

    res.json({
      blocked: false
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to unblock user"
    });
  }
});

/* =========================================================
   POSTS / FEED
   ========================================================= */

router.get("/posts", async (req, res) => {
  try {
    const uid = userId(req);
    const limit = limitValue(req.query.limit, 25, 50);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const result = await query(
      `SELECT
         p.*,
         u.username,
         u.name,
         pr.headline,
         pr.avatar_url,
         (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id=p.id) AS likes_count,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comments_count,
         (SELECT COUNT(*) FROM post_shares ps WHERE ps.post_id=p.id) AS shares_count,
         EXISTS(
           SELECT 1 FROM post_likes pl
            WHERE pl.post_id=p.id AND pl.user_id=$1
         ) AS liked,
         EXISTS(
           SELECT 1 FROM saved_posts sp
            WHERE sp.post_id=p.id AND sp.user_id=$1
         ) AS saved,
         EXISTS(
           SELECT 1 FROM post_shares ps
            WHERE ps.post_id=p.id AND ps.user_id=$1
         ) AS shared
       FROM posts p
       JOIN users u ON u.id=p.user_id
       LEFT JOIN profiles pr ON pr.user_id=p.user_id
       WHERE p.deleted_at IS NULL
         AND (
           p.user_id=$1
           OR p.visibility='public'
           OR (
             p.visibility='connections'
             AND EXISTS(
               SELECT 1
                 FROM connections c
                WHERE c.status='accepted'
                  AND (
                    (c.requester_id=$1 AND c.recipient_id=p.user_id)
                    OR
                    (c.requester_id=p.user_id AND c.recipient_id=$1)
                  )
             )
           )
         )
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [uid, limit, offset]
    );

    res.json({
      posts: result.rows,
      limit,
      offset
    });
  } catch (error) {
    console.error("Feed error:", error);
    res.status(500).json({
      error: "Unable to load feed"
    });
  }
});

router.post("/posts", async (req, res) => {
  try {
    const content = requireString(req.body?.content, "content", 20000);

    const allowedTypes = ["post", "job", "sell", "event"];
    const postType = allowedTypes.includes(req.body?.post_type)
      ? req.body.post_type
      : "post";

    const visibility = ["public", "connections", "private"].includes(
      req.body?.visibility
    )
      ? req.body.visibility
      : "public";

    const mediaUrl = cleanString(req.body?.media_url, 2000) || null;

    const result = await query(
      `INSERT INTO posts
        (user_id, content, media_url, post_type, visibility)
       VALUES($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        userId(req),
        content,
        mediaUrl,
        postType,
        visibility
      ]
    );

    res.status(201).json({
      post: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to create post"
    });
  }
});

router.get("/posts/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const result = await query(
      `SELECT
         p.*,
         u.username,
         u.name,
         pr.headline,
         pr.avatar_url,
         (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id=p.id) AS likes_count,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comments_count,
         (SELECT COUNT(*) FROM post_shares ps WHERE ps.post_id=p.id) AS shares_count,
         EXISTS(
           SELECT 1 FROM post_likes pl
            WHERE pl.post_id=p.id AND pl.user_id=$2
         ) AS liked,
         EXISTS(
           SELECT 1 FROM saved_posts sp
            WHERE sp.post_id=p.id AND sp.user_id=$2
         ) AS saved
       FROM posts p
       JOIN users u ON u.id=p.user_id
       LEFT JOIN profiles pr ON pr.user_id=p.user_id
       WHERE p.id=$1 AND p.deleted_at IS NULL`,
      [id, userId(req)]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Post not found"
      });
    }

    res.json({
      post: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to load post"
    });
  }
});

router.patch("/posts/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);
    const content =
      req.body?.content === undefined
        ? null
        : requireString(req.body.content, "content", 20000);

    const media =
      req.body?.media_url === undefined
        ? null
        : cleanString(req.body.media_url, 2000);

    const result = await query(
      `UPDATE posts
          SET content = COALESCE($1, content),
              media_url = CASE WHEN $2 IS NULL THEN media_url ELSE $2 END,
              updated_at = NOW()
        WHERE id=$3 AND user_id=$4 AND deleted_at IS NULL
      RETURNING *`,
      [content, media, id, userId(req)]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Post not found"
      });
    }

    res.json({
      post: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to update post"
    });
  }
});

router.delete("/posts/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const result = await query(
      `UPDATE posts
          SET deleted_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
      RETURNING id`,
      [id, userId(req)]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Post not found"
      });
    }

    res.json({
      deleted: true
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to delete post"
    });
  }
});

router.post("/posts/:id/like", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const post = await query(
      `SELECT user_id FROM posts WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );

    if (!post.rowCount) {
      return res.status(404).json({
        error: "Post not found"
      });
    }

    await query(
      `INSERT INTO post_likes(post_id,user_id)
       VALUES($1,$2)
       ON CONFLICT DO NOTHING`,
      [id, userId(req)]
    );

    if (Number(post.rows[0].user_id) !== userId(req)) {
      await notify({
        targetUserId: Number(post.rows[0].user_id),
        actorId: userId(req),
        type: "post_like",
        title: "Someone liked your post",
        entityType: "post",
        entityId: id
      });
    }

    res.json({
      liked: true
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to like post"
    });
  }
});

router.delete("/posts/:id/like", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    await query(
      `DELETE FROM post_likes
       WHERE post_id=$1 AND user_id=$2`,
      [id, userId(req)]
    );

    res.json({
      liked: false
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to unlike post"
    });
  }
});

router.post("/posts/:id/share", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const post = await query(
      `SELECT user_id FROM posts WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );

    if (!post.rowCount) {
      return res.status(404).json({
        error: "Post not found"
      });
    }

    await query(
      `INSERT INTO post_shares(post_id,user_id)
       VALUES($1,$2)
       ON CONFLICT DO NOTHING`,
      [id, userId(req)]
    );

    await query(
      `INSERT INTO posts(user_id, content, post_type, visibility)
       SELECT $1, content, 'post', 'public'
       FROM posts
       WHERE id=$2 AND deleted_at IS NULL`,
      [userId(req), id]
    );

    res.json({
      shared: true
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to share post"
    });
  }
});

router.post("/posts/:id/save", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    await query(
      `INSERT INTO saved_posts(post_id,user_id)
       VALUES($1,$2)
       ON CONFLICT DO NOTHING`,
      [id, userId(req)]
    );

    res.json({
      saved: true
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to save post"
    });
  }
});

router.delete("/posts/:id/save", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    await query(
      `DELETE FROM saved_posts
       WHERE post_id=$1 AND user_id=$2`,
      [id, userId(req)]
    );

    res.json({
      saved: false
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to unsave post"
    });
  }
});

router.get("/posts/:id/comments", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const result = await query(
      `SELECT
         c.*,
         u.username,
         u.name,
         p.avatar_url
       FROM comments c
       JOIN users u ON u.id=c.user_id
       LEFT JOIN profiles p ON p.user_id=u.id
       WHERE c.post_id=$1
         AND c.deleted_at IS NULL
       ORDER BY c.created_at ASC
       LIMIT 500`,
      [id]
    );

    res.json({
      comments: result.rows
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to load comments"
    });
  }
});

router.post("/posts/:id/comments", async (req, res) => {
  try {
    const id = idParam(req.params.id);
    const content = requireString(req.body?.content, "content", 5000);

    const post = await query(
      `SELECT user_id FROM posts WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );

    if (!post.rowCount) {
      return res.status(404).json({
        error: "Post not found"
      });
    }

    const parentId =
      req.body?.parent_comment_id === undefined ||
      req.body?.parent_comment_id === null
        ? null
        : idParam(req.body.parent_comment_id, "parent_comment_id");

    const result = await query(
      `INSERT INTO comments
        (post_id,user_id,parent_comment_id,content)
       VALUES($1,$2,$3,$4)
       RETURNING *`,
      [id, userId(req), parentId, content]
    );

    if (Number(post.rows[0].user_id) !== userId(req)) {
      await notify({
        targetUserId: Number(post.rows[0].user_id),
        actorId: userId(req),
        type: "post_comment",
        title: "New comment on your post",
        body: content.slice(0, 120),
        entityType: "post",
        entityId: id
      });
    }

    res.status(201).json({
      comment: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to add comment"
    });
  }
});

router.patch("/comments/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);
    const content = requireString(req.body?.content, "content", 5000);

    const result = await query(
      `UPDATE comments
          SET content=$1, updated_at=NOW()
        WHERE id=$2 AND user_id=$3 AND deleted_at IS NULL
      RETURNING *`,
      [content, id, userId(req)]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Comment not found"
      });
    }

    res.json({
      comment: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to update comment"
    });
  }
});

router.delete("/comments/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const result = await query(
      `UPDATE comments
          SET deleted_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
      RETURNING id`,
      [id, userId(req)]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Comment not found"
      });
    }

    res.json({
      deleted: true
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to delete comment"
    });
  }
});

/* =========================================================
   COMPANIES
   ========================================================= */

router.get("/companies", async (req, res) => {
  try {
    const search = cleanString(req.query.search, 120);
    const limit = limitValue(req.query.limit, 25, 100);

    const result = await query(
      `SELECT
         c.*,
         u.username AS owner_username,
         u.name AS owner_name,
         (SELECT COUNT(*) FROM company_members cm WHERE cm.company_id=c.id) AS member_count,
         (SELECT COUNT(*) FROM job_listings j WHERE j.company_id=c.id AND j.status='open') AS open_jobs
       FROM companies c
       LEFT JOIN users u ON u.id=c.owner_id
       WHERE $1=''
          OR c.name ILIKE '%'||$1||'%'
          OR c.industry ILIKE '%'||$1||'%'
          OR c.location ILIKE '%'||$1||'%'
       ORDER BY c.created_at DESC
       LIMIT $2`,
      [search, limit]
    );

    res.json({
      companies: result.rows
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to load companies"
    });
  }
});

router.post("/companies", async (req, res) => {
  try {
    const name = requireString(req.body?.name, "name", 180);
    const description = cleanString(req.body?.description, 10000) || null;
    const industry = cleanString(req.body?.industry, 120) || null;
    const location = cleanString(req.body?.location, 180) || null;
    const website = cleanString(req.body?.website, 255) || null;
    const logoUrl = cleanString(req.body?.logo_url, 2000) || null;
    const coverUrl = cleanString(req.body?.cover_url, 2000) || null;

    const slugBase = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 180);

    const slug = `${slugBase || "company"}-${crypto.randomBytes(3).toString("hex")}`;

    const result = await query(
      `INSERT INTO companies
        (owner_id,name,slug,description,industry,location,website,logo_url,cover_url)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        userId(req),
        name,
        slug,
        description,
        industry,
        location,
        website,
        logoUrl,
        coverUrl
      ]
    );

    await query(
      `INSERT INTO company_members(company_id,user_id,role)
       VALUES($1,$2,'owner')
       ON CONFLICT DO NOTHING`,
      [result.rows[0].id, userId(req)]
    );

    res.status(201).json({
      company: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to create company"
    });
  }
});

router.get("/companies/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const result = await query(
      `SELECT
         c.*,
         u.username AS owner_username,
         u.name AS owner_name,
         (SELECT COUNT(*) FROM company_members cm WHERE cm.company_id=c.id) AS member_count
       FROM companies c
       LEFT JOIN users u ON u.id=c.owner_id
       WHERE c.id=$1`,
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Company not found"
      });
    }

    res.json({
      company: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to load company"
    });
  }
});

router.patch("/companies/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const result = await query(
      `UPDATE companies
          SET name=COALESCE($1,name),
              description=COALESCE($2,description),
              industry=COALESCE($3,industry),
              location=COALESCE($4,location),
              website=COALESCE($5,website),
              logo_url=COALESCE($6,logo_url),
              cover_url=COALESCE($7,cover_url),
              updated_at=NOW()
        WHERE id=$8 AND owner_id=$9
      RETURNING *`,
      [
        req.body?.name ? cleanString(req.body.name, 180) : null,
        req.body?.description ? cleanString(req.body.description, 10000) : null,
        req.body?.industry ? cleanString(req.body.industry, 120) : null,
        req.body?.location ? cleanString(req.body.location, 180) : null,
        req.body?.website ? cleanString(req.body.website, 255) : null,
        req.body?.logo_url ? cleanString(req.body.logo_url, 2000) : null,
        req.body?.cover_url ? cleanString(req.body.cover_url, 2000) : null,
        id,
        userId(req)
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Company not found or not owned by you"
      });
    }

    res.json({
      company: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to update company"
    });
  }
});

router.post("/companies/:id/members", async (req, res) => {
  try {
    const companyId = idParam(req.params.id, "companyId");
    const targetUserId = idParam(req.body?.user_id, "user_id");
    const role = cleanString(req.body?.role, 50) || "member";

    const owner = await query(
      `SELECT 1 FROM companies
       WHERE id=$1 AND owner_id=$2`,
      [companyId, userId(req)]
    );

    if (!owner.rowCount) {
      return res.status(403).json({
        error: "Company owner access required"
      });
    }

    await query(
      `INSERT INTO company_members(company_id,user_id,role)
       VALUES($1,$2,$3)
       ON CONFLICT(company_id,user_id)
       DO UPDATE SET role=EXCLUDED.role`,
      [companyId, targetUserId, role]
    );

    res.status(201).json({
      member: true
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to add company member"
    });
  }
});

router.delete("/companies/:id/members/:userId", async (req, res) => {
  try {
    const companyId = idParam(req.params.id, "companyId");
    const targetUserId = idParam(req.params.userId, "userId");

    const owner = await query(
      `SELECT 1 FROM companies
       WHERE id=$1 AND owner_id=$2`,
      [companyId, userId(req)]
    );

    if (!owner.rowCount) {
      return res.status(403).json({
        error: "Company owner access required"
      });
    }

    await query(
      `DELETE FROM company_members
       WHERE company_id=$1 AND user_id=$2`,
      [companyId, targetUserId]
    );

    res.json({
      removed: true
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to remove company member"
    });
  }
});

/* =========================================================
   JOBS / APPLICATIONS
   ========================================================= */

router.get("/jobs", async (req, res) => {
  try {
    const search = cleanString(req.query.search, 120);
    const status = ["draft", "open", "closed", "archived"].includes(req.query.status)
      ? req.query.status
      : "open";
    const workplace = cleanString(req.query.workplace_type, 40);
    const limit = limitValue(req.query.limit, 25, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const result = await query(
      `SELECT
         j.*,
         c.name AS company_name,
         c.slug AS company_slug,
         c.logo_url AS company_logo,
         u.username AS creator_username,
         EXISTS(
           SELECT 1 FROM job_applications ja
            WHERE ja.job_id=j.id AND ja.applicant_id=$1
         ) AS applied
       FROM job_listings j
       LEFT JOIN companies c ON c.id=j.company_id
       JOIN users u ON u.id=j.created_by
       WHERE j.status=$2
         AND ($3='' OR j.title ILIKE '%'||$3||'%' OR j.description ILIKE '%'||$3||'%')
         AND ($4='' OR j.workplace_type=$4)
       ORDER BY j.created_at DESC
       LIMIT $5 OFFSET $6`,
      [userId(req), status, search, workplace, limit, offset]
    );

    res.json({
      jobs: result.rows,
      limit,
      offset
    });
  } catch (error) {
    console.error("Jobs error:", error);
    res.status(500).json({
      error: "Unable to load jobs"
    });
  }
});

router.post("/jobs", async (req, res) => {
  try {
    const body = req.body || {};

    const result = await query(
      `INSERT INTO job_listings
        (company_id,created_by,title,description,employment_type,
         workplace_type,location,salary_min,salary_max,currency,
         skills,status,application_deadline)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        body.company_id ? idParam(body.company_id, "company_id") : null,
        userId(req),
        requireString(body.title, "title", 180),
        requireString(body.description, "description", 20000),
        cleanString(body.employment_type, 40) || null,
        cleanString(body.workplace_type, 40) || null,
        cleanString(body.location, 180) || null,
        body.salary_min === undefined || body.salary_min === "" ? null : Number(body.salary_min),
        body.salary_max === undefined || body.salary_max === "" ? null : Number(body.salary_max),
        cleanString(body.currency, 10) || null,
        Array.isArray(body.skills) ? body.skills.map(x => cleanString(x, 100)).filter(Boolean).slice(0, 50) : [],
        ["draft", "open"].includes(body.status) ? body.status : "draft",
        body.application_deadline || null
      ]
    );

    res.status(201).json({
      job: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to create job"
    });
  }
});

router.get("/jobs/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const result = await query(
      `SELECT
         j.*,
         c.name AS company_name,
         c.slug AS company_slug,
         c.logo_url AS company_logo,
         u.username AS creator_username,
         u.name AS creator_name,
         EXISTS(
           SELECT 1 FROM job_applications ja
            WHERE ja.job_id=j.id AND ja.applicant_id=$2
         ) AS applied
       FROM job_listings j
       LEFT JOIN companies c ON c.id=j.company_id
       JOIN users u ON u.id=j.created_by
       WHERE j.id=$1`,
      [id, userId(req)]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Job not found"
      });
    }

    res.json({
      job: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to load job"
    });
  }
});

router.patch("/jobs/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);
    const body = req.body || {};

    const result = await query(
      `UPDATE job_listings
          SET title=COALESCE($1,title),
              description=COALESCE($2,description),
              employment_type=COALESCE($3,employment_type),
              workplace_type=COALESCE($4,workplace_type),
              location=COALESCE($5,location),
              salary_min=COALESCE($6,salary_min),
              salary_max=COALESCE($7,salary_max),
              currency=COALESCE($8,currency),
              skills=COALESCE($9,skills),
              status=COALESCE($10,status),
              application_deadline=COALESCE($11,application_deadline),
              updated_at=NOW()
        WHERE id=$12 AND created_by=$13
      RETURNING *`,
      [
        body.title ? cleanString(body.title, 180) : null,
        body.description ? cleanString(body.description, 20000) : null,
        body.employment_type ? cleanString(body.employment_type, 40) : null,
        body.workplace_type ? cleanString(body.workplace_type, 40) : null,
        body.location ? cleanString(body.location, 180) : null,
        body.salary_min === undefined ? null : Number(body.salary_min),
        body.salary_max === undefined ? null : Number(body.salary_max),
        body.currency ? cleanString(body.currency, 10) : null,
        Array.isArray(body.skills)
          ? body.skills.map(x => cleanString(x, 100)).filter(Boolean).slice(0, 50)
          : null,
        ["draft", "open", "closed", "archived"].includes(body.status)
          ? body.status
          : null,
        body.application_deadline || null,
        id,
        userId(req)
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Job not found or not owned by you"
      });
    }

    res.json({
      job: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to update job"
    });
  }
});

router.post("/jobs/:id/apply", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const job = await query(
      `SELECT id, created_by, title
       FROM job_listings
       WHERE id=$1 AND status='open'`,
      [id]
    );

    if (!job.rowCount) {
      return res.status(404).json({
        error: "Open job not found"
      });
    }

    if (Number(job.rows[0].created_by) === userId(req)) {
      return res.status(400).json({
        error: "You cannot apply to your own job"
      });
    }

    const result = await query(
      `INSERT INTO job_applications
        (job_id,applicant_id,cover_letter,resume_url)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(job_id,applicant_id) DO NOTHING
       RETURNING *`,
      [
        id,
        userId(req),
        cleanString(req.body?.cover_letter, 10000) || null,
        cleanString(req.body?.resume_url, 2000) || null
      ]
    );

    if (!result.rowCount) {
      return res.status(409).json({
        error: "Application already exists"
      });
    }

    await notify({
      targetUserId: Number(job.rows[0].created_by),
      actorId: userId(req),
      type: "job_application",
      title: "New job application",
      body: `A user applied for ${job.rows[0].title}.`,
      entityType: "job",
      entityId: id
    });

    res.status(201).json({
      application: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to apply for job"
    });
  }
});

router.get("/jobs/:id/applications", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const owner = await query(
      `SELECT 1 FROM job_listings
       WHERE id=$1 AND created_by=$2`,
      [id, userId(req)]
    );

    if (!owner.rowCount) {
      return res.status(403).json({
        error: "Job owner access required"
      });
    }

    const result = await query(
      `SELECT
         ja.*,
         u.username,
         u.name,
         p.headline,
         p.avatar_url
       FROM job_applications ja
       JOIN users u ON u.id=ja.applicant_id
       LEFT JOIN profiles p ON p.user_id=u.id
       WHERE ja.job_id=$1
       ORDER BY ja.created_at DESC`,
      [id]
    );

    res.json({
      applications: result.rows
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to load applications"
    });
  }
});

router.patch("/applications/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);
    const status = req.body?.status;

    if (
      ![
        "submitted",
        "reviewing",
        "shortlisted",
        "rejected",
        "accepted",
        "withdrawn"
      ].includes(status)
    ) {
      return res.status(400).json({
        error: "Invalid application status"
      });
    }

    const ownership = await query(
      `SELECT
         ja.applicant_id,
         j.created_by
       FROM job_applications ja
       JOIN job_listings j ON j.id=ja.job_id
       WHERE ja.id=$1`,
      [id]
    );

    if (!ownership.rowCount) {
      return res.status(404).json({
        error: "Application not found"
      });
    }

    if (
      Number(ownership.rows[0].created_by) !== userId(req) &&
      !(status === "withdrawn" &&
        Number(ownership.rows[0].applicant_id) === userId(req))
    ) {
      return res.status(403).json({
        error: "Not authorized"
      });
    }

    const result = await query(
      `UPDATE job_applications
          SET status=$1, updated_at=NOW()
        WHERE id=$2
      RETURNING *`,
      [status, id]
    );

    await notify({
      targetUserId:
        status === "withdrawn"
          ? Number(ownership.rows[0].created_by)
          : Number(ownership.rows[0].applicant_id),
      actorId: userId(req),
      type: "job_application_status",
      title: "Job application updated",
      body: `Application status changed to ${status}.`,
      entityType: "application",
      entityId: id
    });

    res.json({
      application: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to update application"
    });
  }
});

/* =========================================================
   MARKETPLACE
   ========================================================= */

router.get("/marketplace", async (req, res) => {
  try {
    const search = cleanString(req.query.search, 120);
    const category = cleanString(req.query.category, 100);
    const listingType = ["product", "service"].includes(req.query.listing_type)
      ? req.query.listing_type
      : "";
    const limit = limitValue(req.query.limit, 25, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const result = await query(
      `SELECT
         m.*,
         u.username AS seller_username,
         u.name AS seller_name,
         p.avatar_url AS seller_avatar
       FROM marketplace_listings m
       JOIN users u ON u.id=m.seller_id
       LEFT JOIN profiles p ON p.user_id=u.id
       WHERE m.status='active'
         AND ($1='' OR m.title ILIKE '%'||$1||'%' OR m.description ILIKE '%'||$1||'%')
         AND ($2='' OR m.category=$2)
         AND ($3='' OR m.listing_type=$3)
       ORDER BY m.created_at DESC
       LIMIT $4 OFFSET $5`,
      [search, category, listingType, limit, offset]
    );

    res.json({
      listings: result.rows,
      limit,
      offset
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to load marketplace"
    });
  }
});

router.post("/marketplace", async (req, res) => {
  try {
    const body = req.body || {};

    const listingType = ["product", "service"].includes(body.listing_type)
      ? body.listing_type
      : "product";

    const result = await query(
      `INSERT INTO marketplace_listings
        (seller_id,company_id,title,description,category,listing_type,
         price,currency,location,media_url,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')
       RETURNING *`,
      [
        userId(req),
        body.company_id ? idParam(body.company_id, "company_id") : null,
        requireString(body.title, "title", 200),
        requireString(body.description, "description", 20000),
        cleanString(body.category, 100) || null,
        listingType,
        body.price === undefined || body.price === "" ? null : Number(body.price),
        cleanString(body.currency, 10) || null,
        cleanString(body.location, 180) || null,
        cleanString(body.media_url, 2000) || null
      ]
    );

    res.status(201).json({
      listing: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to create listing"
    });
  }
});

router.get("/marketplace/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const result = await query(
      `SELECT
         m.*,
         u.username AS seller_username,
         u.name AS seller_name,
         p.avatar_url AS seller_avatar
       FROM marketplace_listings m
       JOIN users u ON u.id=m.seller_id
       LEFT JOIN profiles p ON p.user_id=u.id
       WHERE m.id=$1`,
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Listing not found"
      });
    }

    res.json({
      listing: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to load listing"
    });
  }
});

router.patch("/marketplace/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);
    const body = req.body || {};

    const result = await query(
      `UPDATE marketplace_listings
          SET title=COALESCE($1,title),
              description=COALESCE($2,description),
              category=COALESCE($3,category),
              listing_type=COALESCE($4,listing_type),
              price=COALESCE($5,price),
              currency=COALESCE($6,currency),
              location=COALESCE($7,location),
              media_url=COALESCE($8,media_url),
              status=COALESCE($9,status),
              updated_at=NOW()
        WHERE id=$10 AND seller_id=$11
      RETURNING *`,
      [
        body.title ? cleanString(body.title, 200) : null,
        body.description ? cleanString(body.description, 20000) : null,
        body.category ? cleanString(body.category, 100) : null,
        ["product", "service"].includes(body.listing_type) ? body.listing_type : null,
        body.price === undefined ? null : Number(body.price),
        body.currency ? cleanString(body.currency, 10) : null,
        body.location ? cleanString(body.location, 180) : null,
        body.media_url ? cleanString(body.media_url, 2000) : null,
        ["draft", "active", "sold", "closed", "archived"].includes(body.status)
          ? body.status
          : null,
        id,
        userId(req)
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Listing not found or not owned by you"
      });
    }

    res.json({
      listing: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to update listing"
    });
  }
});

router.delete("/marketplace/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    await query(
      `UPDATE marketplace_listings
          SET status='archived', updated_at=NOW()
        WHERE id=$1 AND seller_id=$2`,
      [id, userId(req)]
    );

    res.json({
      deleted: true
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to remove listing"
    });
  }
});

/* =========================================================
   MESSAGING
   ========================================================= */

router.post("/conversations", async (req, res) => {
  try {
    const uid = userId(req);

    let members = Array.isArray(req.body?.member_ids)
      ? req.body.member_ids
          .map(x => idParam(x, "member_id"))
          .filter(x => x !== uid)
      : [];

    if (req.body?.user_id !== undefined) {
      members.push(idParam(req.body.user_id, "user_id"));
    }

    members = [...new Set(members)];

    if (!members.length) {
      return res.status(400).json({
        error: "At least one other member is required"
      });
    }

    for (const member of members) {
      if (await isBlocked(uid, member)) {
        return res.status(403).json({
          error: "Conversation unavailable"
        });
      }
    }

    const conv = await query(
      `INSERT INTO conversations DEFAULT VALUES
       RETURNING *`
    );

    const conversationId = conv.rows[0].id;

    await query(
      `INSERT INTO conversation_members(conversation_id,user_id)
       VALUES($1,$2)
       ON CONFLICT DO NOTHING`,
      [conversationId, uid]
    );

    for (const member of members) {
      await query(
        `INSERT INTO conversation_members(conversation_id,user_id)
         VALUES($1,$2)
         ON CONFLICT DO NOTHING`,
        [conversationId, member]
      );
    }

    res.status(201).json({
      conversation: conv.rows[0]
    });
  } catch (error) {
    console.error("Conversation creation error:", error);
    res.status(500).json({
      error: "Unable to create conversation"
    });
  }
});

router.get("/conversations", async (req, res) => {
  try {
    const result = await query(
      `SELECT
         c.id,
         c.created_at,
         c.updated_at,
         (
           SELECT m.body
           FROM messages m
           WHERE m.conversation_id=c.id
             AND m.deleted_at IS NULL
           ORDER BY m.created_at DESC
           LIMIT 1
         ) AS last_message,
         (
           SELECT m.created_at
           FROM messages m
           WHERE m.conversation_id=c.id
             AND m.deleted_at IS NULL
           ORDER BY m.created_at DESC
           LIMIT 1
         ) AS last_message_at,
         (
           SELECT COUNT(*)
           FROM messages m
           WHERE m.conversation_id=c.id
             AND m.deleted_at IS NULL
             AND m.sender_id <> $1
         ) AS incoming_message_count
       FROM conversations c
       JOIN conversation_members cm
         ON cm.conversation_id=c.id
       WHERE cm.user_id=$1
       ORDER BY c.updated_at DESC`,
      [userId(req)]
    );

    res.json({
      conversations: result.rows
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to load conversations"
    });
  }
});

router.get("/conversations/:id/members", async (req, res) => {
  try {
    const conversationId = req.params.id;

    const access = await query(
      `SELECT 1
       FROM conversation_members
       WHERE conversation_id=$1 AND user_id=$2`,
      [conversationId, userId(req)]
    );

    if (!access.rowCount) {
      return res.status(403).json({
        error: "Conversation access required"
      });
    }

    const result = await query(
      `SELECT
         u.id,
         u.username,
         u.name,
         p.headline,
         p.avatar_url,
         cm.joined_at,
         cm.last_read_at
       FROM conversation_members cm
       JOIN users u ON u.id=cm.user_id
       LEFT JOIN profiles p ON p.user_id=u.id
       WHERE cm.conversation_id=$1
       ORDER BY cm.joined_at`,
      [conversationId]
    );

    res.json({
      members: result.rows
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to load conversation members"
    });
  }
});

router.get("/conversations/:id/messages", async (req, res) => {
  try {
    const conversationId = req.params.id;
    const limit = limitValue(req.query.limit, 50, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const access = await query(
      `SELECT 1 FROM conversation_members
       WHERE conversation_id=$1 AND user_id=$2`,
      [conversationId, userId(req)]
    );

    if (!access.rowCount) {
      return res.status(403).json({
        error: "Conversation access required"
      });
    }

    const result = await query(
      `SELECT
         m.*,
         u.username AS sender_username,
         u.name AS sender_name,
         p.avatar_url AS sender_avatar
       FROM messages m
       JOIN users u ON u.id=m.sender_id
       LEFT JOIN profiles p ON p.user_id=m.sender_id
       WHERE m.conversation_id=$1
         AND m.deleted_at IS NULL
       ORDER BY m.created_at ASC
       LIMIT $2 OFFSET $3`,
      [conversationId, limit, offset]
    );

    res.json({
      messages: result.rows,
      limit,
      offset
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to load messages"
    });
  }
});

router.post("/conversations/:id/messages", async (req, res) => {
  try {
    const conversationId = req.params.id;
    const body = requireString(req.body?.body, "body", 10000);
    const attachmentUrl =
      cleanString(req.body?.attachment_url, 2000) || null;

    const access = await query(
      `SELECT 1 FROM conversation_members
       WHERE conversation_id=$1 AND user_id=$2`,
      [conversationId, userId(req)]
    );

    if (!access.rowCount) {
      return res.status(403).json({
        error: "Conversation access required"
      });
    }

    const result = await query(
      `INSERT INTO messages
        (conversation_id,sender_id,body,attachment_url)
       VALUES($1,$2,$3,$4)
       RETURNING *`,
      [conversationId, userId(req), body, attachmentUrl]
    );

    await query(
      `UPDATE conversations
          SET updated_at=NOW()
        WHERE id=$1`,
      [conversationId]
    );

    await query(
      `INSERT INTO notifications
        (user_id,actor_id,type,entity_type,title,body)
       SELECT
         cm.user_id,
         $2,
         'message',
         'conversation',
         'New message',
         LEFT($3, 180)
       FROM conversation_members cm
       WHERE cm.conversation_id=$1
         AND cm.user_id<>$2`,
      [conversationId, userId(req), body]
    ).catch(() => {});

    res.status(201).json({
      message: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to send message"
    });
  }
});

router.patch("/conversations/:id/read", async (req, res) => {
  try {
    const conversationId = req.params.id;

    const result = await query(
      `UPDATE conversation_members
          SET last_read_at=NOW()
        WHERE conversation_id=$1 AND user_id=$2
      RETURNING *`,
      [conversationId, userId(req)]
    );

    if (!result.rowCount) {
      return res.status(403).json({
        error: "Conversation access required"
      });
    }

    res.json({
      read: true
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to mark conversation read"
    });
  }
});

router.patch("/messages/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);
    const body = requireString(req.body?.body, "body", 10000);

    const result = await query(
      `UPDATE messages
          SET body=$1, edited_at=NOW()
        WHERE id=$2 AND sender_id=$3 AND deleted_at IS NULL
      RETURNING *`,
      [body, id, userId(req)]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Message not found"
      });
    }

    res.json({
      message: result.rows[0]
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to edit message"
    });
  }
});

router.delete("/messages/:id", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const result = await query(
      `UPDATE messages
          SET deleted_at=NOW()
        WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL
      RETURNING id`,
      [id, userId(req)]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Message not found"
      });
    }

    res.json({
      deleted: true
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to delete message"
    });
  }
});

/* =========================================================
   NOTIFICATIONS
   ========================================================= */

router.get("/notifications", async (req, res) => {
  try {
    const limit = limitValue(req.query.limit, 50, 100);

    const result = await query(
      `SELECT
         n.*,
         u.username AS actor_username,
         u.name AS actor_name,
         p.avatar_url AS actor_avatar
       FROM notifications n
       LEFT JOIN users u ON u.id=n.actor_id
       LEFT JOIN profiles p ON p.user_id=n.actor_id
       WHERE n.user_id=$1
       ORDER BY n.created_at DESC
       LIMIT $2`,
      [userId(req), limit]
    );

    res.json({
      notifications: result.rows
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to load notifications"
    });
  }
});

router.patch("/notifications/:id/read", async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const result = await query(
      `UPDATE notifications
          SET read_at=COALESCE(read_at,NOW())
        WHERE id=$1 AND user_id=$2
      RETURNING *`,
      [id, userId(req)]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Notification not found"
      });
    }

    res.json({
      notification: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to mark notification read"
    });
  }
});

router.patch("/notifications/read-all", async (req, res) => {
  try {
    await query(
      `UPDATE notifications
          SET read_at=NOW()
        WHERE user_id=$1 AND read_at IS NULL`,
      [userId(req)]
    );

    res.json({
      success: true
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to mark notifications read"
    });
  }
});

/* =========================================================
   SEARCH
   ========================================================= */

router.get("/search", async (req, res) => {
  try {
    const q = requireString(req.query.q, "q", 100);
    const limit = limitValue(req.query.limit, 10, 25);

    const [users, companies, jobs, marketplace] = await Promise.all([
      query(
        `SELECT
           u.id,
           u.username,
           u.name,
           p.headline,
           p.avatar_url
         FROM users u
         LEFT JOIN profiles p ON p.user_id=u.id
         WHERE u.status='active'
           AND (
             u.username ILIKE '%'||$1||'%'
             OR u.name ILIKE '%'||$1||'%'
             OR p.headline ILIKE '%'||$1||'%'
           )
         ORDER BY u.created_at DESC
         LIMIT $2`,
        [q, limit]
      ),
      query(
        `SELECT id,name,slug,industry,location,logo_url,verified
         FROM companies
         WHERE name ILIKE '%'||$1||'%'
            OR industry ILIKE '%'||$1||'%'
            OR location ILIKE '%'||$1||'%'
         ORDER BY created_at DESC
         LIMIT $2`,
        [q, limit]
      ),
      query(
        `SELECT
           id,title,description,location,workplace_type,
           company_id,created_at
         FROM job_listings
         WHERE status='open'
           AND (
             title ILIKE '%'||$1||'%'
             OR description ILIKE '%'||$1||'%'
             OR location ILIKE '%'||$1||'%'
           )
         ORDER BY created_at DESC
         LIMIT $2`,
        [q, limit]
      ),
      query(
        `SELECT
           id,title,description,category,listing_type,
           price,currency,location,media_url
         FROM marketplace_listings
         WHERE status='active'
           AND (
             title ILIKE '%'||$1||'%'
             OR description ILIKE '%'||$1||'%'
             OR category ILIKE '%'||$1||'%'
           )
         ORDER BY created_at DESC
         LIMIT $2`,
        [q, limit]
      )
    ]);

    res.json({
      query: q,
      users: users.rows,
      companies: companies.rows,
      jobs: jobs.rows,
      marketplace: marketplace.rows
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Search failed"
    });
  }
});

module.exports = router;
