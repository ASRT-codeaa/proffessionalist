# Surfaces API contract — support, advertising, AI assistant

The three routers shipped 2026-10-20 (§5.20 of CLOUDFLARE-MIGRATION-HANDOFF.md) answer the paths
`src/services/api.ts` and `src/services/endpoints.ts` have always called.  They live in
`app-new/routes/spa/{support,ads,ai}.js`, are copied into `cf-api/port/` by `tools/build.mjs`
(NEW files — bare specifiers and `$n` placeholders are fine), and ride the ONE `/api` chain in
`cf-api/src/api.js`:

```
app.use("/api", authenticate, userLimiter, safetyRoutes, supportRoutes, adsRoutes, aiRoutes, spaRoutes, platformRoutes);
```

Every path below requires a member session (Bearer token); a missing or stale session is the
authenticate middleware's 401, never a router's.  All DTOs come from the ported `spaDto`
(`toTicket`, `toCampaign`, `toAiConversation`) — the same shapes `src/services/types.ts` declares.
Errors are the standard envelope `{error:{code,message,fields}}`; ownership failures are 404 with
no existence leak.  `cf-api/tools/test-surfaces.mjs` pins this whole contract (39 checks) and the
live transcript is in §5.20.

## Support — `/api/support`

| Call | Answer |
| --- | --- |
| `GET /tickets` | plain array of the viewer's tickets, each with its full `messages[]`, newest-updated first |
| `POST /tickets` `{subject, category, text, attachmentUrl?}` → 201 | the created ticket DTO; `subject` and `text` are required non-empty (≤200 / ≤4000), the opening message lands as the visitor's |
| `GET /tickets/:id` | the ticket DTO — owner or staff only |
| `POST /tickets/:id/reply` `{text, attachmentUrl?}` | the updated ticket DTO — owner or staff only |
| `GET /availability` | static `{online, hours, avgResponse, agents:[{name, avatarUrl, role}]}` — no agents table exists; this JSON is the whole feature |

`support_messages.from_user`: **1 = the visitor, 0 = the support team** (`toTicket` surfaces it as
`fromUser`).  A staff reply writes 0; the advertising of that rule is why a team answer looks
different in the thread.  Status follows the reply: a staff reply moves the ticket to `pending`;
an owner reply on a `resolved` ticket re-opens it.  The report flows from MessagesPage,
ProfilePage and BusinessPage POST here too — same create path.

## Advertising — `/api/ads`

| Call | Answer |
| --- | --- |
| `GET /campaigns` | plain array of the viewer's campaigns, newest first |
| `POST /campaigns` `{name, …}` → 201 | the created campaign DTO |
| `PATCH /campaigns/:id` `{…}` | the updated DTO — a partial update of whitelisted fields only |

The whitelist mirrors `AdvertisingPage.tsx payloadFromForm` and nothing more: `name` (required,
≤120), `objective` ∈ awareness/traffic/engagement/leads/sales, `format` ∈ feed/marketplace/banner/
sponsored_profile/sponsored_product, `status` ∈ draft/active/paused/completed, `budget` ≥ 0,
`startDate`/`endDate`, `creativeUrl`/`creativeText`/`destination`, and `audience` normalised to
exactly `{industries[], locations[], interests[], ageRange}` (anything non-object normalises to the
empty shape).  `ownerBusinessId` is accepted and ignored — no column exists.  `user_id` always
comes from the session, never the body.  D1 stores `audience`/`metrics` as TEXT JSON; the router
parses before the DTO.  `spend` starts at 0 and `metrics` at zeros — no billing pipeline moves
them — and `daily` stays `[]`: no rollup table exists (operator decision, §5.20).

## AI assistant — `/api/ai`

| Call | Answer |
| --- | --- |
| `GET /conversations` | plain array of the viewer's conversations with full `messages[]` |
| `GET /conversations/:id` | the conversation DTO — owner only |
| `DELETE /conversations/:id` | `{deleted:true}` — owner only; messages cascade via FK |
| `GET /suggestions` | `{prompts: string[]}` — the static curated list |
| `POST /messages` `{conversationId, text}` | `{conversationId, reply:{id, role:"assistant", text, createdAt}}` — the exact shape `aiApi.send` reads |

`conversationId: null` starts a conversation titled with the first 42 characters of the message;
otherwise the id must be the viewer's own (404).  `text` is required non-empty, ≤6000.  Both the
user turn and the assistant turn are persisted, and `updated_at` is touched, before the answer is
returned.

### The provider proxy and its env

Assistant replies come from an OpenAI-compatible chat-completions endpoint via the Worker's global
fetch: `POST ${AI_API_BASE}/chat/completions`, `Authorization: Bearer ${AI_API_TOKEN}`, body
`{model: AI_MODEL, messages: [system, …last 20 turns]}`, 20 s abort timeout.

| Name | Kind | Default (in code) |
| --- | --- | --- |
| `AI_API_BASE` | plain var | `https://api.deepseek.com/v1` |
| `AI_MODEL` | plain var | `deepseek-chat` |
| `AI_API_TOKEN` | secret | absent = never call the provider |

**Graceful degradation is part of the contract**: no token, a non-2xx provider answer, a malformed
body, or a timeout all store the fixed fallback reply — *"The AI service is unavailable right now —
try again in a bit."* — and still return 200.  The thread stays continuous; the page never shows a
send failure for a service problem the member cannot fix.

Set or change the key without a redeploy:

```
npx wrangler secret put AI_API_TOKEN professionalist-api     # value on stdin, never printed
```

`tools/deploy.mjs` re-uploads it on every deploy from `~/.qoder/tmp/d1move/ai_token.txt` when that
file exists (optional — no file, no secret, fallback stays).  Current live state (2026-10-20):
the uploaded key is DeepSeek and the account answers **402 Insufficient Balance**, so live replies
are the fallback until the balance is topped up.  Nothing in the router needs to change for that.

## What is NOT here

- No staff console for reading all tickets over HTTP (staff reads happen through the same
  `/tickets/:id`; the ops surface stays internal).
- No ad DELETE (the client never calls one) and no delivery pipeline touching spend/metrics.
- No streaming answers — one request, one stored reply.
