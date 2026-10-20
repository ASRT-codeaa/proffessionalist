import { formatDuration } from "./videoFormat";

export interface VideoProgressBarProps {
  currentTimeMs: number;
  durationMs: number;
  bufferedMs?: number;
  /** False while the media is not seekable (live/external provider, or no duration yet). */
  seekable: boolean;
  onSeek(timeMs: number): void;
}

/**
 * Scrubbable progress line for the feed player. The interactive strip is 44 px tall
 * (touch target) while the visible bar stays thin, and it is a real `input[type=range]`
 * so keyboard and screen-reader slider semantics come for free.
 */
export function VideoProgressBar({
  currentTimeMs,
  durationMs,
  bufferedMs = 0,
  seekable,
  onSeek,
}: VideoProgressBarProps) {
  const progressPct = durationMs > 0 ? clampedPct(currentTimeMs, durationMs) : 0;
  const bufferedPct = durationMs > 0 ? clampedPct(bufferedMs, durationMs) : 0;

  return (
    <div className="relative w-full">
      <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/25">
        <div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: `${bufferedPct}%` }} />
        <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${progressPct}%` }} />
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(1, Math.round(durationMs))}
        step={250}
        value={Math.min(Math.max(0, Math.round(currentTimeMs)), Math.round(durationMs) || 0)}
        disabled={!seekable}
        aria-label="Video position"
        aria-valuetext={`${formatDuration(currentTimeMs)} of ${formatDuration(durationMs)}`}
        className="relative h-11 w-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-default"
        onChange={(event) => onSeek(Number(event.currentTarget.value))}
      />
    </div>
  );
}

function clampedPct(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (value / total) * 100));
}
