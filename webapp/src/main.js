import "./app.css";
import App from "./App.svelte";

const app = new App({ target: document.getElementById("app") });

// Register the PWA service worker (installability + offline shell). Scope /app/.
// Dev (`npm run dev`) has no sw.js, so registration just fails silently.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(() => {});
  });
}

export default app;
