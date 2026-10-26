#!/usr/bin/env node
// A playlist downloading on a poor mobile link, and the person presses play.
//
// The real SPA against the real server, behind a SHARED LINK of LINK bytes a
// second (a Node proxy that splits it evenly between every response in flight,
// the way a bottleneck shares itself between TCP flows). Eight archived tracks
// of the playlist download, four at a time, at full speed; three seconds in,
// the person plays another track from the network. The rule
// (lib/netyield.js): the track they launched has the link, the downloads take
// what is left. Measured:
//   1. how long the track takes to start, against the same link with nothing
//      downloading (it must be the same, give or take);
//   2. that it then plays its first 40 s without stalling;
//   3. that the downloads went on while it had enough in hand, and all finish;
//   4. that the app's own downloads were told (NSNative.offYield: a lease
//      while the track needs the link, 0 when it has what it needs).
//
//   npm run build && node test/download/run.mjs      (LINK=32768 by default: 256 kbit/s)
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { loadPlaywright, startServer, silence, login, checker } from "../harness.mjs";

const { chromium } = await loadPlaywright();
const LINK = +process.env.LINK || 32768;
const LEN = 180; // seconds; the bench's WAV is 8 KB a second, so 1.4 MB a track
const wavPath = join(mkdtempSync(join(tmpdir(), "nsdl-")), "track.wav");
writeFileSync(wavPath, silence(LEN));
const { base, ids, stop } = await startServer(["--audio", wavPath]);
const { check, state } = checker();
const upstream = new URL(base);

// --- the shared link ---------------------------------------------------------
const flows = new Set();
const bytes = { stream: 0, download: 0 };
const proxy = http.createServer((req, res) => {
  const up = http.request(
    { host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers },
    (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      // Only the audio shares the bench's link: the shell, the API and the
      // covers pass straight through (what is compared is the track against
      // the downloads, not how long the app takes to open on 256 kbit/s).
      if (!/\/api\/stream\//.test(req.url)) return ur.pipe(res);
      const f = { res, ur, q: [], n: 0, ended: false, kind: "other" };
      // The player's element fetches as an "audio" destination; a download is a fetch().
      if (/\/api\/stream\//.test(req.url) && req.headers["sec-fetch-dest"] === "audio") f.kind = "stream";
      else if (/\/api\/stream\//.test(req.url)) f.kind = "download";
      flows.add(f);
      ur.on("data", (d) => {
        f.q.push(d);
        f.n += d.length;
        if (f.n > 65536) ur.pause();
      });
      ur.on("end", () => (f.ended = true));
      const drop = () => {
        flows.delete(f);
        ur.destroy();
      };
      res.on("close", drop);
    }
  );
  up.on("error", () => res.destroy());
  req.pipe(up);
});
const STEP_MS = 10;
setInterval(() => {
  let budget = (LINK * STEP_MS) / 1000;
  for (;;) {
    const live = [...flows].filter((f) => f.n > 0 && f.res.writableLength < 16384);
    if (!live.length || budget < 1) break;
    const share = Math.max(1, Math.floor(budget / live.length));
    for (const f of live) {
      let give = Math.min(share, f.n, budget);
      while (give > 0 && f.q.length) {
        const head = f.q[0];
        const take = Math.min(give, head.length);
        f.res.write(head.subarray(0, take));
        if (take === head.length) f.q.shift();
        else f.q[0] = head.subarray(take);
        f.n -= take;
        give -= take;
        budget -= take;
        if (f.kind in bytes) bytes[f.kind] += take;
      }
      if (f.n < 65536) f.ur.resume();
    }
  }
  for (const f of flows) if (f.ended && f.n === 0) {
    f.res.end();
    flows.delete(f);
  }
}, STEP_MS).unref();
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const via = `http://127.0.0.1:${proxy.address().port}`;

// --- the page ----------------------------------------------------------------
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const song = (id, k) => ({
  deezer_id: id, title: "Song " + k, duration: LEN,
  artist: { deezer_id: "a1", name: "Band" }, album: { deezer_id: "al1", title: "Album", cover: "" },
});

async function run({ downloads }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route((u) => /(^|\.)(deezer\.com|dzcdn\.net)$/.test(new URL(u).hostname), (r) => r.abort());
  await ctx.addInitScript(() => {
    // An app whose downloads are not in its storage, but that hears the lease:
    // the page's own downloads run (the web path), and offYield is recorded.
    window.__yields = [];
    window.NSNative = { offYield: (ms) => window.__yields.push([Date.now(), ms]) };
    const Native = window.Audio;
    window.__els = [];
    window.Audio = function (...a) {
      const el = new Native(...a);
      window.__els.push(el);
      el.addEventListener("waiting", () => (window.__waits = (window.__waits || 0) + 1));
      el.addEventListener("playing", () => (window.__playingAt = window.__playingAt || Date.now()));
      return el;
    };
    window.Audio.prototype = Native.prototype;
    const j = sessionStorage.getItem("__inject");
    if (j) {
      const { session } = JSON.parse(j);
      localStorage.setItem("player.session", JSON.stringify(session));
      localStorage.removeItem("player.pos");
      localStorage.setItem("offline.quality", JSON.stringify("FLAC"));
      localStorage.setItem("cache.prefetch", JSON.stringify(false));
      sessionStorage.removeItem("__inject");
    }
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  if (process.env.DEBUG) page.on("response", (r) => r.url().includes("/api/") && console.log("resp", r.status(), r.url()));
  await login(page, via);
  const pl = await page.evaluate(async (tracks) => {
    const r = await fetch("/api/playlists", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Route " + Math.random(), tracks }),
    });
    return (await r.json()).id;
  }, ids.ids.slice(1, 9));
  const session = { queue: [song(ids.ids[0], 0)], index: 0, start: 0, currentTime: 0, context: null, shuffle: false, repeat: "off", _orig: null, at: Date.now() };
  await page.evaluate((j) => sessionStorage.setItem("__inject", j), JSON.stringify({ session }));
  await page.goto(`${via}/app/#/playlist/${pl}`);
  await page.reload();
  await page.waitForSelector('button[aria-label="Télécharger la playlist"]', { timeout: 30000 });

  await page.waitForFunction(() => document.querySelector("footer.player .pp, .mini .pp, button.pp"), null, { timeout: 30000 });
  bytes.stream = bytes.download = 0;
  if (downloads) {
    await page.locator('button[aria-label="Télécharger la playlist"]').click();
    await page.waitForTimeout(3000);
  }
  const dlBefore = bytes.download;
  const t0 = Date.now();
  await page.locator("button.pp").first().click();
  await page.waitForFunction(() => window.__playingAt, null, { timeout: 120000 }).catch(() => {});
  const startMs = (await page.evaluate(() => window.__playingAt || 0)) - t0;
  const waitsAtStart = await page.evaluate(() => window.__waits || 0);
  // 40 s of listening: the element's clock against the wall's.
  const p0 = await page.evaluate(() => window.__els.find((e) => !e.paused)?.currentTime || 0);
  const w0 = Date.now();
  await page.waitForTimeout(40000);
  const p1 = await page.evaluate(() => window.__els.find((e) => !e.paused)?.currentTime || 0);
  const played = p1 - p0;
  const wall = (Date.now() - w0) / 1000;
  const stalls = (await page.evaluate(() => window.__waits || 0)) - waitsAtStart;
  const dlDuring = bytes.download - dlBefore;
  const yields = await page.evaluate(() => window.__yields);
  let done = 0;
  if (downloads) {
    // Paused, the link is the downloads': they must all finish.
    await page.locator("button.pp").first().click();
    const deadline = Date.now() + 8 * (LEN * 8000) / LINK * 1000 * 1.6 + 30000;
    while (Date.now() < deadline) {
      done = await page.evaluate(() => new Promise((res) => {
        const r = indexedDB.open("nsupy-offline");
        r.onsuccess = () => {
          const q = r.result.transaction("meta", "readonly").objectStore("meta").count();
          q.onsuccess = () => res(q.result);
        };
        r.onerror = () => res(0);
      }));
      if (done >= 8) break;
      await page.waitForTimeout(2000);
    }
  }
  await ctx.close();
  return { startMs, played, wall, stalls, dlDuring, yields, done };
}

const quiet = await run({ downloads: false });
console.log(`nothing downloading: starts in ${quiet.startMs} ms, ${quiet.played.toFixed(1)} s heard in ${quiet.wall.toFixed(1)} s, ${quiet.stalls} stall(s)`);
const busy = await run({ downloads: true });
console.log(`8 downloading: starts in ${busy.startMs} ms, ${busy.played.toFixed(1)} s heard in ${busy.wall.toFixed(1)} s, ${busy.stalls} stall(s), ` +
  `${(busy.dlDuring / 1024).toFixed(0)} KB downloaded meanwhile, ${busy.done}/8 downloads done after`);

check(busy.startMs > 0 && busy.startMs < quiet.startMs + 1500,
  "a track launched during a playlist download starts as fast as on an idle link (+1.5 s at most)",
  `${busy.startMs} ms against ${quiet.startMs} ms`);
check(busy.played > busy.wall - 2 && busy.stalls === 0, "and plays its first 40 s without stalling",
  `${busy.played.toFixed(1)} s in ${busy.wall.toFixed(1)} s, ${busy.stalls} stall(s)`);
check(busy.dlDuring > 64 * 1024, "the downloads went on once the track had enough in hand",
  `${(busy.dlDuring / 1024).toFixed(0)} KB`);
check(busy.done === 8, "and every one of them finished", `${busy.done}/8`);
const leases = busy.yields.filter(([, ms]) => ms > 0).length;
const ends = busy.yields.filter(([, ms]) => ms === 0).length;
check(leases > 0 && ends > 0 && busy.yields[0][1] > 0, "the app was given a lease while the track needed the link, and its end",
  `${leases} lease(s), ${ends} end(s)`);

await browser.close();
proxy.close();
stop();
console.log(state.failed ? `\n${state.failed} FAILED` : "\nall passed");
process.exit(state.failed ? 1 : 0);
