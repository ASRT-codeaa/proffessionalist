import { Reveal } from "@/components/landing/Reveal";
import { SectionHeading } from "@/components/landing/ui";
import { trust } from "@/landing/content";
import { cx, t } from "@/landing/tokens";

export function TrustSafety() {
  return (
    <section
      aria-labelledby="trust-title"
      className="border-y border-[#e4e7ec] bg-[#f5f6f8]"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
        <Reveal>
          <SectionHeading kicker="Trust & safety" title={trust.heading} body={trust.body} />
        </Reveal>

        <ul className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {trust.items.map((item, i) => {
            const Icon = item.icon;
            return (
              <Reveal as="li" key={item.title} delayMs={i * 80}>
                <div
                  className={cx(
                    "flex h-full flex-col gap-3 rounded-2xl border border-[#e4e7ec] bg-[#ffffff] p-5",
                    "shadow-[0_1px_2px_#1018280d]",
                  )}
                >
                  <span
                    className={cx(
                      "inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[#e8f0ff]",
                      t.accent,
                    )}
                    aria-hidden="true"
                  >
                    <Icon size={19} strokeWidth={1.9} />
                  </span>
                  <h3 className={cx("text-[15px] font-bold", t.ink)}>{item.title}</h3>
                  <p className={cx("text-[13px] leading-relaxed", t.inkSoft)}>{item.body}</p>
                </div>
              </Reveal>
            );
          })}
        </ul>

        <p className={cx("mt-8 max-w-3xl text-[13px] leading-relaxed", t.inkFaint)}>
          {trust.note}
        </p>
      </div>
    </section>
  );
}
