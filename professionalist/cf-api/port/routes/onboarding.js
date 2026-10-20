const express = require("../_shim/express.js");
const path = require("path");
const { pool, query } = require("../db");
const { uploadImage, publicUrl, removeStored } = require("../middleware/upload");
const { loadAuthUser } = require("../services/userDto");

const router = express.Router();


function uidOf(req) {
  return Number(req.user.sub);
}

function invalid(res, fields, message) {
  return res.status(400).json({
    error: { code: "validation_error", message: message || "Please fix the highlighted fields", fields },
  });
}

function failure(res, error) {
  console.error("Onboarding error:", error);
  return res.status(error.status || 500).json({
    error: { code: "api_error", message: error.status ? error.message : "Unable to save your profile" },
  });
}

/** Trim + clamp. Returns null when the client didn't send the key at all. */
function optionalText(body, key, max) {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return null;
  return String(body[key] === null || body[key] === undefined ? "" : body[key]).trim().slice(0, max);
}

function optionalList(body, key, maxItems, maxLength) {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return null;
  if (!Array.isArray(body[key])) return [];
  return body[key]
    .map(v => String(v === null || v === undefined ? "" : v).replace(/\s+/g, " ").trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function safeMediaUrl(value) {
  if (!value) return true;
  return /^\/uploads\/[\w./-]+$/.test(value) || /^https?:\/\/[^\s]+$/i.test(value);
}

/* -------------------------------------------------------------------------- */
/*                          Photo:  POST /api/onboarding/avatar                */
/* -------------------------------------------------------------------------- */

router.post("/avatar", uploadImage("avatar"), async (req, res) => {
  try {
    if (!req.file) {
      return invalid(res, { file: "Choose an image to upload" }, "No file received");
    }

    const uid = uidOf(req);
    const url = publicUrl("avatar", req.file.filename);

    const previous = await query(`SELECT avatar_url FROM profiles WHERE user_id = $1`, [uid]);
    const old = previous.rows[0] && previous.rows[0].avatar_url;

    await query(
      `INSERT INTO profiles (user_id, avatar_url)
       VALUES ($1, $2)
       ON CONFLICT (user_id)
       DO UPDATE SET avatar_url = EXCLUDED.avatar_url, updated_at = NOW()`,
      [uid, url]
    );

    if (old && old.startsWith("/uploads/avatars/")) {
      removeStored(old, { ctx: req.ctx });
    }

    res.json({ url });
  } catch (error) {
    failure(res, error);
  }
});

/* -------------------------------------------------------------------------- */
/*                        Save:  PUT /api/onboarding                           */
/* -------------------------------------------------------------------------- */

router.put("/", async (req, res) => {
  const uid = uidOf(req);
  const body = req.body || {};

  const title = optionalText(body, "title", 180);
  const company = optionalText(body, "company", 180);
  const bio = optionalText(body, "bio", 2000);
  const website = optionalText(body, "website", 255);
  const location = optionalText(body, "location", 180);
  const country = optionalText(body, "country", 120);
  const category = optionalText(body, "category", 120);
  const avatarUrl = optionalText(body, "avatarUrl", 2000);
  const coverUrl = optionalText(body, "coverUrl", 2000);
  const skills = optionalList(body, "skills", 20, 100);
  const interests = optionalList(body, "interests", 40, 60);

  const finishing = body.onboardingDone === true;
  const onboardingDone = Object.prototype.hasOwnProperty.call(body, "onboardingDone")
    ? Boolean(body.onboardingDone)
    : null;

  const fields = {};
  const finishingNeedsTitle = finishing && !(title || "").trim();
  let storedTitle = "";

  if (finishingNeedsTitle) {
    // A partial save can flag the wizard as done without re-sending the title,
    // so honour what is already stored before rejecting it.
    const existing = await query(
      `SELECT COALESCE(job_title, headline) AS title FROM profiles WHERE user_id = $1`,
      [uid]
    );
    storedTitle = (existing.rows[0] && existing.rows[0].title) || "";
  }

  if (finishingNeedsTitle && !storedTitle) fields.title = "Add your professional title";
  if (bio && bio.length > 2000) fields.bio = "Your bio is too long";
  if (website && !/^https?:\/\//i.test(website)) fields.website = "Website must start with http:// or https://";
  if (avatarUrl && !safeMediaUrl(avatarUrl)) fields.avatarUrl = "Upload the photo first, or paste a full image URL";
  if (coverUrl && !safeMediaUrl(coverUrl)) fields.coverUrl = "Upload the image first, or paste a full image URL";

  if (Object.keys(fields).length) {
    return invalid(res, fields, "Some details need attention");
  }

  let followIds = [];
  if (Array.isArray(body.followUserIds)) {
    followIds = [...new Set(body.followUserIds.map(Number).filter(n => Number.isSafeInteger(n) && n > 0 && n !== uid))].slice(0, 60);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO profiles
         (user_id, job_title, headline, company_name, bio, website, location,
          country, category, avatar_url, cover_url, interests, onboarding_done, visibility)
       VALUES
         ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::text[],'{}'),COALESCE($12,FALSE),'public')
       ON CONFLICT (user_id) DO UPDATE SET
         job_title = COALESCE($2, profiles.job_title),
         headline = COALESCE($2, profiles.headline),
         company_name = COALESCE($3, profiles.company_name),
         bio = COALESCE($4, profiles.bio),
         website = CASE WHEN $5::text IS NULL THEN profiles.website ELSE $5::text END,
         location = CASE WHEN $6::text IS NULL THEN profiles.location ELSE $6::text END,
         country = COALESCE($7, profiles.country),
         category = COALESCE($8, profiles.category),
         avatar_url = CASE WHEN $9::text IS NULL THEN profiles.avatar_url ELSE $9::text END,
         cover_url = CASE WHEN $10::text IS NULL THEN profiles.cover_url ELSE $10::text END,
         interests = COALESCE($11::text[], profiles.interests),
         onboarding_done = COALESCE($12, profiles.onboarding_done),
         updated_at = NOW()`,
      [
        uid, title, company, bio, website, location, country, category,
        avatarUrl, coverUrl, interests, onboardingDone,
      ]
    );

    if (skills) {
      await client.query(`DELETE FROM profile_skills WHERE user_id = $1`, [uid]);

      for (const name of skills) {
        const skill = await client.query(
          `INSERT INTO skills (name) VALUES ($1)
           ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [name]
        );
        await client.query(
          `INSERT INTO profile_skills (user_id, skill_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [uid, skill.rows[0].id]
        );
      }
    }

    if (followIds.length) {
      await client.query(
        `INSERT INTO follows (follower_id, following_id)
         SELECT $1, u.id
           FROM unnest($2::bigint[]) AS candidate(id)
           JOIN users u ON u.id = candidate.id
          WHERE u.status = 'active'
            AND u.id <> $1
            AND NOT EXISTS (
              SELECT 1 FROM blocks b
               WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                  OR (b.blocker_id = u.id AND b.blocked_id = $1)
            )
         ON CONFLICT DO NOTHING`,
        [uid, followIds]
      );
    }

    await client.query("COMMIT");

    res.json(await loadAuthUser(uid));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    failure(res, error);
  } finally {
    client.release();
  }
});

module.exports = router;
