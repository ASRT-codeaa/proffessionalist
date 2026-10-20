import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Briefcase, Building2, Clock, Compass, Hash, Newspaper, Search, Store, Trash2, Users, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { BusinessCard, ListingCard, OpportunityCard, PersonCard } from "@/components/cards";
import { PostCard, PostCardSkeleton } from "@/components/PostCard";
import { Avatar, Button, Card, EmptyState, ErrorState, Skeleton, SkeletonCard, Tabs, VerifiedBadge } from "@/components/ui";
import { useToast } from "@/context/ToastContext";
import { errorMessage, useAsync, useDebounced } from "@/hooks/useAsync";
import { searchApi } from "@/services/api";
import type { Business, Listing, Opportunity, Person, Post, SearchResults } from "@/services/types";
import { formatNumber, fullName } from "@/lib/utils";

/* ------------------------------------------------------------------ model -- */

type Row = Person | Business | Listing | Post | Opportunity;
type SectionKey = "people" | "businesses" | "products" | "services" | "posts" | "opportunities";
type TabKey = "all" | SectionKey;

const PEOPLE_GRID = "grid gap-3 grid-cols-1 @lg:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-4";
const BUSINESS_GRID = "grid gap-3 grid-cols-1 @md:grid-cols-2 @4xl:grid-cols-3";
const LISTING_GRID = "grid gap-3 grid-cols-2 @md:grid-cols-3 @4xl:grid-cols-4 @6xl:grid-cols-5";
const STACK = "space-y-3";
const POST_STACK = "mx-auto w-full max-w-2xl space-y-4";

interface SectionDef {
  id: SectionKey;
  label: string;
  noun: string;
  icon: LucideIcon;
  grid: string;
  preview: number;
}

const SECTIONS: SectionDef[] = [
  { id: "people", label: "People", noun: "people", icon: Users, grid: PEOPLE_GRID, preview: 4 },
  { id: "businesses", label: "Businesses", noun: "businesses", icon: Building2, grid: BUSINESS_GRID, preview: 3 },
  { id: "products", label: "Products", noun: "products", icon: Store, grid: LISTING_GRID, preview: 5 },
  { id: "services", label: "Services", noun: "services", icon: Briefcase, grid: LISTING_GRID, preview: 5 },
  { id: "posts", label: "Posts", noun: "posts", icon: Newspaper, grid: POST_STACK, preview: 2 },
  { id: "opportunities", label: "Opportunities", noun: "opportunities", icon: Compass, grid: STACK, preview: 3 },
];

const TAB_KEYS: readonly string[] = ["all", ...SECTIONS.map((s) => s.id)];

function isTabKey(value: string | null): value is TabKey {
  return value !== null && TAB_KEYS.includes(value);
}

function rowsFor(id: SectionKey, r: SearchResults): Row[] {
  switch (id) {
    case "people":
      return r.people;
    case "businesses":
      return r.businesses;
    case "products":
      return r.products.filter((l) => l.kind === "product");
    case "services":
      return r.products.filter((l) => l.kind === "service");
    case "posts":
      return r.posts;
    case "opportunities":
      return r.opportunities;
  }
}

/* -------------------------------------------------------------- skeletons -- */

function SectionSkeleton({ section, count }: { section: SectionDef; count: number }) {
  return (
    <section aria-label={`Loading ${section.noun}`} className="space-y-3">
      <div className="flex items-center justify-between gap-2 border-b border-line pb-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-5 w-24" />
      </div>
      <div className={section.grid} aria-busy="true">
        {Array.from({ length: count }).map((_, i) => {
          if (section.id === "people")
            return (
              <Card key={i} className="flex flex-col items-center p-4">
                <Skeleton className="h-20 w-20 rounded-full" />
                <Skeleton className="mt-3 h-3.5 w-32" />
                <Skeleton className="mt-2 h-3 w-40" />
                <div className="mt-3.5 grid w-full grid-cols-2 gap-2">
                  <Skeleton className="h-8 rounded-lg" />
                  <Skeleton className="h-8 rounded-lg" />
                </div>
              </Card>
            );
          if (section.id === "businesses")
            return (
              <Card key={i} className="overflow-hidden">
                <Skeleton className="h-20 rounded-none" />
                <div className="space-y-2 p-4">
                  <Skeleton className="-mt-10 h-14 w-14 rounded-2xl" />
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-9 rounded-xl" />
                </div>
              </Card>
            );
          if (section.id === "products" || section.id === "services") return <SkeletonCard key={i} height="h-32" />;
          if (section.id === "posts") return <PostCardSkeleton key={i} />;
          return (
            <Card key={i} className="flex gap-3 p-4">
              <Skeleton className="h-14 w-14 shrink-0 rounded-2xl" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-48" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
              <Skeleton className="h-8 w-20 shrink-0 rounded-lg" />
            </Card>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- mini lists -- */

function SuggestionRow({ icon, title, subtitle, to, verified, verifiedColor }: { icon: ReactNode; title: string; subtitle?: string; to: string; verified?: boolean; verifiedColor?: string }) {
  return (
    <Link to={to} className="flex min-h-[52px] items-center gap-3 rounded-xl px-2.5 py-2 transition-colors hover:bg-surface-2">
      {icon}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 truncate text-sm font-semibold">
          {title}
          {verified && <VerifiedBadge color={verifiedColor} size={13} />}
        </span>
        {subtitle && <span className="block truncate text-xs text-ink-soft">{subtitle}</span>}
      </span>
      <ArrowRight size={15} className="shrink-0 text-ink-faint" aria-hidden />
    </Link>
  );
}

const TAG_LINK =
  "inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink-soft transition-colors hover:border-accent hover:bg-accent-soft hover:text-accent";

/* ------------------------------------------------------------------ page -- */

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const urlTab = params.get("tab");
  const tab: TabKey = isTabKey(urlTab) ? urlTab : "all";

  const [text, setText] = useState(q);
  const debouncedText = useDebounced(text, 350);
  const lastPushed = useRef(q);
  const toast = useToast();
  const navigate = useNavigate();

  const commit = useCallback(
    (mutate: (next: URLSearchParams) => void, replace: boolean) => {
      const next = new URLSearchParams(params);
      mutate(next);
      setParams(next, { replace });
    },
    [params, setParams]
  );

  /* Typing rewrites the URL with replace(); external URL changes (back button, links) win. */
  useEffect(() => {
    if (q !== lastPushed.current) {
      setText(q);
      lastPushed.current = q;
      return;
    }
    const next = debouncedText.trim();
    if (next === lastPushed.current) return;
    lastPushed.current = next;
    commit((p) => {
      if (next) p.set("q", next);
      else p.delete("q");
    }, true);
  }, [debouncedText, q, commit]);

  const selectTab = useCallback(
    (id: TabKey) =>
      commit((p) => {
        if (id === "all") p.delete("tab");
        else p.set("tab", id);
      }, false),
    [commit]
  );

  const runSearch = () => {
    const next = text.trim();
    lastPushed.current = next;
    commit((p) => {
      if (next) p.set("q", next);
      else p.delete("q");
    }, true);
  };

  useEffect(() => {
    document.title = q ? `${q} — Search | Professionalist` : "Search | Professionalist";
  }, [q]);

  const state = useAsync<SearchResults | null>(
    () => (q ? searchApi.global(q, tab === "all" ? undefined : tab) : Promise.resolve(null)),
    [q, tab]
  );

  /* The endpoint answers every content type, so reuse the payload when only the tab changed. */
  const cached = useRef<{ q: string; data: SearchResults } | null>(null);
  useEffect(() => {
    if (state.data) cached.current = { q, data: state.data };
  }, [state.data, q]);
  const results = state.data ?? (cached.current?.q === q ? cached.current.data : null);

  const start = useAsync(() => (q ? Promise.resolve(null) : searchApi.suggestions("")), [q]);

  const counts = useMemo(() => {
    const map: Record<SectionKey, number> = {
      people: 0,
      businesses: 0,
      products: 0,
      services: 0,
      posts: 0,
      opportunities: 0,
    };
    if (!results) return map;
    SECTIONS.forEach((s) => {
      map[s.id] = rowsFor(s.id, results).length;
    });
    return map;
  }, [results]);

  const total = SECTIONS.reduce((sum, s) => sum + counts[s.id], 0);
  const visible = tab === "all" ? SECTIONS.filter((s) => counts[s.id] > 0) : SECTIONS.filter((s) => s.id === tab);
  const visibleCount = tab === "all" ? total : counts[tab as SectionKey] ?? 0;
  const pending = state.loading && !results;
  const activeSection = SECTIONS.find((s) => s.id === tab);
  const ActiveSectionIcon = activeSection?.icon ?? Search;

  const clearRecent = async () => {
    try {
      await searchApi.clearRecent();
      toast.success("Recent searches cleared");
      start.refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="@container space-y-5">
      <h1 className="sr-only">Search Professionalist</h1>

      <div className="card flex items-center gap-2 p-2 transition-colors focus-within:border-accent">
        <div className="relative min-w-0 flex-1">
          <Search size={18} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" aria-hidden />
          <label className="sr-only" htmlFor="page-search">
            Search people, businesses, products, services, posts and opportunities
          </label>
          <input
            id="page-search"
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch();
            }}
            placeholder="Search people, businesses, products, posts…"
            className="h-11 w-full rounded-xl bg-transparent pl-9 pr-10 text-[15px] placeholder:text-ink-faint focus:outline-none"
          />
          {text && (
            <button
              onClick={() => {
                setText("");
                lastPushed.current = "";
                commit((p) => p.delete("q"), true);
              }}
              aria-label="Clear search"
              className="absolute right-0 top-0 flex h-11 w-10 items-center justify-center rounded-xl text-ink-faint transition-colors hover:text-ink"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <Button className="h-11 shrink-0" onClick={runSearch}>
          <Search size={16} aria-hidden /> <span className="hidden sm:inline">Search</span>
        </Button>
      </div>

      {/* ---------------------------------------------- no query: starter -- */}
      {!q && (
        <div className="space-y-4">
          {start.loading && (
            <Card className="space-y-3 p-4">
              <Skeleton className="h-4 w-36" />
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-xl" />
              ))}
            </Card>
          )}

          {start.error && !start.loading && (
            <Card>
              <ErrorState message={errorMessage(start.error)} onRetry={start.refetch} />
            </Card>
          )}

          {start.data && (
            <>
              {start.data.recent.length > 0 && (
                <Card className="p-3">
                  <div className="flex items-center justify-between gap-2 px-1.5 pb-1 pt-2">
                    <h2 className="flex items-center gap-2 text-sm font-bold">
                      <Clock size={15} className="text-ink-faint" aria-hidden /> Recent searches
                    </h2>
                    <Button variant="ghost" size="sm" className="min-h-10" onClick={() => void clearRecent()}>
                      <Trash2 size={14} aria-hidden /> Clear recents
                    </Button>
                  </div>
                  <div className="grid gap-0.5 @xl:grid-cols-2">
                    {start.data.recent.map((r) => (
                      <SuggestionRow
                        key={r}
                        icon={<Clock size={15} className="shrink-0 text-ink-faint" aria-hidden />}
                        title={r}
                        subtitle="Search everything again"
                        to={`/search?q=${encodeURIComponent(r)}`}
                      />
                    ))}
                  </div>
                </Card>
              )}

              {start.data.people.length > 0 && (
                <Card className="p-3">
                  <h2 className="px-1.5 pb-1 pt-2 text-sm font-bold">People</h2>
                  <div className="grid gap-0.5 @xl:grid-cols-2">
                    {start.data.people.map((p) => (
                      <SuggestionRow
                        key={p.id}
                        icon={<Avatar name={fullName(p)} src={p.avatarUrl} size="sm" />}
                        title={fullName(p)}
                        subtitle={p.title}
                        verified={p.verified}
                        verifiedColor={p.verifiedColor}
                        to={`/profile/${p.username}`}
                      />
                    ))}
                  </div>
                </Card>
              )}

              {start.data.businesses.length > 0 && (
                <Card className="p-3">
                  <h2 className="px-1.5 pb-1 pt-2 text-sm font-bold">Businesses</h2>
                  <div className="grid gap-0.5 @xl:grid-cols-2">
                    {start.data.businesses.map((b) => (
                      <SuggestionRow
                        key={b.id}
                        icon={<Avatar name={b.name} src={b.logoUrl} size="sm" />}
                        title={b.name}
                        subtitle={b.industry}
                        verified={b.verified}
                        to={`/business/${b.slug}`}
                      />
                    ))}
                  </div>
                </Card>
              )}

              <Card className="p-4">
                <h2 className="flex items-center gap-2 text-sm font-bold">
                  <Hash size={15} className="text-accent" aria-hidden /> Trending on Professionalist
                </h2>
                {start.data.hashtags.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {start.data.hashtags.map((h) => {
                      const tag = h.replace(/^#/, "");
                      return (
                        <Link key={h} to={`/search?q=${encodeURIComponent(tag)}`} className={TAG_LINK}>
                          #{tag}
                        </Link>
                      );
                    })}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-ink-soft">No trending topics right now.</p>
                )}
                {start.data.recent.length === 0 && start.data.people.length === 0 && start.data.businesses.length === 0 && (
                  <p className="mt-4 text-sm text-ink-soft">
                    Nothing searched yet. Type above to search people, businesses, products, services, posts and opportunities in one go.
                  </p>
                )}
              </Card>
            </>
          )}
        </div>
      )}

      {/* -------------------------------------------------- query present -- */}
      {q && (
        <>
          <Card className="px-2 py-1">
            <Tabs
              items={[
                { id: "all", label: "All", count: pending ? undefined : total },
                ...SECTIONS.map((s) => ({ id: s.id as string, label: s.label, count: !pending && counts[s.id] > 0 ? counts[s.id] : undefined })),
              ]}
              value={tab}
              onChange={(id) => selectTab(id as TabKey)}
            />
          </Card>

          <div className="flex flex-wrap items-end justify-between gap-3" aria-live="polite">
            <div className="min-w-0">
              <h2 className="text-lg font-extrabold tracking-tight sm:text-xl">
                {pending ? "Searching…" : `${formatNumber(visibleCount)} ${visibleCount === 1 ? "result" : "results"}`}
              </h2>
              <p className="mt-0.5 truncate text-sm text-ink-soft">
                for <span className="font-semibold text-ink">“{q}”</span>
                {activeSection && (
                  <>
                    {" "}
                    in <span className="font-semibold text-ink">{activeSection.label}</span>
                  </>
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => navigate("/marketplace")}>
                <Store size={15} aria-hidden /> Marketplace
              </Button>
              <Button variant="soft" onClick={() => navigate("/discover")}>
                <Compass size={15} aria-hidden /> Discover
              </Button>
            </div>
          </div>

          {pending && (
            <div className="space-y-7">
              {(tab === "all" ? SECTIONS.slice(0, 3) : SECTIONS.filter((s) => s.id === tab)).map((s) => (
                <SectionSkeleton key={s.id} section={s} count={s.grid === LISTING_GRID ? 4 : s.preview} />
              ))}
            </div>
          )}

          {state.error && !state.loading && (
            <Card>
              <ErrorState message={errorMessage(state.error)} onRetry={state.refetch} />
            </Card>
          )}

          {results && !state.loading && total === 0 && (
            <Card>
              <EmptyState
                icon={<Search />}
                title={`No results for “${q}”`}
                description="Check the spelling, use fewer or broader words, or try another tab — products and services are indexed separately from people."
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button variant="outline" onClick={() => selectTab("products")}>
                      <Store size={16} aria-hidden /> Search products
                    </Button>
                    <Button variant="outline" onClick={() => selectTab("services")}>
                      <Briefcase size={16} aria-hidden /> Search services
                    </Button>
                    <Button onClick={() => navigate("/marketplace")}>
                      <Compass size={16} aria-hidden /> Open marketplace
                    </Button>
                  </div>
                }
              />
            </Card>
          )}

          {results && !state.loading && total > 0 && visibleCount === 0 && (
            <Card>
              <EmptyState
                icon={<ActiveSectionIcon />}
                title={`Nothing in ${activeSection?.label ?? "this tab"}`}
                description={`“${q}” matched other content types — ${total} result${total === 1 ? "" : "s"} across the rest.`}
                action={
                  <Button variant="outline" onClick={() => selectTab("all")}>
                    Show all results <ArrowRight size={16} aria-hidden />
                  </Button>
                }
              />
            </Card>
          )}

          {results && !state.loading && visibleCount > 0 && (
            <div className="space-y-7">
              {visible.map((s) => (
                <SearchSection key={s.id} section={s} rows={rowsFor(s.id, results)} compact={tab === "all"} onOpenTab={() => selectTab(s.id)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- sections -- */

function SearchSection({
  section,
  rows,
  compact,
  onOpenTab,
}: {
  section: SectionDef;
  rows: Row[];
  compact: boolean;
  onOpenTab: () => void;
}) {
  const shown = compact ? rows.slice(0, section.preview) : rows;
  const Icon = section.icon;

  return (
    <section aria-label={`${section.label} results`} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-line pb-2">
        <h2 className="flex items-center gap-2 text-base font-bold sm:text-lg">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent" aria-hidden>
            <Icon size={15} />
          </span>
          {section.label}
          <span className="text-xs font-semibold text-ink-faint">{formatNumber(rows.length)}</span>
        </h2>
        {compact && rows.length > shown.length && (
          <Button variant="ghost" size="sm" className="min-h-10" onClick={onOpenTab}>
            Show more in {section.label} <ArrowRight size={15} aria-hidden />
          </Button>
        )}
      </div>

      <div className={section.grid}>
        {shown.map((row) => {
          if (section.id === "people") return <PersonCard key={row.id} person={row as Person} />;
          if (section.id === "businesses") return <BusinessCard key={row.id} business={row as Business} />;
          if (section.id === "products" || section.id === "services") return <ListingCard key={row.id} listing={row as Listing} />;
          if (section.id === "posts") return <PostCard key={row.id} post={row as Post} />;
          return <OpportunityCard key={row.id} opportunity={row as Opportunity} />;
        })}
      </div>
    </section>
  );
}
