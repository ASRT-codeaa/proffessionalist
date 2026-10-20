import { clsx } from "clsx";
import { Loader2, UserPlus } from "lucide-react";
import type { VideoItem } from "@/services/videos";
import { videoHttp } from "@/services/videoHttp";
import { initialsOf } from "./videoFormat";
import { VideoActions, type VideoActionsProps } from "./VideoActions";

export interface VideoRailProps extends Pick<VideoActionsProps, "pending" | "onLike" | "onSave" | "onShare" | "onComments"> {
  item: VideoItem;
  followPending?: boolean;
  onToggleFollow(): void;
  onOpenAuthor?(): void;
  className?: string;
}

/**
 * The right-hand column over the video: author identity, follow, and the engagement
 * cluster. Follow uses the app's existing /api/network/follow|unfollow endpoints via the
 * app bridge (see src/services/videoApp.ts).
 */
export function VideoRail({
  item,
  pending,
  followPending,
  onLike,
  onSave,
  onShare,
  onComments,
  onToggleFollow,
  onOpenAuthor,
  className,
}: VideoRailProps) {
  const avatar = item.author.avatarUrl ? videoHttp().mediaUrl(item.author.avatarUrl) : "";
  const follows = Boolean(item.author.viewerFollows);

  return (
    <div className={clsx("flex flex-col items-center gap-2", className)}>
      {onOpenAuthor ? (
        <button
          type="button"
          onClick={onOpenAuthor}
          aria-label={`Open ${item.author.name}'s profile`}
          className="grid min-h-11 min-w-11 place-items-center rounded-full transition-transform hover:scale-[1.03]"
        >
          <span className="relative grid h-12 w-12 place-items-center overflow-hidden rounded-full bg-white/15 text-sm font-bold text-white ring-2 ring-white/40">
            {avatar ? (
              <img src={avatar} alt="" className="h-12 w-12 rounded-full object-cover" />
            ) : (
              <span aria-hidden>{initialsOf(item.author.name)}</span>
            )}
          </span>
        </button>
      ) : (
        <span className="grid h-12 w-12 place-items-center overflow-hidden rounded-full bg-white/15 text-sm font-bold text-white ring-2 ring-white/40">
          {avatar ? (
            <img src={avatar} alt="" className="h-12 w-12 rounded-full object-cover" />
          ) : (
            <span aria-hidden>{initialsOf(item.author.name)}</span>
          )}
        </span>
      )}

      {!follows ? (
        <button
          type="button"
          onClick={onToggleFollow}
          disabled={followPending}
          aria-label={followPending ? "Following request in progress" : `Follow ${item.author.name}`}
          className="grid min-h-11 min-w-11 place-items-center rounded-full transition-colors"
        >
          <span className="grid h-8 w-8 place-items-center rounded-full bg-accent text-accent-ink transition-colors hover:bg-accent-hover">
            {followPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <UserPlus className="h-4 w-4" aria-hidden />
            )}
          </span>
        </button>
      ) : null}

      <VideoActions
        item={item}
        pending={pending}
        onLike={onLike}
        onSave={onSave}
        onShare={onShare}
        onComments={onComments}
      />
    </div>
  );
}
