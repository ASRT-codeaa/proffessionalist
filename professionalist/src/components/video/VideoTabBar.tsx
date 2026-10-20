import { clsx } from "clsx";
import { useEffect, useRef } from "react";
import { Flame, UserRoundSearch, WandSparkles } from "lucide-react";
import type { VideoTab } from "@/services/videos";

export const VIDEO_TABS: { id: VideoTab; label: string; icon: typeof Flame; hint: string }[] = [
  { id: "for-you", label: "For You", icon: WandSparkles, hint: "Chosen from your interests and watch history" },
  { id: "following", label: "Following", icon: UserRoundSearch, hint: "Latest from people you follow" },
  { id: "trending", label: "Trending", icon: Flame, hint: "Rising fastest across Professionalist" },
];

export interface VideoTabBarProps {
  value: VideoTab;
  onChange(tab: VideoTab): void;
  /** Shown as a live region so screen readers announce which tab is selected. */
  className?: string;
  reducedMotion?: boolean;
}

/** For You / Following / Trending switcher. Real tablist semantics + arrow-key roving. */
export function VideoTabBar({ value, onChange, className, reducedMotion = false }: VideoTabBarProps) {
  const refs = useRef(new Map<VideoTab, HTMLButtonElement>());

  const move = (from: VideoTab, delta: number) => {
    const index = VIDEO_TABS.findIndex((t) => t.id === from);
    const next = VIDEO_TABS[(index + delta + VIDEO_TABS.length) % VIDEO_TABS.length];
    onChange(next.id);
    refs.current.get(next.id)?.focus();
  };

  useEffect(() => {
    // Nothing persistent to clean up; this just keeps focus in sync when the parent
    // switches tabs programmatically (e.g. the empty state's "Try Trending").
  }, [value]);

  return (
    <div
      role="tablist"
      aria-label="Video feed"
      className={clsx("flex items-center justify-center gap-1 rounded-full bg-black/35 p-1 backdrop-blur", className)}
    >
      {VIDEO_TABS.map((tab) => {
        const selected = tab.id === value;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              if (node) refs.current.set(tab.id, node);
              else refs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={`video-tab-${tab.id}`}
            aria-selected={selected}
            aria-label={`${tab.label} — ${tab.hint}`}
            title={tab.hint}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault();
                move(tab.id, 1);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                move(tab.id, -1);
              }
            }}
            className={clsx(
              "inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-bold transition-colors",
              !reducedMotion && "motion-safe:transition-all",
              selected ? "bg-white text-ink" : "text-white/85 hover:bg-white/15 hover:text-white",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
