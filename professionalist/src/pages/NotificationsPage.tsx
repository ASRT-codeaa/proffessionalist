import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  AtSign,
  Bell,
  CheckCheck,
  CheckSquare,
  ChevronRight,
  Clock,
  Heart,
  Info,
  Loader2,
  MessageCircle,
  MessageSquare,
  ShoppingBag,
  Store,
  UserPlus,
} from "lucide-react";
import { Avatar, Badge, Button, Card, CheckPill, EmptyState, ErrorState, Skeleton, Tabs } from "@/components/ui";
import { useToast } from "@/context/ToastContext";
import { errorMessage, useAsync } from "@/hooks/useAsync";
import { notificationsApi } from "@/services/api";
import { mediaUrl } from "@/services/http";
import type { AppNotification } from "@/services/types";
import { cn, fullName, timeAgo } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/*  Configuration                                                              */
/* -------------------------------------------------------------------------- */

const PAGE_SIZE = 8;

const CATEGORY_META: Record<AppNotification["category"], { label: string; plural: string; icon: LucideIcon }> = {
  connection: { label: "Connection", plural: "Connections", icon: UserPlus },
  message: { label: "Message", plural: "Messages", icon: MessageSquare },
  marketplace: { label: "Marketplace", plural: "Marketplace", icon: ShoppingBag },
  mention: { label: "Mention", plural: "Mentions", icon: AtSign },
  like: { label: "Like", plural: "Likes", icon: Heart },
  comment: { label: "Comment", plural: "Comments", icon: MessageCircle },
  business: { label: "Business", plural: "Business", icon: Store },
  task: { label: "Task", plural: "Tasks", icon: CheckSquare },
  system: { label: "System", plural: "System", icon: Info },
};

const RAIL: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "connection", label: "Connections" },
  { id: "message", label: "Messages" },
  { id: "marketplace", label: "Marketplace" },
  { id: "mention", label: "Mentions" },
  { id: "like", label: "Likes" },
  { id: "comment", label: "Comments" },
  { id: "business", label: "Business" },
  { id: "task", label: "Tasks" },
];

const EMPTY_COPY: Record<string, { title: string; description: string }> = {
  all: { title: "You're all caught up", description: "Activity on your posts, listings, network and messages lands here." },
  connection: { title: "You're all caught up", description: "Connection requests and accepted invites will show up in this tab." },
  message: { title: "You're all caught up", description: "Message alerts for missed threads appear here — live chats are in Messages." },
  marketplace: { title: "You're all caught up", description: "Views, price drops and order updates for your listings land here." },
  mention: { title: "You're all caught up", description: "When someone tags you in a post it shows up in this tab." },
  like: { title: "You're all caught up", description: "Reactions to your posts and listings collect here." },
  comment: { title: "You're all caught up", description: "Replies to your posts and listings show up here." },
  business: { title: "You're all caught up", description: "Updates from pages you manage or follow appear here." },
  task: { title: "You're all caught up", description: "Due dates and goal nudges are listed in this tab." },
};

interface NotificationPage {
  category: string;
  items: AppNotification[];
  total: number;
  hasMore: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Date helpers                                                               */
/* -------------------------------------------------------------------------- */

function dayKey(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toDateString();
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((midnight(new Date()) - midnight(d)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

/** Timeline segments: day separators + stacked groups for runs of one category. */
type Segment =
  | { kind: "day"; key: string; label: string }
  | { kind: "group"; key: string; category: AppNotification["category"]; items: AppNotification[] }
  | { kind: "item"; key: string; item: AppNotification };

function buildSegments(items: AppNotification[]): Segment[] {
  const segments: Segment[] = [];
  let currentDay: string | null = null;
  let run: { key: string; category: AppNotification["category"]; items: AppNotification[] } | null = null;

  const flushRun = () => {
    if (!run) return;
    const finished = run;
    run = null;
    segments.push(finished.items.length === 1 ? { kind: "item", key: finished.key, item: finished.items[0] } : { ...finished, kind: "group" });
  };

  for (const n of items) {
    const day = dayKey(n.createdAt);
    if (day !== currentDay) {
      flushRun();
      currentDay = day;
      segments.push({ kind: "day", key: `day-${day}`, label: dayLabel(n.createdAt) });
    }
    const key = `run-${day}-${n.category}`;
    if (run && run.key === key) {
      run.items.push(n);
    } else {
      flushRun();
      run = { key, category: n.category, items: [n] };
    }
  }
  flushRun();
  return segments;
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function NotificationsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [category, setCategory] = useState("all");
  const [pages, setPages] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const state = useAsync(async (): Promise<NotificationPage> => {
    const requested = category === "all" ? undefined : category;
    const first = await notificationsApi.list({ category: requested, page: 1, pageSize: PAGE_SIZE });
    const items = [...first.items];
    let last = first;
    for (let page = 2; page <= pages; page++) {
      last = await notificationsApi.list({ category: requested, page, pageSize: PAGE_SIZE });
      items.push(...last.items);
    }
    return { category, items, total: last.total, hasMore: last.hasMore };
  }, [category, pages]);

  const unread = useAsync(() => notificationsApi.unreadCount(), []);
  const { setData: setList, refetch: refetchList } = state;
  const { setData: setUnreadCount, refetch: refetchUnread } = unread;

  const data = state.data;
  const items = useMemo(() => (data && data.category === category ? data.items : []), [data, category]);
  const segments = useMemo(() => buildSegments(unreadOnly ? items.filter((n) => !n.read) : items), [items, unreadOnly]);
  const unreadOnPage = items.filter((n) => !n.read).length;
  const totalUnread = unread.data?.count ?? 0;

  const stale = state.loading && !!data && data.category !== category;
  const firstLoad = state.loading && !data;
  const loadingMore = state.loading && !!data && data.category === category;
  const showError = !!state.error && !state.loading;

  /** Keep the counter honest whenever the shell (or this page) announces new activity. */
  useEffect(() => {
    const load = () =>
      notificationsApi
        .unreadCount()
        .then(setUnreadCount)
        .catch(() => undefined);
    window.addEventListener("professionalist:notifications", load);
    return () => window.removeEventListener("professionalist:notifications", load);
  }, [setUnreadCount]);

  const markRead = useCallback(
    (id: number) => {
      const patch = (read: boolean) =>
        setList((prev) =>
          prev ? { ...prev, items: prev.items.map((n) => (n.id === id ? { ...n, read } : n)) } : { category, items: [], total: 0, hasMore: false }
        );
      patch(true);
      notificationsApi
        .markRead(id)
        .then(() => window.dispatchEvent(new Event("professionalist:notifications")))
        .catch((e: unknown) => {
          patch(false);
          toast.error(errorMessage(e));
        });
    },
    [category, setList, toast]
  );

  const onOpen = (n: AppNotification) => {
    if (!n.read) markRead(n.id);
    navigate(n.href);
  };

  const markAllRead = async () => {
    if (!data) return;
    const snapshot = data;
    setList({ ...snapshot, items: snapshot.items.map((n) => ({ ...n, read: true })) });
    try {
      await notificationsApi.markAllRead();
      window.dispatchEvent(new Event("professionalist:notifications"));
      refetchUnread();
      toast.success("All notifications marked as read");
    } catch (e) {
      setList(snapshot);
      toast.error(errorMessage(e));
    }
  };

  /** Infinite scroll, with a visible fallback button underneath. */
  const sentinelRef = useRef<HTMLDivElement>(null);
  const canLoadMore = !!data && data.category === category && !!data.hasMore && !state.loading && !state.error;

  useEffect(() => {
    if (!canLoadMore) return;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setPages((p) => p + 1);
      },
      { rootMargin: "240px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [canLoadMore, pages]);

  const changeCategory = (id: string) => {
    setCategory(id);
    setPages(1);
  };

  const retry = () => {
    if (state.error && !data) state.refetch();
    else refetchList();
  };

  const emptyCopy = EMPTY_COPY[category] ?? EMPTY_COPY.all;
  const railLabel = RAIL.find((c) => c.id === category)?.label ?? "All";

  return (
    <div className="w-full space-y-3">
      <header className="sticky top-14 z-30 space-y-3 bg-canvas/95 pb-1 backdrop-blur md:top-16">
        <Card className="flex flex-wrap items-center justify-between gap-3 p-3.5">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-lg font-extrabold">
              <Bell size={19} className="text-accent" aria-hidden />
              Notifications
            </h1>
            <p className="mt-0.5 text-[13px] text-ink-soft" aria-live="polite">
              {unread.loading && !unread.data
                ? "Checking your activity…"
                : totalUnread > 0
                  ? `${totalUnread} unread across the app`
                  : "Everything is read — nice work."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CheckPill checked={unreadOnly} onToggle={() => setUnreadOnly((v) => !v)}>
              Unread only{unreadOnPage > 0 ? ` (${unreadOnPage})` : ""}
            </CheckPill>
            <Button variant="outline" size="sm" onClick={() => void markAllRead()} disabled={totalUnread === 0 && unreadOnPage === 0}>
              <CheckCheck size={15} /> Mark all read
            </Button>
          </div>
        </Card>

        <div className="overflow-hidden rounded-2xl border border-line bg-surface">
          <Tabs items={RAIL} value={category} onChange={changeCategory} className="border-b-0 px-1" />
        </div>
      </header>

      <div className="space-y-3">
        {(firstLoad || stale) && <NotificationsSkeleton />}

        {showError && (
          <Card>
            <ErrorState message={errorMessage(state.error)} onRetry={retry} />
          </Card>
        )}

        {!state.loading && !state.error && segments.length === 0 && (
          <Card>
            <EmptyState
              icon={<Bell />}
              title={emptyCopy.title}
              description={emptyCopy.description}
              action={
                unreadOnly ? (
                  <Button variant="outline" onClick={() => setUnreadOnly(false)}>
                    Show read notifications
                  </Button>
                ) : category !== "all" ? (
                  <Button variant="outline" onClick={() => changeCategory("all")}>
                    View all notifications
                  </Button>
                ) : (
                  <Button variant="outline" onClick={() => navigate("/home")}>
                    Back to the feed
                  </Button>
                )
              }
            />
          </Card>
        )}

        {items.length > 0 && segments.length > 0 && (
          <>
            {segments.map((s) => {
              if (s.kind === "day") {
                return (
                  <h2 key={s.key} className="flex items-center gap-1.5 px-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
                    <Clock size={12} aria-hidden />
                    {s.label}
                  </h2>
                );
              }
              if (s.kind === "group") {
                return <NotificationStack key={s.key} category={s.category} items={s.items} onOpen={onOpen} onMarkRead={markRead} />;
              }
              return <NotificationRow key={s.key} notification={s.item} onOpen={onOpen} onMarkRead={markRead} />;
            })}
          </>
        )}

        {loadingMore && <NotificationsSkeleton rows={2} />}

        {loadingMore && (
          <p className="flex items-center justify-center gap-2 py-2 text-[13px] font-semibold text-ink-soft">
            <Loader2 size={15} className="animate-spin" aria-hidden /> Loading more notifications
          </p>
        )}

        <div ref={sentinelRef} aria-hidden />

        {canLoadMore && (
          <div className="flex justify-center pt-1">
            <Button variant="outline" onClick={() => setPages((p) => p + 1)}>
              Load older notifications
            </Button>
          </div>
        )}

        {!state.loading && !state.error && items.length > 0 && !data?.hasMore && (
          <p className="pb-2 text-center text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            That's everything — {data?.total ?? items.length} notification{data?.total === 1 ? "" : "s"} in {railLabel}
          </p>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Rows                                                                       */
/* -------------------------------------------------------------------------- */

function CategoryIcon({ category }: { category: AppNotification["category"] }) {
  const meta = CATEGORY_META[category] ?? CATEGORY_META.system;
  const Icon = meta.icon;
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
      <Icon size={18} aria-hidden />
    </span>
  );
}

function ActorAvatar({ notification }: { notification: AppNotification }) {
  if (!notification.actor) return <CategoryIcon category={notification.category} />;
  return <Avatar name={fullName(notification.actor)} src={mediaUrl(notification.actor.avatarUrl)} size="md" />;
}

function ReadMark({ read }: { read: boolean }) {
  if (!read) {
    return (
      <span className="mt-1 flex w-3 shrink-0 justify-center" aria-hidden>
        <span className="h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-accent-soft" />
      </span>
    );
  }
  return (
    <span className="mt-1 flex w-3 shrink-0 justify-center" aria-hidden>
      <span className="h-2.5 w-2.5 rounded-full border border-line-strong" />
    </span>
  );
}

function NotificationRow({
  notification,
  onOpen,
  onMarkRead,
}: {
  notification: AppNotification;
  onOpen: (n: AppNotification) => void;
  onMarkRead: (id: number) => void;
}) {
  const meta = CATEGORY_META[notification.category] ?? CATEGORY_META.system;
  const unread = !notification.read;

  return (
    <Card className={cn("card-hover flex items-start gap-2 border p-3", unread ? "border-line-strong bg-accent-soft/50" : "border-line bg-surface")}>
      <ReadMark read={notification.read} />
      <ActorAvatar notification={notification} />

      <Link
        to={notification.href}
        onClick={() => unread && onMarkRead(notification.id)}
        className="min-w-0 flex-1 rounded-lg focus-visible:outline-2"
      >
        <span className={cn("block break-words text-[13.5px] leading-snug", unread ? "font-extrabold text-ink" : "font-medium text-ink-soft")}>
          {notification.text}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
          <span className="font-bold uppercase tracking-wide">{meta.plural}</span>
          <span aria-hidden>·</span>
          <time dateTime={notification.createdAt}>{timeAgo(notification.createdAt)} ago</time>
          {unread && (
            <>
              <span aria-hidden>·</span>
              <span className="font-bold">Unread</span>
            </>
          )}
        </span>
      </Link>

      <div className="flex shrink-0 items-center self-center">
        {unread ? (
          <button
            onClick={() => onMarkRead(notification.id)}
            aria-label={`Mark "${notification.text}" as read`}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-ink-faint transition-colors hover:bg-surface-2 hover:text-accent"
          >
            <CheckCheck size={17} />
          </button>
        ) : (
          <span className="px-2 text-[11px] font-semibold text-ink-faint">Read</span>
        )}
        <button
          onClick={() => onOpen(notification)}
          aria-label={`Open ${meta.plural.toLowerCase()} notification`}
          className="flex h-10 w-10 items-center justify-center rounded-xl text-ink-faint transition-colors hover:bg-surface-2 hover:text-accent"
        >
          <ChevronRight size={18} />
        </button>
      </div>
    </Card>
  );
}

/** Consecutive notifications sharing a category collapse into one compact stack. */
function NotificationStack({
  category,
  items,
  onOpen,
  onMarkRead,
}: {
  category: AppNotification["category"];
  items: AppNotification[];
  onOpen: (n: AppNotification) => void;
  onMarkRead: (id: number) => void;
}) {
  const meta = CATEGORY_META[category] ?? CATEGORY_META.system;
  const Icon = meta.icon;
  const unreadCount = items.filter((n) => !n.read).length;

  return (
    <Card className="overflow-hidden">
      <div className={cn("flex items-center gap-2.5 border-b border-line px-3 py-2", unreadCount > 0 ? "bg-accent-soft/60" : "bg-surface-2/60")}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Icon size={16} aria-hidden />
        </span>
        <p className="min-w-0 flex-1 text-[13px] font-extrabold">
          {items.length} {meta.plural}
          {unreadCount > 0 && <span className="ml-1.5 font-bold text-accent">· {unreadCount} unread</span>}
        </p>
        <span className="shrink-0 text-[11px] text-ink-faint">{timeAgo(items[0].createdAt)} ago</span>
      </div>

      <ul className="divide-y divide-line">
        {items.map((n) => (
          <li key={n.id} className={cn("flex items-center gap-2.5 px-3 py-2", !n.read && "bg-accent-soft/40")}>
            {n.actor ? (
              <Avatar name={fullName(n.actor)} src={mediaUrl(n.actor.avatarUrl)} size="sm" />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-soft">
                <Icon size={15} aria-hidden />
              </span>
            )}
            <Link to={n.href} onClick={() => !n.read && onMarkRead(n.id)} className="min-w-0 flex-1">
              <span className={cn("block truncate text-[13px]", n.read ? "font-medium text-ink-soft" : "font-bold text-ink")}>{n.text}</span>
              <span className="block text-[11px] text-ink-faint">
                {timeAgo(n.createdAt)} ago{n.read ? "" : " · unread"}
              </span>
            </Link>
            {!n.read && <Badge tone="accent">New</Badge>}
            <button
              onClick={() => onOpen(n)}
              aria-label={`Open "${n.text}"`}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-faint transition-colors hover:bg-surface-2 hover:text-accent"
            >
              <ChevronRight size={17} />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Skeleton                                                                   */
/* -------------------------------------------------------------------------- */

function NotificationsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-label="Loading notifications">
      <Skeleton className="mx-auto mt-1 mb-2 h-2.5 w-24 rounded-full" />
      {Array.from({ length: rows }).map((_, i) => (
        <Card key={i} className="flex items-start gap-2 border-line p-3">
          <Skeleton className="mt-1 h-2.5 w-2.5 rounded-full" />
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
          <Skeleton className="h-10 w-10 rounded-xl" />
        </Card>
      ))}
    </div>
  );
}
