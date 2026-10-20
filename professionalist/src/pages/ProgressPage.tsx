import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  ArrowRight,
  Award,
  Briefcase,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Flame,
  GraduationCap,
  Lock,
  Pencil,
  PenLine,
  Plus,
  RefreshCw,
  Share2,
  ShieldCheck,
  Sparkles,
  Store,
  Target,
  Trash2,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  ProgressBar,
  ProgressRing,
  Select,
  Skeleton,
} from "@/components/ui";
import { useToast } from "@/context/ToastContext";
import { errorMessage, useAsync } from "@/hooks/useAsync";
import { usersApi } from "@/services/api";
import type { ProgressData } from "@/services/types";
import { cn, formatNumber } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/*  Types + helpers                                                            */
/* -------------------------------------------------------------------------- */

/** The API returns a metric hint per goal; it isn't in the shared DTO, so widen locally. */
type GoalRow = ProgressData["goals"][number] & { metric?: string };

const METRICS = [
  { value: "connections", label: "Connections" },
  { value: "posts", label: "Posts" },
  { value: "sales", label: "Marketplace sales" },
  { value: "listings", label: "Listings" },
  { value: "views", label: "Profile views" },
  { value: "custom", label: "Custom target" },
];

const ACHIEVEMENT_ICONS: Record<string, LucideIcon> = {
  PenLine,
  Users,
  Store,
  Flame,
  GraduationCap,
  Briefcase,
  Share2,
  Award,
};

function trendDelta(values: number[]): number {
  if (values.length < 2) return 0;
  const first = values[0] || 1;
  return Math.round(((values[values.length - 1] - first) / Math.abs(first)) * 100);
}

function isoDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function ProgressPage() {
  const toast = useToast();
  const state = useAsync(() => usersApi.progress(), []);
  const [goalForm, setGoalForm] = useState<{ mode: "create" } | { mode: "edit"; goal: GoalRow } | null>(null);
  const [deleteGoal, setDeleteGoal] = useState<GoalRow | null>(null);
  const [busy, setBusy] = useState(false);

  const data = state.data;
  const goals = useMemo(() => ((data?.goals ?? []) as GoalRow[]), [data]);

  const saveGoals = async (next: GoalRow[]): Promise<boolean> => {
    setBusy(true);
    try {
      await usersApi.setGoals(
        next.map((g) => ({ id: g.id, title: g.title, target: g.target, metric: g.metric ?? "custom", dueDate: g.dueDate }))
      );
      state.refetch();
      toast.success(next.length > goals.length ? "Goal added" : "Goal updated");
      setGoalForm(null);
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const removeGoal = async () => {
    if (!deleteGoal) return;
    const target = deleteGoal;
    setDeleteGoal(null);
    setBusy(true);
    try {
      await usersApi.deleteGoal(target.id);
      state.refetch();
      toast.success("Goal removed");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (state.loading && !data) return <ProgressSkeleton />;

  if (state.error && !data) {
    return (
      <div className="w-full px-3 sm:px-0">
        <Card>
          <ErrorState message={errorMessage(state.error)} onRetry={state.refetch} />
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const suggestions = data.profileSuggestions.slice(0, 4);
  const completionTone = data.profileCompletion >= 80 ? "Complete your presence" : "Strengthen your profile";

  return (
    <div className="w-full space-y-4 px-3 pb-2 sm:px-0 anim-fade-up">
      <header className="flex flex-wrap items-start justify-between gap-3 pt-1">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-extrabold">
            <TrendingUp size={19} className="text-accent" aria-hidden />
            Professional progress
          </h1>
          <p className="mt-0.5 text-[13px] text-ink-soft">Profile strength, network growth, activity and marketplace performance — all from your account data.</p>
        </div>
        <Button variant="outline" size="sm" onClick={state.refetch} loading={state.loading}>
          <RefreshCw size={15} /> Refresh
        </Button>
      </header>

      {/* --------------------------------- hero --------------------------------- */}
      <Card className="grid gap-5 p-5 md:grid-cols-[auto_1fr] md:gap-7">
        <div className="flex flex-col items-center justify-center gap-3">
          <ProgressRing value={data.profileCompletion} size={132} stroke={11}>
            <span className="flex flex-col items-center">
              <span className="text-[26px] font-extrabold tabular-nums leading-none">{data.profileCompletion}%</span>
              <span className="mt-1 text-[10px] font-bold uppercase tracking-wider text-ink-faint">complete</span>
            </span>
          </ProgressRing>
          <p className="text-center text-[13px] font-semibold text-ink-soft">{completionTone}</p>
        </div>

        <div className="min-w-0">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-bold">
              {suggestions.length ? "Next best improvements" : "Profile is fully complete"}
            </h2>
            <Link to="/profile/edit" className="inline-flex min-h-[40px] items-center gap-1 text-[13px] font-semibold text-accent hover:underline">
              Edit profile <ArrowRight size={14} aria-hidden />
            </Link>
          </div>

          {suggestions.length ? (
            <ul className="mt-2.5 space-y-2">
              {suggestions.map((s, i) => (
                <li key={s}>
                  <Link
                    to="/profile/edit"
                    className="card-hover flex items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 anim-fade-up"
                    style={{ animationDelay: `${i * 40}ms` }}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                      <Sparkles size={16} aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{s}</span>
                      <span className="block text-[11px] text-ink-faint">Worth roughly {Math.max(4, Math.round((100 - data.profileCompletion) / suggestions.length))}% of completion</span>
                    </span>
                    <ChevronRight size={17} className="shrink-0 text-ink-faint" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2.5 flex items-center gap-2 rounded-xl bg-success-soft px-3.5 py-3 text-[13px] font-semibold text-success">
              <CheckCircle2 size={16} aria-hidden /> Nothing outstanding — every profile field buyers and partners look at is filled in.
            </p>
          )}

          {data.profileCompletion < 100 && (
            <ProgressBar className="mt-3" value={data.profileCompletion} showLabel />
          )}
        </div>
      </Card>

      {/* -------------------------------- trend cards ------------------------------ */}
      <div className="grid gap-4 lg:grid-cols-3">
        <MetricCard
          title="Network"
          icon={<Users size={15} />}
          headline={`${formatNumber(data.network.connections)}`}
          headlineLabel="connections"
          stats={[
            { label: "Followers", value: formatNumber(data.network.followers) },
            { label: "New this week", value: `+${data.network.weeklyNew}` },
            { label: "Growth", value: `${data.network.growth}%` },
          ]}
          trend={data.network.trend}
          trendLabel="Weekly connections"
          footer={<StatTrend value={trendDelta(data.network.trend)} caption="over 12 weeks" />}
        />
        <MetricCard
          title="Professional activity"
          icon={<Briefcase size={15} />}
          headline={`${data.activity.score}`}
          headlineLabel="activity score"
          stats={[
            { label: "Posts", value: formatNumber(data.activity.posts) },
            { label: "Engagement", value: `${data.activity.engagement}%` },
          ]}
          trend={data.activity.trend}
          trendLabel="Weekly activity"
          footer={<StatTrend value={trendDelta(data.activity.trend)} caption="over 12 weeks" />}
        />
        <MetricCard
          title="Marketplace activity"
          icon={<Store size={15} />}
          headline={`${data.marketplace.score}`}
          headlineLabel="marketplace score"
          stats={[
            { label: "Listings", value: formatNumber(data.marketplace.listings) },
            { label: "Sales", value: formatNumber(data.marketplace.sales) },
            { label: "Views", value: formatNumber(data.marketplace.views) },
          ]}
          trend={data.marketplace.trend}
          trendLabel="Weekly demand"
          footer={<StatTrend value={trendDelta(data.marketplace.trend)} caption="over 12 weeks" />}
        />
      </div>

      {/* ---------------------------- skills + goals ------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <SectionTitle icon={<ShieldCheck size={15} />} title="Skill endorsements" hint="Endorsements from your network" />
          {data.skills.length === 0 ? (
            <EmptyState
              icon={<Award />}
              title="No endorsed skills yet"
              description="Add skills to your profile and connections can endorse them."
              action={
                <Link to="/profile/edit">
                  <Button variant="outline" size="sm">
                    Add skills
                  </Button>
                </Link>
              }
            />
          ) : (
            <ul className="mt-3 space-y-3.5">
              {data.skills.map((s) => {
                const max = Math.max(...data.skills.map((x) => x.endorsements), 1);
                return (
                  <li key={s.name}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm font-semibold">{s.name}</span>
                      <span className="shrink-0 text-[13px] font-bold tabular-nums text-ink-soft">
                        {s.endorsements} <span className="font-medium text-ink-faint">endorsements</span>
                      </span>
                    </div>
                    <ProgressBar className="mt-1.5" value={(s.endorsements / max) * 100} />
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionTitle icon={<Target size={15} />} title="Goals" hint="Targets you set for yourself" />
            <Button size="sm" variant="soft" onClick={() => setGoalForm({ mode: "create" })}>
              <Plus size={15} /> Add goal
            </Button>
          </div>

          {goals.length === 0 ? (
            <EmptyState
              icon={<CalendarClock />}
              title="No goals set"
              description="Define a measurable target — connections, posts or sales — and track it here."
              action={
                <Button size="sm" variant="outline" onClick={() => setGoalForm({ mode: "create" })}>
                  <Plus size={15} /> Create your first goal
                </Button>
              }
            />
          ) : (
            <ul className="mt-3 space-y-3">
              {goals.map((g) => {
                const pct = g.target > 0 ? Math.min(100, Math.round((g.current / g.target) * 100)) : 0;
                return (
                  <li key={g.id} className="rounded-xl border border-line p-3 anim-fade-up">
                    <div className="flex items-start gap-3">
                      <ProgressRing value={pct} size={48} stroke={5}>
                        <span className="text-[11px] font-bold tabular-nums">{pct}%</span>
                      </ProgressRing>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{g.title}</p>
                        <p className="mt-0.5 text-[13px] text-ink-soft tabular-nums">
                          {g.current} of {g.target} {g.metric && g.metric !== "custom" ? METRICS.find((m) => m.value === g.metric)?.label.toLowerCase() : ""}
                          <span className="font-semibold text-ink"> · {g.target - g.current > 0 ? `${g.target - g.current} to go` : "target reached"}</span>
                        </p>
                        <ProgressBar className="mt-2" value={pct} tone={pct >= 100 ? "success" : "accent"} />
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {g.dueDate ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-faint">
                              <CalendarClock size={11} aria-hidden />
                              {new Date(g.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                            </span>
                          ) : (
                            <span className="text-[11px] text-ink-faint">No deadline</span>
                          )}
                          <span className="ml-auto flex items-center gap-1">
                            <button
                              onClick={() => setGoalForm({ mode: "edit", goal: g })}
                              aria-label={`Edit goal ${g.title}`}
                              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-accent"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => setDeleteGoal(g)}
                              aria-label={`Delete goal ${g.title}`}
                              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-danger-soft hover:text-danger"
                            >
                              <Trash2 size={14} />
                            </button>
                          </span>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* ------------------------------ achievements ------------------------------ */}
      <Card className="p-4">
        <SectionTitle
          icon={<Award size={15} />}
          title="Achievements"
          hint={`${data.achievements.filter((a) => a.earnedAt).length} of ${data.achievements.length} earned`}
        />
        {data.achievements.length === 0 ? (
          <EmptyState icon={<Award />} title="No achievements configured" description="Milestones unlock as your profile, network and sales grow." />
        ) : (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.achievements.map((a) => {
              const Icon = ACHIEVEMENT_ICONS[a.icon] ?? Award;
              const earned = !!a.earnedAt;
              return (
                <li
                  key={a.key}
                  className={cn(
                    "flex items-start gap-3 rounded-xl p-3.5 anim-fade-up",
                    earned ? "border border-line bg-surface shadow-[var(--shadow-card)]" : "border border-dashed border-line-strong bg-surface-2/50"
                  )}
                >
                  <span
                    className={cn(
                      "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
                      earned ? "bg-accent-soft text-accent" : "bg-surface text-ink-faint"
                    )}
                    aria-hidden
                  >
                    {earned ? <Icon size={20} /> : <Lock size={18} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-bold">{a.title}</span>
                      {earned ? <Badgeish tone="success">Earned</Badgeish> : <Badgeish tone="neutral">Locked</Badgeish>}
                    </span>
                    <span className="mt-0.5 block text-[13px] leading-snug text-ink-soft">{a.description}</span>
                    <span className="mt-1 block text-[11px] font-semibold text-ink-faint">
                      {earned
                        ? `Unlocked ${new Date(a.earnedAt as string).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
                        : "Keep going — unlocks automatically"}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {state.error && (
        <p className="flex items-center justify-center gap-2 rounded-xl bg-warn-soft px-3 py-2 text-[13px] font-semibold text-warn">
          <AlertTriangle size={15} aria-hidden /> Couldn’t refresh some figures.{" "}
          <button onClick={state.refetch} className="underline">
            Retry
          </button>
        </p>
      )}

      {goalForm && (
        <GoalModal
          key={goalForm.mode === "edit" ? `goal-${goalForm.goal.id}` : "goal-create"}
          goal={goalForm.mode === "edit" ? goalForm.goal : null}
          existing={goals}
          busy={busy}
          onClose={() => setGoalForm(null)}
          onSave={saveGoals}
        />
      )}

      <Modal
        open={!!deleteGoal}
        onClose={() => setDeleteGoal(null)}
        title="Delete goal"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteGoal(null)}>
              Keep it
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void removeGoal()}>
              Delete goal
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          <span className="font-semibold text-ink">{deleteGoal?.title}</span> and its progress history will be removed from your dashboard.
        </p>
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Building blocks                                                            */
/* -------------------------------------------------------------------------- */

function Badgeish({ tone, children }: { tone: "success" | "neutral"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        tone === "success" ? "bg-success-soft text-success" : "bg-surface-2 text-ink-soft"
      )}
    >
      {children}
    </span>
  );
}

function SectionTitle({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="flex items-center gap-2 text-sm font-bold">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent" aria-hidden>
          {icon}
        </span>
        {title}
      </h2>
      {hint && <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{hint}</span>}
    </div>
  );
}

function StatTrend({ value, caption }: { value: number; caption: string }) {
  const up = value >= 0;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-bold", up ? "text-success" : "text-danger")}>
      {up ? <TrendingUp size={12} aria-hidden /> : <TrendingDown size={12} aria-hidden />}
      {up ? `+${value}%` : `${value}%`}
      <span className="font-medium text-ink-faint">{caption}</span>
      <span className="sr-only">{up ? "increase" : "decrease"}</span>
    </span>
  );
}

function MetricCard({
  title,
  icon,
  headline,
  headlineLabel,
  stats,
  trend,
  trendLabel,
  footer,
}: {
  title: string;
  icon: React.ReactNode;
  headline: string;
  headlineLabel: string;
  stats: { label: string; value: string }[];
  trend: number[];
  trendLabel: string;
  footer?: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col p-4 anim-fade-up">
      <div className="flex items-start justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-bold">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent" aria-hidden>
            {icon}
          </span>
          {title}
        </h2>
        {footer}
      </div>

      <p className="mt-3 text-[26px] font-extrabold leading-none tabular-nums">
        {headline} <span className="text-[13px] font-semibold text-ink-faint">{headlineLabel}</span>
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-line px-2.5 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-ink-faint">{s.label}</p>
            <p className="mt-0.5 text-sm font-extrabold tabular-nums">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-3 border-t border-line pt-3">
        <p className="mb-1 flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-ink-faint">
          <span>{trendLabel}</span>
          <span>{trend.length}-week trend</span>
        </p>
        <TrendChart values={trend} label={`${title} ${trendLabel.toLowerCase()}, last ${trend.length} weeks`} />
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Trend chart — inline SVG, hover + keyboard focus per point                 */
/* -------------------------------------------------------------------------- */

function TrendChart({ values, label }: { values: number[]; label: string }) {
  const [active, setActive] = useState<number | null>(null);

  if (values.length === 0) {
    return <p className="rounded-lg bg-surface-2 px-3 py-6 text-center text-xs text-ink-faint">No trend data yet.</p>;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const count = values.length;
  /** percentage-space coordinates so the chart stretches with the card */
  const px = (i: number) => (count > 1 ? (i / (count - 1)) * 100 : 50);
  const py = (v: number) => 88 - ((v - min) / span) * 72;

  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(2)},${py(v).toFixed(2)}`).join(" ");
  const area = `${line} L${px(count - 1).toFixed(2)},100 L0,100 Z`;
  const current = active ?? count - 1;
  const gradId = `trend-${label.replace(/\W+/g, "-").toLowerCase()}`;

  return (
    <div className="relative">
      <div className="relative h-[70px] w-full" role="img" aria-label={`${label}. Low ${min}, high ${max}.`}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradId})`} />
          <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>

        {values.map((v, i) => (
          <span
            key={`dot-${i}`}
            aria-hidden
            className={cn(
              "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-surface transition-all",
              i === current ? "h-3 w-3" : "h-1.5 w-1.5 opacity-70"
            )}
            style={{ left: `${px(i)}%`, top: `${py(v)}%` }}
          />
        ))}

        {values.map((_, i) => {
          const half = count > 1 ? 50 / (count - 1) : 50;
          const left = Math.max(0, px(i) - half);
          const right = Math.min(100, px(i) + half);
          return (
            <button
              key={`hit-${i}`}
              type="button"
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              onClick={() => setActive((prev) => (prev === i ? null : i))}
              aria-label={`${weeksAgoLabel(count, i)}: ${values[i]}`}
              className="absolute bottom-0 top-0 rounded-md focus-visible:outline-2 focus-visible:outline-accent"
              style={{ left: `${left}%`, width: `${right - left}%` }}
            />
          );
        })}
      </div>

      <div className="mt-1 flex items-center justify-between text-[11px] font-semibold tabular-nums text-ink-faint">
        <span>low {min}</span>
        <span className="font-bold text-ink-soft">{values[current]}</span>
        <span>high {max}</span>
      </div>

      {active !== null && (
        <span
          className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[11px] font-semibold text-canvas shadow-pop"
          style={{ left: `${Math.min(88, Math.max(12, px(active)))}%` }}
          role="tooltip"
        >
          {weeksAgoLabel(count, active)} · {values[active]}
        </span>
      )}
    </div>
  );
}

function weeksAgoLabel(total: number, index: number): string {
  const ago = total - 1 - index;
  if (ago === 0) return "This week";
  if (ago === 1) return "Last week";
  return `${ago} weeks ago`;
}

/* -------------------------------------------------------------------------- */
/*  Goal modal                                                                 */
/* -------------------------------------------------------------------------- */

function GoalModal({
  goal,
  existing,
  busy,
  onClose,
  onSave,
}: {
  goal: GoalRow | null;
  existing: GoalRow[];
  busy: boolean;
  onClose: () => void;
  onSave: (next: GoalRow[]) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(goal?.title ?? "");
  const [metric, setMetric] = useState(goal?.metric && METRICS.some((m) => m.value === goal.metric) ? goal.metric : "custom");
  const [target, setTarget] = useState(String(goal?.target ?? 10));
  const [dueDate, setDueDate] = useState(isoDay(goal?.dueDate ?? null));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const parsed = Number(target);
    if (!title.trim()) next.title = "Describe the goal.";
    else if (title.trim().length > 80) next.title = "Keep it under 80 characters.";
    if (!Number.isFinite(parsed) || parsed <= 0) next.target = "Target must be a number above zero.";
    else if (parsed > 1_000_000) next.target = "That target looks too large.";
    if (dueDate && Number.isNaN(new Date(dueDate).getTime())) next.dueDate = "That date isn’t valid.";
    setErrors(next);
    if (Object.keys(next).length) return;

    const row: GoalRow = {
      id: goal?.id ?? 0,
      title: title.trim(),
      target: Math.round(parsed),
      current: goal?.current ?? 0,
      dueDate: dueDate ? new Date(dueDate).toISOString() : null,
      metric,
    };
    const list = goal ? existing.map((g) => (g.id === goal.id ? row : g)) : [...existing, row];
    await onSave(list);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={goal ? "Edit goal" : "New goal"}
      size="sm"
      mobileSheet
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="goal-form" loading={busy}>
            {goal ? "Save goal" : "Add goal"}
          </Button>
        </>
      }
    >
      <form id="goal-form" onSubmit={submit} className="space-y-4">
        <Input
          label="Goal"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={errors.title}
          placeholder="Grow network to 50 connections"
          autoFocus
          maxLength={90}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Measured by" value={metric} onChange={(e) => setMetric(e.target.value)} options={METRICS} />
          <Input
            label="Target"
            type="number"
            min={1}
            step={1}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            error={errors.target}
            inputMode="numeric"
          />
        </div>
        <Input label="Deadline (optional)" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} error={errors.dueDate} />
        {goal && (
          <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-ink-soft">
            Current progress: <span className="font-bold text-ink">{goal.current}</span> of {goal.target}. Progress updates automatically from your account
            activity.
          </p>
        )}
      </form>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Skeleton                                                                   */
/* -------------------------------------------------------------------------- */

function ProgressSkeleton() {
  return (
    <div className="w-full space-y-4 px-3 pb-2 sm:px-0" aria-label="Loading your progress">
      <div className="space-y-2 pt-1">
        <Skeleton className="h-5 w-52" />
        <Skeleton className="h-3.5 w-72" />
      </div>

      <Card className="grid gap-5 p-5 md:grid-cols-[auto_1fr]">
        <div className="flex flex-col items-center gap-3">
          <Skeleton className="h-[132px] w-[132px] rounded-full" />
          <Skeleton className="h-3 w-28" />
        </div>
        <div className="space-y-2.5">
          <Skeleton className="h-4 w-44" />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-xl" />
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="space-y-3 p-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-7 w-24" />
            <div className="grid grid-cols-2 gap-2">
              <Skeleton className="h-12 rounded-xl" />
              <Skeleton className="h-12 rounded-xl" />
            </div>
            <Skeleton className="h-[70px] rounded-xl" />
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3 p-4">
          <Skeleton className="h-5 w-40" />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-6 rounded-lg" />
          ))}
        </Card>
        <Card className="space-y-3 p-4">
          <Skeleton className="h-5 w-40" />
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </Card>
      </div>

      <Card className="p-4">
        <Skeleton className="h-5 w-36" />
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      </Card>
    </div>
  );
}
