import { clsx } from "clsx";
import { useCallback, useRef, useState } from "react";
import { FileVideo, UploadCloud } from "lucide-react";
import { VIDEO_LIMITS } from "@/services/videos";
import { formatBytes } from "./videoFormat";

export interface VideoUploadDropzoneProps {
  /** Called with the chosen file (single file; the videos contract accepts one per post). */
  onFile(file: File): void;
  disabled?: boolean;
  /** Message from the parent (e.g. a server rejection) — the dropzone stays dumb. */
  notice?: string | null;
  className?: string;
}

const ACCEPT = VIDEO_LIMITS.acceptedUploadTypes.join(",") + VIDEO_LIMITS.acceptedExtensions.map((e) => `,${e}`).join("");

/**
 * Drag & drop or browse, with client-side *advisory* checks only (MIME/extension and the
 * size ceiling). Duration/resolution are probed separately in CreateVideoPage, and the
 * server remains the authority: whatever it rejects is shown from its own envelope.
 */
export function VideoUploadDropzone({ onFile, disabled, notice, className }: VideoUploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [localIssue, setLocalIssue] = useState<string | null>(null);

  const accept = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      const typeOk =
        VIDEO_LIMITS.acceptedUploadTypes.includes(file.type) ||
        VIDEO_LIMITS.acceptedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext));
      if (!typeOk) {
        setLocalIssue(
          `${file.name || "That file"} is not a supported video type. Use ${VIDEO_LIMITS.acceptedExtensions.join(", ")}.`,
        );
        return;
      }
      if (file.size > VIDEO_LIMITS.maxUploadBytes) {
        setLocalIssue(
          `${file.name} is ${formatBytes(file.size)} — the upload limit is ${formatBytes(VIDEO_LIMITS.maxUploadBytes)}. A link keeps the video where it is.`,
        );
        return;
      }
      setLocalIssue(null);
      onFile(file);
    },
    [onFile],
  );

  return (
    <div className={clsx("min-w-0", className)}>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (disabled) return;
          accept(event.dataTransfer.files?.[0]);
        }}
        className={clsx(
          "flex min-h-[9.5rem] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-6 text-center transition-colors",
          dragging ? "border-accent bg-accent-soft" : "border-line bg-surface-2/60 hover:bg-surface-2",
          disabled && "opacity-60",
        )}
      >
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent-soft text-accent">
          {dragging ? <UploadCloud className="h-5 w-5" aria-hidden /> : <FileVideo className="h-5 w-5" aria-hidden />}
        </span>
        <p className="text-sm font-bold text-ink">
          {dragging ? "Drop to attach" : "Drag a video here, or choose a file"}
        </p>
        <p className="max-w-xs text-xs leading-relaxed text-ink-faint">
          {VIDEO_LIMITS.acceptedExtensions.join(" · ")} up to {formatBytes(VIDEO_LIMITS.maxUploadBytes)}. We check these locally, the server confirms them.
        </p>
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="mt-1 inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          <UploadCloud className="h-4 w-4" aria-hidden />
          Choose file
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          aria-label="Choose a video file to upload"
          onChange={(event) => {
            accept(event.currentTarget.files?.[0]);
            // Reset so picking the same file again still fires a change event.
            event.currentTarget.value = "";
          }}
        />
      </div>
      {(localIssue || notice) && (
        <p role="alert" className="mt-2 text-xs font-semibold text-danger">
          {localIssue ?? notice}
        </p>
      )}
    </div>
  );
}
