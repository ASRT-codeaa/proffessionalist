import { clsx } from "clsx";
import type { ReactNode } from "react";
import { Bookmark, Heart, Loader2, MessageCircle, Share2 } from "lucide-react";
import type { VideoItem } from "@/services/videos";
import { formatCount } from "./videoFormat";

export interface VideoActionsProps {
  item: VideoItem;
  /** In-flight flags for the optimistic UI: the button is busy, never decorative. */
  pending?: Partial<Record<"like" | "save" | "share" | "comment", boolean>>;
  orientation?: "vertical" | "horizontal";
  onLike(): void;
  onSave(): void;
  onShare(): void;
  onComments(): void;
  className?: string;
}

/**
 * Engagement cluster. Like/save/share post to the EXISTING /api/posts/:id/* endpoints
 * (a video is a post); the caller owns the optimistic state and reconciles with the
 * server result, exactly like src/components/PostCard.tsx does.
 */
export function VideoActions({
  item,
  pending,
  orientation = "vertical",
  onLike,
  onSave,
  onShare,
  onComments,
  className,
}: VideoActionsProps) {
  const liked = item.viewer.liked;
  const saved = item.viewer.saved;

  return (
    <div
      className={clsx(
        orientation === "vertical" ? "flex flex-col items-center gap-1" : "flex items-center gap-1",
        className,
      )}
    >
      <ActionButton
        label={liked ? "Remove like from video" : "Like video"}
        active={liked}
        busy={pending?.like}
        onClick={onLike}
        count={formatCount(item.stats.likes)}
        icon={
          liked ? (
            <Heart className="h-6 w-6 fill-current" aria-hidden />
          ) : (
            <Heart className="h-6 w-6" aria-hidden />
          )
        }
      />
      <ActionButton
        label={saved ? "Remove from saved" : "Save video"}
        active={saved}
        busy={pending?.save}
        onClick={onSave}
        count={formatCount(item.stats.saves)}
        icon={
          saved ? (
            <Bookmark className="h-6 w-6 fill-current" aria-hidden />
          ) : (
            <Bookmark className="h-6 w-6" aria-hidden />
          )
        }
      />
      <ActionButton
        label="Comment on video"
        busy={pending?.comment}
        onClick={onComments}
        count={formatCount(item.stats.comments)}
        icon={<MessageCircle className="h-6 w-6" aria-hidden />}
      />
      <ActionButton
        label="Share video"
        busy={pending?.share}
        onClick={onShare}
        count={formatCount(item.stats.shares)}
        icon={<Share2 className="h-6 w-6" aria-hidden />}
      />
    </div>
  );
}

interface ActionButtonProps {
  label: string;
  icon: ReactNode;
  count?: string;
  active?: boolean;
  busy?: boolean;
  onClick(): void;
}

function ActionButton({ label, icon, count, active, busy, onClick }: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      aria-busy={busy || undefined}
      disabled={busy}
      className={clsx(
        "grid min-h-11 min-w-11 place-items-center gap-0.5 rounded-2xl px-2 py-1.5 text-[11px] font-bold leading-tight text-white/90 transition-colors",
        "hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
        active && "text-white",
        busy ? "opacity-70" : "hover:bg-white/15",
      )}
    >
      <span className={clsx("grid h-8 w-8 place-items-center rounded-full", active && "bg-white/20")}>
        {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : icon}
      </span>
      {count ? <span className="tabular-nums">{count}</span> : null}
    </button>
  );
}
