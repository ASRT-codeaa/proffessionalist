import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cx } from "@/landing/tokens";

export type RevealProps = {
  children: ReactNode;
  className?: string;
  /** Delay in ms so staggered sections read as intentional, not busy. */
  delayMs?: number;
  as?: "div" | "section" | "li";
};

/**
 * A single, restrained entrance animation. Degrades to "always visible" when:
 *  - the user prefers reduced motion (CSS also forces it visible), or
 *  - IntersectionObserver is unavailable, or
 *  - before effects run (so content is never hidden for non-JS / first paint).
 */
export function Reveal({ children, className, delayMs = 0, as = "div" }: RevealProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"idle" | "hidden" | "shown">("idle");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof IntersectionObserver === "undefined") {
      setState("shown");
      return;
    }
    setState("hidden");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (delayMs > 0) {
              window.setTimeout(() => setState("shown"), delayMs);
            } else {
              setState("shown");
            }
            observer.disconnect();
            break;
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [delayMs]);

  const Tag = as;
  return (
    <Tag
      ref={ref as never}
      className={cx("lp-reveal", className)}
      data-lp-hidden={state === "hidden" ? "true" : undefined}
      data-lp-shown={state === "shown" ? "true" : undefined}
    >
      {children}
    </Tag>
  );
}
