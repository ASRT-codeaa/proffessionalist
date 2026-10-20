import { clsx } from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Info, Loader2, Lock, RotateCcw, Save, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import type { VideoTopic } from "@/services/videos";
import { VIDEO_LIMITS, getTopics, putInterests } from "@/services/videos";
import { VideoApiError } from "@/services/videoHttp";
import { videoApp } from "@/services/videoApp";
import { VideoNotice, type VideoNoticeModel } from "@/components/video/VideoNotice";
import { VideoEmptyState } from "@/components/video/VideoEmptyState";
import { readInterestsMirror, useOnlineStatus, writeInterestsMirror } from "@/components/video/videoHooks";

/** The relevance levels the ranking model understands (weight is 0..1 per the contract). */
const WEIGHTS: { value: number; label: string; hint: string }[] = [
  { value: 0, label: "Off", hint: "Never surface this topic in For You" },
  { value: 0.4, label: "Sometimes", hint: "Show occasionally when nothing better ranks" },
  { value: 0.7, label: "Often", hint: "Weight it above average" },
  { value: 1, label: "Always", hint: "Strong preference — rank it first" },
];

export default function VideoInterestsPage() {
  const app = videoApp();
  const online = useOnlineStatus();
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [saved, setSaved] = useState<Record<string, number>>({});
  const [topics, setTopics] = useState<VideoTopic[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(() =>
    app.getSession().isAuthenticated ? "loading" : "ready",
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<VideoNoticeModel | null>(null);
  const sessionFlag = useRef(false);

  useEffect(() => {
    if (app.getSession().isAuthenticated) return;
    app.requireLogin("/videos/interests");
  }, [app]);

  useEffect(
    () =>
      app.subscribeSessionExpired(() => {
        if (sessionFlag.current) return;
        sessionFlag.current = true;
        app.requireLogin("/videos/interests");
      }),
    [app],
  );

  /**
   * There is NO GET /interests in the contract — PUT replaces the whole set and echoes
   * it back, and the echo is mirrored on this device (videoHooks mirror). This page
   * pre-selects from that mirror; it is the last server-confirmed state, never a claim
   * about what the server holds if the mirror was never written.
   */
  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const page = await getTopics();
      const list = page.items ?? [];
      const mirror = readInterestsMirror();
      setTopics(list);
      const next: Record<string, number> = {};
      for (const topic of list) next[topic.slug] = clamp(mirror[topic.slug] ?? 0);
      setWeights(next);
      setSaved({ ...next });
      setStatus("ready");
    } catch (err) {
      setError(err instanceof VideoApiError ? err.message : "The topic list would not load.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    if (app.getSession().isAuthenticated) void load();
  }, [app, load]);

  const selectedCount = useMemo(
    () => Object.entries(weights).filter(([, weight]) => weight > 0).length,
    [weights],
  );
  const dirty = useMemo(
    () => topics.some((topic) => (weights[topic.slug] ?? 0) !== (saved[topic.slug] ?? 0)),
    [topics, weights, saved],
  );

  const setWeight = (slug: string, value: number) => {
    setWeights((prev) => ({ ...prev, [slug]: value }));
  };

  /** Explicit stances only: weights above 0, plus anything the server previously echoed. */
  const buildPayload = useCallback(
    (state: Record<string, number>) => {
      const mirror = readInterestsMirror();
      const entries = Object.entries(state).filter(
        ([slug, weight]) => weight > 0 || (slug in mirror && mirror[slug] !== weight),
      );
      return entries
        .slice(0, VIDEO_LIMITS.maxTopics)
        .map(([slug, weight]) => ({ slug, weight: clamp(weight) }));
    },
    [],
  );

  const applyEcho = useCallback((echo: { slug: string; weight: number }[]) => {
    const mirror: Record<string, number> = {};
    for (const item of echo) mirror[item.slug] = clamp(item.weight);
    writeInterestsMirror(mirror);
    setSaved(mirror);
    setWeights((prev) => {
      const merged: Record<string, number> = {};
      for (const slug of Object.keys(prev)) merged[slug] = mirror[slug] ?? 0;
      return merged;
    });
  }, []);

  const save = async () => {
    if (!online) {
      setNotice({ id: Date.now(), tone: "error", message: "You are offline — reconnect to save your topics." });
      return;
    }
    setSaving(true);
    try {
      const items = buildPayload(weights);
      const result = await putInterests(items);
      applyEcho(result.topics ?? items);
      setNotice({ id: Date.now(), tone: "success", message: "Saved. For You will re-rank with these topics." });
    } catch (err) {
      setNotice({
        id: Date.now(),
        tone: "error",
        message: err instanceof VideoApiError ? err.message : "Saving failed.",
        actionLabel: "Retry",
        onAction: () => void save(),
      });
    } finally {
      setSaving(false);
    }
  };

  const resetNow = async () => {
    setSaving(true);
    try {
      const result = await putInterests([]);
      applyEcho(result.topics ?? []);
      setNotice({ id: Date.now(), tone: "success", message: "Stored topic weights deleted." });
    } catch (err) {
      setNotice({
        id: Date.now(),
        tone: "error",
        message: err instanceof VideoApiError ? err.message : "Deleting weights failed.",
        actionLabel: "Retry",
        onAction: () => void resetNow(),
      });
    } finally {
      setSaving(false);
    }
  };

  const clearAll = () => {
    const emptied = Object.fromEntries(topics.map((topic) => [topic.slug, 0]));
    setWeights(emptied);
    setNotice({
      id: Date.now(),
      tone: "info",
      message: "All topics cleared locally — press Save to confirm.",
      actionLabel: "Undo",
      onAction: () => setWeights({ ...saved }),
    });
  };

  return (
    <div className="min-h-[100svh] bg-canvas">
      <div className="mx-auto w-full max-w-2xl px-4 pb-20 pt-4 sm:pt-6">
        <header className="mb-4 flex items-center gap-2">
          <Link
            to="/videos"
            aria-label="Back to the video feed"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-line bg-surface text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-ink">
              <Sparkles className="h-5 w-5 text-accent" aria-hidden />
              Video interests
            </h1>
            <p className="text-[13px] text-ink-soft">
              The topics you pick here are the explicit signal behind the For You tab.
            </p>
          </div>
        </header>

        <section className="card p-4" aria-label="Your topics">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] font-bold text-ink">
              {selectedCount === 0 ? "No topics chosen yet" : `${selectedCount} topic${selectedCount === 1 ? "" : "s"} weighted`}
            </p>
            <button
              type="button"
              onClick={clearAll}
              disabled={selectedCount === 0}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-[12.5px] font-bold text-ink-soft transition-colors hover:bg-danger-soft hover:text-danger disabled:opacity-40"
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              Clear all
            </button>
          </div>

          <p className="mb-3 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[12px] text-ink-soft">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
            Saving replaces your whole topic set on the server, and the numbers you see here come back from that save —
            they are the last state the server confirmed on this device.
          </p>

          {status === "loading" ? (
            <ul className="space-y-2" aria-hidden>
              {[0, 1, 2].map((i) => (
                <li key={i}>
                  <div className="skeleton h-14 w-full rounded-xl" />
                </li>
              ))}
            </ul>
          ) : status === "error" ? (
            <VideoEmptyState variant="error" body={error ?? undefined} action={{ label: "Retry", onClick: () => void load() }} />
          ) : topics.length === 0 ? (
            <VideoEmptyState
              variant="empty"
              title="No topics published yet"
              body="The topic taxonomy comes straight from the server. Once it has topics, you can weight them here."
            />
          ) : (
            <ul className="space-y-2.5">
              {topics.map((topic) => {
                const value = weights[topic.slug] ?? 0;
                return (
                  <li key={topic.slug} className="rounded-xl border border-line bg-surface-2/50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[13.5px] font-bold text-ink">
                        {topic.name}
                        <span className="ml-1.5 font-mono text-[11px] font-semibold text-ink-faint">#{topic.slug}</span>
                      </p>
                      <div role="radiogroup" aria-label={`How often to show ${topic.name}`} className="flex flex-wrap gap-1">
                        {WEIGHTS.map((option) => {
                          const active = option.value === value;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              title={option.hint}
                              onClick={() => setWeight(topic.slug, option.value)}
                              className={clsx(
                                "inline-flex min-h-11 items-center gap-1 rounded-lg border px-2.5 text-[12px] font-bold transition-colors",
                                active
                                  ? option.value === 0
                                    ? "border-line-strong bg-surface-2 text-ink"
                                    : "border-accent/35 bg-accent-soft text-accent"
                                  : "border-line bg-surface text-ink-soft hover:bg-surface-2 hover:text-ink",
                              )}
                            >
                              {option.value > 0 ? <span className="tabular-nums">{option.value.toFixed(1)}</span> : null}
                              {option.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <p className="mt-1 text-[11.5px] text-ink-faint">
                      {(WEIGHTS.find((w) => w.value === value) ?? WEIGHTS[0]).hint}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="sticky bottom-0 safe-bottom mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface/95 p-3 shadow-pop backdrop-blur">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !dirty}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-bold text-accent-ink transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
            {saving ? "Saving…" : dirty ? "Save interests" : "Saved"}
          </button>
          <p className="text-[12px] text-ink-faint">
            {dirty ? "You have unsaved changes." : "Nothing to save — these match the last confirmed save."}
          </p>
          <Link
            to="/settings"
            className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-[12.5px] font-bold text-accent transition-colors hover:bg-accent-soft"
          >
            Account privacy settings
          </Link>
        </div>

        <section className="card mt-4 space-y-3 p-4" aria-labelledby="privacy-heading">
          <h2 id="privacy-heading" className="flex items-center gap-2 text-[15px] font-extrabold tracking-tight text-ink">
            <ShieldCheck className="h-4 w-4 text-accent" aria-hidden />
            What we store from your watching, and why
          </h2>
          <p className="text-[13px] leading-relaxed text-ink-soft">
            These are the only video signals kept on the Professionalist backend. They exist to rank the For You tab and to
            report to creators how their clips performed. They are not sold, and they are not used to advertise anything else.
          </p>
          <ul className="space-y-2 text-[13px] text-ink">
            <ActivityRow
              event="impression"
              stores="That a clip appeared in your feed once, with a dedupe key."
              why="So a video is not counted twice, and so we can stop showing things you visibly skipped."
            />
            <ActivityRow
              event="view_start"
              stores="That you opened a clip in the feed."
              why="Separates ‘started watching’ from ‘scroll-past’, which the ranking model weights differently."
            />
            <ActivityRow
              event="watch / complete"
              stores="How many milliseconds you actually watched, and whether you reached the end."
              why="Real watch time is the strongest quality signal we have — it is why the player pauses when a clip is off-screen."
            />
            <ActivityRow
              event="like / save / share / follow_from_video"
              stores="The engagement you chose to record, on the post behind the video."
              why="Explicit preference. Saved videos land in your Saved page; likes tell the creator and rank the topic."
            />
            <ActivityRow
              event="search"
              stores="The text you searched for in the feed."
              why="To fix cases where nothing matched, and to grow the topic list."
            />
          </ul>
          <div className="flex items-start gap-2 rounded-xl bg-surface-2 px-3.5 py-3 text-[12.5px] text-ink-soft">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
            <p>
              Watch-time rows are per-user and per-video with a session-scoped dedupe key; nothing is written to a third-party
              analytics endpoint. Deleting a video, or your account, removes its activity history — see{" "}
              <Link to="/settings" className="font-bold text-accent hover:underline">
                Settings
              </Link>
              .
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void resetNow()}
              disabled={saving || (selectedCount === 0 && Object.keys(saved).length === 0)}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4 text-danger" aria-hidden />
              {selectedCount === 0 && Object.keys(saved).length === 0 ? "Nothing stored to delete" : "Delete stored weights now"}
            </button>
            <p className="text-[12px] text-ink-faint">Resets the explicit topics only — your watch history stays until deletion.</p>
          </div>
        </section>
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 mx-auto w-fit max-w-md px-4">
        <VideoNotice notice={notice} onDismiss={() => setNotice(null)} className="pointer-events-auto" />
      </div>
    </div>
  );
}

function ActivityRow({ event, stores, why }: { event: string; stores: string; why: string }) {
  return (
    <li className="rounded-xl border border-line bg-surface-2/50 px-3.5 py-2.5">
      <p className="font-mono text-[11.5px] font-bold uppercase tracking-wide text-accent">{event}</p>
      <p className="mt-1 text-[12.5px] font-semibold text-ink">{stores}</p>
      <p className="mt-0.5 text-[12.5px] text-ink-soft">{why}</p>
    </li>
  );
}

function clamp(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
