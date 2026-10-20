import { API_BASE_URL, REQUEST_TIMEOUT_MS, TOKEN_STORAGE_KEY, REFRESH_STORAGE_KEY } from "./config";

export class ApiError extends Error {
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

type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

export function onSessionExpired(fn: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(fn);
  return () => sessionExpiredListeners.delete(fn);
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

let accessToken: string | null = readStorage(TOKEN_STORAGE_KEY);
let refreshToken: string | null = readStorage(REFRESH_STORAGE_KEY);

export const tokenStore = {
  // Read storage on every access: the video transport (services/videoHttp.ts) writes
  // rotated tokens to the same keys, so a module-level cache would go stale and make
  // the next 401-refresh here present an already-rotated refreshToken and end the session.
  get access() {
    return readStorage(TOKEN_STORAGE_KEY) ?? accessToken;
  },
  get refresh() {
    return readStorage(REFRESH_STORAGE_KEY) ?? refreshToken;
  },
  set(access: string | null, refresh?: string | null) {
    accessToken = access;
    writeStorage(TOKEN_STORAGE_KEY, access);
    if (refresh !== undefined) {
      refreshToken = refresh;
      writeStorage(REFRESH_STORAGE_KEY, refresh);
    }
  },
  clear() {
    tokenStore.set(null, null);
  },
};

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  auth?: boolean;
  formData?: FormData;
  timeoutMs?: number;
  retryOnNetworkError?: boolean;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(API_BASE_URL + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function parseError(res: Response): Promise<ApiError> {
  let code = "api_error";
  let message = `Request failed (${res.status})`;
  let fieldErrors: Record<string, string> = {};
  try {
    const data = await res.json();
    const err = data?.error;
    // The legacy platform router returns errors as a bare string, the SPA router as an envelope.
    if (typeof err === "string") message = err;
    else if (err) {
      code = err.code ?? code;
      message = err.message ?? message;
      fieldErrors = err.fields ?? {};
    }
  } catch {
    /* non-JSON error body */
  }
  if (res.status === 401) code = "unauthorized";
  if (res.status === 403) code = "forbidden";
  if (res.status === 404) code = "not_found";
  if (res.status === 429) code = "rate_limited";
  return new ApiError(res.status, code, message, fieldErrors);
}

let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!tokenStore.refresh) return false;
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(buildUrl("/api/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: tokenStore.refresh }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      tokenStore.set(data.token, data.refreshToken ?? undefined);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const {
    method = "GET",
    body,
    query,
    signal,
    auth = true,
    formData,
    timeoutMs = REQUEST_TIMEOUT_MS,
    retryOnNetworkError = method === "GET",
  } = opts;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), timeoutMs);
  const onOuterAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onOuterAbort);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (auth && tokenStore.access) headers.Authorization = `Bearer ${tokenStore.access}`;
  if (body !== undefined && !formData) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: controller.signal,
    });
  } catch (err) {
    const isTimeout = (err as Error)?.name === "TimeoutError";
    // A slow response is retried no better than a dead one — waiting twice only delays the error state.
    if (!isTimeout && retryOnNetworkError && !signal?.aborted) {
      return request<T>(path, { ...opts, retryOnNetworkError: false });
    }
    throw new ApiError(0, isTimeout ? "timeout" : "network_error", isTimeout ? "The server took too long to respond. Please try again." : "Cannot reach the server. Check your connection.");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onOuterAbort);
  }

  if (res.status === 401 && auth && tokenStore.refresh) {
    const refreshed = await tryRefresh();
    if (refreshed) return request<T>(path, { ...opts, retryOnNetworkError: false });
    tokenStore.clear();
    sessionExpiredListeners.forEach((fn) => fn());
  }

  if (!res.ok) throw await parseError(res);

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const http = {
  get: <T>(path: string, query?: RequestOptions["query"], opts?: Partial<RequestOptions>) =>
    request<T>(path, { ...opts, method: "GET", query }),
  post: <T>(path: string, body?: unknown, opts?: Partial<RequestOptions>) =>
    request<T>(path, { ...opts, method: "POST", body }),
  put: <T>(path: string, body?: unknown, opts?: Partial<RequestOptions>) =>
    request<T>(path, { ...opts, method: "PUT", body }),
  patch: <T>(path: string, body?: unknown, opts?: Partial<RequestOptions>) =>
    request<T>(path, { ...opts, method: "PATCH", body }),
  del: <T>(path: string, opts?: Partial<RequestOptions>) => request<T>(path, { ...opts, method: "DELETE" }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: "POST", formData: form, timeoutMs: 60_000 }),
};

/** Resolve a relative media URL from the backend against the API base. */
export function mediaUrl(url: string | null | undefined): string {
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : API_BASE_URL + url;
}
