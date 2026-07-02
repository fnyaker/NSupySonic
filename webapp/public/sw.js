/* NSupySonic web player service worker.
 *
 * Scope is /app/ (registered from /app/sw.js). Its only jobs are (1) make the
 * app installable as a PWA and (2) make the shell load instantly / offline.
 *
 * Deliberately conservative: it ONLY touches same-origin GETs under /app/. The
 * Subsonic/Deezer API (/api/...) and audio streams are dynamic, auth'd and huge,
 * so they always go straight to the network — never cached.
 */

const CACHE = "nsupysonic-shell-v3";
const SCOPE_PATH = "/app/";

// Precache the shell + its hashed JS/CSS so an airplane-mode launch actually
// boots. The asset filenames are content-hashed (unknown ahead of time), so we
// fetch the freshly-served index.html and pull the /app/... asset URLs out of
// it — without this the offline shell loads but the scripts it needs don't, and
// offline mode never works until the app happens to be reloaded online twice.
async function precache() {
  const cache = await caches.open(CACHE);
  await cache
    .addAll([
      "/app/",
      "/app/manifest.webmanifest",
      "/app/icon-192.png",
      "/app/icon-512.png",
    ])
    .catch(() => {});
  try {
    const res = await fetch("/app/", { cache: "no-store" });
    const html = await res.text();
    const urls = new Set();
    const re =
      /(?:href|src)="(\/app\/[^"]+\.(?:js|mjs|css|woff2?|ttf|png|svg|webmanifest))"/g;
    let m;
    while ((m = re.exec(html))) urls.add(m[1]);
    if (urls.size) await cache.addAll([...urls]).catch(() => {});
  } catch {
    /* offline during install — assets fall back to first online fetch */
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache());
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

  // Navigations + the shell: network-first so a redeploy is picked up, but
  // RACED against a short timeout — on a connected-but-dead network the fetch
  // can hang for tens of seconds, so after 3s we serve the cached shell and let
  // the fetch finish in the background (still refreshing the cache for next time).
  if (request.mode === "navigate" || url.pathname === SCOPE_PATH) {
    const networked = fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put("/app/", copy));
      return res;
    });
    networked.catch(() => {}); // don't surface as unhandled when we serve cache
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
    event.respondWith(
      Promise.race([networked, timeout])
        .then((res) => res || caches.match("/app/").then((hit) => hit || networked))
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
