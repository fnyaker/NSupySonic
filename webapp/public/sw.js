/* NSupySonic web player service worker.
 *
 * Scope is /app/ (registered from /app/sw.js). Its only jobs are (1) make the
 * app installable as a PWA and (2) make the shell load instantly / offline.
 *
 * Deliberately conservative: it ONLY touches same-origin GETs under /app/. The
 * Subsonic/Deezer API (/api/...) and audio streams are dynamic, auth'd and huge,
 * so they always go straight to the network — never cached.
 */

const CACHE = "nsupysonic-shell-v1";
const SCOPE_PATH = "/app/";

self.addEventListener("install", (event) => {
  // Precache the icons/manifest; the hashed JS/CSS are picked up at runtime.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        c.addAll([
          "/app/",
          "/app/manifest.webmanifest",
          "/app/icon-192.png",
          "/app/icon-512.png",
        ])
      )
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin pass
  if (!url.pathname.startsWith(SCOPE_PATH)) return; // /api, streams, etc.

  // Content-hashed build assets are immutable → cache-first.
  if (url.pathname.startsWith("/app/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
            return res;
          })
      )
    );
    return;
  }

  // Navigations + the shell: network-first so a redeploy is picked up, with the
  // cached shell as an offline fallback.
  if (request.mode === "navigate" || url.pathname === SCOPE_PATH) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/app/", copy));
          return res;
        })
        .catch(() => caches.match("/app/").then((hit) => hit || caches.match(request)))
    );
    return;
  }

  // Other in-scope GETs (icons, manifest): cache-first, refresh in background.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
          return res;
        })
    )
  );
});
