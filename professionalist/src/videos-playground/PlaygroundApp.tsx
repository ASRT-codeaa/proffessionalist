import { useCallback, useEffect, useMemo, useState } from "react";
import { createBrowserRouter, Link, RouterProvider, useNavigate, useSearchParams, type RouteObject } from "react-router-dom";
import { Clapperboard, FlaskConical, Moon, RotateCcw, ShieldAlert, Sparkles, Sun, Upload, User } from "lucide-react";
import { clsx } from "clsx";
import videosRoutes from "@/routes/videosRoutes";
import { VideoCard } from "@/components/video/VideoCard";
import { VideoComments } from "@/components/video/VideoComments";
import { useFeedMuted, usePrefersReducedMotion } from "@/components/video/videoHooks";
import { likeVideo, saveVideo, shareVideo } from "@/services/videos";
import type { VideoItem } from "@/services/videos";
import { videoApiBaseUrl } from "@/services/videoHttp";
import { configureVideoApp, videoApp } from "@/services/videoApp";
import { FIXTURE_ITEMS } from "./fixtures/contractShapes";

/**
 * Harness for the video subtree while the rest of src/ is absent from this checkout.
 * Everything it injects is fixtures (src/videos-playground/fixtures) or a pointer at the
 * dev-only stub server — the pages/components themselves are the real ones and they call
 * the documented endpoints over HTTP.
 */

let signedIn = true;
const sessionListeners = new Set<() => void>();
const navigateRef = { current: null as null | ((path: string) => void) };

function setSignedIn(next: boolean) {
  signedIn = next;
  for (const listener of sessionListeners) listener();
}

configureVideoApp({
  getSession: () => ({
    userId: signedIn ? 99 : null,
    displayName: signedIn ? "You (playground)" : null,
    isAuthenticated: signedIn,
    hasToken: signedIn,
  }),
  requireLogin: (returnTo) => {
    // The real app pushes its own /login route with state.from; here we show that gate.
    navigateRef.current?.(`/__login?next=${encodeURIComponent(returnTo)}`);
  },
  subscribeSessionExpired: (listener) => {
    sessionListeners.add(listener);
    return () => {
      sessionListeners.delete(listener);
    };
  },
});

function useSimulatedSession(): boolean {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    sessionListeners.add(listener);
    return () => {
      sessionListeners.delete(listener);
    };
  }, []);
  return signedIn;
}

function Home() {
  const navigate = useNavigate();
  const signed = useSimulatedSession();
  const [dark, setDark] = useState(false);
  const [activity, setActivity] = useState<{ activity: { event: string; dedupe_key: string; value_ms?: number }[]; following: string[]; interestCount: number } | null>(null);

  useEffect(() => {
    navigateRef.current = (path: string) => navigate(path);
    return () => {
      navigateRef.current = null;
    };
  }, [navigate]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      fetch("/api/_stub/state")
        .then((res) => res.json())
        .then((state) => {
          if (!cancelled) setActivity(state);
        })
        .catch(() => undefined);
    tick();
    const timer = window.setInterval(tick, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="min-h-[100svh] bg-canvas">
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
        <header className="card space-y-3 p-4">
          <p className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-widest text-accent">
            <FlaskConical className="h-4 w-4" aria-hidden />
            Videos UI playground — dev only
          </p>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">Professionalist Videos, mounted standalone</h1>
          <p className="text-[13px] leading-relaxed text-ink-soft">
            The three real pages below are the shipped components. Fixture data lives only in{" "}
            <code className="rounded bg-surface-2 px-1 font-mono text-[12px]">src/videos-playground/fixtures</code> and is
            served by <code className="rounded bg-surface-2 px-1 font-mono text-[12px]">stub-server.mjs</code> on{" "}
            <code className="rounded bg-surface-2 px-1 font-mono text-[12px]">/api/…</code>; the pages themselves only talk to
            documented endpoints. API base in use:{" "}
            <strong className="font-bold text-ink">{videoApiBaseUrl() || "(same origin, proxied)"}</strong>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setSignedIn(!signed)}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3.5 text-[13px] font-bold text-ink transition-colors hover:bg-surface-2"
            >
              <User className="h-4 w-4 text-accent" aria-hidden />
              Session: {signed ? "signed in" : "signed out"}
            </button>
            <button
              type="button"
              onClick={() => setDark((value) => !value)}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3.5 text-[13px] font-bold text-ink transition-colors hover:bg-surface-2"
            >
              {dark ? <Sun className="h-4 w-4 text-warn" aria-hidden /> : <Moon className="h-4 w-4 text-accent" aria-hidden />}
              {dark ? "Light" : "Dark"} tokens
            </button>
            {!signed ? (
              <span className="inline-flex items-center gap-1.5 rounded-xl bg-warn-soft px-3 py-2 text-[12px] font-bold text-warn">
                <ShieldAlert className="h-4 w-4" aria-hidden />
                Signing out makes the video pages hand off to the app’s login redirect.
              </span>
            ) : null}
          </div>
        </header>

        <nav className="grid gap-3 sm:grid-cols-2" aria-label="Playground destinations">
          <HarnessLink to="/videos" title="Video feed" blurb="Vertical snap feed · tabs · activity pings" icon={Clapperboard} />
          <HarnessLink to="/videos/create" title="Add a video" blurb="File or link, preflight, real upload progress, review polling" icon={Upload} />
          <HarnessLink to="/videos/interests" title="Video interests" blurb="Topic weights + what we store" icon={Sparkles} />
          <HarnessLink to="/videos/admin" title="Video admin (staff)" blurb="Moderation queue · rank weights · discovery run" icon={ShieldAlert} />
          <div className="card p-3">
            <p className="mb-2 text-[12px] font-bold uppercase tracking-wide text-ink-faint">Component bench</p>
            <VideoCardBench />
          </div>
        </nav>

        <section className="card space-y-2 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[13px] font-extrabold text-ink">Activity the stub has received</h2>
            <button
              type="button"
              onClick={() => {
                setActivity(null);
                fetch("/api/_stub/state")
                  .then((res) => res.json())
                  .then(setActivity)
                  .catch(() => undefined);
              }}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-2.5 text-[12.5px] font-bold text-accent transition-colors hover:bg-accent-soft"
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              Refresh
            </button>
          </div>
          <p className="text-[12px] text-ink-faint">
            Live POST /api/videos/:id/activity payloads (watch ms, completion, engagement), deduped by{" "}
            <code className="font-mono">dedupe_key</code>.
          </p>
          {!activity ? (
            <p className="text-[12.5px] text-ink-soft">No read yet.</p>
          ) : (
            <>
              <p className="text-[12px] font-semibold text-ink-soft">
                {activity.activity.length} event(s) · {activity.following.length} follow(s) · {activity.interestCount} interest
                weight(s)
              </p>
              <ul className="max-h-52 space-y-1 overflow-y-auto font-mono text-[11.5px] text-ink-soft">
                {activity.activity
                  .slice()
                  .reverse()
                  .map((row, index) => (
                    <li key={`${row.dedupe_key}-${index}`} className="truncate">
                      <span className="font-bold text-accent">{row.event}</span> {row.value_ms ? `${row.value_ms}ms ` : ""}
                      <span className="text-ink-faint">{row.dedupe_key}</span>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function HarnessLink({
  to,
  title,
  blurb,
  icon: Icon,
}: {
  to: string;
  title: string;
  blurb: string;
  icon: typeof Clapperboard;
}) {
  return (
    <Link
      to={to}
      className="card flex items-start gap-3 p-3 transition-colors hover:bg-surface-2"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-bold text-ink">{title}</span>
        <span className="block text-[12px] text-ink-soft">{blurb}</span>
        <span className="mt-0.5 block font-mono text-[11px] text-ink-faint">{to}</span>
      </span>
    </Link>
  );
}

/** The same component the feed renders, driven by one fixture VIDEO_ITEM. */
function VideoCardBench() {
  const [index, setIndex] = useState(0);
  const [item, setItem] = useState<VideoItem>(FIXTURE_ITEMS[index]);
  const [muted, setMuted] = useFeedMuted();
  const reducedMotion = usePrefersReducedMotion();
  const [pending, setPending] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setItem(FIXTURE_ITEMS[index]);
  }, [index]);

  const patch = useCallback((next: (prev: VideoItem) => VideoItem) => setItem((prev) => next(prev)), []);

  const act = useMemo(
    () => ({
      like: async () => {
        const willLike = !item.viewer.liked;
        patch((prev) => ({
          ...prev,
          viewer: { ...prev.viewer, liked: willLike },
          stats: { ...prev.stats, likes: prev.stats.likes + (willLike ? 1 : -1) },
        }));
        setPending((prev) => ({ ...prev, like: true }));
        try {
          const result = await likeVideo(item.postId, willLike ? "like" : null);
          patch((prev) => ({
            ...prev,
            viewer: { ...prev.viewer, liked: result.liked },
            stats: { ...prev.stats, likes: result.likeCount },
          }));
        } finally {
          setPending((prev) => ({ ...prev, like: false }));
        }
      },
      save: async () => {
        const willSave = !item.viewer.saved;
        patch((prev) => ({ ...prev, viewer: { ...prev.viewer, saved: willSave } }));
        setPending((prev) => ({ ...prev, save: true }));
        try {
          const result = await saveVideo(item.postId);
          patch((prev) => ({
            ...prev,
            viewer: { ...prev.viewer, saved: result.saved ?? willSave },
            stats: { ...prev.stats, saves: prev.stats.saves + (result.saved ?? willSave ? 1 : -1) },
          }));
        } finally {
          setPending((prev) => ({ ...prev, save: false }));
        }
      },
      share: async () => {
        setPending((prev) => ({ ...prev, share: true }));
        try {
          const shared = await videoApp().share({ url: window.location.origin + `/videos/${item.id}`, title: item.caption });
          if (shared) {
            await shareVideo(item.postId);
            patch((prev) => ({ ...prev, stats: { ...prev.stats, shares: prev.stats.shares + 1 } }));
          }
        } finally {
          setPending((prev) => ({ ...prev, share: false }));
        }
      },
    }),
    [item, patch],
  );

  const [commentsOpen, setCommentsOpen] = useState(false);
  const [followPending, setFollowPending] = useState(false);

  const follow = async () => {
    setFollowPending(true);
    const willFollow = !item.author.viewerFollows;
    patch((prev) => ({ ...prev, author: { ...prev.author, viewerFollows: willFollow } }));
    try {
      const result = await videoApp().toggleFollow(item.author.id, willFollow);
      const confirmed = result && typeof result === "object" ? Boolean(result.following) : willFollow;
      patch((prev) => ({ ...prev, author: { ...prev.author, viewerFollows: confirmed } }));
    } catch {
      patch((prev) => ({ ...prev, author: { ...prev.author, viewerFollows: !willFollow } }));
    } finally {
      setFollowPending(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="relative mx-auto h-[420px] w-full max-w-[240px] overflow-hidden rounded-2xl border border-line">
        <VideoCard
          item={item}
          active
          muted={muted}
          reducedMotion={reducedMotion}
          onMutedChange={setMuted}
          onLike={() => void act.like()}
          onSave={() => void act.save()}
          onShare={() => void act.share()}
          onComments={() => setCommentsOpen(true)}
          onToggleFollow={() => void follow()}
          pending={{ ...pending, follow: followPending }}
        />
        {commentsOpen ? (
          <VideoComments
            open
            postId={item.postId}
            initialComments={[]}
            onClose={() => setCommentsOpen(false)}
            onCountChange={(count) => patch((prev) => ({ ...prev, stats: { ...prev.stats, comments: count } }))}
          />
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {FIXTURE_ITEMS.map((fixture, i) => (
          <button
            key={fixture.id}
            type="button"
            onClick={() => setIndex(i)}
            aria-pressed={i === index}
            className={clsx(
              "inline-flex min-h-9 items-center gap-1 rounded-lg border px-2.5 text-[11.5px] font-bold transition-colors",
              i === index ? "border-accent/35 bg-accent-soft text-accent" : "border-line bg-surface text-ink-soft hover:bg-surface-2",
            )}
          >
            {fixture.provider}
            {fixture.playUrl?.includes("does-not-exist") ? " · broken" : ""}
          </button>
        ))}
      </div>
      <p className="text-[11.5px] leading-relaxed text-ink-faint">
        Bench buttons are wired to the real service functions, so like/save/share round-trip to the stub. The Comments and
        Follow handlers here are no-ops on purpose — exercise them in the full feed.
      </p>
    </div>
  );
}

function LoginSim() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") || "/videos";
  return (
    <div className="grid min-h-[100svh] place-items-center bg-canvas px-4">
      <div className="card w-full max-w-md space-y-3 p-5 text-center">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-accent-soft text-accent">
          <ShieldAlert className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="text-lg font-extrabold tracking-tight text-ink">Login gate reached</h1>
        <p className="text-[13px] leading-relaxed text-ink-soft">
          The video pages do not render for an anonymous visitor: <code className="font-mono">requireLogin(&quot;{next}&quot;)</code>{" "}
          was called. In the real tree this is the app’s own <code className="font-mono">/login</code> route with{" "}
          <code className="font-mono">state.from</code>, so a successful sign-in returns to the feed.
        </p>
        <div className="flex flex-wrap justify-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => {
              setSignedIn(true);
              navigate(next);
            }}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-bold text-accent-ink transition-colors hover:bg-accent-hover"
          >
            Sign in (playground)
          </button>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="inline-flex min-h-11 items-center rounded-xl border border-line bg-surface px-4 text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
          >
            Back to harness
          </button>
        </div>
      </div>
    </div>
  );
}

const harnessRoutes: RouteObject[] = [
  { path: "/", element: <Home /> },
  ...videosRoutes,
  { path: "/__login", element: <LoginSim /> },
];

const router = createBrowserRouter(harnessRoutes);

export function PlaygroundApp() {
  return <RouterProvider router={router} />;
}
