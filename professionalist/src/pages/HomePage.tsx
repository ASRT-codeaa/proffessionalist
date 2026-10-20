import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { Composer } from "@/components/Composer";
import { PostCard, PostCardSkeleton } from "@/components/PostCard";
import { Button, Card, Chip, ErrorState, EmptyState, SegmentedControl } from "@/components/ui";
import { errorMessage } from "@/hooks/useAsync";
import { postsApi } from "@/services/api";
import type { Post } from "@/services/types";

const KINDS = [
  { id: "all", label: "All" },
  { id: "post", label: "Posts" },
  { id: "product", label: "Products" },
  { id: "service", label: "Services" },
  { id: "job", label: "Opportunities" },
];

const PAGE_SIZE = 10;

/**
 * Endless scroll over the page/pageSize feed: a sentinel near the bottom of the list asks the API
 * for one more page and appends it, deduped by post id (offset paging against a timeline that new
 * posts keep shifting can hand back a row twice).  A generation counter makes every in-flight
 * answer from an old sort/kind/refetch drop on the floor.  `refresh` re-pulls the whole loaded
 * range in one request — what the old page-1-doubled-fetch always did, so a new post from the
 * Composer lands at the top without throwing away the reader's scroll.
 */
export default function HomePage() {
  const [sort, setSort] = useState<"recent" | "popular">("recent");
  const [kind, setKind] = useState("all");
  const [following, setFollowing] = useState(false);

  const [items, setItems] = useState<Post[]>([]);
  const [pages, setPages] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const gen = useRef(0);
  const pagesRef = useRef(1);
  pagesRef.current = pages;
  const sentinel = useRef<HTMLDivElement | null>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    const id = ++gen.current;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      const feed = await postsApi.feed({ sort, kind, page: 1, pageSize: PAGE_SIZE * pagesRef.current, scope: following ? "following" : undefined });
      if (gen.current !== id) return;
      setItems(feed.items);
      setHasMore(feed.hasMore);
    } catch (e) {
      if (gen.current === id) setError(e);
    } finally {
      if (gen.current === id) {
        setLoading(false);
        busy.current = false;
      }
    }
  }, [sort, kind, following]);

  useEffect(() => { void load(); }, [load]);

  const loadMore = useCallback(async () => {
    if (busy.current || !hasMore) return;
    busy.current = true;
    setLoadingMore(true);
    const id = gen.current;
    try {
      const next = await postsApi.feed({ sort, kind, page: pagesRef.current + 1, pageSize: PAGE_SIZE, scope: following ? "following" : undefined });
      if (gen.current !== id) return;
      setItems((prev) => {
        const seen = new Set(prev.map(p => p.id));
        return [...prev, ...next.items.filter(p => !seen.has(p.id))];
      });
      setPages(p => p + 1);
      setHasMore(next.hasMore);
    } catch (e) {
      if (gen.current === id) setError(e);
    } finally {
      if (gen.current === id) setLoadingMore(false);
      busy.current = false;
    }
  }, [sort, kind, following, hasMore]);

  /* the observer re-arms on every change of loadMore, which itself changes whenever hasMore or the
     filters do — the sentinel is only ever watched while there is something it could ask for */
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore || loading) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some(en => en.isIntersecting)) void loadMore(); },
      { rootMargin: "600px 0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [loadMore, hasMore, loading]);

  const refresh = useCallback(() => { void load(); }, [load]);
  const reset = useCallback((nextSort?: "recent" | "popular", nextKind?: string) => {
    if (nextSort) setSort(nextSort);
    if (nextKind !== undefined) setKind(nextKind);
    setPages(1);
    pagesRef.current = 1;
  }, []);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
        <SegmentedControl
          value={sort}
          onChange={(v) => reset(v as "recent" | "popular")}
          options={[
            { value: "recent", label: "For you" },
            { value: "popular", label: "Popular" },
          ]}
        />
        <div className="flex gap-1.5 overflow-x-auto hide-scrollbar">
          <Chip active={following} onClick={() => { setFollowing((f) => !f); setPages(1); pagesRef.current = 1; }}>
            Following
          </Chip>
          {KINDS.map((k) => (
            <Chip key={k.id} active={kind === k.id} onClick={() => reset(undefined, k.id)}>
              {k.label}
            </Chip>
          ))}
        </div>
      </Card>

      <Composer onPosted={refresh} />

      {loading && Array.from({ length: 3 }).map((_, i) => <PostCardSkeleton key={i} />)}

      {error !== null && !loading && (
        <Card>
          <ErrorState message={errorMessage(error)} onRetry={refresh} />
        </Card>
      )}

      {!loading && !error && items.length === 0 && (
        <Card>
          <EmptyState
            icon={<Sparkles />}
            title="Your feed is quiet"
            description={kind === "all" ? "Share your first update, or connect with people to fill your feed." : "Nothing matches this filter yet."}
            action={kind !== "all" ? <Button variant="outline" onClick={() => reset(undefined, "all")}>Clear filter</Button> : undefined}
          />
        </Card>
      )}

      {!loading && items.map((p) => <PostCard key={p.id} post={p} onChanged={refresh} />)}

      {!loading && (hasMore || loadingMore) && (
        <div ref={sentinel} className="flex justify-center pt-1 pb-4">
          <Button variant="outline" disabled={loadingMore} onClick={() => { void loadMore(); }}>
            {loadingMore ? "Loading…" : "Load older posts"}
          </Button>
        </div>
      )}
    </div>
  );
}
