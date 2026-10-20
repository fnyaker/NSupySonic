#!/usr/bin/env node
// The animations on the DIRECT output, through a session of ordinary use.
//
//   npm run build && node test/vizdirect/run.mjs     (FADE=1: with the crossfade)
//
// What was reported: in direct output, "after a while the visualizer shows
// nothing, as if no sound were playing, while the music plays". On the direct
// path the analysis reads a COPY of the element (captureStream), and Chromium
// gives that copy a new track on every change of source while leaving the old
// one "live" and silent: the copy kept reading the dead one, so the animations
// fell flat at the first change of track (-Infinity dB, measured before the
// fix). This plays a tone, pauses, skips three times, closes and reopens the
// full-screen player, and requires the analysers to hear the tone after each.
import { join } from "node:path";
import { loadPlaywright, startServer, login, checker } from "../harness.mjs";

const { chromium } = await loadPlaywright();
const { base, stop } = await startServer();
const { check, state } = checker();
const SHOTS = process.env.SHOTS || null;

// A 48 kHz stereo 16-bit tone (440 Hz at -12 dBFS) — something for the
// analysers to hear — served with range support, as an archived track is.
function tone(seconds, freq = 440) {
  const rate = 48000;
  const n = rate * seconds;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + n * 4, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(n * 4, 40);
  const d = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.25 * 32767);
    d.writeInt16LE(v, i * 4);
    d.writeInt16LE(v, i * 4 + 2);
  }
  return Buffer.concat([h, d]);
}
let wav = tone(40);

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// Deezer's CDN and public API are never reached by a bench: matched on the HOSTNAME, not the URL text.
const deezerHost = (u) => u.hostname === "api.deezer.com" || u.hostname.endsWith(".dzcdn.net");
await ctx.route(deezerHost, (r) => r.abort());
await ctx.route(/\/api\/stream\//, (r) => {
  const total = wav.length;
  const m = /bytes=(\d+)-(\d*)/.exec(r.request().headers()["range"] || "");
  if (m) {
    const a = +m[1];
    const b = m[2] ? Math.min(+m[2], total - 1) : total - 1;
    return r.fulfill({
      status: 206,
      body: wav.subarray(a, b + 1),
      headers: {
        "Content-Type": "audio/wav",
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${a}-${b}/${total}`,
        "Content-Length": String(b - a + 1),
      },
    });
  }
  return r.fulfill({
    status: 200,
    body: wav,
    headers: { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Length": String(total) },
  });
});
// The fault, as the timekeeper sees it: an element whose clock runs FAST (a
// context that renders more than the device plays, and drops the excess).
// While window.__skew is set, every element's currentTime reads that much
// faster than it plays.
await ctx.addInitScript(() => {
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    get() {
      const t = d.get.call(this);
      const k = window.__skew || 0;
      if (!k) {
        this.__sk = null;
        return t;
      }
      if (!this.__sk) this.__sk = { t, off: 0 };
      return t + (t - this.__sk.t) * (k - 1);
    },
    set(v) {
      this.__sk = null;
      d.set.call(this, v);
    },
  });
});
await ctx.addInitScript(() => {
  const Native = window.Audio;
  window.__els = [];
  window.Audio = function (...a) {
    const el = new Native(...a);
    window.__els.push(el);
    return el;
  };
  window.Audio.prototype = Native.prototype;
});
await ctx.addInitScript(() => {
  try {
    const j = sessionStorage.getItem("__inject");
    if (j) {
      localStorage.setItem("player.session", j);
      localStorage.removeItem("player.pos");
      sessionStorage.removeItem("__inject");
    }
    const s = sessionStorage.getItem("__settings");
    if (s) {
      for (const [k, v] of Object.entries(JSON.parse(s))) localStorage.setItem(k, JSON.stringify(v));
      sessionStorage.removeItem("__settings");
    }
  } catch {
    /* no storage */
  }
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

const song = (id, duration = 40) => ({
  deezer_id: id, title: "Song " + id, duration,
  artist: { deezer_id: "a1", name: "Band" }, album: { deezer_id: "al1", title: "Album", cover: "" },
});
const session = (queue, index = 0) => ({
  queue, index, start: 0, currentTime: 0, context: null, shuffle: false, repeat: "off", _orig: null, at: Date.now(),
});
async function boot(queue, settings = {}) {
  await page.evaluate(
    ([j, s]) => {
      sessionStorage.setItem("__inject", j);
      sessionStorage.setItem("__settings", s);
    },
    [JSON.stringify(session(queue)), JSON.stringify(settings)]
  );
  await page.reload();
  await page.waitForFunction(() => document.querySelector("footer.player .pp") && window.__nsAudioPath, null, {
    timeout: 30000,
  });
  await page.waitForTimeout(500);
}
const path = () => page.evaluate(() => window.__nsAudioPath());
const els = () =>
  page.evaluate(() =>
    window.__els.map((e, i) => ({ i, src: !!e.getAttribute("src"), paused: e.paused, t: e.currentTime, volume: e.volume }))
  );
const title = () => page.locator("footer.player .info .t").first().textContent();
const hears = async (what) => {
  const p = await path();
  const live = (p.copies || []).find((c) => c.current);
  check(p.capturing >= 1 && p.level > -80, `${what}: the animations hear the music`, `${p.level?.toFixed(1)} dB, ${p.capturing} copies`);
  check(!live || live.tracks.length === 1, `${what}: one track on the copy, not one per song`, JSON.stringify(live?.tracks));
};
await login(page, base);
await boot([song("s1"), song("s2"), song("s3"), song("s4"), song("s5")], {
  "audio.output": "direct",
  "viz.mode": "bars",
  "viz.eco": false,
  "fade.enabled": process.env.FADE === "1",
  "fade.seconds": 2,
});
await page.locator("footer.player .pp").click();
await page.waitForFunction(() => window.__els.some((e) => e.src && !e.paused), null, { timeout: 15000 });
await page.locator("footer.player button.max").click();
await page.waitForTimeout(2000);
await hears("full-screen player open");
const pp = () => page.locator(".d .pp").click();
await pp();
await page.waitForTimeout(1500);
let p = await path();
check(p.capturing === 0 && p.context === "suspended", "paused: the copy is let go and the context suspended", JSON.stringify({ capturing: p.capturing, context: p.context }));
await pp();
await page.waitForTimeout(2000);
await hears("resumed");
for (let k = 0; k < 3; k++) {
  await page.locator('.d button[aria-label="Suivant"]').click();
  await page.waitForTimeout(2500);
  await hears(`skip ${k + 1} (${await title()})`);
}
await page.locator('button[aria-label="Réduire"]').first().click();
await page.waitForTimeout(1500);
await page.locator("footer.player button.max").click();
await page.waitForTimeout(2000);
await hears("closed and reopened");
await browser.close();
stop();
process.exit(state.failed ? 1 : 0);
