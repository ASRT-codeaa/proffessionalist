import { MapPin, BadgeCheck } from "lucide-react";
import { PreviewTag } from "@/components/landing/ui";
import { cx, t } from "@/landing/tokens";
import { previewSample } from "@/landing/content";

const l = previewSample.listing;

/** Marketplace listing card preview. Price + metadata are sample values. */
export function ListingCardPreview({ className }: { className?: string }) {
  return (
    <div
      className={cx(
        "overflow-hidden rounded-2xl border border-[#e4e7ec] bg-[#ffffff] shadow-[0_1px_2px_#1018280d]",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="relative flex h-28 items-end bg-gradient-to-br from-[#eef0f4] via-[#e8f0ff] to-[#eef0f4] p-3"
      >
        <PreviewTag className="absolute right-2 top-2" />
        <span
          className={cx(
            "rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold",
            t.inkSoft,
          )}
        >
          {l.conditionLabel}
        </span>
      </div>
      <div className="space-y-1 p-3">
        <p className={cx("text-[13px] font-bold leading-snug", t.ink)}>{l.title}</p>
        <p className={cx("text-sm font-extrabold", t.accent)}>{l.price}</p>
        <p className={cx("flex items-center gap-1 text-[11px]", t.inkFaint)}>
          <MapPin size={12} strokeWidth={1.75} aria-hidden="true" />
          {l.location}
        </p>
        <p className={cx("flex items-center gap-1 text-[11px] font-medium", t.inkSoft)}>
          <BadgeCheck size={12} className={t.accent} aria-hidden="true" />
          {l.seller}
        </p>
      </div>
    </div>
  );
}
