import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Ban,
  CalendarRange,
  ChevronDown,
  ChevronUp,
  CirclePause,
  CirclePlay,
  Megaphone,
  MousePointerClick,
  Plus,
  Search,
  SlidersHorizontal,
  Target,
  TrendingUp,
  WandSparkles,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  ProgressBar,
  SegmentedControl,
  Select,
  Skeleton,
  Textarea,
} from "@/components/ui";
import { errorMessage, useAsync } from "@/hooks/useAsync";
import { adsApi, businessesApi, marketplaceApi } from "@/services/api";
import { ApiError, mediaUrl } from "@/services/http";
import type { Campaign } from "@/services/types";
import { cn, formatNumber, formatPrice } from "@/lib/utils";
import { useToast } from "@/context/ToastContext";

/* -------------------------------------------------------------------------- */
/*  Local helpers & dictionaries                                               */
/* -------------------------------------------------------------------------- */

type Tone = NonNullable<React.ComponentProps<typeof Badge>["tone"]>;

const STATUS_LABEL: Record<Campaign["status"], string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  completed: "Completed",
};

const STATUS_TONE: Record<Campaign["status"], Tone> = {
  draft: "neutral",
  active: "success",
  paused: "warn",
  completed:
    "accent",
};

const OBJECTIVE_LABEL: Record<Campaign["objective"], string> = {
  awareness: "Brand awareness",
  traffic: "Website traffic",
  engagement: "Engagement",
  leads: "Leads",
  sales: "Sales",
};

const FORMAT_LABEL: Record<Campaign["format"], string> = {
  feed: "Feed placement",
  marketplace: "Marketplace slot",
  banner: "Banner",
  sponsored_profile: "Sponsored profile",
  sponsored_product: "Sponsored product",
};

const AGE_RANGES = ["18-24", "25-34", "25-44", "35-44", "45-54", "55-64", "65+"];

const money = (n: number) => formatPrice(Number.isFinite(n) ? n : 0, "fixed");

function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function toDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromDateInput(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function ctrOf(campaigns: Campaign[]): number {
  const impressions = campaigns.reduce((s, c) => s + (c.metrics?.impressions ?? 0), 0);
  const clicks = campaigns.reduce((s, c) => s + (c.metrics?.clicks ?? 0), 0);
  return impressions > 0 ? (clicks / impressions) * 100 : 0;
}

/** Measure an element so the chart can be drawn at real pixel width (crisp text, no overflow). */
function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

/* -------------------------------------------------------------------------- */
/*  Small presentational pieces                                                */
/* -------------------------------------------------------------------------- */

function StatCard({
  label,
  value,
  hint,
  icon,
  loading,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <Card className="p-3.5">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="mt-2.5 h-6 w-24" />
        <Skeleton className="mt-2 h-2.5 w-16" />
      </Card>
    );
  }
  return (
    <Card className="p-3.5 anim-fade-up">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        <span className="text-accent [&_svg]:h-3.5 [&_svg]:w-3.5" aria-hidden>
          {icon}
        </span>
        {label}
      </p>
      <p className="mt-1.5 text-xl font-extrabold tabular-nums leading-none">{value}</p>
      {hint && <p className="mt-1.5 text-[11px] text-ink-soft">{hint}</p>}
    </Card>
  );
}

function StatusPill({ status }: { status: Campaign["status"] }) {
  return (
    <Badge tone={STATUS_TONE[status]}>
      <span
        className={cn("h-1.5 w-1.5 rounded-full bg-current", status === "active" && "animate-pulse")}
        aria-hidden
      />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/* -------------------------------------------------------------------------- */
/*  Chart                                                                      */
/* -------------------------------------------------------------------------- */

type MetricKey = "impressions" | "clicks" | "conversions" | "spend";

const METRICS: { key: MetricKey; label: string; money: boolean }[] = [
  { key: "impressions", label: "Impressions", money: false },
  { key: "clicks", label: "Clicks", money: false },
  { key: "conversions", label: "Conversions", money: false },
  { key: "spend", label: "Spend", money: true },
];

function metricValue(row: Campaign["daily"][number], key: MetricKey): number {
  const v = row[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function formatMetric(value: number, isMoney: boolean): string {
  return isMoney ? money(value) : formatNumber(value);
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const n = value / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * base;
}

function CampaignTrendChart({ daily }: { daily: Campaign["daily"] }) {
  const [metric, setMetric] = useState<MetricKey>("impressions");
  const [active, setActive] = useState<number | null>(null);
  const [wrapRef, measured] = useElementWidth<HTMLDivElement>();
  const columnsRef = useRef<Array<SVGRectElement | null>>([]);

  const isMoney = METRICS.find((m) => m.key === metric)?.money ?? false;
  const data = daily ?? [];
  const values = data.map((row) => metricValue(row, metric));

  const max = niceMax(Math.max(1, ...values));
  const width = Math.max(measured || 0, 240);
  const height = 196;
  const padLeft = 46;
  const padRight = 8;
  const padTop = 14;
  const padBottom = 28;
  const innerW = Math.max(40, width - padLeft - padRight);
  const innerH = Math.max(40, height - padTop - padBottom);
  const band = data.length > 0 ? innerW / data.length : innerW;
  const barW = Math.max(3, Math.min(28, band * 0.52));
  const xOf = (i: number) => padLeft + band * i + band / 2;
  const yOf = (v: number) => padTop + innerH * (1 - Math.min(v, max) / max);

  const moving = values.map((_, i) => {
    const from = Math.max(0, i - 2);
    const slice = values.slice(from, i + 1);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });

  const labelEvery = Math.max(1, Math.ceil(data.length / 5));
  const bestIndex = values.reduce((best, v, i) => (v > values[best] ? i : best), 0);
  const total = values.reduce((s, v) => s + v, 0);

  const focusColumn = (i: number) => {
    if (data.length === 0) return;
    const next = Math.min(data.length - 1, Math.max(0, i));
    setActive(next);
    columnsRef.current[next]?.focus();
  };

  const activeRow = active !== null ? data[active] : undefined;
  const tooltipLeft = active !== null ? Math.min(Math.max(xOf(active), 78), width - 78) : 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-bold">
          <TrendingUp size={15} className="text-accent" aria-hidden />
          Daily delivery
        </h4>
        <SegmentedControl
          value={metric}
          onChange={(v) => {
            setMetric(v as MetricKey);
            setActive(null);
          }}
          options={METRICS.map((m) => ({ value: m.key, label: m.label }))}
          className="w-full justify-start overflow-x-auto hide-scrollbar sm:w-auto"
        />
      </div>

      {data.length === 0 ? (
        <Card className="border-dashed p-6 text-center">
          <p className="text-sm font-semibold">No delivery data yet</p>
          <p className="mt-1 text-xs text-ink-soft">Daily results appear here once the campaign starts serving.</p>
        </Card>
      ) : (
        <>
          <div
            ref={wrapRef}
            className="relative w-full overflow-hidden rounded-xl border border-line bg-surface-2/40"
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") {
                e.preventDefault();
                focusColumn((active ?? -1) + 1);
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                focusColumn((active ?? 1) - 1);
              } else if (e.key === "Escape") {
                setActive(null);
              }
            }}
          >
            <svg
              width={width}
              height={height}
              viewBox={`0 0 ${width} ${height}`}
              role="group"
              aria-label={`Daily ${metric} for the last ${data.length} days. Highest day ${dayKey(data[bestIndex]?.date ?? "")} at ${formatMetric(values[bestIndex] ?? 0, isMoney)}. Use the arrow keys to inspect individual days.`}
              className="block max-w-full"
            >
              {[0, 0.5, 1].map((t) => {
                const y = padTop + innerH * t;
                const label = max * (1 - t);
                return (
                  <g key={t}>
                    <line x1={padLeft} x2={width - padRight} y1={y} y2={y} stroke="var(--line)" strokeWidth={1} />
                    <text x={padLeft - 8} y={y + 4} textAnchor="end" fontSize={10} fill="var(--ink-faint)">
                      {formatMetric(label, isMoney)}
                    </text>
                  </g>
                );
              })}

              {data.map((row, i) => {
                const v = metricValue(row, metric);
                const y = yOf(v);
                const isActive = active === i;
                return (
                  <g key={row.date ?? i}>
                    <rect
                      x={xOf(i) - barW / 2}
                      y={y}
                      width={barW}
                      height={Math.max(2, padTop + innerH - y)}
                      rx={Math.min(3, barW / 2)}
                      fill="var(--accent)"
                      opacity={isActive ? 1 : 0.62}
                    />
                    {i % labelEvery === 0 && (
                      <text x={xOf(i)} y={height - 9} textAnchor="middle" fontSize={10} fill="var(--ink-faint)">
                        {dayKey(row.date)}
                      </text>
                    )}
                  </g>
                );
              })}

              <polyline
                points={moving.map((v, i) => `${xOf(i)},${yOf(v)}`).join(" ")}
                fill="none"
                stroke="var(--success)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {moving.map((v, i) => (
                <circle
                  key={`pt-${i}`}
                  cx={xOf(i)}
                  cy={yOf(v)}
                  r={active === i ? 4 : 2.5}
                  fill="var(--surface)"
                  stroke="var(--success)"
                  strokeWidth={2}
                />
              ))}

              {data.map((row, i) => (
                <rect
                  key={`hit-${row.date ?? i}`}
                  ref={(el) => {
                    columnsRef.current[i] = el;
                  }}
                  x={padLeft + band * i}
                  y={padTop}
                  width={band}
                  height={innerH}
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-pressed={active === i}
                  aria-label={`${dayKey(row.date)}: ${formatMetric(metricValue(row, "impressions"), false)} impressions, ${formatNumber(metricValue(row, "clicks"))} clicks, ${formatNumber(metricValue(row, "conversions"))} conversions, ${money(metricValue(row, "spend"))} spent`}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive(null)}
                  onClick={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  className="rounded outline-offset-2"
                />
              ))}
            </svg>

            {activeRow && (
              <div
                className="pointer-events-none absolute top-2 z-10 w-[156px] -translate-x-1/2 rounded-xl border border-line bg-surface p-2.5 shadow-pop anim-fade-in"
                style={{ left: tooltipLeft }}
                aria-hidden
              >
                <p className="text-[11px] font-bold">{dayKey(activeRow.date)}</p>
                <dl className="mt-1 space-y-0.5 text-[11px] text-ink-soft">
                  {METRICS.map((m) => (
                    <div key={m.key} className="flex items-center justify-between gap-2">
                      <dt>{m.label}</dt>
                      <dd className={cn("font-semibold tabular-nums", m.key === metric && "text-ink")}>
                        {formatMetric(metricValue(activeRow, m.key), m.money)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-ink-soft">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--accent)" }} aria-hidden />
              {METRICS.find((m) => m.key === metric)?.label}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded-full" style={{ background: "var(--success)" }} aria-hidden />
              3-day average
            </span>
            <span>
              Total <strong className="tabular-nums text-ink">{formatMetric(total, isMoney)}</strong>
            </span>
            <span>
              Peak day <strong className="tabular-nums text-ink">{dayKey(data[bestIndex]?.date ?? "")}</strong> ·{" "}
              <span className="tabular-nums">{formatMetric(values[bestIndex] ?? 0, isMoney)}</span>
            </span>
            <span className="hidden sm:inline">Hover, tap or use ← → to inspect a day</span>
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Campaign detail                                                            */
/* -------------------------------------------------------------------------- */

function DestinationLink({ destination }: { destination: string }) {
  if (!destination) return <span className="text-ink-faint">Not set</span>;
  const isInternal = destination.startsWith("/");
  const label = destination.replace(/^https?:\/\//, "");
  return isInternal ? (
    <Link to={destination} className="font-semibold text-accent hover:underline break-all">
      {label}
    </Link>
  ) : (
    <a href={destination} target="_blank" rel="noreferrer" className="font-semibold text-accent hover:underline break-all">
      {label}
    </a>
  );
}

function CampaignDetail({ campaign, onEdit }: { campaign: Campaign; onEdit: (c: Campaign) => void }) {
  const m = campaign.metrics ?? { impressions: 0, clicks: 0, engagement: 0, conversions: 0 };
  const ctr = m.impressions > 0 ? (m.clicks / m.impressions) * 100 : 0;
  const budget = Number(campaign.budget) || 0;
  const spend = Number(campaign.spend) || 0;
  const usedPct = budget > 0 ? (spend / budget) * 100 : 0;
  const audience = campaign.audience ?? { industries: [], locations: [], ageRange: "", interests: [] };

  return (
    <div className="space-y-4 py-4 anim-fade-up">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Impressions" value={formatNumber(m.impressions)} icon={<Megaphone />} />
        <StatCard label="Clicks" value={formatNumber(m.clicks)} icon={<MousePointerClick />} />
        <StatCard label="CTR" value={`${ctr.toFixed(ctr >= 10 ? 0 : 1)}%`} icon={<Target />} />
        <StatCard label="Conversions" value={formatNumber(m.conversions)} icon={<TrendingUp />} />
        <StatCard label="Engagement" value={formatNumber(m.engagement)} icon={<WandSparkles />} />
      </div>

      <CampaignTrendChart daily={campaign.daily ?? []} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h4 className="flex items-center gap-1.5 text-sm font-bold">
            <CalendarRange size={15} className="text-accent" aria-hidden />
            Budget & schedule
          </h4>
          <div className="mt-3 space-y-3 text-sm">
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-ink-soft">Spent</span>
                <span className="font-bold tabular-nums">
                  {money(spend)} <span className="text-xs font-medium text-ink-faint">of {money(budget)}</span>
                </span>
              </div>
              <ProgressBar
                className="mt-1.5"
                value={usedPct}
                showLabel
                tone={usedPct >= 100 ? "warn" : usedPct >= 80 ? "success" : "accent"}
              />
              {budget > 0 && spend >= budget && (
                <p className="mt-1.5 text-[11px] font-semibold text-warn">Budget fully delivered — raise it to keep serving.</p>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[13px]">
              <div>
                <dt className="text-ink-faint">Starts</dt>
                <dd className="font-semibold">{shortDate(campaign.startDate)}</dd>
              </div>
              <div>
                <dt className="text-ink-faint">Ends</dt>
                <dd className="font-semibold">{shortDate(campaign.endDate)}</dd>
              </div>
              <div>
                <dt className="text-ink-faint">Objective</dt>
                <dd className="font-semibold">{OBJECTIVE_LABEL[campaign.objective]}</dd>
              </div>
              <div>
                <dt className="text-ink-faint">Format</dt>
                <dd className="font-semibold">{FORMAT_LABEL[campaign.format]}</dd>
              </div>
            </dl>
          </div>
        </Card>

        <Card className="p-4">
          <h4 className="flex items-center gap-1.5 text-sm font-bold">
            <SlidersHorizontal size={15} className="text-accent" aria-hidden />
            Audience
          </h4>
          <div className="mt-3 space-y-3">
            <AudienceRow label="Industries" items={audience.industries ?? []} />
            <AudienceRow label="Locations" items={audience.locations ?? []} />
            <AudienceRow label="Interests" items={audience.interests ?? []} />
            <div className="flex items-center justify-between gap-3 text-[13px]">
              <span className="text-ink-faint">Age range</span>
              <span className="font-semibold">{audience.ageRange || "Any"}</span>
            </div>
          </div>
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="flex items-center gap-1.5 text-sm font-bold">
            <WandSparkles size={15} className="text-accent" aria-hidden />
            Creative & destination
          </h4>
          <Button size="sm" variant="outline" onClick={() => onEdit(campaign)}>
            Edit campaign
          </Button>
        </div>
        <div className="mt-3 flex flex-col gap-4 sm:flex-row">
          <div className="w-full shrink-0 overflow-hidden rounded-xl border border-line bg-surface-2 sm:w-44">
            {campaign.creativeUrl ? (
              <img
                src={mediaUrl(campaign.creativeUrl)}
                alt={`Creative for ${campaign.name}`}
                loading="lazy"
                className="h-28 w-full object-cover sm:h-32"
              />
            ) : (
              <span className="flex h-28 items-center justify-center text-xs text-ink-faint sm:h-32">Text-only creative</span>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-2.5">
            <p className="text-sm leading-relaxed">{campaign.creativeText || <span className="text-ink-faint">No copy saved yet.</span>}</p>
            <p className="text-[13px]">
              <span className="text-ink-faint">Destination: </span>
              <DestinationLink destination={campaign.destination} />
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

function AudienceRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="flex items-start justify-between gap-3 text-[13px]">
      <span className="shrink-0 text-ink-faint">{label}</span>
      <span className="flex flex-wrap justify-end gap-1.5">
        {items.length > 0 ? (
          items.map((i) => <Badge key={i}>{i}</Badge>)
        ) : (
          <span className="font-semibold text-ink-faint">Anyone</span>
        )}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Create / edit form                                                         */
/* -------------------------------------------------------------------------- */

interface FormState {
  name: string;
  objective: Campaign["objective"];
  format: Campaign["format"];
  budget: string;
  startDate: string;
  endDate: string;
  status: Campaign["status"];
  creativeUrl: string;
  creativeText: string;
  destination: string;
  ownerBusinessId: string;
  industries: string[];
  locations: string[];
  interests: string[];
  ageRange: string;
}

const BLANK_FORM: FormState = {
  name: "",
  objective: "awareness",
  format: "feed",
  budget: "",
  startDate: toDateInput(new Date().toISOString()),
  endDate: "",
  status: "draft",
  creativeUrl: "",
  creativeText: "",
  destination: "",
  ownerBusinessId: "",
  industries: [],
  locations: [],
  interests: [],
  ageRange: "25-44",
};

function formFromCampaign(c: Campaign): FormState {
  return {
    ...BLANK_FORM,
    name: c.name ?? "",
    objective: c.objective ?? "awareness",
    format: c.format ?? "feed",
    budget: c.budget ? String(c.budget) : "",
    startDate: toDateInput(c.startDate),
    endDate: toDateInput(c.endDate),
    status: c.status ?? "draft",
    creativeUrl: c.creativeUrl ?? "",
    creativeText: c.creativeText ?? "",
    destination: c.destination ?? "",
    ownerBusinessId: String((c as { ownerBusinessId?: number | null }).ownerBusinessId ?? ""),
    industries: c.audience?.industries ?? [],
    locations: c.audience?.locations ?? [],
    interests: c.audience?.interests ?? [],
    ageRange: c.audience?.ageRange || "25-44",
  };
}

function validateForm(state: FormState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (state.name.trim().length < 3) errors.name = "Give the campaign a name of at least 3 characters.";
  const budget = Number(state.budget);
  if (!state.budget.trim() || !Number.isFinite(budget) || budget <= 0) errors.budget = "Enter a budget greater than 0.";
  if (state.startDate && state.endDate && new Date(state.endDate) < new Date(state.startDate)) {
    errors.endDate = "The end date must be on or after the start date.";
  }
  if (state.destination.trim() && !/^(\/|https?:\/\/)/i.test(state.destination.trim())) {
    errors.destination = "Use a site path (starting with /) or a full https:// URL.";
  }
  return errors;
}

function payloadFromForm(state: FormState): Partial<Campaign> & { name: string } {
  const payload: Partial<Campaign> & { name: string; ownerBusinessId?: number } = {
    name: state.name.trim(),
    objective: state.objective,
    format: state.format,
    budget: Number(state.budget),
    startDate: fromDateInput(state.startDate) ?? new Date().toISOString(),
    status: state.status,
    creativeUrl: state.creativeUrl,
    creativeText: state.creativeText.trim(),
    destination: state.destination.trim(),
    audience: {
      industries: state.industries,
      locations: state.locations,
      interests: state.interests,
      ageRange: state.ageRange,
    },
  };
  const endDate = fromDateInput(state.endDate);
  if (endDate) payload.endDate = endDate;
  if (state.ownerBusinessId) payload.ownerBusinessId = Number(state.ownerBusinessId);
  return payload;
}

function TagField({
  id,
  label,
  hint,
  placeholder,
  values,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  placeholder: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const add = (raw: string) => {
    const value = raw.trim().replace(/,+$/, "").trim();
    setDraft("");
    if (!value) return;
    if (values.some((v) => v.toLowerCase() === value.toLowerCase())) return;
    onChange([...values, value]);
  };

  return (
    <div className="w-full">
      <label htmlFor={id} className="block text-[13px] font-semibold mb-1.5">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => add(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          className="w-full h-10 bg-surface border border-line rounded-xl px-3.5 text-sm placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-[var(--ring)] focus:outline-none transition-colors"
        />
      </div>
      {values.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {values.map((v) => (
            <li key={v}>
              <button
                type="button"
                onClick={() => onChange(values.filter((x) => x !== v))}
                aria-label={`Remove ${v} from ${label.toLowerCase()}`}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-accent bg-accent-soft px-3.5 text-[13px] font-semibold text-accent transition-opacity hover:opacity-80"
              >
                {v}
                <X size={13} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

function CampaignFormModal({
  mode,
  campaign,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  campaign: Campaign | null;
  onClose: () => void;
  onSaved: (saved: Campaign, mode: "create" | "edit") => void;
}) {
  const toast = useToast();
  const [state, setState] = useState<FormState>(() => (campaign ? formFromCampaign(campaign) : BLANK_FORM));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const businesses = useAsync(() => businessesApi.manage(), []);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setState((s) => ({ ...s, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key as string];
      return next;
    });
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Unsupported file", "Choose a PNG, JPG, GIF or WebP image.");
      return;
    }
    setUploading(true);
    try {
      const { urls } = await marketplaceApi.uploadImages([file]);
      if (urls?.[0]) {
        set("creativeUrl", urls[0]);
        toast.success("Creative uploaded");
      } else {
        toast.error("Upload failed", "The server did not return an image URL.");
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const found = validateForm(state);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSubmitting(true);
    try {
      const payload = payloadFromForm(state);
      const saved = mode === "create" ? await adsApi.create(payload) : await adsApi.update(campaign!.id, payload);
      toast.success(mode === "create" ? "Campaign created" : "Campaign updated", saved.name);
      onSaved(saved, mode);
    } catch (e) {
      const fieldErrors = e instanceof ApiError ? e.fieldErrors : {};
      if (Object.keys(fieldErrors).length > 0) setErrors(fieldErrors);
      else toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const statusOptions: Campaign["status"][] = mode === "create" ? ["draft", "active", "paused"] : ["draft", "active", "paused", "completed"];

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      mobileSheet
      title={mode === "create" ? "Create campaign" : "Edit campaign"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="campaign-form" loading={submitting}>
            {mode === "create" ? "Launch campaign" : "Save changes"}
          </Button>
        </>
      }
    >
      <form id="campaign-form" onSubmit={(e) => void submit(e)} className="space-y-5" noValidate>
        <Input
          id="campaign-name"
          label="Campaign name"
          placeholder="Autumn brand push"
          value={state.name}
          error={errors.name}
          onChange={(e) => set("name", e.target.value)}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            id="campaign-objective"
            label="Objective"
            value={state.objective}
            onChange={(e) => set("objective", e.target.value as Campaign["objective"])}
            options={Object.entries(OBJECTIVE_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <Select
            id="campaign-format"
            label="Ad format"
            value={state.format}
            onChange={(e) => set("format", e.target.value as Campaign["format"])}
            options={Object.entries(FORMAT_LABEL).map(([value, label]) => ({ value, label }))}
          />
        </div>

        <fieldset className="space-y-4 rounded-xl border border-line p-3.5">
          <legend className="px-1 text-[13px] font-bold">Audience</legend>
          <TagField
            id="campaign-industries"
            label="Industries"
            placeholder="Technology, then Enter"
            values={state.industries}
            onChange={(v) => set("industries", v)}
            hint="Leave empty to reach every industry."
          />
          <TagField
            id="campaign-locations"
            label="Locations"
            placeholder="Lagos, Nigeria, then Enter"
            values={state.locations}
            onChange={(v) => set("locations", v)}
          />
          <TagField
            id="campaign-interests"
            label="Interests"
            placeholder="Startups, then Enter"
            values={state.interests}
            onChange={(v) => set("interests", v)}
          />
          <Select
            id="campaign-age"
            label="Age range"
            value={state.ageRange}
            onChange={(e) => set("ageRange", e.target.value)}
            options={AGE_RANGES.map((a) => ({ value: a, label: a }))}
          />
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-3">
          <Input
            id="campaign-budget"
            label="Total budget (USD)"
            type="number"
            min={1}
            step={1}
            inputMode="decimal"
            placeholder="400"
            value={state.budget}
            error={errors.budget}
            onChange={(e) => set("budget", e.target.value)}
          />
          <Input
            id="campaign-start"
            label="Start date"
            type="date"
            value={state.startDate}
            error={errors.startDate}
            onChange={(e) => set("startDate", e.target.value)}
          />
          <Input
            id="campaign-end"
            label="End date"
            type="date"
            value={state.endDate}
            error={errors.endDate}
            hint="Optional — run until paused."
            onChange={(e) => set("endDate", e.target.value)}
          />
        </div>

        <fieldset className="space-y-4 rounded-xl border border-line p-3.5">
          <legend className="px-1 text-[13px] font-bold">Creative</legend>
          <Textarea
            id="campaign-creative-text"
            label="Ad copy"
            rows={3}
            placeholder="Refurbished comfort, 90-day warranty. Shop office gear from verified sellers."
            value={state.creativeText}
            onChange={(e) => set("creativeText", e.target.value)}
          />
          <div>
            <span className="block text-[13px] font-semibold mb-1.5">Image</span>
            <input
              ref={fileRef}
              id="campaign-creative-file"
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => void upload(e.target.files?.[0])}
            />
            {state.creativeUrl ? (
              <div className="flex items-center gap-3">
                <img
                  src={mediaUrl(state.creativeUrl)}
                  alt="Selected campaign creative"
                  className="h-16 w-24 rounded-lg border border-line object-cover"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => set("creativeUrl", "")}
                  aria-label="Remove creative image"
                >
                  <X size={14} /> Remove
                </Button>
              </div>
            ) : (
              <Button type="button" size="sm" variant="outline" loading={uploading} onClick={() => fileRef.current?.click()}>
                <Plus size={14} /> {uploading ? "Uploading…" : "Upload image"}
              </Button>
            )}
          </div>
          <Input
            id="campaign-destination"
            label="Destination"
            placeholder="/marketplace/12 or https://example.com"
            value={state.destination}
            error={errors.destination}
            hint="Where the click lands."
            onChange={(e) => set("destination", e.target.value)}
          />
        </fieldset>

        <fieldset className="min-w-0">
          <legend className="mb-1.5 block text-[13px] font-semibold">Initial status</legend>
          <div className="flex max-w-full gap-1.5 overflow-x-auto hide-scrollbar">
            {statusOptions.map((s) => (
              <label
                key={s}
                htmlFor={`campaign-status-${s}`}
                className={cn(
                  "inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-xl border px-3.5 text-[13px] font-semibold transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ring)]",
                  state.status === s
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink"
                )}
              >
                <input
                  id={`campaign-status-${s}`}
                  type="radio"
                  name="campaign-status"
                  value={s}
                  checked={state.status === s}
                  onChange={() => set("status", s)}
                  className="sr-only"
                />
                {STATUS_LABEL[s]}
              </label>
            ))}
          </div>
        </fieldset>

        {mode === "create" && (businesses.data?.length ?? 0) > 0 && (
          <Select
            id="campaign-business"
            label="Run for"
            placeholder="My personal account"
            value={state.ownerBusinessId}
            onChange={(e) => set("ownerBusinessId", e.target.value)}
            options={(businesses.data ?? []).map((b) => ({ value: String(b.id), label: b.name }))}
          />
        )}
      </form>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

type SortKey = "name" | "status" | "budget" | "spend" | "conversions";

const SORT_LABEL: Record<SortKey, string> = {
  name: "Name",
  status: "Status",
  budget: "Budget",
  spend: "Spend",
  conversions: "Conversions",
};

function compareCampaigns(a: Campaign, b: Campaign, key: SortKey): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "status":
      return a.status.localeCompare(b.status);
    case "budget":
      return (a.budget ?? 0) - (b.budget ?? 0);
    case "spend":
      return (a.spend ?? 0) - (b.spend ?? 0);
    case "conversions":
      return (a.metrics?.conversions ?? 0) - (b.metrics?.conversions ?? 0);
  }
}

function last7(campaign: Campaign) {
  const rows = (campaign.daily ?? []).slice(-7);
  return rows.reduce(
    (acc, r) => ({
      impressions: acc.impressions + metricValue(r, "impressions"),
      clicks: acc.clicks + metricValue(r, "clicks"),
      spend: acc.spend + metricValue(r, "spend"),
    }),
    { impressions: 0, clicks: 0, spend: 0 }
  );
}

export default function AdvertisingPage() {
  const toast = useToast();
  const { data, loading, error, refetch, setData } = useAsync(() => adsApi.campaigns(), []);
  const campaigns = useMemo(() => data ?? [], [data]);

  const [statusFilter, setStatusFilter] = useState<"all" | Campaign["status"]>("all");
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [modal, setModal] = useState<{ mode: "create" | "edit"; campaign: Campaign | null } | null>(null);

  const totals = useMemo(() => {
    const spend = campaigns.reduce((s, c) => s + (Number(c.spend) || 0), 0);
    const budget = campaigns.reduce((s, c) => s + (Number(c.budget) || 0), 0);
    const impressions = campaigns.reduce((s, c) => s + (c.metrics?.impressions ?? 0), 0);
    const clicks = campaigns.reduce((s, c) => s + (c.metrics?.clicks ?? 0), 0);
    const conversions = campaigns.reduce((s, c) => s + (c.metrics?.conversions ?? 0), 0);
    const active = campaigns.filter((c) => c.status === "active").length;
    return { spend, budget, impressions, clicks, conversions, active, ctr: impressions > 0 ? (clicks / impressions) * 100 : 0 };
  }, [campaigns]);

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: campaigns.length, draft: 0, active: 0, paused: 0, completed: 0 };
    for (const c of campaigns) map[c.status] = (map[c.status] ?? 0) + 1;
    return map;
  }, [campaigns]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = campaigns.filter(
      (c) => (statusFilter === "all" || c.status === statusFilter) && (!q || c.name.toLowerCase().includes(q))
    );
    return [...list].sort((a, b) => {
      const delta = compareCampaigns(a, b, sortKey);
      return sortDir === "asc" ? delta : -delta;
    });
  }, [campaigns, query, sortDir, sortKey, statusFilter]);

  const patch = (id: number, changes: Partial<Campaign>) => {
    setData((prev) => (prev ?? []).map((c) => (c.id === id ? { ...c, ...changes } : c)));
  };

  const changeStatus = async (campaign: Campaign, next: Campaign["status"]) => {
    if (campaign.status === next) return;
    const previous = campaign.status;
    patch(campaign.id, { status: next });
    try {
      const saved = await adsApi.update(campaign.id, { status: next });
      patch(campaign.id, { status: saved.status });
      toast.success(
        next === "active" ? "Campaign resumed" : next === "paused" ? "Campaign paused" : `Campaign ${next}`,
        campaign.name
      );
    } catch (e) {
      patch(campaign.id, { status: previous });
      toast.error("Status change failed", errorMessage(e));
    }
  };

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const onSaved = (saved: Campaign, mode: "create" | "edit") => {
    if (mode === "create") {
      setData((prev) => [saved, ...(prev ?? [])]);
      setExpandedId(saved.id);
    } else {
      patch(saved.id, saved);
    }
    setModal(null);
  };

  return (
    <div className="mt-12 space-y-4 sm:mt-0">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
            <Megaphone size={20} className="text-accent" aria-hidden />
            Advertising
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            {loading ? "Loading your campaigns…" : `${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"} · ${totals.active} active`}
          </p>
        </div>
        <Button onClick={() => setModal({ mode: "create", campaign: null })}>
          <Plus size={16} /> Create campaign
        </Button>
      </header>

      {/* Aggregate */}
      <section aria-label="Account totals" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard loading={loading} label="Total spend" value={money(totals.spend)} hint={`of ${money(totals.budget)} budgeted`} icon={<Megaphone />} />
        <StatCard loading={loading} label="Impressions" value={formatNumber(totals.impressions)} icon={<TrendingUp />} />
        <StatCard loading={loading} label="Clicks" value={formatNumber(totals.clicks)} icon={<MousePointerClick />} />
        <StatCard loading={loading} label="CTR" value={`${totals.ctr.toFixed(totals.ctr >= 10 ? 0 : 1)}%`} icon={<Target />} />
        <StatCard loading={loading} label="Conversions" value={formatNumber(totals.conversions)} icon={<WandSparkles />} />
      </section>

      {/* Toolbar */}
      <Card className="space-y-3 p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex gap-1.5 overflow-x-auto hide-scrollbar" role="group" aria-label="Filter by status">
            {(["all", "active", "paused", "completed", "draft"] as const).map((s) => (
              <Chip key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>
                {s === "all" ? "All" : STATUS_LABEL[s]}
                <span className="tabular-nums text-ink-faint">{counts[s] ?? 0}</span>
              </Chip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-full sm:w-52 sm:min-w-0">
              <Input
                id="campaign-search"
                aria-label="Search campaigns by name"
                placeholder="Search campaigns"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                icon={<Search size={15} />}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="sr-only sm:not-sr-only sm:text-xs sm:text-ink-faint">Sort</span>
              <div className="w-36">
                <Select
                  id="campaign-sort"
                  aria-label="Sort campaigns"
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                  options={(Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({ value: k, label: SORT_LABEL[k] }))}
                />
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                aria-label={sortDir === "asc" ? "Sort campaigns descending" : "Sort campaigns ascending"}
              >
                {sortDir === "asc" ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {loading && (
        <div className="space-y-2.5" aria-hidden>
          {[0, 1, 2].map((i) => (
            <Card key={i} className="p-4">
              <div className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-2.5 w-28" />
                </div>
                <Skeleton className="hidden h-3 w-24 sm:block" />
              </div>
              <Skeleton className="mt-4 h-1.5 w-full rounded-full" />
            </Card>
          ))}
        </div>
      )}

      {!loading && error && (
        <Card>
          <ErrorState message={errorMessage(error)} onRetry={refetch} />
        </Card>
      )}

      {!loading && !error && campaigns.length === 0 && (
        <Card>
          <EmptyState
            icon={<Megaphone />}
            title="No campaigns yet"
            description="Put your profile, listings and services in front of the right professionals. Setup takes about a minute."
            action={
              <Button onClick={() => setModal({ mode: "create", campaign: null })}>
                <Plus size={16} /> Create your first campaign
              </Button>
            }
          />
        </Card>
      )}

      {!loading && !error && campaigns.length > 0 && visible.length === 0 && (
        <Card>
          <EmptyState
            icon={<Search />}
            title="No campaigns match"
            description="Try another status or clear the search."
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setStatusFilter("all");
                  setQuery("");
                }}
              >
                Clear filters
              </Button>
            }
          />
        </Card>
      )}

      {!loading && !error && visible.length > 0 && (
        <>
          {/* Desktop table */}
          <Card className="hidden overflow-hidden md:block">
            <table className="w-full table-fixed border-collapse text-left text-sm">
              <caption className="sr-only">Advertising campaigns with budget, spend and results</caption>
              <thead>
                <tr className="border-b border-line bg-surface-2/60 text-[11px] uppercase tracking-wide text-ink-faint">
                  {([
                    ["name", "Campaign"],
                    ["status", "Status"],
                    ["budget", "Budget / spend"],
                  ] as [SortKey, string][]).map(([key, label]) => (
                    <th
                      key={key}
                      scope="col"
                      className={cn("px-3 py-2.5 font-semibold", key === "name" && "w-[32%]", key === "status" && "w-[13%]", key === "budget" && "w-[20%]")}
                      aria-sort={sortKey === key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                    >
                      <button onClick={() => toggleSort(key)} className="inline-flex items-center gap-1 hover:text-ink">
                        {label}
                        {sortKey === key ? (
                          sortDir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />
                        ) : (
                          <ArrowUpDown size={12} className="opacity-50" />
                        )}
                      </button>
                    </th>
                  ))}
                  <th
                    scope="col"
                    className="w-[18%] px-3 py-2.5 font-semibold"
                    aria-sort={sortKey === "conversions" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <button onClick={() => toggleSort("conversions")} className="inline-flex items-center gap-1 hover:text-ink">
                      Results
                      {sortKey === "conversions" ? (
                        sortDir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />
                      ) : (
                        <ArrowUpDown size={12} className="opacity-50" />
                      )}
                    </button>
                  </th>
                  <th scope="col" className="w-[17%] px-3 py-2.5 text-right font-semibold">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const open = expandedId === c.id;
                  const week = last7(c);
                  return (
                    <Fragment key={c.id}>
                      <tr className={cn("border-b border-line transition-colors hover:bg-surface-2/40", open && "bg-surface-2/40")}>
                        <th scope="row" className="px-3 py-3 font-normal align-top">
                          <button
                            onClick={() => setExpandedId(open ? null : c.id)}
                            aria-expanded={open}
                            className="flex w-full items-start gap-2.5 text-left"
                          >
                            <span className="mt-0.5 shrink-0 text-ink-faint">
                              {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate font-bold">{c.name}</span>
                              <span className="mt-0.5 block truncate text-xs text-ink-soft">
                                {OBJECTIVE_LABEL[c.objective]} · {FORMAT_LABEL[c.format]}
                              </span>
                              <span className="mt-0.5 block text-[11px] text-ink-faint">
                                {shortDate(c.startDate)} → {shortDate(c.endDate)}
                              </span>
                            </span>
                          </button>
                        </th>
                        <td className="px-3 py-3 align-top">
                          <StatusPill status={c.status} />
                        </td>
                        <td className="px-3 py-3 align-top">
                          <p className="tabular-nums font-semibold">{money(c.spend ?? 0)}</p>
                          <p className="text-[11px] text-ink-faint tabular-nums">of {money(c.budget ?? 0)}</p>
                          <ProgressBar
                            className="mt-1.5"
                            value={c.budget > 0 ? ((c.spend ?? 0) / c.budget) * 100 : 0}
                            tone={(c.spend ?? 0) >= c.budget ? "warn" : "accent"}
                          />
                        </td>
                        <td className="px-3 py-3 align-top">
                          <p className="tabular-nums">
                            <span className="font-semibold">{formatNumber(c.metrics?.conversions ?? 0)}</span>{" "}
                            <span className="text-xs text-ink-faint">conv.</span>
                          </p>
                          <p className="mt-0.5 text-[11px] text-ink-soft tabular-nums">
                            {formatNumber(week.impressions)} impr · {formatNumber(week.clicks)} clicks
                          </p>
                          <p className="text-[11px] text-ink-faint tabular-nums">7d {money(week.spend)}</p>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button size="sm" variant="outline" onClick={() => setModal({ mode: "edit", campaign: c })}>
                              Edit
                            </Button>
                            {c.status === "active" ? (
                              <Button size="sm" variant="soft" onClick={() => void changeStatus(c, "paused")}>
                                <CirclePause size={14} /> Pause
                              </Button>
                            ) : c.status === "paused" || c.status === "draft" ? (
                              <Button size="sm" variant="primary" onClick={() => void changeStatus(c, "active")}>
                                <CirclePlay size={14} /> {c.status === "draft" ? "Launch" : "Resume"}
                              </Button>
                            ) : (
                              <Button size="sm" variant="ghost" onClick={() => void changeStatus(c, "active")} disabled>
                                <Ban size={14} /> Ended
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-line bg-surface-2/25">
                          <td colSpan={5} className="px-3 pb-2 align-top">
                            <CampaignDetail campaign={c} onEdit={(x) => setModal({ mode: "edit", campaign: x })} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </Card>

          {/* Mobile list */}
          <div className="space-y-2.5 md:hidden">
            {visible.map((c) => {
              const open = expandedId === c.id;
              const week = last7(c);
              return (
                <Card key={c.id} className="p-3.5">
                  <button
                    onClick={() => setExpandedId(open ? null : c.id)}
                    aria-expanded={open}
                    className="flex w-full items-start gap-2.5 text-left"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold">{c.name}</span>
                      <span className="mt-0.5 block truncate text-xs text-ink-soft">
                        {OBJECTIVE_LABEL[c.objective]} · {FORMAT_LABEL[c.format]}
                      </span>
                    </span>
                    <span className="shrink-0">
                      <StatusPill status={c.status} />
                    </span>
                  </button>

                  <div className="mt-3">
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="font-semibold tabular-nums">{money(c.spend ?? 0)} spent</span>
                      <span className="text-ink-faint tabular-nums">budget {money(c.budget ?? 0)}</span>
                    </div>
                    <ProgressBar
                      className="mt-1.5"
                      value={c.budget > 0 ? ((c.spend ?? 0) / c.budget) * 100 : 0}
                      showLabel
                      tone={(c.spend ?? 0) >= c.budget ? "warn" : "accent"}
                    />
                    <p className="mt-2 text-[11px] text-ink-soft tabular-nums">
                      {formatNumber(c.metrics?.impressions ?? 0)} impressions · {formatNumber(c.metrics?.clicks ?? 0)} clicks ·{" "}
                      {formatNumber(week.impressions)} impr last 7d · {ctrOf([c]).toFixed(1)}% CTR
                    </p>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                    <Button size="sm" variant="outline" onClick={() => setModal({ mode: "edit", campaign: c })}>
                      Edit
                    </Button>
                    {c.status === "active" ? (
                      <Button size="sm" variant="soft" onClick={() => void changeStatus(c, "paused")}>
                        <CirclePause size={14} /> Pause
                      </Button>
                    ) : c.status === "completed" ? (
                      <Button size="sm" variant="ghost" disabled>
                        <Ban size={14} /> Ended
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => void changeStatus(c, "active")}>
                        <CirclePlay size={14} /> {c.status === "draft" ? "Launch" : "Resume"}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setExpandedId(open ? null : c.id)}>
                      {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      {open ? "Hide results" : "View results"}
                    </Button>
                  </div>

                  {open && <CampaignDetail campaign={c} onEdit={(x) => setModal({ mode: "edit", campaign: x })} />}
                </Card>
              );
            })}
          </div>

          <p className="text-center text-[11px] text-ink-faint">
            Delivery figures update when a campaign reports. Budgets are total, not daily.
          </p>
        </>
      )}

      {modal && (
        <CampaignFormModal
          mode={modal.mode}
          campaign={modal.campaign}
          onClose={() => setModal(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}
