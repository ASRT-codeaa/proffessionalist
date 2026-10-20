import { forwardRef, useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { mediaUrl } from "@/services/http";

/* ---------------------------------- Button --------------------------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline" | "soft";
type ButtonSize = "sm" | "md" | "lg" | "icon";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink hover:bg-accent-hover shadow-sm",
  secondary: "bg-ink text-canvas hover:opacity-90",
  ghost: "text-ink hover:bg-surface-2",
  danger: "bg-danger text-white hover:opacity-90",
  outline: "border border-line-strong text-ink hover:bg-surface-2 bg-surface",
  soft: "bg-accent-soft text-accent hover:opacity-85",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] rounded-lg gap-1.5",
  md: "h-10 px-4 text-sm rounded-xl gap-2",
  lg: "h-12 px-6 text-base rounded-xl gap-2",
  icon: "h-10 w-10 rounded-xl justify-center",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, fullWidth, className, children, disabled, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center font-semibold transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none select-none",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        fullWidth && "w-full",
        className
      )}
      {...rest}
    >
      {loading && <Loader2 size={16} className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

/* ---------------------------------- Inputs --------------------------------- */

const FIELD_CLASS =
  "w-full bg-surface border border-line rounded-xl px-3.5 text-sm placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-[var(--ring)] focus:outline-none transition-colors disabled:opacity-60";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  icon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, icon, className, id, ...rest },
  ref
) {
  const inputId = id ?? (label ? `f-${label.replace(/\W+/g, "-").toLowerCase()}` : undefined);
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="block text-[13px] font-semibold mb-1.5">
          {label}
        </label>
      )}
      <div className="relative">
        {icon && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none">{icon}</span>}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={!!error}
          className={cn(FIELD_CLASS, "h-10", icon && "pl-9", error && "border-danger focus:border-danger", className)}
          {...rest}
        />
      </div>
      {error ? (
        <p className="text-xs text-danger mt-1" role="alert">{error}</p>
      ) : hint ? (
        <p className="text-xs text-ink-faint mt-1">{hint}</p>
      ) : null}
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, hint, className, id, rows = 3, ...rest },
  ref
) {
  const inputId = id ?? (label ? `f-${label.replace(/\W+/g, "-").toLowerCase()}` : undefined);
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="block text-[13px] font-semibold mb-1.5">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={inputId}
        rows={rows}
        aria-invalid={!!error}
        className={cn(FIELD_CLASS, "py-2.5 resize-y", error && "border-danger", className)}
        {...rest}
      />
      {error ? (
        <p className="text-xs text-danger mt-1" role="alert">{error}</p>
      ) : hint ? (
        <p className="text-xs text-ink-faint mt-1">{hint}</p>
      ) : null}
    </div>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  hint?: string;
  options: { value: string | number; label: string }[];
  placeholder?: string;
}

export function Select({ label, error, hint, options, placeholder, className, id, ...rest }: SelectProps) {
  const inputId = id ?? (label ? `f-${label.replace(/\W+/g, "-").toLowerCase()}` : undefined);
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="block text-[13px] font-semibold mb-1.5">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          id={inputId}
          aria-invalid={!!error}
          className={cn(FIELD_CLASS, "h-10 appearance-none pr-9", error && "border-danger focus:border-danger", className)}
          {...rest}
        >
          {placeholder && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" aria-hidden />
      </div>
      {error ? (
        <p className="text-xs text-danger mt-1" role="alert">{error}</p>
      ) : hint ? (
        <p className="text-xs text-ink-faint mt-1">{hint}</p>
      ) : null}
    </div>
  );
}

export function Switch({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label?: string; description?: string }) {
  return (
    <label className="flex items-center justify-between gap-4 cursor-pointer group">
      {(label || description) && (
        <span>
          {label && <span className="block text-sm font-semibold">{label}</span>}
          {description && <span className="block text-xs text-ink-soft mt-0.5">{description}</span>}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
          checked ? "bg-accent" : "bg-line-strong"
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200",
            checked && "translate-x-5"
          )}
        />
      </button>
    </label>
  );
}

/* ---------------------------------- Card ----------------------------------- */

export function Card({ className, children, hover, ...rest }: { className?: string; children: ReactNode; hover?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("card", hover && "card-hover", className)} {...rest}>
      {children}
    </div>
  );
}

/* --------------------------------- Avatar ---------------------------------- */

const AVATAR_SIZES = { xs: 24, sm: 32, md: 40, lg: 56, xl: 80, "2xl": 112 } as const;

function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function Avatar({
  name,
  src,
  size = "md",
  className,
  ring,
}: {
  name: string;
  src?: string | null;
  size?: keyof typeof AVATAR_SIZES;
  className?: string;
  ring?: boolean;
}) {
  const px = AVATAR_SIZES[size];
  const url = mediaUrl(src);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  const hue = hashHue(name || "?");
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold select-none", ring && "ring-2 ring-surface", className)}
      style={{
        width: px,
        height: px,
        fontSize: px * 0.38,
        background: url ? undefined : `linear-gradient(135deg, hsl(${hue} 65% 45%), hsl(${(hue + 40) % 360} 75% 55%))`,
        color: "#fff",
      }}
      aria-hidden
    >
      {url ? <img src={url} alt={name} loading="lazy" className="h-full w-full object-cover" /> : initials || "?"}
    </span>
  );
}

export function OnlineDot({ className }: { className?: string }) {
  return <span className={cn("block h-2.5 w-2.5 rounded-full bg-success ring-2 ring-surface", className)} aria-label="Online" />;
}

/* ---------------------------------- Badge ---------------------------------- */

type BadgeTone = "neutral" | "accent" | "success" | "warn" | "danger";
const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-ink-soft",
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
};

export function Badge({ tone = "neutral", className, children }: { tone?: BadgeTone; className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold", BADGE_TONES[tone], className)}>
      {children}
    </span>
  );
}

/* Verified badge colours an administrator can hand out. "brand" and a missing
   colour both mean the app accent, which follows the theme. */
export const VERIFIED_COLORS: Record<string, string> = {
  brand: "var(--accent)",
  blue: "#1d9bf0",
  green: "#17a34a",
  gold: "#d9a407",
  purple: "#8b5cf6",
  red: "#e0245e",
  teal: "#0d9488",
};

export const VERIFIED_COLOR_ORDER = ["brand", "blue", "green", "gold", "purple", "red", "teal"];

export function VerifiedBadge({ size = 15, color }: { size?: number; color?: string }) {
  const fill = (color && VERIFIED_COLORS[color]) || "var(--accent)";
  return (
    <span title={color && color !== "brand" ? `Verified · ${color}` : "Verified"} aria-label="Verified account" className="inline-flex">
      <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden>
        <path
          d="M10 1.5 12.2 3.4l2.9-.3 1 2.7 2.5 1.5-1.1 2.7 1.1 2.7-2.5 1.5-1 2.7-2.9-.3L10 18.5 7.8 16.6l-2.9.3-1-2.7L1.4 12.7l1.1-2.7-1.1-2.7 2.5-1.5 1-2.7 2.9.3L10 1.5Z"
          fill={fill}
        />
        <path d="m6.8 10.2 2.1 2.1 4.3-4.3" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    </span>
  );
}

/* ---------------------------------- Tabs ----------------------------------- */

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

export function Tabs({ items, value, onChange, className }: { items: TabItem[]; value: string; onChange: (id: string) => void; className?: string }) {
  return (
    <div role="tablist" className={cn("flex gap-1 overflow-x-auto hide-scrollbar border-b border-line", className)}>
      {items.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "relative whitespace-nowrap px-3.5 py-2.5 text-sm font-semibold transition-colors",
            value === t.id ? "text-accent" : "text-ink-soft hover:text-ink"
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 text-xs text-ink-faint">{t.count}</span>}
          {value === t.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
        </button>
      ))}
    </div>
  );
}

export function SegmentedControl({ options, value, onChange, className }: { options: { value: string; label: ReactNode }[]; value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <div className={cn("inline-flex rounded-xl bg-surface-2 p-1 gap-0.5", className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-all",
            value === o.value ? "bg-surface text-ink shadow-sm" : "text-ink-soft hover:text-ink"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------- Chip ------------------------------------ */

export function Chip({ active, onClick, children, className }: { active?: boolean; onClick?: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-semibold transition-all",
        active ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink",
        className
      )}
    >
      {children}
    </button>
  );
}

/* --------------------------------- Modal ----------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
  mobileSheet,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  mobileSheet?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;
  const widths = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="absolute inset-0 bg-black/50 anim-fade-in" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative w-full bg-surface border border-line shadow-pop sm:rounded-2xl",
          widths[size],
          "max-h-[92vh] flex flex-col rounded-t-3xl sm:rounded-t-2xl",
          mobileSheet ? "anim-sheet-up sm:anim-scale-in" : "anim-scale-in"
        )}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line-strong sm:hidden" aria-hidden />
        {title && (
          <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-line shrink-0">
            <h2 className="text-base font-bold">{title}</h2>
            <button onClick={onClose} aria-label="Close dialog" className="p-1.5 rounded-lg text-ink-soft hover:bg-surface-2 hover:text-ink transition-colors">
              <X size={18} />
            </button>
          </div>
        )}
        <div className="overflow-y-auto px-5 py-4 flex-1">{children}</div>
        {footer && <div className="border-t border-line px-5 py-3.5 flex justify-end gap-2 shrink-0 safe-bottom">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/* --------------------------------- Drawer ---------------------------------- */

export function Drawer({ open, onClose, side = "right", width = "max-w-md", children, label }: { open: boolean; onClose: () => void; side?: "left" | "right"; width?: string; children: ReactNode; label: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[90]">
      <div className="absolute inset-0 bg-black/50 anim-fade-in" onClick={onClose} aria-hidden />
      <aside
        aria-label={label}
        className={cn(
          "absolute top-0 bottom-0 w-full sm:w-auto sm:min-w-[380px] bg-surface border-line shadow-pop flex flex-col",
          width,
          side === "right" ? "right-0 border-l anim-slide-right" : "left-0 border-r anim-slide-right"
        )}
      >
        {children}
      </aside>
    </div>,
    document.body
  );
}

/* -------------------------------- Dropdown --------------------------------- */

export function Dropdown({ trigger, align = "right", children }: { trigger: (props: { open: boolean; toggle: () => void }) => ReactNode; align?: "left" | "right"; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          className={cn(
            "absolute top-full mt-1.5 z-50 min-w-[200px] bg-surface border border-line rounded-xl shadow-pop p-1.5 anim-scale-in origin-top",
            align === "right" ? "right-0" : "left-0"
          )}
          role="menu"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, onClick, danger, children }: { icon?: ReactNode; onClick?: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors",
        danger ? "text-danger hover:bg-danger-soft" : "text-ink hover:bg-surface-2"
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/* --------------------------------- Tooltip --------------------------------- */

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="relative group/tt inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[11px] font-medium text-canvas opacity-0 transition-opacity group-hover/tt:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}

/* -------------------------------- Skeletons -------------------------------- */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden />;
}

export function SkeletonPost() {
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-full" />
        <div className="space-y-2 flex-1">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-2.5 w-44" />
        </div>
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </Card>
  );
}

export function SkeletonCard({ height = "h-36" }: { height?: string }) {
  return (
    <Card className="overflow-hidden">
      <Skeleton className={cn("w-full rounded-none", height)} />
      <div className="p-3 space-y-2">
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </Card>
  );
}

/* ------------------------------- Progress bar ------------------------------ */

export function ProgressBar({ value, className, tone = "accent", showLabel }: { value: number; className?: string; tone?: "accent" | "success" | "warn"; showLabel?: boolean }) {
  const pct = Math.min(100, Math.max(0, Math.round(value)));
  const bg = { accent: "bg-accent", success: "bg-success", warn: "bg-warn" }[tone];
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-1.5 flex-1 rounded-full bg-surface-2 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn("h-full rounded-full transition-all duration-700", bg)} style={{ width: `${pct}%` }} />
      </div>
      {showLabel && <span className="text-xs font-semibold text-ink-soft tabular-nums w-9 text-right">{pct}%</span>}
    </div>
  );
}

export function ProgressRing({ value, size = 64, stroke = 6, children }: { value: number; size?: number; stroke?: number; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - (pct / 100) * c}
          style={{ transition: "stroke-dashoffset 0.8s ease" }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center">{children}</span>
    </div>
  );
}

/* ------------------------------ Empty / Error ------------------------------ */

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6 anim-fade-up">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-soft text-accent [&_svg]:h-8 [&_svg]:w-8" aria-hidden>
        {icon}
      </div>
      <h3 className="text-base font-bold">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm text-ink-soft">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-danger-soft text-danger" aria-hidden>
        <X size={26} />
      </div>
      <h3 className="text-base font-bold">Something went wrong</h3>
      <p className="mt-1.5 max-w-sm text-sm text-ink-soft">{message ?? "We couldn't load this content. Please try again."}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/* --------------------------------- Toggle ---------------------------------- */

export function CheckPill({ checked, onToggle, children }: { checked: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={checked}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-semibold transition-all",
        checked ? "border-accent bg-accent text-white" : "border-line bg-surface text-ink-soft hover:border-line-strong"
      )}
    >
      {checked && <Check size={13} aria-hidden />}
      {children}
    </button>
  );
}
