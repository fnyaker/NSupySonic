#!/usr/bin/env node
// What playing costs in REQUESTS: a few, never a storm, whatever goes wrong.
//
//   node test/requests/run.mjs        (npm run build first; PYTHON=<venv python>)
//
// Starts tools/perf_api.py --serve (Deezer switched off, twelve tracks archived
// as a generated WAV, the rest not) and, in headless Chromium:
//
// 1. A REFUSED track. Opens an album and presses play on its first track
// (not archived).
// Every /api/stream answer is then a 503 "deezer-disabled" — exactly what a
// person sees when Deezer is unreachable and they play something they never
// downloaded. The player's recovery ladder retries, probes, gives up and moves
// on; it must do so at a human pace.
//
// Measured when the fix went in, over 10 s: 693 stream requests before (a
// reload every ~15 ms, the retry budget cleared by the failed reload's own
// timeupdate at 0 and the backoff scaled by that empty budget), 10 after.
//
// 2. A cover that answers 404, under the full-screen player. An archived track
// whose artwork the server does not have plays for three seconds with the
// player open. The visualizer asked for its cover on every progress tick (the
// player store hands the track over again four times a second, and a failed
// extraction is not memoised): counted from half a second after it opens,
// 11 requests in 3 s before, 0 after.
import { spawn, execSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const { chromium } = await loadPlaywright();
const WINDOW_MS = 10000;
const MAX_REQUESTS = 40; // four attempts a track, a few tracks: generous on purpose
const MAX_COVERS = 4; // the media session and the visualizer, once each: room to spare

// Sixty seconds of quiet 8 kHz mono, written here so the bench needs no ffmpeg.
function wavFile() {
  const rate = 8000, n = rate * 60;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(800 * Math.sin((2 * Math.PI * 220 * i) / rate)), 44 + i * 2);
  const p = join(mkdtempSync(join(tmpdir(), "nsreq-")), "tone.wav");
  writeFileSync(p, b);
  return p;
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const py = process.env.PYTHON || (existsSync(join(repo, ".venv/bin/python")) ? join(repo, ".venv/bin/python") : "python3");
const srv = spawn(py, [join(repo, "tools/perf_api.py"), "--runs", "1", "--serve", "--tracks", "400",
  "--favorites", "50", "--big-playlist", "100", "--playlists", "3", "--audio", wavFile()], { stdio: ["pipe", "pipe", "ignore"] });
const ready = await new Promise((res, rej) => {
  let b = "";
  srv.stdout.on("data", (d) => { b += d; const m = b.match(/READY (\d+) (.*)\n/); if (m) res({ port: +m[1], ids: JSON.parse(m[2]) }); });
  srv.on("exit", () => rej(new Error("server exited")));
});
const base = `http://127.0.0.1:${ready.port}`;
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.route(/dzcdn\.net|api\.deezer\.com|lrclib/, (r) => r.abort());
  const page = await ctx.newPage();
  let streams = 0;
  let refused = 0;
  page.on("response", (r) => {
    if (!r.url().includes("/api/stream/")) return;
    streams++;
    if (r.status() === 503) refused++;
  });
  await page.goto(base + "/app/");
  await page.evaluate(() => fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "bench", password: "Bench1" }) }));
  await page.reload();
  await page.waitForTimeout(1500);
  await page.goto(base + "/app/#/album/" + ready.ids.album);
  await page.locator(".row.track .play").first().waitFor({ timeout: 30000 });
  await page.locator(".row.track .play").first().click();
  await page.waitForTimeout(WINDOW_MS);
  console.log(`stream requests in ${WINDOW_MS / 1000} s: ${streams} (${refused} refused)`);
  if (refused === 0) {
    console.log("FAIL: the server never refused — the bench is not testing anything");
    failed = true;
  } else if (streams > MAX_REQUESTS) {
    console.log(`FAIL: more than ${MAX_REQUESTS} — the recovery ladder is looping`);
    failed = true;
  } else {
    console.log("ok");
  }

  // 2. The full-screen player over a track whose cover is missing.
  const tracks = ready.ids.ids.map((id) => ({ deezer_id: id, title: "Song " + id, duration: 60,
    artist: { deezer_id: "1000000", name: "Band" }, album: { deezer_id: "2000000", title: "Album", cover: "" } }));
  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx2.route(/dzcdn\.net|api\.deezer\.com|lrclib/, (r) => r.abort());
  await ctx2.addInitScript(() => {
    try {
      const j = sessionStorage.getItem("__inject");
      if (j) {
        localStorage.setItem("player.session", j);
        localStorage.removeItem("player.pos");
        sessionStorage.removeItem("__inject");
      }
    } catch {
      /* no storage */
    }
  });
  const p2 = await ctx2.newPage();
  await p2.goto(base + "/app/");
  await p2.evaluate(() => fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "bench", password: "Bench1" }) }));
  await p2.evaluate((j) => sessionStorage.setItem("__inject", j), JSON.stringify({ queue: tracks, index: 0, start: 0, currentTime: 0, context: null, shuffle: false, repeat: "off", _orig: null, at: Date.now() }));
  await p2.reload();
  await p2.locator("footer.player .pp").waitFor({ timeout: 30000 });
  await p2.locator("footer.player .pp").click();
  await p2.waitForFunction(() => /0:0[1-9]/.test(document.querySelector("footer.player")?.innerText || ""), null, { timeout: 15000 });
  await p2.locator("footer.player .info").first().click();
  await p2.waitForTimeout(500);
  let covers = 0;
  let missing = 0;
  p2.on("response", (r) => {
    if (!r.url().includes("/api/cover/")) return;
    covers++;
    if (r.status() === 404) missing++;
  });
  await p2.waitForTimeout(3000);
  console.log(`cover requests in 3 s of the full-screen player: ${covers} (${missing} missing)`);
  if (covers > MAX_COVERS) {
    console.log(`FAIL: more than ${MAX_COVERS} — something asks for the artwork on every tick`);
    failed = true;
  } else {
    console.log("ok");
  }
} finally {
  await browser.close();
  srv.kill();
}
process.exit(failed ? 1 : 0);
