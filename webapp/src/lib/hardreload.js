// Reload the web app FROM SCRATCH, for the day it is stuck in a state a plain
// reload does not leave.
//
// The case that asked for it: a GPU crash. Chromium answers a crashed GPU
// process by refusing WebGL to the page (`getContext("webgl2")` returns null),
// the visualizer falls back to its 2D canvas for good — the spectrum bars for
// every mode, the oscilloscope for the scope — and nothing in the page can undo
// that; a fresh document can. And the same freeze can leave things LEARNT on the
// device that are only true of that bad moment: the audio path convicted of
// losing audio while the page was frozen (audio.glitchRoutes), an analysis
// look-ahead learnt against frames that arrived seconds late.
//
// So this forgets exactly what the device learnt or cached about itself and
// reloads past every cache, and keeps everything the person made or chose:
// their login (a cookie), their settings, their queue and position (the
// session is restored on the way back up), their downloads and the offline
// copies (IndexedDB is not touched).

// Device-learnt state: measured or cached here, re-learnt or re-asked on use.
const LEARNT_KEYS = [
  "audio.analysis", // the served verdicts (asked again)
  "audio.edges.v3", // silence bounds (asked again)
  "audio.glitchRoutes", // outputs convicted of losing audio
  "viz.lookahead.learned", // the automatic look-ahead
  "app.updateAttempt", // the update loop guard
];

/** Forget what the device learnt, drop the shell, and reload from the server. */
export async function hardReload() {
  for (const k of LEARNT_KEYS) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* private mode: nothing to forget */
    }
  }
  // The service worker serves the shell cache-first: without dropping both,
  // "reload" would boot the very build that was running, from the cache.
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
  } catch {
    /* no worker */
  }
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      // Only the shell lives in Cache Storage (sw.js deletes every other name);
      // audio and offline copies are in IndexedDB.
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* ignore */
  }
  // A query the shell has never seen, so no HTTP cache answers for it either;
  // the hash keeps the screen. main.js registers the worker again on load.
  const url = new URL(window.location.href);
  url.searchParams.set("fresh", String(Date.now()));
  window.location.replace(url.toString());
}

/** The marker hardReload put in the URL, taken back out once it has done its job. */
export function dropFreshMarker() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("fresh")) return;
    url.searchParams.delete("fresh");
    window.history.replaceState(window.history.state, "", url.toString());
  } catch {
    /* ignore */
  }
}
