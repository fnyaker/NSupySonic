#!/usr/bin/env node
// The UI bench: what the lists cost the main thread, in a real browser, on a
// library the size real ones reach.
//
//   node test/ui/run.mjs                 # 4x CPU throttle (a mid-range phone), 5 rounds
//   THROTTLE=1 N=9 node test/ui/run.mjs  # desktop speed, more rounds
//
// It starts tools/perf_api.py --serve (8 000 tracks, a 4 000-track playlist,
// 4 000 favourites, Deezer off) against the BUILT SPA (npm run build first),
// logs in in headless Chromium, and repeats what a person does: open the
// favourites, type a search into them letter by letter, change the sort, open
// the big playlist. Each is measured as the main thread's LONG-TASK time
// (PerformanceObserver "longtask": anything over 50 ms that blocked input),
// the median of the rounds — single runs vary by 2x under SwiftShader, which
// is why there are rounds. Cover art is blocked (the sandbox has no CDN).
//
// Measured when row recycling and the text-only offline cache went in
// (median ms, 4x throttle): favourites 315 -> 154, typing ten letters
// 470 -> 55, a sort 97 -> 52, the playlist 304 -> 216.
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

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
const THROTTLE = +(process.env.THROTTLE || 4);
const N = +(process.env.N || 5);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const py = existsSync(join(repo, ".venv/bin/python")) ? join(repo, ".venv/bin/python") : "python3";
const srv = spawn(py, [join(repo, "tools/perf_api.py"), "--runs", "1", "--serve"], { stdio: ["pipe", "pipe", "ignore"] });
const ready = await new Promise((res, rej) => {
  let buf = "";
  srv.stdout.on("data", (d) => { buf += d; const m = buf.match(/READY (\d+) (.*)\n/); if (m) res({ port: +m[1], ids: JSON.parse(m[2]) }); });
  srv.on("exit", () => rej(new Error("server exited")));
});
const base = `http://127.0.0.1:${ready.port}`;
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await ctx.route(/dzcdn\.net|api\.deezer\.com/, (r) => r.abort());
await ctx.addInitScript(() => {
  window.__long = [];
  try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push({ at: e.startTime, d: e.duration }))).observe({ entryTypes: ["longtask"] }); } catch {}
});
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await page.goto(base + "/app/");
await page.evaluate(() => fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "bench", password: "Bench1" }) }));
await page.reload();
await page.waitForTimeout(2500);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
const now = () => page.evaluate(() => performance.now());
const longSum = async (t0) => page.evaluate((t0) => window.__long.filter((e) => e.at >= t0).reduce((a, e) => a + e.d, 0), t0);
const has4000 = () => page.waitForFunction(() => document.body.innerText.includes("4000 titres"), null, { timeout: 60000, polling: 100 });
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const res = { fav: [], type: [], sort: [], pl: [] };
for (let k = 0; k < N; k++) {
  await page.goto(base + "/app/#/");
  await page.waitForTimeout(600);
  let p0 = await now();
  await page.goto(base + "/app/#/library");
  await has4000();
  await page.waitForTimeout(700);
  res.fav.push(await longSum(p0));
  const box = page.locator('input[placeholder="Rechercher dans cette liste…"]').first();
  p0 = await now();
  for (const ch of "amour nuit") await box.type(ch, { delay: 40 });
  await page.waitForTimeout(500);
  res.type.push(await longSum(p0));
  await box.fill("");
  await page.waitForTimeout(400);
  p0 = await now();
  await page.selectOption("select.sortsel", k % 2 ? "album" : "title");
  await page.waitForTimeout(500);
  res.sort.push(await longSum(p0));
  await page.selectOption("select.sortsel", "default");
  p0 = await now();
  await page.goto(base + "/app/#/playlist/" + ready.ids.big);
  await has4000();
  await page.waitForTimeout(700);
  res.pl.push(await longSum(p0));
}
for (const [k, v] of Object.entries(res)) console.log(`${k.padEnd(6)} median long-task ms ${med(v).toFixed(0).padStart(5)}   runs ${v.map((x) => x.toFixed(0)).join(" ")}`);
await browser.close();
srv.kill();
