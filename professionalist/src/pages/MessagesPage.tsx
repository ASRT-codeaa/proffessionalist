import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  Copy,
  Download,
  Flag,
  Globe,
  Info,
  Loader2,
  MapPin,
  MessageSquare,
  MoreVertical,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShoppingBag,
  Smile,
  Trash2,
  User as UserIcon,
  Users,
  X,
} from "lucide-react";
import {
  Avatar,
  Badge,
  Button,
  Drawer,
  Dropdown,
  EmptyState,
  ErrorState,
  Input,
  MenuItem,
  Modal,
  OnlineDot,
  Select,
  Skeleton,
  Textarea,
  Tooltip,
  VerifiedBadge,
} from "@/components/ui";
import { ListingCard, PersonCard, StarRating } from "@/components/cards";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { errorMessage, useAsync, useDebounced } from "@/hooks/useAsync";
import { messagingApi, networkApi, searchApi, supportApi, usersApi } from "@/services/api";
import { mediaUrl } from "@/services/http";
import type { Conversation, ConversationId, Listing, Message, Person } from "@/services/types";
import { cn, formatNumber, formatPrice, fullName, timeAgo } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/*  Local helpers                                                              */
/* -------------------------------------------------------------------------- */

const REACTIONS = ["👍", "❤️", "🎉", "💡", "🙏", "😂"];
const DOCUMENT_RE = /\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip)$/i;

/** A server message plus the local lifecycle flags used for optimistic sends. */
interface UiMessage extends Message {
  temp?: boolean;
  failed?: boolean;
  payload?: { text?: string; mediaUrl?: string; attachmentName?: string };
}

/** The stub API returns root-relative media paths — resolve them once, here. */
const withAvatar = (p: Person): Person => ({ ...p, avatarUrl: mediaUrl(p.avatarUrl) });
const withListingImage = (l: Listing): Listing => ({
  ...l,
  images: l.images.map(mediaUrl),
  seller: { ...l.seller, avatarUrl: mediaUrl(l.seller.avatarUrl) },
});

function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((midnight(new Date()) - midnight(d)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

function previewOf(m: Message): string {
  if (m.text) return m.text;
  if (m.attachmentName) return m.attachmentName;
  if (m.mediaUrl) return "Photo";
  if (m.sharedListing) return m.sharedListing.title;
  if (m.sharedProfile) return "Shared a profile";
  return "";
}

/** Media that is not a known document type is rendered as an inline image. */
function isImageMessage(m: Message): boolean {
  if (!m.mediaUrl) return false;
  return !DOCUMENT_RE.test(m.mediaUrl) && !DOCUMENT_RE.test(m.attachmentName);
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function MessagesPage() {
  const params = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [query, setQuery] = useState("");
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [reportTarget, setReportTarget] = useState<Person | null>(null);

  const debouncedQuery = useDebounced(query.trim(), 300);

  const all = useAsync(() => messagingApi.conversations(), []);
  const filtered = useAsync(() => (debouncedQuery ? messagingApi.conversations(debouncedQuery) : Promise.resolve(null)), [debouncedQuery]);
  const hits = useAsync(() => (debouncedQuery ? messagingApi.search(debouncedQuery) : Promise.resolve(null)), [debouncedQuery]);

  const { setData: setAllRows, refetch: refetchAll } = all;
  const { setData: setFilteredRows } = filtered;

  const activeId: ConversationId | null = params.id ? decodeURIComponent(params.id) : null;

  const rows = debouncedQuery ? filtered.data : all.data;
  const listLoading = debouncedQuery ? filtered.loading : all.loading;
  const listError = debouncedQuery ? filtered.error : all.error;

  const unreadTotal = useMemo(() => (all.data ?? []).reduce((sum, c) => sum + c.unreadCount, 0), [all.data]);

  const active = useMemo(() => {
    if (activeId === null) return null;
    const pool = [...(all.data ?? []), ...(filtered.data ?? [])];
    return pool.find((c) => c.id === activeId) ?? null;
  }, [activeId, all.data, filtered.data]);

  const refreshList = useCallback(() => {
    messagingApi
      .conversations()
      .then(setAllRows)
      .catch(() => undefined);
  }, [setAllRows]);

  /** Opening a thread clears its unread badge locally, remotely and in the shell. */
  useEffect(() => {
    if (activeId === null) return;
    setAllRows((prev) => (prev ?? []).map((c) => (c.id === activeId ? { ...c, unreadCount: 0 } : c)));
    messagingApi
      .markRead(activeId)
      .then(() => window.dispatchEvent(new Event("professionalist:notifications")))
      .catch(() => undefined);
    setContactOpen(false);
  }, [activeId, setAllRows]);

  /** Background polling so other people's replies land without a manual refresh. */
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.hidden) return;
      refreshList();
      if (debouncedQuery) messagingApi.conversations(debouncedQuery).then(setFilteredRows).catch(() => undefined);
    }, 20_000);
    return () => window.clearInterval(t);
  }, [debouncedQuery, refreshList, setFilteredRows]);

  const select = useCallback((id: ConversationId) => navigate(`/messages/${id}`), [navigate]);

  const onActivity = useCallback(
    (m: Message) => {
      setAllRows((prev) =>
        (prev ?? []).map((c) => (c.id === m.conversationId ? { ...c, lastMessage: previewOf(m), lastMessageAt: m.createdAt } : c))
      );
    },
    [setAllRows]
  );

  /** Replies that arrive while the thread is open are read immediately. */
  const onIncoming = useCallback(
    (conversationId: ConversationId) => {
      messagingApi
        .markRead(conversationId)
        .then(() => window.dispatchEvent(new Event("professionalist:notifications")))
        .catch(() => undefined);
      setAllRows((prev) => (prev ?? []).map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)));
      refreshList();
    },
    [refreshList, setAllRows]
  );

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* ---------------------------- Conversation list --------------------------- */}
      <aside
        aria-label="Conversations"
        className={cn(
          "min-h-0 w-full min-w-0 flex-col border-r border-line bg-surface lg:w-[336px] lg:shrink-0 xl:w-[368px]",
          activeId === null ? "flex" : "hidden lg:flex"
        )}
      >
        <div className="shrink-0 space-y-3 border-b border-line px-3.5 py-3">
          <div className="flex items-center justify-between gap-2">
            <h1 className="flex items-center gap-2 text-base font-extrabold">
              <span>Messages</span>
              {unreadTotal > 0 && <Badge tone="accent">{unreadTotal} unread</Badge>}
            </h1>
            <Button size="sm" variant="soft" onClick={() => setNewChatOpen(true)}>
              <Plus size={15} /> New
            </Button>
          </div>
          <Input
            aria-label="Search conversations"
            icon={<Search size={15} />}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people and messages"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {listLoading && !rows && <ConversationListSkeleton />}

          {!listLoading && listError && (
            <ErrorState message={errorMessage(listError)} onRetry={debouncedQuery ? filtered.refetch : refetchAll} />
          )}

          {!listLoading && !listError && rows && rows.length === 0 && (
            <EmptyState
              icon={<MessageSquare />}
              title={debouncedQuery ? "No matches" : "No conversations yet"}
              description={
                debouncedQuery
                  ? `Nothing matches “${debouncedQuery}”. Try another name or word.`
                  : "Start a thread with someone you work with — messages, listings and profiles all travel inside a chat."
              }
              action={
                debouncedQuery ? (
                  <Button variant="outline" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                ) : (
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={() => setNewChatOpen(true)}>
                      <Plus size={15} /> New message
                    </Button>
                    <Button variant="outline" onClick={() => navigate("/network")}>
                      Find people to message
                    </Button>
                  </div>
                )
              }
            />
          )}

          {!listLoading && !listError && rows && rows.length > 0 && (
            <ul className="divide-y divide-line">
              {rows.map((c) => (
                <ConversationRow key={c.id} conversation={c} active={c.id === activeId} onSelect={select} />
              ))}
            </ul>
          )}

          {debouncedQuery && !hits.loading && !hits.error && hits.data && hits.data.messages.length > 0 && (
            <section aria-label="Matching messages" className="border-t border-line">
              <p className="px-3.5 py-2 text-[11px] font-bold uppercase tracking-wider text-ink-faint">In conversations</p>
              <ul className="divide-y divide-line">
                {hits.data.messages.slice(0, 8).map((h) => (
                  <li key={h.id}>
                    <button
                      onClick={() => select(h.conversation.id)}
                      className="flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2"
                    >
                      <Avatar name={fullName(h.conversation.participant)} src={mediaUrl(h.conversation.participant.avatarUrl)} size="sm" />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold">{fullName(h.conversation.participant)}</span>
                        <span className="block truncate text-xs text-ink-soft">{h.text}</span>
                        <span className="block text-[11px] text-ink-faint">{timeAgo(h.createdAt)} ago</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </aside>

      {/* --------------------------------- Thread --------------------------------- */}
      <section
        aria-label="Conversation"
        className={cn("relative min-h-0 min-w-0 flex-1 flex-col bg-canvas", activeId === null ? "hidden lg:flex" : "flex anim-slide-right")}
      >
        {activeId === null && (
          <div className="hidden h-full items-center justify-center p-6 lg:flex">
            <EmptyState
              icon={<MessageSquare />}
              title="Pick up where you left off"
              description="Select a conversation to read the thread, share listings and keep the deal moving."
              action={
                <Button variant="outline" onClick={() => setNewChatOpen(true)}>
                  <Plus size={15} /> Start a new message
                </Button>
              }
            />
          </div>
        )}

        {activeId !== null && !active && (
          <div className="flex h-full flex-col">
            <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-2.5 py-2 sm:px-4">
              <button
                onClick={() => navigate("/messages")}
                aria-label="Back to conversations"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink lg:hidden"
              >
                <ArrowLeft size={20} />
              </button>
              {all.loading || !all.data ? (
                <>
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-2.5 w-20" />
                  </div>
                </>
              ) : (
                <p className="text-sm font-bold">Conversation</p>
              )}
            </header>
            <div className="flex flex-1 items-center justify-center p-6">
              {all.loading || !all.data ? (
                <div className="w-full max-w-md space-y-3" aria-label="Loading messages">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className={cn("flex items-end gap-2", i % 2 ? "justify-end" : "justify-start")}>
                      {i % 2 === 0 && <Skeleton className="h-9 w-9 rounded-full" />}
                      <Skeleton className={cn("h-12 rounded-2xl", i % 2 ? "w-2/5" : "w-3/5")} />
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={<X />}
                  title="Conversation not found"
                  description="This thread may have been removed, or the link is out of date."
                  action={
                    <Button variant="outline" onClick={() => navigate("/messages")}>
                      Back to messages
                    </Button>
                  }
                />
              )}
            </div>
          </div>
        )}

        {active && (
          <Thread
            key={active.id}
            conversation={active}
            currentUserId={user?.id ?? 0}
            onBack={() => navigate("/messages")}
            onActivity={onActivity}
            onIncoming={onIncoming}
            onReport={setReportTarget}
            onOpenContact={() => setContactOpen(true)}
          />
        )}
      </section>

      {/* ------------------------------ Contact panel ----------------------------- */}
      <aside aria-label="Contact details" className="hidden min-h-0 w-[340px] shrink-0 flex-col border-l border-line bg-surface xl:flex">
        {active ? (
          <ContactPanel person={active.participant} online={active.online} onRefresh={refreshList} onReport={setReportTarget} />
        ) : (
          <div className="space-y-3 p-3.5">
            <h2 className="text-sm font-extrabold">Contact</h2>
            <p className="text-xs text-ink-soft">Select a conversation to see the profile, shared listings and quick actions.</p>
          </div>
        )}
      </aside>

      <Drawer
        open={contactOpen && !!active}
        onClose={() => setContactOpen(false)}
        label={active ? `Contact details for ${fullName(active.participant)}` : "Contact details"}
        side="right"
      >
        {active && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ContactPanel
              person={active.participant}
              online={active.online}
              onRefresh={refreshList}
              onReport={setReportTarget}
              onClose={() => setContactOpen(false)}
            />
          </div>
        )}
      </Drawer>

      <NewConversationModal
        open={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        onCreated={(c) => {
          refreshList();
          navigate(`/messages/${c.id}`);
        }}
      />

      <ReportModal person={reportTarget} onClose={() => setReportTarget(null)} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Conversation list                                                          */
/* -------------------------------------------------------------------------- */

function ConversationRow({ conversation, active, onSelect }: { conversation: Conversation; active: boolean; onSelect: (id: ConversationId) => void }) {
  const p = conversation.participant;
  const name = fullName(p);
  const unread = conversation.unreadCount > 0;

  return (
    <li>
      <button
        onClick={() => onSelect(conversation.id)}
        aria-current={active ? "true" : undefined}
        className={cn("flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors", active ? "bg-accent-soft" : "hover:bg-surface-2")}
      >
        <span className="relative shrink-0">
          <Avatar name={name} src={mediaUrl(p.avatarUrl)} size="md" />
          {conversation.online && <OnlineDot className="absolute -bottom-0.5 -right-0.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", unread ? "font-extrabold" : "font-semibold")}>{name}</span>
            {p.verified && <VerifiedBadge color={p.verifiedColor} size={13} />}
            <span className="shrink-0 text-[11px] text-ink-faint">{timeAgo(conversation.lastMessageAt)}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            <span className={cn("min-w-0 flex-1 truncate text-xs", unread ? "font-semibold text-ink" : "text-ink-soft")}>
              {conversation.lastMessage || "No messages yet"}
            </span>
            {unread && (
              <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-accent px-1.5 text-[10px] font-bold text-white">
                {conversation.unreadCount}
                <span className="sr-only">unread</span>
              </span>
            )}
          </span>
          {conversation.online && <span className="mt-0.5 block text-[11px] font-semibold text-success">Active now</span>}
        </span>
      </button>
    </li>
  );
}

function ConversationListSkeleton() {
  return (
    <ul className="divide-y divide-line" aria-label="Loading conversations">
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="flex items-start gap-3 px-3.5 py-3">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-2.5 w-4/5" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*  Thread                                                                     */
/* -------------------------------------------------------------------------- */

function Thread({
  conversation,
  currentUserId,
  onBack,
  onActivity,
  onIncoming,
  onReport,
  onOpenContact,
}: {
  conversation: Conversation;
  currentUserId: number;
  onBack: () => void;
  onActivity: (m: Message) => void;
  onIncoming: (conversationId: ConversationId) => void;
  onReport: (p: Person) => void;
  onOpenContact: () => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const id = conversation.id;
  const participant = conversation.participant;
  const name = fullName(participant);

  const [items, setItems] = useState<UiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [hasMore, setHasMore] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);

  const runRef = useRef(0);
  const itemsRef = useRef<UiMessage[]>([]);
  const tempSeq = useRef(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const restoreRef = useRef<{ height: number; top: number } | null>(null);

  itemsRef.current = items;

  const load = useCallback(
    async (silent = false) => {
      const my = ++runRef.current;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const res = await messagingApi.messages(id);
        if (runRef.current !== my) return;
        setHasMore(res.hasMore);
        const known = new Set(itemsRef.current.map((m) => m.id));
        const freshIncoming = res.items.filter((m) => !m.fromMe && !known.has(m.id));
        setItems((prev) => {
          const pending = prev.filter((m) => m.temp);
          const freshIds = new Set(res.items.map((m) => m.id));
          return [...res.items.map((m) => ({ ...m }) as UiMessage), ...pending.filter((m) => !freshIds.has(m.id))];
        });
        setError(null);
        if (silent && freshIncoming.length > 0) onIncoming(id);
      } catch (e) {
        if (runRef.current === my && !silent) setError(e);
      } finally {
        if (runRef.current === my) setLoading(false);
      }
    },
    [id, onIncoming]
  );

  useEffect(() => {
    atBottomRef.current = true;
    void load();
    const t = window.setInterval(() => {
      if (!document.hidden) void load(true);
    }, 8_000);
    return () => window.clearInterval(t);
  }, [load]);

  const loadOlder = useCallback(async () => {
    const oldest = itemsRef.current.find((m) => !m.temp)?.id;
    if (oldest === undefined) return;
    setOlderLoading(true);
    try {
      const res = await messagingApi.messages(id, oldest);
      setHasMore(res.hasMore);
      setItems((prev) => {
        const known = new Set(prev.map((m) => m.id));
        const older = res.items.filter((m) => !known.has(m.id)).map((m) => ({ ...m }) as UiMessage);
        return [...older, ...prev];
      });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setOlderLoading(false);
    }
  }, [id, toast]);

  const loadOlderPreservingScroll = () => {
    const el = scrollRef.current;
    if (el) restoreRef.current = { height: el.scrollHeight, top: el.scrollTop };
    void loadOlder();
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (restoreRef.current) {
      const { height, top } = restoreRef.current;
      el.scrollTop = el.scrollHeight - height + top;
      restoreRef.current = null;
      return;
    }
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [items, loading]);

  const send = useCallback(
    async (payload: { text: string; mediaUrl?: string; attachmentName?: string }) => {
      const tempId = --tempSeq.current;
      const createdAt = new Date().toISOString();
      const temp: UiMessage = {
        id: tempId,
        conversationId: id,
        senderId: currentUserId,
        fromMe: true,
        text: payload.text,
        mediaUrl: payload.mediaUrl ?? "",
        attachmentName: payload.attachmentName ?? "",
        reaction: "",
        read: false,
        createdAt,
        temp: true,
        payload,
      };
      setItems((prev) => [...prev, temp]);
      atBottomRef.current = true;
      try {
        const created = await messagingApi.send(id, {
          text: payload.text || undefined,
          mediaUrl: payload.mediaUrl,
          attachmentName: payload.attachmentName,
        });
        setItems((prev) => {
          const withoutTemp = prev.filter((m) => m.id !== tempId);
          return withoutTemp.some((m) => m.id === created.id) ? withoutTemp : [...withoutTemp, { ...created }];
        });
        onActivity(created);
      } catch (e) {
        setItems((prev) => prev.map((m) => (m.id === tempId ? { ...m, failed: true } : m)));
        toast.error(errorMessage(e));
        throw e;
      }
    },
    [id, currentUserId, onActivity, toast]
  );

  const retry = (m: UiMessage) => {
    setItems((prev) => prev.filter((x) => x.id !== m.id));
    void send({ text: m.payload?.text ?? "", mediaUrl: m.payload?.mediaUrl, attachmentName: m.payload?.attachmentName }).catch(() => undefined);
  };

  const react = async (m: UiMessage, reaction: string) => {
    const next = m.reaction === reaction ? "" : reaction;
    const previous = m.reaction;
    setItems((prev) => prev.map((x) => (x.id === m.id ? { ...x, reaction: next } : x)));
    try {
      const res = await messagingApi.react(m.id, next);
      setItems((prev) => prev.map((x) => (x.id === m.id ? { ...x, reaction: res.reaction ?? "" } : x)));
    } catch (e) {
      setItems((prev) => prev.map((x) => (x.id === m.id ? { ...x, reaction: previous } : x)));
      toast.error(errorMessage(e));
    }
  };

  const remove = async (m: UiMessage) => {
    const snapshot = itemsRef.current;
    setItems((prev) => prev.filter((x) => x.id !== m.id));
    try {
      await messagingApi.delete(m.id);
      toast.success("Message deleted");
    } catch (e) {
      setItems(snapshot);
      toast.error(errorMessage(e));
    }
  };

  const reactToLastOwn = (reaction: string) => {
    const lastOwn = [...itemsRef.current].reverse().find((m) => m.fromMe && !m.temp);
    if (!lastOwn) {
      toast.info("Nothing to react to yet", "Send a message first, then react to it.");
      return;
    }
    void react(lastOwn, reaction);
  };

  const groups = useMemo(() => {
    const out: { key: string; label: string; items: UiMessage[] }[] = [];
    for (const m of items) {
      const key = new Date(m.createdAt).toDateString();
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(m);
      else out.push({ key, label: dayLabel(m.createdAt), items: [m] });
    }
    return out;
  }, [items]);

  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-2.5 py-2 sm:px-4">
        <button
          onClick={onBack}
          aria-label="Back to conversations"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink lg:hidden"
        >
          <ArrowLeft size={20} />
        </button>
        <Link to={`/profile/${participant.username}`} className="relative shrink-0" aria-label={`Open ${name}'s profile`}>
          <Avatar name={name} src={mediaUrl(participant.avatarUrl)} size="md" />
          {conversation.online && <OnlineDot className="absolute -bottom-0.5 -right-0.5" />}
        </Link>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-sm font-bold">
            <span className="truncate">{name}</span>
            {participant.verified && <VerifiedBadge color={participant.verifiedColor} size={13} />}
          </h2>
          <p className={cn("truncate text-xs font-semibold", conversation.online ? "text-success" : "text-ink-faint")}>
            {conversation.online ? "Active now" : "Offline"}
            {participant.title ? ` · ${participant.title}` : ""}
          </p>
        </div>

        <Tooltip label="Contact details">
          <button
            onClick={onOpenContact}
            aria-label="Show contact details"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink xl:hidden"
          >
            <Info size={19} />
          </button>
        </Tooltip>

        <Dropdown
          trigger={({ open, toggle }) => (
            <button
              onClick={toggle}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label="Conversation options"
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink",
                open && "bg-surface-2 text-ink"
              )}
            >
              <MoreVertical size={19} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon={<UserIcon size={15} />} onClick={() => { navigate(`/profile/${participant.username}`); close(); }}>
                View profile
              </MenuItem>
              <MenuItem icon={<Info size={15} />} onClick={() => { onOpenContact(); close(); }}>
                Contact details
              </MenuItem>
              <MenuItem
                icon={<Copy size={15} />}
                onClick={() => {
                  void navigator.clipboard?.writeText(`${window.location.origin}/profile/${participant.username}`);
                  toast.success("Profile link copied");
                  close();
                }}
              >
                Copy profile link
              </MenuItem>
              <MenuItem icon={<Flag size={15} />} danger onClick={() => { onReport(participant); close(); }}>
                Report conversation
              </MenuItem>
            </>
          )}
        </Dropdown>
      </header>

      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5"
      >
        {loading && (
          <div className="mx-auto max-w-3xl space-y-3" aria-label="Loading messages">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className={cn("flex items-end gap-2", i % 2 ? "justify-end" : "justify-start")}>
                {i % 2 === 0 && <Skeleton className="h-9 w-9 shrink-0 rounded-full" />}
                <Skeleton className={cn("h-14 rounded-2xl", i % 2 ? "w-2/5" : "w-3/5")} />
              </div>
            ))}
          </div>
        )}

        {!loading && !!error && (
          <div className="mx-auto max-w-md">
            <ErrorState message={errorMessage(error)} onRetry={() => void load()} />
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <EmptyState
            icon={<MessageSquare />}
            title="No messages yet"
            description={`Say hello to ${participant.firstName} to start the conversation.`}
          />
        )}

        {!loading && !error && items.length > 0 && (
          <div className="mx-auto max-w-3xl">
            {hasMore ? (
              <div className="flex justify-center pb-3">
                <Button size="sm" variant="outline" loading={olderLoading} onClick={loadOlderPreservingScroll}>
                  Load older messages
                </Button>
              </div>
            ) : (
              <p className="pb-3 text-center text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                Beginning of this conversation
              </p>
            )}

            <div aria-live="polite" aria-relevant="additions" aria-label={`Messages with ${name}`}>
              {groups.map((g) => (
                <section key={g.key} className="mb-1">
                  <h3 className="sticky top-0 z-10 flex justify-center py-2">
                    <span className="rounded-full border border-line bg-surface/95 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-ink-soft shadow-card backdrop-blur">
                      {g.label}
                    </span>
                  </h3>
                  <ul className="space-y-1">
                    {g.items.map((m, i) => (
                      <MessageRow
                        key={m.temp ? `temp-${m.id}` : m.id}
                        message={m}
                        participant={participant}
                        showAvatar={!m.fromMe && (!g.items[i + 1] || g.items[i + 1].senderId !== m.senderId)}
                        onReact={(x, r) => void react(x, r)}
                        onDelete={(x) => void remove(x)}
                        onRetry={retry}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        )}
      </div>

      <Composer placeholder={`Message ${participant.firstName}…`} onSend={send} onReactLast={reactToLastOwn} disabled={!!error} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Message row                                                                */
/* -------------------------------------------------------------------------- */

function MessageRow({
  message: m,
  participant,
  showAvatar,
  onReact,
  onDelete,
  onRetry,
}: {
  message: UiMessage;
  participant: Person;
  showAvatar: boolean;
  onReact: (m: UiMessage, reaction: string) => void;
  onDelete: (m: UiMessage) => void;
  onRetry: (m: UiMessage) => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const isMine = m.fromMe;
  const name = fullName(participant);
  const image = isImageMessage(m);
  const documentName = m.mediaUrl && !image ? m.attachmentName || "Attachment" : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.text);
      toast.success("Message copied");
    } catch {
      toast.error("Clipboard unavailable", "Your browser blocked the copy request.");
    }
  };

  return (
    <li className={cn("flex items-start gap-2 anim-fade-up", isMine ? "flex-row-reverse" : "flex-row")}>
      {isMine ? (
        <span className="w-8 shrink-0" aria-hidden />
      ) : showAvatar ? (
        <Link to={`/profile/${participant.username}`} className="mt-1 shrink-0" aria-label={`Open ${name}'s profile`}>
          <Avatar name={name} src={mediaUrl(participant.avatarUrl)} size="sm" />
        </Link>
      ) : (
        <span className="w-8 shrink-0" aria-hidden />
      )}

      <div className={cn("flex min-w-0 max-w-[min(86%,calc(100%-6rem))] flex-col sm:max-w-[72%]", isMine ? "items-end" : "items-start")}>
        {!isMine && showAvatar && (
          <Link to={`/profile/${participant.username}`} className="mb-0.5 text-[11px] font-bold text-ink-soft hover:text-accent">
            {name}
          </Link>
        )}

        <div className={cn("relative", m.reaction && "mb-4")}>
          <div
            className={cn(
              "rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed break-words",
              isMine ? "bg-accent text-white rounded-br-md" : "bg-surface-2 text-ink rounded-bl-md",
              m.temp && !m.failed && "opacity-75",
              m.failed && "opacity-80 ring-1 ring-danger"
            )}
          >
            {m.text && <p className="whitespace-pre-wrap">{m.text}</p>}

            {image && (
              <a href={mediaUrl(m.mediaUrl)} target="_blank" rel="noreferrer" className="mt-2 block overflow-hidden rounded-xl">
                <img src={mediaUrl(m.mediaUrl)} alt="Message attachment" loading="lazy" className="max-h-64 w-full max-w-xs object-cover" />
              </a>
            )}

            {documentName && (
              <a
                href={mediaUrl(m.mediaUrl)}
                download={documentName}
                className="mt-2 flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2 text-ink transition-colors hover:bg-surface-2"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  <Download size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold">{documentName}</span>
                  <span className="block text-[11px] text-ink-faint">Attachment · tap to download</span>
                </span>
              </a>
            )}

            {m.sharedListing && <SharedListing listing={m.sharedListing} />}
            {m.sharedProfile && <SharedProfile person={m.sharedProfile} />}

            <div className={cn("mt-1 flex items-center justify-end gap-1 text-[10px] font-semibold", isMine ? "text-white/80" : "text-ink-faint")}>
              <time dateTime={m.createdAt}>{clockTime(m.createdAt)}</time>
              {isMine && !m.temp && !m.failed &&
                (m.read ? (
                  <span className="inline-flex items-center" aria-label="Read">
                    <CheckCheck size={13} />
                  </span>
                ) : (
                  <span className="inline-flex items-center" aria-label="Sent">
                    <Check size={13} />
                  </span>
                ))}
              {m.temp && !m.failed && (
                <span className="inline-flex items-center gap-1" aria-label="Sending">
                  <Loader2 size={11} className="animate-spin" /> Sending…
                </span>
              )}
            </div>
          </div>

          {m.reaction && (
            <span
              className={cn(
                "absolute -bottom-3.5 rounded-full border border-line bg-surface px-1.5 py-0.5 text-[12px] shadow-card",
                isMine ? "left-1" : "right-1"
              )}
              role="img"
              aria-label={`${isMine ? "You" : name} reacted ${m.reaction}`}
            >
              {m.reaction}
            </span>
          )}
        </div>

        {m.failed && (
          <p className="mt-1 flex items-center gap-2 text-[11px] font-bold text-danger">
            <span>Not delivered</span>
            <button
              onClick={() => onRetry(m)}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-danger px-2 text-[11px] font-bold hover:bg-danger-soft"
            >
              <RefreshCw size={12} /> Retry
            </button>
          </p>
        )}
      </div>

      {!m.temp && (
        <Dropdown
          align={isMine ? "right" : "left"}
          trigger={({ open, toggle }) => (
            <button
              onClick={toggle}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={`Message options${isMine ? "" : ` from ${name}`}`}
              className={cn(
                "mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink",
                open && "bg-surface-2 text-ink"
              )}
            >
              <MoreVertical size={16} />
            </button>
          )}
        >
          {(close) => (
            <>
              <p className="px-3 pb-1 pt-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-faint">React</p>
              <div className="flex flex-wrap gap-0.5 px-2 pb-1.5">
                {REACTIONS.map((r) => (
                  <button
                    key={r}
                    onClick={() => { onReact(m, r); close(); }}
                    aria-label={`React with ${r}`}
                    className={cn("flex h-9 w-9 items-center justify-center rounded-full text-lg transition-transform hover:scale-125", m.reaction === r && "bg-accent-soft")}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <div className="my-1 border-t border-line" />
              {m.text && (
                <MenuItem icon={<Copy size={15} />} onClick={() => { void copy(); close(); }}>
                  Copy text
                </MenuItem>
              )}
              {!isMine && (
                <MenuItem icon={<UserIcon size={15} />} onClick={() => { navigate(`/profile/${participant.username}`); close(); }}>
                  View profile
                </MenuItem>
              )}
              {isMine && (
                <MenuItem icon={<Trash2 size={15} />} danger onClick={() => { onDelete(m); close(); }}>
                  Delete message
                </MenuItem>
              )}
            </>
          )}
        </Dropdown>
      )}
    </li>
  );
}

function SharedListing({ listing }: { listing: Listing }) {
  return (
    <Link to={`/marketplace/${listing.id}`} className="mt-2 flex gap-2.5 rounded-xl border border-line bg-surface p-2 text-ink transition-colors hover:bg-surface-2">
      <span className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-surface-2">
        {listing.images[0] ? (
          <img src={mediaUrl(listing.images[0])} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-ink-faint">
            <ShoppingBag size={16} />
          </span>
        )}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <Badge tone={listing.kind === "service" ? "accent" : "neutral"}>{listing.kind}</Badge>
          <span className="truncate text-[11px] text-ink-faint">{listing.location}</span>
        </span>
        <span className="mt-0.5 block truncate text-[13px] font-bold">{listing.title}</span>
        <span className="block text-[13px] font-extrabold text-accent">{formatPrice(listing.price, listing.priceType, listing.currency)}</span>
      </span>
    </Link>
  );
}

function SharedProfile({ person }: { person: Person }) {
  const name = fullName(person);
  return (
    <Link to={`/profile/${person.username}`} className="mt-2 flex items-center gap-2.5 rounded-xl border border-line bg-surface p-2 text-ink transition-colors hover:bg-surface-2">
      <Avatar name={name} src={mediaUrl(person.avatarUrl)} size="md" />
      <span className="min-w-0">
        <span className="flex items-center gap-1 text-[13px] font-bold">
          <span className="truncate">{name}</span>
          {person.verified && <VerifiedBadge color={person.verifiedColor} size={12} />}
        </span>
        <span className="block truncate text-[11px] text-ink-soft">{person.title}</span>
      </span>
      <span className="ml-auto shrink-0 text-[11px] font-semibold text-accent">View profile</span>
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/*  Composer                                                                   */
/* -------------------------------------------------------------------------- */

interface PendingAttachment {
  url: string;
  name: string;
  type: "image" | "document";
}

function Composer({
  placeholder,
  onSend,
  onReactLast,
  disabled,
}: {
  placeholder: string;
  onSend: (payload: { text: string; mediaUrl?: string; attachmentName?: string }) => Promise<void>;
  onReactLast: (reaction: string) => void;
  disabled?: boolean;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

  const pickFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error("File is too large", "Attachments are limited to 5 MB.");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      const res = await messagingApi.upload(file);
      setAttachment({ url: res.url, name: res.name || file.name, type: res.type });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const submit = async () => {
    const body = text.trim();
    if ((!body && !attachment) || uploading || sending || disabled) return;
    const payload = {
      text: body,
      mediaUrl: attachment?.url,
      attachmentName: attachment?.type === "document" ? attachment.name : undefined,
    };
    const pendingAttachment = attachment;
    setSending(true);
    setText("");
    setAttachment(null);
    try {
      await onSend(payload);
    } catch {
      setText((cur) => (cur === "" ? payload.text : cur));
      setAttachment((cur) => (cur === null ? pendingAttachment : cur));
    } finally {
      setSending(false);
      areaRef.current?.focus();
    }
  };

  return (
    <div className="shrink-0 border-t border-line bg-surface px-2.5 py-2.5 sm:px-4 safe-bottom">
      {attachment && (
        <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2.5 rounded-xl border border-line bg-surface-2 p-2">
          {attachment.type === "image" ? (
            <img src={mediaUrl(attachment.url)} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
          ) : (
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <Download size={17} />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold">{attachment.name}</span>
            <span className="block text-[11px] text-ink-faint">{uploading ? "Uploading…" : "Ready to send"}</span>
          </span>
          <button
            onClick={() => setAttachment(null)}
            aria-label="Remove attachment"
            className="flex h-10 w-10 items-center justify-center rounded-xl text-ink-soft transition-colors hover:bg-surface hover:text-danger"
          >
            <X size={17} />
          </button>
        </div>
      )}

      <div className="mx-auto flex max-w-3xl items-end gap-1.5">
        <input ref={fileRef} type="file" accept="image/*,application/pdf" hidden onChange={(e) => void pickFile(e.target.files)} />

        <Tooltip label="Attach a photo or PDF">
          <button
            onClick={() => fileRef.current?.click()}
            aria-label="Attach a file"
            disabled={uploading}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-soft transition-colors hover:bg-surface-2 hover:text-accent disabled:opacity-50"
          >
            {uploading ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
          </button>
        </Tooltip>

        <textarea
          ref={areaRef}
          aria-label="Write a message"
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={placeholder}
          className="min-h-10 max-h-[168px] w-full min-w-0 flex-1 resize-none rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />

        <Dropdown
          align="right"
          trigger={({ open, toggle }) => (
            <button
              onClick={toggle}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label="React to your last message"
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-soft transition-colors hover:bg-surface-2 hover:text-accent",
                open && "bg-surface-2 text-accent"
              )}
            >
              <Smile size={19} />
            </button>
          )}
        >
          {(close) => (
            <>
              <p className="px-3 pb-1 pt-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-faint">React to your last message</p>
              <div className="flex gap-0.5 p-1.5">
                {REACTIONS.map((r) => (
                  <button
                    key={r}
                    onClick={() => { onReactLast(r); close(); }}
                    aria-label={`React ${r}`}
                    className="flex h-10 w-10 items-center justify-center rounded-full text-xl transition-transform hover:scale-125"
                  >
                    {r}
                  </button>
                ))}
              </div>
            </>
          )}
        </Dropdown>

        <Button size="icon" onClick={() => void submit()} loading={sending} disabled={(!text.trim() && !attachment) || uploading || !!disabled} aria-label="Send message" className="shrink-0">
          <Send size={18} />
        </Button>
      </div>

      <p className="mx-auto mt-1.5 max-w-3xl text-[11px] text-ink-faint">Enter sends · Shift + Enter adds a line</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Contact panel                                                              */
/* -------------------------------------------------------------------------- */

function ContactPanel({
  person,
  online,
  onRefresh,
  onReport,
  onClose,
}: {
  person: Person;
  online?: boolean;
  onRefresh: () => void;
  onReport: (p: Person) => void;
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const data = useAsync(() => usersApi.byUsername(person.username), [person.username]);
  const name = fullName(person);
  const profile = data.data?.profile ?? null;
  const listings = useMemo(() => [...(data.data?.services ?? []), ...(data.data?.products ?? [])], [data.data]);
  const reviews = data.data?.reviews ?? [];
  const rating = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3.5 py-3">
        <h2 className="text-sm font-extrabold">Contact</h2>
        <div className="flex items-center gap-0.5">
          <Dropdown
            trigger={({ open, toggle }) => (
              <button
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`Options for ${name}`}
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-xl text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink",
                  open && "bg-surface-2 text-ink"
                )}
              >
                <MoreVertical size={18} />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem icon={<UserIcon size={15} />} onClick={() => { navigate(`/profile/${person.username}`); close(); }}>
                  View full profile
                </MenuItem>
                <MenuItem
                  icon={<Copy size={15} />}
                  onClick={() => {
                    void navigator.clipboard?.writeText(`${window.location.origin}/profile/${person.username}`);
                    toast.success("Profile link copied");
                    close();
                  }}
                >
                  Copy profile link
                </MenuItem>
                <MenuItem icon={<Flag size={15} />} danger onClick={() => { onReport(person); close(); }}>
                  Report this conversation
                </MenuItem>
              </>
            )}
          </Dropdown>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close contact details"
              className="flex h-10 w-10 items-center justify-center rounded-xl text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3.5">
        <div className="overflow-hidden rounded-2xl border border-line">
          <div className="h-16 bg-gradient-to-br from-[#0B5CD8] to-[#22C0FF]" aria-hidden />
          <div className="px-3.5 pb-3.5">
            <div className="-mt-8 flex items-end gap-2.5">
              <Avatar name={name} src={mediaUrl(person.avatarUrl)} size="lg" ring className="shadow" />
              {online && <OnlineDot className="mb-1" />}
            </div>
            <p className="mt-2 flex items-center gap-1.5 text-sm font-extrabold">
              <span className="truncate">{name}</span>
              {person.verified && <VerifiedBadge color={person.verifiedColor} size={14} />}
            </p>
            <p className="text-xs text-ink-soft">{person.title || `@${person.username}`}</p>
            {person.company && <p className="text-[11px] text-ink-faint">{person.company}</p>}
            <p className={cn("mt-1 text-[11px] font-semibold", online ? "text-success" : "text-ink-faint")}>{online ? "Active now" : "Offline"}</p>
          </div>
        </div>

        <PersonCard person={withAvatar(person)} onChanged={onRefresh} />

        {data.loading && (
          <div className="space-y-3" aria-label="Loading contact details">
            <Skeleton className="h-16" />
            <Skeleton className="h-24" />
            <Skeleton className="h-44" />
          </div>
        )}

        {data.error && !data.loading && <ErrorState message={errorMessage(data.error)} onRetry={data.refetch} />}

        {data.data && !data.loading && !data.error && (
          <>
            <section className="space-y-2">
              {profile?.bio && <p className="text-[13px] leading-relaxed text-ink-soft">{profile.bio}</p>}
              <ul className="space-y-1 text-xs text-ink-soft">
                {(profile?.location || person.location) && (
                  <li className="flex items-center gap-2">
                    <MapPin size={13} className="text-ink-faint" /> {profile?.location || person.location}
                  </li>
                )}
                {profile?.website && (
                  <li>
                    <a
                      href={/^https?:\/\//i.test(profile.website) ? profile.website : `https://${profile.website}`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 font-semibold text-accent hover:underline"
                    >
                      <Globe size={13} aria-hidden /> {profile.website.replace(/^https?:\/\//, "")}
                    </a>
                  </li>
                )}
                {person.mutualConnections > 0 && (
                  <li className="flex items-center gap-2">
                    <Users size={13} className="text-ink-faint" /> {person.mutualConnections} mutual connection
                    {person.mutualConnections === 1 ? "" : "s"}
                  </li>
                )}
              </ul>
              {reviews.length > 0 && <StarRating value={rating} count={reviews.length} />}
            </section>

            <section aria-label="Profile stats" className="grid grid-cols-3 gap-1 rounded-xl border border-line p-2 text-center">
              {[
                { label: "Posts", value: data.data.stats.posts },
                { label: "Followers", value: data.data.stats.followers },
                { label: "Connections", value: data.data.stats.connections },
              ].map((s) => (
                <div key={s.label}>
                  <p className="text-sm font-extrabold">{formatNumber(s.value)}</p>
                  <p className="text-[11px] text-ink-faint">{s.label}</p>
                </div>
              ))}
            </section>

            {profile?.skills?.length ? (
              <section>
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-faint">Skills</p>
                <div className="flex flex-wrap gap-1.5">
                  {profile.skills.slice(0, 8).map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                </div>
              </section>
            ) : null}

            <section>
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
                Shared listings{listings.length > 0 ? ` · ${listings.length}` : ""}
              </p>
              {listings.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-xs text-ink-soft">
                  {person.firstName} hasn't published a listing yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {listings.slice(0, 3).map((l) => (
                    <ListingCard key={l.id} listing={withListingImage(l)} />
                  ))}
                  {listings.length > 3 && (
                    <Button variant="outline" size="sm" fullWidth onClick={() => navigate(`/profile/${person.username}`)}>
                      See all {listings.length} listings
                    </Button>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  New conversation                                                           */
/* -------------------------------------------------------------------------- */

function NewConversationModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: Conversation) => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Person | null>(null);
  const [firstMessage, setFirstMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const debounced = useDebounced(q.trim(), 300);

  const connections = useAsync(() => (open ? networkApi.connections({ pageSize: 24 }) : Promise.resolve(null)), [open]);
  const searched = useAsync(
    () => (open && debounced ? searchApi.suggestions(debounced).then((r) => r.people) : Promise.resolve(null)),
    [open, debounced]
  );

  const people = useMemo<Person[]>(() => {
    if (debounced) return searched.data ?? [];
    return connections.data?.items ?? [];
  }, [debounced, searched.data, connections.data]);

  const listLoading = debounced ? searched.loading : connections.loading;

  const close = () => {
    setQ("");
    setSelected(null);
    setFirstMessage("");
    onClose();
  };

  const start = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const c = await messagingApi.start(selected.id, firstMessage.trim() || undefined);
      toast.success(`Conversation started with ${fullName(selected)}`);
      setQ("");
      setSelected(null);
      setFirstMessage("");
      onCreated(c);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      mobileSheet
      title={selected ? `Message ${fullName(selected)}` : "New message"}
      footer={
        selected ? (
          <>
            <Button variant="ghost" onClick={() => setSelected(null)}>
              Change person
            </Button>
            <Button onClick={() => void start()} loading={busy}>
              <Send size={15} /> Send
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            onClick={() => {
              onClose();
              navigate("/network");
            }}
          >
            Browse people
          </Button>
        )
      }
    >
      {selected ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-xl border border-line p-3">
            <Avatar name={fullName(selected)} src={mediaUrl(selected.avatarUrl)} size="md" />
            <div className="min-w-0">
              <p className="flex items-center gap-1 truncate text-sm font-bold">
                <span className="truncate">{fullName(selected)}</span>
                {selected.verified && <VerifiedBadge color={selected.verifiedColor} size={13} />}
              </p>
              <p className="truncate text-xs text-ink-soft">{selected.title || `@${selected.username}`}</p>
            </div>
          </div>
          <Textarea
            label="Your message"
            rows={4}
            autoFocus
            value={firstMessage}
            onChange={(e) => setFirstMessage(e.target.value.slice(0, 2000))}
            placeholder={`Hi ${selected.firstName}, …`}
          />
          <p className="text-xs text-ink-faint">Optional — you can open the thread without a message.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <Input
            aria-label="Search people"
            icon={<Search size={15} />}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, title or skill"
          />

          {listLoading && (
            <ul className="space-y-2" aria-label="Loading people">
              {Array.from({ length: 4 }).map((_, i) => (
                <li key={i} className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3 w-1/3" />
                    <Skeleton className="h-2.5 w-1/2" />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {!listLoading && people.length > 0 && (
            <ul className="space-y-1">
              {people.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => setSelected(p)}
                    className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-surface-2"
                  >
                    <Avatar name={fullName(p)} src={mediaUrl(p.avatarUrl)} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold">{fullName(p)}</span>
                        {p.verified && <VerifiedBadge color={p.verifiedColor} size={12} />}
                      </span>
                      <span className="block truncate text-xs text-ink-soft">{p.title || `@${p.username}`}</span>
                    </span>
                    {p.connectionStatus === "connected" && <Badge tone="success">Connected</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!listLoading && people.length === 0 && (
            <EmptyState
              icon={<Users />}
              title={debounced ? "No people found" : "No connections yet"}
              description={
                debounced
                  ? `No one matches “${debounced}”. Check the spelling or try another name.`
                  : "Connect with people first, then bring them into a conversation."
              }
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    onClose();
                    navigate("/network");
                  }}
                >
                  Go to My Network
                </Button>
              }
            />
          )}
        </div>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Report dialog                                                              */
/* -------------------------------------------------------------------------- */

const REPORT_REASONS = [
  { value: "spam", label: "Spam or scam" },
  { value: "harassment", label: "Harassment or bullying" },
  { value: "fraud", label: "Fraudulent listing or payment" },
  { value: "misinformation", label: "False information" },
  { value: "other", label: "Something else" },
];

function ReportModal({ person, onClose }: { person: Person | null; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState<string>(REPORT_REASONS[0].value);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!person) return;
    if (details.trim().length < 10) {
      toast.error("Add a little more detail", "Describe what happened in at least 10 characters so the team can act.");
      return;
    }
    setBusy(true);
    try {
      const label = REPORT_REASONS.find((r) => r.value === reason)?.label ?? reason;
      await supportApi.create({
        subject: `Report: ${fullName(person)} (@${person.username})`,
        category: "Report",
        text: `Reason: ${label}\n\n${details.trim()}`,
      });
      toast.success("Report submitted", "Our trust team will review this conversation.");
      setDetails("");
      setReason(REPORT_REASONS[0].value);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!person}
      onClose={onClose}
      title={person ? `Report ${fullName(person)}` : "Report"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={busy}>
            <Flag size={15} /> Submit report
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-soft">Reports open a support ticket for our trust team. You'll get a reply in your Support inbox.</p>
        <Select label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} options={REPORT_REASONS} />
        <Textarea label="What happened?" rows={4} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Share the context — messages, listings or behaviour that concerned you." />
      </div>
    </Modal>
  );
}
