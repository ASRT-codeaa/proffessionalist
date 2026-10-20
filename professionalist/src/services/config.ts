/**
 * Central runtime configuration. The VPS backend base URL comes exclusively
 * from VITE_API_URL — never hardcode a host or IP in components.
 */
function normalizeBaseUrl(raw: string | undefined): string {
  const fallback = "https://api.proffessionalist.com";
  let url = (raw ?? "").trim() || fallback;
  if (typeof window !== "undefined" && !/^https?:\/\//i.test(url)) {
    url = `${window.location.protocol}//${url}`;
  }
  return url.replace(/\/+$/, "");
}

export const API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_API_URL as string | undefined);

export const IS_PROD = import.meta.env.PROD;

if (IS_PROD && !API_BASE_URL.startsWith("https://")) {
  // eslint-disable-next-line no-console
  console.warn("[Professionalist] VITE_API_URL should use HTTPS in production.");
}

export const REQUEST_TIMEOUT_MS = 15_000;
export const TOKEN_STORAGE_KEY = "professionalist.token";
export const REFRESH_STORAGE_KEY = "professionalist.refresh";
export const THEME_STORAGE_KEY = "professionalist.theme";
