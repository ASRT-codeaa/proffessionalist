import { Link } from "react-router-dom";
import { ArrowRight, Check } from "lucide-react";
import type { ReactNode } from "react";
import { Reveal } from "@/components/landing/Reveal";
import { Kicker } from "@/components/landing/ui";
import { cx, t } from "@/landing/tokens";
import type { FeatureSection as FeatureSectionData } from "@/landing/content";
import { VideoCardPreview } from "@/components/landing/preview/VideoCardPreview";
import { ListingCardPreview } from "@/components/landing/preview/ListingCardPreview";
import { JobListPreview } from "@/components/landing/preview/JobListPreview";
import { NetworkPreview } from "@/components/landing/preview/NetworkPreview";

const previews: Record<FeatureSectionData["preview"], ReactNode> = {
  video: <VideoCardPreview className="mx-auto max-w-[220px]" />,
  jobs: <JobListPreview />,
  marketplace: <ListingCardPreview className="mx-auto max-w-[300px]" />,
  network: <NetworkPreview />,
};

export function FeatureSection({ section }: { section: FeatureSectionData }) {
  const Icon = section.icon;
  const flipped = section.preview === "marketplace"; // alternate which side the visual sits on

  return (
    <section
      aria-labelledby={`${section.id}-title`}
      className={cx(
        "mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:px-8 lg:py-20",
        section.preview === "jobs" && "bg-[#f5f6f8]",
      )}
    >
      <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <Reveal className={cx("min-w-0", flipped ? "lg:order-2" : undefined)}>
          <div className="mb-3 flex items-center gap-3">
            <span
              className={cx(
                "inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[#e8f0ff]",
                t.accent,
              )}
              aria-hidden="true"
            >
              <Icon size={19} strokeWidth={1.9} />
            </span>
            <Kicker>{section.kicker}</Kicker>
          </div>
          <h2
            id={`${section.id}-title`}
            className={cx("text-[28px] font-extrabold leading-[1.12] tracking-tight sm:text-[34px]", t.ink)}
          >
            {section.heading}
          </h2>
          <p className={cx("mt-4 max-w-lg text-[16px] leading-relaxed sm:text-[17px]", t.inkSoft)}>
            {section.body}
          </p>
          <ul className="mt-6 space-y-3">
            {section.bullets.map((b) => (
              <li key={b} className="flex items-start gap-2.5">
                <span
                  className={cx("mt-0.5 inline-flex shrink-0", t.accent)}
                  aria-hidden="true"
                >
                  <Check size={16} strokeWidth={2.4} />
                </span>
                <span className={cx("text-[15px] leading-snug", t.ink)}>{b}</span>
              </li>
            ))}
          </ul>
          {section.link ? (
            <Link
              to={section.link.to}
              className={cx(
                "mt-7 inline-flex min-h-11 items-center gap-1.5 rounded-xl text-sm font-bold",
                t.accent,
                "hover:text-[#155ad0]",
                t.focus,
              )}
            >
              {section.link.label}
              <ArrowRight size={16} strokeWidth={2.2} aria-hidden="true" />
            </Link>
          ) : null}
        </Reveal>

        <Reveal
          delayMs={120}
          className={cx("min-w-0", flipped ? "lg:order-1" : undefined)}
        >
          <div className="relative">
            <div
              aria-hidden="true"
              className="absolute -inset-4 rounded-[2rem] bg-[#eef0f4]"
            />
            <div className="relative">{previews[section.preview]}</div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
