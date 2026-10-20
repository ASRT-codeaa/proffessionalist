import { Bell, UserPlus, Check } from "lucide-react";
import { Avatar, PreviewTag } from "@/components/landing/ui";
import { cx, t } from "@/landing/tokens";
import { previewSample } from "@/landing/content";

const c = previewSample.connection;

/** A connection suggestion + a notification, both inert sample rows. */
export function NetworkPreview({ className }: { className?: string }) {
  return (
    <div className={cx("relative space-y-3", className)}>
      <PreviewTag className="absolute -top-3 right-3" />

      <div
        className={cx(
          "flex items-center gap-3 rounded-2xl border border-[#e4e7ec] bg-[#ffffff] p-4",
          "shadow-[0_1px_2px_#1018280d]",
        )}
      >
        <Avatar initials={c.initials} size={40} tone="neutral" />
        <div className="min-w-0">
          <p className={cx("truncate text-sm font-bold", t.ink)}>{c.name}</p>
          <p className={cx("truncate text-xs", t.inkSoft)}>{c.headline}</p>
        </div>
        {/* decorative affordances only — not interactive on the landing page */}
        <div aria-hidden="true" className="ml-auto flex items-center gap-2">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[#e8f0ff] text-[#1e6fff]">
            <Check size={16} strokeWidth={2} />
          </span>
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[#e4e7ec] text-[#667085]">
            <UserPlus size={16} strokeWidth={1.8} />
          </span>
        </div>
      </div>

      <div
        className={cx(
          "flex items-center gap-3 rounded-2xl border border-[#e4e7ec] bg-[#ffffff] p-4",
          "shadow-[0_1px_2px_#1018280d]",
        )}
      >
        <span
          aria-hidden="true"
          className={cx("inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[#eef0f4]", t.inkSoft)}
        >
          <Bell size={16} strokeWidth={1.8} />
        </span>
        <p className={cx("text-sm", t.ink)}>{previewSample.notification.text}</p>
      </div>
    </div>
  );
}
