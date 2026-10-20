import type { ReactNode } from "react";
import { cx, t } from "@/landing/tokens";
import { previewLabel } from "@/landing/content";

/** Rounded monogram avatar — presentation only, no image is loaded. */
export function Avatar({
  initials,
  size = 40,
  tone = "accent",
}: {
  initials: string;
  size?: number;
  tone?: "accent" | "neutral";
}) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        tone === "accent"
          ? "bg-[#e8f0ff] text-[#155ad0]"
          : "bg-[#eef0f4] text-[#667085]",
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initials}
    </span>
  );
}

/** A calm white panel using the deployed card treatment (line + soft shadow). */
export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "rounded-3xl border border-[#e4e7ec] bg-[#ffffff] shadow-[0_1px_2px_#1018280d]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Small all-caps section kicker. */
export function Kicker({ children }: { children: ReactNode }) {
  return (
    <p
      className={cx(
        "text-xs font-semibold uppercase tracking-[0.14em]",
        t.accent,
      )}
    >
      {children}
    </p>
  );
}

/** Visible, unmissable marker that a card shows sample, non-live content. */
export function PreviewTag({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border border-[#e4e7ec] bg-[#f5f6f8] px-2.5 py-1 " +
          "text-[10px] font-semibold uppercase tracking-[0.12em] text-[#98a2b3]",
        className,
      )}
    >
      {previewLabel}
    </span>
  );
}

export type SectionHeadingProps = {
  kicker?: string;
  title: string;
  body?: string;
  align?: "left" | "center";
  as?: "h2";
};

export function SectionHeading({
  kicker,
  title,
  body,
  align = "left",
}: SectionHeadingProps) {
  return (
    <div className={cx("max-w-2xl", align === "center" && "mx-auto text-center")}>
      {kicker ? <div className="mb-3"><Kicker>{kicker}</Kicker></div> : null}
      <h2
        className={cx(
          "text-[28px] font-extrabold leading-[1.12] tracking-tight sm:text-4xl",
          t.ink,
        )}
      >
        {title}
      </h2>
      {body ? (
        <p className={cx("mt-4 text-base leading-relaxed sm:text-[17px]", t.inkSoft)}>
          {body}
        </p>
      ) : null}
    </div>
  );
}
