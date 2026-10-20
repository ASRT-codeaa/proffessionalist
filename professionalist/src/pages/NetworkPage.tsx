import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ArrowRight, ChevronDown, Compass, Inbox, Link2, MoreHorizontal, Search, SlidersHorizontal, Sparkles, Trash2, UserCheck, UserPlus, Users, X } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { BusinessCard, PersonCard } from "@/components/cards";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Dropdown,
  EmptyState,
  ErrorState,
  Input,
  MenuItem,
  Select,
  Skeleton,
  Tabs,
  VerifiedBadge,
} from "@/components/ui";
import { useToast } from "@/context/ToastContext";
import { errorMessage, useAsync, useDebounced } from "@/hooks/useAsync";
import type { AsyncState } from "@/hooks/useAsync";
import { metaApi, networkApi } from "@/services/api";
import type { Business, ConnectionFilters, Paginated, Person } from "@/services/types";
import { cn, formatNumber, fullName } from "@/lib/utils";

/* ------------------------------------------------------------------ model -- */

type RequestItem = Person & { requestId: number };
type Overview = Awaited<ReturnType<typeof networkApi.overview>>;

const TAB_IDS = ["my", "connections", "requests", "suggestions", "following", "followers"] as const;
type TabId = (typeof TAB_IDS)[number];

const TAB_LABELS: Record<TabId, string> = {
  my: "My network",
  connections: "Connections",
  requests: "Requests",
  suggestions: "Suggestions",
  following: "Following",
  followers: "Followers",
};

const PAGE_SIZE = 12;
const PEOPLE_GRID = "grid gap-3 grid-cols-1 @lg:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-4";
const BUSINESS_GRID = "grid gap-3 grid-cols-1 @md:grid-cols-2 @4xl:grid-cols-3";

const EMPTY_PAGE: Paginated<Person> = { items: [], total: 0, page: 1, pageSize: 0, hasMore: false };

function isTabId(value: string | null): value is TabId {
  return value !== null && (TAB_IDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------- filter helpers -- */

function matchesQuery(p: Person, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [fullName(p), p.title, p.company, p.location, p.category, ...p.skills].join(" ").toLowerCase().includes(needle);
}

/** Applies the same predicates as the server-side `ConnectionFilters` contract, so a filtered view is never silently ignored. */
function matchesFilters(p: Person, f: ConnectionFilters): boolean {
  const needle = (v?: string) => (v ?? "").trim().toLowerCase();
  const industry = needle(f.industry);
  if (industry && !p.category.toLowerCase().includes(industry)) return false;
  const profession = needle(f.profession);
  if (profession && !p.title.toLowerCase().includes(profession)) return false;
  const location = needle(f.location);
  if (location && !p.location.toLowerCase().includes(location)) return false;
  const skill = needle(f.skill);
  if (skill && !p.skills.some((s) => s.toLowerCase().includes(skill))) return false;
  return true;
}

type PeopleSort = "name_asc" | "name_desc" | "mutual" | "company";

const SORT_OPTIONS = [
  { value: "name_asc", label: "Name (A–Z)" },
  { value: "name_desc", label: "Name (Z–A)" },
  { value: "mutual", label: "Most mutual connections" },
  { value: "company", label: "Company" },
];

function sortPeople(list: Person[], sort: PeopleSort): Person[] {
  const byName = (a: Person, b: Person) => fullName(a).localeCompare(fullName(b));
  const copy = [...list];
  if (sort === "name_desc") return copy.sort((a, b) => byName(b, a));
  if (sort === "mutual") return copy.sort((a, b) => b.mutualConnections - a.mutualConnections || byName(a, b));
  if (sort === "company") return copy.sort((a, b) => a.company.localeCompare(b.company) || byName(a, b));
  return copy.sort(byName);
}

function countActiveFilters(f: ConnectionFilters): number {
  return [f.industry, f.profession, f.location, f.skill].filter((v) => (v ?? "").trim()).length;
}

/* ------------------------------------------------------------ skeletons -- */

function PersonCardSkeleton() {
  return (
    <Card className="flex flex-col items-center p-4 text-center">
      <Skeleton className="h-20 w-20 rounded-full" />
      <Skeleton className="mt-3 h-3.5 w-32" />
      <Skeleton className="mt-2 h-3 w-40" />
      <Skeleton className="mt-1.5 h-3 w-24" />
      <div className="mt-2.5 grid grid-cols-3 gap-1.5">
        <Skeleton className="h-5 w-14 rounded-full" />
        <Skeleton className="h-5 w-12 rounded-full" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="mt-3.5 grid w-full grid-cols-2 gap-2">
        <Skeleton className="h-8 rounded-lg" />
        <Skeleton className="h-8 rounded-lg" />
      </div>
      <Skeleton className="mt-2 h-3 w-16" />
    </Card>
  );
}

function PeopleGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className={PEOPLE_GRID} aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <PersonCardSkeleton key={i} />
      ))}
    </div>
  );
}

function BusinessGridSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className={BUSINESS_GRID} aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} className="overflow-hidden">
          <Skeleton className="h-20 rounded-none" />
          <div className="space-y-2 p-4">
            <Skeleton className="h-14 w-14 rounded-2xl" />
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-9 rounded-xl" />
          </div>
        </Card>
      ))}
    </div>
  );
}

function RequestRowSkeleton() {
  return (
    <Card className="flex flex-wrap items-center gap-3 p-4">
      <Skeleton className="h-14 w-14 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3 w-56" />
      </div>
      <div className="grid w-full grid-cols-2 gap-2 sm:w-auto">
        <Skeleton className="h-10 w-full rounded-xl sm:w-28" />
        <Skeleton className="h-10 w-full rounded-xl sm:w-28" />
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ primitives -- */

function SectionHeader({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-base font-bold sm:text-lg">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-ink-soft sm:text-[13px]">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

function StateLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold text-ink-soft">
      <span className="text-ink-faint" aria-hidden>
        {icon}
      </span>
      {children}
    </p>
  );
}

function StatTile({
  icon,
  label,
  value,
  caption,
  highlight,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  caption?: string;
  highlight?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn("card card-hover flex min-h-[92px] flex-col items-start gap-1 p-3 text-left", highlight && "border-accent bg-accent-soft")}
    >
      <span className={cn("flex h-8 w-8 items-center justify-center rounded-lg", highlight ? "bg-accent text-accent-ink" : "bg-surface-2 text-accent")}>
        {icon}
      </span>
      <span className="text-xl font-extrabold leading-none tabular-nums">{formatNumber(value)}</span>
      <span className={cn("text-[11px] font-semibold uppercase tracking-wide", highlight ? "text-accent" : "text-ink-soft")}>{label}</span>
      {caption && <span className="text-[11px] text-ink-faint">{caption}</span>}
    </button>
  );
}

/* ------------------------------------------------- invitation interaction -- */

function useRequestResponder(setItems: (fn: (prev: RequestItem[]) => RequestItem[]) => void, afterChange: () => void) {
  const toast = useToast();
  const [busyId, setBusyId] = useState<number | null>(null);

  const respond = useCallback(
    async (request: RequestItem, action: "accept" | "decline", index: number) => {
      const name = fullName(request);
      setBusyId(request.requestId);
      setItems((prev) => prev.filter((r) => r.requestId !== request.requestId));
      try {
        if (action === "accept") {
          await networkApi.acceptRequest(request.requestId);
          toast.success(`You are now connected with ${name}`);
        } else {
          await networkApi.declineRequest(request.requestId);
          toast.info(`Invitation from ${name} declined`);
        }
        afterChange();
      } catch (e) {
        setItems((prev) => {
          if (prev.some((r) => r.requestId === request.requestId)) return prev;
          const next = [...prev];
          next.splice(Math.max(0, Math.min(index, next.length)), 0, request);
          return next;
        });
        toast.error(errorMessage(e));
      } finally {
        setBusyId(null);
      }
    },
    [afterChange, setItems, toast]
  );

  return { busyId, respond };
}

function RequestRow({
  request,
  index,
  busyId,
  onRespond,
}: {
  request: RequestItem;
  index: number;
  busyId: number | null;
  onRespond: (request: RequestItem, action: "accept" | "decline", index: number) => void;
}) {
  const name = fullName(request);
  const busy = busyId === request.requestId;
  return (
    <Card className="anim-fade-up flex flex-wrap items-center gap-3 p-4">
      <Link to={`/profile/${request.username}`} aria-label={`Open ${name}'s profile`} className="shrink-0">
        <Avatar name={name} src={request.avatarUrl} size="lg" />
      </Link>
      <div className="min-w-0 flex-1">
        <Link to={`/profile/${request.username}`} className="flex items-center gap-1.5 text-sm font-bold hover:underline">
          <span className="truncate">{name}</span>
          {request.verified && <VerifiedBadge color={request.verifiedColor} />}
        </Link>
        <p className="truncate text-[13px] text-ink-soft">{request.title}</p>
        <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-faint">
          <Users size={12} aria-hidden />
          {request.mutualConnections > 0
            ? `${request.mutualConnections} mutual connection${request.mutualConnections === 1 ? "" : "s"}`
            : "New to your network"}
        </p>
      </div>
      <div className="grid w-full grid-cols-2 gap-2 sm:w-auto sm:shrink-0">
        <Button size="md" loading={busy} onClick={() => void onRespond(request, "accept", index)}>
          <UserCheck size={16} aria-hidden /> Accept
        </Button>
        <Button size="md" variant="outline" disabled={busy} onClick={() => void onRespond(request, "decline", index)}>
          Decline
        </Button>
      </div>
    </Card>
  );
}

/* ------------------------------------------------- people filter controls -- */

function PersonFilterFields({
  value,
  onChange,
  onReset,
}: {
  value: ConnectionFilters;
  onChange: (next: ConnectionFilters) => void;
  onReset: () => void;
}) {
  const categories = useAsync(() => metaApi.professionalCategories(), []);
  const options = useMemo(() => (categories.data ?? []).map((c) => ({ value: c, label: c })), [categories.data]);
  const active = countActiveFilters(value);

  return (
    <div className="space-y-3">
      {categories.error ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-danger">
          {errorMessage(categories.error)}
          <Button variant="ghost" size="sm" className="min-h-10" onClick={categories.refetch}>
            Retry industries
          </Button>
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-3 sm:grid-cols-2">
          {categories.loading && !categories.data ? (
            <Skeleton className="h-[58px] rounded-xl" />
          ) : (
            <Select
              label="Industry"
              placeholder="Any industry"
              value={value.industry ?? ""}
              options={options}
              onChange={(e) => onChange({ ...value, industry: e.target.value || undefined })}
            />
          )}
          <Input
            label="Profession or title"
            placeholder="e.g. Product designer"
            value={value.profession ?? ""}
            onChange={(e) => onChange({ ...value, profession: e.target.value || undefined })}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Location"
            placeholder="e.g. Lagos"
            value={value.location ?? ""}
            onChange={(e) => onChange({ ...value, location: e.target.value || undefined })}
          />
          <Input
            label="Skill"
            placeholder="e.g. Figma"
            value={value.skill ?? ""}
            onChange={(e) => onChange({ ...value, skill: e.target.value || undefined })}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StateLine icon={<SlidersHorizontal size={13} />}>
          {active > 0 ? `${active} filter${active === 1 ? "" : "s"} applied` : "No filters applied"}
        </StateLine>
        <Button variant="ghost" size="sm" className="min-h-10" onClick={onReset} disabled={active === 0}>
          <X size={14} aria-hidden /> Reset filters
        </Button>
      </div>
    </div>
  );
}

function FilterBar({ value, onChange, caption }: { value: ConnectionFilters; onChange: (next: ConnectionFilters) => void; caption: string }) {
  const [open, setOpen] = useState(false);
  const active = countActiveFilters(value);

  return (
    <Card className="p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 rounded-xl text-left"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <SlidersHorizontal size={17} aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2 text-sm font-bold">
              {caption}
              {active > 0 && <Badge tone="accent">{active} active</Badge>}
            </span>
            <span className="block truncate text-xs text-ink-soft">Industry, profession, location and skill</span>
          </span>
        </span>
        <ChevronDown size={18} className={cn("shrink-0 text-ink-faint transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="mt-3 border-t border-line pt-3">
          <PersonFilterFields value={value} onChange={onChange} onReset={() => onChange({})} />
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------- My network tab -- */

function MyNetworkPanel({
  overview,
  version,
  onSelectTab,
  onChanged,
}: {
  overview: AsyncState<Overview>;
  version: number;
  onSelectTab: (tab: TabId) => void;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const stats = useAsync(
    () =>
      Promise.all([networkApi.connections({ pageSize: 1 }), networkApi.following(), networkApi.followers()]).then(
        ([connections, following, followers]) => ({
          connections: connections.total,
          people: following.people.length,
          businesses: following.businesses.length,
          followers: followers.length,
        })
      ),
    [version]
  );

  const setRequests = useCallback(
    (fn: (prev: RequestItem[]) => RequestItem[]) =>
      overview.setData((prev) => {
        const base: Overview = prev ?? { requests: [], suggestions: [], invitations: 0 };
        return { ...base, requests: fn(base.requests) };
      }),
    [overview]
  );
  const { busyId, respond } = useRequestResponder(setRequests, onChanged);

  const data = overview.data;
  const invitations = data?.invitations ?? 0;

  return (
    <div className="space-y-6">
      <section aria-label="Network summary" className="grid grid-cols-2 gap-3 @xl:grid-cols-3 @4xl:grid-cols-5">
        {stats.loading && Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="min-h-[92px] rounded-2xl" />)}
        {stats.error && !stats.loading && (
          <Card className="col-span-2 @xl:col-span-3 @4xl:col-span-5">
            <ErrorState message={errorMessage(stats.error)} onRetry={stats.refetch} />
          </Card>
        )}
        {stats.data && (
          <>
            <StatTile icon={<Users size={17} />} label="Connections" value={stats.data.connections} onClick={() => onSelectTab("connections")} />
            <StatTile
              icon={<Inbox size={17} />}
              label="Pending requests"
              value={invitations}
              highlight={invitations > 0}
              onClick={() => onSelectTab("requests")}
            />
            <StatTile icon={<Sparkles size={17} />} label="Suggestions" value={data?.suggestions.length ?? 0} onClick={() => onSelectTab("suggestions")} />
            <StatTile
              icon={<UserPlus size={17} />}
              label="Following"
              value={stats.data.people + stats.data.businesses}
              caption={`${stats.data.people} people · ${stats.data.businesses} businesses`}
              onClick={() => onSelectTab("following")}
            />
            <StatTile icon={<UserCheck size={17} />} label="Followers" value={stats.data.followers} onClick={() => onSelectTab("followers")} />
          </>
        )}
      </section>

      <section aria-label="Pending invitations">
        <SectionHeader
          title="Invitations"
          hint={invitations > 0 ? `${invitations} waiting on you` : "People who asked to connect with you"}
          action={
            invitations > 1 ? (
              <Button variant="ghost" size="sm" className="min-h-10" onClick={() => onSelectTab("requests")}>
                See all requests <ArrowRight size={15} className="text-ink-faint" aria-hidden />
              </Button>
            ) : undefined
          }
        />
        {overview.loading && (
          <div className="space-y-3">
            <RequestRowSkeleton />
            <RequestRowSkeleton />
          </div>
        )}
        {!overview.loading && data && data.requests.length === 0 && (
          <Card>
            <EmptyState
              icon={<Inbox />}
              title="No pending invitations"
              description="When someone wants to connect, their request lands here."
              action={
                <Button onClick={() => navigate("/discover")}>
                  <Compass size={16} aria-hidden /> Find colleagues
                </Button>
              }
            />
          </Card>
        )}
        {!overview.loading && data && data.requests.length > 0 && (
          <div className="space-y-3">
            {data.requests.slice(0, 3).map((r, i) => (
              <RequestRow key={r.requestId} request={r} index={i} busyId={busyId} onRespond={respond} />
            ))}
          </div>
        )}
      </section>

      <section aria-label="People you may know">
        <SectionHeader
          title="People you may know"
          hint="Based on your industry, mutual connections and profile"
          action={
            <Button variant="ghost" size="sm" className="min-h-10" onClick={() => onSelectTab("suggestions")}>
              See all <ArrowRight size={15} className="text-ink-faint" aria-hidden />
            </Button>
          }
        />
        {overview.loading && <PeopleGridSkeleton count={4} />}
        {!overview.loading && data && data.suggestions.length === 0 && (
          <Card>
            <EmptyState
              icon={<Sparkles />}
              title="No suggestions right now"
              description="You are caught up. Discover more professionals by industry, location or skill."
              action={
                <Button onClick={() => navigate("/discover")}>
                  <Search size={16} aria-hidden /> Browse Discover
                </Button>
              }
            />
          </Card>
        )}
        {!overview.loading && data && data.suggestions.length > 0 && (
          <div className={PEOPLE_GRID}>
            {data.suggestions.slice(0, 4).map((p) => (
              <PersonCard key={p.id} person={p} />
            ))}
          </div>
        )}
      </section>

      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-sm font-bold">Keep looking further</p>
          <p className="mt-0.5 text-[13px] text-ink-soft">Search businesses, products, services and open opportunities in one place.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => navigate("/search")}>
            <Search size={16} aria-hidden /> Search
          </Button>
          <Button onClick={() => navigate("/discover")}>
            <Compass size={16} aria-hidden /> Discover
          </Button>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------ connections -- */

function ConnectionsPanel({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ConnectionFilters>({});
  const filters = useDebounced(draft, 350);
  const filterKey = JSON.stringify(filters);
  const [pages, setPages] = useState(1);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<PeopleSort>("name_asc");

  const state = useAsync(() => networkApi.connections({ ...filters, pageSize: PAGE_SIZE * pages }), [filterKey, pages]);

  const loaded = state.data?.items ?? [];
  const visible = useMemo(
    () => sortPeople(loaded.filter((p) => matchesFilters(p, filters) && matchesQuery(p, q)), sort),
    [loaded, filters, q, sort]
  );
  const total = state.data?.total ?? 0;

  const remove = async (p: Person) => {
    const name = fullName(p);
    state.setData((cur) => {
      const page = cur ?? EMPTY_PAGE;
      return { ...page, items: page.items.filter((x) => x.id !== p.id), total: Math.max(0, page.total - 1) };
    });
    try {
      await networkApi.removeConnection(p.id);
      toast.success(`${name} removed from your connections`);
      onChanged();
    } catch (e) {
      state.setData((cur) => {
        const page = cur ?? EMPTY_PAGE;
        if (page.items.some((x) => x.id === p.id)) return page;
        return { ...page, items: [...page.items, p], total: page.total + 1 };
      });
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="space-y-4">
      <FilterBar value={draft} onChange={setDraft} caption="Filter connections" />

      <Card className="p-3">
        <div className="grid gap-3 lg:grid-cols-[1fr_210px] lg:items-end">
          <div className="relative">
            <Input
              label="Search your connections"
              icon={<Search size={16} aria-hidden />}
              placeholder="Name, title, company or skill"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className={cn(q && "pr-10")}
            />
            {q && (
              <button
                onClick={() => setQ("")}
                aria-label="Clear connection search"
                className="absolute bottom-1 right-1 flex h-10 w-10 items-center justify-center rounded-xl text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <X size={15} />
              </button>
            )}
          </div>
          <Select label="Sort by" value={sort} options={SORT_OPTIONS} onChange={(e) => setSort(e.target.value as PeopleSort)} />
        </div>
      </Card>

      {state.loading && <PeopleGridSkeleton count={6} />}

      {state.error && !state.loading && (
        <Card>
          <ErrorState message={errorMessage(state.error)} onRetry={state.refetch} />
        </Card>
      )}

      {!state.loading && state.data && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <StateLine icon={<Users size={14} />}>
              {q.trim() ? `${visible.length} of ${total} connections match “${q.trim()}”` : `${total} connection${total === 1 ? "" : "s"}`}
            </StateLine>
            {state.data.hasMore && <span className="text-xs text-ink-faint">Loaded {loaded.length} of {total}</span>}
          </div>

          {total === 0 ? (
            <Card>
              <EmptyState
                icon={<Users />}
                title="No connections yet"
                description="Connections are how opportunities find you. Start with people in your industry."
                action={
                  <Button onClick={() => navigate("/discover")}>
                    <Compass size={16} aria-hidden /> Find people to connect with
                  </Button>
                }
              />
            </Card>
          ) : visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Search />}
                title="No connections match"
                description="Nothing in your loaded connections matches that search and those filters."
                action={
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQ("");
                      setDraft({});
                    }}
                  >
                    <X size={15} aria-hidden /> Clear search and filters
                  </Button>
                }
              />
            </Card>
          ) : (
            <div className={PEOPLE_GRID}>
              {visible.map((p) => (
                <ConnectionTile key={p.id} person={p} onRemove={() => void remove(p)} />
              ))}
            </div>
          )}

          {state.data.hasMore && (
            <div className="flex justify-center pt-1">
              <Button variant="outline" onClick={() => setPages((n) => n + 1)}>
                Show more connections
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ConnectionTile({ person, onRemove }: { person: Person; onRemove: () => void }) {
  const navigate = useNavigate();
  const name = fullName(person);
  return (
    <div className="relative focus-within:z-30 hover:z-30">
      <PersonCard person={person} />
      <div className="absolute right-2 top-2 z-10">
        <Dropdown
          trigger={({ toggle, open }) => (
            <button
              onClick={toggle}
              aria-label={`Manage connection with ${name}`}
              aria-expanded={open}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface/90 text-ink-soft shadow-sm backdrop-blur transition-colors hover:text-ink"
            >
              <MoreHorizontal size={16} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<Link2 size={16} aria-hidden />}
                onClick={() => {
                  navigate(`/profile/${person.username}`);
                  close();
                }}
              >
                View profile
              </MenuItem>
              <MenuItem
                icon={<Trash2 size={16} aria-hidden />}
                danger
                onClick={() => {
                  close();
                  onRemove();
                }}
              >
                Remove connection
              </MenuItem>
            </>
          )}
        </Dropdown>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- requests -- */

function RequestsPanel({ onChanged }: { onChanged: () => void }) {
  const navigate = useNavigate();
  const state = useAsync(() => networkApi.requests(), []);
  const setItems = useCallback(
    (fn: (prev: RequestItem[]) => RequestItem[]) => state.setData((prev) => fn(prev ?? [])),
    [state]
  );
  const { busyId, respond } = useRequestResponder(setItems, onChanged);
  const items = state.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StateLine icon={<Inbox size={14} />}>
          {state.loading ? "Loading invitations…" : `${items.length} pending invitation${items.length === 1 ? "" : "s"}`}
        </StateLine>
        {items.length > 0 && <span className="text-xs text-ink-faint">Accepted invitations appear in Connections immediately.</span>}
      </div>

      {state.loading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <RequestRowSkeleton key={i} />
          ))}
        </div>
      )}

      {state.error && !state.loading && (
        <Card>
          <ErrorState message={errorMessage(state.error)} onRetry={state.refetch} />
        </Card>
      )}

      {!state.loading && !state.error && items.length === 0 && (
        <Card>
          <EmptyState
            icon={<Inbox />}
            title="No pending invitations"
            description="Your invitations inbox is clear. Send the first one and grow your network."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => navigate("/discover")}>
                  <Compass size={16} aria-hidden /> Find colleagues
                </Button>
                <Button variant="outline" onClick={() => navigate("/search?tab=people")}>
                  <Search size={16} aria-hidden /> Search people
                </Button>
              </div>
            }
          />
        </Card>
      )}

      {!state.loading && items.length > 0 && (
        <div className="space-y-3">
          {items.map((r, i) => (
            <RequestRow key={r.requestId} request={r} index={i} busyId={busyId} onRespond={respond} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ suggestions -- */

function SuggestionsPanel() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ConnectionFilters>({});
  const filters = useDebounced(draft, 350);
  const filterKey = JSON.stringify(filters);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const state = useAsync(() => networkApi.suggestions({ ...filters, pageSize: limit }), [filterKey, limit]);
  const raw = state.data ?? [];
  const visible = useMemo(() => raw.filter((p) => matchesFilters(p, filters)), [raw, filters]);
  const active = countActiveFilters(draft);

  return (
    <div className="space-y-4">
      <FilterBar value={draft} onChange={setDraft} caption="Filter suggestions" />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <StateLine icon={<Sparkles size={14} />}>
          {state.loading ? "Finding people you may know…" : `${visible.length} suggested ${visible.length === 1 ? "person" : "people"}`}
          {active > 0 && !state.loading && <span className="font-normal text-ink-faint">with {active} filter{active === 1 ? "" : "s"} applied</span>}
        </StateLine>
        <Button variant="ghost" size="sm" className="min-h-10" onClick={() => navigate("/discover")}>
          More ways to discover <ArrowRight size={15} className="text-ink-faint" aria-hidden />
        </Button>
      </div>

      {state.loading && <PeopleGridSkeleton count={6} />}

      {state.error && !state.loading && (
        <Card>
          <ErrorState message={errorMessage(state.error)} onRetry={state.refetch} />
        </Card>
      )}

      {!state.loading && !state.error && visible.length === 0 && (
        <Card>
          <EmptyState
            icon={<Users />}
            title={active > 0 ? "No matches for these filters" : "No suggestions available"}
            description={
              active > 0
                ? "Try a broader industry, location or skill — suggestions refresh as your network grows."
                : "You are already connected with everyone we would suggest right now."
            }
            action={
              active > 0 ? (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="outline" onClick={() => setDraft({})}>
                    <X size={15} aria-hidden /> Clear filters
                  </Button>
                  <Button onClick={() => navigate("/discover")}>
                    <Compass size={16} aria-hidden /> Go to Discover
                  </Button>
                </div>
              ) : (
                <Button onClick={() => navigate("/discover")}>
                  <Compass size={16} aria-hidden /> Go to Discover
                </Button>
              )
            }
          />
        </Card>
      )}

      {!state.loading && visible.length > 0 && (
        <>
          <div className={PEOPLE_GRID}>
            {visible.map((p) => (
              <PersonCard key={p.id} person={p} />
            ))}
          </div>
          {raw.length >= limit && (
            <div className="flex flex-col items-center gap-2 pt-1">
              <Button variant="outline" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                See more people
              </Button>
              <span className="text-xs text-ink-faint">Showing {limit} at a time</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- following -- */

function FollowingPanel() {
  const navigate = useNavigate();
  const state = useAsync(() => networkApi.following(), []);
  const people = state.data?.people ?? [];
  const businesses = state.data?.businesses ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StateLine icon={<UserPlus size={14} />}>
          {state.loading
            ? "Loading who you follow…"
            : `Following ${people.length} ${people.length === 1 ? "person" : "people"} and ${businesses.length} ${businesses.length === 1 ? "business" : "businesses"}`}
        </StateLine>
        <Link to="/home" className="text-[13px] font-semibold text-accent hover:underline">
          See their posts in your feed
        </Link>
      </div>

      {state.loading && (
        <div className="space-y-4">
          <PeopleGridSkeleton count={2} />
          <BusinessGridSkeleton count={2} />
        </div>
      )}

      {state.error && !state.loading && (
        <Card>
          <ErrorState message={errorMessage(state.error)} onRetry={state.refetch} />
        </Card>
      )}

      {!state.loading && !state.error && people.length + businesses.length === 0 && (
        <Card>
          <EmptyState
            icon={<UserPlus />}
            title="You are not following anyone yet"
            description="Following keeps people and businesses in your feed without needing a connection."
            action={
              <Button onClick={() => navigate("/discover")}>
                <Compass size={16} aria-hidden /> Find someone to follow
              </Button>
            }
          />
        </Card>
      )}

      {!state.loading && people.length > 0 && (
        <section aria-label="People you follow" className="space-y-3">
          <SectionHeader title="People" hint={`${people.length} followed · unfollow from any card`} />
          <div className={PEOPLE_GRID}>
            {people.map((p) => (
              <PersonCard key={p.id} person={p} />
            ))}
          </div>
        </section>
      )}

      {!state.loading && businesses.length > 0 && (
        <section aria-label="Businesses you follow" className="space-y-3">
          <SectionHeader title="Businesses" hint={`${businesses.length} followed · unfollow from any card`} />
          <div className={BUSINESS_GRID}>
            {businesses.map((b: Business) => (
              <BusinessCard key={b.id} business={b} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- followers -- */

function FollowersPanel() {
  const navigate = useNavigate();
  const state = useAsync(() => networkApi.followers(), []);
  const people = state.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StateLine icon={<UserCheck size={14} />}>
          {state.loading ? "Loading followers…" : `${people.length} follower${people.length === 1 ? "" : "s"}`}
        </StateLine>
        {people.length > 0 && <span className="text-xs text-ink-faint">Use Connect on a card to bring them into your network</span>}
      </div>

      {state.loading && <PeopleGridSkeleton count={6} />}

      {state.error && !state.loading && (
        <Card>
          <ErrorState message={errorMessage(state.error)} onRetry={state.refetch} />
        </Card>
      )}

      {!state.loading && !state.error && people.length === 0 && (
        <Card>
          <EmptyState
            icon={<UserCheck />}
            title="No followers yet"
            description="Post regularly and connect with peers — followers usually arrive first."
            action={
              <Button onClick={() => navigate("/discover")}>
                <Compass size={16} aria-hidden /> Discover people and businesses
              </Button>
            }
          />
        </Card>
      )}

      {!state.loading && people.length > 0 && (
        <div className={PEOPLE_GRID}>
          {people.map((p) => (
            <PersonCard key={p.id} person={p} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ page -- */

export default function NetworkPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [version, setVersion] = useState(0);
  const urlTab = params.get("tab");
  const tab: TabId = isTabId(urlTab) ? urlTab : "my";

  const overview = useAsync(() => networkApi.overview(), [version]);
  const invitations = overview.data?.invitations ?? 0;

  const selectTab = useCallback(
    (id: TabId) => {
      const next = new URLSearchParams(params);
      if (id === "my") next.delete("tab");
      else next.set("tab", id);
      setParams(next, { replace: true });
    },
    [params, setParams]
  );

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  return (
    <div className="@container space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">My network</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Manage invitations, keep your connections tidy and follow the people and businesses that matter.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => navigate("/search?tab=people")}>
            <Search size={16} aria-hidden /> Find people
          </Button>
          <Button onClick={() => navigate("/discover")}>
            <Compass size={16} aria-hidden /> Discover
          </Button>
        </div>
      </header>

      <Card className="px-2 py-1">
        <Tabs
          items={TAB_IDS.map((id) => ({
            id,
            label: TAB_LABELS[id],
            count: id === "requests" && invitations > 0 ? invitations : undefined,
          }))}
          value={tab}
          onChange={(id) => selectTab(id as TabId)}
        />
      </Card>

      <div key={tab}>
        {tab === "my" &&
          (overview.error ? (
            <Card>
              <ErrorState message={errorMessage(overview.error)} onRetry={overview.refetch} />
            </Card>
          ) : !overview.data ? (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-3 @xl:grid-cols-3 @4xl:grid-cols-5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="min-h-[92px] rounded-2xl" />
                ))}
              </div>
              <RequestRowSkeleton />
              <PeopleGridSkeleton count={4} />
            </div>
          ) : (
            <MyNetworkPanel overview={overview} version={version} onSelectTab={selectTab} onChanged={bump} />
          ))}
        {tab === "connections" && <ConnectionsPanel onChanged={bump} />}
        {tab === "requests" && <RequestsPanel onChanged={bump} />}
        {tab === "suggestions" && <SuggestionsPanel />}
        {tab === "following" && <FollowingPanel />}
        {tab === "followers" && <FollowersPanel />}
      </div>
    </div>
  );
}
