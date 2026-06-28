// Connectivity state, shared across the app.
//
// `navigator.onLine` is unreliable (it reports true on a connected-but-dead
// network, and doesn't notice a server that went away), so we treat it only as
// a hint and refine the real state from actual request outcomes: api.js calls
// reportOnline()/reportOffline() on every success/network-failure. While we
// believe we're offline we actively probe the server so playback and the UI
// recover even when no `online` event ever fires.

import { writable, get } from "svelte/store";

export const online = writable(
  typeof navigator === "undefined" ? true : navigator.onLine
);

// Bumped every time we transition back to online, so consumers (the player) can
// react to "we just reconnected" without polling.
export const reconnectedAt = writable(0);

let probeTimer = null;

export function reportOnline() {
  if (!get(online)) {
    online.set(true);
    reconnectedAt.set(Date.now());
  }
  stopProbe();
}

export function reportOffline() {
  if (get(online)) online.set(false);
  startProbe();
}

// Lightweight reachability check: a cheap, credentialed GET. A 401 still proves
// the server is reachable (we're just logged out), so it counts as online.
async function probeOnce() {
  try {
    const r = await fetch("/api/me", { credentials: "include", cache: "no-store" });
    return r.ok || r.status === 401;
  } catch {
    return false;
  }
}

function startProbe() {
  if (probeTimer) return;
  let delay = 2000;
  const tick = async () => {
    probeTimer = null;
    if (get(online)) return;
    if (await probeOnce()) {
      reportOnline();
      return;
    }
    delay = Math.min(Math.round(delay * 1.6), 15000);
    probeTimer = setTimeout(tick, delay);
  };
  probeTimer = setTimeout(tick, delay);
}

function stopProbe() {
  if (probeTimer) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
}

export function initConnectivity() {
  if (typeof window === "undefined") return;
  // The browser events are a fast hint; the probe confirms real reachability.
  window.addEventListener("online", () => {
    if (navigator.onLine) startProbe(); // verify before declaring us back
  });
  window.addEventListener("offline", reportOffline);
}
