import { Building2, MapPin } from "lucide-react";
import { PreviewTag } from "@/components/landing/ui";
import { cx, t } from "@/landing/tokens";
import { previewSample } from "@/landing/content";

/** Static list of sample job cards for the jobs & companies section. */
export function JobListPreview({ className }: { className?: string }) {
  return (
    <div className={cx("relative space-y-3", className)}>
      <PreviewTag className="absolute -top-3 right-3" />
      {previewSample.jobs.map((job) => (
        <div
          key={job.role}
          className={cx(
            "flex items-start gap-3 rounded-2xl border border-[#e4e7ec] bg-[#ffffff] p-4",
            "shadow-[0_1px_2px_#1018280d]",
          )}
        >
          <span
            aria-hidden="true"
            className={cx(
              "mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#eef0f4]",
              t.inkSoft,
            )}
          >
            <Building2 size={17} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <p className={cx("text-sm font-bold leading-snug", t.ink)}>{job.role}</p>
            <p className={cx("mt-0.5 text-xs font-medium", t.inkSoft)}>{job.company}</p>
            <p className={cx("mt-1 flex items-center gap-1.5 text-[11px]", t.inkFaint)}>
              <MapPin size={12} strokeWidth={1.75} aria-hidden="true" />
              {job.place}
              <span className="mx-1" aria-hidden="true">·</span>
              {job.type}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
