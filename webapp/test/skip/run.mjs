#!/usr/bin/env node
// A skip with the crossfade on, in a page that is HIDDEN and whose timers are
// throttled — the phone in a pocket behind a car radio's "next" button. A
// backgrounded WebView fires timers as little as once a minute; here they fire
// only on 20 s boundaries. From "next" to the new track playing must not wait
// for one: measured before the fix, 2.2-16.8 s (graph) and 12.3-16.4 s
// (direct); after, 0.14-0.21 s (the bench's own polling included).
//
//   npm run build && node test/skip/run.mjs
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlaywright, startServer, silence, login, checker } from "../harness.mjs";
const { chromium } = await loadPlaywright();
const LEN = 40;
const wavPath = join(mkdtempSync(join(tmpdir(), "nsskip-")), "track.wav");
writeFileSync(wavPath, silence(LEN));
const { base, ids, stop } = await startServer(["--audio", wavPath]);
const { check, state } = checker();
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const song = (id) => ({ deezer_id: id, title: "Song " + id, duration: LEN, artist: { deezer_id: "a1", name: "Band" }, album: { deezer_id: "al1", title: "Album", cover: "" } });
async function run(output) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(/dzcdn\.net|api\.deezer\.com/, (r) => r.abort());
  await ctx.addInitScript(() => {
    const Native = window.Audio;
    window.__els = [];
    window.Audio = function (...a) { const el = new Native(...a); window.__els.push(el); const k = window.__els.length;
      for (const ev of ["play", "playing", "pause", "loadstart", "loadedmetadata", "canplay", "waiting", "emptied", "timeupdate", "seeking", "seeked", "volumechange"])
        el.addEventListener(ev, () => window.__hidden && console.log("EV", Date.now() % 100000, k, ev, el.currentTime.toFixed(2), (el.src || "").slice(-24)));
      return el; };
    window.Audio.prototype = Native.prototype;
    window.__hidden = false;
    Object.defineProperty(Document.prototype, "visibilityState", { get: () => (window.__hidden ? "hidden" : "visible") });
    Object.defineProperty(Document.prototype, "hidden", { get: () => window.__hidden });
    const ST = window.setTimeout.bind(window), SI = window.setInterval.bind(window);
    const SLOT = 20000; // a throttled page's timers, on 20 s boundaries
    window.setTimeout = (fn, ms = 0, ...a) => {
      if (!window.__hidden) return ST(fn, ms, ...a);
      const at = Date.now() + ms;
      return ST(fn, Math.ceil(at / SLOT) * SLOT - Date.now(), ...a);
    };
    window.setInterval = (fn, ms = 0, ...a) => {
      let next = 0;
      return SI(() => {
        if (window.__hidden) { const now = Date.now(); if (now < next) return; next = Math.ceil((now + 1) / SLOT) * SLOT; }
        fn(...a);
      }, ms);
    };
    try {
      const j = sessionStorage.getItem("__inject");
      if (j) {
        const { session, settings } = JSON.parse(j);
        localStorage.setItem("player.session", JSON.stringify(session));
        localStorage.removeItem("player.pos");
        for (const [k, v] of Object.entries(settings)) localStorage.setItem(k, JSON.stringify(v));
        sessionStorage.removeItem("__inject");
      }
    } catch {}
  });
  const page = await ctx.newPage();
  page.on("console", (m) => process.env.TRACE && console.log(m.text().slice(0, 200)));
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await login(page, base);
  const tracks = ids.ids.slice(0, 6).map(song);
  const session = { queue: tracks, index: 0, start: 0, currentTime: 0, context: null, shuffle: false, repeat: "off", _orig: null, at: Date.now() };
  const settings = { "fade.enabled": true, "fade.onSkip": true, "fade.skipSeconds": 1.5, "audio.output": output };
  await page.evaluate((j) => sessionStorage.setItem("__inject", j), JSON.stringify({ session, settings }));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("footer.player .pp"), null, { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.locator("footer.player .pp").click();
  await page.waitForTimeout(2500);
  await page.evaluate(() => (window.__hidden = true));
  const lat = [];
  for (let k = 1; k <= 4; k++) {
    // land a little into a 20 s slot, as a real press would
    await page.waitForTimeout(1000 + Math.random() * 3000);
    const old = await page.evaluate(() => window.__els.filter((e) => !e.paused).map((e) => e.src));
    const t0 = Date.now(); if (process.env.TRACE) console.log("CLICK", t0 % 100000);
    await page.evaluate(() => navigator.mediaSession && document.querySelector("footer.player .next").click());
    while (Date.now() - t0 < 60000) {
      const ok = await page.evaluate((old) => window.__els.some((e) => !e.paused && e.currentTime > 0.1 && e.src && !old.includes(e.src)), old);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    lat.push(((Date.now() - t0) / 1000).toFixed(2));
    await page.waitForTimeout(2000);
  }
  check(lat.every((x) => +x < 1), `${output}: a skip in a hidden, throttled page is heard at once`, lat.join(" s, ") + " s");
  await ctx.close();
}
await run("graph");
await run("direct");
await browser.close();
stop();
process.exit(state.failed ? 1 : 0);
