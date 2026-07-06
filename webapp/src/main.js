import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { initNativeBridge } from "./lib/native.js";

// Inside the Android app (android/): mirror the player to the native
// MediaSession + foreground service. A no-op in a regular browser.
initNativeBridge();

// Svelte 5 mounting API. The old `new App({ target })` form doesn't establish a
// root effect context, which leaves library deriveds/effects (e.g. svelte-spa-
// router's runes-based `router`) orphaned and crashes the boot.
const app = mount(App, { target: document.getElementById("app") });

// Register the PWA service worker (installability + offline shell). Scope /app/.
// Dev (`npm run dev`) has no sw.js, so registration just fails silently.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(() => {});
  });
}

export default app;
