import { BadgeCheck } from "lucide-react";
import { Avatar, PreviewTag } from "@/components/landing/ui";
import { cx, t } from "@/landing/tokens";
import { previewSample } from "@/landing/content";

const p = previewSample.profile;

/** Static profile-header preview: cover band, avatar, verified name, skills. */
export function ProfileHeaderPreview({ className }: { className?: string }) {
  return (
    <div
      className={cx(
        "overflow-hidden rounded-2xl border border-[#e4e7ec] bg-[#ffffff] shadow-[0_1px_2px_#1018280d]",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="h-16 w-full bg-gradient-to-r from-[#e8f0ff] via-[#ffffff] to-[#eef0f4]"
      />
      <div className="px-4 pb-4">
        <div className="-mt-8 flex items-end justify-between">
          <Avatar initials={p.initials} size={56} />
          <PreviewTag />
        </div>
        <div className="mt-3">
          <p className={cx("flex items-center gap-1.5 text-sm font-bold", t.ink)}>
            {p.name}
            {p.verified ? (
              <BadgeCheck size={16} className={t.accent} aria-label="Verified sample profile" />
            ) : null}
          </p>
          <p className={cx("text-xs", t.inkFaint)}>{p.handle}</p>
          <p className={cx("mt-1 text-[13px] leading-snug", t.inkSoft)}>{p.headline}</p>
        </div>
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Sample skills">
          {p.skills.map((skill) => (
            <li
              key={skill}
              className={cx(
                "rounded-full border border-[#e4e7ec] bg-[#f5f6f8] px-2.5 py-1 text-[11px] font-medium",
                t.inkSoft,
              )}
            >
              {skill}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
