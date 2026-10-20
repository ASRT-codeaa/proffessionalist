import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Briefcase,
  Building2,
  Compass,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Newspaper,
  Store,
  Users,
  X,
} from "lucide-react";
import { BusinessCard, ListingCard, OpportunityCard, PersonCard } from "@/components/cards";
import { PostCard, PostCardSkeleton } from "@/components/PostCard";
import {
  Button,
  Card,
  Chip,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  Select,
  Skeleton,
  SkeletonCard,
  Switch,
  Tabs,
} from "@/components/ui";
import { errorMessage, useAsync, useDebounced } from "@/hooks/useAsync";
import { marketplaceApi, metaApi, networkApi, opportunitiesApi, postsApi, searchApi } from "@/services/api";
import type { Business, ConnectionFilters, FeedFilters, Listing, MarketplaceFilters, Opportunity, Person, Post } from "@/services/types";
import { fullName, plural } from "@/lib/utils";

/* ------------------------------------------------------------------ model -- */

const TABS = [
  { id: "people", label: "People", noun: "people", one: "person", icon: Users },
  { id: "businesses", label: "Businesses", noun: "businesses", one: "business", icon: Building2 },
  { id: "products", label: "Products", noun: "products", one: "product", icon: Store },
  { id: "services", label: "Services", noun: "services", one: "service", icon: Briefcase },
  { id: "posts", label: "Posts", noun: "posts", one: "post", icon: Newspaper },
  { id: "opportunities", label: "Opportunities", noun: "opportunities", one: "opportunity", icon: Compass },
] as const;

type TabKey = (typeof TABS)[number]["id"];
const TAB_KEYS: readonly string[] = TABS.map((t) => t.id);

/** Which URL params belong to which tab — switching tabs drops the irrelevant ones so a shared link always makes sense. */
const TAB_PARAMS: Record<TabKey, string[]> = {
  people: ["industry", "profession", "location", "skill"],
  businesses: ["industry", "category", "location"],
  products: ["categoryId", "minPrice", "maxPrice", "condition", "location", "sort"],
  services: ["categoryId", "minPrice", "maxPrice", "condition", "location", "sort"],
  posts: ["postKind", "sort"],
  opportunities: ["opKind", "location", "remote"],
};

const PAGE_SIZE = 12;
const PEOPLE_GRID = "grid gap-3 grid-cols-1 @lg:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-4";
const BUSINESS_GRID = "grid gap-3 grid-cols-1 @md:grid-cols-2 @4xl:grid-cols-3";
const LISTING_GRID = "grid gap-3 grid-cols-2 @md:grid-cols-3 @4xl:grid-cols-4 @6xl:grid-cols-5";

const CONDITIONS = [
  { value: "new", label: "New" },
  { value: "like_new", label: "Like new" },
  { value: "used", label: "Used" },
];

const LISTING_SORTS = [
  { value: "recent", label: "Most recent" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "popular", label: "Most popular" },
];

const FEED_SORTS = [
  { value: "recent", label: "Most recent" },
  { value: "popular", label: "Most popular" },
];

const OPPORTUNITY_KINDS = [
  { value: "job", label: "Job" },
  { value: "freelance", label: "Freelance" },
  { value: "partnership", label: "Partnership" },
  { value: "business", label: "Business for sale" },
  { value: "event", label: "Event" },
  { value: "project", label: "Project" },
];

const POST_KINDS = [
  { value: "post", label: "Updates" },
  { value: "article", label: "Articles" },
  { value: "job", label: "Hiring posts" },
  { value: "product", label: "Product posts" },
  { value: "service", label: "Service posts" },
];

type FilterValues = {
  industry: string;
  profession: string;
  skill: string;
  category: string;
  categoryId: string;
  location: string;
  minPrice: string;
  maxPrice: string;
  condition: string;
  sort: string;
  postKind: string;
  opKind: string;
  remote: string;
};

const EMPTY_FILTERS: FilterValues = {
  industry: "",
  profession: "",
  skill: "",
  category: "",
  categoryId: "",
  location: "",
  minPrice: "",
  maxPrice: "",
  condition: "",
  sort: "",
  postKind: "",
  opKind: "",
  remote: "",
};

type Results =
  | { kind: "people"; items: Person[]; total: number; hasMore: boolean }
  | { kind: "businesses"; items: Business[]; all: Business[]; total: number; hasMore: boolean }
  | { kind: "listings"; items: Listing[]; total: number; hasMore: boolean }
  | { kind: "posts"; items: Post[]; total: number; hasMore: boolean }
  | { kind: "opportunities"; items: Opportunity[]; total: number; hasMore: boolean };

function isTabKey(value: string | null): value is TabKey {
  return value !== null && TAB_KEYS.includes(value);
}

function tabConfig(tab: TabKey) {
  return TABS.find((t) => t.id === tab) ?? TABS[0];
}

/* ----------------------------------------------------------- match helpers -- */

const norm = (v: string) => v.trim().toLowerCase();

function personMatches(p: Person, q: string, f: ConnectionFilters): boolean {
  const needle = norm(q);
  if (needle && ![fullName(p), p.title, p.company, p.location, p.category, ...p.skills].join(" ").toLowerCase().includes(needle)) return false;
  const industry = norm(f.industry ?? "");
  if (industry && !p.category.toLowerCase().includes(industry)) return false;
  const profession = norm(f.profession ?? "");
  if (profession && !p.title.toLowerCase().includes(profession)) return false;
  const location = norm(f.location ?? "");
  if (location && !p.location.toLowerCase().includes(location)) return false;
  const skill = norm(f.skill ?? "");
  if (skill && !p.skills.some((s) => s.toLowerCase().includes(skill))) return false;
  return true;
}

function businessMatches(b: Business, f: FilterValues): boolean {
  if (f.industry && b.industry.toLowerCase() !== f.industry.toLowerCase()) return false;
  if (f.category && b.category.toLowerCase() !== f.category.toLowerCase()) return false;
  if (f.location && !b.location.toLowerCase().includes(f.location.toLowerCase())) return false;
  return true;
}

function postMatches(p: Post, q: string): boolean {
  const needle = norm(q);
  if (!needle) return true;
  const author = p.authorType === "business" ? (p.author as Business).name : fullName(p.author as Person);
  return [p.text, author, p.hashtags.join(" "), p.location].join(" ").toLowerCase().includes(needle);
}

/** Facets are read off the unfiltered business results because `searchApi.global` is the only business source available. */
function facetsFrom(rows: Business[], pick: (b: Business) => string): { value: string; label: string }[] {
  const set = new Map<string, string>();
  rows.forEach((r) => {
    const v = pick(r);
    if (v) set.set(v.toLowerCase(), v);
  });
  return [...set.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
}

/** Decides between the inline filter panel and the mobile filter sheet (the Drawer renders through a portal). */
function useIsWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", onChange);
    setWide(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}

/* -------------------------------------------------------------- skeletons -- */

function PersonGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className={PEOPLE_GRID} aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} className="flex flex-col items-center p-4">
          <Skeleton className="h-20 w-20 rounded-full" />
          <Skeleton className="mt-3 h-3.5 w-32" />
          <Skeleton className="mt-2 h-3 w-40" />
          <Skeleton className="mt-1.5 h-3 w-24" />
          <div className="mt-3.5 grid w-full grid-cols-2 gap-2">
            <Skeleton className="h-8 rounded-lg" />
            <Skeleton className="h-8 rounded-lg" />
          </div>
        </Card>
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
            <Skeleton className="-mt-10 h-14 w-14 rounded-2xl" />
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-9 rounded-xl" />
          </div>
        </Card>
      ))}
    </div>
  );
}

function ListingGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className={LISTING_GRID} aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} height="h-32" />
      ))}
    </div>
  );
}

function StackSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-3" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} className="flex gap-3 p-4">
          <Skeleton className="h-14 w-14 shrink-0 rounded-2xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="h-8 w-20 shrink-0 rounded-lg" />
        </Card>
      ))}
    </div>
  );
}

function ResultsSkeleton({ tab }: { tab: TabKey }) {
  if (tab === "people") return <PersonGridSkeleton count={6} />;
  if (tab === "businesses") return <BusinessGridSkeleton count={3} />;
  if (tab === "products" || tab === "services") return <ListingGridSkeleton count={8} />;
  if (tab === "posts")
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4" aria-busy="true">
        {Array.from({ length: 3 }).map((_, i) => (
          <PostCardSkeleton key={i} />
        ))}
      </div>
    );
  return <StackSkeleton count={4} />;
}

/* -------------------------------------------------------------- filter UI -- */

function FilterFields({
  tab,
  value,
  set,
  businessIndustries,
  businessCategories,
  categories,
  industryOptions,
}: {
  tab: TabKey;
  value: FilterValues;
  set: (key: keyof FilterValues, next: string) => void;
  businessIndustries: { value: string; label: string }[];
  businessCategories: { value: string; label: string }[];
  categories: { value: string; label: string }[];
  industryOptions: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-3">
      {tab === "people" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Industry"
            placeholder="Any industry"
            value={value.industry}
            options={industryOptions}
            onChange={(e) => set("industry", e.target.value)}
          />
          <Input label="Profession or title" placeholder="e.g. Data scientist" value={value.profession} onChange={(e) => set("profession", e.target.value)} />
          <Input label="Location" placeholder="e.g. Nairobi" value={value.location} onChange={(e) => set("location", e.target.value)} />
          <Input label="Skill" placeholder="e.g. React" value={value.skill} onChange={(e) => set("skill", e.target.value)} />
        </div>
      )}

      {tab === "businesses" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Industry"
            placeholder="Any industry"
            value={value.industry}
            options={businessIndustries.length ? businessIndustries : industryOptions}
            onChange={(e) => set("industry", e.target.value)}
          />
          <Select label="Category" placeholder="Any category" value={value.category} options={businessCategories} onChange={(e) => set("category", e.target.value)} />
          <Input label="Location" placeholder="e.g. Lagos" value={value.location} onChange={(e) => set("location", e.target.value)} />
          <p className="text-xs text-ink-faint sm:col-span-2">
            Businesses are served by global search, so this tab ranks the strongest matches for your search text rather than paging a directory.
          </p>
        </div>
      )}

      {(tab === "products" || tab === "services") && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Category" placeholder="Any category" value={value.categoryId} options={categories} onChange={(e) => set("categoryId", e.target.value)} />
          <Select label="Condition" placeholder="Any condition" value={value.condition} options={CONDITIONS} onChange={(e) => set("condition", e.target.value)} />
          <Input label="Minimum price" type="number" min={0} inputMode="decimal" placeholder="0" value={value.minPrice} onChange={(e) => set("minPrice", e.target.value)} />
          <Input label="Maximum price" type="number" min={0} inputMode="decimal" placeholder="No limit" value={value.maxPrice} onChange={(e) => set("maxPrice", e.target.value)} />
          <Input label="Location" placeholder="e.g. Accra" value={value.location} onChange={(e) => set("location", e.target.value)} />
          <Select label="Sort by" value={value.sort || "recent"} options={LISTING_SORTS} onChange={(e) => set("sort", e.target.value)} />
        </div>
      )}

      {tab === "posts" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Format" placeholder="Every format" value={value.postKind} options={POST_KINDS} onChange={(e) => set("postKind", e.target.value)} />
          <Select label="Sort by" value={value.sort || "recent"} options={FEED_SORTS} onChange={(e) => set("sort", e.target.value)} />
          <p className="text-xs text-ink-faint sm:col-span-2">
            The feed has no server-side text search, so the search box matches post copy, author and hashtags within the loaded feed.
          </p>
        </div>
      )}

      {tab === "opportunities" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Opportunity type" placeholder="Any type" value={value.opKind} options={OPPORTUNITY_KINDS} onChange={(e) => set("opKind", e.target.value)} />
          <Input label="Location" placeholder="e.g. Remote · Lagos" value={value.location} onChange={(e) => set("location", e.target.value)} />
          <div className="rounded-xl border border-line bg-surface-2/60 p-3 sm:col-span-2">
            <Switch
              checked={value.remote === "true"}
              onChange={(next) => set("remote", next ? "true" : "")}
              label="Remote only"
              description="Show opportunities that can be done from anywhere"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ActiveChips({ chips, onClear, onClearAll }: { chips: { key: string; label: string }[]; onClear: (key: string) => void; onClearAll: () => void }) {
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Active</span>
      {chips.map((c) => (
        <Chip key={c.key} active className="min-h-10" onClick={() => onClear(c.key)}>
          {c.label}
          <X size={13} aria-hidden />
          <span className="sr-only">Remove {c.label} filter</span>
        </Chip>
      ))}
      {chips.length > 1 && (
        <Button variant="ghost" size="sm" className="min-h-10" onClick={onClearAll}>
          <RotateCcw size={14} aria-hidden /> Clear all
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ page -- */

export default function DiscoverPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const urlTab = params.get("tab");
  const tab: TabKey = isTabKey(urlTab) ? urlTab : "people";
  const config = tabConfig(tab);
  const q = params.get("q") ?? "";

  const values: FilterValues = {
    ...EMPTY_FILTERS,
    industry: params.get("industry") ?? "",
    profession: params.get("profession") ?? "",
    skill: params.get("skill") ?? "",
    category: params.get("category") ?? "",
    categoryId: params.get("categoryId") ?? "",
    location: params.get("location") ?? "",
    minPrice: params.get("minPrice") ?? "",
    maxPrice: params.get("maxPrice") ?? "",
    condition: params.get("condition") ?? "",
    sort: params.get("sort") ?? "",
    postKind: params.get("postKind") ?? "",
    opKind: params.get("opKind") ?? "",
    remote: params.get("remote") ?? "",
  };
  const filterKey = JSON.stringify(values);

  const [text, setText] = useState(q);
  const debouncedText = useDebounced(text, 320);
  const [pages, setPages] = useState(1);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const wide = useIsWide();
  const lastPushed = useRef(q);

  const commit = useCallback(
    (mutate: (next: URLSearchParams) => void, replace: boolean) => {
      const next = new URLSearchParams(params);
      mutate(next);
      setParams(next, { replace });
    },
    [params, setParams]
  );

  const setFilter = useCallback(
    (key: keyof FilterValues, next: string) =>
      commit((p) => {
        if (next) p.set(key, next);
        else p.delete(key);
      }, true),
    [commit]
  );

  const selectTab = useCallback(
    (id: TabKey) =>
      commit((p) => {
        if (id === "people") p.delete("tab");
        else p.set("tab", id);
        const keep = new Set<string>([...TAB_PARAMS[id], "q", "tab"]);
        [...p.keys()].forEach((key) => {
          if (!keep.has(key)) p.delete(key);
        });
      }, false),
    [commit]
  );

  /* Search box <-> URL: external changes (back button, links) win; typing pushes with replace. */
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

  useEffect(() => setPages(1), [tab, q, filterKey]);

  const categories = useAsync(() => (tab === "products" || tab === "services" ? marketplaceApi.categories() : Promise.resolve([])), [tab]);
  const categoryOptions = useMemo(
    () => (categories.data ?? []).map((c) => ({ value: String(c.id), label: c.name })),
    [categories.data]
  );
  const categoryNames = useMemo(
    () => Object.fromEntries((categories.data ?? []).map((c) => [String(c.id), c.name])),
    [categories.data]
  );

  const industries = useAsync(() => metaApi.professionalCategories(), []);
  const industryOptions = useMemo(() => (industries.data ?? []).map((c) => ({ value: c, label: c })), [industries.data]);

  const size = PAGE_SIZE * pages;

  const state = useAsync<Results>(async () => {
    if (tab === "people") {
      const filters: ConnectionFilters = {
        industry: values.industry || undefined,
        profession: values.profession || undefined,
        location: values.location || undefined,
        skill: values.skill || undefined,
        pageSize: size,
      };
      const raw = await networkApi.suggestions(filters);
      const items = raw.filter((p) => personMatches(p, q, filters));
      return { kind: "people", items, total: items.length, hasMore: raw.length >= size };
    }

    if (tab === "businesses") {
      const res = await searchApi.global(q, "business");
      const all = res.businesses;
      return { kind: "businesses", items: all.filter((b) => businessMatches(b, values)), all, total: all.length, hasMore: false };
    }

    if (tab === "products" || tab === "services") {
      const page = await marketplaceApi.listings({
        q: q || undefined,
        kind: tab,
        categoryId: values.categoryId ? Number(values.categoryId) : undefined,
        minPrice: values.minPrice ? Number(values.minPrice) : undefined,
        maxPrice: values.maxPrice ? Number(values.maxPrice) : undefined,
        condition: values.condition || undefined,
        location: values.location || undefined,
        sort: (values.sort || "recent") as MarketplaceFilters["sort"],
        page: 1,
        pageSize: size,
      });
      return { kind: "listings", items: page.items, total: page.total, hasMore: page.hasMore };
    }

    if (tab === "posts") {
      const page = await postsApi.feed({
        kind: values.postKind || undefined,
        sort: (values.sort || "recent") as FeedFilters["sort"],
        page: 1,
        pageSize: size,
      });
      const items = page.items.filter((p) => postMatches(p, q));
      return { kind: "posts", items, total: items.length, hasMore: page.hasMore };
    }

    const page = await opportunitiesApi.list({
      kind: values.opKind || undefined,
      q: q || undefined,
      location: values.location || undefined,
      remote: values.remote === "true" ? true : undefined,
      page: 1,
      pageSize: size,
    });
    return { kind: "opportunities", items: page.items, total: page.total, hasMore: page.hasMore };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q, filterKey, size]);

  const data = state.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const chips = useMemo(() => buildChips(tab, values, categoryNames), [tab, filterKey, categoryNames]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearOne = (key: string) => setFilter(key as keyof FilterValues, "");
  const clearAll = () => commit((p) => TAB_PARAMS[tab].forEach((key) => p.delete(key)), true);
  const clearEverything = () => {
    clearAll();
    commit((p) => p.delete("q"), true);
    setText("");
  };
  const openFilters = () => (wide ? setPanelOpen(true) : setSheetOpen(true));

  const filterPanel = (
    <FilterFields
      tab={tab}
      value={values}
      set={setFilter}
      businessIndustries={data?.kind === "businesses" ? facetsFrom(data.all, (b) => b.industry) : []}
      businessCategories={data?.kind === "businesses" ? facetsFrom(data.all, (b) => b.category) : []}
      categories={categoryOptions}
      industryOptions={industryOptions}
    />
  );

  return (
    <div className="@container space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-tight sm:text-2xl">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent" aria-hidden>
              <Search size={19} />
            </span>
            Discover
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            People, businesses, products, services, posts and opportunities — filter them down and share the URL.
          </p>
        </div>
        <Link to="/network" className="text-[13px] font-semibold text-accent hover:underline">
          Manage my network
        </Link>
      </header>

      <Card className="px-2 py-1">
        <Tabs items={TABS.map((t) => ({ id: t.id, label: t.label }))} value={tab} onChange={(id) => selectTab(id as TabKey)} />
      </Card>

      <Card className="space-y-3 p-3">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" aria-hidden />
            <label className="sr-only" htmlFor="discover-search">
              Search {config.noun} on Discover
            </label>
            <input
              id="discover-search"
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`Search ${config.noun}…`}
              className="h-11 w-full rounded-xl border border-line bg-surface pl-9 pr-10 text-sm placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-[var(--ring)] focus:outline-none"
            />
            {text && (
              <button
                onClick={() => setText("")}
                aria-label="Clear search text"
                className="absolute right-0 top-0 flex h-11 w-10 items-center justify-center rounded-r-xl text-ink-faint hover:text-ink"
              >
                <X size={16} />
              </button>
            )}
          </div>
          <Button variant={chips.length ? "soft" : "outline"} className="h-11 shrink-0" onClick={openFilters} aria-expanded={wide ? panelOpen : sheetOpen}>
            <SlidersHorizontal size={16} aria-hidden />
            <span className="hidden sm:inline">Filters</span>
            {chips.length > 0 && <span className="tabular-nums">· {chips.length}</span>}
          </Button>
        </div>
        <ActiveChips chips={chips} onClear={clearOne} onClearAll={clearAll} />
      </Card>

      {wide && panelOpen && (
        <Card className="anim-fade-up space-y-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-bold">
              <SlidersHorizontal size={15} className="text-accent" aria-hidden />
              {config.label} filters
            </h2>
            <Button variant="ghost" size="sm" className="min-h-10" onClick={clearAll} disabled={!chips.length}>
              <RotateCcw size={14} aria-hidden /> Reset
            </Button>
          </div>
          {filterPanel}
        </Card>
      )}

      {!wide && (
        <Drawer open={sheetOpen} onClose={() => setSheetOpen(false)} width="max-w-full" label={`${config.label} filters`}>
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="flex items-center gap-2 text-sm font-bold">
              <SlidersHorizontal size={15} className="text-accent" aria-hidden />
              {config.label} filters
            </h2>
            <button
              onClick={() => setSheetOpen(false)}
              aria-label="Close filters"
              className="flex h-10 w-10 items-center justify-center rounded-xl text-ink-soft hover:bg-surface-2 hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-4">{filterPanel}</div>
          <div className="safe-bottom flex gap-2 border-t border-line p-4">
            <Button variant="outline" fullWidth onClick={clearAll} disabled={!chips.length}>
              Clear all
            </Button>
            <Button fullWidth onClick={() => setSheetOpen(false)}>
              Show {state.loading ? "…" : plural(items.length, config.one, config.noun)}
            </Button>
          </div>
        </Drawer>
      )}

      {state.loading && <ResultsSkeleton tab={tab} />}

      {state.error && !state.loading && (
        <Card>
          <ErrorState message={errorMessage(state.error)} onRetry={state.refetch} />
        </Card>
      )}

      {!state.loading && data && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold text-ink-soft">
              <config.icon size={14} className="text-ink-faint" aria-hidden />
              {total === items.length ? plural(total, config.one, config.noun) : `${items.length} loaded · ${plural(total, config.one, config.noun)} in total`}
              {q && <span className="font-normal text-ink-faint">for “{q}”</span>}
            </p>
            {data.hasMore && <span className="text-xs text-ink-faint">More available</span>}
          </div>

          {items.length === 0 ? (
            <Card>
              <EmptyState
                icon={<config.icon />}
                title={q || chips.length ? `No ${config.noun} match your search` : `No ${config.noun} yet`}
                description={
                  chips.length || q
                    ? "Widen the filters or clear the search text — there is plenty more in the marketplace."
                    : "This tab has nothing to show right now. Try another tab."
                }
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button variant="outline" onClick={openFilters}>
                      <SlidersHorizontal size={16} aria-hidden /> Adjust your filters
                    </Button>
                    {(chips.length > 0 || q) && (
                      <Button onClick={clearEverything}>
                        <X size={16} aria-hidden /> Clear search and filters
                      </Button>
                    )}
                    {!chips.length && !q && (
                      <Button variant="outline" onClick={() => navigate("/marketplace")}>
                        <Store size={16} aria-hidden /> Browse marketplace
                      </Button>
                    )}
                  </div>
                }
              />
            </Card>
          ) : (
            <>
              {data.kind === "people" && (
                <div className={PEOPLE_GRID}>
                  {data.items.map((p) => (
                    <PersonCard key={p.id} person={p} />
                  ))}
                </div>
              )}
              {data.kind === "businesses" && (
                <div className={BUSINESS_GRID}>
                  {data.items.map((b) => (
                    <BusinessCard key={b.id} business={b} onChanged={state.refetch} />
                  ))}
                </div>
              )}
              {data.kind === "listings" && (
                <div className={LISTING_GRID}>
                  {data.items.map((l) => (
                    <ListingCard key={l.id} listing={l} />
                  ))}
                </div>
              )}
              {data.kind === "posts" && (
                <div className="mx-auto w-full max-w-2xl space-y-4">
                  {data.items.map((p) => (
                    <PostCard key={p.id} post={p} onChanged={state.refetch} />
                  ))}
                </div>
              )}
              {data.kind === "opportunities" && (
                <div className="space-y-3">
                  {data.items.map((o) => (
                    <OpportunityCard key={o.id} opportunity={o} onChanged={state.refetch} />
                  ))}
                </div>
              )}
            </>
          )}

          {data.hasMore && (
            <div className="flex flex-col items-center gap-2 pt-1">
              <Button variant="outline" onClick={() => setPages((n) => n + 1)}>
                Load more {config.noun}
              </Button>
              <span className="text-xs text-ink-faint">
                Showing {items.length}
                {total > items.length ? ` of ${total}` : ""}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ chips -- */

function buildChips(tab: TabKey, values: FilterValues, categoryNames: Record<string, string>): { key: string; label: string }[] {
  return TAB_PARAMS[tab]
    .filter((key) => (values[key as keyof FilterValues] ?? "").trim() !== "")
    .map((key) => ({ key, label: chipLabel(key as keyof FilterValues, values[key as keyof FilterValues], tab, categoryNames) }));
}

function chipLabel(key: keyof FilterValues, raw: string, tab: TabKey, categoryNames: Record<string, string>): string {
  switch (key) {
    case "categoryId":
      return `${categoryNames[raw] ?? "Selected"} · category`;
    case "minPrice":
      return `From ${raw}`;
    case "maxPrice":
      return `Up to ${raw}`;
    case "remote":
      return "Remote only";
    case "condition":
      return CONDITIONS.find((c) => c.value === raw)?.label ?? raw;
    case "sort":
      return (tab === "posts" ? FEED_SORTS : LISTING_SORTS).find((s) => s.value === raw)?.label ?? raw;
    case "opKind":
      return OPPORTUNITY_KINDS.find((k) => k.value === raw)?.label ?? raw;
    case "postKind":
      return POST_KINDS.find((k) => k.value === raw)?.label ?? raw;
    default:
      return `${raw}`;
  }
}
