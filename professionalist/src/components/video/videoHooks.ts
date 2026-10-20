import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

/** Honours the OS "reduce motion" setting; the feed disables smooth scrolling/animations. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== "undefined" && "matchMedia" in window
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

const MUTE_KEY = "professionalist.videos.muted";

/**
 * Browser autoplay policy: a feed can only autoplay with sound after a user gesture, so
 * the player starts muted and the user unmutes it (the choice then persists per device).
 */
export function useFeedMuted(): [boolean, (next: boolean) => void] {
  const [muted, setMutedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(MUTE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const setMuted = useCallback((next: boolean) => {
    setMutedState(next);
    try {
      localStorage.setItem(MUTE_KEY, String(next));
    } catch {
      /* private mode: the in-memory value still applies for this session */
    }
  }, []);
  return [muted, setMuted];
}

/** Media query for pointer/coarse input, so desktop keeps visible transport buttons. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState<boolean>(() =>
    typeof window !== "undefined" && "matchMedia" in window
      ? window.matchMedia("(pointer: coarse)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) return;
    const mq = window.matchMedia("(pointer: coarse)");
    const onChange = () => setCoarse(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

/** Stable per-page-view id used to build activity `dedupe_key`s. */
export function useActivitySession(): string {
  const ref = useRef<string>("");
  if (!ref.current) {
    const cryptoObj = globalThis.crypto as Crypto | undefined;
    ref.current =
      typeof cryptoObj?.randomUUID === "function"
        ? cryptoObj.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return ref.current;
}

export function useDebounced<T>(value: T, delayMs = 450): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface VideoActivityInput {
  videoId: number;
  active: boolean;
  isPlaying: boolean;
  report: (event: ActivityEventName, payload: { value_ms?: number; value_num?: number; dedupe_key: string }) => void;
}

export interface VideoActivityApi {
  /** Called by the player on the `ended` event; reports `complete` once per slot. */
  noteEnded: () => void;
}

/**
 * Reports real watch time for the active feed slot:
 * view_start + impression on activation, watch batches every 5 s of *playing* time,
 * complete on `noteEnded()`, and a final flush when the slot goes inactive or the page
 * hides. Keys are stable per session, so the idempotent endpoint ignores replays.
 */
export function useVideoActivity(input: VideoActivityInput): VideoActivityApi {
  const { videoId, active, isPlaying, report } = input;
  const session = useActivitySession();
  const accumulated = useRef(0);
  const bucket = useRef(0);
  const viewedRef = useRef<number | null>(null);
  const completedRef = useRef(false);
  const reportRef = useRef(report);
  reportRef.current = report;

  const key = useCallback((kind: string) => `${videoId}:${kind}:${session}`, [videoId, session]);

  const flushWatch = useCallback(() => {
    const ms = Math.round(accumulated.current);
    accumulated.current = 0;
    if (ms < 250) return;
    bucket.current += 1;
    reportRef.current("watch", { value_ms: ms, dedupe_key: key(`watch:${bucket.current}`) });
  }, [key]);

  useEffect(() => {
    if (!active) {
      flushWatch();
      return;
    }
    if (viewedRef.current !== videoId) {
      viewedRef.current = videoId;
      completedRef.current = false;
      reportRef.current("view_start", { value_ms: 0, dedupe_key: key("view_start") });
      reportRef.current("impression", { value_num: 1, dedupe_key: key("impression") });
    }
  }, [active, videoId, key, flushWatch]);

  useEffect(() => {
    if (!isPlaying) return;
    const interval = window.setInterval(() => {
      accumulated.current += 1_000;
      if (accumulated.current >= 5_000) flushWatch();
    }, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [isPlaying, flushWatch]);

  useEffect(() => {
    const onHide = () => flushWatch();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
  }, [flushWatch]);

  return useMemo<VideoActivityApi>(
    () => ({
      noteEnded: () => {
        if (completedRef.current) return;
        completedRef.current = true;
        flushWatch();
        reportRef.current("complete", { value_ms: 0, dedupe_key: `${videoId}:complete:${session}` });
      },
    }),
    [flushWatch, videoId, session],
  );
}

export type ActivityEventName =
  | "view_start"
  | "watch"
  | "complete"
  | "like"
  | "save"
  | "share"
  | "follow_from_video"
  | "impression";

/**
 * Modal focus discipline: focus moves into the container on open, Tab and Shift+Tab
 * cycle inside it, Escape closes, and focus returns to the trigger on close. Used by
 * the comments sheet and the per-video menu (the feed's overlays must never leak focus).
 */
export function useOverlayFocus(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    const focusables = () =>
      Array.from(
        container?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    const first = focusables()[0];
    (first ?? container)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const activeEl = document.activeElement as HTMLElement | null;
      const index = activeEl ? items.indexOf(activeEl) : -1;
      const next = event.shiftKey
        ? items[(index - 1 + items.length) % items.length]
        : items[(index + 1) % items.length];
      if (index === -1 || activeEl === container) {
        event.preventDefault();
        next.focus();
        return;
      }
      if (event.shiftKey && index === 0) {
        event.preventDefault();
        next.focus();
      } else if (!event.shiftKey && index === items.length - 1) {
        event.preventDefault();
        next.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      previous?.focus?.();
    };
  }, [containerRef, open, onClose]);
}

/* ------------------------------------------------------------------ *
 * Interests mirror.
 * The videos contract has NO GET /interests — PUT replaces the whole set and
 * echoes it back. To re-render saved weights on the next visit (and to keep
 * "not interested" topic writes from wiping the rest of the set) the UI caches
 * the server echo per device. It is a cache of the last server-confirmed state,
 * never a source of truth the API is expected to agree with silently.
 * ------------------------------------------------------------------ */

const INTERESTS_MIRROR_KEY = "professionalist.videos.interests";

export type InterestMirror = Record<string, number>;

export function readInterestsMirror(): InterestMirror {
  try {
    const raw = localStorage.getItem(INTERESTS_MIRROR_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: InterestMirror = {};
    for (const [slug, weight] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof weight === "number" && weight >= 0 && weight <= 1) out[slug] = weight;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeInterestsMirror(mirror: InterestMirror): void {
  try {
    localStorage.setItem(INTERESTS_MIRROR_KEY, JSON.stringify(mirror));
  } catch {
    /* private mode: the in-memory state of the current session still applies */
  }
}
