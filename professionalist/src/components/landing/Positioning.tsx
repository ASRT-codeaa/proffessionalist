import { Reveal } from "@/components/landing/Reveal";
import { SectionHeading } from "@/components/landing/ui";
import { positioning } from "@/landing/content";
import { cx, t } from "@/landing/tokens";

export function Positioning() {
  return (
    <section
      aria-labelledby="positioning-title"
      className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:px-8 lg:py-24"
    >
      <Reveal>
        <SectionHeading
          kicker="What this is"
          title={positioning.heading}
          body={positioning.body}
        />
      </Reveal>

      <ul className="mt-12 grid grid-cols-1 gap-px overflow-hidden rounded-3xl border border-[#e4e7ec] bg-[#e4e7ec] sm:grid-cols-3">
        {positioning.pillars.map((pillar, i) => {
          const Icon = pillar.icon;
          return (
            <Reveal as="li" key={pillar.title} delayMs={i * 90}>
              <div className="flex h-full flex-col gap-3 bg-[#ffffff] p-6 lg:p-7">
                <span
                  className={cx(
                    "inline-flex h-11 w-11 items-center justify-center rounded-xl bg-[#e8f0ff]",
                    t.accent,
                  )}
                  aria-hidden="true"
                >
                  <Icon size={20} strokeWidth={1.9} />
                </span>
                <h3 className={cx("text-[17px] font-bold leading-snug", t.ink)}>
                  {pillar.title}
                </h3>
                <p className={cx("text-sm leading-relaxed", t.inkSoft)}>{pillar.body}</p>
              </div>
            </Reveal>
          );
        })}
      </ul>
    </section>
  );
}
