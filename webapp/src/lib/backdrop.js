// The full-screen player's blurred backdrop, as a stack of crossfading layers.
//
// Shared by MobileNowPlaying and DesktopNowPlaying, which render the layers
// identically — the logic below used to be copy-pasted in both, so a fix landed
// in one and not the other.
//
// How it works: each new cover is PRELOADED first and only stacked once decoded,
// ON TOP of the previous layer (which stays painted meanwhile) — so a skip on a
// slow network never leaves a bare backdrop with the page showing through. The
// caller resolves the URL through the offline cache, so it also works offline.
//
// The one rule everything else follows from: `wanted` is the ONLY authority on
// what belongs on screen. Every load, retry and timeout re-checks it before
// painting, and every change to it cancels whatever was in flight. Without that
// (the old code returned early on "already showing that art" / "already
// preloading it" WITHOUT cancelling), skipping forward and then back left the
// abandoned preload alive: it finished a moment later and painted the track the
// user had already left, and nothing ever corrected it — the backdrop stayed on
// the wrong cover until the next track change.

import { writable } from "svelte/store";
import { logInfo } from "./log.js";

// URLs are long and noisy; the tail is the part that identifies the art.
const tag = (u) => (u ? String(u).slice(-44) : "(none)");

export function createBackdrop({
  fadeMs = 420, // must match the layers' in:fade duration
  timeoutMs = 7000, // an image request can hang forever with no error
  retries = 2,
} = {}) {
  // [{ id, src, url }] — `src` is what gets painted (possibly cache-busted),
  // `url` the logical cover it stands for.
  const { subscribe, set } = writable([]);
  let layers = [];
  let seq = 0;
  let wanted = ""; // the cover the CURRENT track wants on screen
  let loader = null; // Image() preloading `wanted`
  let retryTimer = null;
  let watchdog = null;
  let dropTimer = null; // removes the covered-up layer after the fade
  let destroyed = false;
  let fallback = ""; // same-origin proxy for `wanted`, tried when it fails

  // Abort the preload/retry in flight. Called on every change of `wanted`, so
  // nothing started for the previous track can still land.
  function cancelLoad() {
    if (loader) {
      loader.onload = loader.onerror = null;
      // NOT `src = ""`: an empty src resolves against the document URL, so the
      // browser would re-fetch the whole SPA page on every skip. Removing the
      // attribute is what actually aborts the image request.
      try {
        loader.removeAttribute("src");
      } catch {
        /* ignore */
      }
      loader = null;
    }
    clearTimeout(retryTimer);
    retryTimer = null;
    clearTimeout(watchdog);
    watchdog = null;
  }

  function pushLayer(src, url) {
    const id = ++seq;
    // Keep at most ONE layer under the incoming one — that's all that shows
    // through while the new art fades in. The stack used to grow until 420ms of
    // quiet finally arrived, so skipping through a dozen tracks left a dozen
    // full-screen `blur(60px)` layers composited on top of each other, which is
    // enough on its own to drag the whole view to a crawl.
    layers = [...layers.slice(-1), { id, src, url }];
    set(layers);
    logInfo("bg", `painted ${tag(url)}`);
    // Drop the covered-up layer once the fade-in has finished.
    clearTimeout(dropTimer);
    dropTimer = setTimeout(() => {
      layers = layers.filter((l) => l.id === id);
      set(layers);
    }, fadeMs);
  }

  /**
   * Fetch `url` and paint it, on behalf of the logical cover `forUrl`.
   *
   * The two are the same until we fall back to the same-origin proxy, which is
   * a DIFFERENT url standing for the SAME cover. Keeping the logical identity
   * separate is what lets the proxy paint (every check below is against the
   * cover the track wants, not against the byte source we happen to be trying)
   * and keeps the "already on screen" test meaningful afterwards.
   */
  function load(url, attempt, forUrl) {
    // Retries re-fetch under a cache-busted URL so the browser doesn't just
    // replay the failed attempt from its cache.
    const src =
      attempt && !url.startsWith("blob:")
        ? url + (url.includes("?") ? "&" : "?") + "r=" + attempt
        : url;
    const im = new Image();
    loader = im;

    // Exactly one of onload / onerror / the watchdog gets to finish this
    // attempt, and none of them paints anything unless the cover is still the
    // one we want.
    const settle = (ok) => {
      if (loader !== im) return; // superseded by a newer cover
      im.onload = im.onerror = null;
      loader = null;
      clearTimeout(watchdog);
      watchdog = null;
      if (!ok) {
        try {
          im.removeAttribute("src");
        } catch {
          /* ignore */
        }
      }
      if (destroyed || forUrl !== wanted) return;
      if (ok) {
        pushLayer(src, forUrl);
        return;
      }
      // The image CDN fails transiently; back off and try again.
      if (attempt < retries) {
        logInfo("bg", `load failed ${tag(url)} (attempt ${attempt + 1}) — retrying`);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (!destroyed && forUrl === wanted) load(url, attempt + 1, forUrl);
        }, 1200 * (attempt + 1));
        return;
      }
      // Out of retries on the art itself. Fall back to the same-origin,
      // server-cached copy before giving up — Cover.svelte has always had this
      // step, and the backdrop not having it is why a Deezer-CDN wobble left it
      // showing the PREVIOUS track for the rest of the session.
      if (fallback && fallback !== url) {
        const next = fallback;
        fallback = "";
        logInfo("bg", `${tag(url)} unreachable — falling back to ${tag(next)}`,
                null, { important: true });
        load(next, 0, forUrl);
        return;
      }
      logInfo("bg", `gave up on ${tag(url)} — keeping the previous backdrop`,
              null, { important: true });
    };

    im.onload = () => settle(true);
    im.onerror = () => settle(false);
    // A stalled image request fires NEITHER handler — no timeout applies to
    // <img> loads. Without this the backdrop stayed on the previous track for
    // the rest of the session on a flaky connection.
    watchdog = setTimeout(() => {
      watchdog = null;
      settle(im.complete && im.naturalWidth > 0);
    }, timeoutMs);
    im.src = src;
  }

  return {
    subscribe,

    /**
     * Point the backdrop at `url` (falsy = this track has no art).
     *
     * `proxyUrl` is an optional same-origin, server-cached copy of the same art
     * (`/api/cover/<id>`), used only if `url` turns out to be unreachable.
     */
    set(url, proxyUrl = "") {
      url = url || "";
      if (destroyed) return;
      if (url === wanted) return;
      logInfo("bg", `want ${tag(url)}`);
      wanted = url;
      fallback = proxyUrl || "";
      cancelLoad(); // whatever the previous track started is now irrelevant
      if (!url) {
        // No art at all. Keep the previous backdrop rather than blanking — but
        // say so, because "the blur did not change" looks identical from the
        // outside whether it is this or a failure.
        logInfo("bg", "track has no cover — keeping the previous backdrop");
        return;
      }
      const top = layers[layers.length - 1];
      if (top && (top.url || top.src) === url) {
        logInfo("bg", "already on screen");
        return; // already on screen
      }
      load(url, 0, url);
    },

    destroy() {
      destroyed = true;
      cancelLoad();
      clearTimeout(dropTimer);
      dropTimer = null;
    },
  };
}
