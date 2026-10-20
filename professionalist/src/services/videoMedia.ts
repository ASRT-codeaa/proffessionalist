/**
 * videoMedia.ts — purely local media inspection for the "Add a video" preflight.
 * No network, no state: it only asks the browser what a File contains, so the UI can
 * warn before uploading. The server re-validates everything (POST /api/videos).
 */

export interface VideoProbe {
  durationMs: number;
  width: number;
  height: number;
  /** Present when the browser could not decode the container at all. */
  decodeError: string | null;
}

const PROBE_TIMEOUT_MS = 12_000;

export async function probeVideoFile(file: File): Promise<VideoProbe> {
  const url = URL.createObjectURL(file);
  try {
    return await readMetadata(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function readMetadata(url: string): Promise<VideoProbe> {
  return new Promise((resolve) => {
    const el = document.createElement("video");
    let settled = false;
    const finish = (probe: VideoProbe) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      el.removeAttribute("src");
      el.load();
      resolve(probe);
    };
    const timer = window.setTimeout(
      () => finish({ durationMs: 0, width: 0, height: 0, decodeError: "The browser could not read this file in time." }),
      PROBE_TIMEOUT_MS,
    );

    el.preload = "metadata";
    el.muted = true;
    el.playsInline = true;
    el.addEventListener("loadedmetadata", () => {
      const duration = Number.isFinite(el.duration) ? el.duration * 1000 : 0;
      finish({
        durationMs: duration,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
        decodeError: duration === 0 ? "No duration found — the container may not be playable in a browser." : null,
      });
    });
    el.onerror = () =>
      finish({ durationMs: 0, width: 0, height: 0, decodeError: "This browser cannot decode that video file." });
    el.src = url;
  });
}

/**
 * Grabs a frame for the thumbnail picker. Returns null when the browser refuses to draw
 * it (rare, and harmless — the server then generates its own thumbnail).
 */
export async function captureThumbnail(file: File, atMs = 800): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    return await drawFrame(url, atMs);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawFrame(url: string, atMs: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    const el = document.createElement("video");
    let settled = false;
    const finish = (blob: Blob | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      el.removeAttribute("src");
      el.load();
      resolve(blob);
    };
    const timer = window.setTimeout(() => finish(null), PROBE_TIMEOUT_MS);

    el.preload = "metadata";
    el.muted = true;
    el.playsInline = true;
    el.addEventListener("loadeddata", () => {
      if (!el.videoWidth || !el.videoHeight) {
        finish(null);
        return;
      }
      const canvas = document.createElement("canvas");
      // Portrait-safe: cap the long edge so the poster stays small enough to upload.
      const scale = Math.min(1, 720 / Math.max(el.videoWidth, el.videoHeight));
      canvas.width = Math.max(1, Math.round(el.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(el.videoHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        finish(null);
        return;
      }
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => finish(blob), "image/jpeg", 0.82);
    });
    el.onerror = () => finish(null);
    el.currentTime = atMs / 1000;
    el.src = url;
  });
}
