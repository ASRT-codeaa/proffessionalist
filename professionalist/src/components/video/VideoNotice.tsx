import { clsx } from "clsx";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";

export type VideoNoticeTone = "success" | "error" | "info";

export interface VideoNoticeModel {
  id: number;
  tone: VideoNoticeTone;
  message: string;
  actionLabel?: string;
  onAction?(): void;
}

export interface VideoNoticeProps {
  notice: VideoNoticeModel | null;
  onDismiss(): void;
  className?: string;
}

/**
 * Single-line feedback for actions (like/save/share/follow/upload). Rendered in an
 * aria-live region; every control in it does something (dismiss, or the offered retry).
 */
export function VideoNotice({ notice, onDismiss, className }: VideoNoticeProps) {
  return (
    <div aria-live="polite" aria-atomic="true" className={clsx("pointer-events-none", className)}>
      {notice ? (
        <div
          className={clsx(
            "anim-fade-up pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm shadow-pop backdrop-blur",
            notice.tone === "success" && "border-success/30 bg-success-soft text-success",
            notice.tone === "error" && "border-danger/30 bg-danger-soft text-danger",
            notice.tone === "info" && "border-line bg-surface/95 text-ink",
          )}
        >
          <span className="mt-0.5 shrink-0">
            {notice.tone === "success" ? (
              <CheckCircle2 className="h-4 w-4" aria-hidden />
            ) : notice.tone === "error" ? (
              <TriangleAlert className="h-4 w-4" aria-hidden />
            ) : (
              <Info className="h-4 w-4" aria-hidden />
            )}
          </span>
          <p className="min-w-0 flex-1 font-medium break-words">{notice.message}</p>
          {notice.actionLabel && notice.onAction ? (
            <button
              type="button"
              onClick={notice.onAction}
              className="shrink-0 rounded-lg px-2 py-1 text-xs font-bold underline-offset-2 hover:underline"
            >
              {notice.actionLabel}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss message"
            className=" -mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-lg opacity-70 transition-opacity hover:opacity-100"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
}
