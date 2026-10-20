import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Briefcase,
  CalendarClock,
  ChevronRight,
  Copy,
  MapPin,
  Search,
  SlidersHorizontal,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  Select,
  Skeleton,
  Switch,
  Tabs,
} from "@/components/ui";
import { OpportunityCard } from "@/components/cards";
import { useToast } from "@/context/ToastContext";
import { errorMessage, useAsync, useDebounced } from "@/hooks/useAsync";
import { opportunitiesApi } from "@/services/api";
import { mediaUrl } from "@/services/http";
import type { Opportunity, Paginated } from "@/services/types";
import { cn, timeAgo } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/*  Filters                                                                    */
/* -------------------------------------------------------------------------- */

const PAGE_SIZE = 12;

const KINDS: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "job", label: "Jobs" },
  { id: "freelance", label: "Freelance" },
  { id: "partnership", label: "Partnerships" },
  { id: "business", label: "Business" },
  { id: "event", label: "Events" },
  { id: "project", label: "Projects" },
];

type SortKey = "recent" | "deadline" | "title";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Newest first" },
  { value: "deadline", label: "Closing soonest" },
  { value: "title", label: "Title A–Z" },
];

interface Filters {
  kind: string;
  q: string;
  location: string;
  remote: boolean;
  sort: SortKey;
}

function readFilters(params: URLSearchParams): Filters {
  const sort = params.get("sort");
  return {
    kind: KINDS.some((k) => k.id === params.get("kind")) ? (params.get("kind") as string) : "all",
    q: params.get("q") ?? "",
    location: params.get("location") ?? "",
    remote: params.get("remote") === "true",
    sort: sort === "deadline" || sort === "title" ? sort : "recent",
  };
}

function countActive(f: Filters): number {
  return [f.kind !== "all", f.q.trim() !== "", f.location.trim() !== "", f.remote, f.sort !== "recent"].filter(Boolean).length;
}

/* -------------------------------------------------------------------------- */
/*  Deadline helpers                                                           */
/* -------------------------------------------------------------------------- */

function deadlineInfo(iso: string | null): { label: string; detail: string; closed: boolean; soon: boolean } | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const diffDays = Math.ceil((t - Date.now()) / 86_400_000);
  const detail = new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (diffDays <= 0) {
    const ago = Math.abs(diffDays);
    return { label: ago === 0 ? "Closes today" : `Closed ${ago} day${ago === 1 ? "" : "s"} ago`, detail, closed: diffDays < 0, soon: diffDays === 0 };
  }
  if (diffDays <= 7) return { label: `Closes in ${diffDays} day${diffDays === 1 ? "" : "s"}`, detail, closed: false, soon: true };
  return { label: `Closes in ${diffDays} days`, detail, closed: false, soon: false };
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function OpportunitiesPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const active = countActive(filters);

  const apiQuery = useMemo(
    () => ({
      kind: filters.kind === "all" ? undefined : filters.kind,
      q: filters.q.trim() || undefined,
      location: filters.location.trim() || undefined,
      remote: filters.remote ? true : undefined,
    }),
    [filters.kind, filters.q, filters.location, filters.remote]
  );
  const apiQueryKey = JSON.stringify(apiQuery);

  const patchParams = useCallback(
    (changes: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(changes)) {
            if (value) next.set(key, value);
            else next.delete(key);
          }
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  /* debounced search text -> URL */
  const [qText, setQText] = useState(filters.q);
  const debouncedQ = useDebounced(qText, 400);
  const skipUrlSync = useRef(false);

  useEffect(() => {
    if (debouncedQ === filters.q) return;
    skipUrlSync.current = true;
    patchParams({ q: debouncedQ.trim() || null });
  }, [debouncedQ, filters.q, patchParams]);

  useEffect(() => {
    if (skipUrlSync.current) {
      skipUrlSync.current = false;
      return;
    }
    setQText(filters.q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.q]);

  /* location: same debounced treatment so typing doesn't fire a request per keystroke */
  const [locText, setLocText] = useState(filters.location);
  const debouncedLoc = useDebounced(locText, 450);
  const skipLocSync = useRef(false);

  useEffect(() => {
    if (debouncedLoc === filters.location) return;
    skipLocSync.current = true;
    patchParams({ location: debouncedLoc.trim() || null });
  }, [debouncedLoc, filters.location, patchParams]);

  useEffect(() => {
    if (skipLocSync.current) {
      skipLocSync.current = false;
      return;
    }
    setLocText(filters.location);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.location]);

  /* first page from useAsync, later pages accumulated by "Load more" */
  const first = useAsync(() => opportunitiesApi.list({ ...apiQuery, page: 1, pageSize: PAGE_SIZE }), [apiQueryKey]);
  const [extraPages, setExtraPages] = useState<Paginated<Opportunity>[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setExtraPages([]);
  }, [apiQueryKey]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const next = await opportunitiesApi.list({ ...apiQuery, page: extraPages.length + 2, pageSize: PAGE_SIZE });
      setExtraPages((prev) => [...prev, next]);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const items = useMemo(() => {
    const seen = new Set<number>();
    const out: Opportunity[] = [];
    for (const o of [...(first.data?.items ?? []), ...extraPages.flatMap((p) => p.items)]) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      out.push(o);
    }
    if (filters.sort === "deadline") {
      return [...out].sort((a, b) => {
        const av = a.deadline ? new Date(a.deadline).getTime() : Number.POSITIVE_INFINITY;
        const bv = b.deadline ? new Date(b.deadline).getTime() : Number.POSITIVE_INFINITY;
        return av - bv;
      });
    }
    if (filters.sort === "title") return [...out].sort((a, b) => a.title.localeCompare(b.title));
    return out;
  }, [first.data, extraPages, filters.sort]);

  const hasMore = (extraPages[extraPages.length - 1] ?? first.data)?.hasMore ?? false;
  const total = first.data?.total ?? 0;
  const loading = first.loading && !first.data;
  const showError = !!first.error && !first.loading;

  /* ------------------------------- apply I/O ------------------------------ */

  const applyOutcome = useCallback(
    (id: number, applied: boolean) => {
      const flip = (list: Opportunity[]) => list.map((o) => (o.id === id ? { ...o, applied } : o));
      if (first.data) first.setData({ ...first.data, items: flip(first.data.items) });
      setExtraPages((prev) => prev.map((p) => ({ ...p, items: flip(p.items) })));
    },
    [first]
  );

  const applyFromDrawer = async (o: Opportunity) => {
    if (o.applied) return;
    applyOutcome(o.id, true);
    try {
      const res = await opportunitiesApi.apply(o.id);
      applyOutcome(o.id, res.applied);
      toast.success(res.applied ? "Application sent" : "Application withdrawn");
    } catch (e) {
      applyOutcome(o.id, o.applied);
      toast.error(errorMessage(e));
    }
  };

  /* quiet refresh used after the card's own Apply call */
  const refreshQuietly = useCallback(() => {
    opportunitiesApi
      .list({ ...apiQuery, page: 1, pageSize: PAGE_SIZE })
      .then((d) => first.setData(d))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiQueryKey]);

  /* -------------------------------- details ------------------------------- */

  const [detailId, setDetailId] = useState<number | null>(null);
  const detail = items.find((o) => o.id === detailId) ?? null;

  const copyLink = async (o: Opportunity) => {
    const url = `${location.origin}/opportunities?kind=${o.kind}&q=${encodeURIComponent(o.title)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied", "Opens this opportunity with the matching filters.");
    } catch {
      toast.info("Copy this link", url);
    }
  };

  const clearAll = () => {
    setQText("");
    skipUrlSync.current = true;
    setLocText("");
    skipLocSync.current = true;
    patchParams({ kind: null, q: null, location: null, remote: null, sort: null });
  };

  const kindLabel = KINDS.find((k) => k.id === filters.kind)?.label ?? "All";

  return (
    <div className="w-full space-y-4 px-3 pb-2 sm:px-0 anim-fade-up">
      <header className="space-y-3 pt-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-lg font-extrabold">
              <Briefcase size={19} className="text-accent" aria-hidden />
              Opportunities
            </h1>
            <p className="mt-0.5 text-[13px] text-ink-soft">
              {first.loading && !first.data
                ? "Scanning the market…"
                : `${total} open ${total === 1 ? "role" : "roles"} · ${kindLabel}${filters.remote ? " · remote only" : ""}`}
            </p>
          </div>
          {active > 0 && (
            <Button variant="ghost" size="sm" onClick={clearAll}>
              <X size={15} /> Clear {active} filter{active === 1 ? "" : "s"}
            </Button>
          )}
        </div>

        <Card className="space-y-3 p-3.5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_auto_auto] lg:items-end">
            <Input
              label="Search"
              value={qText}
              onChange={(e) => setQText(e.target.value)}
              placeholder="Role, company or keyword"
              icon={<Search size={15} />}
              aria-label="Search opportunities by title, description or organization"
            />
            <Input
              label="Location"
              value={locText}
              onChange={(e) => setLocText(e.target.value)}
              placeholder="Lagos, Accra, Nairobi…"
              icon={<MapPin size={15} />}
            />
            <div className="flex h-10 items-center rounded-xl border border-line bg-surface px-3.5">
              <Switch checked={filters.remote} onChange={(v) => patchParams({ remote: v ? "true" : null })} label="Remote only" />
            </div>
            <Select
              label="Sort"
              value={filters.sort}
              onChange={(e) => patchParams({ sort: e.target.value === "recent" ? null : e.target.value })}
              options={SORT_OPTIONS}
              className="lg:w-44"
            />
          </div>

          {active > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-3 text-xs text-ink-soft">
              <SlidersHorizontal size={13} aria-hidden />
              <span className="font-semibold">Active:</span>
              {filters.kind !== "all" && <Badge tone="accent">{kindLabel}</Badge>}
              {filters.q.trim() && <Badge>“{filters.q.trim()}”</Badge>}
              {filters.location.trim() && <Badge>{filters.location.trim()}</Badge>}
              {filters.remote && <Badge tone="success">Remote</Badge>}
              {filters.sort !== "recent" && <Badge>{SORT_OPTIONS.find((s) => s.value === filters.sort)?.label}</Badge>}
            </div>
          )}
        </Card>

        <div className="overflow-hidden rounded-2xl border border-line bg-surface">
          <Tabs items={KINDS} value={filters.kind} onChange={(id) => patchParams({ kind: id === "all" ? null : id })} className="border-b-0 px-1" />
        </div>
      </header>

      {loading && <OpportunitiesSkeleton />}

      {showError && (
        <Card>
          <ErrorState message={errorMessage(first.error)} onRetry={first.refetch} />
        </Card>
      )}

      {!loading && !showError && items.length === 0 && (
        <Card>
          <EmptyState
            icon={<Sparkles />}
            title={active > 0 ? "No opportunities match these filters" : "No opportunities posted yet"}
            description={
              active > 0
                ? "Try a broader keyword, clear the location, or turn off the remote-only switch."
                : "When businesses post roles, projects or partnerships they appear here."
            }
            action={
              active > 0 ? (
                <Button variant="outline" onClick={clearAll}>
                  Clear all filters
                </Button>
              ) : (
                <Button variant="outline" onClick={() => patchParams({ kind: null, remote: null })}>
                  Show every kind
                </Button>
              )
            }
          />
        </Card>
      )}

      {!loading && !showError && items.length > 0 && (
        <>
          <p className="px-1 text-[13px] text-ink-soft" aria-live="polite">
            Showing <span className="font-semibold text-ink">{items.length}</span> of {total} {total === 1 ? "opportunity" : "opportunities"}
          </p>

          <ul className="space-y-3">
            {items.map((o) => (
              <li key={o.id} className="space-y-1">
                <OpportunityCard opportunity={o} onChanged={refreshQuietly} />
                <div className="flex justify-end px-1">
                  <button
                    onClick={() => setDetailId(o.id)}
                    className="inline-flex min-h-[40px] items-center gap-1 rounded-lg px-2 text-[13px] font-semibold text-ink-soft transition-colors hover:bg-surface-2 hover:text-accent"
                  >
                    View details <ChevronRight size={14} aria-hidden />
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <div className="flex justify-center pt-1">
            {hasMore ? (
              <Button variant="outline" loading={loadingMore} onClick={() => void loadMore()}>
                Load more opportunities
              </Button>
            ) : (
              <p className="pb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                That's everything in {kindLabel}
                {filters.q.trim() ? ` for “${filters.q.trim()}”` : ""}
              </p>
            )}
          </div>
        </>
      )}

      <Drawer open={!!detail} onClose={() => setDetailId(null)} label={detail ? `Details for ${detail.title}` : "Opportunity details"} side="right">
        {detail && (
          <DetailPanel
            opportunity={detail}
            onClose={() => setDetailId(null)}
            onApply={() => void applyFromDrawer(detail)}
            onCopy={() => void copyLink(detail)}
          />
        )}
      </Drawer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Detail panel                                                               */
/* -------------------------------------------------------------------------- */

function DetailPanel({
  opportunity,
  onClose,
  onApply,
  onCopy,
}: {
  opportunity: Opportunity;
  onClose: () => void;
  onApply: () => void;
  onCopy: () => void;
}) {
  const o = opportunity;
  const deadline = deadlineInfo(o.deadline);

  return (
    <>
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold">{o.title}</h2>
            <Badge tone="accent">{o.kind}</Badge>
            {o.remote && <Badge tone="success">Remote</Badge>}
          </div>
          <p className="mt-0.5 truncate text-[13px] text-ink-soft">
            Posted {timeAgo(o.createdAt) || "just now"} ago{o.applied ? " · you applied" : ""}
          </p>
        </div>
        <button onClick={onClose} aria-label="Close details" className="rounded-lg p-2 text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink">
          <X size={18} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="flex items-center gap-3">
          <Avatar name={o.organization} src={mediaUrl(o.organizationLogo)} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{o.organization}</p>
            <p className="flex items-center gap-1 truncate text-xs text-ink-soft">
              <MapPin size={11} aria-hidden /> {o.location || "Location flexible"}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-2.5">
          <Fact icon={<Briefcase size={13} />} label="Compensation" value={o.compensation || "Not stated"} />
          <Fact
            icon={<CalendarClock size={13} />}
            label="Deadline"
            value={deadline ? `${deadline.label} · ${deadline.detail}` : "No stated deadline"}
            tone={deadline?.closed ? "danger" : deadline?.soon ? "warn" : undefined}
          />
        </dl>

        {deadline && (
          <p className={cn("rounded-xl px-3 py-2.5 text-[13px] font-semibold", deadline.closed ? "bg-danger-soft text-danger" : deadline.soon ? "bg-warn-soft text-warn" : "bg-success-soft text-success")}>
            {deadline.closed ? "Applications are closed for this role." : deadline.soon ? `Closing window: ${deadline.label.toLowerCase()}.` : "Applications open — apply when your materials are ready."}
          </p>
        )}

        <section>
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Description</h3>
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-ink-soft">{o.description}</p>
        </section>

        <section className="rounded-xl border border-line bg-surface-2/60 p-3">
          <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
            <Users size={12} aria-hidden /> What happens when you apply
          </h3>
          <p className="mt-1.5 text-[13px] text-ink-soft">
            Your profile, skills and recent work go to {o.organization} as an application. This card switches to “Application sent” and the same state shows up
            wherever this opportunity is listed.
          </p>
        </section>
      </div>

      <div className="safe-bottom flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        <Button
          variant={o.applied ? "outline" : "primary"}
          className="min-w-[9rem] flex-1"
          onClick={onApply}
          disabled={o.applied || (deadline?.closed ?? false)}
        >
          {o.applied ? "Application sent" : deadline?.closed ? "Applications closed" : "Apply now"}
        </Button>
        <Button variant="outline" size="md" onClick={onCopy} aria-label="Copy a link to this opportunity">
          <Copy size={15} /> Link
        </Button>
      </div>
    </>
  );
}

function Fact({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: "danger" | "warn" }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <dt className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
        {icon}
        {label}
      </dt>
      <dd className={cn("mt-1 text-sm font-semibold", tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-ink")}>{value}</dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Skeleton                                                                   */
/* -------------------------------------------------------------------------- */

function OpportunitiesSkeleton() {
  return (
    <ul className="space-y-3" aria-label="Loading opportunities">
      {Array.from({ length: 4 }).map((_, i) => (
        <li key={i}>
          <Card className="flex gap-3.5 p-4">
            <Skeleton className="h-14 w-14 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-2.5 w-24" />
              <Skeleton className="h-2.5 w-full" />
              <Skeleton className="h-2.5 w-4/5" />
              <div className="flex gap-2 pt-1">
                <Skeleton className="h-4 w-28 rounded-full" />
                <Skeleton className="h-4 w-20 rounded-full" />
              </div>
            </div>
            <Skeleton className="h-8 w-20 self-center rounded-lg" />
          </Card>
        </li>
      ))}
    </ul>
  );
}
