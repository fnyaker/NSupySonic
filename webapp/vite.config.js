import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// One identity per build, compiled INTO the bundle and written NEXT TO it.
// The running app knows which build it is (__APP_BUILD__) and the server knows
// which build it serves (dist/version.json), so "is there a new version?" is an
// exact comparison instead of a guess about cache freshness. CI can pin it with
// NSUPY_BUILD_ID; otherwise every build gets a fresh timestamped id.
const BUILD_ID =
  process.env.NSUPY_BUILD_ID || `${pkg.version}+${Date.now().toString(36)}`;

function buildStamp() {
  let outDir = "dist";
  return {
    name: "nsupysonic-build-stamp",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      writeFileSync(
        join(outDir, "version.json"),
        JSON.stringify({ build: BUILD_ID, version: pkg.version, ts: Date.now() })
      );
    },
  };
}

// Served by Flask under /app, so assets must be referenced from /app/.
// Build output goes straight into the Python package so it ships in Docker.
// Svelte preprocessing (incl. TS) is configured in svelte.config.js.
export default defineConfig({
  plugins: [svelte(), buildStamp()],
  base: "/app/",
  define: {
    __APP_BUILD__: JSON.stringify(BUILD_ID),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
