/**
 * videoApp.ts — the seam between the video UI and the rest of the app
 * (session, login redirect, follow, native share, navigation).
 *
 * The video subtree must not re-implement auth or the app shell, and it must not import
 * modules that only exist in the real tree (AuthContext, AppShell, …) or it would not
 * compile standalone. So it depends on this small contract instead, and the app injects
 * its own implementations during the merge (src/README-VIDEO-UI.md, "Merge step 2"):
 *
 *   configureVideoApp({
 *     getSession: () => ({ userId: user?.id ?? null, displayName: user?.name ?? null,
 *                         isAuthenticated: Boolean(user), accessToken: hasToken() }),
 *     requireLogin: () => navigate("/login", { state: { from: location.pathname } }),
 *     toggleFollow: (userId, follow) => follow ? network.follow(userId) : network.unfollow(userId),
 *     onSessionExpired: unsubscribe => subscribeSessionExpired(unsubscribe),
 *   });
 *
 * The defaults below only adapt to what the deployed app already does (the same
 * `/login` route, `Authorization: Bearer professionalist.token` session, and the
 * `/api/network/follow|unfollow` endpoints). They call real endpoints; they fabricate
 * nothing.
 */

import { subscribeSessionExpired } from "./videoHttp";

export interface VideoSession {
  userId: number | null;
  displayName: string | null;
  isAuthenticated: boolean;
  /** Whether a bearer token is available; drives the request's Authorization header. */
  hasToken: boolean;
}

/** Why a viewer asked for a video to be taken down (kept short; sent as the report note). */
export type VideoReportReason = "spam" | "harassment" | "nsfw" | "misinformation" | "other";

export interface VideoAppBridge {
  getSession(): VideoSession;
  /** Sends an unauthenticated visitor to the app's existing login screen. */
  requireLogin(returnTo: string): void;
  toggleFollow(userId: number, follow: boolean): Promise<{ following: boolean } | void>;
  /**
   * Per-creator safety actions. The videos contract does NOT define these routes
   * (docs/videos-api-contract.md has no report/block/mute surface), so the defaults
   * below fail with a clear message and the app injects real implementations — the
   * existing app owns user blocks/mutes outside /api/videos.
   */
  reportVideo(videoId: number, reason: VideoReportReason, note?: string): Promise<void>;
  blockUser(userId: number): Promise<void>;
  /** Share a link; resolves true when the user actually completed a share action. */
  share(input: { url: string; title: string; text?: string }): Promise<boolean>;
  subscribeSessionExpired(listener: () => void): () => void;
}

const LOGIN_PATH = "/login";

function readToken(): string | null {
  try {
    return localStorage.getItem("professionalist.token");
  } catch {
    return null;
  }
}

async function defaultToggleFollow(userId: number, follow: boolean): Promise<{ following: boolean }> {
  const token = readToken();
  const base = ((import.meta.env.VITE_API_URL as string | undefined) ?? "").replace(/\/+$/, "");
  const res = await fetch(`${base}${follow ? "/api/network/follow" : "/api/network/unfollow"}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) {
    throw Object.assign(new Error("Follow request failed."), { status: res.status });
  }
  try {
    return (await res.json()) as { following: boolean };
  } catch {
    return { following: follow };
  }
}

/**
 * Honest default for the safety actions the videos contract does not carry:
 * refuse with a stable message so the UI shows a real failure path instead of
 * pretending a write landed. The app overrides these via configureVideoApp().
 */
function notWired(action: string): Promise<never> {
  return Promise.reject(new Error(`${action} is handled by the app's safety flow, which has not been wired into this build yet.`));
}

const defaultBridge: VideoAppBridge = {
  getSession(): VideoSession {
    const token = readToken();
    return {
      userId: null,
      displayName: null,
      isAuthenticated: !!token,
      hasToken: !!token,
    };
  },
  requireLogin(returnTo: string): void {
    const next = encodeURIComponent(returnTo || "/videos");
    window.location.assign(`${LOGIN_PATH}?next=${next}`);
  },
  toggleFollow: defaultToggleFollow,
  reportVideo: (videoId) => notWired(`Reporting video ${videoId}`),
  blockUser: () => notWired("Blocking this creator"),
  async share({ url, title, text }): Promise<boolean> {
    const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
    if (typeof nav.share === "function") {
      try {
        await nav.share({ url, title, text });
        return true;
      } catch {
        // User dismissed the sheet, or the platform refused it: fall through to clipboard.
        return copyToClipboard(url);
      }
    }
    return copyToClipboard(url);
  },
  subscribeSessionExpired(listener: () => void): () => void {
    // Reuses the shared 401 flow in videoHttp.ts (refresh attempt, then broadcast).
    return subscribeSessionExpired(listener);
  },
};

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

let bridge: VideoAppBridge = defaultBridge;

export function configureVideoApp(partial: Partial<VideoAppBridge>): void {
  bridge = { ...bridge, ...partial };
}

export function videoApp(): VideoAppBridge {
  return bridge;
}

/** Absolute URL for a feed item, used for share links and the "Open original" action. */
export function absoluteVideoUrl(path: string): string {
  const base = (import.meta.env.VITE_APP_URL as string | undefined) ?? "";
  if (/^https?:\/\//i.test(path)) return path;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${base.replace(/\/+$/, "") || origin}${path.startsWith("/") ? path : `/${path}`}`;
}
