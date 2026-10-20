import "@/landing/landing.css";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { Hero } from "@/components/landing/Hero";
import { Positioning } from "@/components/landing/Positioning";
import { FeatureSection } from "@/components/landing/FeatureSection";
import { TrustSafety } from "@/components/landing/TrustSafety";
import { ClosingCta } from "@/components/landing/ClosingCta";
import { featureSections } from "@/landing/content";
import { cx, t } from "@/landing/tokens";

/**
 * Professionalist landing page (`/`).
 *
 * Self-contained subtree: it imports only its own `@/landing/*` and
 * `@/components/landing/*` modules plus `react-router-dom` (via those components).
 * It deliberately imports nothing from `src/services`, `src/context` or
 * `src/components/ui` — the page has no data dependencies and renders fully from
 * authored editorial content. The mount path is a plain default export with no
 * props, lazy-importable by the app router:
 *
 *   const LandingPage = lazy(() => import("@/pages/LandingPage"));
 */
export default function LandingPage() {
  return (
    <div className={cx("min-h-dvh w-full overflow-x-clip bg-[#f5f6f8] antialiased", t.ink)}>
      <a
        href="#landing-main"
        className={cx(
          "sr-only left-4 top-4 z-50 rounded-lg bg-[#1e6fff] px-4 py-2 text-sm font-semibold text-white",
          "focus:not-sr-only focus:absolute",
          t.focus,
        )}
      >
        Skip to content
      </a>

      <LandingHeader />

      <main id="landing-main">
        <Hero />
        <Positioning />
        {featureSections.map((section) => (
          <FeatureSection key={section.id} section={section} />
        ))}
        <TrustSafety />
        <ClosingCta />
      </main>

      <LandingFooter />
    </div>
  );
}
