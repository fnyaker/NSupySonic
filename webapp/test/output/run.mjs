#!/usr/bin/env node
// The audio path end to end, on the elements the browser really plays.
//
//   npm run build && node test/output/run.mjs        (SHOTS=<dir> keeps pictures)
//
// What was reported: through a Bluetooth car radio (AAC), the music "sounded
// sped up, as if pieces were being cut out", switching features off did
// nothing — and after the phone was reconnected to the same radio, it played
// cleanly again. So the correction is applied only while the fault is
// MEASURED. This drives that in headless Chromium:
//
//  1. play, open the full-screen player: the element is routed through Web
//     Audio, the analysers hear the tone — and a Bluetooth radio connecting
//     changes nothing by itself;
//  2. the fault: the routed element's clock runs 8% fast, which is what a
//     context that drops the frames it rendered late does to it. Within one
//     window the timekeeper convicts it; the track carries on DIRECT on a
//     fresh element, the context that lost the audio is closed, and the
//     animations read a copy of the sound from a NEW one;
//  3. Réglages says so, and when the next try is;
//  4. the radio reconnected: a clean slate, processed again;
//  5. a retry that has come due happens at the next track change, on a fresh
//     context, and enough clean playback forgets the fault;
//  6. pinned "Directe": the crossfade runs on the volumes, no context is made.
//
// Chromium's audio output here is a fake device, so what reaches a speaker is
// not measured; what is measured is which path each element is on, where it
// is, and what the analysers hear.
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
await ctx.route(/dzcdn\.net|api\.deezer\.com/, (r) => r.abort());
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
const route = (r) => page.evaluate((x) => window.__nsAudioRoute(x), r);

await login(page, base);
const RADIO = (conn) => ({ kind: "bluetooth", name: "KMM-BT309", type: 8, conn });

// -- 1. processed, as the full-screen player's animation leaves it ---------------
await boot([song("s1"), song("s2"), song("s3")], { "audio.output": "auto", "viz.mode": "bars", "viz.eco": false, "audio.glitchRoutes": {} });
await page.locator("footer.player .pp").click();
await page.waitForFunction(() => window.__els.some((e) => e.src && !e.paused), null, { timeout: 15000 });
await page.locator("footer.player button.max").click();
await page.waitForTimeout(2500);
let p = await path();
check(p.wired === true && p.context === "running", "the full-screen player routes the element through Web Audio", JSON.stringify({ wired: p.wired, context: p.context }));
check(p.level > -80, "and the analysers hear the tone", `${p.level?.toFixed(1)} dB`);
await route(RADIO("c1"));
await page.waitForTimeout(1500);
p = await path();
check(p.plan.direct === false && p.wired === true, "a Bluetooth radio connecting changes nothing by itself", `${p.plan.why}`);
if (SHOTS) await page.screenshot({ path: join(SHOTS, "1-processed.png") });

// -- 2. the fault ---------------------------------------------------------------------
const serial0 = p.serial;
const faultAt = Date.now();
await page.evaluate(() => (window.__skew = 1.08));
await page.waitForFunction(() => window.__nsAudioPath().wired === false, null, { timeout: 30000 }).catch(() => {});
const detectedIn = (Date.now() - faultAt) / 1000;
await page.evaluate(() => (window.__skew = 0));
p = await path();
check(p.plan.direct === true && p.plan.why === "glitch", "the fault is measured and the output goes direct", `${p.plan.why}, after ${detectedIn.toFixed(1)} s`);
check(detectedIn < 14, "within one window of the fault", `${detectedIn.toFixed(1)} s`);
check(p.wired === false && p.routed === 0 && p.paused === false, "the track carries on, on an element no longer routed", JSON.stringify({ wired: p.wired, routed: p.routed, paused: p.paused }));
const list = await els();
const playing = list.filter((e) => e.src && !e.paused);
check(playing.length === 1 && playing[0].i >= 2, "a fresh one (a routed element cannot be taken out of the graph)", `playing: ${playing.map((e) => e.i).join(",")}`);
check(list[0].paused && !list[0].src, "the routed one is stopped and emptied");
const toast = await page.locator("text=Son haché détecté").count();
check(toast > 0, "and the listener is told");
await page.waitForTimeout(1500);
p = await path();
check(p.serial > serial0 && p.context === "running", "the context that lost the audio is replaced by a fresh one", `serial ${serial0} → ${p.serial}`);
check(p.capturing >= 1 && p.level > -80, "which the animations read a copy of the sound from", JSON.stringify({ capturing: p.capturing, level: p.level?.toFixed(1) }));
const t1 = p.t;
await page.waitForTimeout(2000);
p = await path();
check(p.t - t1 > 1.7 && p.t - t1 < 2.4, "and the music keeps time", `${(p.t - t1).toFixed(2)} s in 2 s`);
const verdict = await page.evaluate(() => JSON.parse(localStorage.getItem("audio.glitchRoutes"))["bluetooth:kmm-bt309"]);
check(!!verdict && verdict.conn === "c1" && Math.abs(verdict.retryAt - verdict.at - 15 * 60000) < 1000, "remembered for this connection, retried in 15 min", JSON.stringify(verdict && { conn: verdict.conn, why: verdict.why }));

// -- 3. Réglages says so -----------------------------------------------------------
await page.locator('button[aria-label="Réduire"]').first().click();
await page.goto(base + "/app/#/settings");
await page.waitForTimeout(800);
await page.getByRole("tab", { name: "Audio" }).click().catch(() => {});
await page.waitForTimeout(500);
const card = page.locator("section.card", { hasText: "Sortie audio" }).first();
const text = ((await card.textContent().catch(() => "")) || "").replace(/\s+/g, " ");
check(/Lecture directe/.test(text) && /se hachait/.test(text) && /Nouvel essai vers/.test(text), "Réglages names the path, why, and the next try", text.slice(0, 220));
if (SHOTS) {
  await card.screenshot({ path: join(SHOTS, "3-settings.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await card.screenshot({ path: join(SHOTS, "3-settings-phone.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
}
await page.goBack();
await page.waitForTimeout(500);

// -- 4. the radio reconnected: a clean slate -------------------------------------------
await route(RADIO("c2"));
await page.waitForTimeout(1000);
p = await path();
check(p.plan.direct === false && p.plan.why === "default", "a new connection of the same radio plays processed again", `${p.plan.why}`);

// -- 5. a retry that has come due, at the next track change ------------------------------
const past = Date.now() - 20 * 60000;
await boot([song("s1"), song("s2"), song("s3")], {
  "audio.output": "auto",
  "viz.mode": "bars",
  "audio.glitchRoutes": {
    "bluetooth:kmm-bt309": { at: past, conn: "c3", name: "KMM-BT309", kind: "bluetooth", why: "pace 1.080", backoff: 15 * 60000, retryAt: past + 15 * 60000, probing: false, good: 0, count: 1 },
  },
});
await route(RADIO("c3"));
await page.locator("footer.player .pp").click();
await page.waitForFunction(() => window.__els.some((e) => e.src && !e.paused), null, { timeout: 15000 });
await page.locator("footer.player button.max").click();
await page.waitForTimeout(1500);
p = await path();
check(p.plan.why === "glitch" && p.wired === false, "a fault measured on this connection keeps it direct until the retry", `${p.plan.why}`);
await page.locator('button[aria-label="Réduire"]').first().click();
await page.locator("footer.player .next").click();
await page.waitForFunction(() => document.querySelector("footer.player .info .t")?.textContent === "Song s2");
await page.waitForFunction(() => window.__nsAudioPath().paused === false, null, { timeout: 10000 });
await page.locator("footer.player button.max").click();
await page.waitForTimeout(1500);
p = await path();
check(p.plan.why === "probing" && p.wired === true, "the retry is due: the next track plays processed again", JSON.stringify({ why: p.plan.why, wired: p.wired }));
check(p.context === "running" && p.level > -80, "and the analysers hear it", `${p.level?.toFixed(1)} dB`);
// Six clean windows of eight seconds forget the fault.
await page.waitForFunction(() => window.__nsAudioPath().plan.why === "default", null, { timeout: 75000 }).catch(() => {});
p = await path();
check(p.plan.why === "default" && p.wired === true, "enough clean playback forgets it", `${p.plan.why}`);

// -- 6. pinned direct: the crossfade on the volumes ---------------------------------------
await page.locator('button[aria-label="Réduire"]').first().click();
wav = tone(9);
await boot([song("x1", 9), song("x2", 9)], {
  "audio.output": "direct",
  "fade.enabled": true,
  "fade.seconds": 3,
  "fade.trim": false,
  "fx.normalize": "off",
});
await page.locator("footer.player .pp").click();
await page.waitForFunction(() => window.__els.some((e) => e.src && !e.paused), null, { timeout: 15000 });
const samples = [];
const tEnd = Date.now() + 11000;
while (Date.now() < tEnd) {
  samples.push(await els());
  await page.waitForTimeout(100);
}
const both = samples.filter((s) => s.filter((e) => e.src && !e.paused).length === 2);
check(both.length >= 10, "at the end both tracks play at once (a crossfade, not a cut)", `${both.length} samples with two playing`);
const mid = both
  .map((s) => s.filter((e) => e.src && !e.paused).map((e) => e.volume))
  .find((v) => v[0] > 0.3 && v[0] < 0.9 && v[1] > 0.3 && v[1] < 0.9);
check(!!mid, "passing through the middle of an equal-power curve", mid ? mid.map((v) => v.toFixed(2)).join(" / ") : "none");
if (mid) check(Math.abs(mid[0] ** 2 + mid[1] ** 2 - 1) < 0.15, "whose power sums to one", (mid[0] ** 2 + mid[1] ** 2).toFixed(3));
check((await title()) === "Song x2", "and the queue moved on", await title());
p = await path();
check(p.routed === 0 && p.context === null, "with no AudioContext ever made", JSON.stringify({ routed: p.routed, context: p.context }));

await browser.close();
stop();
process.exit(state.failed ? 1 : 0);
