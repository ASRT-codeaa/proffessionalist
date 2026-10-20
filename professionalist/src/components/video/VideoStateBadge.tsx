import { clsx } from "clsx";
import { Check, Clock, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import type { VideoModerationState } from "@/services/videos";
import { moderationLabel } from "./videoFormat";

export interface VideoStateBadgeProps {
  state: VideoModerationState | string;
  /** Optional server reason (rejection text, transcode error) shown as a title tooltip. */
  reason?: string | null;
  className?: string;
}

const TONE: Record<string, { wrap: string; icon: typeof Check }> = {
  approved: { wrap: "bg-success-soft text-success border-success/25", icon: Check },
  pending: { wrap: "bg-warn-soft text-warn border-warn/25", icon: Clock },
  reprocessing: { wrap: "bg-accent-soft text-accent border-accent/25", icon: Loader2 },
  rejected: { wrap: "bg-danger-soft text-danger border-danger/25", icon: ShieldAlert },
  removed: { wrap: "bg-surface-2 text-ink-soft border-line", icon: Trash2 },
};

/** Moderation lifecycle pill — the visible promise that nothing publishes unreviewed. */
export function VideoStateBadge({ state, reason, className }: VideoStateBadgeProps) {
  const tone = TONE[state] ?? { wrap: "bg-surface-2 text-ink-soft border-line", icon: Clock };
  const Icon = tone.icon;
  return (
    <span
      title={reason ?? undefined}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-bold",
        tone.wrap,
        className,
      )}
    >
      <Icon className={clsx("h-3.5 w-3.5", state === "reprocessing" && "animate-spin motion-reduce:animate-none")} aria-hidden />
      {moderationLabel(String(state))}
    </span>
  );
}
