/**
 * videoHttp.ts — the single network adapter used by the whole video UI.
 *
 * WHY THIS FILE EXISTS
 * The app already owns a request helper (`src/services/http.ts`, which exposes the
 * `API_BASE_URL` constant, the verb helpers `get/post/put/del/upload`, `mediaUrl()`
 * at http.ts:203, the `ApiError` class and the refresh-then-logout 401 flow). Video
 * code must not fork that behaviour, so every call in `src/services/videos.ts` goes
 * through the `VideoHttp` contract below.
 *
 * In the real tree one line wires the app's helper in (see src/README-VIDEO-UI.md,
 * "Merge step 3"):
 *
 *   configureVideoHttp({ get: http.get, post: http.post, put: http.put,
 *                        del: http.del, upload: http.upload, mediaUrl });
 *
 * When nothing has been injected (playground build, or the subtree reviewed before the
 * merge) `defaultVideoHttp` below implements the *same documented conventions* —
 * `VITE_API_URL` base, `Authorization: Bearer <professionalist.token>`, one
 * `/api/auth/refresh` retry, `{ error: { code, message, fields } }` envelope — against
 * real endpoints only. It contains no fixtures, no fallback payloads and no demo data:
 * if the server does not answer, it throws.
 */

const ACCESS_TOKEN_KEY = "professionalist.token";
const REFRESH_TOKEN_KEY = "professionalist.refresh";
const REQUEST_TIMEOUT_MS = 15_000;

/** Mirrors `ApiError` from src/services/http.ts (status, code, fieldErrors). */
export class VideoApiError extends Error {
  status: number;
  code: string;
  fieldErrors: Record<string, string>;

  constructor(status: number, code: string, message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export type VideoHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type VideoQuery = Record<string, string | number | boolean | undefined | null>;

export interface VideoRequestOptions {
  query?: VideoQuery;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Multipart upload progress in bytes, when the transport can report it. */
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
}

export interface VideoHttp {
  get<T>(path: string, query?: VideoQuery, options?: VideoRequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: VideoRequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: VideoRequestOptions): Promise<T>;
  del<T>(path: string, options?: VideoRequestOptions): Promise<T>;
  upload<T>(path: string, form: FormData, options?: VideoRequestOptions): Promise<T>;
  /** API_BASE_URL + "/uploads/…" convention from http.ts:203. */
  mediaUrl(url?: string | null): string;
}

let injected: VideoHttp | null = null;

/** Called once by the app (main.tsx / route module) to reuse the existing http helper. */
export function configureVideoHttp(impl: VideoHttp): void {
  injected = impl;
}

export function videoHttp(): VideoHttp {
  return injected ?? defaultVideoHttp;
}

export function isVideoHttpConfigured(): boolean {
  return injected !== null;
}

/* ------------------------------------------------------------------ *
 * Session-expired broadcasting (the app's normal flow, see README).
 * ------------------------------------------------------------------ */

type SessionExpiredListener = () => void;
const sessionListeners = new Set<SessionExpiredListener>();

export function subscribeSessionExpired(listener: SessionExpiredListener): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

/** Lets the app bridge its own 401 flow (services/http.ts) into this listener set. */
export function notifySessionExpired(): void {
  broadcastSessionExpired();
}

function broadcastSessionExpired(): void {
  for (const listener of sessionListeners) listener();
}

/* ------------------------------------------------------------------ *
 * Default implementation of the app's documented conventions.
 * ------------------------------------------------------------------ */

function readStoredToken(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function rawBaseUrl(): string {
  const fromEnv = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
  return fromEnv.replace(/\/+$/, "");
}

export function videoApiBaseUrl(): string {
  return rawBaseUrl();
}

function absoluteUrl(url: string): string {
  return /^(https?:|blob:|data:)/i.test(url) ? url : `${rawBaseUrl()}${url.startsWith("/") ? url : `/${url}`}`;
}

function withQuery(path: string, query?: VideoQuery): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

function statusToCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "request_failed";
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; fields?: Record<string, string> };
}

function toFieldFields(fields: unknown): Record<string, string> {
  if (!fields || typeof fields !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value) && typeof value[0] === "string") out[key] = value[0] as string;
  }
  return out;
}

async function errorFromResponse(res: Response): Promise<VideoApiError> {
  let envelope: ErrorEnvelope | null = null;
  try {
    envelope = (await res.json()) as ErrorEnvelope;
  } catch {
    envelope = null;
  }
  const code = envelope?.error?.code ?? statusToCode(res.status);
  const message =
    envelope?.error?.message ??
    (res.status === 429 ? "Too many requests — please wait a moment." : `Request failed (${res.status}).`);
  return new VideoApiError(res.status, code, message, toFieldFields(envelope?.error?.fields));
}

async function tryRefresh(): Promise<boolean> {
  const refresh = readStoredToken(REFRESH_TOKEN_KEY);
  if (!refresh) return false;
  try {
    const res = await fetch(`${rawBaseUrl()}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { token?: string; refreshToken?: string };
    if (!data.token) return false;
    try {
      localStorage.setItem(ACCESS_TOKEN_KEY, data.token);
      if (data.refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
    } catch {
      /* storage disabled — the request simply re-authenticates next time */
    }
    return true;
  } catch {
    return false;
  }
}

function authHeaders(): Record<string, string> {
  const token = readStoredToken(ACCESS_TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function requestJson<T>(
  method: VideoHttpMethod,
  path: string,
  init: { body?: BodyInit | null; headers?: Record<string, string> },
  options?: VideoRequestOptions,
): Promise<T | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  const outerSignal = options?.signal;
  outerSignal?.addEventListener("abort", onOuterAbort);

  const url = `${rawBaseUrl()}${withQuery(path, options?.query)}`;
  const headers: Record<string, string> = { Accept: "application/json", ...authHeaders(), ...init.headers };

  try {
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: init.body ?? null, signal: controller.signal });
    } catch {
      if (outerSignal?.aborted) throw new DOMException("Aborted", "AbortError");
      throw new VideoApiError(0, "network_error", "You appear to be offline. Check your connection and retry.");
    }

    if (res.status === 401 && readStoredToken(REFRESH_TOKEN_KEY)) {
      if (await tryRefresh()) {
        return requestJson<T>(method, path, { ...init, headers: { ...authHeaders(), ...init.headers } }, options);
      }
      broadcastSessionExpired();
    }

    if (!res.ok) throw await errorFromResponse(res);
    if (res.status === 204) return undefined;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : undefined;
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

function uploadForm<T>(path: string, form: FormData, options?: VideoRequestOptions): Promise<T> {
  // XHR only because fetch() cannot report upload progress; the response handling
  // (auth header, error envelope, 401 refresh-broadcast) matches requestJson above.
  if (!options?.onProgress) {
    return requestJson<T>("POST", path, { body: form }, options).then((v) => v as T);
  }
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${rawBaseUrl()}${withQuery(path, options.query)}`, true);
    xhr.responseType = "text";
    for (const [key, value] of Object.entries(authHeaders())) xhr.setRequestHeader(key, value);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) options.onProgress?.(e.loaded, e.total);
    };
    xhr.onerror = () => reject(new VideoApiError(0, "network_error", "Upload failed — check your connection."));
    xhr.ontimeout = () => reject(new VideoApiError(0, "timeout", "Upload timed out."));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const body = xhr.responseText;
        resolve(body ? (JSON.parse(body) as T) : (undefined as T));
        return;
      }
      if (xhr.status === 401) broadcastSessionExpired();
      let envelope: ErrorEnvelope | null = null;
      try {
        envelope = JSON.parse(xhr.responseText) as ErrorEnvelope;
      } catch {
        envelope = null;
      }
      reject(
        new VideoApiError(
          xhr.status,
          envelope?.error?.code ?? statusToCode(xhr.status),
          envelope?.error?.message ?? `Upload failed (${xhr.status}).`,
          toFieldFields(envelope?.error?.fields),
        ),
      );
    };
    if (options.signal) options.signal.addEventListener("abort", () => xhr.abort());
    xhr.send(form);
  });
}

export const defaultVideoHttp: VideoHttp = {
  get<T>(path: string, query?: VideoQuery, options?: VideoRequestOptions): Promise<T> {
    return requestJson<T>("GET", path, {}, { ...options, query }) as Promise<T>;
  },
  post<T>(path: string, body?: unknown, options?: VideoRequestOptions): Promise<T> {
    const payload = body === undefined ? null : body instanceof FormData ? body : JSON.stringify(body);
    const headers: Record<string, string> =
      body === undefined || body instanceof FormData ? {} : { "Content-Type": "application/json" };
    return requestJson<T>("POST", path, { body: payload, headers }, options) as Promise<T>;
  },
  put<T>(path: string, body?: unknown, options?: VideoRequestOptions): Promise<T> {
    return requestJson<T>(
      "PUT",
      path,
      {
        body: body === undefined ? null : JSON.stringify(body),
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
      },
      options,
    ) as Promise<T>;
  },
  del<T>(path: string, options?: VideoRequestOptions): Promise<T> {
    return requestJson<T>("DELETE", path, {}, options) as Promise<T>;
  },
  upload<T>(path: string, form: FormData, options?: VideoRequestOptions): Promise<T> {
    return uploadForm<T>(path, form, options);
  },
  mediaUrl(url?: string | null): string {
    if (!url) return "";
    return absoluteUrl(url);
  },
};

/** True when the browser reports no connection — used for the feed's offline state. */
export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}
