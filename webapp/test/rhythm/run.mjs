#!/usr/bin/env node
// The rhythm analyser in a real browser, end to end.
//
//   node test/rhythm/run.mjs                       # hardstyle, techno, frenchcore
//   node test/rhythm/run.mjs --only uptempo-220 --seconds 30
//   node test/rhythm/run.mjs --seed                # with a served verdict
//
// test/eval measures the analyser itself, in Node, on exact sample times. This
// asks the other question: does what the ANIMATIONS receive match the music —
// through the Web Audio graph, the AudioWorklet, the WebAssembly module and the
// engine's delivery queue, in headless Chromium, in real time. It plays a
// record from test/songs.mjs through a real <audio> element and scores the
// kicks and beats the engine hands out against the record's ground truth.
// Like the render bench it needs a browser, so it is not part of `npm test`.
//
// The engine stamps every frame with the context time its audio passed the
// tap, so event times are compared on the context clock; the one constant
// between the two (when the element started, as the context saw it) is fitted
// as the median offset, and what is scored is everything that is left.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SONG_BY_ID } from "../songs.mjs";
import { loadSong, songFile } from "../eval/rhythm-eval.mjs";

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
  const root = execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  for (const name of ["playwright", "playwright-core"]) {
    const p = join(root, name, "index.mjs");
    if (existsSync(p)) return import(pathToFileURL(p).href);
  }
  throw new Error("Playwright is not installed (npm i -g playwright).");
}

// Nearest-neighbour residuals of `est` against `ref`, after the constant offset.
function align(est, ref, tol) {
  if (!est.length || !ref.length) return { p: 0, r: 0, off: NaN, res50: NaN, res95: NaN };
  const raw = [];
  for (const t of est) {
    let best = Infinity;
    for (const r of ref) if (Math.abs(t - r) < Math.abs(best)) best = t - r;
    raw.push(best);
  }
  const sorted = raw.slice().sort((a, b) => a - b);
  const off = sorted[sorted.length >> 1];
  let tp = 0;
  const res = [];
  const used = new Set();
  for (const t of est) {
    let bi = -1;
    let bd = Infinity;
    ref.forEach((r, i) => {
      const d = Math.abs(t - off - r);
      if (!used.has(i) && d < bd) {
        bd = d;
        bi = i;
      }
    });
    if (bi >= 0 && bd <= tol) {
      used.add(bi);
      tp++;
      res.push(bd);
    }
  }
  res.sort((a, b) => a - b);
  return {
    p: tp / est.length,
    r: tp / ref.length,
    off,
    res50: res[res.length >> 1] ?? NaN,
    res95: res[Math.floor(res.length * 0.95)] ?? NaN,
  };
}

const ids = String(arg("only", "hardstyle-150,techno-132,frenchcore-200")).split(",");
const seconds = +arg("seconds", 20);
const seed = !!arg("seed");

const { createServer } = await import("vite");
const server = await createServer({
  root: webapp,
  configFile: false,
  logLevel: "error",
  server: { port: 0, host: "127.0.0.1", hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, entries: [] },
});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, "");
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
let failed = 0;
try {
  for (const id of ids) {
    const def = SONG_BY_ID.get(id);
    if (!def) throw new Error(`unknown record ${id}`);
    const { truth } = loadSong(def);
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") logs.push(m.text());
    });
    page.on("pageerror", (e) => logs.push(String(e)));
    // The served verdict, as /api/analyses answers it.
    await page.route("**/api/analyses", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          analyses: seed ? { 900000001: { bpm: truth.bpm, style: truth.genre, bpmConfidence: 0.9 } } : {},
        }),
      })
    );
    await page.goto(`${url}/test/rhythm/bench.html`);
    await page.waitForFunction(() => window.bench?.ready, null, { timeout: 30000 });
    const file = "/" + songFile(def).slice(webapp.length + 1);
    const rec = await page.evaluate((o) => window.bench.run(o), { file, seconds });
    await page.close();
    const until = seconds - 0.5;
    const from = 5;
    const win = (xs) => xs.filter((t) => t >= from && t <= until);
    const shift = (xs) => (rec.playCtx == null ? xs : xs.map((t) => t - rec.playCtx));
    const kicks = align(win(shift(rec.kicks)), win(truth.kicks), 0.035);
    const beats = align(win(shift(rec.beats)), win(truth.beats), 0.07);
    const bpm = rec.bpm.length ? rec.bpm[rec.bpm.length - 1] : 0;
    const late = rec.late.slice().sort((a, b) => a - b);
    const ok = rec.frames > seconds * 80 && kicks.r > 0.8 && beats.r > 0.8 && Math.abs(bpm - truth.bpm) < 1.5;
    if (!ok) failed++;
    const pct = (x) => `${Math.round(x * 100)}%`;
    const ms = (x) => (Number.isFinite(x) ? `${(x * 1000).toFixed(1)} ms` : "-");
    console.log(
      `${ok ? "ok  " : "FAIL"} ${id.padEnd(16)} frames ${rec.frames} (${(rec.frames / seconds).toFixed(1)}/s, gap p50 ${ms(rec.gapP50)} p99 ${ms(rec.gapP99)})` +
        `  bpm ${bpm.toFixed(1)}/${truth.bpm}  kicks P ${pct(kicks.p)} R ${pct(kicks.r)} ±${ms(kicks.res50)} p95 ${ms(kicks.res95)}` +
        `  beats P ${pct(beats.p)} R ${pct(beats.r)} ±${ms(beats.res50)}  late p50 ${ms(late[late.length >> 1])} p95 ${ms(late[Math.floor(late.length * 0.95)])}` +
        `  readout ${rec.readout?.bpm} ${rec.readout?.style || ""}${rec.readout?.served ? " (served)" : ""}`
    );
    for (const l of logs.slice(0, 5)) console.log("     ", l);
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
