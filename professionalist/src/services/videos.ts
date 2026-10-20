/**
 * videos.ts — typed client for the Videos backend.
 *
 * Contract: docs/videos-api-contract.md (authoritative). Every path below is either a
 * documented `/api/videos*` endpoint or an EXISTING `/api/posts*` engagement endpoint —
 * a video is a post, so like/save/share/comment reuse the post routes already used by
 * src/components/PostCard.tsx (`post(id, reaction)`, `save(id, collection)`,
 * `share(id, note)`, `comments(id)`, `addComment(id, text)`).
 *
 * No mock data lives here: every function awaits the server and throws `ApiError`
 * (see videoHttp.ts) with the server's `{ error: { code, message, fields } }` envelope.
 */

import { videoHttp, type VideoQuery } from "./videoHttp";

export type VideoTab = "for-you" | "following" | "trending";

export type VideoActivityEvent =
  | "view_start"
  | "watch"
  | "complete"
  | "like"
  | "save"
  | "share"
  | "impression";

export type VideoProvider = "upload" | "youtube" | "vimeo" | "external";

export type VideoModerationState =
  | "pending"
  | "approved"
  | "rejected"
  | "reprocessing"
  | "removed";

export interface VideoAuthor {
  id: string;
  name: string;
  headline?: string | null;
  avatarUrl?: string | null;
  viewerFollows?: boolean | null;
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

export interface VideoRanking {
  score: number;
  reasons: string[];
}

/** VIDEO_ITEM, exactly as documented. */
export interface VideoItem {
  id: string;
  postId: string;
  kind: string;
  provider: VideoProvider | string;
  playUrl: string | null;
  thumbnailUrl: string | null;
  durationMs: number;
  width: number;
  height: number;
  caption: string;
  hashtags: string[];
  topics: string[];
  author: VideoAuthor;
  stats: VideoStats;
  viewer: VideoViewer;
  createdAt: string;
  ranking?: VideoRanking | null;
}

export interface VideoFeedPage {
  items: VideoItem[];
  nextCursor: string | null;
}

export interface VideoComment {
  id: string;
  text: string;
  author: VideoAuthor;
  createdAt: string;
  likeCount?: number;
  likedByViewer?: boolean;
}

export interface VideoCommentPage {
  items: VideoComment[];
  nextCursor?: string | null;
}

export interface VideoDetail extends VideoItem {
  comments: VideoCommentPage;
}

/** A creator's own upload plus its moderation lifecycle. */
export interface OwnVideo {
  id: string;
  postId: string;
  title: string;
  caption: string;
  topics: string[];
  provider: string;
  playUrl: string | null;
  thumbnailUrl: string | null;
  durationMs: number;
  moderationState: VideoModerationState | string;
  moderationReason?: string | null;
  stats?: Partial<VideoStats>;
  createdAt: string;
  updatedAt?: string | null;
}

export interface VideoInterest {
  topic: string;
  /** 0..1 relevance weight the server feeds into recommendations. */
  weight: number;
}

export interface CreateVideoByLinkInput {
  url: string;
  title?: string;
  caption?: string;
  topics?: string[];
}

export interface CreateVideoUploadInput {
  file: File;
  title?: string;
  caption?: string;
  topics?: string[];
  thumbnail?: File | Blob | null;
}

export interface ActivityPayload {
  event: VideoActivityEvent;
  value_ms?: number;
  value_num?: number;
  dedupe_key: string;
}

export interface LikeResult {
  liked: boolean;
  likeCount: number;
  reaction?: string | null;
}

export interface SaveResult {
  saved: boolean;
  saveCount?: number;
}

/**
 * Server-side limits, mirrored for *advisory* client preflight only.
 * The server is always the authority: POST /api/videos re-validates everything and the
 * UI surfaces that envelope verbatim (see CreateVideoPage). Values are the documented
 * defaults for the videos contract; adjust here (single source) if the contract moves.
 */
export const VIDEO_LIMITS = {
  maxUploadBytes: 100 * 1024 * 1024,
  minDurationMs: 3_000,
  maxDurationMs: 15 * 60_000,
  maxTitleLength: 80,
  maxCaptionLength: 2_200,
  maxHashtags: 12,
  maxTopics: 5,
  acceptedUploadTypes: ["video/mp4", "video/webm", "video/quicktime"] as string[],
  acceptedExtensions: [".mp4", ".mov", ".webm", ".m4v"] as string[],
  minWidth: 240,
  minHeight: 240,
} as const;

/** Canonical topic vocabulary for interests; the server response extends it. */
export const VIDEO_TOPICS = [
  "Career advice",
  "Business & finance",
  "Marketing",
  "Design",
  "Engineering",
  "Productivity",
  "Leadership",
  "Sales",
  "Founder stories",
  "Hiring & interviews",
  "Data & AI",
  "Personal finance",
] as const;

export const VIDEO_TOPIC_OPTIONS: string[] = [...VIDEO_TOPICS];

const http = () => videoHttp();

/* ------------------------------------------------------------------ *
 * Feed / discovery
 * ------------------------------------------------------------------ */

export function getFeed(params: { tab: VideoTab; cursor?: string | null; limit?: number }): Promise<VideoFeedPage> {
  const query: VideoQuery = { tab: params.tab, limit: params.limit ?? 10 };
  if (params.cursor) query.cursor = params.cursor;
  return http().get<VideoFeedPage>("/api/videos/feed", query);
}

export function searchVideos(q: string): Promise<VideoFeedPage> {
  return http().get<VideoFeedPage>("/api/videos/search", { q });
}

export function getVideo(id: string): Promise<VideoDetail> {
  return http().get<VideoDetail>(`/api/videos/${encodeURIComponent(id)}`);
}

/* ------------------------------------------------------------------ *
 * Creation
 * ------------------------------------------------------------------ */

export function createVideoByLink(input: CreateVideoByLinkInput): Promise<OwnVideo> {
  return http().post<OwnVideo>("/api/videos", {
    url: input.url.trim(),
    title: input.title?.trim() || undefined,
    caption: input.caption?.trim() || undefined,
    topics: input.topics?.length ? input.topics : undefined,
  });
}

export function createVideoUpload(
  input: CreateVideoUploadInput,
  options?: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void },
): Promise<OwnVideo> {
  const form = new FormData();
  form.append("file", input.file, input.file.name);
  form.append("kind", "video");
  if (input.title) form.append("title", input.title.trim());
  if (input.caption) form.append("caption", input.caption.trim());
  if (input.topics?.length) form.append("topics", input.topics.join(","));
  if (input.thumbnail) form.append("thumbnail", input.thumbnail, "thumbnail.jpg");
  return http().upload<OwnVideo>("/api/videos", form, { signal: options?.signal, onProgress: options?.onProgress });
}

export function listMyVideos(params?: { cursor?: string | null; limit?: number }): Promise<{
  items: OwnVideo[];
  nextCursor: string | null;
}> {
  return http().get("/api/videos/mine", { cursor: params?.cursor, limit: params?.limit ?? 20 });
}

/** Re-run the ingest pipeline after a failed transcode / provider fetch. */
export function reprocessVideo(id: string): Promise<OwnVideo> {
  return http().post<OwnVideo>(`/api/videos/${encodeURIComponent(id)}/reprocess`);
}

export function removeVideo(id: string): Promise<void> {
  return http().del<void>(`/api/videos/${encodeURIComponent(id)}`);
}

/* ------------------------------------------------------------------ *
 * Activity (real watch time; idempotent server-side thanks to dedupe_key)
 * ------------------------------------------------------------------ */

export function postActivity(videoId: string, payload: ActivityPayload): Promise<{ accepted: boolean }> {
  return http().post<{ accepted: boolean }>(`/api/videos/${encodeURIComponent(videoId)}/activity`, payload);
}

/* ------------------------------------------------------------------ *
 * Interests
 * ------------------------------------------------------------------ */

export function getInterests(): Promise<{ items: VideoInterest[] }> {
  return http().get<{ items: VideoInterest[] }>("/api/videos/interests");
}

export function putInterests(items: VideoInterest[]): Promise<{ items: VideoInterest[] }> {
  return http().put<{ items: VideoInterest[] }>("/api/videos/interests", { items });
}

/* ------------------------------------------------------------------ *
 * Engagement — existing post endpoints (no new surface invented)
 * ------------------------------------------------------------------ */

export function likeVideo(postId: string, reaction?: string | null): Promise<LikeResult> {
  return http().post<LikeResult>(`/api/posts/${encodeURIComponent(postId)}/like`, {
    reaction: reaction ?? undefined,
  });
}

export function saveVideo(postId: string, collection?: string | null): Promise<SaveResult> {
  return http().post<SaveResult>(`/api/posts/${encodeURIComponent(postId)}/save`, {
    collection: collection ?? undefined,
  });
}

export function shareVideo(postId: string, note?: string | null): Promise<{ shareCount?: number }> {
  return http().post<{ shareCount?: number }>(`/api/posts/${encodeURIComponent(postId)}/share`, {
    note: note ?? undefined,
  });
}

export function getVideoComments(postId: string, cursor?: string | null): Promise<VideoCommentPage> {
  return http().get<VideoCommentPage>(`/api/posts/${encodeURIComponent(postId)}/comments`, { cursor });
}

export function addVideoComment(postId: string, text: string): Promise<VideoComment> {
  return http().post<VideoComment>(`/api/posts/${encodeURIComponent(postId)}/comments`, { text });
}

export function deleteVideoComment(commentId: string): Promise<void> {
  return http().del<void>(`/api/posts/comments/${encodeURIComponent(commentId)}`);
}

/**
 * Duplicate check for the "Add a video" link flow. Uses the documented search endpoint
 * (no separate duplicate route exists in the contract) and is strictly advisory: the
 * server still rejects true duplicates on POST /api/videos.
 */
export async function findLikelyDuplicate(url: string): Promise<VideoItem | null> {
  const normalized = normalizeVideoUrl(url);
  if (!normalized) return null;
  try {
    const page = await searchVideos(normalized);
    const videoId = extractProviderVideoId(normalized);
    return (
      page.items.find((item) => {
        const itemUrl = normalizeVideoUrl(item.playUrl ?? "");
        return (!!videoId && !!extractProviderVideoId(itemUrl) && extractProviderVideoId(itemUrl) === videoId) ||
          itemUrl === normalized;
      }) ?? null
    );
  } catch {
    // Advisory only: a failed search must never block the create flow.
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * URL helpers (link canonicalisation preview)
 * ------------------------------------------------------------------ */

export interface CanonicalisedLink {
  input: string;
  canonicalUrl: string | null;
  provider: VideoProvider | null;
  providerVideoId: string | null;
  /** Short human reason shown next to the preview, or null when the link looks usable. */
  issue: string | null;
}

const YOUTUBE_PATTERNS = [
  /youtube\.com\/watch\?v=([\w-]{6,20})/i,
  /youtube\.com\/shorts\/([\w-]{6,20})/i,
  /youtu\.be\/([\w-]{6,20})/i,
  /youtube\.com\/embed\/([\w-]{6,20})/i,
  /youtube\.com\/live\/([\w-]{6,20})/i,
];

export function normalizeVideoUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    url.hash = "";
    // Drop tracking noise that does not identify the video.
    for (const junk of ["si", "feature", "t", "start", "end", "list_type", "utm_source", "rel"]) {
      url.searchParams.delete(junk);
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function extractProviderVideoId(rawUrl: string): string | null {
  const url = normalizeVideoUrl(rawUrl);
  if (!url) return null;
  for (const pattern of YOUTUBE_PATTERNS) {
    const match = pattern.exec(url);
    if (match?.[1]) return match[1];
  }
  try {
    const parsed = new URL(url);
    if (/vimeo\.com$/i.test(parsed.hostname)) {
      const id = parsed.pathname.split("/").filter(Boolean).pop();
      return id && /^\d+$/.test(id) ? id : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function canonicaliseVideoLink(raw: string): CanonicalisedLink {
  const canonicalUrl = normalizeVideoUrl(raw);
  if (!raw.trim()) {
    return { input: raw, canonicalUrl: null, provider: null, providerVideoId: null, issue: null };
  }
  if (!canonicalUrl) {
    return {
      input: raw,
      canonicalUrl: null,
      provider: null,
      providerVideoId: null,
      issue: "That does not look like a web address.",
    };
  }
  let hostname = "";
  try {
    hostname = new URL(canonicalUrl).hostname;
  } catch {
    hostname = "";
  }
  const providerId = extractProviderVideoId(canonicalUrl);
  let provider: VideoProvider | null = "external";
  if (/youtube\.com|youtu\.be/i.test(hostname)) provider = "youtube";
  else if (/vimeo\.com/i.test(hostname)) provider = providerId ? "vimeo" : "external";
  else if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(canonicalUrl)) provider = "external";

  let issue: string | null = null;
  if (provider === "youtube" && !providerId) {
    issue = "YouTube links need a video id (watch?v=…, /shorts/…, or youtu.be/…).";
  } else if (provider === "vimeo" && !providerId) {
    issue = "Vimeo links need the numeric video id in the path.";
  } else if (provider === "external" && !/\.(mp4|webm|mov|m4v)(\?|$)/i.test(canonicalUrl)) {
    issue = "Direct links must point at a video file (.mp4, .webm, .mov, .m4v) or a supported provider.";
  }
  return { input: raw, canonicalUrl, provider, providerVideoId: providerId, issue };
}

/** True when the browser can stream this item directly (otherwise: provider/unavailable UI). */
export function isPlayableDirectly(item: VideoItem): boolean {
  return !!item.playUrl && (item.provider === "upload" || item.provider === "external");
}

export function videoSharePath(item: VideoItem): string {
  return `/videos/${encodeURIComponent(item.id)}`;
}
