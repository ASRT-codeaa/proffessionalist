import { Play, Heart, MessageCircle } from "lucide-react";
import { PreviewTag } from "@/components/landing/ui";
import { cx } from "@/landing/tokens";
import { previewSample } from "@/landing/content";

const v = previewSample.video;

/**
 * Vertical video tile preview. The "thumbnail" is an abstract graphite surface
 * (no stock photography), the play control is decorative. Presentation only.
 */
export function VideoCardPreview({ className }: { className?: string }) {
  return (
    <div
      className={cx(
        "relative aspect-[9/16] w-full overflow-hidden rounded-2xl border border-[#e4e7ec] " +
          "bg-[#101828] shadow-[0_12px_32px_-8px_#1018282e]",
        className,
      )}
    >
      {/* abstract texture so it reads as a video frame, not a photo of a person */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-tr from-[#101828] via-[#1f2a3c] to-[#155ad0]/60"
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <span
          aria-hidden="true"
          className="flex h-12 w-12 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/40 backdrop-blur-sm"
        >
          <Play size={20} className="text-white" fill="white" />
        </span>
      </div>

      <PreviewTag className="absolute right-2 top-2" />

      <div className="absolute inset-x-0 bottom-0 space-y-1 p-3">
        <p className="line-clamp-2 text-[13px] font-semibold leading-snug text-white">
          {v.title}
        </p>
        <div className="flex items-center gap-3 text-[11px] text-white/80">
          <span className="truncate">{v.author}</span>
          <span aria-hidden="true" className="ml-auto inline-flex items-center gap-1">
            <Heart size={13} strokeWidth={1.75} />
          </span>
          <span aria-hidden="true" className="inline-flex items-center gap-1">
            <MessageCircle size={13} strokeWidth={1.75} />
          </span>
        </div>
      </div>
    </div>
  );
}
