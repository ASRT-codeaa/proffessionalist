import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  Bookmark,
  Building2,
  ChevronDown,
  ChevronRight,
  Briefcase,
  FolderPlus,
  Grid,
  Heart,
  Layers,
  LayoutList,
  Megaphone,
  RotateCcw,
  Search,
  ShoppingBag,
  Trash2,
  User,
  Wrench,
} from "lucide-react";
import { Avatar, Button, Card, EmptyState, ErrorState, Modal, SegmentedControl, Skeleton, Tabs } from "@/components/ui";
import { useToast } from "@/context/ToastContext";
import { errorMessage, useAsync } from "@/hooks/useAsync";
import { savedApi } from "@/services/api";
import { mediaUrl } from "@/services/http";
import type { SavedItem } from "@/services/types";
import { cn, timeAgo } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/*  Configuration                                                              */
/* -------------------------------------------------------------------------- */

const ALL = "all";

const TYPES: { id: string; label: string; icon: LucideIcon }[] = [
  { id: ALL, label: "All", icon: Layers },
  { id: "post", label: "Posts", icon: Megaphone },
  { id: "product", label: "Products", icon: ShoppingBag },
  { id: "service", label: "Services", icon: Wrench },
  { id: "person", label: "People", icon: User },
  { id: "business", label: "Businesses", icon: Building2 },
  { id: "opportunity", label: "Opportunities", icon: Briefcase },
];

const TYPE_LABEL: Record<SavedItem["itemType"], string> = {
  post: "Post",
  product: "Product",
  service: "Service",
  person: "Person",
  business: "Business",
  opportunity: "Opportunity",
};

interface SavedData {
  items: SavedItem[];
  collections: string[];
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function SavedPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [type, setType] = useState(ALL);
  const [collection, setCollection] = useState(ALL);
  const [density, setDensity] = useState<"list" | "grid">("list");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [collectionModal, setCollectionModal] = useState(false);

  const state = useAsync<SavedData>(
    () =>
      savedApi.list({
        type: type === ALL ? undefined : type,
        collection: collection === ALL ? undefined : collection,
      }),
    [type, collection]
  );

  const items = state.data?.items ?? [];
  const collections = state.data?.collections ?? [];

  const sections = useMemo(() => {
    const map = new Map<string, SavedItem[]>();
    for (const item of items) map.set(item.collection, [...(map.get(item.collection) ?? []), item]);
    return [...map.entries()]
      .map(([name, list]) => [name, [...list].sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime())] as [string, SavedItem[]])
      .filter(([, list]) => list.length > 0)
      .sort((a, b) => {
        if (a[0] === "General") return -1;
        if (b[0] === "General") return 1;
        return new Date(b[1][0].savedAt).getTime() - new Date(a[1][0].savedAt).getTime();
      });
  }, [items]);

  const loading = state.loading && !state.data;
  const showError = !!state.error && !state.loading;
  const filtersActive = type !== ALL || collection !== ALL;
  const collectionCount = sections.length || collections.length;

  const toggleCollection = (name: string) =>
    setCollapsed((prev) => (prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]));

  const remove = (item: SavedItem) => {
    if (!state.data) return;
    const snapshot = state.data;
    const remainingItems = snapshot.items.filter((x) => x.id !== item.id);
    state.setData({ ...snapshot, items: remainingItems });

    savedApi
      .remove(item.id)
      .then(() => {
        toast.success("Removed from saved", item.title);
        const stillUsed = new Set(remainingItems.map((x) => x.collection));
        const collections = filtersActive ? snapshot.collections : snapshot.collections.filter((c) => stillUsed.has(c));
        state.setData((prev) => ({ ...(prev ?? snapshot), items: remainingItems, collections }));
      })
      .catch((e: unknown) => {
        state.setData(snapshot);
        toast.error(errorMessage(e));
      });
  };

  const clearFilters = () => {
    setType(ALL);
    setCollection(ALL);
  };

  return (
    <div className="w-full space-y-4 px-3 pb-2 sm:px-0 anim-fade-up">
      <header className="sticky top-14 z-30 -mx-3 space-y-3 bg-canvas/95 px-3 pb-1 pt-1 backdrop-blur md:top-16 md:mx-0 md:px-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-lg font-extrabold">
              <Bookmark size={19} className="text-accent" aria-hidden />
              Saved
            </h1>
            <p className="mt-0.5 text-[13px] text-ink-soft" aria-live="polite">
              {state.loading && !state.data
                ? "Loading your saves…"
                : `${items.length} saved ${items.length === 1 ? "item" : "items"} across ${collectionCount} collection${collectionCount === 1 ? "" : "s"}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SegmentedControl
              value={density}
              onChange={(v) => setDensity(v as "list" | "grid")}
              options={[
                { value: "list", label: <span className="flex items-center gap-1.5"><LayoutList size={14} /> List</span> },
                { value: "grid", label: <span className="flex items-center gap-1.5"><Grid size={14} /> Grid</span> },
              ]}
            />
            <Button variant="outline" size="sm" onClick={() => setCollectionModal(true)}>
              <FolderPlus size={15} /> New collection
            </Button>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-line bg-surface">
          <Tabs items={TYPES.map((t) => ({ id: t.id, label: t.label }))} value={type} onChange={setType} className="border-b-0 px-1" />
        </div>

        <div className="-mx-1 flex gap-1.5 overflow-x-auto hide-scrollbar px-1 pb-0.5">
          <CollectionChip active={collection === ALL} onClick={() => setCollection(ALL)} icon={<Layers size={13} />} label="All collections" />
          {collections.map((c) => (
            <CollectionChip
              key={c}
              active={collection === c}
              onClick={() => setCollection((prev) => (prev === c ? ALL : c))}
              icon={<Heart size={13} />}
              label={c}
            />
          ))}
          {loading && Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-9 w-28 shrink-0 rounded-full" />)}
        </div>

        {filtersActive && (
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-soft">
            <span>Filtered by {type !== ALL ? TYPES.find((t) => t.id === type)?.label.toLowerCase() : "everything"}</span>
            {collection !== ALL && <span className="font-semibold text-ink">· {collection}</span>}
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <RotateCcw size={14} /> Reset
            </Button>
          </div>
        )}
      </header>

      {loading && <SavedSkeleton density={density} />}

      {showError && (
        <Card>
          <ErrorState message={errorMessage(state.error)} onRetry={state.refetch} />
        </Card>
      )}

      {!loading && !showError && items.length === 0 && (
        <Card>
          <EmptyState
            icon={<Bookmark />}
            title={filtersActive ? "Nothing saved matches this filter" : "Nothing saved yet"}
            description={
              filtersActive
                ? "Try another type or collection — your other saves are still here."
                : "Tap the bookmark on a post, listing, person or business and it lands here, organised into collections."
            }
            action={
              filtersActive ? (
                <Button variant="outline" onClick={clearFilters}>
                  <RotateCcw size={15} /> Show everything
                </Button>
              ) : (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button onClick={() => navigate("/discover")}>
                    <Search size={15} /> Find people to follow
                  </Button>
                  <Button variant="outline" onClick={() => navigate("/marketplace")}>
                    <ShoppingBag size={15} /> Browse the marketplace
                  </Button>
                </div>
              )
            }
          />
        </Card>
      )}

      {!loading && !showError && sections.length > 0 && (
        <div className="space-y-4">
          {sections.map(([name, list]) => {
            const isCollapsed = collapsed.includes(name);
            return (
              <section key={name} aria-labelledby={`collection-${name}`}>
                <Card className="p-0">
                  <button
                    onClick={() => toggleCollection(name)}
                    aria-expanded={!isCollapsed}
                    aria-controls={`collection-panel-${name}`}
                    className="flex min-h-[52px] w-full items-center gap-2.5 px-3.5 py-3 text-left"
                  >
                    {isCollapsed ? <ChevronRight size={17} className="shrink-0 text-ink-faint" aria-hidden /> : <ChevronDown size={17} className="shrink-0 text-accent" aria-hidden />}
                    <span id={`collection-${name}`} className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold">{name}</span>
                      <span className="block text-[11px] text-ink-faint">
                        {list.length} saved {list.length === 1 ? "item" : "items"} · last added {timeAgo(list[0].savedAt) || "now"} ago
                      </span>
                    </span>
                    <span className="flex shrink-0 -space-x-2" aria-hidden>
                      {list.slice(0, 3).map((item) => (
                        <Avatar key={item.id} name={item.title} src={item.imageUrl ? mediaUrl(item.imageUrl) : null} size="xs" ring />
                      ))}
                    </span>
                  </button>
                </Card>

                {!isCollapsed && (
                  <div id={`collection-panel-${name}`} className="mt-2.5 anim-fade-up">
                    {density === "grid" ? <GridList items={list} onRemove={remove} /> : <ListRows items={list} onRemove={remove} />}
                  </div>
                )}
              </section>
            );
          })}

          <p className="pb-1 text-center text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            {items.length} saved {items.length === 1 ? "item" : "items"}
          </p>
        </div>
      )}

      <Modal
        open={collectionModal}
        onClose={() => setCollectionModal(false)}
        title="New collection"
        size="sm"
        mobileSheet
        footer={
          <>
            <Button variant="ghost" onClick={() => setCollectionModal(false)}>
              Not now
            </Button>
            <Button
              onClick={() => {
                setCollectionModal(false);
                navigate("/discover");
              }}
            >
              Browse Discover
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          Collections are created the moment you save something into a new one — bookmark a post and name the collection, and it appears here instantly.
        </p>
        <p className="mt-3 rounded-xl bg-surface-2 p-3 text-[13px] text-ink-soft">
          <span className="font-semibold text-ink">Heads up:</span> the platform has no endpoint for creating an empty collection yet, so this list only shows
          collections that already contain saved items.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to="/marketplace" className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-semibold hover:bg-surface-2">
            <ShoppingBag size={14} aria-hidden /> Browse products
          </Link>
          <Link to="/home" className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-semibold hover:bg-surface-2">
            <Megaphone size={14} aria-hidden /> Save from the feed
          </Link>
        </div>
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Bits                                                                       */
/* -------------------------------------------------------------------------- */

function CollectionChip({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold transition-all",
        active ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function Thumb({ item, className }: { item: SavedItem; className?: string }) {
  const Icon = TYPES.find((t) => t.id === item.itemType)?.icon ?? Bookmark;
  if (item.itemType === "person" || item.itemType === "business") {
    return (
      <span className={cn("flex shrink-0 items-center justify-center overflow-hidden bg-surface-2", className)}>
        <Avatar name={item.title} src={item.imageUrl ? mediaUrl(item.imageUrl) : null} size={item.itemType === "person" ? "md" : "lg"} />
      </span>
    );
  }
  if (!item.imageUrl) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center bg-surface-2 text-ink-faint", className)} aria-hidden>
        <Icon size={18} />
      </span>
    );
  }
  return (
    <span className={cn("block shrink-0 overflow-hidden bg-surface-2", className)}>
      <img src={mediaUrl(item.imageUrl)} alt="" loading="lazy" className="h-full w-full object-cover" />
    </span>
  );
}

function Meta({ item }: { item: SavedItem }) {
  const Icon = TYPES.find((t) => t.id === item.itemType)?.icon ?? Bookmark;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-faint">
      <span className="inline-flex items-center gap-1 font-bold uppercase tracking-wide">
        <Icon size={11} aria-hidden />
        {TYPE_LABEL[item.itemType] ?? item.itemType}
      </span>
      <span aria-hidden>·</span>
      <span className="truncate">{item.collection}</span>
      <span aria-hidden>·</span>
      <time dateTime={item.savedAt} title={new Date(item.savedAt).toLocaleString()}>
        Saved {timeAgo(item.savedAt) || "just now"} ago
      </time>
    </span>
  );
}

function RemoveButton({ item, onRemove }: { item: SavedItem; onRemove: (item: SavedItem) => void }) {
  return (
    <button
      onClick={() => onRemove(item)}
      aria-label={`Remove ${item.title} from saved`}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-faint transition-colors hover:bg-danger-soft hover:text-danger"
    >
      <Trash2 size={16} />
    </button>
  );
}

function ListRows({ items, onRemove }: { items: SavedItem[]; onRemove: (item: SavedItem) => void }) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.id}>
          <Card className="flex items-center gap-3 p-3 anim-fade-up">
            <Thumb item={item} className="h-14 w-14 rounded-xl" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{item.title}</p>
              {item.subtitle && <p className="truncate text-[13px] text-ink-soft">{item.subtitle}</p>}
              <Meta item={item} />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Link
                to={item.href}
                className="inline-flex min-h-[40px] items-center gap-1 rounded-xl border border-line px-3 text-[13px] font-semibold hover:bg-surface-2"
              >
                Open <ChevronRight size={14} aria-hidden />
              </Link>
              <RemoveButton item={item} onRemove={onRemove} />
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function GridList({ items, onRemove }: { items: SavedItem[]; onRemove: (item: SavedItem) => void }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((item) => (
        <li key={item.id}>
          <Card className="flex h-full flex-col overflow-hidden anim-fade-up">
            <Link to={item.href} className="block aspect-[4/3] w-full overflow-hidden bg-surface-2">
              <Thumb item={item} className="h-full w-full" />
            </Link>
            <div className="flex min-w-0 flex-1 flex-col p-3">
              <p className="line-clamp-2 text-[13px] font-semibold">{item.title}</p>
              {item.subtitle && <p className="mt-0.5 truncate text-xs text-ink-soft">{item.subtitle}</p>}
              <div className="mt-1">
                <Meta item={item} />
              </div>
              <div className="mt-2.5 flex items-center gap-1 border-t border-line pt-2">
                <Link to={item.href} className="inline-flex min-h-[40px] flex-1 items-center justify-center rounded-lg bg-accent-soft text-[13px] font-semibold text-accent">
                  Open
                </Link>
                <RemoveButton item={item} onRemove={onRemove} />
              </div>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function SavedSkeleton({ density }: { density: "list" | "grid" }) {
  return (
    <div className="space-y-4" aria-label="Loading saved items">
      {Array.from({ length: 2 }).map((_, s) => (
        <div key={s} className="space-y-2">
          <Card className="flex items-center gap-2.5 p-3">
            <Skeleton className="h-5 w-5 rounded-md" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-2.5 w-44" />
            </div>
            <Skeleton className="h-6 w-16 rounded-full" />
          </Card>
          {density === "grid" ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Card key={i} className="overflow-hidden">
                  <Skeleton className="aspect-[4/3] w-full rounded-none" />
                  <div className="space-y-2 p-3">
                    <Skeleton className="h-3 w-3/4" />
                    <Skeleton className="h-2.5 w-1/2" />
                    <Skeleton className="h-9 rounded-lg" />
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={i} className="flex items-center gap-3 p-3">
                  <Skeleton className="h-14 w-14 rounded-xl" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="h-2.5 w-1/3" />
                  </div>
                  <Skeleton className="h-10 w-20 rounded-xl" />
                  <Skeleton className="h-10 w-10 rounded-xl" />
                </Card>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
