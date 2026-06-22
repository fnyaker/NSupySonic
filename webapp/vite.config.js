import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Served by Flask under /app, so assets must be referenced from /app/.
// Build output goes straight into the Python package so it ships in Docker.
// Svelte preprocessing (incl. TS) is configured in svelte.config.js.
export default defineConfig({
  plugins: [svelte()],
  base: "/app/",
  build: {
    outDir: "../supysonic/webui/dist",
    emptyOutDir: true,
  },
  server: {
    // `npm run dev` proxies API calls to a locally running supysonic.
    proxy: {
      "/api": "http://localhost:5000",
    },
  },
});
