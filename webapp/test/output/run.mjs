#!/usr/bin/env node
// The audio path end to end, on the elements the browser really plays.
//
//   npm run build && node test/output/run.mjs        (SHOTS=<dir> keeps pictures)
//
// What was reported: through a Bluetooth car radio (AAC), the music "sounded
// sped up, as if pieces were being cut out", and switching features off did
// nothing — the element had been routed into Web Audio by the full-screen
// player's animation, and a routed element stays routed. The fix plays a
// Bluetooth output DIRECT. This drives exactly that in headless Chromium:
//
//  1. play, open the full-screen player: the element is routed, the analysers
//     hear the tone;
//  2. the car radio connects (the Android app's route message, window.__nsAudioRoute):
//     within a couple of seconds the track is playing on a FRESH, unrouted
//     element, from where the old one was, and the old ones are silent;
//  3. the animations keep reading the sound — a copy of it — and when the
//     player is closed the context is suspended: one audio stream left, the
//     element's own;
//  4. the next track, and a crossfade, play direct (the fade on the volumes);
//  5. the car radio goes, the phone speaker is back: routed again, lazily;
//  6. Réglages says which path, and why.
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

// -- 1. processed, as the full-screen player's animation leaves it ---------------
await boot([song("s1"), song("s2"), song("s3")], { "audio.output": "auto", "viz.mode": "bars", "viz.eco": false });
await page.locator("footer.player .pp").click();
await page.waitForFunction(() => window.__els.some((e) => e.src && !e.paused), null, { timeout: 15000 });
await page.locator("footer.player button.max").click();
await page.waitForTimeout(2500);
let p = await path();
check(p.plan.direct === false && p.plan.why === "default", "no output reported: the processed path", `${p.plan.why}`);
check(p.wired === true && p.context === "running", "the full-screen player routes the element through Web Audio", JSON.stringify(p));
check(p.level > -80, "and the analysers hear the tone", `${p.level?.toFixed(1)} dB`);
if (SHOTS) await page.screenshot({ path: join(SHOTS, "1-processed.png") });

// -- 2. the car radio connects ------------------------------------------------------
const before = await path();
const wall0 = Date.now();
await route({ kind: "bluetooth", name: "KMM-BT309", type: 8 });
await page.waitForFunction(() => window.__nsAudioPath().wired === false, null, { timeout: 8000 }).catch(() => {});
const wall1 = Date.now();
p = await path();
check(p.plan.direct === true && p.plan.why === "bluetooth", "a Bluetooth output plays direct", `${p.plan.why}`);
check(p.wired === false && p.routed === 0, "the playing element is no longer routed, nor is any other", JSON.stringify({ wired: p.wired, routed: p.routed }));
check(p.active >= 0 && p.paused === false, "and it is playing");
const list = await els();
const playing = list.filter((e) => e.src && !e.paused);
// Only what was routed is replaced: the idle element had never been, and
// keeps its place.
check(
  playing.length === 1 && playing[0].i >= 2,
  "on a fresh element (a routed one cannot be taken out of the graph)",
  `${list.length} made, playing: ${playing.map((e) => e.i).join(",")}`
);
check(list[0].paused && !list[0].src, "the routed one is stopped and emptied", JSON.stringify(list[0]));
const expected = before.t + (wall1 - wall0) / 1000;
check(Math.abs(p.t - expected) < 0.6, "the track carried on from where it was", `${p.t.toFixed(2)} s, expected ~${expected.toFixed(2)} s`);
await page.waitForTimeout(1500);
p = await path();
check(p.capturing >= 1 && p.context === "running", "the animations read a copy of the sound", JSON.stringify({ capturing: p.capturing, context: p.context }));
check(p.level > -80, "and the copy reaches the analysers", `${p.level?.toFixed(1)} dB`);
const t1 = p.t;
await page.waitForTimeout(2000);
p = await path();
check(p.t - t1 > 1.7 && p.t - t1 < 2.4, "it keeps time", `${(p.t - t1).toFixed(2)} s in 2 s`);
if (SHOTS) await page.screenshot({ path: join(SHOTS, "2-direct.png") });

// -- 3. nobody watching: one stream left ----------------------------------------------
await page.locator('button[aria-label="Réduire"]').first().click();
await page.waitForTimeout(1500);
p = await path();
check(p.analysis === false, "the full-screen player closed: the analysis stops", JSON.stringify({ analysis: p.analysis }));
check(p.capturing === 0 && p.context === "suspended", "the copy goes and the context is suspended", JSON.stringify({ capturing: p.capturing, context: p.context }));
check(p.paused === false, "the music plays on");

// -- 4. the next track, and a crossfade, stay direct ------------------------------------
await page.locator("footer.player .next").click();
await page.waitForFunction(() => document.querySelector("footer.player .info .t")?.textContent === "Song s2");
await page.waitForFunction(() => window.__nsAudioPath().paused === false, null, { timeout: 10000 });
p = await path();
check(p.wired === false && p.routed === 0 && p.context === "suspended", "the next track plays direct too", JSON.stringify(p));

wav = tone(9);
await boot([song("x1", 9), song("x2", 9)], {
  "audio.output": "auto",
  "fade.enabled": true,
  "fade.seconds": 3,
  "fade.trim": false,
  "fx.normalize": "off",
});
await route({ kind: "bluetooth", name: "KMM-BT309", type: 8 });
await page.locator("footer.player .pp").click();
await page.waitForFunction(() => window.__els.some((e) => e.src && !e.paused), null, { timeout: 15000 });
// Sample every element's volume through the end of the first track.
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

// -- 5. back on the speaker ----------------------------------------------------------------
wav = tone(40);
await boot([song("s1"), song("s2")], { "audio.output": "auto", "viz.mode": "bars" });
await route({ kind: "bluetooth", name: "KMM-BT309", type: 8 });
await page.locator("footer.player .pp").click();
await page.waitForFunction(() => window.__els.some((e) => e.src && !e.paused), null, { timeout: 15000 });
await page.locator("footer.player button.max").click();
await page.waitForTimeout(1500);
p = await path();
check(p.wired === false && p.capturing >= 1, "Bluetooth from the start: direct, with the animations on a copy", JSON.stringify({ wired: p.wired, capturing: p.capturing }));
await route({ kind: "speaker", name: "", type: 2 });
await page.waitForTimeout(800);
p = await path();
check(p.plan.direct === false && p.wired === true && p.capturing === 0, "the car radio gone: routed again, the copy dropped", JSON.stringify({ direct: p.plan.direct, wired: p.wired, capturing: p.capturing }));
check(p.paused === false, "without stopping the music");

// -- 6. Réglages says which path, and why ---------------------------------------------------
await route({ kind: "bluetooth", name: "KMM-BT309", type: 8 });
await page.locator('button[aria-label="Réduire"]').first().click().catch(() => {});
await page.goto(base + "/app/#/settings");
await page.waitForTimeout(800);
await page.getByRole("tab", { name: "Audio" }).click().catch(() => {});
await page.waitForTimeout(500);
const card = page.locator("section.card", { hasText: "Sortie audio" }).first();
const text = (await card.textContent().catch(() => "")) || "";
check(/Lecture directe/.test(text) && /KMM-BT309/.test(text), "Réglages names the path and the device", text.replace(/\s+/g, " ").slice(0, 160));
if (SHOTS) {
  await card.screenshot({ path: join(SHOTS, "6-settings.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await card.screenshot({ path: join(SHOTS, "6-settings-phone.png") });
}

await browser.close();
stop();
process.exit(state.failed ? 1 : 0);
