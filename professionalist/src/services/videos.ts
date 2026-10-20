/**
 * videos.ts — typed client for the Videos backend.
 *
 * Contract: docs/videos-api-contract.md (authoritative; implemented by
 * app-new/routes/spa/videos.js). Every path here is either a documented
 * `/api/videos*` endpoint (including `/api/videos/admin/*`) or an EXISTING
 * `/api/posts*` engagement endpoint — a video is a post, so like/save/share/
 * comment reuse the same routes src/services/feed.ts documents
 * (`post(id, reaction)`, `save(id, collection)`, `share(id, note)`,
 * `comments(id)`, `addComment(id, text)`, `deleteComment(id)`).
 *
 * Things the contract is explicit about and this file therefore obeys:
 *  - ids are JSON NUMBERS (`id === 7`), never "4";
 *  - `durationMs`, `width`, `height`, `thumbnailUrl`, `embedUrl`, `indexedAt`,
 *    `nextCursor` are nullable;
 *  - `kind` ∈ upload | link | indexed, `provider` ∈ self | youtube | vimeo | linkedin;
 *  - `ranking.reasons` is an array of {key, value, weight} objects;
 *  - there is NO GET /interests and NO /videos/mine: interests are read back through
 *    the PUT response echo (the UI keeps a local mirror, see videoHooks.ts), and an
 *    author sees their own pending video through GET /:id;
 *  - reprocess/approve/remove are staff-only (/admin/:id/…);
 *  - upload accepts `file` + text fields caption/topics(repeated)/durationMs/width/height;
 *    `caption` is REQUIRED for uploads; a client-declared author or role is a 400.
 *
 * No mock data lives here: every function awaits the server and throws `VideoApiError`
 * (see videoHttp.ts) carrying the server's `{ error: { code, message, fields } }` envelope.
 */

import { videoHttp, type VideoQuery } from "./videoHttp";

export type VideoTab = "for-you" | "following" | "trending";

/** Exactly the events the activity route accepts (anything else → 400 fields.event). */
export type VideoActivityEvent =
  | "view_start"
  | "watch"
  | "complete"
  | "like"
  | "save"
  | "share"
  | "follow_from_video"
  | "impression";

export type VideoKind = "upload" | "link" | "indexed";
export type VideoProvider = "self" | "youtube" | "vimeo" | "linkedin";
export type VideoModerationState = "pending" | "approved" | "removed";
export type VideoAvailability = "ok" | "unavailable";

/** The six ranking keys the Worker scores with (video_rank_config). */
export type VideoRankingKey =
  | "interest_relevance"
  | "watch_completion"
  | "engagement"
  | "followed_creators"
  | "quality_freshness"
  | "diversity_discovery";

export interface VideoAuthor {
  id: number;
  /** "" when absent — the contract guarantees empty string, never null. */
  name: string;
  headline: string;
  avatarUrl: string | null;
  viewerFollows: boolean | null;
  /** Present when the DTO is a full `Person` (comment authors). */
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface VideoStats {
  views: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
}

export interface VideoViewer {
  liked: boolean;
  saved: boolean;
}

export interface VideoRankingReason {
  key: string;
  value: number;
  weight: number;
}

export interface VideoRanking {
  score: number;
  reasons: VideoRankingReason[];
}

/** VIDEO_ITEM, exactly as documented. */
export interface VideoItem {
  id: number;
  postId: number;
  kind: VideoKind | string;
  provider: VideoProvider | string;
  playUrl: string;
  /** Present on kind:"link" rows the server could build an embed for (youtube, vimeo). */
  embedUrl?: string | null;
  canonicalUrl?: string;
  thumbnailUrl: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  caption: string;
  hashtags: string[];
  /** Topic slugs ("hiring"), never display names. */
  topics: string[];
  author: VideoAuthor;
  stats: VideoStats;
  viewer: VideoViewer;
  createdAt: string;
  ranking: VideoRanking | null;
}

/** GET /:id and POST / add these to VIDEO_ITEM; `comments` is inline on both. */
export interface VideoDetail extends VideoItem {
  canonicalUrl: string;
  embedUrl: string | null;
  moderationState: VideoModerationState | string;
  availability: VideoAvailability | string;
  indexedAt: string | null;
  comments: VideoComment[];
}

export interface VideoFeedPage {
  items: VideoItem[];
  nextCursor: string | null;
  tab: VideoTab;
}

export interface VideoSearchPage {
  items: VideoItem[];
  nextCursor: string | null;
  query: string;
  total: number;
}

/** The `toComment` DTO used by /api/posts/:id/comments and GET /videos/:id. */
export interface VideoComment {
  id: number;
  postId: number;
  author: VideoAuthor;
  text: string;
  likeCount: number;
  liked: boolean;
  createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Topics / interests (contract shapes: slug-based, PUT-only)
 * ------------------------------------------------------------------ */

export interface VideoTopic {
  id: number;
  slug: string;
  name: string;
  parentId: number | null;
}

/** What PUT /interests echoes back — the only way to read saved interests. */
export interface VideoSavedInterest {
  slug: string;
  name: string;
  weight: number;
  updatedAt: string | null;
}

export interface InterestsResult {
  ok: boolean;
  topics: VideoSavedInterest[];
}

/* ------------------------------------------------------------------ *
 * Admin surface (staff-only; deny-by-default 401/403)
 * ------------------------------------------------------------------ */

export interface AdminVideoRow extends VideoItem {
  moderationState: string;
  availability: string;
  canonicalUrl: string;
  sourceUserId: number | null;
  indexedAt: string | null;
  lastCheckedAt: string | null;
}

export interface RankConfigItem {
  key: string;
  weight: number;
  updatedAt: string | null;
}

export interface RankConfig {
  items: RankConfigItem[];
  weights: Record<VideoRankingKey, number>;
  sum: number;
}

export interface VideoSource {
  id: number;
  kind: "rss" | "sitemap" | "allowlist" | string;
  url: string;
  provider: string;
  enabled: boolean;
  robotsRespected: boolean;
  lastRunAt: string | null;
  etag: string | null;
  createdAt: string;
}

export type DiscoveryOutcome =
  | "indexed"
  | "duplicate"
  | "provider_denied"
  | "scheme_denied"
  | "robots_denied"
  | "rejected";

export interface DiscoveryRunResult {
  processed: number;
  indexed: number[];
  duplicates: number;
  refused: number;
  outcomes: { url: string; outcome: DiscoveryOutcome | string; videoId: number | null; detail: string | null }[];
  sourceId: number | null;
  ranAt: string;
}

/* ------------------------------------------------------------------ *
 * Request payload types
 * ------------------------------------------------------------------ */

export interface ActivityPayload {
  event: VideoActivityEvent;
  value_ms?: number | null;
  value_num?: number | null;
  /** Required, 1–120 chars; replays are stored once, never an error. */
  dedupe_key: string;
}

export interface ActivityResult {
  recorded: boolean;
  deduped: boolean;
  videoId: number;
  event: VideoActivityEvent;
}

export interface CreateVideoByLinkInput {
  url: string;
  caption?: string;
  topics?: string[];
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  /** External https thumbnail URL only (the server canonicalises it). */
  thumbnailUrl?: string | null;
}

export interface CreateVideoUploadInput {
  file: File;
  /** Required for uploads — the server answers 400 fields.caption without it. */
  caption: string;
  topics?: string[];
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  hashtags?: string[];
}

export interface LikeResult {
  liked: boolean;
  likeCount: number;
  reaction: string | null;
}

export interface SaveResult {
  saved: boolean;
}

export interface ShareResult {
  shareCount: number;
}

/* ------------------------------------------------------------------ *
 * Server-side limits, mirrored for client-side preflight only.
 * The server is always the authority (docs: "a client-side check is
 * never the reason for a rejection") — values below are the documented
 * answers of POST /api/videos.
 * ------------------------------------------------------------------ */
export const VIDEO_LIMITS = {
  /** "Keep each file under 12 MB." */
  maxUploadBytes: 12 * 1024 * 1024,
  /** multer shim accepts video/mp4 | video/webm | video/quicktime. */
  acceptedUploadTypes: ["video/mp4", "video/webm", "video/quicktime"] as string[],
  acceptedExtensions: [".mp4", ".webm", ".mov", ".m4v"] as string[],
  /** caption longer than 2000 chars is truncated by the server (no error). */
  maxCaptionLength: 2_000,
  /** interests: "Pick up to 24 topics"; weight 0..1. */
  maxTopics: 24,
  /** search: q is 1..80 chars, longer is truncated. */
  maxSearchLength: 80,
  /** feed/search limit is clamped to 1..30 by the server. */
  maxPageSize: 30,
  /** dedupe_key: 1..120 chars. */
  maxDedupeKeyLength: 120,
  valueUpperBoundMs: 86_400_000,
} as const;

const http = () => videoHttp();

/* ------------------------------------------------------------------ *
 * Feed / discovery
 * ------------------------------------------------------------------ */

export function getFeed(params: { tab: VideoTab; cursor?: string | null; limit?: number }): Promise<VideoFeedPage> {
  const query: VideoQuery = { tab: params.tab, limit: params.limit ?? 10 };
  if (params.cursor) query.cursor = params.cursor;
  return http().get<VideoFeedPage>("/api/videos/feed", query);
}

export function searchVideos(q: string, cursor?: string | null): Promise<VideoSearchPage> {
  const query: VideoQuery = { q: q.slice(0, VIDEO_LIMITS.maxSearchLength), limit: 10 };
  if (cursor) query.cursor = cursor;
  return http().get<VideoSearchPage>("/api/videos/search", query);
}

/** Visible when approved+ok, or the viewer is the author (pending OK), or staff. */
export function getVideo(id: number): Promise<VideoDetail> {
  return http().get<VideoDetail>(`/api/videos/${id}`);
}

export function getTopics(): Promise<{ items: VideoTopic[] }> {
  return http().get<{ items: VideoTopic[] }>("/api/videos/topics");
}

/* ------------------------------------------------------------------ *
 * Creation
 * ------------------------------------------------------------------ */

export function createVideoByLink(input: CreateVideoByLinkInput): Promise<VideoDetail> {
  return http().post<VideoDetail>("/api/videos", {
    url: input.url.trim(),
    caption: input.caption?.trim() || undefined,
    topics: input.topics?.length ? input.topics : undefined,
    durationMs: input.durationMs ?? undefined,
    width: input.width ?? undefined,
    height: input.height ?? undefined,
    thumbnailUrl: input.thumbnailUrl ?? undefined,
  });
}

export function createVideoUpload(
  input: CreateVideoUploadInput,
  options?: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void },
): Promise<VideoDetail> {
  const form = new FormData();
  form.append("file", input.file, input.file.name);
  form.append("caption", input.caption.trim());
  // the contract accepts topics "repeated or JSON array string" — repeated fields it is.
  for (const slug of input.topics ?? []) form.append("topics", slug);
  if (input.durationMs != null) form.append("durationMs", String(input.durationMs));
  if (input.width != null) form.append("width", String(input.width));
  if (input.height != null) form.append("height", String(input.height));
  for (const tag of input.hashtags ?? []) form.append("hashtags", tag);
  return http().upload<VideoDetail>("/api/videos", form, { signal: options?.signal, onProgress: options?.onProgress });
}

/* ------------------------------------------------------------------ *
 * Activity (real watch time; idempotent server-side via dedupe_key)
 * ------------------------------------------------------------------ */

export function postActivity(videoId: number, payload: ActivityPayload): Promise<ActivityResult> {
  return http().post<ActivityResult>(`/api/videos/${videoId}/activity`, payload);
}

/* ------------------------------------------------------------------ *
 * Interests — PUT replaces the whole set and echoes it back; there is no GET.
 * ------------------------------------------------------------------ */

export function putInterests(topics: { slug: string; weight: number }[]): Promise<InterestsResult> {
  return http().put<InterestsResult>("/api/videos/interests", { topics });
}

/* ------------------------------------------------------------------ *
 * Engagement — existing post endpoints (a video IS a post; no new surface)
 * ------------------------------------------------------------------ */

export function likeVideo(postId: number, reaction?: "like" | null): Promise<LikeResult> {
  return http().post<LikeResult>(`/api/posts/${postId}/like`, { reaction: reaction ?? null });
}

export function saveVideo(postId: number, collection?: string | null): Promise<SaveResult> {
  return http().post<SaveResult>(`/api/posts/${postId}/save`, { collection: collection ?? null });
}

export function shareVideo(postId: number, note?: string | null): Promise<ShareResult> {
  return http().post<ShareResult>(`/api/posts/${postId}/share`, { note: note ?? null });
}

/** GET /api/posts/:id/comments answers a plain array (oldest first), see feed.ts. */
export function getVideoComments(postId: number): Promise<VideoComment[]> {
  return http().get<VideoComment[]>(`/api/posts/${postId}/comments`);
}

export function addVideoComment(postId: number, text: string): Promise<VideoComment> {
  return http().post<VideoComment>(`/api/posts/${postId}/comments`, { text });
}

export function deleteVideoComment(commentId: number): Promise<{ ok: boolean }> {
  return http().del<{ ok: boolean }>(`/api/posts/comments/${commentId}`);
}

/* ------------------------------------------------------------------ *
 * Admin (staff): /api/videos/admin/* — deny-by-default, audited server-side.
 * ------------------------------------------------------------------ */

export function adminIndex(params: {
  state: "pending" | "approved" | "removed" | "all";
  cursor?: string | null;
  limit?: number;
}): Promise<{ items: AdminVideoRow[]; total: number; nextCursor: string | null; state: string }> {
  const query: VideoQuery = { state: params.state, limit: params.limit ?? 10 };
  if (params.cursor) query.cursor = params.cursor;
  return http().get("/api/videos/admin/index", query);
}

export interface AdminStateResult {
  ok: boolean;
  videoId: number;
  moderationState: string;
  availability?: string;
  changed?: boolean;
}

export function adminApprove(id: number): Promise<AdminStateResult> {
  return http().post<AdminStateResult>(`/api/videos/admin/${id}/approve`);
}

export function adminRemove(id: number): Promise<AdminStateResult> {
  return http().post<AdminStateResult>(`/api/videos/admin/${id}/remove`);
}

export function adminReprocess(id: number): Promise<AdminStateResult> {
  return http().post<AdminStateResult>(`/api/videos/admin/${id}/reprocess`);
}

export function adminRankConfig(): Promise<RankConfig> {
  return http().get<RankConfig>("/api/videos/admin/rank-config");
}

/** All six keys are required and must sum to 1.0 (±0.001) or the call is a 400. */
export function adminPutRankConfig(weights: Record<VideoRankingKey, number>): Promise<RankConfig> {
  return http().put<RankConfig>("/api/videos/admin/rank-config", { weights });
}

export function adminSources(): Promise<{ items: VideoSource[] }> {
  return http().get<{ items: VideoSource[] }>("/api/videos/admin/sources");
}

export function adminAddSource(input: {
  kind: "rss" | "sitemap" | "allowlist";
  url: string;
  provider: VideoProvider;
  enabled: boolean;
}): Promise<VideoSource> {
  return http().post<VideoSource>("/api/videos/admin/sources", input);
}

/** The whole discovery pipeline's only trigger (there is no cron). ≤50 urls per call. */
export function adminRunDiscovery(input: { urls: string[]; sourceId?: number; etag?: string }): Promise<DiscoveryRunResult> {
  return http().post<DiscoveryRunResult>("/api/videos/admin/discovery/run", input);
}

/* ------------------------------------------------------------------ *
 * Small shared helpers (no network)
 * ------------------------------------------------------------------ */

/** True when the browser can stream this item directly; otherwise the external panel shows. */
export function isPlayableDirectly(item: VideoItem): boolean {
  return item.provider === "self" && !!item.playUrl;
}

export function videoSharePath(item: VideoItem): string {
  return `/videos?video=${item.id}`;
}

/** Display name across the two author DTO flavours (video author vs comment Person). */
export function authorDisplayName(author: VideoAuthor | null | undefined): string {
  if (!author) return "";
  if (author.name) return author.name;
  const joined = [author.firstName, author.lastName].filter(Boolean).join(" ");
  return joined || author.username || "";
}
