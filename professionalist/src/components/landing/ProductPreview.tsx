import { cx } from "@/landing/tokens";
import { hero } from "@/landing/content";
import { FeedCardPreview } from "@/components/landing/preview/FeedCardPreview";
import { ProfileHeaderPreview } from "@/components/landing/preview/ProfileHeaderPreview";
import { VideoCardPreview } from "@/components/landing/preview/VideoCardPreview";
import { ListingCardPreview } from "@/components/landing/preview/ListingCardPreview";

/**
 * The genuine product preview: a composed, static arrangement of four real app
 * surfaces — feed post, vertical video, marketplace listing, and profile header.
 * Every card is presentation-only and labelled as sample content. This is a
 * <figure> describing itself for assistive tech; the cards themselves are inert.
 */
export function ProductPreview({ className }: { className?: string }) {
  return (
    <figure className={cx("m-0", className)}>
      <figcaption className="sr-only">{hero.previewAlt}</figcaption>
      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4"
        aria-hidden="true"
      >
        <FeedCardPreview className="sm:col-span-2" />
        <VideoCardPreview />
        <div className="flex flex-col gap-3 sm:gap-4">
          <ProfileHeaderPreview />
          <ListingCardPreview />
        </div>
      </div>
    </figure>
  );
}
