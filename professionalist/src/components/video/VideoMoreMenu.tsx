import { clsx } from "clsx";
import { useRef, useState, type ReactNode } from "react";
import { Ban, Check, Copy, EyeOff, Flag, VolumeX } from "lucide-react";
import type { VideoItem } from "@/services/videos";
import { authorDisplayName } from "@/services/videos";
import type { VideoReportReason } from "@/services/videoApp";
import { useOverlayFocus } from "./videoHooks";

export interface VideoMoreMenuProps {
  item: VideoItem;
  /** Author already muted on this device (client-side feed filter). */
  authorMuted: boolean;
  onNotInterested(): void;
  onToggleMuteAuthor(): void;
  onReport(reason: VideoReportReason): void;
  onBlock(): void;
  onCopyLink(): void;
  onClose(): void;
  className?: string;
}

const REPORT_REASONS: { id: VideoReportReason; label: string }[] = [
  { id: "spam", label: "Spam or scam" },
  { id: "harassment", label: "Harassment or bullying" },
  { id: "nsfw", label: "Not work-appropriate" },
  { id: "misinformation", label: "Misinformation" },
  { id: "other", label: "Something else" },
];

/**
 * The long-press / "more" sheet for one feed item: not interested, mute creator,
 * report (with reason), block creator, copy link. Opened by VideoCard's ⋯ button or
 * a 550 ms long press; Escape closes, Tab is trapped, focus returns to the trigger.
 *
 * "Not interested" and "mute" take effect on this device immediately; the durable
 * ranking signal for not-interested is the topic weight written through the
 * interests PUT (the page owns that write). Report and block go through the app
 * bridge — the videos contract carries no report/block surface.
 */
export function VideoMoreMenu({
  item,
  authorMuted,
  onNotInterested,
  onToggleMuteAuthor,
  onReport,
  onBlock,
  onCopyLink,
  onClose,
  className,
}: VideoMoreMenuProps) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useOverlayFocus(sheetRef, true, onClose);

  const run = (id: string, action: () => void) => {
    setBusy(id);
    action();
  };

  const author = authorDisplayName(item.author) || "this creator";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button type="button" aria-label="Close menu" onClick={onClose} className="absolute inset-0 bg-black/55" />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={`More options for video by ${author}`}
        tabIndex={-1}
        className={clsx(
          "anim-sheet-up relative w-full max-w-sm rounded-t-3xl bg-surface p-2 shadow-pop outline-none sm:rounded-3xl",
          className,
        )}
      >
        <p className="px-3 py-2 text-[12px] font-bold uppercase tracking-wide text-ink-faint">
          This video · @author {author}
        </p>
        {reportOpen ? (
          <div>
            <p className="px-3 pb-1 pt-2 text-[13px] font-bold text-ink">Why are you reporting this video?</p>
            {REPORT_REASONS.map((reason) => (
              <button
                key={reason.id}
                type="button"
                disabled={busy === `report:${reason.id}`}
                onClick={() => run(`report:${reason.id}`, () => {
                  onReport(reason.id);
                  setReportOpen(false);
                })}
                className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[13.5px] font-semibold text-ink transition-colors hover:bg-surface-2"
              >
                <Flag className="h-4 w-4 shrink-0 text-danger" aria-hidden />
                {reason.label}
                {busy === `report:${reason.id}` ? <span className="ml-auto text-[11.5px] text-ink-faint">Sending…</span> : null}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setReportOpen(false)}
              className="mt-1 min-h-11 w-full rounded-xl px-3 text-left text-[13px] font-bold text-ink-soft transition-colors hover:bg-surface-2"
            >
              Back
            </button>
          </div>
        ) : (
          <div>
            <MenuButton
              icon={<EyeOff className="h-4 w-4 text-ink-soft" aria-hidden />}
              label="Not interested"
              detail="Hide this clip and down-weight its topics in For You"
              onClick={() => run("not-interested", () => {
                onNotInterested();
                onClose();
              })}
            />
            <MenuButton
              icon={<VolumeX className="h-4 w-4 text-ink-soft" aria-hidden />}
              label={authorMuted ? `Unmute ${author}` : `Mute ${author}`}
              detail={authorMuted ? "Show their videos in your feed again" : "Stop showing this creator's videos on this device"}
              onClick={() => run("mute", () => {
                onToggleMuteAuthor();
                onClose();
              })}
            />
            <MenuButton
              icon={<Copy className="h-4 w-4 text-ink-soft" aria-hidden />}
              label="Copy link"
              detail="Share address on your clipboard"
              onClick={() => run("copy", () => {
                onCopyLink();
                onClose();
              })}
            />
            <MenuButton
              icon={<Flag className="h-4 w-4 text-danger" aria-hidden />}
              label="Report video"
              detail="Tell the moderators what is wrong with it"
              onClick={() => setReportOpen(true)}
            />
            <MenuButton
              icon={<Ban className="h-4 w-4 text-danger" aria-hidden />}
              label={`Block ${author}`}
              detail="Account-level block, handled by the app's safety flow"
              danger
              onClick={() => run("block", () => {
                onBlock();
                onClose();
              })}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function MenuButton({
  icon,
  label,
  detail,
  danger,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
  danger?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex min-h-11 w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-surface-2",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className={clsx("block text-[13.5px] font-bold", danger ? "text-danger" : "text-ink")}>{label}</span>
        <span className="block text-[11.5px] text-ink-faint">{detail}</span>
      </span>
      <Check className="ml-auto mt-1 h-3.5 w-3.5 shrink-0 opacity-0" aria-hidden />
    </button>
  );
}

export interface VideoWhyPanelProps {
  item: VideoItem;
}

/**
 * "Why am I seeing this?" — ranking.reasons comes verbatim off the API
 * ({key, value, weight} per feature), so the panel is pure display.
 */
export function VideoWhyPanel({ item }: VideoWhyPanelProps) {
  if (!item.ranking?.reasons?.length) return null;
  return (
    <ul className="space-y-1 rounded-xl bg-black/45 p-2.5 text-[11px] text-white/85 backdrop-blur" aria-label="Why this video was recommended">
      {item.ranking.reasons.map((reason) => (
        <li key={reason.key} className="flex items-center justify-between gap-3">
          <span className="capitalize">{reason.key.replace(/_/g, " ")}</span>
          <span className="tabular-nums text-white/60">
            {Math.round(reason.value * 100)}% × {reason.weight}
          </span>
        </li>
      ))}
    </ul>
  );
}
