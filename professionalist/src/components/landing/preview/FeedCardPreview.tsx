import { Heart, MessageSquare, Repeat2, Bookmark } from "lucide-react";
import { Avatar, PreviewTag } from "@/components/landing/ui";
import { cx, t } from "@/landing/tokens";
import { previewSample } from "@/landing/content";

const s = previewSample.feed;

/**
 * Static representation of a feed post card. Presentation only — the action
 * icons are decorative (aria-hidden) and nothing here is clickable.
 */
export function FeedCardPreview({ className }: { className?: string }) {
  return (
    <div
      className={cx(
        "rounded-2xl border border-[#e4e7ec] bg-[#ffffff] p-4 shadow-[0_1px_2px_#1018280d]",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <Avatar initials={previewSample.profile.initials} size={40} />
        <div className="min-w-0 flex-1">
          <p className={cx("truncate text-sm font-bold", t.ink)}>{s.author}</p>
          <p className={cx("truncate text-xs", t.inkFaint)}>{s.meta}</p>
        </div>
        <PreviewTag />
      </div>

      <p className={cx("mt-3 text-[13px] leading-relaxed", t.inkSoft)}>{s.body}</p>

      <p className={cx("mt-2 text-xs font-semibold", t.accent)}>{s.hashtags.join("  ")}</p>

      {/* Decorative action row — not interactive on the landing page. */}
      <div
        aria-hidden="true"
        className={cx("mt-3 flex items-center gap-5 border-t border-[#e4e7ec] pt-3 text-xs", t.inkFaint)}
      >
        <span className="inline-flex items-center gap-1.5">
          <Heart size={15} strokeWidth={1.75} /> Like
        </span>
        <span className="inline-flex items-center gap-1.5">
          <MessageSquare size={15} strokeWidth={1.75} /> Comment
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Repeat2 size={15} strokeWidth={1.75} /> Share
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5">
          <Bookmark size={15} strokeWidth={1.75} /> Save
        </span>
      </div>
    </div>
  );
}
