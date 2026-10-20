import { clsx } from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Trash2, X } from "lucide-react";
import type { VideoComment } from "@/services/videos";
import { addVideoComment, deleteVideoComment, getVideoComments } from "@/services/videos";
import { VideoApiError } from "@/services/videoHttp";
import { initialsOf, formatRelativeTime } from "./videoFormat";
import { useOverlayFocus } from "./videoHooks";

export interface VideoCommentsProps {
  open: boolean;
  postId: number;
  /** Seed from GET /api/videos/:id so the first paint is instant (inline `comments`). */
  initialComments?: VideoComment[];
  canModerate?: boolean;
  onClose(): void;
  onCountChange(count: number): void;
}

/**
 * Comment sheet. Loads and posts through the EXISTING post-comment endpoints
 * (GET/POST /api/posts/:id/comments answer plain arrays of the toComment DTO,
 * DELETE /api/posts/comments/:id) — the videos contract reuses them verbatim.
 */
export function VideoComments({
  open,
  postId,
  initialComments,
  canModerate = false,
  onClose,
  onCountChange,
}: VideoCommentsProps) {
  const [comments, setComments] = useState<VideoComment[]>(initialComments ?? []);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "ready">(() =>
    initialComments?.length ? "ready" : "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      // GET /api/posts/:id/comments answers a plain array (oldest first, capped).
      const list = await getVideoComments(postId);
      setComments(Array.isArray(list) ? list : []);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof VideoApiError ? err.message : "Comments would not load right now.");
      setStatus("error");
    }
  }, [postId]);

  useEffect(() => {
    if (!open) return;
    if (initialComments?.length) {
      setComments(initialComments);
      setStatus("ready");
      return;
    }
    void load();
  }, [open, postId, initialComments, load]);

  // Escape closes, Tab is trapped inside the sheet, focus returns on close.
  useOverlayFocus(sheetRef, open, onClose);

  const submit = async () => {
    const text = draft.trim();
    if (!text || posting) return;
    setPosting(true);
    setError(null);
    try {
      const created = await addVideoComment(postId, text);
      setComments((prev) => [...prev, created]);
      setDraft("");
      setStatus("ready");
      onCountChange(comments.length + 1);
    } catch (err) {
      setError(err instanceof VideoApiError ? err.message : "Your comment would not post. Try again.");
    } finally {
      setPosting(false);
    }
  };

  const remove = async (id: number) => {
    setDeletingId(id);
    try {
      await deleteVideoComment(id);
      setComments((prev) => {
        const next = prev.filter((c) => c.id !== id);
        onCountChange(next.length);
        return next;
      });
    } catch (err) {
      setError(err instanceof VideoApiError ? err.message : "That comment would not be removed.");
    } finally {
      setDeletingId(null);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close comments"
        onClick={onClose}
        className="absolute inset-0 bg-black/55"
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Comments"
        tabIndex={-1}
        className={clsx(
          "anim-sheet-up relative flex max-h-[78vh] w-full flex-col overflow-hidden rounded-t-3xl bg-surface shadow-pop outline-none sm:max-w-lg sm:rounded-3xl",
        )}
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-extrabold tracking-tight text-ink">
            Comments
            <span className="ml-1.5 text-[12px] font-semibold text-ink-faint">{comments.length}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close comments"
            className="-mr-2 grid h-11 w-11 place-items-center rounded-xl text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {status === "loading" ? (
            <div className="space-y-3" aria-hidden>
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-2.5">
                  <div className="skeleton h-9 w-9 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <div className="skeleton h-3 w-24 rounded-full" />
                    <div className="skeleton h-3 w-full rounded-full" />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {status === "error" ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <p className="text-sm text-ink-soft">{error}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="inline-flex min-h-11 items-center rounded-xl border border-line bg-surface px-4 text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
              >
                Retry
              </button>
            </div>
          ) : null}

          {status === "ready" && comments.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-soft">
              No comments yet — start the conversation.
            </p>
          ) : null}

          <ul className="space-y-3.5">
            {comments.map((comment) => (
              <li key={comment.id} className="flex items-start gap-2.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-[12px] font-bold text-accent">
                  {initialsOf(comment.author?.name)}
                </span>
                <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[13px] font-bold text-ink">{comment.author?.name ?? "Member"}</span>
                    <span className="shrink-0 text-[11px] text-ink-faint">{formatRelativeTime(comment.createdAt)}</span>
                  </div>
                  <p className="mt-0.5 text-sm whitespace-pre-wrap break-words text-ink">{comment.text}</p>
                </div>
                {canModerate ? (
                  <button
                    type="button"
                    onClick={() => void remove(comment.id)}
                    disabled={deletingId !== null}
                    aria-label={`Delete comment by ${comment.author?.name || "member"}`}
                    className="mt-1 grid h-11 w-11 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-danger-soft hover:text-danger disabled:opacity-50"
                  >
                    {deletingId === comment.id ? (
                      <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
                    ) : (
                      <Trash2 className="h-4 w-4" aria-hidden />
                    )}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        <footer className="safe-bottom border-t border-line bg-surface px-3 py-3">
          {error && status !== "error" ? (
            <p role="alert" className="mb-2 text-xs font-semibold text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={draft}
              rows={1}
              maxLength={1000}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              aria-label="Write a comment"
              placeholder="Add a comment…"
              className="max-h-36 min-h-11 w-full flex-1 resize-none rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:bg-surface focus:ring-2 focus:ring-[var(--ring)] focus:outline-none transition-colors disabled:opacity-60"
              disabled={posting}
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!draft.trim() || posting}
              aria-label="Post comment"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent text-accent-ink transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {posting ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <Send className="h-5 w-5" aria-hidden />}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
