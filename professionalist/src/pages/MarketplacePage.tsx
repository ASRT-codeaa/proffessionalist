import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Building2,
  Briefcase,
  Clock,
  Cpu,
  Flame,
  GraduationCap,
  HardHat,
  Laptop,
  MapPin,
  Package,
  Scale,
  Search,
  Shirt,
  SlidersHorizontal,
  Sprout,
  Star,
  Store,
  Tag,
  Truck,
  Users,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ListingCard } from "@/components/cards";
import {
  Button,
  Card,
  Chip,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  SegmentedControl,
  Select,
  Skeleton,
  SkeletonCard,
} from "@/components/ui";
import { useToast } from "@/context/ToastContext";
import { errorMessage, useAsync, useDebounced } from "@/hooks/useAsync";
import { marketplaceApi } from "@/services/api";
import type { Category, Listing, MarketplaceFilters, Paginated } from "@/services/types";
import { cn } from "@/lib/utils";

/* ------------------------------ category icons ------------------------------ */

const ICONS_BY_NAME: Record<string, LucideIcon> = {
  Package,
  Laptop,
  Shirt,
  GraduationCap,
  Briefcase,
  Scale,
  Cpu,
  HardHat,
  Sprout,
  Truck,
  Building2,
  Users,
  Tag,
  Store,
};

const ICONS_BY_SLUG: Record<string, LucideIcon> = {
  electronics: Laptop,
  clothing: Shirt,
  education: GraduationCap,
  "business-services": Briefcase,
  "professional-services": Scale,
  technology: Cpu,
  construction: HardHat,
  agriculture: Sprout,
  transport: Truck,
  "real-estate": Building2,
  jobs: Users,
  other: Tag,
};

/** Renders the lucide icon a category asks for, falling back to its slug, then to a box. */
export function CategoryIcon({
  category,
  size = 16,
  className,
}: {
  category?: Pick<Category, "icon" | "slug" | "name"> | null;
  size?: number;
  className?: string;
}) {
  const Icon = category ? (ICONS_BY_NAME[category.icon] ?? ICONS_BY_SLUG[category.slug] ?? Package) : Package;
  return <Icon size={size} className={className} aria-hidden />;
}

/* --------------------------------- constants -------------------------------- */

type SectionKey = NonNullable<MarketplaceFilters["section"]>;

const SECTIONS: { key: SectionKey; title: string; blurb: string; icon: LucideIcon }[] = [
  { key: "featured", title: "Featured", blurb: "The most-seen listings this week", icon: Star },
  { key: "recommended", title: "Recommended for you", blurb: "Based on what professionals like you browse", icon: Clock },
  { key: "nearby", title: "Near you", blurb: "Close enough to inspect in person", icon: MapPin },
  { key: "new", title: "Just listed", blurb: "Fresh on the marketplace", icon: Package },
  { key: "popular", title: "Popular", blurb: "Saved the most by members", icon: Flame },
];

const CONDITION_OPTIONS = [
  { value: "new", label: "New" },
  { value: "like_new", label: "Like new" },
  { value: "used", label: "Used" },
  { value: "n/a", label: "Not applicable" },
];

const SORT_OPTIONS = [
  { value: "recent", label: "Recent" },
  { value: "price_asc", label: "Price low" },
  { value: "price_desc", label: "Price high" },
  { value: "popular", label: "Popular" },
];

const KIND_OPTIONS = [
  { value: "", label: "All" },
  { value: "product", label: "Products" },
  { value: "service", label: "Services" },
];

const PAGE_SIZE = 12;

/** Every filter lives in the URL so a result set is shareable. */
interface FilterValues {
  q: string;
  categoryId: string;
  kind: string;
  minPrice: string;
  maxPrice: string;
  condition: string;
  location: string;
  sort: string;
  section: string;
}

function readFilters(params: URLSearchParams): FilterValues {
  return {
    q: params.get("q") ?? "",
    categoryId: params.get("categoryId") ?? "",
    kind: params.get("kind") ?? "",
    minPrice: params.get("minPrice") ?? "",
    maxPrice: params.get("maxPrice") ?? "",
    condition: params.get("condition") ?? "",
    location: params.get("location") ?? "",
    sort: params.get("sort") ?? "",
    section: params.get("section") ?? "",
  };
}

function toApiFilters(v: FilterValues): MarketplaceFilters {
  const num = (s: string) => {
    const n = Number(s);
    return s.trim() !== "" && Number.isFinite(n) ? n : undefined;
  };
  return {
    q: v.q.trim() || undefined,
    categoryId: num(v.categoryId),
    kind: v.kind || undefined,
    minPrice: num(v.minPrice),
    maxPrice: num(v.maxPrice),
    condition: v.condition || undefined,
    location: v.location.trim() || undefined,
    sort: (v.sort || undefined) as MarketplaceFilters["sort"],
    section: (v.section || undefined) as MarketplaceFilters["section"],
  };
}

/* ----------------------------------- page ----------------------------------- */

export default function MarketplacePage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const apiFilters = useMemo(() => toApiFilters(filters), [filters.q, filters.categoryId, filters.kind, filters.minPrice, filters.maxPrice, filters.condition, filters.location, filters.sort, filters.section]);
  const apiFilterKey = JSON.stringify(apiFilters);

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

  /* search: local text -> debounced URL write; URL -> text when the change came from elsewhere */
  const [qText, setQText] = useState(filters.q);
  const debouncedQ = useDebounced(qText, 400);
  const skipNextUrlSync = useRef(false);

  useEffect(() => {
    if (debouncedQ === filters.q) return;
    skipNextUrlSync.current = true;
    patchParams({ q: debouncedQ.trim() || null });
  }, [debouncedQ, filters.q, patchParams]);

  useEffect(() => {
    if (skipNextUrlSync.current) {
      skipNextUrlSync.current = false;
      return;
    }
    setQText(filters.q);
    // Only meaningful when the URL itself changes (back/forward, clear filters).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.q]);

  /* home rails */
  const home = useAsync(() => marketplaceApi.home(), []);
  const categories = home.data?.categories ?? [];

  /* browse results — page 1 from useAsync, further pages accumulated on demand */
  const first = useAsync(() => marketplaceApi.listings({ ...apiFilters, page: 1, pageSize: PAGE_SIZE }), [apiFilterKey]);
  const [extraPages, setExtraPages] = useState<Paginated<Listing>[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setExtraPages([]);
  }, [apiFilterKey]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const next = await marketplaceApi.listings({ ...apiFilters, page: extraPages.length + 2, pageSize: PAGE_SIZE });
      setExtraPages((prev) => [...prev, next]);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const results = useMemo(() => {
    const seen = new Set<number>();
    const out: Listing[] = [];
    for (const l of [...(first.data?.items ?? []), ...extraPages.flatMap((p) => p.items)]) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      out.push(l);
    }
    return out;
  }, [first.data, extraPages]);

  const lastPage = extraPages[extraPages.length - 1] ?? first.data;
  const hasMore = lastPage?.hasMore ?? false;
  const total = first.data?.total ?? 0;

  const activeCount = countActiveFilters(filters);
  const sectionActive = Boolean(filters.section);
  const showRails = activeCount === 0 && !sectionActive;
  const activeSection = SECTIONS.find((s) => s.key === filters.section);

  const browseRef = useRef<HTMLElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const showAll = (key: SectionKey) => {
    patchParams({ section: key, categoryId: filters.categoryId || null });
    window.requestAnimationFrame(() => browseRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const clearAll = () => {
    setQText("");
    skipNextUrlSync.current = true;
    patchParams({ q: null, categoryId: null, kind: null, minPrice: null, maxPrice: null, condition: null, location: null, sort: null, section: null });
    setFiltersOpen(false);
  };

  const pickCategory = (id: string) => {
    patchParams({ categoryId: id, section: null });
  };

  return (
    <div className="w-full space-y-5 px-3 pb-2 sm:px-0 anim-fade-up">
      {/* -------------------------------- header -------------------------------- */}
      <header className="flex flex-wrap items-start justify-between gap-3 pt-1">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-extrabold sm:text-2xl">
            <Store size={22} className="text-accent" aria-hidden />
            Marketplace
          </h1>
          <p className="mt-1 text-sm text-ink-soft">Buy, sell and hire from verified professionals nearby.</p>
        </div>
        <Button onClick={() => navigate("/create-listing")} className="shrink-0">
          <Package size={16} aria-hidden />
          Create listing
        </Button>
      </header>

      {/* -------------------------------- search -------------------------------- */}
      <div className="space-y-3">
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            patchParams({ q: qText.trim() || null, section: null });
          }}
          className="relative"
        >
          <label htmlFor="mp-search" className="sr-only">
            Search listings
          </label>
          <Input
            id="mp-search"
            icon={<Search size={16} aria-hidden />}
            value={qText}
            onChange={(e) => setQText(e.target.value)}
            placeholder="Search products, services, tags…"
            autoComplete="off"
            className="h-12 rounded-2xl pl-10 pr-10 text-[15px]"
          />
          {qText && (
            <button
              type="button"
              onClick={() => setQText("")}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X size={16} />
            </button>
          )}
        </form>

        {/* category chip rail */}
        <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 hide-scrollbar sm:mx-0 sm:px-0" role="group" aria-label="Browse by category">
          {home.loading &&
            Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-9 w-28 shrink-0 rounded-full" />)}
          {home.data && (
            <>
              <Chip active={!filters.categoryId} onClick={() => pickCategory("")}>
                All categories
              </Chip>
              {categories.map((c) => (
                <Chip key={c.id} active={filters.categoryId === String(c.id)} onClick={() => pickCategory(String(c.id))}>
                  <CategoryIcon category={c} size={14} />
                  {c.name}
                  <span className="text-[11px] font-normal opacity-70">{c.count}</span>
                </Chip>
              ))}
            </>
          )}
        </div>
      </div>

      {/* ------------------------------ home rails ------------------------------ */}
      {home.error && !home.loading && (
        <Card>
          <ErrorState message={errorMessage(home.error)} onRetry={home.refetch} />
        </Card>
      )}

      {showRails && (
        <div className="space-y-6">
          {home.loading && <RailSkeleton title="Featured" />}
          {home.data &&
            SECTIONS.map((section) => (
              <Rail key={section.key} section={section} listings={home.data?.[section.key] ?? []} loading={home.loading} onSeeAll={() => showAll(section.key)} />
            ))}
        </div>
      )}

      {/* -------------------------------- browse -------------------------------- */}
      <section aria-labelledby="browse-heading" ref={browseRef} className="scroll-mt-20 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 id="browse-heading" className="text-lg font-bold">
              {activeSection ? activeSection.title : filters.q ? `Results for “${filters.q}”` : "Browse all listings"}
            </h2>
            <p className="text-xs text-ink-soft">
              {first.loading ? "Loading…" : `${total} ${total === 1 ? "listing" : "listings"}${filters.location ? ` near ${filters.location}` : ""}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="lg:hidden" onClick={() => setFiltersOpen(true)}>
              <SlidersHorizontal size={15} aria-hidden />
              Filters
              {activeCount > 0 && (
                <span className="ml-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[11px] font-bold text-accent-ink">
                  {activeCount}
                </span>
              )}
            </Button>
            <div className="hidden max-w-full overflow-x-auto hide-scrollbar lg:block">
              <SegmentedControl
                options={SORT_OPTIONS}
                value={filters.sort || "recent"}
                onChange={(v) => patchParams({ sort: v === "recent" ? null : v })}
              />
            </div>
          </div>
        </div>

        {activeCount > 0 && (
          <ActiveFilterPills filters={filters} categories={categories} patchParams={patchParams} clearAll={clearAll} />
        )}

        {sectionActive && (
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-accent-soft px-4 py-2.5 text-sm text-accent">
            <span className="min-w-0 truncate font-semibold">Showing the {activeSection?.title ?? "selected"} rail in the full grid.</span>
            <button onClick={() => patchParams({ section: null })} className="shrink-0 text-[13px] font-bold underline">
              Exit
            </button>
          </div>
        )}

        {/* desktop inline filters — sticky so they stay reachable while scrolling results */}
        <div className="hidden lg:sticky lg:top-20 lg:z-20 lg:block">
          <Card className="p-3">
            <FilterPanel filters={filters} categories={categories} patchParams={patchParams} layout="bar" />
          </Card>
        </div>

        {first.loading && (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-2 sm:gap-3 md:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <SkeletonCard key={i} height="h-28 sm:h-36" />
            ))}
          </div>
        )}

        {first.error && !first.loading && (
          <Card>
            <ErrorState message={errorMessage(first.error)} onRetry={first.refetch} />
          </Card>
        )}

        {!first.loading && !first.error && results.length === 0 && (
          <Card>
            <EmptyState
              icon={<Search />}
              title="No listings match those filters"
              description={filters.q ? `Nothing found for “${filters.q}”. Try a broader search or clear a filter or two.` : "Try widening the price range, or browse a different category."}
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="outline" onClick={clearAll}>
                    Clear filters
                  </Button>
                  <Button onClick={() => navigate("/create-listing")}>Create a listing</Button>
                </div>
              }
            />
          </Card>
        )}

        {!first.loading && results.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-2 sm:gap-3 md:grid-cols-3 xl:grid-cols-4">
              {results.map((l) => (
                <ListingCard key={l.id} listing={l} />
              ))}
            </div>
            <div className="flex flex-col items-center gap-2 pt-2">
              {hasMore ? (
                <Button variant="outline" onClick={() => void loadMore()} loading={loadingMore}>
                  Load more listings
                </Button>
              ) : (
                <p className="text-xs text-ink-faint">You’ve seen {results.length} of {total} listings — that’s everything.</p>
              )}
              <p className="text-[11px] text-ink-faint">{results.length} shown</p>
            </div>
          </>
        )}
      </section>

      {/* ------------------------------ mobile sheet ----------------------------- */}
      <Drawer open={filtersOpen} onClose={() => setFiltersOpen(false)} label="Filter listings" side="right" width="max-w-md">
        <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
          <h2 className="text-base font-bold">Filters</h2>
          <button
            onClick={() => setFiltersOpen(false)}
            aria-label="Close filters"
            className="grid h-10 w-10 place-items-center rounded-xl text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <FilterPanel filters={filters} categories={categories} patchParams={patchParams} layout="sheet" />
          <div className="mt-5">
            <p className="mb-1.5 block text-[13px] font-semibold">Sort by</p>
            <div className="flex flex-wrap gap-2">
              {SORT_OPTIONS.map((o) => (
                <Chip key={o.value} active={(filters.sort || "recent") === o.value} onClick={() => patchParams({ sort: o.value === "recent" ? null : o.value })}>
                  {o.label}
                </Chip>
              ))}
            </div>
          </div>
        </div>
        <div className="flex gap-2 border-t border-line px-4 py-3 safe-bottom">
          <Button variant="outline" className="flex-1" onClick={clearAll}>
            Clear all
          </Button>
          <Button className="flex-[2]" onClick={() => setFiltersOpen(false)}>
            {first.data ? `Show ${total} ${total === 1 ? "result" : "results"}` : "Show results"}
          </Button>
        </div>
      </Drawer>
    </div>
  );
}

/* ------------------------------- sub-components ------------------------------ */

function countActiveFilters(f: FilterValues): number {
  return [f.q, f.categoryId, f.kind, f.minPrice, f.maxPrice, f.condition, f.location, f.section].filter(Boolean).length;
}

function ActiveFilterPills({
  filters,
  categories,
  patchParams,
  clearAll,
}: {
  filters: FilterValues;
  categories: Category[];
  patchParams: (c: Record<string, string | null>) => void;
  clearAll: () => void;
}) {
  const category = categories.find((c) => String(c.id) === filters.categoryId);
  const pills: { key: string; label: string }[] = [];
  if (filters.q) pills.push({ key: "q", label: `“${filters.q}”` });
  if (filters.categoryId) pills.push({ key: "categoryId", label: category?.name ?? "Category" });
  if (filters.kind) pills.push({ key: "kind", label: filters.kind === "product" ? "Products" : "Services" });
  if (filters.minPrice) pills.push({ key: "minPrice", label: `Min ${filters.minPrice}` });
  if (filters.maxPrice) pills.push({ key: "maxPrice", label: `Max ${filters.maxPrice}` });
  if (filters.condition) pills.push({ key: "condition", label: CONDITION_OPTIONS.find((c) => c.value === filters.condition)?.label ?? filters.condition });
  if (filters.location) pills.push({ key: "location", label: `Near ${filters.location}` });
  if (filters.section) pills.push({ key: "section", label: SECTIONS.find((s) => s.key === filters.section)?.title ?? "Section" });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {pills.map((p) => (
        <span key={p.key} className="anim-scale-in inline-flex items-center gap-1.5 rounded-full bg-surface-2 py-1 pl-3 pr-1.5 text-[13px] font-semibold text-ink-soft">
          {p.label}
          <button
            onClick={() => patchParams({ [p.key]: null })}
            aria-label={`Remove filter ${p.label}`}
            className="relative grid h-6 w-6 place-items-center rounded-full text-ink-faint transition-colors hover:bg-surface hover:text-danger before:absolute before:-inset-2 before:content-['']"
          >
            <X size={13} />
          </button>
        </span>
      ))}
      <button onClick={clearAll} className="text-[13px] font-bold text-accent hover:underline">
        Clear all
      </button>
    </div>
  );
}

function FilterPanel({
  filters,
  categories,
  patchParams,
  layout,
}: {
  filters: FilterValues;
  categories: Category[];
  patchParams: (c: Record<string, string | null>) => void;
  layout: "bar" | "sheet";
}) {
  const [minPrice, setMinPrice] = useState(filters.minPrice);
  const [maxPrice, setMaxPrice] = useState(filters.maxPrice);
  const [location, setLocation] = useState(filters.location);

  useEffect(() => setMinPrice(filters.minPrice), [filters.minPrice]);
  useEffect(() => setMaxPrice(filters.maxPrice), [filters.maxPrice]);
  useEffect(() => setLocation(filters.location), [filters.location]);

  const priceInvalid = Boolean(minPrice && maxPrice && Number(minPrice) > Number(maxPrice));
  const commit = () => {
    if (priceInvalid) return;
    patchParams({ minPrice: minPrice.trim() || null, maxPrice: maxPrice.trim() || null, location: location.trim() || null });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
      className={cn("grid gap-3", layout === "bar" ? "grid-cols-2 xl:grid-cols-5" : "grid-cols-1")}
    >
      <Select
        label="Category"
        placeholder="All categories"
        value={filters.categoryId}
        onChange={(e) => patchParams({ categoryId: e.target.value || null, section: null })}
        options={categories.map((c) => ({ value: String(c.id), label: `${c.name} (${c.count})` }))}
      />

      <div>
        <span className="mb-1.5 block text-[13px] font-semibold">Type</span>
        <div className="flex h-10 items-center">
          <SegmentedControl
            options={KIND_OPTIONS}
            value={filters.kind}
            onChange={(v) => patchParams({ kind: v || null })}
            className={layout === "sheet" ? "w-full justify-between" : ""}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Input
          label="Min price"
          type="number"
          min={0}
          inputMode="decimal"
          placeholder="0"
          value={minPrice}
          onChange={(e) => setMinPrice(e.target.value)}
          onBlur={commit}
          error={priceInvalid && minPrice ? "Min above max" : undefined}
        />
        <Input
          label="Max price"
          type="number"
          min={0}
          inputMode="decimal"
          placeholder="Any"
          value={maxPrice}
          onChange={(e) => setMaxPrice(e.target.value)}
          onBlur={commit}
          error={priceInvalid && maxPrice ? "Max below min" : undefined}
        />
      </div>

      <Select
        label="Condition"
        placeholder="Any condition"
        value={filters.condition}
        onChange={(e) => patchParams({ condition: e.target.value || null })}
        options={CONDITION_OPTIONS}
      />

      <Input
        label="Location"
        icon={<MapPin size={15} aria-hidden />}
        placeholder="Lagos, Nairobi…"
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        onBlur={commit}
        hint={layout === "sheet" ? "Matches the seller’s city." : undefined}
      />

      {layout === "sheet" && (
        <Button type="submit" fullWidth>
          Apply price & location
        </Button>
      )}
    </form>
  );
}

function Rail({
  section,
  listings,
  loading,
  onSeeAll,
}: {
  section: { title: string; blurb: string; icon: LucideIcon };
  listings: Listing[];
  loading: boolean;
  onSeeAll: () => void;
}) {
  if (!loading && listings.length === 0) return null;
  const Icon = section.icon;
  return (
    <section aria-label={section.title} className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-bold sm:text-lg">
            <Icon size={17} className="text-accent" aria-hidden />
            {section.title}
          </h2>
          <p className="truncate text-xs text-ink-soft">{section.blurb}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onSeeAll} className="shrink-0">
          See all
        </Button>
      </div>

      {loading ? (
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="w-[220px] shrink-0 sm:w-[250px]">
              <SkeletonCard height="h-32" />
            </div>
          ))}
        </div>
      ) : (
        <ul
          className={cn(
            "-mx-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-3 pb-1 hide-scrollbar",
            "md:mx-0 md:grid md:grid-cols-3 md:overflow-visible md:px-0 xl:grid-cols-4"
          )}
        >
          {listings.map((l) => (
            <li key={l.id} className="w-[220px] shrink-0 snap-start sm:w-[250px] md:w-auto md:shrink">
              <ListingCard listing={l} className="h-full" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RailSkeleton({ title }: { title: string }) {
  return (
    <section aria-label={`${title} loading`} className="space-y-3" aria-busy>
      <Skeleton className="h-5 w-40" />
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="w-[220px] shrink-0 sm:w-[250px]">
            <SkeletonCard height="h-32" />
          </div>
        ))}
      </div>
    </section>
  );
}
