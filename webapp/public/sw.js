/* NSupySonic web player service worker.
 *
 * Scope is /app/ (registered from /app/sw.js). Its jobs are (1) make the app
 * installable as a PWA, (2) make the shell boot INSTANTLY, online or off, and
 * (3) download a new build in the background so the page only ever swaps to it
 * once every byte is on disk.
 *
 * Deliberately conservative: it ONLY touches same-origin GETs under /app/. The
 * Subsonic/Deezer API (/api/...) and audio streams are dynamic, auth'd and huge,
 * so they always go straight to the network — never cached.
 *
 * Update model (see lib/appversion.js for the other half): the page compares its
 * compiled-in build id against /app/version.json and, when they differ, asks us
 * to stage the new build. We fetch the new index.html plus every asset it
 * references and only then publish it as the cached shell — an interrupted
 * update leaves the OLD, complete build in place, never a half one.
 */

const CACHE = "nsupysonic-shell-v5";
const SCOPE_PATH = "/app/";
const SHELL_KEY = "/app/";

// Only ever cache a genuine success. Caching a 404/5xx (a transient 502 on a
// hashed asset, a 503 "not built" notice served as the shell) would pin that
// error forever under cache-first and brick the app until storage is cleared.
function ok(res) {
  return res && res.ok && res.status === 200;
}

// The /app/... URLs an index.html references (hashed JS/CSS, icons, fonts).
function assetUrls(html) {
  const urls = new Set();
  const re =
    /(?:href|src)="(\/app\/[^"]+\.(?:js|mjs|css|woff2?|ttf|png|svg|webmanifest))"/g;
  let m;
  while ((m = re.exec(html))) urls.add(m[1]);
  return [...urls];
}

// Fetch + cache one URL, bypassing the HTTP cache so an update really is the
// new file. Returns true on success.
async function stage(cache, url) {
  try {
    const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    if (!ok(res)) return false;
    await cache.put(url, res.clone());
    return true;
  } catch {
    return false;
  }
}

// Download a complete build (shell + assets) and publish it. Returns true when
// the whole thing landed; on any failure nothing is published.
async function stageBuild() {
  const cache = await caches.open(CACHE);
  let html;
  let shellRes;
  try {
    shellRes = await fetch(SHELL_KEY, { cache: "no-store", credentials: "same-origin" });
    if (!ok(shellRes)) return false;
    html = await shellRes.clone().text();
  } catch {
    return false;
  }
  const urls = assetUrls(html);
  // Sequential-ish but parallel enough: a handful of files, and doing them all
  // at once on a phone's link is how you starve the audio stream sharing it.
  const results = [];
  for (let i = 0; i < urls.length; i += 3) {
    results.push(
      ...(await Promise.all(urls.slice(i, i + 3).map((u) => stage(cache, u))))
    );
  }
  if (results.some((r) => !r)) return false;
  // Every asset is on disk: NOW the shell may point at them.
  await cache.put(SHELL_KEY, shellRes);
  await prune(cache, urls);
  await dropOldCaches();
  return true;
}

// A previous worker's cache, kept alive across the upgrade as a fallback (see
// the activate handler), is redundant the moment we hold a complete build.
async function dropOldCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
}

// Drop hashed assets from previous builds (they're unreachable once the shell
// stops referencing them), keeping the current build's set.
async function prune(cache, keep) {
  const keepSet = new Set(keep);
  const keys = await cache.keys();
  await Promise.all(
    keys.map((req) => {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/app/assets/") && !keepSet.has(path))
        return cache.delete(req);
      return Promise.resolve(false);
    })
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache
        .addAll([
          "/app/manifest.webmanifest",
          "/app/icon-192.png",
          "/app/icon-512.png",
        ])
        .catch(() => {});
      await stageBuild();
    })()
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop the previous worker's cache ONLY once this one holds a complete
      // shell. Upgrading while offline would otherwise delete the only copy of
      // the app on the device and leave nothing to boot from — and until then
      // `caches.match` still finds the old entries, so the old build keeps
      // serving in the meantime.
      const cache = await caches.open(CACHE);
      if (await cache.match(SHELL_KEY)) {
        const keys = await caches.keys();
        await Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
        );
      }
      await self.clients.claim();
    })()
  );
});

// The page drives updates: it knows its own build id and the server's.
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "stage-build") return;
  const source = event.source;
  event.waitUntil(
    stageBuild().then((done) => {
      source &&
        source.postMessage({
          type: done ? "update-ready" : "update-failed",
          build: data.build || null,
        });
    })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin pass
  if (!url.pathname.startsWith(SCOPE_PATH)) return; // /api, streams, etc.

  // version.json is the update signal itself — always live, never cached.
  if (url.pathname === "/app/version.json") return;

  // Content-hashed build assets are immutable → cache-first.
  if (url.pathname.startsWith("/app/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (ok(res)) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // Navigations + the shell: CACHE-FIRST. The staged build is by definition
  // complete and current (the page checks the version on every launch and after
  // an update reloads into the new one), so there is nothing to gain from
  // making every cold start wait on the network — and on a slow or
  // connected-but-dead link that wait was the whole "the app is horrible
  // offline" experience. Falls back to the network when nothing is staged yet.
  if (request.mode === "navigate" || url.pathname === SCOPE_PATH) {
    event.respondWith(
      caches.match(SHELL_KEY).then(
        (hit) =>
          hit ||
          fetch(request)
            .then((res) => {
              if (ok(res)) {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put(SHELL_KEY, copy));
              }
              return res;
            })
            .catch(() => caches.match(request))
      )
    );
    return;
  }

  // Other in-scope GETs (icons, manifest): cache-first, refresh in background.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((res) => {
          if (ok(res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
    )
  );
});
