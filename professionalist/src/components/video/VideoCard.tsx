import { clsx } from "clsx";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BadgeCheck, Ellipsis, Hash, Lock, VolumeX } from "lucide-react";
import type { VideoItem } from "@/services/videos";
import { formatCount, formatDuration, formatRelativeTime } from "./videoFormat";
import { VideoPlayer, type VideoPlayerActivity } from "./VideoPlayer";
import { VideoRail } from "./VideoRail";
import { VideoWhyPanel } from "./VideoMoreMenu";

export interface VideoCardProps {
  item: VideoItem;
  /** Only one slot in the feed is active at a time (it plays, others are paused). */
  active: boolean;
  muted: boolean;
  reducedMotion?: boolean;
  onMutedChange(muted: boolean): void;
  pending?: Partial<Record<"like" | "save" | "share" | "comment" | "follow", boolean>>;
  onLike(): void;
  onSave(): void;
  onShare(): void;
  onComments(): void;
  onToggleFollow(): void;
  onOpenAuthor?(): void;
  /** Opens the not-interested / mute / report / block sheet (button, or long press). */
  onMore?(): void;
  /** Set when this card is the viewer's own pending upload (from GET /:id). */
  moderationState?: string | null;
  onPlayingChange?(playing: boolean): void;
  onEnded?(): void;
  onActivity?(event: VideoPlayerActivity): void;
  className?: string;
}

/**
 * One full-height feed slot: the player plus the meta layer (author, caption, hashtags,
 * stats) and the action rail. Everything here is real state from the VIDEO_ITEM — the
 * component owns no data and fires no requests itself; the page does.
 */
export function VideoCard({
  item,
  active,
  muted,
  reducedMotion = false,
  onMutedChange,
  pending,
  onLike,
  onSave,
  onShare,
  onComments,
  onToggleFollow,
  onOpenAuthor,
  onMore,
  moderationState,
  onPlayingChange,
  onEnded,
  onActivity,
  className,
}: VideoCardProps) {
  const [captionExpanded, setCaptionExpanded] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const isPendingReview = moderationState === "pending";
  const longPressTimer = useRef<number | null>(null);

  const beginLongPress = (event: ReactPointerEvent<HTMLElement>) => {
    if (!onMore) return;
    // Scrubbing the progress strip must never open the report sheet.
    if ((event.target as HTMLElement).closest("[data-transport-zone]")) return;
    longPressTimer.current = window.setTimeout(() => onMore(), 550);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current != null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  return (
    <section
      aria-label={`Video by ${item.author.name}${active ? " (playing)" : ""}`}
      aria-roledescription="video"
      onPointerDown={beginLongPress}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      className={clsx(
        "relative flex h-full w-full snap-start snap-always overflow-hidden bg-black",
        className,
      )}
    >
      <VideoPlayer
        item={item}
        active={active}
        muted={muted}
        reducedMotion={reducedMotion}
        onMutedChange={onMutedChange}
        onPlayingChange={onPlayingChange}
        onEnded={onEnded}
        onActivity={onActivity}
        className="absolute inset-0"
      />

      {muted && active ? (
        <div className="pointer-events-none absolute right-0 top-16 z-10 flex items-center gap-1.5 rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-bold text-white">
          <VolumeX className="h-3.5 w-3.5" aria-hidden />
          Muted
        </div>
      ) : null}

      <div className="absolute right-3 top-28 z-10 flex flex-col items-end gap-2">
        {onMore ? (
          <button
            type="button"
            onClick={onMore}
            aria-label="More options for this video — not interested, mute creator, report, block"
            className="grid h-11 w-11 place-items-center rounded-xl bg-black/40 text-white backdrop-blur transition-colors hover:bg-black/60"
          >
            <Ellipsis className="h-5 w-5" aria-hidden />
          </button>
        ) : null}
        {item.ranking && item.ranking.reasons.length > 0 ? (
          <>
            <button
              type="button"
              onClick={() => setWhyOpen((v) => !v)}
              aria-expanded={whyOpen}
              className="rounded-full bg-black/40 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur transition-colors hover:bg-black/60"
            >
              Why this video
            </button>
            {whyOpen ? <div className="w-56 sm:w-64"><VideoWhyPanel item={item} /></div> : null}
          </>
        ) : null}
      </div>

      {isPendingReview ? (
        <div className="absolute inset-x-0 top-14 z-10 mx-auto flex w-fit items-center gap-2 rounded-full bg-surface/95 px-3.5 py-1.5 text-[12px] font-bold text-ink shadow-pop">
          <Lock className="h-3.5 w-3.5 text-warn" aria-hidden />
          Not published until approved
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-40 bg-gradient-to-t from-black/80 via-black/35 to-transparent" />

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end gap-3 p-3 pb-4 sm:p-4">
        <div className="min-w-0 flex-1 text-white">
          <div className="flex items-center gap-2">
            {onOpenAuthor ? (
              <button
                type="button"
                onClick={onOpenAuthor}
                className="pointer-events-auto inline-flex min-w-0 max-w-full items-center gap-1.5 truncate text-left text-sm font-extrabold hover:underline"
              >
                <span className="truncate">@{item.author.name || "professionalist"}</span>
                <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-white/70" aria-hidden />
              </button>
            ) : (
              <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 truncate text-sm font-extrabold">
                <span className="truncate">@{item.author.name || "professionalist"}</span>
                <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-white/70" aria-hidden />
              </span>
            )}
            <span className="shrink-0 text-[11px] font-semibold text-white/60">
              {formatRelativeTime(item.createdAt)}
            </span>
          </div>
          {item.author.headline ? (
            <p className="mt-0.5 line-clamp-1 text-[12px] text-white/70">{item.author.headline}</p>
          ) : null}

          {item.caption ? (
            <p
              className={clsx(
                "mt-1.5 text-sm leading-snug break-words",
                captionExpanded ? "" : "line-clamp-2",
              )}
            >
              {item.caption}
              {item.caption.length > 90 ? (
                <button
                  type="button"
                  onClick={() => setCaptionExpanded((v) => !v)}
                  className="pointer-events-auto ml-1.5 inline-flex min-h-11 items-center text-[12px] font-bold text-white/80 underline-offset-2 hover:underline"
                >
                  {captionExpanded ? "Less" : "More"}
                </button>
              ) : null}
            </p>
          ) : null}

          {item.hashtags.length > 0 ? (
            <ul className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              {item.hashtags.slice(0, 6).map((tag) => (
                <li key={tag} className="inline-flex items-center gap-0.5 text-[12px] font-bold text-white/85">
                  <Hash className="h-3 w-3 opacity-70" aria-hidden />
                  {tag}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold text-white/70">
            <span>{formatCount(item.stats.views)} views</span>
            <span aria-hidden>·</span>
            <span>{formatDuration(item.durationMs)}</span>
            {item.topics.length > 0 ? (
              <>
                <span aria-hidden>·</span>
                <span className="line-clamp-1">{item.topics.slice(0, 2).join(" · ")}</span>
              </>
            ) : null}
          </div>
        </div>

        <VideoRail
          item={item}
          pending={pending}
          followPending={pending?.follow}
          onLike={onLike}
          onSave={onSave}
          onShare={onShare}
          onComments={onComments}
          onToggleFollow={onToggleFollow}
          onOpenAuthor={onOpenAuthor}
          className="pointer-events-auto shrink-0 pb-1"
        />
      </div>
    </section>
  );
}
