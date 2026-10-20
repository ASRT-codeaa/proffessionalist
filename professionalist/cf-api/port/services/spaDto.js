const { query } = require("../db");
const { toPerson } = require("./userDto");

/* -------------------------------------------------------------------------- */
/*                             Row → SPA DTO mappers                          */
/*                                                                            */
/*  pg returns BIGINT as a string and dates as Date objects; the SPA wants     */
/*  numbers and ISO strings, so every mapper normalises explicitly rather      */
/*  than leaking storage details into the pages.                              */
/* -------------------------------------------------------------------------- */

function text(value) {
  return value === null || value === undefined ? "" : String(value);
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function strArray(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

/** Location reads as "City, Country" everywhere in the UI. */
function locationExpr(alias) {
  return `CASE
            WHEN COALESCE(${alias}.location, '') = '' THEN COALESCE(${alias}.country, '')
            WHEN COALESCE(${alias}.country, '') = '' THEN ${alias}.location
            ELSE ${alias}.location || ', ' || ${alias}.country
          END`;
}

const PERSON_COLUMNS = `
  u.id::int AS id,
  u.username,
  u.name,
  COALESCE(u.verified, FALSE) AS verified,
  COALESCE(u.verified_badge, '') AS verified_badge,
  pr.first_name,
  pr.last_name,
  COALESCE(pr.job_title, pr.headline, '') AS title,
  COALESCE(pr.company_name, '') AS company,
  ${locationExpr("pr")} AS location,
  COALESCE(pr.avatar_url, '') AS avatar_url,
  COALESCE(pr.category, '') AS category,
  COALESCE((SELECT array_agg(s.name ORDER BY s.name)
              FROM profile_skills ps
              JOIN skills s ON s.id = ps.skill_id
             WHERE ps.user_id = u.id), '{}') AS skills,
  COALESCE(pr.open_to, '{}') AS open_to`;

function statusColumns(viewer) {
  if (!viewer) {
    return `FALSE AS connected, FALSE AS pending_in, FALSE AS pending_out,
            FALSE AS following, 0::int AS mutual_connections`;
  }
  return `
  EXISTS (SELECT 1 FROM conn_edges e WHERE e.a = ${viewer} AND e.b = u.id) AS connected,
  EXISTS (SELECT 1 FROM connections c
           WHERE c.status = 'pending' AND c.requester_id = u.id AND c.recipient_id = ${viewer}) AS pending_in,
  EXISTS (SELECT 1 FROM connections c
           WHERE c.status = 'pending' AND c.requester_id = ${viewer} AND c.recipient_id = u.id) AS pending_out,
  EXISTS (SELECT 1 FROM follows f
           WHERE f.follower_id = ${viewer} AND f.following_id = u.id) AS following,
  COALESCE((SELECT COUNT(*)::int
              FROM conn_edges a
              JOIN conn_edges b ON b.b = a.b
             WHERE a.a = ${viewer}
               AND b.a = u.id
               AND a.b <> ${viewer}
               AND a.b <> u.id), 0) AS mutual_connections`;
}

async function personRows(ids, viewer) {
  const list = [...new Set(ids.map(Number).filter(n => Number.isSafeInteger(n) && n > 0))];
  if (!list.length) return [];
  const params = [list];
  let viewerSql = statusColumns(0);
  if (viewer) {
    params.push(Number(viewer));
    viewerSql = statusColumns(`$2::bigint`);
  }
  const sql = `
    SELECT ${PERSON_COLUMNS}, ${viewerSql}
      FROM users u
      LEFT JOIN profiles pr ON pr.user_id = u.id
     WHERE u.id = ANY($1::bigint[])`;
  const result = await query(sql, params);
  return result.rows;
}

/** id → Person, hydrated in one query for any set of rows. */
async function loadPeople(ids, viewer) {
  const map = new Map();
  for (const row of await personRows(ids, viewer)) {
    const person = toPerson(row);
    person.openTo = strArray(row.open_to);
    map.set(person.id, person);
  }
  return map;
}

const EMPTY_PERSON = {
  id: 0, username: "", firstName: "Someone", lastName: "", title: "", company: "",
  location: "", avatarUrl: "", verified: false, verifiedColor: "", category: "", skills: [],
  mutualConnections: 0, connectionStatus: "none", following: false,
};

function personFrom(map, id) {
  return map.get(num(id)) || EMPTY_PERSON;
}

/* ------------------------------- business ------------------------------- */

function toBusiness(row) {
  return {
    id: num(row.id),
    slug: text(row.slug),
    name: text(row.name),
    industry: text(row.industry),
    category: text(row.category) || text(row.industry),
    tagline: text(row.tagline),
    description: text(row.description),
    website: text(row.website),
    email: text(row.email),
    phone: text(row.phone),
    location: text(row.location),
    logoUrl: text(row.logo_url),
    coverUrl: text(row.cover_url),
    verified: Boolean(row.verified),
    followers: num(row.followers),
    following: Boolean(row.following),
    rating: num(row.rating),
    reviewCount: num(row.review_count),
    listingCount: num(row.listing_count),
    team: [],
  };
}

const BUSINESS_COLUMNS = `
  c.id::int AS id, c.name, c.slug, c.description, c.industry, c.location, c.website,
  c.logo_url, c.cover_url, c.verified,
  COALESCE(c.tagline, '') AS tagline,
  COALESCE(c.email, '') AS email,
  COALESCE(c.phone, '') AS phone,
  COALESCE(c.category, '') AS category,
  COALESCE((SELECT COUNT(*) FROM company_followers cf WHERE cf.company_id = c.id), 0)::int AS followers,
  COALESCE((SELECT COUNT(*) FROM listing_favorites lf
              JOIN marketplace_listings ml ON ml.id = lf.listing_id
             WHERE ml.company_id = c.id), 0)::int AS favourites,
  COALESCE((SELECT ROUND(AVG(r.rating), 1) FROM reviews r
             WHERE r.subject_type = 'company' AND r.subject_id = c.id), 0)::float AS rating,
  COALESCE((SELECT COUNT(*) FROM reviews r
             WHERE r.subject_type = 'company' AND r.subject_id = c.id), 0)::int AS review_count,
  COALESCE((SELECT COUNT(*) FROM marketplace_listings ml
             WHERE ml.company_id = c.id AND ml.status = 'active'), 0)::int AS listing_count`;

/* -------------------------------- posts --------------------------------- */

const POST_COLUMNS = `
  p.id::int AS id,
  p.user_id::int AS user_id,
  p.company_id::int AS company_id,
  p.content,
  p.media,
  p.media_url,
  COALESCE(p.link_url, '') AS link_url,
  p.poll,
  COALESCE(p.hashtags, '{}') AS hashtags,
  COALESCE(p.location, '') AS location,
  p.post_type AS kind,
  p.visibility,
  p.comments_disabled,
  p.scheduled_at,
  p.created_at,
  COALESCE(lc.count, 0)::int AS like_count,
  COALESCE(cc.count, 0)::int AS comment_count,
  COALESCE(sc.count, 0)::int AS share_count,
  pl.reaction AS my_reaction,
  (si.id IS NOT NULL) AS saved`;

/** Accepts a parameter index (4) or its reference ("$4"); anything else means anonymous. */
function viewerRef(viewer) {
  if (viewer === null || viewer === undefined || viewer === false || viewer === "" || viewer === 0) return "NULL";
  const ref = String(viewer);
  return ref.startsWith("$") ? ref : `$${ref}`;
}

function postJoins(viewer) {
  const v = `${viewerRef(viewer)}::bigint`;
  return `
    LEFT JOIN (SELECT post_id, COUNT(*) AS count FROM post_likes GROUP BY post_id) lc ON lc.post_id = p.id
    LEFT JOIN (SELECT post_id, COUNT(*) AS count FROM comments
                WHERE deleted_at IS NULL GROUP BY post_id) cc ON cc.post_id = p.id
    LEFT JOIN (SELECT post_id, COUNT(*) AS count FROM post_shares GROUP BY post_id) sc ON sc.post_id = p.id
    LEFT JOIN post_likes pl ON pl.post_id = p.id AND pl.user_id = ${v}
    LEFT JOIN saved_items si ON si.user_id = ${v} AND si.item_type = 'post' AND si.ref_id = p.id::text`;
}

function pollWithVotes(row, viewerVote) {
  if (!row.poll || typeof row.poll !== "object") return null;
  const options = Array.isArray(row.poll.options) ? row.poll.options : [];
  return {
    question: text(row.poll.question),
    options: options.map((label, i) => ({
      id: i,
      label: text(label),
      votes: num(voteCount(row.poll, i)),
    })),
    endsAt: iso(row.poll.endsAt),
    votedOption: viewerVote === null || viewerVote === undefined ? null : num(viewerVote),
  };
}

function voteCount(poll, index) {
  const votes = poll && poll.votes;
  if (Array.isArray(votes)) return votes[index] || 0;
  if (votes && typeof votes === "object") return votes[index] || votes[String(index)] || 0;
  return 0;
}

function toPost(row, people, businesses, viewerVote) {
  const author = row.company_id ? businesses.get(num(row.company_id)) : null;
  const person = personFrom(people, row.user_id);
  let media = strArray(Array.isArray(row.media) ? row.media : []);
  if (!media.length && text(row.media_url)) media = [row.media_url];
  return {
    id: num(row.id),
    author: author || person,
    authorType: author ? "business" : "user",
    kind: ["post", "job", "product", "service", "article"].includes(row.kind) ? row.kind : "post",
    text: text(row.content),
    media: media.map(url => ({ url, type: /\.(mp4|mov|webm)$/i.test(url) ? "video" : "image" })),
    linkUrl: text(row.link_url),
    linkTitle: "",
    poll: pollWithVotes(row, viewerVote),
    hashtags: strArray(row.hashtags),
    location: text(row.location),
    audience: row.visibility === "connections" ? "connections" : "public",
    commentsDisabled: Boolean(row.comments_disabled),
    scheduledAt: iso(row.scheduled_at),
    likeCount: num(row.like_count),
    commentCount: num(row.comment_count),
    shareCount: num(row.share_count),
    liked: Boolean(row.my_reaction),
    likedReaction: text(row.my_reaction) || null,
    saved: Boolean(row.saved),
    createdAt: iso(row.created_at) || new Date().toISOString(),
  };
}

function toComment(row, people) {
  return {
    id: num(row.id),
    postId: num(row.post_id),
    author: personFrom(people, row.user_id),
    text: text(row.content),
    likeCount: num(row.like_count),
    liked: Boolean(row.liked),
    createdAt: iso(row.created_at) || new Date().toISOString(),
  };
}

/* ------------------------------ marketplace ----------------------------- */

function toListing(row, people, businesses) {
  const images = strArray(row.images).length ? strArray(row.images)
    : text(row.media_url) ? [text(row.media_url)] : [];
  const business = row.company_id ? businesses.get(num(row.company_id)) : null;
  const seller = personFrom(people, row.seller_id);
  const price = num(row.price);
  return {
    id: num(row.id),
    kind: row.listing_type === "service" ? "service" : "product",
    category: row.category_id
      ? { id: num(row.category_id), slug: text(row.category_slug), name: text(row.category_name), icon: text(row.category_icon), count: 0 }
      : null,
    title: text(row.title),
    description: text(row.description),
    price,
    priceType: ["fixed", "hourly", "starting_at", "negotiable", "free"].includes(row.price_type) ? row.price_type : "fixed",
    currency: text(row.currency) || "USD",
    condition: ["new", "like_new", "used", "n/a"].includes(row.condition) ? row.condition : "n/a",
    availability: ["available", "limited", "sold_out"].includes(row.availability) ? row.availability : "available",
    location: text(row.location),
    images,
    tags: strArray(row.tags),
    views: num(row.views),
    favoriteCount: num(row.favorite_count),
    favorited: Boolean(row.favorited),
    status: ["active", "paused", "sold", "removed"].includes(row.status)
      ? (row.status === "closed" || row.status === "archived" || row.status === "draft" ? "paused" : row.status)
      : "active",
    seller: {
      userId: seller.id || undefined,
      businessId: business ? business.id : undefined,
      name: business ? business.name : [seller.firstName, seller.lastName].filter(Boolean).join(" "),
      avatarUrl: business ? business.logoUrl : seller.avatarUrl,
      verified: business ? business.verified : seller.verified,
      rating: num(row.seller_rating),
      reviews: num(row.seller_reviews),
      responseTime: " within a day",
      memberSince: iso(row.seller_created_at) || "",
    },
    details: text(row.summary) ? [{ label: "Summary", value: text(row.summary) }] : [],
    createdAt: iso(row.created_at) || new Date().toISOString(),
  };
}

const LISTING_COLUMNS = `
  m.id::int AS id,
  m.seller_id::int AS seller_id,
  m.company_id::int AS company_id,
  m.title, m.description, m.media_url, m.status, m.listing_type,
  m.price, m.currency, m.location,
  COALESCE(m.images, '{}') AS images,
  COALESCE(m.tags, '{}') AS tags,
  COALESCE(m.views, 0)::int AS views,
  COALESCE(m.price_type, 'fixed') AS price_type,
  COALESCE(m.condition, 'n/a') AS condition,
  COALESCE(m.availability, 'available') AS availability,
  COALESCE(m.summary, '') AS summary,
  m.category_id::int AS category_id,
  lc.name AS category_name, lc.slug AS category_slug, COALESCE(lc.icon, 'Package') AS category_icon,
  COALESCE((SELECT COUNT(*) FROM listing_favorites lf WHERE lf.listing_id = m.id), 0)::int AS favorite_count,
  (lf.user_id IS NOT NULL) AS favorited,
  COALESCE((SELECT ROUND(AVG(r.rating), 1) FROM reviews r
             WHERE r.subject_type = 'user' AND r.subject_id = m.seller_id), 0)::float AS seller_rating,
  COALESCE((SELECT COUNT(*) FROM reviews r
             WHERE r.subject_type = 'user' AND r.subject_id = m.seller_id), 0)::int AS seller_reviews,
  su.created_at AS seller_created_at,
  m.created_at`;

function listingJoins(viewer) {
  const v = `${viewerRef(viewer)}::bigint`;
  return `
    LEFT JOIN listing_categories lc ON lc.id = m.category_id
    LEFT JOIN listing_favorites lf ON lf.listing_id = m.id AND lf.user_id = ${v}
    LEFT JOIN users su ON su.id = m.seller_id`;
}

/* ------------------------------- messaging ------------------------------ */

function toConversation(row, people, viewerId) {
  // chat.js names the other member peer_id; the requester/recipient pair stays as
  // the fallback for callers that read a raw conversation row.
  const peerId =
    num(row.peer_id) ||
    (num(row.requester_id) === num(viewerId) ? num(row.recipient_id) : num(row.requester_id));

  return {
    id: text(row.id),
    subject: text(row.subject) || "Conversation",
    participant: personFrom(people, peerId),
    lastMessage: text(row.last_message),
    lastMessageAt:
      iso(row.last_message_at) || iso(row.created_at) || iso(row.conversation_created_at) || new Date().toISOString(),
    unreadCount: num(row.unread_count),
    online: false,
  };
}

function toMessage(row, viewerId) {
  return {
    id: num(row.id),
    conversationId: text(row.conversation_id),
    senderId: num(row.sender_id),
    fromMe: num(row.sender_id) === num(viewerId),
    text: text(row.body),
    mediaUrl: text(row.attachment_url),
    attachmentName: text(row.attachment_name),
    reaction: text(row.reaction),
    read: Boolean(row.read),
    createdAt: iso(row.created_at) || new Date().toISOString(),
  };
}

/* ----------------------------- notifications ---------------------------- */

const NOTIFICATION_CATEGORY = {
  connection: "connection", connection_request: "connection", connection_accepted: "connection",
  message: "message", like: "like", comment: "comment", mention: "mention",
  share: "mention", follow: "connection", sale: "marketplace", listing: "marketplace",
  review: "marketplace", task: "task", system: "system", welcome: "system",
};

function notificationHref(row) {
  const entity = text(row.entity_type);
  const id = text(row.entity_id);
  if (entity === "post") return `/post/${id}`;
  if (entity === "listing") return `/marketplace/${id}`;
  if (entity === "conversation") return `/messages/${id}`;
  if (entity === "user") return `/profile/${id}`;
  if (entity === "comment") return `/post/${id}`;
  return "/notifications";
}

function toNotification(row, people) {
  return {
    id: num(row.id),
    category: NOTIFICATION_CATEGORY[text(row.type)] || "system",
    actor: row.actor_id ? personFrom(people, row.actor_id) : null,
    text: text(row.title),
    href: text(row.href) || notificationHref(row),
    read: Boolean(row.read_at),
    createdAt: iso(row.created_at) || new Date().toISOString(),
  };
}

/* --------------------------------- misc --------------------------------- */

function toTask(row, people) {
  return {
    id: num(row.id),
    title: text(row.title),
    description: text(row.description),
    dueDate: iso(row.due_date),
    priority: ["low", "medium", "high"].includes(row.priority) ? row.priority : "medium",
    category: text(row.category),
    status: ["todo", "in_progress", "done"].includes(row.status) ? row.status : "todo",
    assignee: row.assignee_id ? personFrom(people, row.assignee_id) : null,
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at) || new Date().toISOString(),
  };
}

function toOpportunity(row) {
  const kind = ["job", "freelance", "partnership", "business", "event", "project"].includes(row.opportunity_kind)
    ? row.opportunity_kind
    : "job";
  const low = row.salary_min === null || row.salary_min === undefined ? "" : Number(row.salary_min).toLocaleString("en-US");
  const high = row.salary_max === null || row.salary_max === undefined ? "" : Number(row.salary_max).toLocaleString("en-US");
  const compensation = text(row.compensation) || (low || high
    ? `${row.currency || "USD"} ${low}${high ? ` – ${high}` : ""}`
    : "Not disclosed");
  return {
    id: num(row.id),
    title: text(row.title),
    kind,
    organization: text(row.organization) || text(row.company_name) || "Independent",
    organizationLogo: text(row.organization_logo) || text(row.company_logo),
    location: text(row.location) || "Remote",
    remote: Boolean(row.remote) || text(row.workplace_type) === "remote",
    description: text(row.description),
    compensation,
    deadline: iso(row.application_deadline),
    applied: Boolean(row.applied),
    createdAt: iso(row.created_at) || new Date().toISOString(),
  };
}

function toReview(row, people) {
  return {
    id: num(row.id),
    author: row.author_id ? personFrom(people, row.author_id) : EMPTY_PERSON,
    rating: num(row.rating),
    text: text(row.body),
    createdAt: iso(row.created_at) || new Date().toISOString(),
  };
}

function toSavedItem(row) {
  const href = text(row.href) || (text(row.item_type) === "post" ? `/post/${text(row.ref_id)}` : `/marketplace/${text(row.ref_id)}`);
  return {
    id: num(row.id),
    itemType: ["post", "product", "person", "business", "service", "opportunity"].includes(row.item_type) ? row.item_type : "post",
    collection: text(row.collection) || "Saved posts",
    title: text(row.title),
    subtitle: text(row.subtitle),
    imageUrl: text(row.image_url),
    href,
    savedAt: iso(row.saved_at) || new Date().toISOString(),
  };
}

function toCampaign(row) {
  const metrics = row.metrics && typeof row.metrics === "object" ? row.metrics : {};
  return {
    id: num(row.id),
    name: text(row.name),
    objective: text(row.objective) || "awareness",
    audience: row.audience && typeof row.audience === "object"
      ? {
          industries: strArray(row.audience.industries),
          locations: strArray(row.audience.locations),
          ageRange: text(row.audience.ageRange),
          interests: strArray(row.audience.interests),
        }
      : { industries: [], locations: [], ageRange: "", interests: [] },
    budget: num(row.budget),
    spend: num(row.spend),
    startDate: text(row.start_date),
    endDate: text(row.end_date),
    format: text(row.format) || "feed",
    creativeUrl: text(row.creative_url),
    creativeText: text(row.creative_text),
    destination: text(row.destination),
    status: ["draft", "active", "paused", "completed"].includes(row.status) ? row.status : "draft",
    metrics: {
      impressions: num(metrics.impressions),
      clicks: num(metrics.clicks),
      engagement: num(metrics.engagement),
      conversions: num(metrics.conversions),
    },
    daily: [],
  };
}

function toTicket(row, messages) {
  return {
    id: num(row.id),
    subject: text(row.subject),
    category: text(row.category),
    status: ["open", "pending", "resolved"].includes(row.status) ? row.status : "open",
    updatedAt: iso(row.updated_at) || new Date().toISOString(),
    messages: (messages || []).map(m => ({
      id: num(m.id),
      fromUser: Boolean(m.from_user),
      text: text(m.body),
      attachmentUrl: text(m.attachment_url),
      createdAt: iso(m.created_at) || new Date().toISOString(),
    })),
  };
}

function toAiConversation(row, messages) {
  return {
    id: num(row.id),
    title: text(row.title),
    updatedAt: iso(row.updated_at) || new Date().toISOString(),
    messages: (messages || []).map(m => ({
      id: num(m.id),
      role: m.role === "assistant" ? "assistant" : "user",
      text: text(m.body),
      createdAt: iso(m.created_at) || new Date().toISOString(),
    })),
  };
}

function paginate(items, total, page, pageSize) {
  return {
    items,
    total: num(total),
    page: num(page, 1),
    pageSize: num(pageSize, items.length),
    hasMore: num(page, 1) * num(pageSize, items.length) < num(total),
  };
}

/** Read page/pageSize out of a query string the way the SPA sends it. */
function paging(req, defaults = {}) {
  const page = Math.max(1, num(req.query.page, defaults.page || 1));
  const pageSize = Math.min(60, Math.max(1, num(req.query.pageSize, defaults.pageSize || 10)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

module.exports = {
  text, num, iso, strArray, locationExpr,
  PERSON_COLUMNS, statusColumns, personRows, loadPeople, personFrom, EMPTY_PERSON,
  BUSINESS_COLUMNS, toBusiness,
  POST_COLUMNS, postJoins, toPost, toComment, pollWithVotes, voteCount,
  LISTING_COLUMNS, listingJoins, toListing,
  toConversation, toMessage, toNotification, notificationHref,
  toTask, toOpportunity, toReview, toSavedItem, toCampaign, toTicket, toAiConversation,
  paginate, paging,
};
