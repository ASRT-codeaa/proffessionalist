import { ArrowRight } from "lucide-react";
import { Button } from "@/components/landing/Button";
import { Kicker } from "@/components/landing/ui";
import { ProductPreview } from "@/components/landing/ProductPreview";
import { hero } from "@/landing/content";
import { cx, t } from "@/landing/tokens";

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden">
      {/* subtle top wash, no blobs — a flat neutral band behind the copy */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-gradient-to-b from-[#ffffff] to-[#f5f6f8]"
      />
      <div className="relative mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-10 px-4 pb-14 pt-10 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14 lg:px-8 lg:pb-24 lg:pt-16">
        <div className="max-w-xl">
          <div className="mb-4">
            <Kicker>{hero.eyebrow}</Kicker>
          </div>
          <h1
            id="hero-title"
            className={cx(
              "text-[34px] font-extrabold leading-[1.08] tracking-tight sm:text-5xl lg:text-[56px]",
              t.ink,
            )}
          >
            {hero.headline}
          </h1>
          <p
            className={cx(
              "mt-5 max-w-lg text-[17px] leading-relaxed sm:text-[19px]",
              t.inkSoft,
            )}
          >
            {hero.subhead}
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button to={hero.primaryCta.to} variant="primary" size="lg" className="w-full sm:w-auto">
              {hero.primaryCta.label}
              <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
            </Button>
            <Button to={hero.secondaryCta.to} variant="secondary" size="lg" className="w-full sm:w-auto">
              {hero.secondaryCta.label}
            </Button>
          </div>
          <p className={cx("mt-5 text-[13px]", t.inkFaint)}>
            A preview of the product is shown beside this text — all sample content, not a live view.
          </p>
        </div>

        <div className="min-w-0">
          <ProductPreview />
        </div>
      </div>
    </section>
  );
}
