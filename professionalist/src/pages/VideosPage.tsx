import { clsx } from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Pause,
  Play,
  Plus,
  Search,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { VideoActivityEvent, VideoComment, VideoItem, VideoTab } from "@/services/videos";
import {
  getFeed,
  getVideo,
  likeVideo,
  postActivity,
  putInterests,
  saveVideo,
  searchVideos,
  shareVideo,
  VIDEO_LIMITS,
  videoSharePath,
} from "@/services/videos";
import { VideoApiError, isOffline } from "@/services/videoHttp";
import { safetyApi } from "@/services/api";
import { absoluteVideoUrl, videoApp, type VideoReportReason } from "@/services/videoApp";
import { VideoCard } from "@/components/video/VideoCard";
import { VideoComments } from "@/components/video/VideoComments";
import { VideoEmptyState } from "@/components/video/VideoEmptyState";
import { VideoMoreMenu } from "@/components/video/VideoMoreMenu";
import { VideoNotice, type VideoNoticeModel } from "@/components/video/VideoNotice";
import { VideoTabBar } from "@/components/video/VideoTabBar";
import {
  readInterestsMirror,
  useFeedMuted,
  useOnlineStatus,
  usePrefersReducedMotion,
  useVideoActivity,
  writeInterestsMirror,
  type InterestMirror,
} from "@/components/video/videoHooks";
import type { VideoPlayerActivity } from "@/components/video/VideoPlayer";
import { getVideoTransport } from "@/components/video/VideoPlayer";

type SlotStatus = "idle" | "loading" | "ready" | "empty" | "error";

interface FeedState {
  items: VideoItem[];
  nextCursor: string | null;
  status: SlotStatus;
  error: string | null;
}

const EMPTY_FEED: FeedState = { items: [], nextCursor: null, status: "idle", error: null };

const PAGE_SIZE = 10;

/* Mutes are server-side (GET/POST/DELETE /api/mutes, enforced in both feeds' SQL); this local
   list is an optimistic cache so a tap hides the creator before the round-trip lands, and it
   still works offline.  hiddenVideos stays device-only: "not interested" is a taste signal,
   not a safety list. */
const MUTED_AUTHORS_KEY = "professionalist.videos.mutedAuthors";
const HIDDEN_VIDEOS_KEY = "professionalist.videos.hidden";

function readIdList(key: string): number[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function writeIdList(key: string, ids: number[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    /* private mode: the in-memory list still applies for this session */
  }
}

export default function VideosPage() {
  const app = videoApp();
  const reducedMotion = usePrefersReducedMotion();
  const online = useOnlineStatus();
  const [muted, setMuted] = useFeedMuted();
  const [tab, setTab] = useState<VideoTab>("for-you");
  const [feeds, setFeeds] = useState<Record<VideoTab, FeedState>>({
    "for-you": EMPTY_FEED,
    following: EMPTY_FEED,
    trending: EMPTY_FEED,
  });
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<FeedState>(EMPTY_FEED);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [pending, setPending] = useState<Record<string, Partial<Record<"like" | "save" | "share" | "comment" | "follow", boolean>>>>({});
  const [commentsFor, setCommentsFor] = useState<{ item: VideoItem; comments: VideoComment[] } | null>(null);
  const [notice, setNotice] = useState<VideoNoticeModel | null>(null);
  const [moreFor, setMoreFor] = useState<VideoItem | null>(null);
  const [mutedAuthors, setMutedAuthors] = useState<number[]>(() => readIdList(MUTED_AUTHORS_KEY));
  const [hiddenVideos, setHiddenVideos] = useState<number[]>(() => readIdList(HIDDEN_VIDEOS_KEY));

  useEffect(() => writeIdList(HIDDEN_VIDEOS_KEY, hiddenVideos), [hiddenVideos]);

  /* The server owns the mute list — pull it once per session so a mute made on another device
     hides here too.  A failed read leaves the device cache in charge until the next load. */
  useEffect(() => {
    if (!app.getSession().isAuthenticated) return;
    let stale = false;
    safetyApi.mutes()
      .then((list) => {
        if (stale) return;
        const ids = list.items.map(p => p.id);
        setMutedAuthors(ids);
        writeIdList(MUTED_AUTHORS_KEY, ids);
      })
      .catch(() => { /* offline: the device cache keeps hiding authors until the round-trip works */ });
    return () => { stale = true; };
  }, [app]);

  const navigate = useNavigate();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef(new Map<number, HTMLElement>());
  const searchParams = useSearchParams()[0];
  const sessionExpired = useRef(false);

  const viewingId = searchParams.get("video");

  /* ---------------------------------------------------------------- */
  /* Session gate: an unauthenticated visitor goes to the app's login. */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    if (app.getSession().isAuthenticated) return;
    app.requireLogin("/videos");
  }, [app]);

  useEffect(() => app.subscribeSessionExpired(() => {
    if (sessionExpired.current) return;
    sessionExpired.current = true;
    app.requireLogin("/videos");
  }), [app]);

  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const say = useCallback((tone: VideoNoticeModel["tone"], message: string, action?: VideoNoticeModel) => {
    setNotice({ id: Date.now(), tone, message, actionLabel: action?.actionLabel, onAction: action?.onAction });
  }, []);

  /* ---------------------------------------------------------------- */
  /* Feed loading (tab pages + search)                                 */
  /* ---------------------------------------------------------------- */
  const loadTab = useCallback(
    async (target: VideoTab, mode: "first" | "more") => {
      if (isOffline()) {
        setFeeds((prev) => ({ ...prev, [target]: { ...prev[target], status: "error", error: "offline" } }));
        return;
      }
      setFeeds((prev) => ({
        ...prev,
        [target]: { ...prev[target], status: mode === "first" ? "loading" : "ready", error: null },
      }));
      try {
        const cursor = mode === "more" ? feeds[target].nextCursor : null;
        const page = await getFeed({ tab: target, cursor, limit: PAGE_SIZE });
        setFeeds((prev) => {
          const existing = mode === "more" ? prev[target].items : [];
          const merged = mergeById(existing, page.items ?? []);
          return {
            ...prev,
            [target]: {
              items: merged,
              nextCursor: page.nextCursor ?? null,
              status: merged.length === 0 ? "empty" : "ready",
              error: null,
            },
          };
        });
      } catch (err) {
        const message = err instanceof VideoApiError ? err.message : "The video feed would not load.";
        setFeeds((prev) => ({ ...prev, [target]: { ...prev[target], status: "error", error: message } }));
      }
    },
    [feeds],
  );

  useEffect(() => {
    if (query.trim()) return;
    if (feeds[tab].status === "idle") void loadTab(tab, "first");
  }, [tab, query, feeds, loadTab]);

  const runSearch = useCallback(
    async (raw: string, mode: "first" | "more" = "first", cursor?: string | null) => {
      const q = raw.trim();
      if (!q) {
        setSearchState(EMPTY_FEED);
        return;
      }
      setSearchState((prev) => ({ ...prev, status: mode === "first" ? "loading" : prev.status, error: null }));
      try {
        const page = await searchVideos(q, mode === "more" ? cursor ?? null : null);
        setSearchState((prev) => {
          const existing = mode === "more" ? prev.items : [];
          const merged = mergeById(existing, page.items ?? []);
          return {
            items: merged,
            nextCursor: page.nextCursor ?? null,
            status: merged.length === 0 ? "empty" : "ready",
            error: null,
          };
        });
        if (mode === "first") setActiveIndex(0);
      } catch (err) {
        setSearchState((prev) => ({
          ...prev,
          status: prev.items.length > 0 ? "ready" : "error",
          error: err instanceof VideoApiError ? err.message : "Search would not run.",
        }));
      }
    },
    [],
  );

  /* ---------------------------------------------------------------- */
  /* Active slot detection                                             */
  /* ---------------------------------------------------------------- */
  const rawItems = useMemo(() => (query.trim() ? searchState.items : feeds[tab].items), [query, searchState, feeds, tab]);
  const state: FeedState = query.trim() ? searchState : feeds[tab];
  /* Device-side mute/not-interested filtering happens here, never on the server. */
  const items = useMemo(
    () => rawItems.filter((item) => !hiddenVideos.includes(item.id) && !mutedAuthors.includes(item.author.id)),
    [rawItems, hiddenVideos, mutedAuthors],
  );

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.slotIndex);
          if (!Number.isFinite(index)) continue;
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            setActiveIndex(index);
          }
        }
      },
      { root: scroller, threshold: [0.2, 0.6, 0.9] },
    );
    for (const node of slotRefs.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [items]);

  const activeItem = items[activeIndex] ?? null;

  useEffect(() => {
    if (!activeItem) return;
    if (activeIndex >= items.length - 2 && state.nextCursor && state.status === "ready") {
      void (query.trim() ? runSearch(query, "more", state.nextCursor) : loadTab(tab, "more"));
    }
  }, [activeIndex, items.length, state, tab, query, loadTab, runSearch, activeItem]);

  const goTo = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, Math.max(0, items.length - 1)));
      const node = slotRefs.current.get(clamped);
      const scroller = scrollerRef.current;
      if (!node || !scroller) return;
      scroller.scrollTo({ top: node.offsetTop, behavior: reducedMotion ? "auto" : "smooth" });
      setActiveIndex(clamped);
    },
    [items.length, reducedMotion],
  );

  /* ---------------------------------------------------------------- */
  /* Activity reporting (real watch time)                              */
  /* ---------------------------------------------------------------- */
  const activityReport = useCallback(
    (event: VideoActivityEvent, payload: { value_ms?: number; value_num?: number; dedupe_key: string }) => {
      if (!activeItem) return;
      void reportActivity(activeItem.id, event, payload);
    },
    [activeItem],
  );

  const activity = useVideoActivity({
    videoId: activeItem?.id ?? -1,
    active: Boolean(activeItem) && pageVisible && online,
    isPlaying,
    report: activityReport,
  });

  /* ---------------------------------------------------------------- */
  /* Engagement — optimistic, then reconciled with the server          */
  /* ---------------------------------------------------------------- */
  const patchItem = useCallback(
    (id: number, patch: (item: VideoItem) => VideoItem) => {
      const apply = (list: VideoItem[]) => list.map((item) => (item.id === id ? patch(item) : item));
      setFeeds((prev) => ({
        ...prev,
        "for-you": { ...prev["for-you"], items: apply(prev["for-you"].items) },
        following: { ...prev.following, items: apply(prev.following.items) },
        trending: { ...prev.trending, items: apply(prev.trending.items) },
      }));
      setSearchState((prev) => ({ ...prev, items: apply(prev.items) }));
    },
    [],
  );

  const setFlag = (id: number, key: "like" | "save" | "share" | "comment" | "follow", value: boolean) => {
    setPending((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }));
  };

  const onLike = useCallback(
    async (item: VideoItem) => {
      const willLike = !item.viewer.liked;
      const before = { liked: item.viewer.liked, likes: item.stats.likes };
      patchItem(item.id, (d) => ({
        ...d,
        viewer: { ...d.viewer, liked: willLike },
        stats: { ...d.stats, likes: Math.max(0, d.stats.likes + (willLike ? 1 : -1)) },
      }));
      setFlag(item.id, "like", true);
      try {
        const result = await likeVideo(item.postId, willLike ? "like" : null);
        patchItem(item.id, (d) => ({
          ...d,
          viewer: { ...d.viewer, liked: result.liked ?? willLike },
          stats: { ...d.stats, likes: result.likeCount ?? d.stats.likes },
        }));
        if (willLike) {
          void reportActivity(item.id, "like", { value_num: 1, dedupe_key: `${item.id}:like:${Date.now()}` });
        }
      } catch (err) {
        patchItem(item.id, (d) => ({
          ...d,
          viewer: { ...d.viewer, liked: before.liked },
          stats: { ...d.stats, likes: before.likes },
        }));
        say("error", errorMessage(err));
      } finally {
        setFlag(item.id, "like", false);
      }
    },
    [patchItem, say],
  );

  const onSave = useCallback(
    async (item: VideoItem) => {
      const willSave = !item.viewer.saved;
      const before = { saved: item.viewer.saved, saves: item.stats.saves };
      patchItem(item.id, (d) => ({
        ...d,
        viewer: { ...d.viewer, saved: willSave },
        stats: { ...d.stats, saves: Math.max(0, d.stats.saves + (willSave ? 1 : -1)) },
      }));
      setFlag(item.id, "save", true);
      try {
        const result = await saveVideo(item.postId);
        patchItem(item.id, (d) => ({
          ...d,
          viewer: { ...d.viewer, saved: result.saved ?? willSave },
        }));
        if (willSave) void reportActivity(item.id, "save", { value_num: 1, dedupe_key: `${item.id}:save:${Date.now()}` });
        say("success", willSave ? "Saved to your collection." : "Removed from saved.");
      } catch (err) {
        patchItem(item.id, (d) => ({
          ...d,
          viewer: { ...d.viewer, saved: before.saved },
          stats: { ...d.stats, saves: before.saves },
        }));
        say("error", errorMessage(err));
      } finally {
        setFlag(item.id, "save", false);
      }
    },
    [patchItem, say],
  );

  const onShare = useCallback(
    async (item: VideoItem) => {
      const url = absoluteVideoUrl(videoSharePath(item));
      setFlag(item.id, "share", true);
      try {
        const shared = await app.share({ url, title: item.caption || `Video by ${item.author.name}` });
        if (!shared) {
          say("info", "Copy the address from your browser bar to share this video.");
          return;
        }
        const result = await shareVideo(item.postId);
        patchItem(item.id, (d) => ({ ...d, stats: { ...d.stats, shares: result.shareCount ?? d.stats.shares + 1 } }));
        void reportActivity(item.id, "share", { value_num: 1, dedupe_key: `${item.id}:share:${Date.now()}` });
        say("success", "Shared.");
      } catch (err) {
        say("error", errorMessage(err));
      } finally {
        setFlag(item.id, "share", false);
      }
    },
    [app, patchItem, say],
  );

  const onToggleFollow = useCallback(
    async (item: VideoItem) => {
      const follow = !item.author.viewerFollows;
      setFlag(item.id, "follow", true);
      patchItem(item.id, (d) => ({ ...d, author: { ...d.author, viewerFollows: follow } }));
      try {
        const result = await app.toggleFollow(item.author.id, follow);
        const confirmed = result && typeof result === "object" ? Boolean(result.following) : follow;
        patchItem(item.id, (d) => ({ ...d, author: { ...d.author, viewerFollows: confirmed } }));
        if (follow) {
          say("success", `Following ${item.author.name}.`);
          void reportActivity(item.id, "follow_from_video", { value_num: 1, dedupe_key: `${item.id}:follow:${Date.now()}` });
        }
      } catch (err) {
        patchItem(item.id, (d) => ({ ...d, author: { ...d.author, viewerFollows: !follow } }));
        say("error", errorMessage(err));
      } finally {
        setFlag(item.id, "follow", false);
      }
    },
    [app, patchItem, say],
  );

  const openComments = useCallback(
    async (item: VideoItem) => {
      setFlag(item.id, "comment", true);
      setCommentsFor({ item, comments: [] });
      try {
        const detail = await getVideo(item.id);
        setCommentsFor({ item: detail, comments: detail.comments ?? [] });
        patchItem(item.id, (d) => ({
          ...d,
          stats: Number.isFinite(detail.stats?.comments) ? { ...d.stats, comments: detail.stats.comments } : d.stats,
        }));
      } catch (err) {
        say("error", errorMessage(err));
      } finally {
        setFlag(item.id, "comment", false);
      }
    },
    [patchItem, say],
  );

  /* ---------------------------------------------------------------- */
  /* Not interested / mute / report / block (per-video safety paths)    */
  /* ---------------------------------------------------------------- */
  const hideItem = useCallback((id: number) => {
    setHiddenVideos((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const toggleMuteAuthor = useCallback(
    (authorId: number, authorName: string) => {
      const willMute = !mutedAuthors.includes(authorId);
      const next = willMute ? [...mutedAuthors, authorId] : mutedAuthors.filter((id) => id !== authorId);
      setMutedAuthors(next);
      writeIdList(MUTED_AUTHORS_KEY, next);
      say(
        "info",
        willMute
          ? `${authorName || "This creator"} is muted — their videos are hidden from your feeds on every device.`
          : `${authorName || "This creator"} is unmuted and will show in your feeds again.`,
      );
      /* the optimistic list rolls back if the server refuses, so the menu always states reality */
      const request = willMute ? safetyApi.mute(authorId) : safetyApi.unmute(authorId);
      request.catch(() => {
        setMutedAuthors((prev) => {
          const rolled = willMute ? prev.filter(id => id !== authorId) : [...new Set([...prev, authorId])];
          writeIdList(MUTED_AUTHORS_KEY, rolled);
          return rolled;
        });
        say("error", "Could not save that on your account — it will only apply on this device until you are back online.");
      });
    },
    [mutedAuthors, say],
  );

  const onNotInterested = useCallback(
    async (item: VideoItem) => {
      hideItem(item.id);
      say("info", "Hidden. You can re-tune your topics any time from the interests page.");
      const topics = item.topics ?? [];
      if (topics.length === 0 || !app.getSession().isAuthenticated) return;
      /* Durable down-weight: PUT /interests replaces the whole set, so merge the
         cached server echo (mirror) with this clip's topics at weight 0. */
      try {
        const mirror: InterestMirror = { ...readInterestsMirror() };
        for (const slug of topics) mirror[slug] = 0;
        const payload = Object.entries(mirror)
          .slice(0, VIDEO_LIMITS.maxTopics)
          .map(([slug, weight]) => ({ slug, weight }));
        const result = await putInterests(payload);
        if (result.ok) {
          writeInterestsMirror(Object.fromEntries(result.topics.map((t) => [t.slug, t.weight])));
        }
      } catch {
        /* The device-side hide still applies; weights are re-sent on the next interests save. */
      }
    },
    [app, hideItem, say],
  );

  const onCopyLink = useCallback(
    async (item: VideoItem) => {
      const url = absoluteVideoUrl(videoSharePath(item));
      try {
        await navigator.clipboard.writeText(url);
        const result = await shareVideo(item.postId);
        patchItem(item.id, (d) => ({ ...d, stats: { ...d.stats, shares: result.shareCount ?? d.stats.shares + 1 } }));
        void reportActivity(item.id, "share", { value_num: 1, dedupe_key: `${item.id}:share:${Date.now()}` });
        say("success", "Link copied to your clipboard.");
      } catch (err) {
        say("error", "Could not copy the link. " + errorMessage(err));
      }
    },
    [patchItem, say],
  );

  const onReport = useCallback(
    async (item: VideoItem, reason: VideoReportReason) => {
      try {
        await app.reportVideo(item.id, reason);
        say("success", "Report sent to the moderators.");
      } catch (err) {
        say("error", errorMessage(err));
      }
    },
    [app, say],
  );

  const onBlock = useCallback(
    async (item: VideoItem) => {
      try {
        await app.blockUser(item.author.id);
        /* blocking hides both ways server-side; park the author in the mute list too so the menu
           and the local cache agree — never TOGGLE, which could silently unmute right after a block */
        if (!mutedAuthors.includes(item.author.id)) {
          const next = [...mutedAuthors, item.author.id];
          setMutedAuthors(next);
          writeIdList(MUTED_AUTHORS_KEY, next);
          safetyApi.mute(item.author.id).catch(() => { /* the block itself already hides them */ });
        }
        say("success", `Blocked ${item.author.name || "this creator"}. Undo it any time in Settings → Muted & blocked creators.`);
      } catch (err) {
        say("error", errorMessage(err));
      }
    },
    [app, say, mutedAuthors],
  );

  /* ---------------------------------------------------------------- */
  /* Keyboard transport                                                */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (commentsFor || moreFor) return;
      const transport = activeItem ? getVideoTransport(activeItem.id) : null;
      switch (event.key) {
        case "ArrowDown":
        case "PageDown":
          event.preventDefault();
          goTo(activeIndex + 1);
          break;
        case "ArrowUp":
        case "PageUp":
          event.preventDefault();
          goTo(activeIndex - 1);
          break;
        case "ArrowLeft":
          event.preventDefault();
          // Embed transports report duration 0 — they scrub with the provider's own controls.
          if (transport && transport.durationMs() > 0) {
            transport.seek(Math.max(0, transport.currentTimeMs() - 5000));
          }
          break;
        case "ArrowRight":
          event.preventDefault();
          if (transport && transport.durationMs() > 0) {
            transport.seek(Math.min(transport.durationMs(), transport.currentTimeMs() + 5000));
          }
          break;
        case " ":
          event.preventDefault();
          transport?.toggle();
          break;
        case "m":
        case "M":
          setMuted(!muted);
          break;
        case "l":
        case "L":
          if (activeItem) void onLike(activeItem);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, activeItem, commentsFor, moreFor, goTo, muted, setMuted, onLike]);

  /* Deep link: /videos?video=<id> jumps to that slot once it is loaded. */
  useEffect(() => {
    if (!viewingId) return;
    const index = items.findIndex((item) => String(item.id) === viewingId);
    if (index > 0) goTo(index);
  }, [viewingId, items, goTo]);

  const onPlayerActivity = useCallback((event: VideoPlayerActivity) => {
    if (event === "provider_error") setIsPlaying(false);
  }, []);

  const openAuthor = useCallback(
    (item: VideoItem) => navigate(`/profile/${encodeURIComponent(item.author.name || item.author.id)}`),
    [navigate],
  );

  const transport = activeItem ? getVideoTransport(activeItem.id) : null;
  const signedIn = app.getSession().isAuthenticated;

  return (
    <div className="relative h-[100svh] w-full overflow-hidden bg-black">
      {/* Floating chrome over the feed */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col gap-2 px-3 pt-3">
        <div className="pointer-events-auto flex items-center gap-2">
          <Link
            to="/discover"
            aria-label="Back to Discover"
            className="grid h-11 w-11 place-items-center rounded-xl bg-black/40 text-white backdrop-blur transition-colors hover:bg-black/60"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </Link>
          <form
            className="relative flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch(query);
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/70" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setQuery(next);
                if (next.trim() === "") setSearchState(EMPTY_FEED);
                else if (next.trim().length >= 2) void runSearch(next);
              }}
              aria-label="Search videos"
              placeholder="Search videos, topics, people"
              className="h-11 w-full rounded-xl border border-white/20 bg-black/40 pl-9 pr-9 text-sm text-white placeholder:text-white/60 backdrop-blur focus:border-white/40 focus:outline-none"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setSearchState(EMPTY_FEED);
                }}
                aria-label="Clear search"
                className="absolute right-0 top-1/2 grid h-11 w-9 -translate-y-1/2 place-items-center rounded-r-xl text-white/70 hover:text-white"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            ) : null}
          </form>
          <Link
            to="/videos/create"
            className="inline-flex h-11 min-w-11 items-center gap-1.5 rounded-xl bg-accent px-3 text-[13px] font-bold text-accent-ink transition-colors hover:bg-accent-hover"
          >
            <Plus className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Add video</span>
          </Link>
        </div>

        {!query ? (
          <div className="pointer-events-auto flex justify-center">
            <VideoTabBar value={tab} onChange={setTab} reducedMotion={reducedMotion} />
          </div>
        ) : null}
      </header>

      {/* Desktop transport buttons: keyboard is available, but visible controls stay too */}
      <div className="absolute left-3 top-1/2 z-30 hidden -translate-y-1/2 flex-col gap-2 sm:flex">
        <TransportButton label="Previous video" onClick={() => goTo(activeIndex - 1)} disabled={activeIndex === 0}>
          <ChevronUp className="h-5 w-5" aria-hidden />
        </TransportButton>
        <TransportButton
          label={isPlaying ? "Pause" : "Play"}
          onClick={() => transport?.toggle()}
          disabled={!transport}
        >
          {isPlaying ? <Pause className="h-5 w-5" aria-hidden /> : <Play className="h-5 w-5" aria-hidden />}
        </TransportButton>
        <TransportButton label="Next video" onClick={() => goTo(activeIndex + 1)} disabled={activeIndex >= items.length - 1}>
          <ChevronDown className="h-5 w-5" aria-hidden />
        </TransportButton>
        <TransportButton label={muted ? "Unmute" : "Mute"} onClick={() => setMuted(!muted)}>
          {muted ? <VolumeX className="h-5 w-5" aria-hidden /> : <Volume2 className="h-5 w-5" aria-hidden />}
        </TransportButton>
      </div>

      {/* The scroll-snap column */}
      <div
        ref={scrollerRef}
        className={clsx(
          "h-full w-full overflow-y-auto overscroll-y-contain [scrollbar-width:none]",
          reducedMotion ? "" : "scroll-smooth",
        )}
        style={{ scrollSnapType: "y mandatory" }}
      >
        {items.length > 0 ? (
          <div className="h-full w-full">
            {items.map((item, index) => (
              <div
                key={item.id}
                data-slot-index={index}
                ref={(node) => {
                  if (node) slotRefs.current.set(index, node);
                  else slotRefs.current.delete(index);
                }}
                className="h-full w-full"
                style={{ scrollSnapAlign: "start" }}
              >
                <VideoCard
                  item={item}
                  active={index === activeIndex && pageVisible && online}
                  muted={muted}
                  reducedMotion={reducedMotion}
                  onMutedChange={setMuted}
                  pending={pending[item.id]}
                  onLike={() => void onLike(item)}
                  onSave={() => void onSave(item)}
                  onShare={() => void onShare(item)}
                  onComments={() => void openComments(item)}
                  onToggleFollow={() => void onToggleFollow(item)}
                  onMore={() => setMoreFor(item)}
                  onOpenAuthor={signedIn ? () => openAuthor(item) : undefined}
                  onPlayingChange={setIsPlaying}
                  onEnded={activity.noteEnded}
                  onActivity={onPlayerActivity}
                />
              </div>
            ))}
          </div>
        ) : null}

        {items.length === 0 ? (
          <div className="flex h-full items-center justify-center bg-canvas">
            <FeedStatePanel
              status={state.status}
              error={state.error}
              tab={tab}
              isSearch={Boolean(query.trim())}
              online={online}
              onRetry={() => {
                if (query.trim()) void runSearch(query);
                else void loadTab(tab, "first");
              }}
              onSwitchTab={(next) => {
                setQuery("");
                setTab(next);
              }}
              onChooseTopics={() => navigate("/videos/interests")}
            />
          </div>
        ) : null}

        {items.length > 0 && state.status === "ready" && state.nextCursor ? (
          <div className="flex h-16 items-center justify-center bg-black text-[12px] font-semibold text-white/70">
            Scroll for more
          </div>
        ) : null}
      </div>

      {!online ? (
        <div className="absolute inset-x-0 bottom-20 z-30 mx-auto w-fit">
          <VideoNotice
            notice={{ id: 1, tone: "error", message: "You are offline — reconnect to keep watching." }}
            onDismiss={() => undefined}
          />
        </div>
      ) : (
        <div className="absolute inset-x-0 bottom-20 z-30 mx-auto w-fit max-w-md px-3">
          <VideoNotice notice={notice} onDismiss={() => setNotice(null)} />
        </div>
      )}

      {commentsFor ? (
        <VideoComments
          open
          postId={commentsFor.item.postId}
          initialComments={commentsFor.comments}
          canModerate={signedIn && app.getSession().userId === commentsFor.item.author.id}
          onClose={() => setCommentsFor(null)}
          onCountChange={(count) =>
            patchItem(commentsFor.item.id, (d) => ({ ...d, stats: { ...d.stats, comments: count } }))
          }
        />
      ) : null}

      {moreFor ? (
        <VideoMoreMenu
          item={moreFor}
          authorMuted={mutedAuthors.includes(moreFor.author.id)}
          onNotInterested={() => void onNotInterested(moreFor)}
          onToggleMuteAuthor={() => toggleMuteAuthor(moreFor.author.id, moreFor.author.name)}
          onReport={(reason) => void onReport(moreFor, reason)}
          onBlock={() => void onBlock(moreFor)}
          onCopyLink={() => void onCopyLink(moreFor)}
          onClose={() => setMoreFor(null)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TransportButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid h-11 w-11 place-items-center rounded-xl bg-black/40 text-white backdrop-blur transition-colors hover:bg-black/60 disabled:opacity-35"
    >
      {children}
    </button>
  );
}

function FeedStatePanel({
  status,
  error,
  tab,
  isSearch,
  online,
  onRetry,
  onSwitchTab,
  onChooseTopics,
}: {
  status: SlotStatus;
  error: string | null;
  tab: VideoTab;
  isSearch: boolean;
  online: boolean;
  onRetry(): void;
  onSwitchTab(tab: VideoTab): void;
  onChooseTopics(): void;
}) {
  if (!online) {
    return <VideoEmptyState variant="offline" action={{ label: "Try again", onClick: onRetry }} />;
  }
  if (status === "loading" || status === "idle") {
    return <VideoEmptyState variant="loading" />;
  }
  if (status === "error") {
    return (
      <VideoEmptyState
        variant="error"
        body={error ?? undefined}
        action={{ label: "Retry", onClick: onRetry }}
        secondaryAction={tab !== "trending" ? { label: "Try Trending", onClick: () => onSwitchTab("trending") } : undefined}
      />
    );
  }
  if (isSearch) {
    return (
      <VideoEmptyState
        variant="empty"
        title="No videos matched that search"
        body="Try a topic, a person's name, or a hashtag."
        action={{ label: "Back to For You", onClick: () => onSwitchTab("for-you") }}
      />
    );
  }
  if (tab === "following") {
    return (
      <VideoEmptyState
        variant="no-following"
        action={{ label: "Browse Trending", onClick: () => onSwitchTab("trending") }}
      />
    );
  }
  return (
    <VideoEmptyState
      variant="empty"
      action={{ label: "Choose topics", onClick: onChooseTopics }}
      secondaryAction={{ label: "Browse Trending", onClick: () => onSwitchTab("trending") }}
    />
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof VideoApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

function mergeById(existing: VideoItem[], incoming: VideoItem[]): VideoItem[] {
  const seen = new Set(existing.map((item) => item.id));
  return [...existing, ...incoming.filter((item) => !seen.has(item.id))];
}

async function reportActivity(
  videoId: number,
  event: VideoActivityEvent,
  payload: { value_ms?: number; value_num?: number; dedupe_key: string },
): Promise<void> {
  try {
    await postActivity(videoId, { event, ...payload });
  } catch {
    /* Best-effort telemetry: a failed watch-time ping must never interrupt viewing. */
  }
}
