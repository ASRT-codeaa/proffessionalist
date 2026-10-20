const express = require("express");
const { query } = require("../../db");
const dto = require("../../services/spaDto");
const kit = require("../../services/spaKit");
const videos = require("../../services/videoKit");
const { uploadFiles, publicUrl, mediaType } = require("../../middleware/upload");

const router = express.Router();

const {
  handle, builder, invalid, missing, toId, uid, str, list, num,
  isStoredMedia, paging, businessesFor, isStaff, notify, KINDS,
} = kit;

/* -------------------------------------------------------------------------- */
/*                                    posts                                   */
/* -------------------------------------------------------------------------- */

async function hydratePosts(rows, viewer) {
  if (!rows.length) return [];
  const postIds = rows.map(r => r.id);

  const jobs = [
    dto.loadPeople(rows.map(r => r.user_id), viewer),
    businessesFor(rows, viewer),
  ];
  const withPolls = rows.filter(r => r.poll);
  if (withPolls.length) {
    jobs.push(query(
      `SELECT post_id::int AS post_id, option_id::int AS option_id, COUNT(*)::int AS votes
         FROM poll_votes WHERE post_id = ANY($1::bigint[])
        GROUP BY post_id, option_id`,
      [postIds]
    ));
    jobs.push(query(
      `SELECT post_id::int AS post_id, option_id::int AS option_id
         FROM poll_votes WHERE user_id = $1 AND post_id = ANY($2::bigint[])`,
      [viewer, postIds]
    ));
  }

  const [people, businesses, tallies, myVotes] = await Promise.all(jobs);

  const countsByPost = new Map();
  const choiceByPost = new Map((myVotes ? myVotes.rows : []).map(v => [v.post_id, v.option_id]));
  for (const t of (tallies ? tallies.rows : [])) {
    if (!countsByPost.has(t.post_id)) countsByPost.set(t.post_id, []);
    countsByPost.get(t.post_id)[t.option_id] = t.votes;
  }

  return rows.map(row => {
    if (row.poll && typeof row.poll === "object") {
      const options = Array.isArray(row.poll.options) ? row.poll.options : [];
      const counts = countsByPost.get(row.id) || [];
      row = Object.assign({}, row, {
        poll: Object.assign({}, row.poll, {
          votes: options.map((_, i) => num(counts[i])),
        }),
      });
    }
    return dto.toPost(row, people, businesses, choiceByPost.has(row.id) ? choiceByPost.get(row.id) : null);
  });
}

function visibleClause(mine) {
  return `(p.visibility = 'public' OR p.user_id = ${mine}
            OR (p.visibility = 'connections'
                AND EXISTS (SELECT 1 FROM conn_edges e WHERE e.a = ${mine} AND e.b = p.user_id)))`;
}

router.get("/posts/feed", handle(async (req, res) => {
  const me = uid(req);
  const { pageSize, offset } = paging(req, 10);
  const page = req.query.page || 1;
  const sort = req.query.sort === "popular" ? "popular" : "recent";
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  const hashtag = str(req.query.hashtag, 60).replace(/^#/, "").toLowerCase();
  const author = str(req.query.author, 50).toLowerCase();

  const b = builder();
  const mine = b.add(me);
  const where = [`p.deleted_at IS NULL`, `p.scheduled_at IS NULL`, `u.status = 'active'`, visibleClause(mine)];
  /* scope=following narrows the timeline to the authors the viewer follows — the same
     follows table the videos "following" tab reads, so one graph answers both surfaces. */
  if (str(req.query.scope, 20) === "following") {
    where.push(`EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ${mine} AND fo.following_id = p.user_id)`);
  }
  /* the viewer's safety list, honoured here and in the videos ranking (videoKit PUBLIC_CLAUSE):
     muted creators vanish one-way; a block vanishes both ways. */
  where.push(`NOT EXISTS (SELECT 1 FROM mutes mu WHERE mu.user_id = ${mine} AND mu.muted_id = p.user_id)`);
  where.push(`NOT EXISTS (SELECT 1 FROM blocks bl
    WHERE (bl.blocker_id = ${mine} AND bl.blocked_id = p.user_id)
       OR (bl.blocker_id = p.user_id AND bl.blocked_id = ${mine}))`);
  if (kind) where.push(`p.post_type = ${b.add(kind)}`);
  if (hashtag) where.push(`EXISTS (SELECT 1 FROM json_each(COALESCE(p.hashtags, '[]')) AS jt WHERE LOWER(jt.value) = ${b.add(hashtag)})`);
  if (author) where.push(`LOWER(u.username) = ${b.add(author)}`);
  const clause = where.join(" AND ");

  const total = await query(
    `SELECT COUNT(*)::int AS total FROM posts p JOIN users u ON u.id = p.user_id WHERE ${clause}`,
    b.params
  );

  const order = sort === "popular"
    ? `(SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) DESC, p.created_at DESC`
    : `p.created_at DESC`;

  const viewerParam = b.add(me);
  const limitParam = b.add(pageSize);
  const offsetParam = b.add(offset);

  const rows = await query(
    `SELECT ${dto.POST_COLUMNS}
       FROM posts p
       JOIN users u ON u.id = p.user_id
       ${dto.postJoins(viewerParam)}
      WHERE ${clause}
      ORDER BY ${order}
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    b.params
  );

  res.json(dto.paginate(await hydratePosts(rows.rows, me), total.rows[0].total, page, pageSize));
}));

async function loadPostRow(id, viewer) {
  const result = await query(
    `SELECT ${dto.POST_COLUMNS}
       FROM posts p
       JOIN users u ON u.id = p.user_id
       ${dto.postJoins("$1")}
      WHERE p.id = $2 AND p.deleted_at IS NULL`,
    [viewer, id]
  );
  return result.rows[0] || null;
}

router.get("/posts/author/:username", handle(async (req, res) => {
  const me = uid(req);
  const { pageSize, offset } = paging(req, 10);
  const username = str(req.params.username, 50).toLowerCase();

  const account = await query(`SELECT id::int AS id FROM users WHERE LOWER(username) = $1`, [username]);
  if (!account.rowCount) return res.json(dto.paginate([], 0, req.query.page || 1, pageSize));

  const target = account.rows[0].id;
  const rows = await query(
    `SELECT ${dto.POST_COLUMNS}
       FROM posts p
       JOIN users u ON u.id = p.user_id
       ${dto.postJoins("$1")}
      WHERE p.user_id = $2 AND p.deleted_at IS NULL AND p.scheduled_at IS NULL
        AND ${visibleClause("$1")}
      ORDER BY p.created_at DESC
      LIMIT $3 OFFSET $4`,
    [me, target, pageSize, offset]
  );
  const total = await query(
    `SELECT COUNT(*)::int AS total FROM posts
      WHERE user_id = $1 AND deleted_at IS NULL AND scheduled_at IS NULL`,
    [target]
  );

  res.json(dto.paginate(await hydratePosts(rows.rows, me), total.rows[0].total, req.query.page || 1, pageSize));
}));

router.post("/posts/media", uploadFiles("post", "files", 8), handle(async (req, res) => {
  const files = req.files || [];
  if (!files.length) return invalid(res, { files: "Choose at least one file" });
  res.json({
    urls: files.map(f => ({
      url: publicUrl("post", f.filename),
      type: mediaType(f.mimetype),
      name: f.originalname ? str(f.originalname, 200) : "attachment",
    })),
  });
}));

router.post("/posts", handle(async (req, res) => {
  const me = uid(req);
  const body = req.body || {};
  const content = str(body.text === undefined ? body.content : body.text, 5000);
  const mediaUrls = (Array.isArray(body.media) ? body.media : [])
    .map(m => (typeof m === "string" ? m : str(m && m.url, 500)))
    .filter(isStoredMedia);
  const pollOptions = list(body.poll && body.poll.options, 10);
  const poll = body.poll && str(body.poll.question, 300) && pollOptions.length >= 2
    ? { question: str(body.poll.question, 300), options: pollOptions, endsAt: body.poll.endsAt || null }
    : null;

  if (!content && !mediaUrls.length && !poll && !body.listingId) {
    return invalid(res, { text: "Write something or attach media first" });
  }

  const postKind = KINDS.includes(body.kind) ? body.kind : "post";
  const visibility = body.audience === "connections" ? "connections" : "public";
  const created = await query(
    `INSERT INTO posts (user_id, content, media, media_url, post_type, visibility, link_url, poll,
                        hashtags, location, comments_disabled, scheduled_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::timestamptz)
     RETURNING id`,
    [me, content || " ", JSON.stringify(mediaUrls), mediaUrls[0] || null,
      postKind, visibility,
      str(body.linkUrl, 500) || null,
      poll ? JSON.stringify(poll) : null,
      list(body.hashtags, 20).map(t => t.replace(/^#/, "").toLowerCase()),
      str(body.location, 180) || null,
      Boolean(body.commentsDisabled),
      body.scheduledAt ? new Date(body.scheduledAt).toISOString() : null]
  );

  const postId = created.rows[0].id;

  /*  Auto-enrol a plain public post that IS a video (an mp4 attachment) or LINKS to one
   *  (a gate-approved provider URL) into the videos index so /videos can show it — as
   *  pending: nothing reaches the videos feed without staff approving it in the video
   *  console first, even though the post itself is already public in the normal feed.
   *  Listing kinds, connections-only posts and scheduled posts stay out — they are not
   *  public timeline content yet.  Engagement never moves: it stays on the posts row,
   *  which is what the videos feed reads through p.
   *  Failures are swallowed here (the post is committed); the backfill tool re-enrols
   *  anything missed with this same classifier. */
  if (postKind === "post" && visibility === "public" && !body.scheduledAt) {
    try {
      const asVideo = videos.fromPostRow({
        media: mediaUrls,
        media_url: mediaUrls[0] || null,
        link_url: str(body.linkUrl, 500) || null,
      });
      if (asVideo) {
        const clash = await query(
          `SELECT id FROM videos WHERE canonical_url = $1 OR post_id = $2 LIMIT 1`,
          [asVideo.canonicalUrl, postId]
        );
        if (!clash.rows.length) {
          await query(
            `INSERT INTO videos (post_id, kind, provider, canonical_url, media_key, embed_url,
                                thumbnail_key, topic_ids, moderation_state, availability)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'[]','pending','ok')`,
            [postId, asVideo.kind, asVideo.provider, asVideo.canonicalUrl, asVideo.mediaKey,
              asVideo.embedUrl, asVideo.thumbnailKey]
          );
        }
      }
    } catch { /* not enrolment-critical */ }
  }

  const row = await loadPostRow(postId, me);
  const [post] = await hydratePosts([row], me);
  res.status(201).json(post);
}));

router.get("/posts/:id", handle(async (req, res) => {
  const me = uid(req);
  const row = await loadPostRow(toId(req.params.id), me);
  if (!row) return missing(res, "Post");
  const [post] = await hydratePosts([row], me);
  res.json(post);
}));

router.delete("/posts/:id", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const result = isStaff(req)
    ? await query(`UPDATE posts SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id])
    : await query(`UPDATE posts SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`, [id, me]);
  if (!result.rowCount) return missing(res, "Post");
  res.json({ ok: true });
}));

router.post("/posts/:id/like", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const reaction = str(req.body && req.body.reaction, 20);

  const post = await query(`SELECT id, user_id::int AS user_id FROM posts WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!post.rowCount) return missing(res, "Post");

  const existing = await query(`SELECT reaction FROM post_likes WHERE post_id = $1 AND user_id = $2`, [id, me]);

  if (existing.rowCount && !reaction) {
    await query(`DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2`, [id, me]);
  } else if (existing.rowCount) {
    await query(`UPDATE post_likes SET reaction = $1 WHERE post_id = $2 AND user_id = $3`, [reaction, id, me]);
  } else {
    await query(
      `INSERT INTO post_likes (post_id, user_id, reaction) VALUES ($1,$2,$3)
       ON CONFLICT (post_id, user_id) DO NOTHING`,
      [id, me, reaction || "like"]
    );
    await notify({
      userId: post.rows[0].user_id, actorId: me, type: "like",
      title: "Someone liked your post", entityType: "post", entityId: id, href: `/post/${id}`,
    });
  }

  const count = await query(`SELECT COUNT(*)::int AS total FROM post_likes WHERE post_id = $1`, [id]);
  const previous = existing.rowCount ? existing.rows[0].reaction : null;
  const finalReaction = existing.rowCount && !reaction ? null : (reaction || previous || "like");
  res.json({ liked: Boolean(finalReaction), likeCount: count.rows[0].total, reaction: finalReaction });
}));

router.post("/posts/:id/poll", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const optionId = Number(req.body && req.body.optionId);
  if (!Number.isSafeInteger(optionId) || optionId < 0) return invalid(res, { optionId: "Pick an option" });

  const row = await loadPostRow(id, me);
  if (!row) return missing(res, "Post");
  if (!row.poll) return invalid(res, { optionId: "This post has no poll" });

  await query(
    `INSERT INTO poll_votes (post_id, user_id, option_id) VALUES ($1,$2,$3)
     ON CONFLICT (post_id, user_id) DO UPDATE SET option_id = EXCLUDED.option_id`,
    [id, me, optionId]
  );

  const [post] = await hydratePosts([row], me);
  res.json({ poll: post.poll });
}));

router.get("/posts/:id/comments", handle(async (req, res) => {
  const me = uid(req);
  const rows = await query(
    `SELECT c.id::int AS id, c.post_id::int AS post_id, c.user_id::int AS user_id, c.content, c.created_at,
            COALESCE(cl.count, 0)::int AS like_count,
            (clike.user_id IS NOT NULL) AS liked
       FROM comments c
       LEFT JOIN (SELECT comment_id, COUNT(*) AS count FROM comment_likes GROUP BY comment_id) cl ON cl.comment_id = c.id
       LEFT JOIN comment_likes clike ON clike.comment_id = c.id AND clike.user_id = $1
      WHERE c.post_id = $2 AND c.deleted_at IS NULL
      ORDER BY c.created_at ASC
      LIMIT 200`,
    [me, toId(req.params.id)]
  );
  const people = await dto.loadPeople(rows.rows.map(r => r.user_id), me);
  res.json(rows.rows.map(r => dto.toComment(r, people)));
}));

router.post("/posts/:id/comments", handle(async (req, res) => {
  const me = uid(req);
  const postId = toId(req.params.id);
  const body = req.body || {};
  const text = str(body.text === undefined ? body.content : body.text, 2000);
  if (!text) return invalid(res, { text: "Write a comment first" });

  const post = await query(`SELECT id, user_id::int AS user_id FROM posts WHERE id = $1 AND deleted_at IS NULL`, [postId]);
  if (!post.rowCount) return missing(res, "Post");

  const created = await query(
    `INSERT INTO comments (post_id, user_id, content) VALUES ($1,$2,$3)
     RETURNING id::int AS id, post_id::int AS post_id, user_id::int AS user_id, content, created_at`,
    [postId, me, text]
  );
  await notify({
    userId: post.rows[0].user_id, actorId: me, type: "comment",
    title: "Someone commented on your post", body: text.slice(0, 140),
    entityType: "post", entityId: postId, href: `/post/${postId}`,
  });

  const people = await dto.loadPeople([me], me);
  res.status(201).json(dto.toComment(Object.assign(created.rows[0], { like_count: 0, liked: false }), people));
}));

router.delete("/posts/comments/:id", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const result = isStaff(req)
    ? await query(`UPDATE comments SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id])
    : await query(
        `UPDATE comments SET deleted_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL
            AND (user_id = $2 OR EXISTS (SELECT 1 FROM posts p WHERE p.id = comments.post_id AND p.user_id = $2))
          RETURNING id`,
        [id, me]
      );
  if (!result.rowCount) return missing(res, "Comment");
  res.json({ ok: true });
}));

router.post("/posts/:id/share", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const note = str((req.body || {}).note, 2000);

  const post = await query(`SELECT id FROM posts WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!post.rowCount) return missing(res, "Post");

  await query(`INSERT INTO post_shares (post_id, user_id) VALUES ($1,$2) ON CONFLICT (post_id, user_id) DO NOTHING`, [id, me]);
  if (note) {
    await query(`INSERT INTO posts (user_id, content, post_type, visibility, source_post_id)
                 VALUES ($1,$2,'post','public',$3)`, [me, note, id]);
  }

  const count = await query(`SELECT COUNT(*)::int AS total FROM post_shares WHERE post_id = $1`, [id]);
  res.json({ shareCount: count.rows[0].total });
}));

router.post("/posts/:id/save", handle(async (req, res) => {
  const me = uid(req);
  const id = toId(req.params.id);
  const collection = str((req.body || {}).collection, 80) || "Saved posts";

  const post = await query(
    `SELECT p.id::int AS id, LEFT(COALESCE(p.content, ''), 200) AS excerpt,
            COALESCE(u.name, u.username) AS author,
            COALESCE(p.media->0, to_jsonb(p.media_url)) AS first_media
       FROM posts p JOIN users u ON u.id = p.user_id
      WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [id]
  );
  if (!post.rowCount) return missing(res, "Post");

  const found = post.rows[0];
  const image = typeof found.first_media === "string" ? found.first_media : "";

  const removed = await query(
    `DELETE FROM saved_items
      WHERE user_id = $1 AND item_type = 'post' AND ref_id = $2 AND collection = $3
      RETURNING id`,
    [me, String(id), collection]
  );
  if (removed.rowCount) return res.json({ saved: false });

  await query(
    `INSERT INTO saved_items (user_id, item_type, ref_id, collection, title, subtitle, image_url, href)
     VALUES ($1,'post',$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id, item_type, ref_id)
       DO UPDATE SET collection = EXCLUDED.collection, saved_at = NOW()`,
    [me, String(id), collection,
      found.excerpt ? found.excerpt.slice(0, 120) : `Post by ${found.author}`,
      found.author, image, `/post/${id}`]
  );
  res.json({ saved: true });
}));

module.exports = router;
