const { query } = require("../db");

/**
 * Builds the AuthUser DTO the SPA expects (src/services/types.ts) from the
 * account row plus everything hanging off the profile tables.
 */

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
}

function text(value) {
  return value === null || value === undefined ? "" : String(value);
}

async function loadAuthUser(userId) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) return null;

  const account = await query(
    `SELECT id::int AS id, username, email, name, role, account_type,
            COALESCE(verified, FALSE) AS verified,
            COALESCE(verified_badge, '') AS verified_badge
       FROM users
      WHERE id = $1`,
    [uid]
  );

  if (!account.rowCount) return null;

  const user = account.rows[0];

  const [profileRow, skillRows, experienceRows, educationRows] = await Promise.all([
    query(
      `SELECT first_name, last_name, headline, bio, location, website,
              avatar_url, cover_url, phone, company_name, job_title,
              visibility, country, category, interests, onboarding_done
         FROM profiles
        WHERE user_id = $1`,
      [uid]
    ),
    query(
      `SELECT s.name
         FROM profile_skills ps
         JOIN skills s ON s.id = ps.skill_id
        WHERE ps.user_id = $1
        ORDER BY s.name`,
      [uid]
    ),
    query(
      `SELECT id::int AS id, company_name, title, location, description,
              to_char(start_date, 'YYYY-MM-DD') AS start_date,
              to_char(end_date, 'YYYY-MM-DD') AS end_date
         FROM experiences
        WHERE user_id = $1
        ORDER BY is_current_role DESC, start_date DESC NULLS LAST, id DESC`,
      [uid]
    ),
    query(
      `SELECT id::int AS id, institution, qualification, field_of_study,
              to_char(start_date, 'YYYY-MM-DD') AS start_date,
              to_char(end_date, 'YYYY-MM-DD') AS end_date
         FROM education
        WHERE user_id = $1
        ORDER BY end_date DESC NULLS LAST, id DESC`,
      [uid]
    ),
  ]);

  const p = profileRow.rows[0] || null;
  const fromName = splitName(user.name);

  return {
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: text(p && p.first_name) || fromName.firstName,
    lastName: text(p && p.last_name) || fromName.lastName,
    role: user.role,
    verified: Boolean(user.verified),
    verifiedColor: user.verified ? text(user.verified_badge) : "",
    accountType: user.account_type || "individual",
    profile: {
      userId: user.id,
      bio: text(p && p.bio),
      title: text(p && p.job_title) || text(p && p.headline),
      company: text(p && p.company_name),
      website: text(p && p.website),
      phone: text(p && p.phone),
      location: text(p && p.location),
      country: text(p && p.country),
      category: text(p && p.category),
      avatarUrl: text(p && p.avatar_url),
      coverUrl: text(p && p.cover_url),
      skills: skillRows.rows.map(r => r.name),
      interests: Array.isArray(p && p.interests) ? p.interests : [],
      experience: experienceRows.rows.map(r => ({
        id: String(r.id),
        role: text(r.title),
        company: text(r.company_name),
        location: text(r.location),
        start: text(r.start_date),
        end: text(r.end_date),
        description: text(r.description),
      })),
      education: educationRows.rows.map(r => ({
        id: String(r.id),
        school: text(r.institution),
        degree: text(r.qualification),
        field: text(r.field_of_study),
        start: text(r.start_date),
        end: text(r.end_date),
      })),
      certifications: [],
      portfolio: [],
      onboardingDone: Boolean(p && p.onboarding_done),
      visibility:
        p && ["public", "connections", "private"].includes(p.visibility)
          ? p.visibility
          : "public",
    },
  };
}

/** Person DTO (src/services/types.ts) from a joined users/profiles row. */
function toPerson(row) {
  const fromName = splitName(row.name);
  return {
    id: Number(row.id),
    username: row.username,
    firstName: text(row.first_name) || fromName.firstName,
    lastName: text(row.last_name) || fromName.lastName,
    title: text(row.title),
    company: text(row.company),
    location: text(row.location),
    avatarUrl: text(row.avatar_url),
    verified: Boolean(row.verified),
    verifiedColor: row.verified ? text(row.verified_badge) : "",
    category: text(row.category),
    skills: Array.isArray(row.skills) ? row.skills : [],
    mutualConnections: Number(row.mutual_connections) || 0,
    connectionStatus: row.connected
      ? "connected"
      : row.pending_in
        ? "pending_in"
        : row.pending_out
          ? "pending_out"
          : "none",
    following: Boolean(row.following),
  };
}

module.exports = { loadAuthUser, toPerson, splitName, text };
