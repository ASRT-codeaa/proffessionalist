import { ArrowRight } from "lucide-react";
import { Button } from "@/components/landing/Button";
import { Reveal } from "@/components/landing/Reveal";
import { closingCta } from "@/landing/content";
import { cx, t } from "@/landing/tokens";

export function ClosingCta() {
  return (
    <section aria-labelledby="closing-title" className="px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
      <Reveal className="mx-auto w-full max-w-4xl">
        <div
          className={cx(
            "overflow-hidden rounded-[2rem] border border-[#e4e7ec] bg-[#ffffff] px-6 py-12 text-center",
            "shadow-[0_12px_32px_-8px_#1018282e] sm:px-12 lg:py-16",
          )}
        >
          <h2
            id="closing-title"
            className={cx("mx-auto max-w-xl text-[30px] font-extrabold leading-[1.1] tracking-tight sm:text-[40px]", t.ink)}
          >
            {closingCta.heading}
          </h2>
          <p className={cx("mx-auto mt-4 max-w-xl text-[16px] leading-relaxed sm:text-[17px]", t.inkSoft)}>
            {closingCta.body}
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button to={closingCta.primary.to} variant="primary" size="lg" className="w-full sm:w-auto">
              {closingCta.primary.label}
              <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
            </Button>
            <Button to={closingCta.secondary.to} variant="secondary" size="lg" className="w-full sm:w-auto">
              {closingCta.secondary.label}
            </Button>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
