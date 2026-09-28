import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";

// Note: the Android app (android/) needs no webapp-side bridge — it injects a
// navigator.mediaSession shim into its WebView and feeds off the mediaSession
// metadata/state/handlers Player.svelte already maintains.

// Svelte 5 mounting API. The old `new App({ target })` form doesn't establish a
// root effect context, which leaves library deriveds/effects (e.g. svelte-spa-
// router's runes-based `router`) orphaned and crashes the boot.
const app = mount(App, { target: document.getElementById("app") });

// The app core (Rust: the lists' index, the clocks the lyrics, the animations
// and the listen party share) — a few dozen kilobytes, fetched once the first
// screen has painted so it never competes with it, and cached with the build.
// Nothing waits on it: a list searched in the first instant falls back to the
// old path, and the output clock simply has no reading yet.
const warmCore = () => import("./lib/appcore/core.js").then((m) => m.loadAppCore()).catch(() => {});
if ("requestIdleCallback" in window) requestIdleCallback(warmCore, { timeout: 1500 });
else setTimeout(warmCore, 300);

// Register the PWA service worker (installability + offline shell). Scope /app/.
// Dev (`npm run dev`) has no sw.js, so registration just fails silently.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(() => {});
  });
}

export default app;
