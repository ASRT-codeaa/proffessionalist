import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowLeft,
  BadgeCheck,
  BadgeX,
  Ban,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleDollarSign,
  Clock,
  ExternalLink,
  Eye,
  FileText,
  Flag,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Megaphone,
  Menu,
  MessageSquare,
  MoreHorizontal,
  MoveHorizontal,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingBag,
  Trash2,
  TrendingUp,
  Users,
  X,
} from "lucide-react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Drawer,
  Dropdown,
  EmptyState,
  ErrorState,
  Input,
  MenuItem,
  Modal,
  ProgressBar,
  Skeleton,
  Tooltip,
  VERIFIED_COLOR_ORDER,
  VerifiedBadge,
} from "@/components/ui";
import { LogoSymbol } from "@/components/Logo";
import { errorMessage, useAsync, useDebounced } from "@/hooks/useAsync";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { adminApi, marketplaceApi, postsApi, searchApi } from "@/services/api";
import { mediaUrl } from "@/services/http";
import type {
  AdminBusinessRow,
  AdminReportRow,
  AdminStats,
  AdminTransactionRow,
  AdminUserRow,
  Business,
  Campaign,
  Listing,
  Person,
  Post,
  SupportTicket,
} from "@/services/types";
import { cn, formatNumber, formatPrice, fullName, timeAgo } from "@/lib/utils";

/* ------------------------------- navigation -------------------------------- */

type SectionId = "dashboard" | "users" | "businesses" | "marketplace" | "posts" | "reports" | "transactions" | "tickets" | "ads";

interface SectionMeta {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  title: string;
  description: string;
}

const SECTIONS: SectionMeta[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, title: "Platform overview", description: "Live totals, growth trends and the busiest categories." },
  { id: "users", label: "Users", icon: Users, title: "User management", description: "Search accounts, hand out verified badges in any colour, suspend or delete abusive ones." },
  { id: "businesses", label: "Businesses", icon: Building2, title: "Business pages", description: "Grant or revoke the verified badge on company pages." },
  { id: "marketplace", label: "Marketplace", icon: ShoppingBag, title: "Listings moderation", description: "Every product and service listing on the platform." },
  { id: "posts", label: "Posts", icon: FileText, title: "Content moderation", description: "Recent posts across the feed with their author and engagement." },
  { id: "reports", label: "Reports", icon: Flag, title: "Trust & safety reports", description: "Work queued for review, resolved or dismissed." },
  { id: "transactions", label: "Transactions", icon: CircleDollarSign, title: "Payments ledger", description: "Sales, payouts, subscriptions and campaign charges." },
  { id: "tickets", label: "Support tickets", icon: LifeBuoy, title: "Support inbox", description: "Conversations between members and the support team." },
  { id: "ads", label: "Advertisements", icon: Megaphone, title: "Ad campaigns", description: "Budget, spend and delivery for every campaign." },
];

/* --------------------------------- helpers --------------------------------- */

/** `design-studio` reads better as `Design studio` in a table cell. */
function prettify(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "—";
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function dateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function monthLabels(length: number): string[] {
  const now = new Date();
  return Array.from({ length }, (_, i) =>
    new Date(now.getFullYear(), now.getMonth() - (length - 1 - i), 1).toLocaleDateString(undefined, { month: "short" })
  );
}

function statusTone(status: string): "neutral" | "accent" | "success" | "warn" | "danger" {
  switch (status) {
    case "completed":
    case "resolved":
    case "active":
    case "open":
      return status === "open" ? "warn" : "success";
    case "pending":
    case "reviewing":
    case "paused":
      return "warn";
    case "refunded":
    case "dismissed":
    case "removed":
    case "sold":
      return "danger";
    case "draft":
    case "sold_out":
      return "neutral";
    default:
      return "neutral";
  }
}

/** Post authors are either people or business pages, so every display field needs the union narrowed. */
function authorKind(post: Post): "business" | "user" {
  return post.authorType === "business" ? "business" : "user";
}

function authorName(post: Post): string {
  return authorKind(post) === "business" ? (post.author as Business).name : fullName(post.author as Person);
}

function authorAvatar(post: Post): string {
  return authorKind(post) === "business" ? (post.author as Business).logoUrl : (post.author as Person).avatarUrl;
}

function authorHref(post: Post): string {
  if (authorKind(post) === "business") return `/business/${(post.author as Business).slug}`;
  return `/profile/${(post.author as Person).username}`;
}

/* ------------------------------ table scaffold ------------------------------ */

interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  footer?: boolean;
}

function DataTable<T>({ columns, rows, keyOf, minWidth = 760 }: { columns: Column<T>[]; rows: T[]; keyOf: (row: T) => string | number; minWidth?: number }) {
  const cardCols = columns.filter((c) => !c.footer);
  const footCols = columns.filter((c) => c.footer);

  return (
    <div>
      <p className="mb-2 hidden items-center gap-1 text-[11px] font-semibold text-ink-faint md:flex lg:hidden" aria-hidden>
        <MoveHorizontal size={12} /> Swipe the table to see every column
      </p>

      <div className="hidden overflow-x-auto pb-1 md:block">
        <table className="w-full border-collapse text-left text-sm" style={{ minWidth: `${minWidth}px` }}>
          <thead>
            <tr className="border-b border-line">
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn("whitespace-nowrap px-3 py-2.5 text-[11px] font-bold uppercase tracking-wide text-ink-faint", c.align === "right" && "text-right")}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={keyOf(row)} className="border-b border-line align-middle transition-colors last:border-0 hover:bg-surface-2/60">
                {columns.map((c) => (
                  <td key={c.key} className={cn("px-3 py-3", c.align === "right" && "text-right tabular-nums")}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2.5 md:hidden">
        {rows.map((row) => (
          <li key={keyOf(row)} className="rounded-xl border border-line bg-surface p-3 anim-fade-up">
            <dl className="space-y-2">
              {cardCols.map((c, i) => (
                <div key={c.key} className={cn("flex items-start justify-between gap-3", i === 0 && "block")}>
                  <dt className={i === 0 ? "sr-only" : "shrink-0 pt-0.5 text-[11px] font-bold uppercase tracking-wide text-ink-faint"}>{c.header}</dt>
                  <dd className={cn("min-w-0", i === 0 ? "w-full" : "text-right text-sm font-medium")}>{c.cell(row)}</dd>
                </div>
              ))}
            </dl>
            {footCols.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                {footCols.map((c) => (
                  <div key={c.key} className="contents">
                    {c.cell(row)}
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TableSkeleton({ rows = 6, height = "h-14" }: { rows?: number; height?: string }) {
  return (
    <div className="space-y-2.5" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-9 w-full rounded-lg" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={cn("w-full rounded-xl", height)} />
      ))}
    </div>
  );
}

function SectionState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Card className="p-4">
      <ErrorState message={errorMessage(error)} onRetry={onRetry} />
    </Card>
  );
}

function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative min-w-0 flex-1 sm:max-w-xs">
      <Input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        icon={<Search size={15} />}
        className="pr-9"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
}

function AdminToolbar({ children }: { children: ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center gap-2.5">{children}</div>;
}

/** Filter pill with a real `aria-pressed` state and a leading icon, so the active filter is never colour-only. */
function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex min-h-[40px] items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-semibold transition-colors",
        active ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink"
      )}
    >
      {active && <Check size={13} aria-hidden />}
      {children}
    </button>
  );
}

function SectionIntro({ meta, count, children }: { meta: SectionMeta; count?: number; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="flex flex-wrap items-center gap-2 text-lg font-extrabold sm:text-xl">
          <meta.icon size={18} className="text-accent" aria-hidden />
          {meta.title}
          {count !== undefined && (
            <Badge tone="neutral">
              {formatNumber(count)} {count === 1 ? "record" : "records"}
            </Badge>
          )}
        </h1>
        <p className="mt-1 text-[13px] text-ink-soft">{meta.description}</p>
      </div>
      {children}
    </div>
  );
}

interface ConfirmRequest {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
}

function ConfirmModal({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!request) return;
    setBusy(true);
    try {
      await request.onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!request}
      onClose={onClose}
      title={request?.title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void run()} loading={busy}>
            {request?.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger-soft text-danger" aria-hidden>
          <CircleAlert size={20} />
        </span>
        <div className="min-w-0 text-sm leading-relaxed text-ink-soft">{request?.body}</div>
      </div>
    </Modal>
  );
}

function Pager({ page, pageSize, total, hasMore, onPage }: { page: number; pageSize: number; total: number; hasMore: boolean; onPage: (p: number) => void }) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
      <p className="text-xs text-ink-soft tabular-nums">
        Showing <strong className="text-ink">{from}–{to}</strong> of <strong className="text-ink">{formatNumber(total)}</strong>
      </p>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="outline" className="min-h-[40px]" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
          <ChevronLeft size={15} aria-hidden /> Prev
        </Button>
        <span className="px-1 text-xs font-semibold text-ink-soft tabular-nums" aria-live="polite">
          Page {page} of {pages}
        </span>
        <Button size="sm" variant="outline" className="min-h-[40px]" onClick={() => onPage(page + 1)} disabled={!hasMore} aria-label="Next page">
          Next <ChevronRight size={15} aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------- dashboard --------------------------------- */

function StatCard({ icon, label, value, sub }: { icon: ReactNode; label: string; value: string; sub?: string }) {
  return (
    <Card className="p-3.5 anim-fade-up">
      <div className="flex items-start gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent" aria-hidden>
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">{label}</p>
          <p className="mt-0.5 truncate text-xl font-extrabold tabular-nums leading-tight">{value}</p>
          {sub && <p className="mt-0.5 truncate text-[11px] text-ink-soft">{sub}</p>}
        </div>
      </div>
    </Card>
  );
}

function TrendChart({ values, labels, format, title }: { values: number[]; labels: string[]; format: (v: number) => string; title: string }) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const n = values.length;
  if (n === 0) return <p className="text-sm text-ink-soft">No trend data yet.</p>;

  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const points = values.map((v, i) => ({ x: n === 1 ? 50 : (i / (n - 1)) * 100, y: 42 - ((v - min) / span) * 32 }));
  const line = points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const area = `${line} L100,44 L0,44 Z`;
  const growth = values[0] > 0 ? ((values[n - 1] - values[0]) / values[0]) * 100 : 0;
  const active = hover ?? n - 1;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-2xl font-extrabold tabular-nums">{format(values[active])}</p>
        <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums", growth >= 0 ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
          <TrendingUp size={11} aria-hidden className={growth >= 0 ? "" : "rotate-180"} />
          {growth >= 0 ? "+" : ""}
          {growth.toFixed(1)}% · {labels[active] ?? ""}
        </span>
      </div>

      <div className="relative mt-3">
        <svg viewBox="0 0 100 44" preserveAspectRatio="none" className="h-28 w-full overflow-visible" role="img" aria-label={`${title}: ${values.map((v, i) => `${labels[i]} ${format(v)}`).join(", ")}`}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradientId})`} />
          <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        <span
          className="pointer-events-none absolute z-10 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent shadow-sm"
          style={{ left: `${points[active].x}%`, top: `${(points[active].y / 44) * 100}%` }}
          aria-hidden
        />

        {hover !== null && (
          <span
            className="pointer-events-none absolute -top-2 z-20 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[11px] font-bold text-canvas shadow-pop"
            style={{ left: `${points[hover].x}%`, transform: points[hover].x < 12 ? "none" : points[hover].x > 88 ? "translateX(-100%)" : "translateX(-50%)" }}
            role="status"
          >
            {labels[hover]} · {format(values[hover])}
          </span>
        )}

        <div className="absolute inset-0 flex">
          {values.map((v, i) => (
            <button
              key={`${labels[i]}-${i}`}
              type="button"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              onClick={() => setHover(i)}
              aria-label={`${labels[i]}: ${format(v)}`}
              className="h-full flex-1 rounded-md focus-visible:bg-accent-soft"
            />
          ))}
        </div>
      </div>

      <div className="mt-1.5 flex justify-between text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
        {labels
          .filter((_, i) => i % Math.ceil(labels.length / 4) === 0 || i === labels.length - 1)
          .slice(0, 5)
          .map((l, idx) => (
            <span key={`${l}-${idx}`}>{l}</span>
          ))}
      </div>
    </div>
  );
}

function BarList({ items }: { items: { name: string; count: number }[] }) {
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <ul className="space-y-2.5">
      {items.map((c) => (
        <li key={c.name}>
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <span className="min-w-0 truncate font-semibold">{c.name}</span>
            <span className="shrink-0 tabular-nums text-ink-soft">{formatNumber(c.count)}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${c.name}: ${c.count} listings`}>
            <div className="h-full rounded-full bg-accent transition-all duration-700" style={{ width: `${(c.count / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function DashboardSection() {
  const q = useAsync(() => adminApi.stats(), []);
  const labels = useMemo(() => monthLabels(12), []);

  useEffect(() => {
    document.title = "Admin dashboard | Professionalist";
  }, []);

  if (q.loading && !q.data) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading platform statistics">
        <Skeleton className="h-10 w-52" />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-56 rounded-2xl" />
          <Skeleton className="h-56 rounded-2xl" />
        </div>
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (!q.data) return <SectionState error={q.error} onRetry={q.refetch} />;

  const s: AdminStats = q.data;
  const t = s.totals;
  const activePct = t.users ? Math.round((t.activeUsers / t.users) * 100) : 0;
  const revenuePerActive = t.activeUsers ? t.revenue / t.activeUsers : 0;

  return (
    <div className="space-y-4">
      <SectionIntro meta={SECTIONS[0]}>
        <Button size="sm" variant="outline" className="min-h-[40px]" onClick={q.refetch} loading={q.loading}>
          <RefreshCw size={14} aria-hidden /> Refresh
        </Button>
      </SectionIntro>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard icon={<Users size={17} />} label="Users" value={formatNumber(t.users)} sub={`${formatNumber(t.activeUsers)} active`} />
        <StatCard icon={<Activity size={17} />} label="Active users" value={formatNumber(t.activeUsers)} sub={`${activePct}% of all accounts`} />
        <StatCard icon={<Building2 size={17} />} label="Businesses" value={formatNumber(t.businesses)} sub="verified company pages" />
        <StatCard icon={<ShoppingBag size={17} />} label="Products" value={formatNumber(t.products)} sub="live listings" />
        <StatCard icon={<FileText size={17} />} label="Posts" value={formatNumber(t.posts)} sub="published to feeds" />
        <StatCard icon={<MessageSquare size={17} />} label="Messages" value={formatNumber(t.messages)} sub="exchanged" />
        <StatCard icon={<Flag size={17} />} label="Reports" value={formatNumber(t.reports)} sub="all time" />
        <StatCard icon={<CircleDollarSign size={17} />} label="Revenue" value={formatPrice(t.revenue, "fixed")} sub={`${formatPrice(revenuePerActive, "fixed")} per active user`} />
      </div>

      <Card className="flex flex-wrap items-center justify-between gap-3 border-accent/35 bg-accent-soft p-4">
        <p className="flex items-center gap-2 text-sm font-bold text-accent">
          <Clock size={16} aria-hidden /> {formatNumber(s.signupsToday)} new signups today
        </p>
        <p className="text-xs font-semibold text-accent">
          {formatNumber(t.users + s.signupsToday)} accounts on the platform
        </p>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4 anim-fade-up">
          <h2 className="text-sm font-bold">User growth</h2>
          <p className="mb-1 mt-0.5 text-xs text-ink-soft">Accounts per month, last 12 months</p>
          <TrendChart values={s.userTrend} labels={labels} format={(v) => formatNumber(v)} title="User growth" />
        </Card>
        <Card className="p-4 anim-fade-up">
          <h2 className="text-sm font-bold">Revenue</h2>
          <p className="mb-1 mt-0.5 text-xs text-ink-soft">Gross platform revenue per month, last 12 months</p>
          <TrendChart values={s.revenueTrend} labels={labels} format={(v) => formatPrice(v, "fixed")} title="Revenue" />
        </Card>
      </div>

      <Card className="p-4 anim-fade-up">
        <h2 className="text-sm font-bold">Busiest categories</h2>
        <p className="mb-3 mt-0.5 text-xs text-ink-soft">Listings per category across the marketplace</p>
        {s.topCategories.length ? (
          <BarList items={s.topCategories} />
        ) : (
          <p className="text-sm text-ink-soft">No category activity recorded.</p>
        )}
      </Card>
    </div>
  );
}

/* ---------------------------------- users ---------------------------------- */

type UserRowAction = "suspend" | "unsuspend" | "verify" | "unverify" | "delete";

const badgeName = (color: string) =>
  !color || color === "brand" ? "Accent" : color.charAt(0).toUpperCase() + color.slice(1);

const USER_ACTION_TOAST: Record<Exclude<UserRowAction, "verify">, string> = {
  suspend: "Account suspended",
  unsuspend: "Suspension lifted",
  unverify: "Verification removed",
  delete: "Account deleted",
};

function UserRowActions({ row, onAction, me }: { row: AdminUserRow; onAction: (row: AdminUserRow, action: UserRowAction, badge?: string) => void; me: number }) {
  const isMe = row.id === me;
  const navigate = useNavigate();

  return (
    <div className="flex justify-end">
      <Dropdown
        trigger={({ toggle, open }) => (
          <button
            onClick={toggle}
            aria-label={`Actions for ${row.name}`}
            aria-expanded={open}
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-line-strong bg-surface text-ink-soft transition-colors hover:bg-surface-2"
          >
            <MoreHorizontal size={16} />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuItem
              icon={<ExternalLink size={16} />}
              onClick={() => {
                close();
                navigate(`/profile/${row.username}`);
              }}
            >
              View profile
            </MenuItem>
            <div className="my-1 h-px bg-line" />
            <div className="px-2 pb-1 pt-1.5">
              <p className="px-1 text-[11px] font-bold uppercase tracking-wide text-ink-faint">Verified badge</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {VERIFIED_COLOR_ORDER.map((color) => {
                  const active = row.verified && (row.verifiedColor || "brand") === color;
                  return (
                    <Tooltip key={color} label={`${badgeName(color)} badge`}>
                      <button
                        role="menuitemradio"
                        aria-checked={active}
                        aria-label={`Grant the ${badgeName(color)} verified badge`}
                        onClick={() => {
                          close();
                          onAction(row, "verify", color);
                        }}
                        className={cn(
                          "flex h-9 w-9 items-center justify-center rounded-lg border transition-colors hover:bg-surface-2",
                          active ? "border-line-strong bg-surface-2 ring-2 ring-accent-soft" : "border-line bg-surface"
                        )}
                      >
                        <VerifiedBadge size={17} color={color} />
                      </button>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
            {row.verified && (
              <MenuItem
                icon={<BadgeX size={16} />}
                onClick={() => {
                  close();
                  onAction(row, "unverify");
                }}
              >
                Remove verification
              </MenuItem>
            )}
            {!isMe && (
              <>
                <MenuItem
                  icon={<Ban size={16} />}
                  onClick={() => {
                    close();
                    onAction(row, row.suspended ? "unsuspend" : "suspend");
                  }}
                >
                  {row.suspended ? "Lift suspension" : "Suspend account"}
                </MenuItem>
                <MenuItem
                  icon={<Trash2 size={16} />}
                  danger
                  onClick={() => {
                    close();
                    onAction(row, "delete");
                  }}
                >
                  Delete account
                </MenuItem>
              </>
            )}
            {isMe && (
              <p className="flex items-center gap-1.5 px-3 py-2 text-[11px] font-bold text-ink-faint">
                <ShieldCheck size={12} aria-hidden /> Your account · badges only
              </p>
            )}
          </>
        )}
      </Dropdown>
    </div>
  );
}

function UsersSection({ onCount }: { onCount: (n: number) => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), 350);
  const [page, setPage] = useState(1);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    setPage(1);
  }, [debounced]);

  const q = useAsync(() => adminApi.users({ q: debounced || undefined, page, pageSize: 10 }), [debounced, page]);
  const rows = q.data?.items ?? [];

  useEffect(() => {
    if (q.data) onCount(q.data.total);
  }, [q.data, onCount]);

  /* The section only ever mutates while a page of rows is loaded, so read the current
     snapshot directly instead of using an updater that has to handle `null`. */
  const mutate = (id: number, patch: Partial<AdminUserRow>) => {
    const prev = q.data;
    if (!prev) return;
    q.setData({ ...prev, items: prev.items.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  };

  const remove = (id: number) => {
    const prev = q.data;
    if (!prev) return;
    q.setData({ ...prev, items: prev.items.filter((r) => r.id !== id) });
  };

  const run = async (row: AdminUserRow, action: UserRowAction, badge?: string) => {
    const prev = q.data;
    if (!prev) return;
    if (action === "delete") remove(row.id);
    else if (action === "suspend" || action === "unsuspend") mutate(row.id, { suspended: action === "suspend" });
    else if (action === "verify") mutate(row.id, { verified: true, verifiedColor: badge ?? "brand" });
    else mutate(row.id, { verified: false, verifiedColor: "" });

    try {
      await adminApi.userAction(row.id, action, badge);
      toast.success(
        action === "verify" ? `${badgeName(badge ?? "brand")} badge granted` : USER_ACTION_TOAST[action],
        `${row.name} · @${row.username}`
      );
    } catch (e) {
      q.setData(prev);
      toast.error("Action failed", errorMessage(e));
    }
  };

  const ask = (row: AdminUserRow, action: "suspend" | "delete") => {
    setConfirm({
      title: action === "delete" ? `Delete ${row.name}?` : `Suspend ${row.name}?`,
      body:
        action === "delete" ? (
          <>
            Deleting removes <strong className="text-ink">{row.name}</strong> (@{row.username}) from the platform, including {row.posts} post
            {row.posts === 1 ? "" : "s"}. This cannot be undone from the console.
          </>
        ) : (
          <>
            <strong className="text-ink">{row.name}</strong> (@{row.username}) will not be able to sign in, post or sell until you lift the suspension.
          </>
        ),
      confirmLabel: action === "delete" ? "Delete account" : "Suspend account",
      onConfirm: () => run(row, action),
    });
  };

  const onAction = (row: AdminUserRow, action: UserRowAction, badge?: string) => {
    if (action === "delete" || action === "suspend") {
      ask(row, action);
      return;
    }
    void run(row, action, badge);
  };

  const columns: Column<AdminUserRow>[] = [
    {
      key: "user",
      header: "Member",
      cell: (r) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar name={r.name} size="sm" />
          <div className="min-w-0">
            <Link to={`/profile/${r.username}`} className="block max-w-[220px] truncate font-bold hover:underline">
              {r.name}
            </Link>
            <p className="max-w-[220px] truncate text-xs text-ink-faint">
              @{r.username} · {r.email}
            </p>
          </div>
        </div>
      ),
    },
    { key: "role", header: "Role", cell: (r) => <Badge tone={r.role === "admin" ? "warn" : "neutral"}>{r.role === "admin" ? "Admin" : "Member"}</Badge> },
    {
      key: "status",
      header: "Status",
      cell: (r) =>
        r.suspended ? (
          <Badge tone="danger">
            <Ban size={11} aria-hidden /> Suspended
          </Badge>
        ) : r.verified ? (
          <Badge tone="success">
            <VerifiedBadge size={12} color={r.verifiedColor} />
            {r.verifiedColor && r.verifiedColor !== "brand" ? `${badgeName(r.verifiedColor)} verified` : "Verified"}
          </Badge>
        ) : (
          <Badge tone="neutral">
            <Clock size={11} aria-hidden /> Unverified
          </Badge>
        ),
    },
    { key: "posts", header: "Posts", align: "right", cell: (r) => formatNumber(r.posts) },
    { key: "joined", header: "Joined", cell: (r) => <span className="text-ink-soft">{shortDate(r.joinedAt)}</span> },
    {
      key: "actions",
      header: "Actions",
      footer: true,
      cell: (r) => <UserRowActions row={r} onAction={onAction} me={user?.id ?? -1} />,
    },
  ];

  return (
    <div>
      <SectionIntro meta={SECTIONS[1]} count={q.data?.total}>
        <Button size="sm" variant="outline" className="min-h-[40px]" onClick={q.refetch} loading={q.loading}>
          <RefreshCw size={14} aria-hidden /> Refresh
        </Button>
      </SectionIntro>

      <AdminToolbar>
        <SearchBar value={query} onChange={setQuery} placeholder="Search name, username or email" />
        {debounced && (
          <Badge tone="accent">
            Filtered by “{debounced}”
          </Badge>
        )}
      </AdminToolbar>

      {q.loading && <TableSkeleton />}

      {!q.loading && !q.data && <SectionState error={q.error} onRetry={q.refetch} />}

      {q.data && rows.length === 0 && (
        <Card>
          <EmptyState
            icon={<Search />}
            title="No accounts match"
            description={debounced ? `Nothing found for “${debounced}”. Check the spelling or search by email.` : "There are no user accounts yet."}
            action={
              debounced ? (
                <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              ) : undefined
            }
          />
        </Card>
      )}

      {q.data && rows.length > 0 && (
        <>
          <Card className="p-2 sm:p-3">
            <DataTable columns={columns} rows={rows} keyOf={(r) => r.id} minWidth={880} />
          </Card>
          <Pager
            page={q.data.page}
            pageSize={q.data.pageSize}
            total={q.data.total}
            hasMore={q.data.hasMore}
            onPage={(p) => setPage(Math.max(1, p))}
          />
        </>
      )}

      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

/* -------------------------------- businesses -------------------------------- */

function BusinessesSection({ onCount }: { onCount: (n: number) => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), 350);
  const [openBusy, setOpenBusy] = useState<number | null>(null);

  const q = useAsync(() => adminApi.businesses({ q: debounced || undefined }), [debounced]);
  const rows = q.data ?? [];

  useEffect(() => {
    if (q.data) onCount(q.data.length);
  }, [q.data, onCount]);

  const setVerified = (row: AdminBusinessRow, verified: boolean) => {
    const prev = q.data ?? [];
    q.setData(prev.map((r) => (r.id === row.id ? { ...r, verified } : r)));
    void (async () => {
      try {
        await adminApi.verifyBusiness(row.id, verified);
        toast.success(verified ? "Business verified" : "Verification removed", row.name);
      } catch (e) {
        q.setData(prev);
        toast.error("Action failed", errorMessage(e));
      }
    })();
  };

  /** Admin rows carry no slug, so resolve the real one through search before deep-linking. */
  const openPage = async (row: AdminBusinessRow) => {
    setOpenBusy(row.id);
    try {
      const results = await searchApi.global(row.name, "businesses");
      const match = results.businesses.find((b) => b.id === row.id) ?? results.businesses.find((b) => b.name === row.name);
      if (match) navigate(`/business/${match.slug}`);
      else toast.error("No public page found", "This business has no resolvable slug — it may have been removed.");
    } catch (e) {
      toast.error("Could not open the page", errorMessage(e));
    } finally {
      setOpenBusy(null);
    }
  };

  const columns: Column<AdminBusinessRow>[] = [
    {
      key: "business",
      header: "Business",
      cell: (r) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent" aria-hidden>
            <Building2 size={16} />
          </span>
          <div className="min-w-0">
            <p className="max-w-[240px] truncate font-bold">{r.name}</p>
            <p className="max-w-[240px] truncate text-xs text-ink-faint">{prettify(r.industry)}</p>
          </div>
        </div>
      ),
    },
    { key: "owner", header: "Owner", cell: (r) => <span className="text-ink-soft">{r.owner}</span> },
    { key: "listings", header: "Listings", align: "right", cell: (r) => formatNumber(r.listings) },
    { key: "followers", header: "Followers", align: "right", cell: (r) => formatNumber(r.followers) },
    { key: "created", header: "Created", cell: (r) => <span className="text-ink-soft">{shortDate(r.createdAt)}</span> },
    {
      key: "verified",
      header: "Verified",
      footer: true,
      cell: (r) => (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={r.verified ? "outline" : "soft"} className="min-h-[40px]" onClick={() => setVerified(r, !r.verified)}>
            <BadgeCheck size={14} aria-hidden /> {r.verified ? "Remove badge" : "Verify"}
          </Button>
          <Button size="sm" variant="ghost" className="min-h-[40px]" loading={openBusy === r.id} onClick={() => void openPage(r)}>
            <ExternalLink size={14} aria-hidden /> Public page
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <SectionIntro meta={SECTIONS[2]} count={q.data?.length}>
        <Button size="sm" variant="outline" className="min-h-[40px]" onClick={q.refetch} loading={q.loading}>
          <RefreshCw size={14} aria-hidden /> Refresh
        </Button>
      </SectionIntro>

      <AdminToolbar>
        <SearchBar value={query} onChange={setQuery} placeholder="Search business name" />
        {q.data && (
          <Badge tone="success">
            <BadgeCheck size={11} aria-hidden /> {q.data.filter((r) => r.verified).length} verified
          </Badge>
        )}
      </AdminToolbar>

      {q.loading && <TableSkeleton />}
      {!q.loading && !q.data && <SectionState error={q.error} onRetry={q.refetch} />}
      {q.data && rows.length === 0 && (
        <Card>
          <EmptyState
            icon={<Building2 />}
            title="No business pages found"
            description={query ? `Nothing matches “${query}”.` : "No company has created a business page yet."}
            action={
              query ? (
                <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={q.refetch}>
                  Reload
                </Button>
              )
            }
          />
        </Card>
      )}
      {q.data && rows.length > 0 && (
        <Card className="p-2 sm:p-3">
          <DataTable columns={columns} rows={rows} keyOf={(r) => r.id} minWidth={820} />
        </Card>
      )}
    </div>
  );
}

/* -------------------------------- marketplace ------------------------------- */

function MarketplaceSection({ onCount }: { onCount: (n: number) => void }) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), 350);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const q = useAsync(() => adminApi.listings({ q: debounced || undefined }), [debounced]);
  const rows = q.data ?? [];

  useEffect(() => {
    if (q.data) onCount(q.data.length);
  }, [q.data, onCount]);

  const removeListing = async (row: Listing) => {
    const prev = q.data ?? [];
    q.setData(prev.filter((r) => r.id !== row.id));
    try {
      await marketplaceApi.deleteListing(row.id);
      toast.success("Listing removed", `${row.title} is no longer visible in the marketplace.`);
    } catch (e) {
      q.setData(prev);
      toast.error("Could not remove listing", errorMessage(e));
    }
  };

  const columns: Column<Listing>[] = [
    {
      key: "listing",
      header: "Listing",
      cell: (r) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-surface-2">
            {r.images[0] ? <img src={mediaUrl(r.images[0])} alt="" loading="lazy" className="h-full w-full object-cover" /> : null}
          </span>
          <div className="min-w-0">
            <Link to={`/marketplace/${r.id}`} className="block max-w-[260px] truncate font-bold hover:underline">
              {r.title}
            </Link>
            <p className="text-xs text-ink-faint">
              #{r.id} · {r.category?.name ?? "Uncategorised"}
            </p>
          </div>
        </div>
      ),
    },
    { key: "kind", header: "Type", cell: (r) => <Badge tone="accent">{r.kind}</Badge> },
    { key: "seller", header: "Seller", cell: (r) => <span className="text-ink-soft">{r.seller.name}</span> },
    { key: "price", header: "Price", align: "right", cell: (r) => <span className="font-bold">{formatPrice(r.price, r.priceType, r.currency)}</span> },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <Badge tone={statusTone(r.status)}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> {r.status.replace("_", " ")}
        </Badge>
      ),
    },
    { key: "views", header: "Views", align: "right", cell: (r) => formatNumber(r.views) },
    {
      key: "actions",
      header: "Actions",
      footer: true,
      cell: (r) => (
        <div className="flex flex-wrap gap-2">
          <Link
            to={`/marketplace/${r.id}`}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-line-strong bg-surface px-3 text-[13px] font-semibold transition-colors hover:bg-surface-2"
          >
            <Eye size={14} aria-hidden /> Open listing
          </Link>
          <Button
            size="sm"
            variant="ghost"
            className="min-h-[40px] text-danger hover:bg-danger-soft"
            onClick={() =>
              setConfirm({
                title: `Remove “${r.title}”?`,
                body: (
                  <>
                    <strong className="text-ink">{r.title}</strong> disappears from search, category pages and the seller’s storefront straight away. The seller (
                    {r.seller.name}) keeps their account, and the listing leaves this moderation queue — this console has no restore action.
                  </>
                ),
                confirmLabel: "Remove listing",
                onConfirm: () => removeListing(r),
              })
            }
          >
            <Trash2 size={14} aria-hidden /> Remove
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <SectionIntro meta={SECTIONS[3]} count={q.data?.length}>
        <Button size="sm" variant="outline" className="min-h-[40px]" onClick={q.refetch} loading={q.loading}>
          <RefreshCw size={14} aria-hidden /> Refresh
        </Button>
      </SectionIntro>

      <AdminToolbar>
        <SearchBar value={query} onChange={setQuery} placeholder="Search listing title" />
        <span className="text-xs text-ink-faint">Showing the 50 most recent matches.</span>
      </AdminToolbar>

      {q.loading && <TableSkeleton />}
      {!q.loading && !q.data && <SectionState error={q.error} onRetry={q.refetch} />}
      {q.data && rows.length === 0 && (
        <Card>
          <EmptyState
            icon={<ShoppingBag />}
            title="No listings found"
            description={query ? `Nothing matches “${query}”.` : "The marketplace has no live listings yet."}
            action={
              query ? (
                <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              ) : (
                <Link
                  to="/marketplace"
                  className="inline-flex min-h-[40px] items-center rounded-xl border border-line-strong bg-surface px-4 text-sm font-semibold transition-colors hover:bg-surface-2"
                >
                  Browse the marketplace
                </Link>
              )
            }
          />
        </Card>
      )}
      {q.data && rows.length > 0 && (
        <Card className="p-2 sm:p-3">
          <DataTable columns={columns} rows={rows} keyOf={(r) => r.id} minWidth={900} />
        </Card>
      )}

      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

/* ---------------------------------- posts ----------------------------------- */

function PostsSection({ onCount }: { onCount: (n: number) => void }) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), 350);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const q = useAsync(() => adminApi.posts({ q: debounced || undefined }), [debounced]);
  const rows = q.data ?? [];

  useEffect(() => {
    if (q.data) onCount(q.data.length);
  }, [q.data, onCount]);

  const removePost = async (row: Post) => {
    const prev = q.data ?? [];
    q.setData(prev.filter((r) => r.id !== row.id));
    try {
      await postsApi.delete(row.id);
      toast.success("Post deleted", "It no longer appears in any feed.");
    } catch (e) {
      q.setData(prev);
      toast.error("Could not delete post", errorMessage(e));
    }
  };

  const columns: Column<Post>[] = [
    {
      key: "post",
      header: "Post",
      cell: (r) => (
        <div className="min-w-0">
          <p className="max-w-[320px] text-sm leading-snug line-clamp-2">{r.text || <span className="italic text-ink-faint">(no text)</span>}</p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
            <Badge tone="neutral">{r.kind}</Badge>
            {r.media.length > 0 && <span>{r.media.length} attachment{r.media.length === 1 ? "" : "s"}</span>}
            {r.audience === "connections" && <span>connections only</span>}
          </p>
        </div>
      ),
    },
    {
      key: "author",
      header: "Author",
      cell: (r) => (
        <div className="flex min-w-0 items-center gap-2">
          <Avatar name={authorName(r)} src={mediaUrl(authorAvatar(r))} size="xs" />
          <Link to={authorHref(r)} className="max-w-[150px] truncate font-semibold hover:underline">
            {authorName(r)}
          </Link>
        </div>
      ),
    },
    { key: "engagement", header: "Engagement", align: "right", cell: (r) => <span>{formatNumber(r.likeCount + r.commentCount + r.shareCount)}</span> },
    { key: "date", header: "Posted", cell: (r) => <span className="text-ink-soft" title={dateTime(r.createdAt)}>{timeAgo(r.createdAt)} ago</span> },
    {
      key: "actions",
      header: "Actions",
      footer: true,
      cell: (r) => (
        <div className="flex flex-wrap gap-2">
          <Link
            to={authorHref(r)}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-line-strong bg-surface px-3 text-[13px] font-semibold transition-colors hover:bg-surface-2"
          >
            <ExternalLink size={14} aria-hidden /> Author
          </Link>
          <Button
            size="sm"
            variant="ghost"
            className="min-h-[40px] text-danger hover:bg-danger-soft"
            onClick={() =>
              setConfirm({
                title: "Delete this post?",
                body: (
                  <>
                    “{r.text.slice(0, 90)}{r.text.length > 90 ? "…" : ""}” will be removed from every feed. The author ({authorName(r)})
                    keeps their account.
                  </>
                ),
                confirmLabel: "Delete post",
                onConfirm: () => removePost(r),
              })
            }
          >
            <Trash2 size={14} aria-hidden /> Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <SectionIntro meta={SECTIONS[4]} count={q.data?.length}>
        <Button size="sm" variant="outline" className="min-h-[40px]" onClick={q.refetch} loading={q.loading}>
          <RefreshCw size={14} aria-hidden /> Refresh
        </Button>
      </SectionIntro>

      <AdminToolbar>
        <SearchBar value={query} onChange={setQuery} placeholder="Search post text" />
        <span className="text-xs text-ink-faint">Showing the 50 most recent matches.</span>
      </AdminToolbar>

      {q.loading && <TableSkeleton rows={5} height="h-16" />}
      {!q.loading && !q.data && <SectionState error={q.error} onRetry={q.refetch} />}
      {q.data && rows.length === 0 && (
        <Card>
          <EmptyState
            icon={<FileText />}
            title="No posts found"
            description={query ? `Nothing matches “${query}”.` : "Nobody has published a post yet."}
            action={
              query ? (
                <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              ) : (
                <Link
                  to="/home"
                  className="inline-flex min-h-[40px] items-center rounded-xl border border-line-strong bg-surface px-4 text-sm font-semibold transition-colors hover:bg-surface-2"
                >
                  Open the feed
                </Link>
              )
            }
          />
        </Card>
      )}
      {q.data && rows.length > 0 && (
        <Card className="p-2 sm:p-3">
          <DataTable columns={columns} rows={rows} keyOf={(r) => r.id} minWidth={860} />
        </Card>
      )}

      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

/* --------------------------------- reports ---------------------------------- */

const REPORT_FILTERS = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "reviewing", label: "Reviewing" },
  { id: "resolved", label: "Resolved" },
  { id: "dismissed", label: "Dismissed" },
];

function ReportsSection({ onCount }: { onCount: (n: number) => void }) {
  const toast = useToast();
  const [status, setStatus] = useState("all");

  const q = useAsync(() => adminApi.reports(status === "all" ? undefined : { status }), [status]);
  const rows = q.data ?? [];

  useEffect(() => {
    if (q.data) onCount(q.data.length);
  }, [q.data, onCount]);

  const act = async (row: AdminReportRow, action: "resolve" | "dismiss" | "review") => {
    const prev = q.data ?? [];
    const nextStatus: AdminReportRow["status"] = action === "resolve" ? "resolved" : action === "dismiss" ? "dismissed" : "reviewing";
    /* When filtering by a status, a row that leaves that status drops out of the queue. */
    const visible = status === "all" || status === nextStatus;
    q.setData(
      prev
        .map((r) => (r.id === row.id ? { ...r, status: nextStatus } : r))
        .filter((r) => (visible ? true : r.id !== row.id))
    );
    try {
      await adminApi.reportAction(row.id, action);
      toast.success(
        { resolve: "Report resolved", dismiss: "Report dismissed", review: "Report moved to review" }[action],
        `${row.targetType} · ${row.reason}`
      );
    } catch (e) {
      q.setData(prev);
      toast.error("Action failed", errorMessage(e));
    }
  };

  const columns: Column<AdminReportRow>[] = [
    { key: "id", header: "ID", cell: (r) => <span className="font-mono text-xs text-ink-faint">#{r.id}</span> },
    {
      key: "target",
      header: "Reported",
      cell: (r) => (
        <div className="min-w-0">
          <p className="max-w-[200px] truncate font-semibold">{r.target}</p>
          <p className="text-[11px] uppercase tracking-wide text-ink-faint">{r.targetType}</p>
        </div>
      ),
    },
    { key: "reporter", header: "Reporter", cell: (r) => <span className="text-ink-soft">{r.reporter}</span> },
    { key: "reason", header: "Reason", cell: (r) => <span className="line-clamp-2 max-w-[260px] text-ink-soft">{r.reason}</span> },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <Badge tone={statusTone(r.status)}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> {r.status}
        </Badge>
      ),
    },
    { key: "date", header: "Opened", cell: (r) => <span className="text-ink-soft">{shortDate(r.createdAt)}</span> },
    {
      key: "actions",
      header: "Actions",
      footer: true,
      cell: (r) => (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="soft" className="min-h-[40px]" onClick={() => void act(r, "review")} disabled={r.status === "reviewing"}>
            <Eye size={14} aria-hidden /> Review
          </Button>
          <Button size="sm" variant="outline" className="min-h-[40px]" onClick={() => void act(r, "resolve")} disabled={r.status === "resolved"}>
            <Check size={14} aria-hidden /> Resolve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="min-h-[40px] text-danger hover:bg-danger-soft"
            onClick={() => void act(r, "dismiss")}
            disabled={r.status === "dismissed"}
          >
            <X size={14} aria-hidden /> Dismiss
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <SectionIntro meta={SECTIONS[5]} count={q.data?.length}>
        <Button size="sm" variant="outline" className="min-h-[40px]" onClick={q.refetch} loading={q.loading}>
          <RefreshCw size={14} aria-hidden /> Refresh
        </Button>
      </SectionIntro>

      <AdminToolbar>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter reports by status">
          {REPORT_FILTERS.map((f) => (
            <FilterPill key={f.id} active={status === f.id} onClick={() => setStatus(f.id)}>
              {f.label}
            </FilterPill>
          ))}
        </div>
        {q.data && status === "all" && (
          <Badge tone="warn">
            {q.data.filter((r) => r.status === "open").length} awaiting first response
          </Badge>
        )}
      </AdminToolbar>

      {q.loading && <TableSkeleton rows={5} height="h-16" />}
      {!q.loading && !q.data && <SectionState error={q.error} onRetry={q.refetch} />}
      {q.data && rows.length === 0 && (
        <Card>
          <EmptyState
            icon={<Flag />}
            title={status === "all" ? "No reports in the queue" : `No ${status} reports`}
            description="Reports filed by members about listings, posts, messages and profiles land here."
            action={
              status !== "all" ? (
                <Button variant="outline" size="sm" onClick={() => setStatus("all")}>
                  Show all reports
                </Button>
              ) : undefined
            }
          />
        </Card>
      )}
      {q.data && rows.length > 0 && (
        <Card className="p-2 sm:p-3">
          <DataTable columns={columns} rows={rows} keyOf={(r) => r.id} minWidth={880} />
        </Card>
      )}
    </div>
  );
}

/* ------------------------------- transactions ------------------------------- */

function TransactionsSection({ onCount }: { onCount: (n: number) => void }) {
  /* The ledger endpoint has no query support, so the debounced filter runs over the loaded rows. */
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim().toLowerCase(), 300);

  const q = useAsync(() => adminApi.transactions(), []);
  const rows = q.data ?? [];

  useEffect(() => {
    if (q.data) onCount(q.data.length);
  }, [q.data, onCount]);

  const visible = useMemo(
    () => (debounced ? rows.filter((r) => [r.id, r.type, r.from, r.to, r.status].join(" ").toLowerCase().includes(debounced)) : rows),
    [rows, debounced]
  );

  const completed = rows.filter((r) => r.status === "completed");
  const net = completed.reduce((sum, r) => sum + r.amount, 0);

  const columns: Column<AdminTransactionRow>[] = [
    { key: "id", header: "Reference", cell: (r) => <span className="font-mono text-xs font-semibold">{r.id}</span> },
    { key: "type", header: "Type", cell: (r) => <Badge tone="neutral">{r.type}</Badge> },
    {
      key: "parties",
      header: "From → To",
      cell: (r) => (
        <span className="text-ink-soft">
          <span className="font-semibold text-ink">{r.from}</span> → {r.to}
        </span>
      ),
    },
    { key: "amount", header: "Amount", align: "right", cell: (r) => <span className="font-bold">{formatPrice(r.amount, "fixed")}</span> },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <Badge tone={statusTone(r.status)}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> {r.status}
        </Badge>
      ),
    },
    { key: "date", header: "Date", cell: (r) => <span className="text-ink-soft" title={dateTime(r.createdAt)}>{shortDate(r.createdAt)}</span> },
  ];

  return (
    <div>
      <SectionIntro meta={SECTIONS[6]} count={q.data?.length}>
        <Button size="sm" variant="outline" className="min-h-[40px]" onClick={q.refetch} loading={q.loading}>
          <RefreshCw size={14} aria-hidden /> Refresh
        </Button>
      </SectionIntro>

      <AdminToolbar>
        <SearchBar value={query} onChange={setQuery} placeholder="Search reference, party or status" />
        <Card className="flex items-center gap-2 px-3 py-2">
          <CircleDollarSign size={16} className="text-accent" aria-hidden />
          <span className="text-xs text-ink-soft">Settled volume</span>
          <strong className="text-sm tabular-nums">{q.data ? formatPrice(net, "fixed") : "—"}</strong>
        </Card>
        <Card className="flex items-center gap-2 px-3 py-2">
          <Clock size={16} className="text-warn" aria-hidden />
          <span className="text-xs text-ink-soft">Pending</span>
          <strong className="text-sm tabular-nums">{q.data ? rows.filter((r) => r.status === "pending").length : "—"}</strong>
        </Card>
      </AdminToolbar>

      {q.loading && <TableSkeleton rows={6} height="h-12" />}
      {!q.loading && !q.data && <SectionState error={q.error} onRetry={q.refetch} />}
      {q.data && visible.length === 0 && (
        <Card>
          <EmptyState
            icon={<CircleDollarSign />}
            title={debounced ? "No matching transactions" : "No transactions yet"}
            description={
              debounced
                ? `Nothing in the ledger matches “${debounced}”.`
                : "Sales, payouts, subscription renewals and campaign charges will appear here as soon as money moves."
            }
            action={
              debounced ? (
                <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={q.refetch}>
                  <RefreshCw size={14} aria-hidden /> Reload the ledger
                </Button>
              )
            }
          />
        </Card>
      )}
      {q.data && visible.length > 0 && (
        <Card className="p-2 sm:p-3">
          <DataTable columns={columns} rows={visible} keyOf={(r) => r.id} minWidth={760} />
        </Card>
      )}
    </div>
  );
}

/* --------------------------------- tickets ---------------------------------- */

type AdminTicket = SupportTicket & { user?: Person };

/** Older tickets in the stub carry no top-level timestamp; the newest message is the real last activity. */
function lastActivity(t: AdminTicket): string {
  return t.updatedAt || t.messages[t.messages.length - 1]?.createdAt || "";
}

function TicketsSection({ onCount }: { onCount: (n: number) => void }) {
  /* Tickets have no search endpoint, so the debounced query filters the loaded inbox. */
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim().toLowerCase(), 300);

  const q = useAsync(() => adminApi.tickets() as Promise<AdminTicket[]>, []);
  const rows = q.data ?? [];
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    if (q.data) onCount(q.data.length);
  }, [q.data, onCount]);

  const visible = useMemo(
    () =>
      debounced
        ? rows.filter((t) =>
            [t.subject, t.category, t.status, t.user ? `${t.user.firstName} ${t.user.lastName} @${t.user.username}` : "", t.messages.map((m) => m.text).join(" ")]
              .join(" ")
              .toLowerCase()
              .includes(debounced)
          )
        : rows,
    [rows, debounced]
  );

  return (
    <div>
      <SectionIntro meta={SECTIONS[7]} count={q.data?.length}>
        <Button size="sm" variant="outline" className="min-h-[40px]" onClick={q.refetch} loading={q.loading}>
          <RefreshCw size={14} aria-hidden /> Refresh
        </Button>
      </SectionIntro>

      <AdminToolbar>
        <SearchBar value={query} onChange={setQuery} placeholder="Search subject, category or member" />
        {q.data && (
          <>
            <Badge tone="warn">{q.data.filter((t) => t.status === "open").length} open</Badge>
            <Badge tone="accent">{q.data.filter((t) => t.status === "pending").length} pending</Badge>
            <Badge tone="success">{q.data.filter((t) => t.status === "resolved").length} resolved</Badge>
          </>
        )}
        <span className="text-xs text-ink-faint">Tap a ticket to read the full thread.</span>
      </AdminToolbar>

      {q.loading && (
        <div className="space-y-2.5" aria-busy="true" aria-label="Loading support tickets">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      )}

      {!q.loading && !q.data && <SectionState error={q.error} onRetry={q.refetch} />}

      {q.data && visible.length === 0 && (
        <Card>
          <EmptyState
            icon={<LifeBuoy />}
            title={debounced ? "No matching tickets" : "Inbox zero"}
            description={
              debounced
                ? `No ticket mentions “${debounced}”. Search covers subject, category, member and message text.`
                : "No member has opened a support ticket. New tickets from the support centre land here."
            }
            action={
              debounced ? (
                <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={q.refetch}>
                  <RefreshCw size={14} aria-hidden /> Check again
                </Button>
              )
            }
          />
        </Card>
      )}

      {q.data && visible.length > 0 && (
        <ul className="space-y-2.5">
          {visible.map((t) => {
            const expanded = openId === t.id;
            const requester = t.user;
            return (
              <li key={t.id} className="card anim-fade-up overflow-hidden">
                <h3>
                  <button
                    type="button"
                    onClick={() => setOpenId(expanded ? null : t.id)}
                    aria-expanded={expanded}
                    className="flex min-h-[56px] w-full items-start gap-3 p-3.5 text-left transition-colors hover:bg-surface-2/60"
                  >
                    <Avatar name={requester ? `${requester.firstName} ${requester.lastName}` : t.subject} src={mediaUrl(requester?.avatarUrl)} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 truncate text-sm font-bold">{t.subject}</span>
                        <Badge tone={statusTone(t.status)}>
                          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> {t.status}
                        </Badge>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-ink-soft">
                        {requester ? `${requester.firstName} ${requester.lastName} (@${requester.username})` : `#${t.id}`} · {t.category} · updated {timeAgo(lastActivity(t))} ago
                      </span>
                    </span>
                    <ChevronDown size={18} className={cn("mt-1 shrink-0 text-ink-faint transition-transform", expanded && "rotate-180")} aria-hidden />
                  </button>
                </h3>

                {expanded && (
                  <div className="border-t border-line bg-surface-2/40 p-3.5">
                    <ol className="space-y-2.5">
                      {t.messages.map((m) => (
                        <li key={m.id} className={cn("flex flex-col", m.fromUser ? "items-start" : "items-end")}>
                          <span className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-faint">
                            {m.fromUser ? (requester ? `${requester.firstName} ${requester.lastName}` : "Member") : "Support"} · {dateTime(m.createdAt)}
                          </span>
                          <p
                            className={cn(
                              "max-w-[46rem] rounded-2xl border px-3.5 py-2.5 text-sm leading-relaxed",
                              m.fromUser ? "border-line bg-surface" : "border-accent/30 bg-accent-soft"
                            )}
                          >
                            {m.text}
                          </p>
                          {m.attachmentUrl && (
                            <a
                              href={mediaUrl(m.attachmentUrl)}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1 inline-flex items-center gap-1.5 text-xs font-semibold text-accent hover:underline"
                            >
                              <ExternalLink size={12} aria-hidden /> Open attachment
                            </a>
                          )}
                        </li>
                      ))}
                    </ol>
                    <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
                      {requester && (
                        <Link
                          to={`/profile/${requester.username}`}
                          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-line-strong bg-surface px-3 text-[13px] font-semibold transition-colors hover:bg-surface-2"
                        >
                          <ExternalLink size={14} aria-hidden /> View requester profile
                        </Link>
                      )}
                      <Link
                        to="/support"
                        className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-3 text-[13px] font-semibold text-accent hover:bg-accent-soft"
                      >
                        <LifeBuoy size={14} aria-hidden /> Open your own support inbox
                      </Link>
                      <span className="text-xs text-ink-faint">There is no admin reply endpoint yet — answers go through the support team tooling.</span>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ----------------------------------- ads ------------------------------------ */

function AdsSection({ onCount }: { onCount: (n: number) => void }) {
  /* Campaigns have no search endpoint, so the debounced query filters the loaded rows. */
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim().toLowerCase(), 300);

  const q = useAsync(() => adminApi.ads(), []);
  const rows = q.data ?? [];

  useEffect(() => {
    if (q.data) onCount(q.data.length);
  }, [q.data, onCount]);

  const totalBudget = rows.reduce((s, c) => s + c.budget, 0);
  const totalSpend = rows.reduce((s, c) => s + c.spend, 0);

  const visible = useMemo(
    () => (debounced ? rows.filter((c) => [c.name, c.objective, c.format, c.status].join(" ").toLowerCase().includes(debounced)) : rows),
    [rows, debounced]
  );

  const columns: Column<Campaign>[] = [
    {
      key: "campaign",
      header: "Campaign",
      cell: (r) => (
        <div className="min-w-0">
          <p className="max-w-[240px] truncate font-bold">{r.name}</p>
          <p className="text-[11px] text-ink-faint">
            {r.objective} · {r.format.replace("_", " ")}
          </p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <Badge tone={statusTone(r.status)}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> {r.status}
        </Badge>
      ),
    },
    {
      key: "budget",
      header: "Spend / budget",
      cell: (r) => (
        <div className="min-w-[140px] max-w-[200px]">
          <p className="text-xs font-semibold tabular-nums">
            {formatPrice(r.spend, "fixed")} of {formatPrice(r.budget, "fixed")}
          </p>
          <ProgressBar value={r.budget ? (r.spend / r.budget) * 100 : 0} className="mt-1.5" tone={r.spend > r.budget ? "warn" : "accent"} />
        </div>
      ),
    },
    { key: "impressions", header: "Impressions", align: "right", cell: (r) => formatNumber(r.metrics.impressions) },
    {
      key: "clicks",
      header: "Clicks · CTR",
      align: "right",
      cell: (r) => (
        <span>
          {formatNumber(r.metrics.clicks)}
          <span className="ml-1 text-xs text-ink-faint">{r.metrics.impressions ? `${((r.metrics.clicks / r.metrics.impressions) * 100).toFixed(1)}%` : "—"}</span>
        </span>
      ),
    },
    { key: "dates", header: "Flight", cell: (r) => <span className="text-ink-soft whitespace-nowrap">{shortDate(r.startDate)} → {shortDate(r.endDate)}</span> },
    {
      key: "actions",
      header: "Actions",
      footer: true,
      cell: () => (
        <Link
          to="/advertising"
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-line-strong bg-surface px-3 text-[13px] font-semibold transition-colors hover:bg-surface-2"
        >
          <Megaphone size={14} aria-hidden /> Campaign manager
        </Link>
      ),
    },
  ];

  return (
    <div>
      <SectionIntro meta={SECTIONS[8]} count={q.data?.length}>
        <Button size="sm" variant="outline" className="min-h-[40px]" onClick={q.refetch} loading={q.loading}>
          <RefreshCw size={14} aria-hidden /> Refresh
        </Button>
      </SectionIntro>

      <AdminToolbar>
        <SearchBar value={query} onChange={setQuery} placeholder="Search campaign, objective or status" />
        <Card className="flex items-center gap-2 px-3 py-2">
          <CircleDollarSign size={16} className="text-accent" aria-hidden />
          <span className="text-xs text-ink-soft">Booked</span>
          <strong className="text-sm tabular-nums">{q.data ? formatPrice(totalBudget, "fixed") : "—"}</strong>
        </Card>
        <Card className="flex items-center gap-2 px-3 py-2">
          <TrendingUp size={16} className="text-success" aria-hidden />
          <span className="text-xs text-ink-soft">Delivered</span>
          <strong className="text-sm tabular-nums">{q.data ? formatPrice(totalSpend, "fixed") : "—"}</strong>
        </Card>
        <Card className="flex items-center gap-2 px-3 py-2">
          <Activity size={16} className="text-warn" aria-hidden />
          <span className="text-xs text-ink-soft">Active</span>
          <strong className="text-sm tabular-nums">{q.data ? rows.filter((c) => c.status === "active").length : "—"}</strong>
        </Card>
      </AdminToolbar>

      {q.loading && <TableSkeleton rows={5} height="h-16" />}
      {!q.loading && !q.data && <SectionState error={q.error} onRetry={q.refetch} />}
      {q.data && visible.length === 0 && (
        <Card>
          <EmptyState
            icon={<Megaphone />}
            title={debounced ? "No matching campaigns" : "No campaigns running"}
            description={
              debounced
                ? `No campaign matches “${debounced}”. Search covers name, objective, format and status.`
                : "When a business launches an ad campaign it appears here with live budget and delivery."
            }
            action={
              debounced ? (
                <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              ) : (
                <Link
                  to="/advertising"
                  className="inline-flex min-h-[40px] items-center rounded-xl border border-line-strong bg-surface px-4 text-sm font-semibold transition-colors hover:bg-surface-2"
                >
                  Open campaign manager
                </Link>
              )
            }
          />
        </Card>
      )}
      {q.data && visible.length > 0 && (
        <Card className="p-2 sm:p-3">
          <DataTable columns={columns} rows={visible} keyOf={(r) => r.id} minWidth={940} />
        </Card>
      )}
    </div>
  );
}

/* ---------------------------------- chrome ---------------------------------- */

type Counts = Partial<Record<SectionId, number>>;

function BrandTile() {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-canvas">
      <LogoSymbol size={24} />
    </span>
  );
}

function NavList({
  section,
  counts,
  onNavigate,
  inverted,
}: {
  section: SectionId;
  counts: Counts;
  onNavigate: (id: SectionId) => void;
  inverted: boolean;
}) {
  return (
    <nav aria-label="Admin sections">
      <ul className="space-y-0.5">
        {SECTIONS.map((s) => {
          const active = s.id === section;
          const count = counts[s.id];
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onNavigate(s.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-[44px] w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-semibold transition-colors",
                  active
                    ? inverted
                      ? "bg-canvas text-ink"
                      : "bg-accent-soft text-accent"
                    : inverted
                      ? "text-canvas/75 hover:bg-canvas/10 hover:text-canvas"
                      : "text-ink-soft hover:bg-surface-2 hover:text-ink"
                )}
              >
                <s.icon size={16} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                {count !== undefined && (
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums",
                      active ? (inverted ? "bg-surface-2 text-ink-soft" : "bg-surface text-ink-soft") : inverted ? "bg-canvas/15 text-canvas/80" : "bg-surface-2 text-ink-soft"
                    )}
                  >
                    {formatNumber(count)}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function AdminIdentity({ inverted }: { inverted: boolean }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;

  return (
    <div className={cn("rounded-2xl p-3", inverted ? "bg-canvas/10" : "bg-surface-2")}>
      <div className="flex items-center gap-2.5">
        <Avatar name={`${user.firstName} ${user.lastName}`} src={mediaUrl(user.profile.avatarUrl)} size="sm" />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-[13px] font-bold", inverted && "text-canvas")}>{`${user.firstName} ${user.lastName}`}</p>
          <p className={cn("truncate text-[11px]", inverted ? "text-canvas/65" : "text-ink-soft")}>@{user.username}</p>
        </div>
        <Badge tone={inverted ? "neutral" : "warn"} className={cn(inverted && "bg-canvas/20 text-canvas")}>
          <ShieldCheck size={11} aria-hidden /> Admin
        </Badge>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Link
          to="/home"
          className={cn(
            "inline-flex min-h-[40px] flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-[13px] font-semibold transition-colors",
            inverted ? "bg-canvas text-ink hover:opacity-90" : "border border-line-strong bg-surface text-ink hover:bg-surface-2"
          )}
        >
          <ArrowLeft size={14} aria-hidden /> Back to app
        </Link>
        <button
          type="button"
          onClick={() =>
            void logout().then(() => {
              navigate("/login");
            })
          }
          aria-label="Sign out of Professionalist"
          className={cn(
            "inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl px-3 text-[13px] font-semibold transition-colors",
            inverted ? "text-canvas/75 hover:bg-canvas/15 hover:text-canvas" : "text-ink-soft hover:bg-surface"
          )}
        >
          <LogOut size={14} aria-hidden /> Sign out
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------- page ----------------------------------- */

export default function AdminPage() {
  const [params, setParams] = useSearchParams();
  const [counts, setCounts] = useState<Counts>({});
  const [navOpen, setNavOpen] = useState(false);

  const fromParam = params.get("section");
  const section: SectionId = SECTIONS.some((s) => s.id === fromParam) ? (fromParam as SectionId) : "dashboard";

  const go = useCallback(
    (id: SectionId) => {
      setParams(id === "dashboard" ? {} : { section: id }, { replace: false });
      setNavOpen(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [setParams]
  );

  const reportCount = useCallback(
    (id: SectionId) => (n: number) => setCounts((c) => (c[id] === n ? c : { ...c, [id]: n })),
    []
  );

  const meta = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  useEffect(() => {
    document.title = `Admin · ${meta.label} | Professionalist`;
  }, [meta.label]);

  const body = () => {
    switch (section) {
      case "users":
        return <UsersSection onCount={reportCount("users")} />;
      case "businesses":
        return <BusinessesSection onCount={reportCount("businesses")} />;
      case "marketplace":
        return <MarketplaceSection onCount={reportCount("marketplace")} />;
      case "posts":
        return <PostsSection onCount={reportCount("posts")} />;
      case "reports":
        return <ReportsSection onCount={reportCount("reports")} />;
      case "transactions":
        return <TransactionsSection onCount={reportCount("transactions")} />;
      case "tickets":
        return <TicketsSection onCount={reportCount("tickets")} />;
      case "ads":
        return <AdsSection onCount={reportCount("ads")} />;
      default:
        return <DashboardSection />;
    }
  };

  return (
    <div className="min-h-dvh bg-canvas lg:flex">
      {/* --------------------------------- rail --------------------------------- */}
      <aside
        className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col gap-4 bg-ink p-4 lg:flex"
        aria-label="Admin console navigation"
      >
        <div className="flex items-center gap-2.5">
          <BrandTile />
          <div className="min-w-0">
            <p className="truncate text-sm font-extrabold text-canvas">Professionalist</p>
            <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-canvas/60">Admin console</p>
          </div>
        </div>

        <NavList section={section} counts={counts} onNavigate={go} inverted />

        <div className="mt-auto">
          <AdminIdentity inverted />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ------------------------------ mobile bar ------------------------------ */}
        <header className="sticky top-0 z-30 flex min-h-[56px] items-center gap-2 border-b border-line bg-ink px-3 text-canvas lg:hidden">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open admin navigation"
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-canvas/85 transition-colors hover:bg-canvas/15 hover:text-canvas"
          >
            <Menu size={20} />
          </button>
          <BrandTile />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-extrabold">{meta.label}</p>
            <p className="truncate text-[11px] text-canvas/60">Admin console</p>
          </div>
          <Link
            to="/home"
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-2.5 text-[13px] font-semibold text-canvas/85 transition-colors hover:bg-canvas/15 hover:text-canvas"
          >
            <ArrowLeft size={16} aria-hidden /> App
          </Link>
        </header>

        <main className="min-w-0 flex-1 p-3 sm:p-5 lg:p-6">
          <div key={section} className="anim-fade-up mx-auto w-full max-w-[1240px]">
            {body()}
          </div>
        </main>
      </div>

      <Drawer open={navOpen} onClose={() => setNavOpen(false)} side="left" label="Admin sections" width="max-w-xs">
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-surface-2">
                <LogoSymbol size={24} />
              </span>
              <div>
                <p className="text-sm font-extrabold">Professionalist</p>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Admin console</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setNavOpen(false)}
              aria-label="Close admin navigation"
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X size={20} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <NavList section={section} counts={counts} onNavigate={go} inverted={false} />
          </div>

          <AdminIdentity inverted={false} />
        </div>
      </Drawer>
    </div>
  );
}
