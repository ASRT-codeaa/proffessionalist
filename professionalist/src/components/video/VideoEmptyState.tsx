import { clsx } from "clsx";
import {
  CloudOff,
  Clapperboard,
  Compass,
  Inbox,
  RefreshCw,
  ShieldAlert,
  SignalHigh,
  type LucideIcon,
} from "lucide-react";

export type VideoEmptyVariant =
  | "loading"
  | "empty"
  | "offline"
  | "error"
  | "unavailable"
  | "no-following"
  | "moderation-hold";

const COPY: Record<VideoEmptyVariant, { icon: LucideIcon; title: string; body: string }> = {
  loading: { icon: SignalHigh, title: "Loading videos", body: "Pulling the next clips for you." },
  empty: {
    icon: Inbox,
    title: "Nothing here yet",
    body: "This feed is empty for now. Pick a few topics so we can line up videos worth your time.",
  },
  offline: {
    icon: CloudOff,
    title: "You are offline",
    body: "Reconnect to load videos. Everything you already watched stays where you left it.",
  },
  error: {
    icon: RefreshCw,
    title: "The feed would not load",
    body: "Something went wrong reaching the video service. Try again in a moment.",
  },
  unavailable: {
    icon: Clapperboard,
    title: "Video unavailable",
    body: "This clip was removed, is still processing, or its source refused to play.",
  },
  "no-following": {
    icon: Compass,
    title: "Follow people to fill this tab",
    body: "The Following tab only shows clips from accounts you follow.",
  },
  "moderation-hold": {
    icon: ShieldAlert,
    title: "Waiting on review",
    body: "Videos stay private until a moderator approves them, so nothing is published automatically.",
  },
};

export interface VideoEmptyStateProps {
  variant: VideoEmptyVariant;
  /** Override the default copy (e.g. with the server's error message). */
  title?: string;
  body?: string;
  action?: { label: string; onClick(): void };
  secondaryAction?: { label: string; onClick(): void };
  className?: string;
}

/** One component for every non-content state in the video UI. Never a dead button. */
export function VideoEmptyState({ variant, title, body, action, secondaryAction, className }: VideoEmptyStateProps) {
  const copy = COPY[variant];
  const Icon = copy.icon;
  return (
    <div
      role="status"
      aria-live="polite"
      className={clsx(
        "mx-auto flex w-full max-w-sm flex-col items-center gap-3 px-6 py-10 text-center",
        className,
      )}
    >
      <span
        className={clsx(
          "grid h-12 w-12 place-items-center rounded-2xl",
          variant === "offline" || variant === "error" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent",
        )}
      >
        <Icon className="h-6 w-6" aria-hidden />
      </span>
      <p className="text-base font-bold text-ink">{title ?? copy.title}</p>
      <p className="text-sm leading-relaxed text-ink-soft">{body ?? copy.body}</p>
      {action || secondaryAction ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {action ? (
            <button
              type="button"
              onClick={action.onClick}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover"
            >
              {action.label}
            </button>
          ) : null}
          {secondaryAction ? (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
            >
              {secondaryAction.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Skeleton used while the first page of a tab is in flight. */
export function VideoFeedSkeleton({ count = 2 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-3 p-4" aria-hidden>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="card overflow-hidden">
          <div className="skeleton aspect-[9/16] w-full" />
          <div className="space-y-2 p-3">
            <div className="skeleton h-3 w-1/3 rounded-full" />
            <div className="skeleton h-3 w-2/3 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
