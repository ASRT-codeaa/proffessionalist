import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function timeAgo(iso: string | number | null | undefined): string {
  if (!iso) return "";
  const t = typeof iso === "number" ? iso : new Date(iso).getTime();
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: d > 300 ? "numeric" : undefined });
}

export function formatPrice(value: number, type: string, currency = "USD"): string {
  const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: value % 1 ? 2 : 0 });
  if (type === "free") return "Free";
  if (type === "hourly") return `${fmt.format(value)}/hr`;
  if (type === "starting_at") return `From ${fmt.format(value)}`;
  if (type === "negotiable") return `${fmt.format(value)} · Negotiable`;
  return fmt.format(value);
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

/** "7 people" / "1 person" — count with a correct singular or plural noun. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function fullName(p: { firstName?: string; lastName?: string; name?: string }): string {
  return (p.name ?? `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim()) || "Unknown";
}

/** "Today" / "Tomorrow" / "Yesterday" / "Mar 4" for a due date. */
export function dueLabel(iso: string): string {
  const d = new Date(iso);
  const day = 86_400_000;
  const same = (offset: number) => new Date(Date.now() + offset).toDateString() === d.toDateString();
  if (same(0)) return "Today";
  if (same(day)) return "Tomorrow";
  if (same(-day)) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
