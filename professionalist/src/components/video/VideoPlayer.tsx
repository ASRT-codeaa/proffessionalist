import { useCallback, useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { AlertTriangle, ExternalLink, Play, RefreshCw, Volume2 } from "lucide-react";
import type { VideoItem } from "@/services/videos";
import { isPlayableDirectly } from "@/services/videos";
import { videoHttp } from "@/services/videoHttp";
import { formatDuration } from "./videoFormat";
import { VideoProgressBar } from "./VideoProgressBar";

export type VideoPlayerStatus = "unconfigured" | "idle" | "loading" | "playing" | "paused" | "error" | "external";

export type VideoPlayerActivity = "play" | "pause" | "provider_error";

export interface VideoPlayerProps {
  item: VideoItem;
  /** Only the active feed slot plays; anything else is paused and shows its poster. */
  active: boolean;
  muted: boolean;
  loop?: boolean;
  reducedMotion?: boolean;
  onMutedChange(muted: boolean): void;
  onPlayingChange?(playing: boolean): void;
  onEnded?(): void;
  /** Transport-level signals; watch-time accounting itself lives in useVideoActivity. */
  onActivity?(event: VideoPlayerActivity): void;
  className?: string;
}

export interface VideoTransport {
  toggle(): void;
  seek(timeMs: number): void;
  isPaused(): boolean;
  durationMs(): number;
  currentTimeMs(): number;
}

interface PlayerTelemetry {
  currentTimeMs: number;
  durationMs: number;
  bufferedMs: number;
}

/**
 * The feed's media surface: a <video> element for direct files, an explicit
 * "watch on the provider" panel for external providers, plus retry/error states that map
 * to real causes (no source, network failure, autoplay refusal). Autoplay is muted-first
 * per browser policy, and the element is paused whenever the slot stops being active.
 */
export function VideoPlayer({
  item,
  active,
  muted,
  loop = true,
  reducedMotion = false,
  onMutedChange,
  onPlayingChange,
  onEnded,
  onActivity,
  className,
}: VideoPlayerProps) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const embedRef = useRef<HTMLIFrameElement | null>(null);
  const [telemetry, setTelemetry] = useState<PlayerTelemetry>({ currentTimeMs: 0, durationMs: 0, bufferedMs: 0 });
  const [needsGesture, setNeedsGesture] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [embedLaunched, setEmbedLaunched] = useState(false);
  const [embedPlaying, setEmbedPlaying] = useState(false);
  const [status, setStatus] = useState<VideoPlayerStatus>(() => initialStatus(item));
  /** Autoplay intent: false after a user pause so nothing resumes playback behind their finger. */
  const wantPlayRef = useRef(true);
  const statusRef = useRef<VideoPlayerStatus>(status);

  const playUrl = item.playUrl ? videoHttp().mediaUrl(item.playUrl) : "";
  const poster = item.thumbnailUrl ? videoHttp().mediaUrl(item.thumbnailUrl) : undefined;
  const directPlayback = isPlayableDirectly(item);
  const totalMs = telemetry.durationMs || item.durationMs || 0;
  /* a link row with a server-built embed plays in-page once the viewer taps — the tap itself is
     the user gesture autoplay policies demand; without the tap the provider loads nothing */
  const embed = item.kind === "link" ? item.embedUrl : null;
  const showEmbed = Boolean(embed) && embedLaunched && active;

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    const next = initialStatus(item);
    statusRef.current = next;
    setStatus(next);
    setTelemetry({ currentTimeMs: 0, durationMs: item.durationMs || 0, bufferedMs: 0 });
    setNeedsGesture(false);
    setEmbedLaunched(false);
    setEmbedPlaying(false);
    wantPlayRef.current = true;
  }, [item.id, item.playUrl, item.provider, item.durationMs]);

  /** Plays when the slot becomes active, pauses when it leaves — never two at once. */
  useEffect(() => {
    const el = ref.current;
    if (!el || !directPlayback) return;
    const current = statusRef.current;
    if (current === "error" || current === "unconfigured") return;
    if (!active) {
      if (!el.paused) {
        el.pause();
        onPlayingChange?.(false);
        onActivity?.("pause");
      }
      if (current === "playing") setStatus("paused");
      wantPlayRef.current = true;
      return;
    }
    // `status` deliberately is not a dep: it used to be, and every user pause flipped it
    // and re-ran this effect straight back into el.play(). Pause never stuck.
    if (!wantPlayRef.current) return;
    const attempt = el.play();
    if (attempt && typeof attempt.then === "function") {
      attempt
        .then(() => {
          setNeedsGesture(false);
          onPlayingChange?.(true);
          onActivity?.("play");
        })
        .catch(() => {
          // Autoplay refused (sound without a gesture, or data-saver): offer tap-to-play.
          setNeedsGesture(true);
          onPlayingChange?.(false);
        });
    }
  }, [active, directPlayback, muted, reloadToken, playUrl, onActivity, onPlayingChange]);

  const syncTelemetry = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setTelemetry((prev) => {
      const next: PlayerTelemetry = {
        currentTimeMs: (el.currentTime || 0) * 1000,
        durationMs: Number.isFinite(el.duration) ? el.duration * 1000 : prev.durationMs,
        bufferedMs: bufferedEnd(el) * 1000,
      };
      if (
        Math.abs(next.currentTimeMs - prev.currentTimeMs) < 90 &&
        Math.abs(next.durationMs - prev.durationMs) < 90 &&
        Math.abs(next.bufferedMs - prev.bufferedMs) < 900
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const togglePlay = useCallback(() => {
    const el = ref.current;
    if (!el || !directPlayback) return;
    if (el.paused) {
      wantPlayRef.current = true;
      const attempt = el.play();
      attempt
        ?.then(() => {
          setNeedsGesture(false);
          onPlayingChange?.(true);
          onActivity?.("play");
        })
        .catch(() => setNeedsGesture(true));
    } else {
      wantPlayRef.current = false;
      el.pause();
      onPlayingChange?.(false);
      onActivity?.("pause");
    }
  }, [directPlayback, onActivity, onPlayingChange]);

  const seekTo = useCallback(
    (timeMs: number) => {
      const el = ref.current;
      if (!el || !Number.isFinite(el.duration)) return;
      el.currentTime = Math.min(Math.max(0, timeMs / 1000), el.duration);
      syncTelemetry();
    },
    [syncTelemetry],
  );

  /**
   * Lets the feed's keyboard shortcuts and desktop transport buttons drive whichever
   * player is active, without lifting the <video> ref into the page.
   */
  useEffect(() => {
    if (!active || !directPlayback) return;
    const transport: VideoTransport = {
      toggle: togglePlay,
      seek: seekTo,
      isPaused: () => Boolean(ref.current?.paused),
      durationMs: () => totalMs,
      currentTimeMs: () => telemetry.currentTimeMs,
    };
    transportSinks.set(item.id, transport);
    return () => {
      if (transportSinks.get(item.id) === transport) transportSinks.delete(item.id);
    };
  }, [active, directPlayback, item.id, togglePlay, seekTo, telemetry.currentTimeMs, totalMs]);

  /**
   * Leaving the slot unmounts the provider iframe outright: its audio stops, and coming back
   * replays from a fresh user tap instead of an autoplay=1 remount the browser will refuse.
   */
  useEffect(() => {
    if (!active) {
      setEmbedLaunched(false);
      setEmbedPlaying(false);
    }
  }, [active]);

  /**
   * Page keyboard/transport buttons for a launched embed go through the provider command
   * APIs over postMessage (play/pause only); seek and duration stay the provider player's own job.
   */
  useEffect(() => {
    if (!showEmbed || !embed) return;
    const vimeo = item.provider === "vimeo";
    const targetOrigin = frameOrigin(embed);
    const transport: VideoTransport = {
      toggle: () => {
        const next = !embedPlaying;
        const frame = embedRef.current;
        if (frame?.contentWindow) {
          const payload = vimeo
            ? JSON.stringify({ method: next ? "play" : "pause" })
            : JSON.stringify({ event: "command", func: next ? "playVideo" : "pauseVideo", args: [] });
          frame.contentWindow.postMessage(payload, targetOrigin);
        }
        setEmbedPlaying(next);
      },
      seek: () => {},
      isPaused: () => !embedPlaying,
      durationMs: () => 0,
      currentTimeMs: () => 0,
    };
    transportSinks.set(item.id, transport);
    return () => {
      if (transportSinks.get(item.id) === transport) transportSinks.delete(item.id);
    };
  }, [showEmbed, embed, embedPlaying, item.id, item.provider]);

  const unmute = () => {
    const el = ref.current;
    onMutedChange(false);
    if (!el) return;
    el.muted = false;
    setNeedsGesture(false);
    wantPlayRef.current = true;
    const attempt = el.play();
    attempt?.catch(() => setNeedsGesture(true));
  };

  if (!directPlayback) {
    const sourceUrl = (/^https?:/i.test(item.playUrl) ? item.playUrl : "") || playUrl;
    if (showEmbed && embed) {
      return (
        <div className={clsx("relative h-full w-full overflow-hidden bg-black", className)} data-video-player={item.id}>
          <iframe
            ref={embedRef}
            src={embedSrc(embed, item.provider)}
            className="absolute inset-0 h-full w-full border-0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
            title={item.caption || `Video by ${item.author.name}`}
          />
        </div>
      );
    }
    return (
      <div className={clsx("relative grid h-full w-full place-items-center overflow-hidden bg-black", className)}>
        {poster ? <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover opacity-35" /> : null}
        <div className="relative flex max-w-sm flex-col items-center gap-3 px-6 text-center">
          {embed ? (
            <button
              type="button"
              onClick={() => {
                setEmbedLaunched(true);
                setEmbedPlaying(true);
              }}
              className="grid h-16 w-16 place-items-center rounded-full bg-white/95 text-ink shadow-lg transition-transform hover:scale-105"
              aria-label={`Play on ${providerName(item.provider)}`}
            >
              <Play className="h-7 w-7" aria-hidden />
            </button>
          ) : (
            <p className="text-sm font-semibold text-white/90">
              {item.kind === "indexed"
                ? "This clip was indexed from an outside source and plays in their player."
                : "This video is hosted on an external link and plays there."}
            </p>
          )}
          <a
            href={sourceUrl || "#"}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white/95 px-4 text-sm font-semibold text-ink transition-colors hover:bg-white"
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
            Watch on {providerName(item.provider)}
          </a>
        </div>
      </div>
    );
  }

  const unavailable = status === "unconfigured" || !playUrl;

  return (
    <div className={clsx("relative h-full w-full overflow-hidden bg-black", className)} data-video-player={item.id}>
      <video
        ref={ref}
        key={`${item.id}:${reloadToken}`}
        className="h-full w-full object-contain"
        src={playUrl || undefined}
        poster={poster}
        preload={active ? "auto" : "metadata"}
        muted={muted}
        loop={loop}
        playsInline
        autoPlay={active && !unavailable}
        aria-label={item.caption || `Video by ${item.author.name}`}
        onLoadedMetadata={syncTelemetry}
        onTimeUpdate={syncTelemetry}
        onProgress={syncTelemetry}
        onPlay={() => setStatus("playing")}
        onPause={() => setStatus((prev) => (prev === "error" || prev === "unconfigured" ? prev : "paused"))}
        onWaiting={() => setStatus((prev) => (prev === "error" || prev === "unconfigured" ? prev : "loading"))}
        onPlaying={() => setStatus("playing")}
        onCanPlay={() => setStatus((prev) => (prev === "error" || prev === "unconfigured" ? prev : "playing"))}
        onEnded={() => {
          setStatus("paused");
          onPlayingChange?.(false);
          onEnded?.();
        }}
        onError={() => setStatus(playUrl ? "error" : "unconfigured")}
        onClick={togglePlay}
      />

      {active && status !== "playing" && !unavailable ? (
        <div className="pointer-events-none absolute inset-0">
          {poster ? (
            <img
              src={poster}
              alt=""
              className={clsx("h-full w-full object-cover", status === "loading" && "opacity-75")}
            />
          ) : null}
        </div>
      ) : null}

      <div
        data-transport-zone
        className="absolute inset-x-0 bottom-0 z-30 flex flex-col gap-1 bg-gradient-to-t from-black/70 via-black/25 to-transparent px-3 pb-2 pt-8"
      >
        <VideoProgressBar
          currentTimeMs={telemetry.currentTimeMs}
          durationMs={totalMs}
          bufferedMs={telemetry.bufferedMs}
          seekable={!unavailable && status !== "error" && totalMs > 0}
          onSeek={seekTo}
        />
        <div className="flex items-center gap-2 text-[11px] font-semibold text-white/85">
          <span aria-live="off">{formatDuration(telemetry.currentTimeMs)}</span>
          <span aria-hidden>/</span>
          <span>{formatDuration(totalMs)}</span>
          {status === "loading" ? (
            <span className="ml-auto inline-flex items-center gap-1.5">
              <RefreshCw className={clsx("h-3.5 w-3.5", !reducedMotion && "animate-spin")} aria-hidden />
              Buffering
            </span>
          ) : null}
          {muted && active && !unavailable ? (
            <button
              type="button"
              onClick={unmute}
              className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-white/15 px-2.5 text-[12px] font-bold text-white transition-colors hover:bg-white/25"
            >
              <Volume2 className="h-4 w-4" aria-hidden />
              Unmute
            </button>
          ) : null}
        </div>
      </div>

      {(needsGesture || (active && status === "paused" && !unavailable)) && !unavailable ? (
        <button
          type="button"
          onClick={togglePlay}
          className="absolute inset-x-0 top-1/2 grid -translate-y-1/2 place-items-center py-6 text-white"
          aria-label="Play video"
        >
          <span className="grid h-16 w-16 place-items-center rounded-full bg-black/45 backdrop-blur-sm">
            <Play className="h-7 w-7" aria-hidden />
          </span>
        </button>
      ) : null}

      {unavailable || status === "error" ? (
        <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 flex-col items-center gap-3 px-6 text-center">
          <AlertTriangle className="h-6 w-6 text-white" aria-hidden />
          <p className="max-w-xs text-sm font-medium text-white/90">
            {unavailable
              ? "This video is unavailable — the source is gone or has not finished processing."
              : "This video would not load. The source may be blocked or temporarily offline."}
          </p>
          {!unavailable ? (
            <button
              type="button"
              onClick={() => {
                setTelemetry({ currentTimeMs: 0, durationMs: item.durationMs || 0, bufferedMs: 0 });
                statusRef.current = "loading";
                setStatus("loading");
                wantPlayRef.current = true;
                setReloadToken((token) => token + 1);
              }}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white/95 px-4 text-sm font-semibold text-ink transition-colors hover:bg-white"
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function initialStatus(item: VideoItem): VideoPlayerStatus {
  if (!isPlayableDirectly(item)) return "external";
  return item.playUrl ? "idle" : "unconfigured";
}

/** The tap has happened by the time we build this src, so autoplay is earned, not requested cold. */
function embedSrc(embed: string, provider: string): string {
  try {
    const url = new URL(embed);
    url.searchParams.set("autoplay", "1");
    if (provider === "youtube") {
      // The command API (play/pause via postMessage) only answers with the JS API enabled.
      url.searchParams.set("enablejsapi", "1");
      url.searchParams.set("playsinline", "1");
    }
    if (provider === "vimeo") {
      url.searchParams.set("api", "1");
      url.searchParams.set("dnt", "1");
      url.searchParams.set("playsinline", "1");
      url.searchParams.set("title", "0");
      url.searchParams.set("byline", "0");
      url.searchParams.set("portrait", "0");
    }
    return url.toString();
  } catch {
    return embed;
  }
}

/** postMessage targetOrigin for the command calls: the frame's own origin, never a wildcard. */
function frameOrigin(embed: string): string {
  try {
    return new URL(embed).origin;
  } catch {
    return "*";
  }
}

function providerName(provider: string): string {
  switch (provider) {
    case "youtube":
      return "YouTube";
    case "vimeo":
      return "Vimeo";
    case "linkedin":
      return "LinkedIn";
    case "self":
      return "Professionalist";
    default:
      return provider || "the source site";
  }
}

function bufferedEnd(el: HTMLVideoElement): number {
  try {
    return el.buffered.length === 0 ? 0 : el.buffered.end(el.buffered.length - 1);
  } catch {
    return 0;
  }
}

/* Transport registry: the feed looks up the active player by video id. */
const transportSinks = new Map<number, VideoTransport>();

export function getVideoTransport(videoId: number): VideoTransport | null {
  return transportSinks.get(videoId) ?? null;
}
