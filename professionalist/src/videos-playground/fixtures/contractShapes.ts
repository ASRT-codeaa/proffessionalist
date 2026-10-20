/**
 * fixtures/contractShapes.ts — PLAYGROUND DATA, the only place fixtures live.
 *
 * These objects are built field-for-field from docs/videos-api-contract.md (the
 * authoritative VIDEO_ITEM): JSON NUMBER ids, `kind` upload|link|indexed,
 * `provider` self|youtube|vimeo|linkedin, nullable durationMs/width/height/
 * thumbnailUrl, `ranking.reasons` as {key,value,weight} objects, topic SLUGS
 * (career, hiring, design, engineering, finance, sales, leadership, freelancing),
 * and the documented error envelope `{error:{code,message,fields}}`.
 *
 * src/pages, src/components/video and src/services never import this file. The stub
 * server (src/videos-playground/stub-server.mjs) imports it so the HTTP responses are
 * byte-identical to what the UI consumes, i.e. the components still talk to endpoints.
 */

import type { VideoComment, VideoItem, VideoRankingReason, VideoTopic } from "@/services/videos";

const AUTHOR = (id: number, name: string, headline: string, avatarSeed: string) => ({
  id,
  name,
  headline,
  avatarUrl: `/media/avatar-${avatarSeed}.svg`,
  viewerFollows: false,
});

/** Contract feature keys; weights are the seeded starting weights. */
const REASONS = (hits: Partial<Record<string, number>>): VideoRankingReason[] =>
  ([
    ["interest_relevance", 0.3],
    ["watch_completion", 0.2],
    ["engagement", 0.15],
    ["followed_creators", 0.15],
    ["quality_freshness", 0.1],
    ["diversity_discovery", 0.1],
  ] as [string, number][]).map(([key, weight]) => ({ key, value: hits[key] ?? 0, weight }));

/** Direct-file clips (kind upload, provider self) so the <video> element really plays them. */
export const FIXTURE_UPLOAD_ITEMS: VideoItem[] = [
  {
    id: 41,
    postId: 1204,
    kind: "upload",
    provider: "self",
    playUrl: "/media/clip-0.mp4",
    thumbnailUrl: "/media/thumb-0.svg",
    durationMs: 12_000,
    width: 720,
    height: 1280,
    caption: "Three slides that make a pricing page convert. #pricing #growth",
    hashtags: ["pricing", "growth"],
    topics: ["sales", "career"],
    author: AUTHOR(7, "Mira Adeyemi", "Pricing consultant · ex-Stripe", "mira"),
    stats: { views: 128_400, likes: 3_102, comments: 44, saves: 918, shares: 212 },
    viewer: { liked: false, saved: false },
    createdAt: "2026-10-18T09:24:00.000Z",
    ranking: { score: 0.91, reasons: REASONS({ interest_relevance: 1, watch_completion: 0.82, engagement: 0.6, quality_freshness: 0.7 }) },
  },
  {
    id: 42,
    postId: 1205,
    kind: "upload",
    provider: "self",
    playUrl: "/media/clip-1.mp4",
    thumbnailUrl: "/media/thumb-1.svg",
    durationMs: 12_000,
    width: 720,
    height: 1280,
    caption: "How I run a 15-minute design review so nobody wastes an afternoon. #design",
    hashtags: ["design"],
    topics: ["design", "leadership"],
    author: AUTHOR(8, "Tomás Rivera", "Product designer", "tomas"),
    stats: { views: 44_120, likes: 1_204, comments: 18, saves: 310, shares: 65 },
    viewer: { liked: true, saved: false },
    createdAt: "2026-10-19T14:02:00.000Z",
    ranking: { score: 0.74, reasons: REASONS({ interest_relevance: 0.7, followed_creators: 1, quality_freshness: 0.8 }) },
  },
  {
    id: 43,
    postId: 1206,
    kind: "upload",
    provider: "self",
    playUrl: "/media/clip-2.mp4",
    thumbnailUrl: "/media/thumb-2.svg",
    durationMs: 12_000,
    width: 1280,
    height: 720,
    caption: "Whiteboard: the one query plan that cut our report from 40s to 300ms. #engineering",
    hashtags: ["engineering"],
    topics: ["engineering"],
    author: AUTHOR(9, "Amara Okafor", "Staff engineer, data platform", "amara"),
    stats: { views: 203_900, likes: 8_440, comments: 132, saves: 2_140, shares: 780 },
    viewer: { liked: false, saved: true },
    createdAt: "2026-10-20T06:40:00.000Z",
    ranking: { score: 0.88, reasons: REASONS({ interest_relevance: 1, engagement: 0.9, quality_freshness: 0.9 }) },
  },
];

/** Provider links + a dead source, so the external / unavailable states are reachable. */
export const FIXTURE_EXTERNAL_ITEMS: VideoItem[] = [
  {
    id: 44,
    postId: 1207,
    kind: "link",
    provider: "youtube",
    playUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    thumbnailUrl: "/media/thumb-3.svg",
    durationMs: 212_000,
    width: 1920,
    height: 1080,
    caption: "Keynote cut: hiring for judgement, not for tenure.",
    hashtags: [],
    topics: ["hiring", "leadership"],
    author: AUTHOR(10, "Jonah Weiss", "Talent partner", "jonah"),
    stats: { views: 9_800, likes: 402, comments: 7, saves: 88, shares: 31 },
    viewer: { liked: false, saved: false },
    createdAt: "2026-10-17T11:11:00.000Z",
    ranking: { score: 0.42, reasons: REASONS({ interest_relevance: 0.4, quality_freshness: 0.5 }) },
  },
  {
    id: 45,
    postId: 1208,
    kind: "upload",
    provider: "self",
    playUrl: "/media/does-not-exist.mp4",
    thumbnailUrl: null,
    durationMs: null,
    width: null,
    height: null,
    caption: "Processing failed at the origin — the feed must show an unavailable state.",
    hashtags: [],
    topics: ["freelancing"],
    author: AUTHOR(11, "Lena Novak", "Operations lead", "lena"),
    stats: { views: 12, likes: 0, comments: 0, saves: 0, shares: 0 },
    viewer: { liked: false, saved: false },
    createdAt: "2026-10-20T08:00:00.000Z",
    ranking: { score: 0.1, reasons: REASONS({ quality_freshness: 0.95, diversity_discovery: 1 }) },
  },
  {
    id: 46,
    postId: 1209,
    kind: "indexed",
    provider: "vimeo",
    playUrl: "https://vimeo.com/76979871",
    thumbnailUrl: "/media/thumb-5.svg",
    durationMs: 96_000,
    width: 1080,
    height: 1920,
    caption: "Studio tour: how a solo founder films a launch video in one afternoon. #founder",
    hashtags: ["founder"],
    topics: ["freelancing", "sales"],
    author: AUTHOR(12, "Sarah Kim", "Founder, Northbeam Studio", "sara"),
    stats: { views: 51_300, likes: 2_010, comments: 39, saves: 505, shares: 140 },
    viewer: { liked: false, saved: false },
    createdAt: "2026-10-19T19:35:00.000Z",
    ranking: { score: 0.66, reasons: REASONS({ interest_relevance: 0.6, engagement: 0.5, watch_completion: 0.6 }) },
  },
];

export const FIXTURE_ITEMS: VideoItem[] = [...FIXTURE_UPLOAD_ITEMS, ...FIXTURE_EXTERNAL_ITEMS];

/** toComment DTO shape (id/postId numbers, `liked`, oldest first). */
export const FIXTURE_COMMENTS: VideoComment[] = [
  {
    id: 88,
    postId: 1204,
    text: "The second slide is the one I stole for our own page. Works.",
    author: { id: 21, name: "Dev Patel", headline: "Growth at Fernwood", avatarUrl: "/media/avatar-dev.svg", viewerFollows: false },
    likeCount: 12,
    liked: false,
    createdAt: "2026-10-19T10:15:00.000Z",
  },
  {
    id: 89,
    postId: 1204,
    text: "Would you do the annual plan the same way? The psychology feels different.",
    author: { id: 22, name: "Ingrid Hall", headline: "Finance partner", avatarUrl: "/media/avatar-ingrid.svg", viewerFollows: true },
    likeCount: 3,
    liked: false,
    createdAt: "2026-10-19T12:41:00.000Z",
  },
  {
    id: 90,
    postId: 1204,
    text: "Timestamp 0:41 saved me. Thank you.",
    author: { id: 23, name: "Omar Farouk", headline: "Indie consultant", avatarUrl: "/media/avatar-omar.svg", viewerFollows: false },
    likeCount: 0,
    liked: false,
    createdAt: "2026-10-20T07:02:00.000Z",
  },
];

/** GET /api/videos/topics — the seeded taxonomy from migration 012. */
export const FIXTURE_TOPICS: VideoTopic[] = [
  { id: 1, slug: "career", name: "Career", parentId: null },
  { id: 2, slug: "hiring", name: "Hiring", parentId: null },
  { id: 3, slug: "design", name: "Design", parentId: null },
  { id: 4, slug: "engineering", name: "Engineering", parentId: null },
  { id: 5, slug: "finance", name: "Finance", parentId: null },
  { id: 6, slug: "sales", name: "Sales", parentId: null },
  { id: 7, slug: "leadership", name: "Leadership", parentId: null },
  { id: 8, slug: "freelancing", name: "Freelancing", parentId: null },
];

/** Documented error envelope, used by the stub for a rejected submission. */
export const FIXTURE_ERROR_ENVELOPE = {
  error: {
    code: "validation_error",
    message: "That provider is not allowlisted",
    fields: {},
  },
};
