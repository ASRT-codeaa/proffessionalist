import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bookmark,
  ChevronDown,
  FileText,
  Link2,
  MessageCircle,
  MoreHorizontal,
  Play,
  Repeat2,
  Share2,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import { Avatar, Badge, Button, Card, Dropdown, MenuItem, Modal, Skeleton, Textarea, VerifiedBadge } from "@/components/ui";
import { errorMessage, useAsync } from "@/hooks/useAsync";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { postsApi } from "@/services/api";
import { classifyLink, embedSrcForPlay } from "@/services/embeds";
import { mediaUrl } from "@/services/http";
import type { Business, Comment, Person, Post } from "@/services/types";
import { cn, formatNumber, timeAgo } from "@/lib/utils";

const REACTIONS = ["👍", "❤️", "🎉", "💡", "👏"];

function authorView(post: Post) {
  const base = { id: 0, name: "", headline: "", avatarUrl: "", verified: false, verifiedColor: "", href: "#", following: false, isBusiness: false };
  if (post.authorType === "business") {
    const b = post.author as Business;
    return { ...base, isBusiness: true, id: b.id, name: b.name, headline: b.industry, avatarUrl: b.logoUrl, verified: b.verified, href: `/business/${b.slug}`, following: b.following };
  }
  const u = post.author as Person;
  return {
    ...base,
    id: u.id,
    name: `${u.firstName} ${u.lastName}`,
    headline: u.title,
    avatarUrl: u.avatarUrl,
    verified: u.verified,
    verifiedColor: u.verifiedColor ?? "",
    href: `/profile/${u.username}`,
    following: u.following,
  };
}

function richText(text: string) {
  return text.split(/(\s+)/).map((chunk, i) => {
    if (/^#[\w-]+$/.test(chunk))
      return (
        <Link key={i} to={`/search?q=${encodeURIComponent(chunk.slice(1))}`} className="font-semibold text-accent hover:underline">
          {chunk}
        </Link>
      );
    if (/^@[\w.-]+$/.test(chunk))
      return (
        <Link key={i} to={`/profile/${encodeURIComponent(chunk.slice(1))}`} className="font-semibold text-accent hover:underline">
          {chunk}
        </Link>
      );
    return <span key={i}>{chunk}</span>;
  });
}

function MediaGrid({ media }: { media: Post["media"] }) {
  if (!media.length) return null;
  const [first, ...rest] = media;
  if (first.type === "document")
    return (
      <a
        href={mediaUrl(first.url)}
        target="_blank"
        rel="noreferrer"
        className="mt-3 flex items-center gap-3 rounded-xl border border-line bg-surface-2/60 p-3 transition-colors hover:bg-surface-2"
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <FileText size={18} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{first.name ?? "Document"}</span>
          <span className="block text-xs text-ink-soft">Open document</span>
        </span>
      </a>
    );

  return (
    <div className={cn("mt-3 grid gap-1 overflow-hidden rounded-2xl border border-line", media.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
      {first.type === "video" ? (
        <video src={mediaUrl(first.url)} controls playsInline preload="metadata" className="max-h-[26rem] w-full bg-black" />
      ) : (
        <img src={mediaUrl(first.url)} alt="" loading="lazy" className="max-h-[26rem] w-full object-cover" />
      )}
      {media.length > 1 &&
        rest.slice(0, 3).map((m) =>
          m.type === "video" ? (
            <video key={m.url} src={mediaUrl(m.url)} controls playsInline preload="metadata" className="h-full max-h-52 w-full object-cover" />
          ) : (
            <img key={m.url} src={mediaUrl(m.url)} alt="" loading="lazy" className="h-full max-h-52 w-full object-cover" />
          )
        )}
    </div>
  );
}

function LinkVideo({ post }: { post: Post }) {
  const embed = classifyLink(post.linkUrl!);
  const [launched, setLaunched] = useState(false);
  const frameBox = useRef<HTMLDivElement | null>(null);
  /* a launched iframe scrolled out of sight must not keep playing audio — back to the facade */
  useEffect(() => {
    if (!launched) return;
    const node = frameBox.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.intersectionRatio < 0.3)) setLaunched(false);
      },
      { threshold: [0, 0.3, 0.6] },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [launched]);
  if (!embed) return null;
  const label = post.linkTitle || `Video on ${embed.provider === "youtube" ? "YouTube" : "Vimeo"}`;
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-line">
      <div ref={frameBox} className="relative aspect-video w-full bg-black">
        {launched ? (
          <iframe
            src={embedSrcForPlay(embed.embedUrl, embed.provider)}
            className="absolute inset-0 h-full w-full border-0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
            title={label}
          />
        ) : (
          /* the tap is the user gesture autoplay policies demand; before it the provider loads nothing */
          <button
            type="button"
            onClick={() => setLaunched(true)}
            aria-label={`Play ${label}`}
            className="group absolute inset-0 grid h-full w-full place-items-center"
          >
            {embed.thumbUrl ? (
              <img src={embed.thumbUrl} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
            ) : null}
            <span className="absolute inset-0 bg-black/25" aria-hidden />
            <span className="relative grid h-16 w-16 place-items-center rounded-full bg-white/95 text-ink shadow-lg transition-transform group-hover:scale-105">
              <Play className="h-7 w-7 translate-x-0.5" aria-hidden />
            </span>
          </button>
        )}
      </div>
      <div className="bg-surface-2 px-3.5 py-2.5">
        <p className="truncate text-sm font-bold">{post.linkTitle || label}</p>
        <a href={embed.canonicalUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold uppercase tracking-wide text-ink-soft hover:text-accent">
          Watch on {embed.provider === "youtube" ? "YouTube" : "Vimeo"}
        </a>
      </div>
    </div>
  );
}

function PollView({ post, onVote }: { post: Post; onVote: (optionId: number) => void }) {
  const poll = post.poll!;
  const total = poll.options.reduce((s, o) => s + o.votes, 0);
  const voted = poll.votedOption != null;
  return (
    <div className="mt-3 space-y-2">
      <p className="text-sm font-bold">{poll.question}</p>
      {poll.options.map((o) => {
        const pct = total ? Math.round((o.votes / total) * 100) : 0;
        return (
          <button
            key={o.id}
            onClick={() => onVote(o.id)}
            disabled={voted}
            className={cn(
              "relative w-full overflow-hidden rounded-xl border px-3.5 py-2.5 text-left text-sm font-semibold transition-colors",
              voted ? "cursor-default" : "hover:border-accent",
              poll.votedOption === o.id ? "border-accent text-accent" : "border-line"
            )}
          >
            {voted && <span className="absolute inset-y-0 left-0 bg-accent-soft" style={{ width: `${pct}%` }} aria-hidden />}
            <span className="relative flex justify-between gap-3">
              <span>{o.label}</span>
              {voted && <span className="tabular-nums">{pct}%</span>}
            </span>
          </button>
        );
      })}
      <p className="text-xs text-ink-faint">{formatNumber(total)} votes</p>
    </div>
  );
}

function Comments({ post, onCount }: { post: Post; onCount: (n: number) => void }) {
  const { data, loading, error, refetch } = useAsync(() => postsApi.comments(post.id), [post.id]);
  const { user } = useAuth();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      await postsApi.addComment(post.id, text);
      setDraft("");
      onCount(post.commentCount + 1);
      toast.success("Comment posted");
      void refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      {loading && <Skeleton className="h-12 rounded-xl" />}
      {error && <p className="text-sm text-danger">{errorMessage(error)}</p>}
      {data?.map((c: Comment) => (
        <div key={c.id} className="flex gap-2.5">
          <Avatar name={`${c.author.firstName} ${c.author.lastName}`} src={c.author.avatarUrl} size="sm" />
          <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-2.5">
            <div className="flex items-baseline gap-2">
              <Link to={`/profile/${c.author.username}`} className="truncate text-[13px] font-bold hover:underline">
                {c.author.firstName} {c.author.lastName}
              </Link>
              <span className="shrink-0 text-[11px] text-ink-faint">{timeAgo(c.createdAt)}</span>
            </div>
            <p className="mt-0.5 text-sm whitespace-pre-wrap break-words">{c.text}</p>
          </div>
        </div>
      ))}
      {data?.length === 0 && <p className="text-sm text-ink-soft">No comments yet. Start the conversation.</p>}
      <div className="flex items-start gap-2.5">
        <Avatar name={user ? `${user.firstName} ${user.lastName}` : "?"} src={user?.profile.avatarUrl} size="sm" />
        <Textarea
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a comment…"
          aria-label="Write a comment"
          className="min-h-10"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button size="sm" onClick={() => void send()} loading={busy} disabled={!draft.trim()}>
          Send
        </Button>
      </div>
    </div>
  );
}

export function PostCard({ post, onChanged }: { post: Post; onChanged?: () => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const [showComments, setShowComments] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState(post);
  const p = local;
  const a = authorView(p);

  const patch = (next: Partial<Post>) => setLocal((prev) => ({ ...prev, ...next }));

  /** Apply an optimistic change, then reconcile with the server or roll back. */
  const optimistic = (before: Partial<Post>, next: Partial<Post>, run: () => Promise<Partial<Post>>) => {
    patch(next);
    run()
      .then((server) => patch(server))
      .catch((e) => {
        patch(before);
        toast.error(errorMessage(e));
      });
  };

  const react = (emoji: string) => {
    const before: Partial<Post> = { liked: p.liked, likeCount: p.likeCount, likedReaction: p.likedReaction };
    const next = p.likedReaction === emoji ? null : emoji;
    optimistic(
      before,
      { liked: !!next, likedReaction: next, likeCount: p.likeCount + (next && !p.liked ? 1 : !next && p.liked ? -1 : 0) },
      async () => {
        const r = await postsApi.like(p.id, next ?? undefined);
        return { liked: r.liked, likeCount: r.likeCount, likedReaction: r.reaction };
      }
    );
  };

  const save = () => {
    const before: Partial<Post> = { saved: p.saved };
    optimistic(before, { saved: !p.saved }, async () => ({ saved: (await postsApi.save(p.id)).saved }));
  };

  const vote = async (optionId: number) => {
    if (!p.poll || p.poll.votedOption != null) return;
    const poll = p.poll;
    patch({
      poll: { ...poll, votedOption: optionId, options: poll.options.map((o) => (o.id === optionId ? { ...o, votes: o.votes + 1 } : o)) },
    });
    try {
      await postsApi.votePoll(p.id, optionId);
      toast.success("Vote recorded");
    } catch (e) {
      patch({ poll });
      toast.error(errorMessage(e));
    }
  };

  const share = async () => {
    setBusy(true);
    try {
      const r = await postsApi.share(p.id, note.trim() || undefined);
      patch({ shareCount: r.shareCount });
      setShareOpen(false);
      setNote("");
      toast.success(note.trim() ? "Shared to your feed" : "Post shared");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await postsApi.delete(p.id);
      toast.success("Post deleted");
      onChanged?.();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const isLong = p.text.length > 280;
  const mine = user && p.authorType === "user" && (p.author as { id?: number }).id === user.id;

  return (
    <Card className="p-4 anim-fade-up">
      <div className="flex items-start gap-3">
        <Link to={a.href}>
          <Avatar name={a.name} src={a.avatarUrl} size="md" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Link to={a.href} className="truncate text-sm font-bold hover:underline">
              {a.name}
            </Link>
            {a.verified && <VerifiedBadge color={a.verifiedColor} />}
            {p.kind !== "post" && <Badge tone="accent">{p.kind}</Badge>}
          </div>
          <p className="truncate text-xs text-ink-soft">
            {a.headline} · {timeAgo(p.createdAt)}
            {p.audience === "connections" && " · 🌐 only connections"}
          </p>
        </div>
        <Dropdown
          trigger={({ toggle }) => (
            <button onClick={toggle} aria-label="Post options" className="rounded-lg p-1.5 text-ink-soft hover:bg-surface-2">
              <MoreHorizontal size={18} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon={<Link2 size={16} />} onClick={() => { void navigator.clipboard?.writeText(`${location.origin}${a.href}`); toast.success("Link copied"); close(); }}>
                Copy link
              </MenuItem>
              <MenuItem icon={<Bookmark size={16} />} onClick={() => { save(); close(); }}>
                {p.saved ? "Unsave" : "Save"}
              </MenuItem>
              {mine && (
                <MenuItem icon={<Trash2 size={16} />} danger onClick={() => { void remove(); close(); }}>
                  Delete post
                </MenuItem>
              )}
            </>
          )}
        </Dropdown>
      </div>

      <div className="mt-3 text-[15px] leading-relaxed break-words whitespace-pre-wrap">
        <span className={cn(!expanded && isLong && "line-clamp-6")}>{richText(p.text)}</span>
      </div>
      {isLong && (
        <button onClick={() => setExpanded((v) => !v)} className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-accent hover:underline">
          {expanded ? "Show less" : "See more"}
          <ChevronDown size={14} className={cn("transition-transform", expanded && "rotate-180")} />
        </button>
      )}

      {p.hashtags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1">
          {p.hashtags.map((h) => (
            <Link key={h} to={`/search?q=${encodeURIComponent(h)}`} className="text-sm font-semibold text-accent hover:underline">
              #{h}
            </Link>
          ))}
        </div>
      )}

      <MediaGrid media={p.media} />

      {p.poll && <PollView post={p} onVote={vote} />}

      {p.linkUrl && (classifyLink(p.linkUrl) ? (
        <LinkVideo key={p.id} post={p} />
      ) : (
        <a
          href={p.linkUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 block overflow-hidden rounded-xl border border-line transition-colors hover:bg-surface-2/60"
        >
          <span className="block bg-surface-2 px-3.5 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-soft">
            {new URL(p.linkUrl, location.origin).hostname}
          </span>
          {p.linkTitle && <span className="block px-3.5 py-3 text-sm font-bold">{p.linkTitle}</span>}
        </a>
      ))}

      {p.listing && (
        <Link to={`/marketplace/${p.listing.id}`} className="mt-3 flex gap-3 rounded-xl border border-line p-3 transition-colors hover:bg-surface-2/60">
          {p.listing.images[0] && <img src={mediaUrl(p.listing.images[0])} alt="" loading="lazy" className="h-16 w-16 shrink-0 rounded-lg object-cover" />}
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold">{p.listing.title}</span>
            <span className="block text-xs text-ink-soft">{p.listing.location}</span>
            <span className="mt-1 block text-sm font-extrabold text-accent">{p.listing.price === 0 ? "Free" : `$${p.listing.price.toLocaleString()}`}</span>
          </span>
        </Link>
      )}

      <div className="mt-3 flex items-center gap-3 border-t border-line pt-3 text-xs text-ink-soft">
        {p.likeCount > 0 && <span aria-label={`${p.likeCount} likes`}>👍 ❤️ {formatNumber(p.likeCount)}</span>}
        <span>{formatNumber(p.commentCount)} comments</span>
        {p.shareCount > 0 && <span className="ml-auto">{formatNumber(p.shareCount)} shares</span>}
      </div>

      <div className="mt-1.5 grid grid-cols-4 gap-1">
        <Dropdown
          align="left"
          trigger={({ toggle }) => (
            <button
              onClick={toggle}
              aria-label={p.liked ? `Change reaction (current: ${p.likedReaction ?? "like"})` : "Like this post"}
              className={cn("flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[13px] font-semibold transition-colors hover:bg-surface-2", p.liked && "text-accent")}
            >
              <ThumbsUp size={17} className={cn(p.liked && "fill-current")} />
              <span className="hidden sm:inline">{p.likedReaction || "Like"}</span>
            </button>
          )}
        >
          {(close) => (
            <div className="flex gap-1 p-1">
              {REACTIONS.map((r) => (
                <button
                  key={r}
                  onClick={() => { react(r); close(); }}
                  aria-label={`React ${r}`}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-lg transition-transform hover:scale-125"
                >
                  {r}
                </button>
              ))}
            </div>
          )}
        </Dropdown>
        <button
          onClick={() => setShowComments((v) => !v)}
          aria-expanded={showComments}
          aria-label={`Comment (${p.commentCount})`}
          className={cn("flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[13px] font-semibold transition-colors hover:bg-surface-2", showComments && "text-accent")}
        >
          <MessageCircle size={17} />
          <span className="hidden sm:inline">Comment</span>
        </button>
        <button
          onClick={() => setShareOpen(true)}
          aria-label="Share this post"
          className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[13px] font-semibold transition-colors hover:bg-surface-2"
        >
          <Repeat2 size={17} />
          <span className="hidden sm:inline">Share</span>
        </button>
        <button
          onClick={save}
          aria-label={p.saved ? "Remove from saved" : "Save this post"}
          aria-pressed={p.saved}
          className={cn("flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[13px] font-semibold transition-colors hover:bg-surface-2", p.saved && "text-accent")}
        >
          <Bookmark size={17} className={cn(p.saved && "fill-current")} />
          <span className="hidden sm:inline">{p.saved ? "Saved" : "Save"}</span>
        </button>
      </div>

      {showComments && !p.commentsDisabled && <Comments post={p} onCount={(n) => patch({ commentCount: n })} />}
      {p.commentsDisabled && showComments && <p className="mt-3 border-t border-line pt-3 text-sm text-ink-soft">Comments are disabled on this post.</p>}

      <Modal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        title="Share this post"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShareOpen(false)}>Cancel</Button>
            <Button onClick={() => void share()} loading={busy}>Share</Button>
          </>
        }
      >
        <p className="mb-3 line-clamp-3 rounded-xl bg-surface-2 p-3 text-sm text-ink-soft">{p.text}</p>
        <Textarea label="Add a note (optional)" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What do you want to say about this?" />
        <button
          onClick={() => { void navigator.clipboard?.writeText(`${location.origin}/home`); toast.success("Link copied to clipboard"); }}
          className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline"
        >
          <Share2 size={15} /> Copy link instead
        </button>
      </Modal>
    </Card>
  );
}

export function PostCardSkeleton() {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-2.5 w-44" />
        </div>
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </Card>
  );
}
