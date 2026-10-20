/** Pure formatting helpers shared by the video components (no I/O, no fixtures). */

export function formatCount(value: number | undefined | null): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.floor(n));
  if (n < 1_000_000) return `${trimZero(n / 1_000)}K`;
  if (n < 1_000_000_000) return `${trimZero(n / 1_000_000)}M`;
  return `${trimZero(n / 1_000_000_000)}B`;
}

function trimZero(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 0:07 · 1:04:09 — from milliseconds. */
export function formatDuration(ms: number | undefined | null): string {
  const total = Math.max(0, Math.floor(Number(ms) / 1_000 || 0));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3_600);
  const pad = (v: number) => String(v).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Human size for upload preflight: 3.4 MB / 1.2 GB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / 1024 ** exponent;
  return `${size >= 100 ? Math.round(size) : trimZero(size)} ${units[exponent]}`;
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const minute = 60_000;
  if (diff < minute) return "now";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)}m`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))}h`;
  if (diff < 7 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))}d`;
  const date = new Date(then);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "#design #careers" — keeps the caption's own hashtags out of the derived list. */
export function extractHashtags(caption: string): string[] {
  const matches = caption.match(/#[\p{L}\p{N}_]{1,40}/gu);
  return matches ? [...new Set(matches.map((m) => m.slice(1).toLowerCase()))] : [];
}

export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Turns "Career advice" into a stable slug for topic chips. */
export function topicSlug(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function moderationLabel(state: string): string {
  switch (state) {
    case "pending":
      return "In review";
    case "approved":
      return "Published";
    case "rejected":
      return "Not approved";
    case "reprocessing":
      return "Reprocessing";
    case "removed":
      return "Removed";
    default:
      return state;
  }
}
