/* Professionalist service worker — offline shell + static asset caching.
   The VPS API is never cached; failed API calls return a JSON 503 the client can surface. */

const VERSION = "professionalist-v2";
const STATIC = `${VERSION}-static`;
const RUNTIME = `${VERSION}-runtime`;

const PRECACHE = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/brand/logo-mark.png",
  "/brand/logo-mark-dark.png",
  "/brand/logo-full.png",
  "/brand/logo-full-dark.png",
  "/brand/favicon-48.png",
  "/brand/favicon-32.png",
  "/brand/favicon-16.png",
  "/brand/apple-touch-icon.png",
  "/brand/icon-192.png",
  "/brand/icon-512.png",
  "/brand/og-cover.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (url.pathname.startsWith("/api/")) return;

  const hashedAsset = url.origin === self.location.origin && /\/assets\/|\.js$|\.css$/.test(url.pathname);
  const font = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  const image = url.pathname.startsWith("/brand/") || /\.(png|jpe?g|svg|webp|avif|ico)(\?|$)/i.test(url.pathname);
  const navigation = request.mode === "navigate" || request.headers.get("Accept")?.includes("text/html");

  event.respondWith(
    (async () => {
      const cache = await caches.open(RUNTIME);
      if (hashedAsset || image) {
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          if (res.ok) cache.put(request, res.clone());
          return res;
        } catch (err) {
          if (font) return Response.error();
          throw err;
        }
      }
      try {
        const res = await fetch(request);
        if (navigation && res.ok) cache.put(request, res.clone());
        return res;
      } catch (err) {
        if (navigation) {
          const shell = (await cache.match(request)) || (await caches.match("/index.html"));
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
