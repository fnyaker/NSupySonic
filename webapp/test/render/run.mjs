#!/usr/bin/env node
// The render bench: every GL world, rendered for real and photographed.
//
//   node test/render/run.mjs                     # every world, default track
//   node test/render/run.mjs --world forge,tunnel --genre frenchcore --bpm 200
//   node test/render/run.mjs --phone             # the phone player, cover in the middle
//   node test/render/run.mjs --phone --pscale 2  # ... at twice the size, to read detail
//   node test/render/run.mjs --world tunnel --genre ebm --skin   # as ebm dresses it
//   node test/render/run.mjs --check             # fail on the contracts below
//   node test/render/run.mjs --tempo             # the 90-vs-180 BPM stopwatch
//
// It needs a browser, which is why it is not part of `npm test`: it starts the
// Vite dev server, opens test/render/bench.html in headless Chromium (Playwright,
// with SwiftShader so it needs no GPU), drives each world through the synthetic
// arrangement in music.mjs and writes a contact sheet per world plus a JSON
// report to --out (default: test/render/out, which is git-ignored).
//
// THE CONTRACTS (--check). The same questions the canvas scenes were once asked
// through a stub that recorded stroke coordinates — asked now of real pixels:
//
//   fills the frame   every one of the four borders carries light in the drop
//                     (a world built round an inscribed circle leaves a 16:9
//                     beamer's sides black);
//   exposure          the drop's mean is neither a black screen nor a white one,
//                     and almost nothing clips;
//   keeps off the     on the phone, less than a quarter of the picture's light
//   artwork           sits behind the cover;
//   answers the       the drop and the breakdown are measurably different
//   moment            pictures (a world that ignores the music draws them alike);
//   plays the tempo   (--tempo) the picture moves materially more per second at
//                     180 BPM than at 90 — a rate hard-coded in seconds scores
//                     ~1.0 and fails.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const webapp = resolve(here, "../..");

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

async function loadPlaywright() {
  for (const spec of ["playwright", "playwright-core"]) {
    try {
      return await import(spec);
    } catch {
      /* try the next */
    }
  }
  let root = "";
  try {
    root = execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    /* no npm */
  }
  for (const name of ["playwright", "playwright-core"]) {
    const p = join(root, name, "index.mjs");
    if (root && existsSync(p)) return import(pathToFileURL(p).href);
  }
  throw new Error(
    "Playwright is not installed. `npm i -g playwright && npx playwright install chromium`, " +
      "or add it to this project's devDependencies."
  );
}

async function worldList() {
  const src = readFileSync(join(webapp, "src/lib/viz/worlds/index.js"), "utf8");
  const block = src.match(/const LOADERS = \{([\s\S]*?)\n\};/);
  return block ? [...block[1].matchAll(/^\s*([a-z0-9]+):/gm)].map((m) => m[1]) : [];
}

// --pscale 2 renders the phone at twice the size, to look at detail; the
// contracts are scale-free, so --check is unaffected either way.
const PSCALE = Math.max(1, +arg("pscale", 1) || 1);
const PHONE = { w: 270 * PSCALE, h: 585 * PSCALE };
function phoneHole() {
  const side = Math.round(PHONE.w * 0.72);
  return { x: Math.round((PHONE.w - side) / 2), y: Math.round((PHONE.h - side) / 2) - 40 * PSCALE, w: side, h: side };
}

function fmt(v, d = 3) {
  return Number.isFinite(v) ? v.toFixed(d) : String(v);
}

async function main() {
  const out = resolve(arg("out", join(here, "out")));
  mkdirSync(out, { recursive: true });
  const all = await worldList();
  const want = arg("world") ? String(arg("world")).split(",") : all;
  const genre = arg("genre", "techno");
  const bpm = +arg("bpm", 128);
  const tier = arg("tier", "high");
  const palette = arg("palette", "neon");
  const [w, h] = String(arg("size", "640x360")).split("x").map(Number);
  const check = !!arg("check");
  const phone = !!arg("phone") || check;
  const tempo = !!arg("tempo") || check;
  const shots = arg("shots") ? String(arg("shots")).split(",") : undefined;
  // --skin: draw the world the way the smart engine does for --genre — pinned,
  // so it wears the genre's skin (its palette lean AND, when the genre lives on
  // this world, its shape parameters). Without it the world runs on its own
  // defaults, which is what the contracts are about.
  const skin = !!arg("skin");

  const { createServer } = await import("vite");
  const server = await createServer({
    root: webapp,
    configFile: false,
    logLevel: "error",
    // No hot reload and no watcher: editing a world while a sweep runs used
    // to reload the bench page under it, and every world after that
    // "crashed" with window.bench undefined.
    server: { port: 0, host: "127.0.0.1", hmr: false, watch: null },
    // Only the viz modules are served; scanning the Svelte app for dependencies
    // (with no Svelte plugin loaded) is slow and prints nothing but errors.
    optimizeDeps: { noDiscovery: true, entries: [] },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, "");
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const logs = [];
  page.on("console", (m) => {
    if (m.type() === "error") logs.push(m.text());
  });
  page.on("pageerror", (e) => logs.push(String(e)));
  await page.goto(`${url}/test/render/bench.html`);
  await page.waitForFunction(() => window.bench?.ready, null, { timeout: 60000 });

  const report = {};
  const failures = [];
  const run = (opts) => page.evaluate((o) => window.bench.run(o), opts);
  const save = (name, dataUrl) =>
    writeFileSync(join(out, name), Buffer.from(dataUrl.split(",")[1], "base64"));

  for (const world of want) {
    const t0 = Date.now();
    const r = { world };
    try {
      const wide = await run({ world, genre, bpm, w, h, tier, palette, shots, skin });
      save(`${world}.png`, wide.sheet);
      r.wide = wide.frames;
      r.cost = wide.costMs;
      r.errors = wide.errors;
      if (phone) {
        const ph = await run({
          world, genre, bpm, w: PHONE.w, h: PHONE.h, hole: phoneHole(), tier, palette,
          shots: ["breakdown", "drop", "dropOff"], cols: 3, skin,
        });
        save(`${world}-phone.png`, ph.sheet);
        r.phone = ph.frames;
        r.errors = [...(r.errors || []), ...ph.errors];
      }
      if (tempo) {
        // The same two seconds of wall clock in the second drop, at 90 and at
        // 180 BPM: how much does the picture change, frame to frame, on
        // average? Averaged over the window, not read off one pair of frames —
        // a single pair right on a kick measures the kick's envelope, and
        // most worlds scored about 1.0 on it.
        const motion = async (b) => {
          const res = await run({
            world, genre, bpm: b, w: 320, h: 180, tier, palette,
            shots: ["drop"], motionGap: 1 / 30, motionWindow: 2, grain: false,
          });
          return res.frames[0].m;
        };
        const slow = await motion(90);
        const fast = await motion(180);
        // Three readings, and the strongest counts. Frame-to-frame change on
        // blocks saturates on a fast world (the picture is already new every
        // frame at both tempos); the change over the whole window does the
        // opposite, and is what a calm world's slow drift shows up in; and
        // only the pixel-level reading sees motion finer than a block, like a
        // sea's small waves. A clock in seconds scores ~1.0 on all three, so
        // taking the largest cannot let one through.
        const rPairs = fast.motion / Math.max(1e-6, slow.motion);
        const rSpan = fast.span / Math.max(1e-6, slow.span);
        const rFine = fast.fine / Math.max(1e-6, slow.fine);
        r.tempo = { slow: slow.motion, fast: fast.motion, rPairs, rSpan, rFine, ratio: Math.max(rPairs, rSpan, rFine) };
      }
    } catch (e) {
      r.crash = String(e?.stack || e);
    }
    r.seconds = (Date.now() - t0) / 1000;
    report[world] = r;

    // --- the contracts ---
    const fail = (msg) => failures.push(`${world}: ${msg}`);
    if (r.crash) fail(`crashed: ${r.crash.split("\n")[0]}`);
    if (r.errors?.length) fail(`GL errors: ${r.errors[0].slice(0, 300)}`);
    const drop = r.wide?.find((f) => f.name === "drop")?.m;
    const quiet = r.wide?.find((f) => f.name === "breakdown")?.m;
    if (drop) {
      const e = drop.edges;
      const minEdge = Math.min(e.left, e.right, e.top, e.bottom);
      if (world !== "spectrum" && minEdge < 0.012) fail(`an edge is dark in the drop (${fmt(minEdge)})`);
      // Exposure is judged across the beat — the instant after a flashed
      // downbeat and the half-beat after it — because a strobe frame is
      // SUPPOSED to be bright, and grading it alone would outlaw the strobe.
      const off = r.wide?.find((f) => f.name === "dropOff")?.m;
      const mean = off ? (drop.mean + off.mean) / 2 : drop.mean;
      if (mean < 0.035) fail(`the drop is nearly black (mean ${fmt(mean)})`);
      if (mean > 0.45) fail(`the drop is washed out (mean ${fmt(mean)})`);
      if (drop.clipped > 0.12) fail(`${fmt(drop.clipped * 100, 1)}% of the drop clips`);
    }
    if (drop && quiet) {
      const d = Math.abs(drop.mean - quiet.mean) / Math.max(1e-3, drop.mean);
      let hd = 0;
      for (let i = 0; i < 64; i++) hd += Math.abs(drop.hist[i] - quiet.hist[i]);
      r.contrast = { mean: d, layout: hd };
      if (d < 0.08 && hd < 0.08) fail(`the drop and the breakdown look the same (${fmt(d)}, ${fmt(hd)})`);
    }
    const ph = r.phone?.find((f) => f.name === "drop")?.m;
    if (ph && ph.holeShare > 0.25) fail(`${fmt(ph.holeShare * 100, 0)}% of the light is behind the cover`);
    if (r.tempo && r.tempo.ratio < 1.25) fail(`moves the same at 90 and 180 BPM (ratio ${fmt(r.tempo.ratio, 2)})`);

    const line = [
      world.padEnd(12),
      drop ? `mean ${fmt(drop.mean)}` : "",
      drop ? `clip ${fmt(drop.clipped * 100, 1)}%` : "",
      drop ? `detail ${fmt(drop.detail)}` : "",
      drop ? `motion ${fmt(drop.motion)}` : "",
      ph ? `cover ${fmt(ph.holeShare * 100, 0)}%` : "",
      r.tempo ? `tempo x${fmt(r.tempo.ratio, 2)}` : "",
      r.cost ? `${fmt(r.cost, 0)} ms/frame (sw)` : "",
      `${fmt(r.seconds, 1)}s`,
    ].filter(Boolean);
    console.log(line.join("  "));
  }

  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
  await browser.close();
  await server.close();
  if (logs.length) console.log(`\n${logs.length} console errors; first:\n${logs[0].slice(0, 2000)}`);
  if (failures.length) {
    console.log(`\n${failures.length} failure(s):\n  ${failures.join("\n  ")}`);
    if (check) process.exit(1);
  } else if (check) console.log("\nall contracts hold");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
