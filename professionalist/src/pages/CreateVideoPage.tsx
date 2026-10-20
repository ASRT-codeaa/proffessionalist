import { clsx } from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clapperboard,
  Film,
  Link2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import type { CreateVideoUploadInput, VideoDetail, VideoTopic } from "@/services/videos";
import {
  VIDEO_LIMITS,
  createVideoByLink,
  createVideoUpload,
  getTopics,
  getVideo,
} from "@/services/videos";
import { VideoApiError } from "@/services/videoHttp";
import { captureThumbnail, probeVideoFile, type VideoProbe } from "@/services/videoMedia";
import { videoApp } from "@/services/videoApp";
import { VideoNotice, type VideoNoticeModel } from "@/components/video/VideoNotice";
import { VideoStateBadge } from "@/components/video/VideoStateBadge";
import { VideoTopicPicker } from "@/components/video/VideoTopicPicker";
import { VideoUploadDropzone } from "@/components/video/VideoUploadDropzone";
import { extractHashtags, formatBytes, formatDuration } from "@/components/video/videoFormat";
import { useOnlineStatus } from "@/components/video/videoHooks";

type Mode = "file" | "link";

interface PreflightCheck {
  label: string;
  ok: boolean;
  /** Advisory only — never blocks the request; the server has the last word. */
  detail: string;
}

/** GET /:id while the clip sits in review. The contract guarantees the author can read
 *  their own pending video, so this is the only honest "what happened to my upload" view. */
interface PollState {
  videoId: number;
  detail: VideoDetail | null;
  status: "polling" | "settled" | "timeout" | "error";
  error: string | null;
}

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 40;

export default function CreateVideoPage() {
  const app = videoApp();
  const navigate = useNavigate();
  const online = useOnlineStatus();

  const [mode, setMode] = useState<Mode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [probe, setProbe] = useState<VideoProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [previewThumbUrl, setPreviewThumbUrl] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [poll, setPoll] = useState<PollState | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<VideoNoticeModel | null>(null);

  /* Topics come from GET /api/videos/topics — the server's taxonomy, slugs and all. */
  const [topicCatalog, setTopicCatalog] = useState<{
    items: VideoTopic[];
    status: "loading" | "ready" | "error";
    error: string | null;
  }>({ items: [], status: "loading", error: null });

  const abortRef = useRef<AbortController | null>(null);
  const pollTimer = useRef<number | null>(null);
  const sessionFlag = useRef(false);

  useEffect(() => {
    if (app.getSession().isAuthenticated) return;
    app.requireLogin("/videos/create");
  }, [app]);

  useEffect(
    () =>
      app.subscribeSessionExpired(() => {
        if (sessionFlag.current) return;
        sessionFlag.current = true;
        app.requireLogin("/videos/create");
      }),
    [app],
  );

  const loadTopics = useCallback(async () => {
    setTopicCatalog((prev) => ({ ...prev, status: "loading", error: null }));
    try {
      const page = await getTopics();
      setTopicCatalog({ items: page.items ?? [], status: "ready", error: null });
    } catch (err) {
      setTopicCatalog((prev) => ({
        ...prev,
        status: "error",
        error: err instanceof VideoApiError ? err.message : "The topic list would not load.",
      }));
    }
  }, []);

  useEffect(() => {
    void loadTopics();
  }, [loadTopics]);

  /* ---------------- pending-video polling (visible failure path) ---------------- */
  const stopPolling = useCallback(() => {
    if (pollTimer.current != null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const startPolling = useCallback(
    (videoId: number) => {
      stopPolling();
      let attempts = POLL_MAX_ATTEMPTS;
      const tick = async () => {
        attempts -= 1;
        let next: PollState;
        try {
          const detail = await getVideo(videoId);
          next =
            detail.moderationState === "pending"
              ? { videoId, detail, status: attempts <= 0 ? "timeout" : "polling", error: null }
              : { videoId, detail, status: "settled", error: null };
        } catch (err) {
          next = {
            videoId,
            detail: null,
            status: "error",
            error: err instanceof VideoApiError ? err.message : "The review status would not load.",
          };
        }
        setPoll((prev) => (prev && prev.videoId !== videoId ? prev : next));
        if (next.status === "polling") {
          pollTimer.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
        }
      };
      pollTimer.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    },
    [stopPolling],
  );

  /* ---------------- file preflight ---------------- */
  const clearPreviewThumb = useCallback(() => {
    setPreviewThumbUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const onFile = useCallback(
    async (picked: File) => {
      clearPreviewThumb();
      setFile(picked);
      setProbe(null);
      setProbing(true);
      const info = await probeVideoFile(picked);
      setProbe(info);
      setProbing(false);
      if (!info.decodeError) {
        /* Local preview only — the videos API takes no thumbnail upload; the server
           generates its own, and external thumbnailUrl strings apply to link posts. */
        const frame = await captureThumbnail(picked);
        if (frame) setPreviewThumbUrl(URL.createObjectURL(frame));
      }
    },
    [clearPreviewThumb],
  );

  useEffect(() => () => clearPreviewThumb(), [clearPreviewThumb]);

  const preflight = useMemo<PreflightCheck[]>(() => {
    if (!file) return [];
    const checks: PreflightCheck[] = [];
    const typeOk =
      VIDEO_LIMITS.acceptedUploadTypes.includes(file.type) ||
      VIDEO_LIMITS.acceptedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext));
    checks.push({
      label: "Container",
      ok: typeOk,
      detail: typeOk ? `${file.type || "by extension"} is on the accepted list.` : "Unsupported container — the server will reject it.",
    });
    const sizeOk = file.size <= VIDEO_LIMITS.maxUploadBytes;
    checks.push({
      label: "Size",
      ok: sizeOk,
      detail: `${formatBytes(file.size)} of ${formatBytes(VIDEO_LIMITS.maxUploadBytes)} allowed.`,
    });
    if (probe) {
      checks.push({
        label: "Duration",
        ok: probe.durationMs > 0,
        detail: probe.durationMs
          ? `${formatDuration(probe.durationMs)} — sent with the file as metadata; the server confirms it.`
          : "No readable duration — the file may be corrupt or unsupported.",
      });
      checks.push({
        label: "Resolution",
        ok: probe.width > 0 && probe.height > 0,
        detail: probe.width ? `${probe.width}×${probe.height} px (vertical 9:16 performs best).` : "Resolution unknown until upload.",
      });
      checks.push({
        label: "Decodes in a browser",
        ok: !probe.decodeError,
        detail: probe.decodeError ?? "Sample frames decoded fine.",
      });
    }
    return checks;
  }, [file, probe]);

  const hashtags = useMemo(() => extractHashtags(caption), [caption]);

  /* ---------------- submit ---------------- */
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setServerErrors({});
    setFormError(null);
    stopPolling();
    setPoll(null);

    if (!online) {
      setFormError("You are offline — reconnect and this form will submit the same values.");
      return;
    }
    if (!app.getSession().isAuthenticated) {
      app.requireLogin("/videos/create");
      return;
    }
    /* The upload endpoint answers 400 fields.caption without one — say so up front. */
    if (mode === "file" && !caption.trim()) {
      setFormError("A caption is required when you upload a file — tell viewers what the clip is about.");
      return;
    }

    setSubmitting(true);
    setProgress(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const created =
        mode === "link"
          ? await createVideoByLink({ url, caption, topics })
          : await createVideoUpload(
              {
                file: file as File,
                caption,
                topics,
                durationMs: probe?.durationMs || null,
                width: probe?.width || null,
                height: probe?.height || null,
                hashtags,
              } satisfies CreateVideoUploadInput,
              { signal: controller.signal, onProgress: (loaded, total) => setProgress({ loaded, total }) },
            );
      const stillPending = created.moderationState === "pending";
      setPoll({ videoId: created.id, detail: created, status: stillPending ? "polling" : "settled", error: null });
      if (stillPending) startPolling(created.id);
      setNotice({ id: Date.now(), tone: "success", message: "Submitted — it is private until a moderator approves it." });
      setFile(null);
      setProbe(null);
      clearPreviewThumb();
      setCaption("");
      setTopics([]);
      setUrl("");
    } catch (err) {
      if (err instanceof VideoApiError) {
        setServerErrors(err.fieldErrors ?? {});
        setFormError(err.message);
        if (err.status === 413) setFormError(`${err.message} A link keeps the video where it is.`);
      } else if (err instanceof DOMException && err.name === "AbortError") {
        setFormError("Upload cancelled.");
      } else {
        setFormError(err instanceof Error ? err.message : "The video would not be submitted.");
      }
    } finally {
      setSubmitting(false);
      setProgress(null);
      abortRef.current = null;
    }
  };

  const canSubmit = mode === "link" ? url.trim().length > 0 : Boolean(file);

  return (
    <div className="min-h-[100svh] bg-canvas">
      <div className="mx-auto w-full max-w-2xl px-4 pb-16 pt-4 sm:pt-6">
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
              <Clapperboard className="h-5 w-5 text-accent" aria-hidden />
              Add a video
            </h1>
            <p className="text-[13px] text-ink-soft">Upload a file or point at a link. Professionalist reviews it before anyone sees it.</p>
          </div>
        </header>

        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-line bg-warn-soft px-3.5 py-3 text-[13px] text-ink">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
          <p>
            <strong className="font-bold">Nothing publishes automatically.</strong> Submitted videos stay{" "}
            <span className="font-semibold">In review</span> and are only added to the feed once a moderator approves them.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="card p-4">
            <div role="radiogroup" aria-label="How do you want to add the video" className="flex gap-2 rounded-xl bg-surface-2 p-1">
              {(
                [
                  { id: "file" as Mode, label: "Upload a file", icon: Upload },
                  { id: "link" as Mode, label: "Paste a link", icon: Link2 },
                ]
              ).map((option) => {
                const Icon = option.icon;
                const selected = mode === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setMode(option.id)}
                    className={clsx(
                      "inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg text-[13px] font-bold transition-colors",
                      selected ? "bg-surface text-ink shadow-card" : "text-ink-soft hover:text-ink",
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    {option.label}
                  </button>
                );
              })}
            </div>

            {mode === "file" ? (
              <div className="mt-4 space-y-3">
                <VideoUploadDropzone
                  onFile={(picked) => void onFile(picked)}
                  disabled={submitting}
                  notice={serverErrors.file ?? serverErrors.video ?? null}
                />
                {file ? (
                  <div className="rounded-xl border border-line bg-surface-2/60 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate text-[13px] font-bold text-ink">
                          <Film className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                          {file.name}
                        </p>
                        <p className="mt-0.5 text-[12px] text-ink-faint">
                          {formatBytes(file.size)}
                          {probe?.durationMs ? ` · ${formatDuration(probe.durationMs)}` : ""}
                          {probe?.width ? ` · ${probe.width}×${probe.height}` : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          abortRef.current?.abort();
                          setFile(null);
                          setProbe(null);
                          clearPreviewThumb();
                        }}
                        aria-label={`Remove ${file.name}`}
                        className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-danger-soft hover:text-danger"
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </button>
                    </div>

                    {previewThumbUrl ? (
                      <img
                        src={previewThumbUrl}
                        alt="Preview frame captured locally from your video"
                        className="mt-2 h-24 w-16 rounded-lg object-cover"
                      />
                    ) : null}

                    {probing ? (
                      <p className="mt-2 flex items-center gap-2 text-[12px] font-semibold text-ink-soft">
                        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
                        Reading the file…
                      </p>
                    ) : null}

                    {preflight.length > 0 ? (
                      <ul className="mt-3 space-y-1.5" aria-label="Local preflight checks">
                        {preflight.map((check) => (
                          <li key={check.label} className="flex items-start gap-2 text-[12.5px]">
                            {check.ok ? (
                              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                            ) : (
                              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
                            )}
                            <span className="min-w-0">
                              <span className="font-bold text-ink">{check.label}: </span>
                              <span className="text-ink-soft">{check.detail}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
                      These checks are advisory. The server re-validates type, size and safety before anything is accepted.
                    </p>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mt-4 space-y-2">
                <label htmlFor="video-link" className="block text-[13px] font-bold text-ink">
                  Video link
                </label>
                <input
                  id="video-link"
                  type="url"
                  inputMode="url"
                  value={url}
                  onChange={(event) => setUrl(event.currentTarget.value)}
                  placeholder="https://youtube.com/watch?v=…"
                  aria-invalid={Boolean(serverErrors.url)}
                  className={clsx(
                    "h-11 w-full rounded-xl border bg-surface px-3.5 text-sm text-ink placeholder:text-ink-faint transition-colors focus:ring-2 focus:ring-[var(--ring)] focus:outline-none",
                    serverErrors.url ? "border-danger" : "border-line focus:border-accent",
                  )}
                />
                {serverErrors.url ? <FieldError message={serverErrors.url} /> : null}
                <p className="text-[12px] text-ink-faint">
                  YouTube, Vimeo or LinkedIn addresses. The server canonicalises the URL itself, rejects anything outside
                  its allowlist, and tells you when the exact video is already in the library.
                </p>
              </div>
            )}
          </div>

          <div className="card space-y-3.5 p-4">
            <div>
              <label htmlFor="video-caption" className="flex items-baseline justify-between text-[13px] font-bold text-ink">
                Caption{mode === "file" ? <span className="text-danger">*</span> : <span className="text-[11.5px] font-semibold text-ink-faint">optional</span>}
                <span className="text-[11.5px] font-semibold text-ink-faint">
                  {caption.length}/{VIDEO_LIMITS.maxCaptionLength}
                </span>
              </label>
              <textarea
                id="video-caption"
                value={caption}
                maxLength={VIDEO_LIMITS.maxCaptionLength}
                rows={3}
                required={mode === "file"}
                onChange={(event) => setCaption(event.currentTarget.value)}
                placeholder="Add context, a takeaway, and a few #hashtags"
                aria-invalid={Boolean(serverErrors.caption)}
                className={clsx(
                  "mt-1.5 w-full resize-y rounded-xl border bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint transition-colors focus:border-accent focus:ring-2 focus:ring-[var(--ring)] focus:outline-none",
                  serverErrors.caption ? "border-danger" : "border-line",
                )}
              />
              {serverErrors.caption ? <FieldError message={serverErrors.caption} /> : null}
              {hashtags.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Hashtags detected in the caption">
                  {hashtags.slice(0, 8).map((tag) => (
                    <li
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-[11.5px] font-bold text-accent"
                    >
                      #{tag}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            {topicCatalog.status === "error" ? (
              <div role="alert" className="rounded-xl border border-danger/30 bg-danger-soft p-3">
                <p className="text-[12.5px] font-semibold text-danger">{topicCatalog.error}</p>
                <button
                  type="button"
                  onClick={() => void loadTopics()}
                  className="mt-1.5 inline-flex min-h-11 items-center gap-1.5 text-[12.5px] font-bold text-accent hover:underline"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Retry topics
                </button>
              </div>
            ) : topicCatalog.status === "loading" ? (
              <div className="flex flex-wrap gap-2" aria-label="Loading topics" aria-busy>
                {[0, 1, 2, 3, 4].map((index) => (
                  <span key={`topic-skeleton-${index}`} className="skeleton inline-block h-11 w-24 rounded-full" aria-hidden />
                ))}
              </div>
            ) : (
              <VideoTopicPicker
                options={topicCatalog.items.map((topic) => ({ value: topic.slug, label: topic.name }))}
                selected={topics}
                max={VIDEO_LIMITS.maxTopics}
                error={serverErrors.topics ?? null}
                hint="Topics tune who sees this clip in For You."
                onChange={setTopics}
              />
            )}
          </div>

          {formError ? (
            <div role="alert" className="card border-danger/40 bg-danger-soft p-3.5">
              <p className="flex items-start gap-2 text-[13px] font-semibold text-danger">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {formError}
              </p>
            </div>
          ) : null}

          {submitting && progress ? (
            <div className="card p-3.5">
              <p className="mb-2 text-[12.5px] font-bold text-ink">
                Uploading {Math.round((progress.loaded / Math.max(1, progress.total)) * 100)}% ·{" "}
                {formatBytes(progress.loaded)} of {formatBytes(progress.total)}
              </p>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round((progress.loaded / Math.max(1, progress.total)) * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div
                  className="h-full bg-accent transition-[width] duration-150 motion-reduce:transition-none"
                  style={{ width: `${Math.min(100, (progress.loaded / Math.max(1, progress.total)) * 100)}%` }}
                />
              </div>
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-2"
              >
                <X className="h-4 w-4" aria-hidden />
                Cancel upload
              </button>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={submitting || !canSubmit}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-5 text-sm font-bold text-accent-ink transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
              {mode === "link" ? "Submit link" : "Upload & submit"}
            </button>
            <p className="text-[12px] text-ink-faint">
              Goes straight to review — it is not visible publicly until approved.
            </p>
          </div>

          {poll ? <SubmissionStatusCard poll={poll} onRetry={() => startPolling(poll.videoId)} onOpenFeed={() => navigate("/videos")} /> : null}
        </form>

        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 mx-auto w-fit max-w-md px-4">
          <VideoNotice notice={notice} onDismiss={() => setNotice(null)} className="pointer-events-auto" />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SubmissionStatusCard({
  poll,
  onRetry,
  onOpenFeed,
}: {
  poll: PollState;
  onRetry(): void;
  onOpenFeed(): void;
}) {
  const detail = poll.detail;
  const state = detail ? String(detail.moderationState) : "pending";
  return (
    <div role="status" aria-live="polite" className="card anim-fade-up space-y-2 p-4">
      <p className="flex items-center gap-2 text-sm font-bold text-ink">
        {poll.status === "settled" && state === "approved" ? (
          <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
        ) : (
          <Loader2 className={clsx("h-4 w-4 text-accent", poll.status === "polling" && "animate-spin motion-reduce:animate-none")} aria-hidden />
        )}
        {poll.status === "polling"
          ? "Waiting for review"
          : poll.status === "settled" && state === "approved"
            ? "Approved and published"
            : poll.status === "settled" && state === "removed"
              ? "The moderator did not approve it"
              : poll.status === "settled"
                ? `Review finished — ${state}`
                : poll.status === "timeout"
                  ? "Still in review"
                  : "Could not check the review status"}
      </p>
      {detail ? (
        <p className="line-clamp-2 text-[13px] text-ink-soft">{detail.caption || `Video ${detail.id}`}</p>
      ) : null}
      {poll.status === "error" ? (
        <p className="text-[13px] font-semibold text-danger">{poll.error}</p>
      ) : null}
      {poll.status === "timeout" ? (
        <p className="text-[13px] text-ink-soft">
          Moderation is slower than usual. Your video stays private until a decision is made — check again below or open it
          directly from the feed address <span className="font-mono text-[12px]">/videos?video={poll.videoId}</span>.
        </p>
      ) : null}
      {poll.status === "polling" ? (
        <p className="text-[12px] text-ink-faint">Checking every few seconds. This video is only visible to you until it is approved.</p>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-1">
        <VideoStateBadge state={state} />
        {poll.status === "error" || poll.status === "timeout" ? (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-2"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Check again
          </button>
        ) : null}
        {poll.status === "settled" && state === "approved" ? (
          <button
            type="button"
            onClick={onOpenFeed}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-accent px-3.5 text-[13px] font-bold text-accent-ink transition-colors hover:bg-accent-hover"
          >
            Open the feed
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FieldError({ message }: { message: string }) {
  return (
    <p role="alert" className="mt-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-danger">
      <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
      {message}
    </p>
  );
}
