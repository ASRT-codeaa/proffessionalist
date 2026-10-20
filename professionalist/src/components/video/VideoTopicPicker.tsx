import { clsx } from "clsx";
import { Check, Plus } from "lucide-react";

export interface VideoTopicOption {
  /** Slug — what the API accepts (unknown slugs are a 400). */
  value: string;
  /** Display name — what the user reads. */
  label: string;
}

export interface VideoTopicPickerProps {
  options: VideoTopicOption[];
  selected: string[];
  max?: number;
  label?: string;
  hint?: string;
  /** Field error from the server envelope, shown under the chips when present. */
  error?: string | null;
  disabled?: boolean;
  onChange(next: string[]): void;
  className?: string;
  id?: string;
}

/** Multi-select topic chips (used by "Add a video" and the interests page). */
export function VideoTopicPicker({
  options,
  selected,
  max = 5,
  label = "Topics",
  hint,
  error,
  disabled,
  onChange,
  className,
  id = "video-topics",
}: VideoTopicPickerProps) {
  const toggle = (topic: string) => {
    if (selected.includes(topic)) {
      onChange(selected.filter((t) => t !== topic));
      return;
    }
    if (selected.length >= max) return;
    onChange([...selected, topic]);
  };

  return (
    <fieldset className={clsx("min-w-0", className)} disabled={disabled}>
      <legend className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px] font-bold text-ink">
        <span id={`${id}-label`}>{label}</span>
        <span className="text-[11.5px] font-semibold text-ink-faint">
          {selected.length}/{max}
        </span>
      </legend>
      <div
        role="group"
        aria-labelledby={`${id}-label`}
        className="flex flex-wrap gap-2"
        id={id}
      >
        {options.map((option) => {
          const isActive = selected.includes(option.value);
          const atLimit = !isActive && selected.length >= max;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={isActive}
              disabled={atLimit}
              onClick={() => toggle(option.value)}
              title={atLimit ? `You can pick up to ${max} topics` : undefined}
              className={clsx(
                "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
                isActive
                  ? "border-accent/35 bg-accent-soft text-accent"
                  : "border-line bg-surface text-ink-soft hover:bg-surface-2 hover:text-ink",
                atLimit && "cursor-not-allowed opacity-50",
              )}
            >
              {isActive ? <Check className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
              {option.label}
            </button>
          );
        })}
      </div>
      {hint && !error ? <p className="mt-1.5 text-xs text-ink-faint">{hint}</p> : null}
      {error ? (
        <p role="alert" className="mt-1.5 text-xs font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
