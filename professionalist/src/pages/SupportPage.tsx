import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Bug,
  CheckCircle2,
  Clock,
  Flag,
  Headphones,
  Loader2,
  Megaphone,
  MessageSquarePlus,
  Paperclip,
  Paperclip as PaperclipIcon,
  Plus,
  RotateCw,
  Send,
  ShieldAlert,
  ShoppingBag,
  Wallet,
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
  Modal,
  Select,
  Skeleton,
  Textarea,
  Tooltip,
} from "@/components/ui";
import { useToast } from "@/context/ToastContext";
import { errorMessage, useAsync } from "@/hooks/useAsync";
import { messagingApi, supportApi } from "@/services/api";
import { ApiError, mediaUrl } from "@/services/http";
import type { SupportTicket } from "@/services/types";
import { cn, timeAgo } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/*  Local helpers                                                              */
/* -------------------------------------------------------------------------- */

type Tone = NonNullable<React.ComponentProps<typeof Badge>["tone"]>;
type TicketMessage = SupportTicket["messages"][number];

const STATUS_LABEL: Record<SupportTicket["status"], string> = {
  open: "Open",
  pending: "Awaiting you",
  resolved: "Resolved",
};

const STATUS_TONE: Record<SupportTicket["status"], Tone> = {
  open: "accent",
  pending: "warn",
  resolved: "success",
};

const CATEGORIES = [
  "General",
  "Marketplace & orders",
  "Payments & payouts",
  "Advertising & billing",
  "Account & security",
  "Reports & moderation",
  "Technical issue",
];

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif)(\?|#|$)/i;

function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** True from 1024px up — used to decide drawer vs split pane without a second data source. */
function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(min-width: 1024px)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => setDesktop(e.matches);
    mq.addEventListener("change", onChange);
    setDesktop(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return desktop;
}

/* -------------------------------------------------------------------------- */
/*  Availability banner                                                        */
/* -------------------------------------------------------------------------- */

function AvailabilityBanner() {
  const { data, loading, error, refetch } = useAsync(() => supportApi.availability(), []);

  if (loading) {
    return (
      <Card className="flex items-center gap-4 p-4">
        <Skeleton className="h-10 w-10 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3 w-44" />
          <Skeleton className="h-2.5 w-60" />
        </div>
        <Skeleton className="hidden h-8 w-28 rounded-full sm:block" />
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <AlertTriangle size={18} className="text-warn" aria-hidden />
        <p className="min-w-0 flex-1 text-sm text-ink-soft">
          {error ? errorMessage(error) : "We could not reach the support status service."}
        </p>
        <Button size="sm" variant="outline" onClick={refetch}>
          <RotateCw size={14} /> Try again
        </Button>
      </Card>
    );
  }

  return (
    <Card className="flex flex-wrap items-center gap-x-5 gap-y-3 p-4 anim-fade-up">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent" aria-hidden>
        <Headphones size={19} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-bold">
          <span
            className={cn(
              "inline-block h-2 w-2 shrink-0 rounded-full",
              data.online ? "bg-success animate-pulse" : "bg-ink-faint"
            )}
            aria-hidden
          />
          {data.online ? "Support team is online" : "Support team is offline"}
          <span className="text-[11px] font-semibold text-ink-faint">· Team of {data.agents.length}</span>
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-soft">
          <span className="flex items-center gap-1.5">
            <Clock size={12} aria-hidden />
            {data.hours}
          </span>
          <span className="flex items-center gap-1.5">
            <CheckCircle2 size={12} aria-hidden />
            Typical first reply {data.avgResponse}
          </span>
        </p>
      </div>

      <ul className="flex items-center gap-2" aria-label="Support agents">
        {data.agents.map((a) => (
          <li key={a.name}>
            <Tooltip label={`${a.name} · ${a.role}`}>
              <span className="flex items-center gap-2 rounded-full border border-line bg-surface-2/60 py-1 pl-1 pr-3">
                <Avatar name={a.name} src={mediaUrl(a.avatarUrl)} size="xs" />
                <span className="hidden text-xs font-semibold sm:inline">{a.name.split(" ")[0]}</span>
              </span>
            </Tooltip>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Thread + reply                                                             */
/* -------------------------------------------------------------------------- */

function Attachment({ url, label }: { url: string; label: string }) {
  if (IMAGE_RE.test(url)) {
    return (
      <a href={mediaUrl(url)} target="_blank" rel="noreferrer" className="mt-2 block max-w-[220px]">
        <img
          src={mediaUrl(url)}
          alt={label}
          loading="lazy"
          className="w-full rounded-xl border border-line object-cover"
        />
      </a>
    );
  }
  return (
    <a
      href={mediaUrl(url)}
      target="_blank"
      rel="noreferrer"
      className="mt-2 inline-flex min-h-10 items-center gap-2 rounded-xl border border-line bg-surface-2/60 px-3 text-xs font-semibold hover:border-line-strong"
    >
      <PaperclipIcon size={13} aria-hidden />
      <span className="truncate">Open attachment</span>
    </a>
  );
}

function Thread({ messages }: { messages: TicketMessage[] }) {
  return (
    <ul className="space-y-4" aria-live="polite">
      {messages.map((m) => (
        <li key={m.id} className={cn("flex gap-2.5 anim-fade-up", m.fromUser && "flex-row-reverse")}>
          <span
            className={cn(
              "mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
              m.fromUser ? "bg-accent text-accent-ink" : "bg-accent-soft text-accent"
            )}
            aria-hidden
          >
            {m.fromUser ? "You" : <Headphones size={15} />}
          </span>
          <div className={cn("min-w-0 max-w-[85%]", m.fromUser && "text-right")}>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              {m.fromUser ? "You" : "Professionalist support"} · {clockTime(m.createdAt)}
            </p>
            <div
              className={cn(
                "mt-1 inline-block whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-left text-[14.5px] leading-relaxed",
                m.fromUser
                  ? "rounded-br-md bg-accent text-accent-ink"
                  : "rounded-tl-md border border-line bg-surface-2/60"
              )}
            >
              {m.text}
              {m.attachmentUrl && <Attachment url={m.attachmentUrl} label={`Attachment on ticket message ${m.id}`} />}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

interface Draft {
  url: string;
  name: string;
  type: "image" | "document";
}

function ReplyComposer({ onSend }: { onSend: (text: string, attachment?: Draft) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const res = await messagingApi.upload(file);
      setAttachment({ url: res.url, name: res.name, type: res.type });
    } catch (e) {
      toast.error("Upload failed", errorMessage(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const submit = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      const ok = await onSend(text.trim(), attachment ?? undefined);
      if (ok) {
        setText("");
        setAttachment(null);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t border-line p-3 safe-bottom">
      <input ref={fileRef} type="file" className="sr-only" aria-label="Attach a file to your reply" onChange={(e) => void upload(e.target.files?.[0])} />
      {attachment && (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-line bg-surface-2/60 px-3 py-2 text-xs">
          <Paperclip size={13} className="shrink-0 text-accent" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-semibold">{attachment.name}</span>
          <button onClick={() => setAttachment(null)} aria-label="Remove attachment" className="flex h-10 w-10 items-center justify-center rounded-lg text-ink-faint hover:text-danger">
            <X size={14} />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <label htmlFor="ticket-reply" className="sr-only">
          Reply to support
        </label>
        <textarea
          id="ticket-reply"
          ref={taRef}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Write your reply…"
          disabled={sending}
          className="max-h-36 min-h-11 w-full flex-1 resize-none rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-[var(--ring)] focus:outline-none transition-colors disabled:opacity-60"
        />
        <button
          onClick={() => fileRef.current?.click()}
          aria-label="Attach a document or image"
          disabled={busy}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
        >
          {busy ? <Loader2 size={17} className="animate-spin" /> : <Paperclip size={17} />}
        </button>
        <Button size="icon" className="h-11 w-11 shrink-0" onClick={() => void submit()} loading={sending} disabled={!text.trim()} aria-label="Send reply">
          {!sending && <Send size={17} />}
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-ink-faint">Enter sends · Shift + Enter adds a line</p>
    </div>
  );
}

function TicketDetail({
  ticket,
  onReply,
}: {
  ticket: SupportTicket;
  onReply: (id: number, text: string, attachment?: Draft) => Promise<boolean>;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-line p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[ticket.status]}>{STATUS_LABEL[ticket.status]}</Badge>
          <Badge>{ticket.category}</Badge>
          <span className="ml-auto text-[11px] text-ink-faint">Updated {timeAgo(ticket.updatedAt)} ago</span>
        </div>
        <h2 className="mt-2 text-base font-extrabold leading-snug">{ticket.subject}</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <Thread messages={ticket.messages} />
      </div>
      <ReplyComposer onSend={(text, attachment) => onReply(ticket.id, text, attachment)} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  New ticket modal                                                           */
/* -------------------------------------------------------------------------- */

interface TicketDraft {
  category: string;
  subject: string;
  text: string;
}

function NewTicketModal({
  initial,
  onClose,
  onCreated,
}: {
  initial: TicketDraft;
  onClose: () => void;
  onCreated: (ticket: SupportTicket) => void;
}) {
  const toast = useToast();
  const [state, setState] = useState<TicketDraft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attachment, setAttachment] = useState<Draft | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = (key: keyof TicketDraft, value: string) => {
    setState((s) => ({ ...s, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const res = await messagingApi.upload(file);
      setAttachment({ url: res.url, name: res.name, type: res.type });
    } catch (e) {
      toast.error("Upload failed", errorMessage(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const submit = async () => {
    const found: Record<string, string> = {};
    if (state.subject.trim().length < 4) found.subject = "Add a subject with at least 4 characters.";
    if (state.text.trim().length < 25) found.text = "Please describe the issue in at least 25 characters so we can help fast.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSaving(true);
    try {
      const created = await supportApi.create({
        subject: state.subject.trim(),
        category: state.category,
        text: state.text.trim(),
        attachmentUrl: attachment?.url,
      });
      toast.success("Conversation started", "Support has your ticket and will reply here.");
      onCreated(created);
    } catch (e) {
      const fieldErrors = e instanceof ApiError ? e.fieldErrors : {};
      if (Object.keys(fieldErrors).length > 0) setErrors(fieldErrors);
      else toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      mobileSheet
      size="md"
      title="Start a support conversation"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            Send to support
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Select
          id="ticket-category"
          label="Category"
          value={state.category}
          onChange={(e) => set("category", e.target.value)}
          options={CATEGORIES.map((c) => ({ value: c, label: c }))}
        />
        <Input
          id="ticket-subject"
          label="Subject"
          placeholder="Payout for order MK-8841 missing"
          value={state.subject}
          error={errors.subject}
          onChange={(e) => set("subject", e.target.value)}
        />
        <div>
          <Textarea
            id="ticket-text"
            label="What happened?"
            rows={5}
            placeholder="Tell us what you expected, what you saw, and any reference numbers."
            value={state.text}
            error={errors.text}
            onChange={(e) => set("text", e.target.value)}
          />
          {!errors.text && (
            <p className="mt-1 text-xs text-ink-faint">{state.text.trim().length} characters · 25 minimum</p>
          )}
        </div>
        <div>
          <span className="block text-[13px] font-semibold mb-1.5">Document or screenshot (optional)</span>
          <input
            ref={fileRef}
            id="ticket-file"
            type="file"
            className="sr-only"
            onChange={(e) => void upload(e.target.files?.[0])}
          />
          {attachment ? (
            <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-2/60 px-3 py-2.5 text-sm">
              <Paperclip size={14} className="shrink-0 text-accent" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
              <button onClick={() => setAttachment(null)} aria-label="Remove attachment" className="flex h-10 w-10 items-center justify-center rounded-lg text-ink-faint hover:text-danger">
                <X size={15} />
              </button>
            </div>
          ) : (
            <Button variant="outline" size="sm" loading={uploading} onClick={() => fileRef.current?.click()}>
              {!uploading && <Plus size={14} />} {uploading ? "Uploading…" : "Attach file"}
            </Button>
          )}
        </div>
        <p className="text-xs text-ink-faint">
          A real person reads every ticket. Anything you attach stays private to you and the support team.
        </p>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Quick help                                                                 */
/* -------------------------------------------------------------------------- */

const QUICK_HELP: { title: string; body: string; icon: typeof Bug; draft: TicketDraft }[] = [
  {
    title: "Order not delivered",
    icon: ShoppingBag,
    draft: {
      category: "Marketplace & orders",
      subject: "My order has not arrived",
      text: "Hi support, I placed an order in the marketplace and it has not been delivered or updated. Order reference: ",
    },
    body: "Tracking and delivery problems",
  },
  {
    title: "Payout or payment question",
    icon: Wallet,
    draft: {
      category: "Payments & payouts",
      subject: "Missing payout for a sale",
      text: "Hi support, I would like help with a payout. The sale happened on (date) and the amount was (amount). Reference: ",
    },
    body: "Payouts, invoices and refunds",
  },
  {
    title: "Campaign spend question",
    icon: Megaphone,
    draft: {
      category: "Advertising & billing",
      subject: "Question about my campaign spend",
      text: "Hi support, I have a question about advertising billing. Campaign name: ",
    },
    body: "Budgets, charges and delivery",
  },
  {
    title: "Account or security issue",
    icon: ShieldAlert,
    draft: {
      category: "Account & security",
      subject: "I cannot access my account properly",
      text: "Hi support, something is wrong with my account. What happened, and when it started: ",
    },
    body: "Sign-in, verification, sessions",
  },
  {
    title: "Report a listing or profile",
    icon: Flag,
    draft: {
      category: "Reports & moderation",
      subject: "Report a listing or profile",
      text: "Hi support, I want to report content. The link is: \nWhy it breaks the rules: ",
    },
    body: "Counterfeits, spam, harassment",
  },
  {
    title: "Something is broken",
    icon: Bug,
    draft: {
      category: "Technical issue",
      subject: "A feature is not working",
      text: "Hi support, a feature is not working as expected. What I did, what happened, and my device/browser: ",
    },
    body: "Errors, upload failures, display bugs",
  },
];

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function SupportPage() {
  const toast = useToast();
  const desktop = useIsDesktop();
  const { data, loading, error, refetch, setData } = useAsync(() => supportApi.tickets(), []);
  const tickets = useMemo(() => data ?? [], [data]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modal, setModal] = useState<TicketDraft | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);

  /* Keep a sensible selection once the list lands. */
  useEffect(() => {
    if (loading || error) return;
    if (selectedId && tickets.some((t) => t.id === selectedId)) return;
    setSelectedId(tickets[0]?.id ?? null);
  }, [error, loading, selectedId, tickets]);

  const selected = tickets.find((t) => t.id === selectedId) ?? null;

  const patchTicket = (id: number, updater: (t: SupportTicket) => SupportTicket) => {
    setData((prev) => (prev ?? []).map((t) => (t.id === id ? updater(t) : t)));
  };

  const scheduleRefresh = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => refetch(), 3200);
  };

  const openTicket = (id: number) => {
    setSelectedId(id);
    if (!desktop) setDrawerOpen(true);
  };

  const reply = async (id: number, text: string, attachment?: Draft) => {
    const stamp = new Date().toISOString();
    const tempId = -Date.now();
    const temp: TicketMessage = { id: tempId, fromUser: true, text, attachmentUrl: attachment?.url ?? "", createdAt: stamp };

    patchTicket(id, (t) => ({ ...t, updatedAt: stamp, messages: [...t.messages, temp] }));
    try {
      const saved = await supportApi.reply(id, text, attachment?.url);
      patchTicket(id, () => saved);
      toast.success("Reply sent", "The support team has been notified.");
      scheduleRefresh();
      return true;
    } catch (e) {
      patchTicket(id, (t) => ({ ...t, messages: t.messages.filter((m) => m.id !== tempId) }));
      toast.error("Reply failed", errorMessage(e));
      return false;
    }
  };

  const onCreated = (created: SupportTicket) => {
    setData((prev) => [created, ...(prev ?? [])]);
    setModal(null);
    setSelectedId(created.id);
    if (!desktop) setDrawerOpen(true);
    scheduleRefresh();
  };

  const sortedTickets = useMemo(
    () => [...tickets].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [tickets]
  );

  const ticketList = (
    <>
      {loading && (
        <ul className="divide-y divide-line">
          {[0, 1, 2].map((i) => (
            <li key={i} className="space-y-2 p-4" aria-hidden>
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-2.5 w-1/3" />
            </li>
          ))}
        </ul>
      )}

      {!loading && error && <ErrorState message={errorMessage(error)} onRetry={refetch} />}

      {!loading && !error && tickets.length === 0 && (
        <div className="p-3">
          <EmptyState
            icon={<MessageSquarePlus />}
            title="No conversations yet"
            description="Start a conversation and a support specialist will pick it up during working hours."
            action={
              <Button onClick={() => setModal({ category: CATEGORIES[0], subject: "", text: "" })}>
                <MessageSquarePlus size={16} /> Start a support conversation
              </Button>
            }
          />
        </div>
      )}

      {!loading && !error && (
        <ul className="divide-y divide-line">
          {sortedTickets.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => openTicket(t.id)}
                aria-current={t.id === selectedId}
                className={cn(
                  "flex w-full flex-col gap-1.5 px-4 py-3.5 text-left transition-colors hover:bg-surface-2/60",
                  t.id === selectedId && "bg-accent-soft/60 hover:bg-accent-soft/70"
                )}
              >
                <span className="flex items-start gap-2">
                  <span className={cn("min-w-0 flex-1 truncate text-sm font-bold", t.id === selectedId && "text-accent")}>
                    {t.subject}
                  </span>
                  <Badge tone={STATUS_TONE[t.status]} className="shrink-0">
                    {STATUS_LABEL[t.status]}
                  </Badge>
                </span>
                <span className="flex items-center gap-2 text-[11px] text-ink-soft">
                  <span className="truncate">{t.category}</span>
                  <span className="text-ink-faint">·</span>
                  <span className="shrink-0">{timeAgo(t.updatedAt)} ago</span>
                </span>
                <span className="line-clamp-1 text-xs text-ink-faint">
                  {t.messages[t.messages.length - 1]?.text || "No messages yet"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return (
    <div className="mt-12 space-y-4 sm:mt-0">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
            <Headphones size={20} className="text-accent" aria-hidden />
            Human support
          </h1>
          <p className="mt-1 text-sm text-ink-soft">Real people, not bots. Ticket history stays here.</p>
        </div>
        <Button onClick={() => setModal({ category: CATEGORIES[0], subject: "", text: "" })}>
          <MessageSquarePlus size={16} /> Start a support conversation
        </Button>
      </header>

      <AvailabilityBanner />

      <section className="grid gap-4 lg:items-start lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* Ticket list */}
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-bold">Your conversations</h2>
            <span className="text-[11px] text-ink-faint">{loading ? "…" : tickets.length}</span>
          </div>
          <div className="max-h-[380px] overflow-y-auto lg:max-h-[560px]">{ticketList}</div>
        </Card>

        {/* Split pane detail (desktop) */}
        <Card className="hidden min-h-[420px] flex-col overflow-hidden lg:flex">
          {loading ? (
            <div className="space-y-4 p-4" aria-hidden>
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-16 w-full rounded-2xl" />
              <Skeleton className="ml-auto h-16 w-2/3 rounded-2xl" />
              <Skeleton className="h-10 w-full rounded-xl" />
            </div>
          ) : error ? (
            <ErrorState message={errorMessage(error)} onRetry={refetch} />
          ) : selected ? (
            <TicketDetail ticket={selected} onReply={reply} />
          ) : (
            <EmptyState
              icon={<MessageSquarePlus />}
              title="Nothing selected"
              description="Pick a conversation on the left, or start a new one."
              action={
                <Button variant="outline" onClick={() => setModal({ category: CATEGORIES[0], subject: "", text: "" })}>
                  Start a conversation
                </Button>
              }
            />
          )}
        </Card>

        {/* Mobile: same detail inside a drawer */}
        <Drawer open={drawerOpen && !desktop && !!selected} onClose={() => setDrawerOpen(false)} label="Support conversation" width="sm:max-w-xl">
          {selected && (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5 lg:hidden">
                <Button variant="ghost" size="sm" onClick={() => setDrawerOpen(false)}>
                  <ArrowLeft size={14} /> Back
                </Button>
                <span className="truncate text-xs font-bold">Ticket #{selected.id}</span>
              </div>
              <TicketDetail ticket={selected} onReply={reply} />
            </>
          )}
        </Drawer>
      </section>

      {/* Quick help */}
      <Card className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-bold">Common problems</h2>
          <p className="text-[11px] text-ink-faint">Tapping one opens a ticket with the details already filled in.</p>
        </div>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {QUICK_HELP.map((q) => {
            const Icon = q.icon;
            return (
              <li key={q.title}>
                <button
                  onClick={() => setModal({ ...q.draft })}
                  className="card-hover flex w-full items-start gap-3 rounded-xl border border-line bg-surface p-3 text-left transition-colors hover:border-accent"
                >
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent" aria-hidden>
                    <Icon size={17} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-bold">{q.title}</span>
                    <span className="block truncate text-[11px] text-ink-soft">{q.body}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      {modal && <NewTicketModal initial={modal} onClose={() => setModal(null)} onCreated={onCreated} />}
    </div>
  );
}
