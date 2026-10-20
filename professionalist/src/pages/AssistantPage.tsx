import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  BarChart3,
  CalendarRange,
  Check,
  Compass,
  Copy,
  Loader2,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Plus,
  RotateCw,
  Send,
  Sparkles,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { Button, Card, ErrorState, Skeleton } from "@/components/ui";
import { LogoSymbol } from "@/components/Logo";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { errorMessage, useAsync } from "@/hooks/useAsync";
import { aiApi } from "@/services/api";
import type { AiConversation, AiMessage } from "@/services/types";
import { cn, fullName, timeAgo } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/*  Local helpers                                                              */
/* -------------------------------------------------------------------------- */

function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function fullTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Very small, safe markdown-ish renderer: real text nodes only, never innerHTML. */
type Block =
  | { kind: "para"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] };

const BULLET_RE = /^\s*(?:[-*•·]|\d+[.)])\s+/;
const BULLET_STRIP = /^\s*(?:[-*•·]|\d+[.)])\s+/;

function splitBlocks(text: string): Block[] {
  return text
    .split(/\r?\n{2,}/)
    .map((chunk) => {
      const lines = chunk
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter((l) => l.trim().length > 0);
      if (lines.length > 0 && lines.every((l) => BULLET_RE.test(l))) {
        return {
          kind: "list" as const,
          ordered: /^\s*\d+[.)]/.test(lines[0]),
          items: lines.map((l) => l.replace(BULLET_STRIP, "").trim()),
        };
      }
      return { kind: "para" as const, lines };
    })
    .filter((b) => (b.kind === "list" ? b.items.length > 0 : b.lines.length > 0));
}

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i} className="font-bold">{part.slice(2, -2)}</strong>;
        if (/^`[^`]+`$/.test(part))
          return (
            <code key={i} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[12.5px]">
              {part.slice(1, -1)}
            </code>
          );
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

function RichText({ text }: { text: string }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <div className="space-y-2.5">
      {blocks.map((block, i) =>
        block.kind === "list" ? (
          <ul key={i} className={cn("space-y-1", block.ordered && "list-inside list-decimal")}>
            {block.items.map((item, j) => (
              <li key={j} className={!block.ordered ? "flex gap-2" : undefined}>
                {!block.ordered && <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />}
                <span className="min-w-0">
                  <InlineText text={item} />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p key={i} className="space-y-1">
            {block.lines.map((line, j) => (
              <span key={j} className="block">
                <InlineText text={line} />
              </span>
            ))}
          </p>
        )
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Suggested prompts, grouped by intent                                       */
/* -------------------------------------------------------------------------- */

const INTENTS: { id: string; label: string; icon: typeof PenLine; test: RegExp }[] = [
  { id: "improve", label: "Improve", icon: WandSparkles, test: /improve|better|rewrite|polish|refine|fix\b/i },
  { id: "write", label: "Write", icon: PenLine, test: /write|draft|post|description|bio|message|reply/i },
  { id: "plan", label: "Plan", icon: CalendarRange, test: /plan|schedule|week|set up|setup|campaign|goal|priorit/i },
  { id: "analyse", label: "Analyse", icon: BarChart3, test: /summar|analys|analyz|report|stat|insight|read|review/i },
  { id: "explore", label: "Explore", icon: Compass, test: /.*/ },
];

function groupPrompts(prompts: string[]) {
  const map = new Map<string, string[]>();
  for (const prompt of prompts) {
    const intent = INTENTS.find((i) => i.test.test(prompt)) ?? INTENTS[INTENTS.length - 1];
    const list = map.get(intent.id) ?? [];
    list.push(prompt);
    map.set(intent.id, list);
  }
  return INTENTS.filter((i) => map.has(i.id)).map((i) => ({ ...i, prompts: map.get(i.id)! }));
}

/* -------------------------------------------------------------------------- */
/*  Message row                                                                */
/* -------------------------------------------------------------------------- */

function MessageRow({ message, isUser }: { message: AiMessage; isUser: boolean }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      toast.success("Message copied");
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Copy failed", "Your browser blocked clipboard access.");
    }
  };

  if (isUser) {
    return (
      <li className="flex flex-col items-end anim-fade-up">
        <div className="flex max-w-[88%] items-end gap-1.5 sm:max-w-[78%]">
          <button
            type="button"
            onClick={() => void copy()}
            aria-label="Copy your message"
            className="mb-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <div className="rounded-2xl rounded-br-md bg-accent px-3.5 py-2.5 text-[14.5px] leading-relaxed text-accent-ink shadow-sm">
            <RichText text={message.text} />
          </div>
        </div>
        <span className="mt-1 mr-9 text-[11px] text-ink-faint" title={fullTime(message.createdAt)}>
          {clockTime(message.createdAt)}
        </span>
      </li>
    );
  }

  return (
    <li className="flex gap-2.5 anim-fade-up">
      <LogoSymbol size={30} className="mt-1 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">Assistant</p>
          <span className="text-[11px] text-ink-faint" title={fullTime(message.createdAt)}>
            {clockTime(message.createdAt)}
          </span>
          <button
            type="button"
            onClick={() => void copy()}
            aria-label="Copy assistant message"
            className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
        <div className="mt-1 rounded-2xl rounded-tl-md border border-line bg-surface-2/50 px-3.5 py-2.5 text-[14.5px] leading-relaxed">
          <RichText text={message.text} />
        </div>
      </div>
    </li>
  );
}

function PendingRow() {
  return (
    <li className="flex gap-2.5 anim-fade-in">
      <LogoSymbol size={30} className="mt-1 shrink-0 opacity-70" />
      <div className="min-w-0 flex-1">
        <div className="mt-1 inline-flex items-center gap-2.5 rounded-2xl rounded-tl-md border border-line bg-surface-2/50 px-3.5 py-3">
          <span className="flex items-end gap-1" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent"
                style={{ animationDelay: `${i * 140}ms` }}
              />
            ))}
          </span>
          <span className="text-[13px] font-semibold text-ink-soft">Assistant is thinking…</span>
        </div>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function AssistantPage() {
  const toast = useToast();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const activeIdRaw = params.get("c");
  const activeId = activeIdRaw && !Number.isNaN(Number(activeIdRaw)) ? Number(activeIdRaw) : null;

  const [railOpen, setRailOpen] = useState(true);
  const [pane, setPane] = useState<"list" | "chat">(activeId ? "chat" : "list");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ text: string; message: string } | null>(null);
  const [sending, setSending] = useState(false);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tempId = useRef(-1);

  const rail = useAsync(() => aiApi.conversations(), []);
  const detail = useAsync(
    () => (activeId ? aiApi.conversation(activeId) : Promise.resolve(null as AiConversation | null)),
    [activeId]
  );
  const suggestions = useAsync(() => aiApi.suggestions(), []);

  const messages = useMemo(() => detail.data?.messages ?? [], [detail.data]);
  const groups = useMemo(() => groupPrompts(suggestions.data?.prompts ?? []), [suggestions.data]);

  const railItems = useMemo(
    () => [...(rail.data ?? [])].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [rail.data]
  );

  /* auto-grow the composer */
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  /* keep the transcript pinned to the newest message */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending, failed]);

  const selectConversation = useCallback(
    (id: number) => {
      const next = new URLSearchParams(params);
      next.set("c", String(id));
      setParams(next, { replace: true });
      setPane("chat");
      setFailed(null);
      setDraft("");
    },
    [params, setParams]
  );

  const startNewChat = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete("c");
    setParams(next, { replace: true });
    setPane("chat");
    setDraft("");
    setFailed(null);
    window.setTimeout(() => taRef.current?.focus(), 60);
  }, [params, setParams]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sending) return;
      setSending(true);
      setFailed(null);
      setPending(text);
      /* Seed the composer with what is being sent, then clear once the reply lands. */
      setDraft(text);

      const userId = tempId.current--;
      const stamp = new Date().toISOString();
      const userMessage: AiMessage = { id: userId, role: "user", text, createdAt: stamp };

      try {
        const res = await aiApi.send(activeId, text);
        const reply = res.reply;

        if (activeId && res.conversationId === activeId) {
          detail.setData((prev) => (prev ? { ...prev, updatedAt: reply.createdAt, messages: [...prev.messages, userMessage, reply] } : prev));
        }

        rail.setData((prev) => {
          const list = prev ?? [];
          const existing = list.find((c) => c.id === res.conversationId);
          const next: AiConversation = {
            id: res.conversationId,
            title: existing?.title || text.slice(0, 40),
            updatedAt: reply.createdAt,
            messages: [...(existing?.messages ?? []), userMessage, reply],
          };
          return [next, ...list.filter((c) => c.id !== res.conversationId)];
        });

        if (res.conversationId !== activeId) selectConversation(res.conversationId);
      } catch (e) {
        setFailed({ text, message: errorMessage(e) });
        toast.error("The assistant could not answer", errorMessage(e));
      } finally {
        setPending(null);
        setSending(false);
      }
    },
    [activeId, detail, rail, selectConversation, sending, toast]
  );

  const removeConversation = async (conversation: AiConversation) => {
    const snapshot = rail.data ?? [];
    rail.setData(snapshot.filter((c) => c.id !== conversation.id));
    if (activeId === conversation.id) {
      const next = new URLSearchParams(params);
      next.delete("c");
      setParams(next, { replace: true });
      detail.setData(null);
      setPane("list");
    }
    try {
      await aiApi.deleteConversation(conversation.id);
      toast.success("Conversation deleted", conversation.title);
    } catch (e) {
      rail.setData(snapshot);
      toast.error("Delete failed", errorMessage(e));
    }
  };

  const title = detail.data?.title || "New conversation";
  const name = user ? fullName(user) : "there";

  const railPanel = (
    <Card className={cn("flex-col overflow-hidden", railOpen ? "hidden lg:flex lg:w-72" : "hidden")}>
      <div className="flex items-center gap-2 border-b border-line p-3">
        <Button size="sm" onClick={startNewChat} className="flex-1">
          <Plus size={15} /> New chat
        </Button>
        <button
          onClick={() => setRailOpen(false)}
          aria-label="Hide conversation list"
          className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink lg:flex"
        >
          <PanelLeftClose size={17} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {rail.loading && (
          <ul className="space-y-2" aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i} className="rounded-xl border border-line p-3">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="mt-2 h-2.5 w-16" />
              </li>
            ))}
          </ul>
        )}

        {!rail.loading && rail.error && <ErrorState message={errorMessage(rail.error)} onRetry={rail.refetch} />}

        {!rail.loading && !rail.error && railItems.length === 0 && (
          <div className="px-3 py-8 text-center">
            <MessagesSquare size={26} className="mx-auto mb-2 text-ink-faint" aria-hidden />
            <p className="text-sm font-bold">No conversations yet</p>
            <p className="mt-1 text-xs text-ink-soft">Your chats with the assistant will be listed here.</p>
          </div>
        )}

        {!rail.loading && !rail.error && railItems.length > 0 && (
          <ul className="space-y-1">
            {railItems.map((c) => {
              const isActive = c.id === activeId;
              return (
                <li key={c.id} className="group relative">
                  <button
                    onClick={() => selectConversation(c.id)}
                    aria-current={isActive}
                    className={cn(
                      "w-full rounded-xl border px-3 py-2.5 pr-10 text-left transition-colors",
                      isActive ? "border-accent bg-accent-soft" : "border-transparent hover:bg-surface-2"
                    )}
                  >
                    <span className={cn("block truncate text-[13px] font-semibold", isActive && "text-accent")}>
                      {c.title || "Untitled conversation"}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-ink-faint">
                      {timeAgo(c.updatedAt)} ago · {c.messages?.length ?? 0} messages
                    </span>
                  </button>
                  <button
                    onClick={() => void removeConversation(c)}
                    aria-label={`Delete conversation ${c.title || "untitled"}`}
                    className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-ink-faint opacity-0 transition-all hover:bg-danger-soft hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );

  const mobileRailPanel = (
    <Card className={cn("w-full flex-col overflow-hidden", pane === "list" ? "flex" : "hidden", "lg:hidden")}>
      <div className="flex items-center justify-between gap-2 border-b border-line p-3">
        <h2 className="text-sm font-bold">Conversations</h2>
        <Button size="sm" onClick={startNewChat}>
          <Plus size={15} /> New chat
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {rail.loading && (
          <ul className="space-y-2" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="rounded-xl border border-line p-3">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="mt-2 h-2.5 w-16" />
              </li>
            ))}
          </ul>
        )}
        {!rail.loading && rail.error && <ErrorState message={errorMessage(rail.error)} onRetry={rail.refetch} />}
        {!rail.loading && !rail.error && railItems.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-ink-soft">No conversations yet.</p>
        )}
        {!rail.loading && !rail.error && (
          <ul className="space-y-1">
            {railItems.map((c) => (
              <li key={c.id} className="relative">
                <button
                  onClick={() => selectConversation(c.id)}
                  aria-current={c.id === activeId}
                  className={cn(
                    "w-full rounded-xl border px-3 py-3 pr-11 text-left transition-colors",
                    c.id === activeId ? "border-accent bg-accent-soft" : "border-transparent hover:bg-surface-2"
                  )}
                >
                  <span className="block truncate text-sm font-semibold">{c.title || "Untitled conversation"}</span>
                  <span className="mt-0.5 block text-[11px] text-ink-faint">{timeAgo(c.updatedAt)} ago</span>
                </button>
                <button
                  onClick={() => void removeConversation(c)}
                  aria-label={`Delete conversation ${c.title || "untitled"}`}
                  className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-ink-faint hover:bg-danger-soft hover:text-danger"
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );

  return (
    <div className="mt-12 flex h-[calc(100dvh-13rem)] min-h-[420px] gap-3 sm:mt-0 sm:h-[calc(100dvh-9rem)] lg:h-[calc(100dvh-8rem)] lg:gap-4">
      {!railOpen && (
        <button
          onClick={() => setRailOpen(true)}
          aria-label="Show conversation list"
          className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink lg:flex"
        >
          <PanelLeftOpen size={17} />
        </button>
      )}

      {/* rail: desktop */}
      {railPanel}
      {/* rail: mobile */}
      {mobileRailPanel}

      {/* main */}
      <Card className={cn("min-w-0 flex-1 flex-col overflow-hidden", pane === "chat" ? "flex" : "hidden lg:flex")}>
        <header className="flex items-center gap-2 border-b border-line p-3">
          <button
            onClick={() => setPane("list")}
            aria-label="Back to conversation list"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink lg:hidden"
          >
            <ArrowLeft size={18} />
          </button>
          <LogoSymbol size={32} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-extrabold">{title}</h1>
            <p className="truncate text-[11px] text-ink-faint">
              {activeId ? `${messages.length} messages` : "Ready when you are"}
            </p>
          </div>
          <span className="hidden items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-[11px] font-bold text-success sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
            Assistant online
          </span>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4">
          {detail.loading && activeId && (
            <ul className="space-y-5" aria-hidden>
              {[0, 1, 2].map((i) => (
                <li key={i} className={cn("flex gap-2.5", i % 2 === 1 && "flex-row-reverse")}>
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className={cn("space-y-2", i % 2 === 1 ? "items-end flex flex-col" : "flex-1")}>
                    <Skeleton className="h-2.5 w-20" />
                    <Skeleton className="h-14 w-full max-w-md rounded-2xl" />
                    <Skeleton className="h-3 w-2/3 max-w-xs" />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {!detail.loading && detail.error && activeId && (
            <ErrorState message={errorMessage(detail.error)} onRetry={detail.refetch} />
          )}

          {!detail.loading && !detail.error && messages.length === 0 && !pending && (
            <section className="anim-fade-up">
              <div className="mx-auto max-w-xl text-center">
                <span className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft">
                  <LogoSymbol size={34} />
                </span>
                <h2 className="text-lg font-extrabold tracking-tight">Hi {name.split(" ")[0]}, what are we working on?</h2>
                <p className="mt-1.5 text-sm text-ink-soft">
                  Draft posts and listings, sharpen your profile, plan the week or make sense of your numbers — the
                  assistant works from your Professionalist activity.
                </p>
              </div>

              <div className="mx-auto mt-6 max-w-2xl space-y-5">
                {suggestions.loading &&
                  [0, 1].map((g) => (
                    <div key={g} className="space-y-2" aria-hidden>
                      <Skeleton className="h-3 w-24" />
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Skeleton className="h-14" />
                        <Skeleton className="h-14" />
                      </div>
                    </div>
                  ))}

                {!suggestions.loading && suggestions.error && (
                  <ErrorState message={errorMessage(suggestions.error)} onRetry={suggestions.refetch} />
                )}

                {!suggestions.loading && !suggestions.error && groups.length === 0 && (
                  <p className="text-center text-sm text-ink-soft">
                    No starter prompts right now — type below to start a conversation.
                  </p>
                )}

                {!suggestions.loading &&
                  !suggestions.error &&
                  groups.map((group) => {
                    const Icon = group.icon;
                    return (
                      <div key={group.id}>
                        <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
                          <Icon size={13} aria-hidden />
                          {group.label}
                        </h3>
                        <ul className="grid gap-2 sm:grid-cols-2">
                          {group.prompts.map((prompt) => (
                            <li key={prompt}>
                              <button
                                onClick={() => void send(prompt)}
                                disabled={sending}
                                className="card-hover flex min-h-12 w-full items-center gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-left text-[13px] font-semibold transition-colors hover:border-accent disabled:opacity-50"
                              >
                                <Sparkles size={15} className="shrink-0 text-accent" aria-hidden />
                                <span className="min-w-0">{prompt}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
              </div>
            </section>
          )}

          {(messages.length > 0 || pending || failed) && (
            <ul className="mx-auto max-w-2xl space-y-5" aria-live="polite">
              {messages.map((m) => (
                <MessageRow key={m.id} message={m} isUser={m.role === "user"} />
              ))}
              {pending && (
                <>
                  <MessageRow
                    message={{ id: -998, role: "user", text: pending, createdAt: new Date().toISOString() }}
                    isUser
                  />
                  <PendingRow />
                </>
              )}
              {failed && !pending && (
                <>
                  <MessageRow
                    message={{ id: -997, role: "user", text: failed.text, createdAt: new Date().toISOString() }}
                    isUser
                  />
                  <li className="flex gap-2.5 anim-fade-up">
                    <span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
                      <Loader2 size={16} aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-danger">Request failed</p>
                      <div className="mt-1 rounded-2xl rounded-tl-md border border-danger bg-danger-soft/60 px-3.5 py-2.5 text-[13.5px]">
                        <p>{failed.message}</p>
                        <div className="mt-2.5 flex gap-2">
                          <Button size="sm" onClick={() => void send(failed.text)}>
                            <RotateCw size={14} /> Retry
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setFailed(null)}>
                            Dismiss
                          </Button>
                        </div>
                      </div>
                    </div>
                  </li>
                </>
              )}
            </ul>
          )}
        </div>

        <footer className="border-t border-line p-3 safe-bottom">
          <div className="mx-auto max-w-2xl">
            <div className="flex items-end gap-2">
              <label htmlFor="assistant-input" className="sr-only">
                Message the Professionalist assistant
              </label>
              <textarea
                id="assistant-input"
                ref={taRef}
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
                placeholder={sending ? "Assistant is thinking…" : "Ask for a draft, a plan, an analysis…"}
                disabled={sending}
                className="max-h-40 min-h-11 w-full flex-1 resize-none rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-[var(--ring)] focus:outline-none transition-colors disabled:opacity-60"
              />
              <Button
                size="icon"
                onClick={() => void send(draft)}
                loading={sending}
                disabled={!draft.trim() || sending}
                aria-label="Send message to assistant"
                className="h-11 w-11 shrink-0"
              >
                {!sending && <Send size={17} />}
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] text-ink-faint">
              Enter sends · Shift + Enter adds a line · Replies are generated from your activity on Professionalist.
            </p>
          </div>
        </footer>
      </Card>
    </div>
  );
}
