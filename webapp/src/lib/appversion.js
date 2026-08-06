// Web app version management.
//
// A PWA is an install, not a page: a phone can keep a months-old bundle alive in
// its service-worker cache and never find out the server moved on. So the app
// knows its OWN build id (compiled in at build time) and asks the server which
// build it serves (/app/version.json, never cached). When they differ the new
// build is downloaded IN FULL in the background — shell plus every asset — and
// only then does the page swap to it, by reloading. An interrupted download
// changes nothing: the previous, complete build stays in place.
//
// The other half of this lives in public/sw.js (the staging + cache-first
// shell). Together they're what makes a cold start instant and an update
// invisible, instead of the app spending the first three seconds of every
// launch waiting on a slow network for an index.html it already had.

import { get } from "svelte/store";
import { notices, player, toasts } from "./stores.js";
import { logInfo } from "./log.js";

// Injected by vite (see vite.config.js). Undefined under `npm run dev`.
export const BUILD =
  typeof __APP_BUILD__ !== "undefined" ? __APP_BUILD__ : null;

const VERSION_URL = "/app/version.json";
// How often to look for a new build while the app stays open.
const CHECK_INTERVAL = 30 * 60 * 1000;
// …and how long since the last check before a return-to-foreground triggers one.
const FOREGROUND_MIN_AGE = 10 * 60 * 1000;
// Auto-reload guard: if a reload doesn't actually change the running build
// (mis-set caches, a proxy pinning index.html), stop reloading and just offer
// the button. Without this the app could reload-loop forever.
const ATTEMPT_KEY = "app.updateAttempt";
const MAX_AUTO_RELOADS = 2;

let lastCheck = 0;
let staging = false;
let staged = null; // build id already downloaded and waiting for a reload
let timer = null;

async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

function attempts(build) {
  try {
    const raw = JSON.parse(localStorage.getItem(ATTEMPT_KEY) || "null");
    return raw && raw.build === build ? raw.count || 0 : 0;
  } catch {
    return 0;
  }
}
function noteAttempt(build) {
  try {
    localStorage.setItem(
      ATTEMPT_KEY,
      JSON.stringify({ build, count: attempts(build) + 1 })
    );
  } catch {
    /* private mode — we just lose the loop guard */
  }
}
function clearAttempts() {
  try {
    localStorage.removeItem(ATTEMPT_KEY);
  } catch {
    /* ignore */
  }
}

// The service worker controlling this page, waiting briefly for one on a first
// visit (registration happens on window load, and the worker only takes control
// once it activates and claims us).
async function controller() {
  const sw = navigator.serviceWorker;
  if (!sw) return null;
  if (sw.controller) return sw.controller;
  try {
    await Promise.race([
      sw.ready,
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (!sw.controller)
      await new Promise((r) => {
        const done = () => {
          sw.removeEventListener("controllerchange", done);
          r();
        };
        sw.addEventListener("controllerchange", done);
        setTimeout(done, 3000);
      });
  } catch {
    /* no worker — handled by the null return */
  }
  return sw.controller || null;
}

// Ask the service worker to download the whole new build. Resolves true once
// every byte is cached. No service worker (dev server, unsupported browser) →
// false, and the caller falls back to offering a manual reload.
async function stageBuild(build) {
  const sw = navigator.serviceWorker;
  const worker = await controller();
  if (!worker) return false;
  return new Promise((resolve) => {
    const channel = (event) => {
      const data = event.data || {};
      if (data.type !== "update-ready" && data.type !== "update-failed") return;
      sw.removeEventListener("message", channel);
      clearTimeout(bail);
      resolve(data.type === "update-ready");
    };
    // Never hang the update state machine on a worker that went away.
    const bail = setTimeout(() => {
      sw.removeEventListener("message", channel);
      resolve(false);
    }, 120000);
    sw.addEventListener("message", channel);
    worker.postMessage({ type: "stage-build", build });
  });
}

function applyNow() {
  clearTimeout(timer);
  window.location.reload();
}

// When to swap by ourselves: only in the first moments of a session, before
// anyone has done anything worth losing. An update that lands 40 minutes in is
// offered, never imposed — yanking the page out from under someone mid-browse
// (or mid-song) is exactly the kind of thing that makes an app feel unreliable.
// Nothing is lost by waiting either way: the build is already on disk, so the
// next cold start runs it regardless.
const BOOT_WINDOW = 90 * 1000;
const startedAt = Date.now();

function apply(build) {
  const playing = get(player).playing;
  const booting = Date.now() - startedAt < BOOT_WINDOW;
  if (!playing && booting && attempts(build) < MAX_AUTO_RELOADS) {
    noteAttempt(build);
    logInfo("update", `applying build ${build} at boot`, null, { important: true });
    applyNow();
    return;
  }
  notices.push({
    id: "app-update",
    kind: "info",
    message: "Nouvelle version téléchargée, prête à être appliquée.",
    actionLabel: "Redémarrer",
    action: () => {
      noteAttempt(build);
      applyNow();
    },
  });
}

export async function checkForUpdate() {
  if (staging) return false;
  lastCheck = Date.now();
  let info;
  try {
    info = await fetchJSON(VERSION_URL);
  } catch {
    return false; // offline or no version stamp — nothing to do, quietly
  }
  const server = info && info.build;
  if (!server) return false;
  if (!BUILD || server === BUILD) {
    // Running what the server serves: any previous attempt succeeded.
    clearAttempts();
    notices.dismiss("app-update");
    return false;
  }
  if (staged === server) {
    apply(server);
    return true;
  }
  logInfo("update", `server build ${server} != local ${BUILD}; staging`, null, {
    important: true,
  });
  staging = true;
  let done = false;
  try {
    done = await stageBuild(server);
  } finally {
    staging = false;
  }
  if (done) {
    staged = server;
    apply(server);
    return true;
  }
  // No service worker to stage with (or the download failed): a plain reload
  // still fetches the new build, it just isn't pre-downloaded — so OFFER it
  // rather than doing it. Reloading a page we haven't verified we can re-fetch
  // is how you strand someone on a blank screen at the wrong moment.
  notices.push({
    id: "app-update",
    kind: "info",
    message: "Une nouvelle version est disponible.",
    actionLabel: "Mettre à jour",
    action: () => {
      noteAttempt(server);
      applyNow();
    },
  });
  return false;
}

// -- native (Android) app ---------------------------------------------------

// "1.4.0" vs "1.10.2" — numeric, segment by segment, ignoring a leading "v" and
// any build suffix. Returns >0 when `a` is newer.
export function compareVersions(a, b) {
  const parse = (v) =>
    String(v || "")
      .trim()
      .replace(/^v/i, "")
      .split(/[^\d]+/)
      .filter((s) => s !== "")
      .map(Number);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

// The version of the native shell hosting us, if we're inside it.
export function nativeVersion() {
  try {
    const v = window.NSNative && window.NSNative.appVersion;
    return typeof v === "function" ? String(v.call(window.NSNative) || "") : null;
  } catch {
    return null;
  }
}

// Startup-only check: is the installed Android app older than the one this
// server expects? Deliberately not repeated during the session — an update you
// can't apply without leaving the app is a one-time piece of information, not a
// running alarm.
export async function checkAndroidUpdate() {
  const installed = nativeVersion();
  if (!installed) return; // browser / PWA — nothing to update here
  let info;
  try {
    info = await fetchJSON("/api/version");
  } catch {
    return;
  }
  const android = (info && info.android) || {};
  if (!android.version) return; // the server doesn't publish one: claim nothing
  if (compareVersions(android.version, installed) <= 0) return;
  notices.push({
    id: "android-update",
    kind: "info",
    message: `Une nouvelle version de l'application Android (${android.version}) est disponible — vous utilisez la ${installed}.`,
    actionLabel: "Télécharger",
    action: () => openExternal(android.url),
  });
}

// Open a link outside the app. In the Android shell `window.open` is a no-op
// (multiple windows are disabled); a plain navigation is what reaches
// shouldOverrideUrlLoading, which hands a foreign URL to the system browser and
// leaves the WebView exactly where it was.
function openExternal(url) {
  if (!url) return;
  try {
    if (nativeVersion() !== null) window.location.href = url;
    else window.open(url, "_blank", "noopener");
  } catch {
    toasts.push("Impossible d'ouvrir le lien de téléchargement", "error");
  }
}

// Wire everything up. Call once at startup.
export function initVersionWatch() {
  if (typeof window === "undefined") return;
  checkForUpdate();
  checkAndroidUpdate();
  clearInterval(timer);
  timer = setInterval(() => checkForUpdate(), CHECK_INTERVAL);
  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      Date.now() - lastCheck > FOREGROUND_MIN_AGE
    )
      checkForUpdate();
  });
}
