// The output path (lib/audio/output.js), the watch on the music's pace
// (lib/audio/timekeeper.js) and the graph's direct path (lib/audio/graph.js),
// in Node — none of them needs an AudioContext to be held to what it promises.
//
// Why this exists: played through an AAC car radio over Bluetooth, the app's
// music "sounded sped up, as if pieces were being cut out", whatever was
// switched off. The processed path (the element routed through Web Audio,
// rendered on an AudioWorklet's thread) loses audio on Android Bluetooth
// sinks; the fix plays such outputs DIRECT and watches the pace everywhere
// else. What is pinned here:
//  - the policy: which output plays direct, and why;
//  - the timekeeper stays silent on a HEALTHY processed path as Chromium was
//    measured running it (373 ppm of drift, a currentTime that moves in render
//    bursts, a 21.6 ms output-clock step, throttled ticks, seeks and stalls),
//    and convicts the three ways a broken one keeps bad time;
//  - on the direct path the graph routes nothing, and the normalization and
//    the crossfade still do what they do, on the element's volume.

import test from "node:test";
import assert from "node:assert/strict";

import { get } from "svelte/store";
import { audioOutput, normalization, glitchRoutes } from "../src/lib/stores.js";
import {
  decideOutput,
  normalizeRoute,
  activeGlitches,
  audioRoute,
  outputPlan,
  reportGlitch,
  forgetGlitch,
  GLITCH_TTL,
  UNKNOWN_ROUTE,
} from "../src/lib/audio/output.js";
import { PaceMeter, judge, strike, WINDOW_MS, JITTER_MAX } from "../src/lib/audio/timekeeper.js";
import {
  registerSource,
  setElementGain,
  setPlayerVolume,
  fadeElement,
  setFade,
  canCrossfade,
  isWired,
  isDirect,
  wireAudio,
  getContext,
  releaseElement,
} from "../src/lib/audio/graph.js";

const BT = normalizeRoute({ kind: "bluetooth", name: "KMM-BT309", source: "native" });
const SPEAKER = normalizeRoute({ kind: "speaker", name: "", source: "native" });

// --- the policy -------------------------------------------------------------------

test("auto plays a Bluetooth output direct, and everything else processed", () => {
  assert.deepEqual(decideOutput("auto", BT, {}, null, false), { direct: true, why: "bluetooth" });
  assert.deepEqual(decideOutput("auto", SPEAKER, {}, null, false), { direct: false, why: "default" });
  assert.deepEqual(decideOutput("auto", UNKNOWN_ROUTE, {}, null, false), { direct: false, why: "default" });
});

test("on Bluetooth, an effect only the processor can apply keeps it processed — until it is measured failing", () => {
  assert.deepEqual(decideOutput("auto", BT, {}, null, true), { direct: false, why: "dsp" });
  const glitches = { [BT.key]: { at: Date.now() - 1000 } };
  assert.deepEqual(decideOutput("auto", BT, glitches, null, true), { direct: true, why: "glitch" });
});

test("a measured failure sends ANY output direct, for GLITCH_TTL and not a day longer", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const fresh = { default: { at: now - 3 * 86400e3 } };
  assert.equal(decideOutput("auto", UNKNOWN_ROUTE, fresh, null, false, now).direct, true);
  const stale = { default: { at: now - GLITCH_TTL - 1 } };
  assert.equal(decideOutput("auto", UNKNOWN_ROUTE, stale, null, false, now).direct, false);
  // A verdict dated in the future (a clock that jumped) is not believed.
  const future = { default: { at: now + 86400e3 } };
  assert.equal(decideOutput("auto", UNKNOWN_ROUTE, future, null, false, now).direct, false);
  // One output's verdict says nothing about another's.
  assert.equal(decideOutput("auto", SPEAKER, { [BT.key]: { at: now } }, null, false, now).direct, false);
  // This session's verdict counts before it is stored.
  assert.equal(decideOutput("auto", SPEAKER, {}, { key: SPEAKER.key }, false, now).direct, true);
});

test("the setting pins the path whatever the output says", () => {
  const glitches = { [BT.key]: { at: Date.now() } };
  assert.deepEqual(decideOutput("direct", SPEAKER, {}, null, true), { direct: true, why: "setting" });
  assert.deepEqual(decideOutput("graph", BT, glitches, { key: BT.key }, false), { direct: false, why: "setting" });
});

test("a route from the native side is bounded before anything reads it", () => {
  const r = normalizeRoute({ kind: "<script>", name: "x".repeat(500) + "\n\tend" });
  assert.equal(r.kind, "other");
  assert.ok(r.name.length <= 60);
  assert.ok(!/[\n\t]/.test(r.name));
  assert.equal(normalizeRoute(null), UNKNOWN_ROUTE);
  assert.equal(normalizeRoute("bluetooth"), UNKNOWN_ROUTE);
  // Two devices of one kind are two outputs; the same device is one.
  assert.notEqual(normalizeRoute({ kind: "bluetooth", name: "Casque" }).key, BT.key);
  assert.equal(normalizeRoute({ kind: "bluetooth", name: "kmm-bt309" }).key, BT.key);
});

test("a verdict is remembered for the output it was measured on, and can be forgotten", () => {
  audioOutput.set("auto");
  glitchRoutes.set({});
  audioRoute.set(SPEAKER);
  assert.equal(get(outputPlan).direct, false);
  assert.equal(reportGlitch({ why: "pace 1.043", ratio: 1.0431 }), true);
  assert.equal(get(outputPlan).direct, true);
  assert.equal(get(outputPlan).why, "glitch");
  const kept = activeGlitches(get(glitchRoutes));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].key, SPEAKER.key);
  assert.equal(kept[0].ratio, 1.0431);
  forgetGlitch(SPEAKER.key);
  assert.equal(get(outputPlan).direct, false);
  // Pinned processed: the verdict is reported, and changes nothing.
  audioOutput.set("graph");
  assert.equal(reportGlitch({ why: "pace 1.05" }), false);
  assert.equal(get(outputPlan).direct, false);
  forgetGlitch(SPEAKER.key);
  audioOutput.set("auto");
  audioRoute.set(UNKNOWN_ROUTE);
});

// --- the timekeeper ----------------------------------------------------------------
//
// A player seen through the timekeeper's 1 s ticks. `media(t)` is where the
// element says it is at wall time t (s); `map(t)` the output clock's
// contextTime - performanceTime; `under(t)` playbackStats.underrunDuration.
// Ticks jitter by up to ±150 ms, and every 40th one is late by three seconds
// (a busy main thread, a throttled timer). Returns every window and verdict.

function lcg(seed) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function run({ seconds, media, map = () => 0, under = () => 0, ctxT = (t) => t, wired = true, seed = 7, state = () => "ok" }) {
  const rnd = lcg(seed);
  const meter = new PaceMeter();
  const el = {};
  const windows = [];
  const verdicts = [];
  let t = 0;
  let n = 0;
  while (t < seconds) {
    t += 1 + (rnd() - 0.5) * 0.3 + (++n % 40 === 0 ? 3 : 0);
    const st = state(t);
    if (st === "stalled") {
      meter.offer(null);
      continue;
    }
    const w = meter.offer({
      el,
      src: st === "other-track" ? "b" : "a",
      wired,
      media: media(t),
      wall: t * 1000,
      rate: 1,
      ctxTime: wired ? ctxT(t) : null,
      mapD: wired ? map(t) : null,
      underrun: wired ? under(t) : null,
    });
    if (!w) continue;
    windows.push(w);
    const why = strike(meter, w);
    if (why) verdicts.push({ t, why });
  }
  return { windows, verdicts };
}

// What headless Chromium measured on a HEALTHY routed element: its currentTime
// moves in render bursts (~21.3 ms at latencyHint "playback") and runs 373 ppm
// fast against real time; the output mapping holds to ±0.1 ms and steps once
// by a whole burst (21.6 ms) a few seconds in.
const BURST = 1024 / 48000;
const healthyMedia = (t) => Math.floor((t * (1 + 373e-6)) / BURST) * BURST;
const healthyMap = (rnd) => (t) => (t > 3.2 ? -0.0216 : 0) + (rnd() - 0.5) * 0.0002;

test("a healthy processed path is never convicted: drift, bursts, a clock step, late ticks", () => {
  const rnd = lcg(11);
  const { windows, verdicts } = run({ seconds: 600, media: healthyMedia, map: healthyMap(rnd), ctxT: (t) => t * (1 + 12e-6) });
  assert.ok(windows.length >= 35, `only ${windows.length} windows in ten minutes`);
  assert.equal(verdicts.length, 0);
  const worst = Math.max(...windows.map((w) => Math.abs(w.pace - 1)));
  const jitter = Math.max(...windows.map((w) => w.jitter));
  // Measured on this model: worst pace error 0.0014, worst window jitter 22 ms.
  assert.ok(worst < 0.005, `pace off by ${worst}`);
  assert.ok(jitter < 0.05, `output clock moved ${jitter} s in one window`);
  assert.equal(windows.filter((w) => judge(w)).length, 0);
});

test("seeks, stalls and track changes restart the window instead of reading as a pace", () => {
  // A seek forward 40 s at t=50, back 20 s at t=120, a 4 s stall at t=200
  // (the element frozen, readyState down), a new track at t=260.
  const media = (t) => {
    let m = healthyMedia(t);
    if (t > 50) m += 40;
    if (t > 120) m -= 20;
    if (t > 204) m -= 4;
    return m;
  };
  const state = (t) => (t > 200 && t < 204 ? "stalled" : t > 260 ? "other-track" : "ok");
  const { verdicts, windows } = run({ seconds: 400, media, map: healthyMap(lcg(3)), state });
  assert.equal(verdicts.length, 0);
  assert.equal(windows.filter((w) => judge(w)).length, 0);
});

test("a stall the element does not report (position frozen, readyState fine) is not a pace", () => {
  const media = (t) => (t > 100 && t < 106 ? healthyMedia(100) : t >= 106 ? healthyMedia(t) - 6 : healthyMedia(t));
  const { verdicts } = run({ seconds: 300, media, map: healthyMap(lcg(5)) });
  assert.equal(verdicts.length, 0);
});

// The three ways a broken processed path keeps bad time.

test("frames dropped (the context pulls the element faster than the device plays): convicted in two windows", () => {
  // 4% of the music cut out: the element is pulled 1.04x real time.
  const media = (t) => healthyMedia(t * 1.04);
  const { verdicts, windows } = run({ seconds: 120, media, map: healthyMap(lcg(9)), ctxT: (t) => t * 1.04 });
  assert.ok(verdicts.length >= 1);
  assert.ok(verdicts[0].t < 2 * WINDOW_MS / 1000 + 8, `first verdict only at ${verdicts[0].t} s`);
  assert.match(verdicts[0].why, /pace 1\.04/);
  assert.ok(windows.every((w) => w.pace > 1.03));
});

test("silence padded in (an underrunning FIFO): convicted by the pace, or by playbackStats where it exists", () => {
  // 3% of the time padded with silence: the element falls behind real time.
  const slow = run({ seconds: 120, media: (t) => healthyMedia(t * 0.97), map: healthyMap(lcg(2)), ctxT: (t) => t * 0.97 });
  assert.ok(slow.verdicts.length >= 1);
  // A FIFO that pads a gap and then drops as much when the late frames land
  // keeps the element's pace at 1: only the underrun counter sees it (2% of
  // the time here), and the output clock, which moves by every gap.
  const padded = run({
    seconds: 120,
    media: healthyMedia,
    map: healthyMap(lcg(4)),
    under: (t) => t * 0.02,
  });
  assert.ok(padded.verdicts.length >= 1);
  assert.match(padded.verdicts[0].why, /underruns 2\.0%/);
});

test("gaps padded then dropped, with no underrun counter: the output clock gives it away", () => {
  // Gaps of 20-60 ms a few times a second: the mapping steps back by the gap
  // and forward again when the FIFO drops as much, so a reading taken at any
  // moment finds it displaced about half the time. Healthy, it moved 22 ms in
  // a window at most.
  const rnd = lcg(13);
  const map = () => (rnd() < 0.5 ? -(0.02 + rnd() * 0.04) : 0);
  const { verdicts, windows } = run({ seconds: 90, media: healthyMedia, map });
  assert.ok(verdicts.length >= 1);
  assert.match(verdicts[0].why, /output clock moved/);
  const least = Math.min(...windows.map((w) => w.jitter));
  // Measured on this model: 0.33-0.43 s a window, against 0.022 s healthy.
  assert.ok(least > JITTER_MAX, `least jitter ${least}`);
});

test("one bad window on a loaded phone is not a verdict", () => {
  // Pace 1.05 for 15 s at t=60..75, healthy otherwise.
  const media = (t) => healthyMedia(t) + Math.max(0, Math.min(t, 75) - 60) * 0.05;
  const { verdicts, windows } = run({ seconds: 300, media, map: healthyMap(lcg(21)) });
  assert.ok(windows.some((w) => judge(w)), "the bad stretch should show in a window");
  assert.equal(verdicts.length, 0);
});

// --- the direct path in the graph ----------------------------------------------------

function fakeEl() {
  return { volume: 1, paused: true, addEventListener() {}, removeEventListener() {} };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("direct: nothing is routed, and no AudioContext is ever made to play", () => {
  audioOutput.set("direct");
  assert.equal(isDirect(), true);
  const a = fakeEl();
  const b = fakeEl();
  registerSource(a);
  wireAudio(b); // what a crossfade arming its incoming element calls
  assert.equal(isWired(a), false);
  assert.equal(isWired(b), false);
  assert.equal(getContext(), null);
  assert.equal(canCrossfade(a, b), true, "the crossfade must still be possible, on the volumes");
  releaseElement(a);
  releaseElement(b);
});

test("direct: the normalization rides on the volume, and can only turn a track down", () => {
  audioOutput.set("direct");
  normalization.set("medium"); // +5 dB over the ReplayGain target
  const el = fakeEl();
  registerSource(el);
  setPlayerVolume(0.8, [el]);
  // Deezer loudness -10 dB → ReplayGain -(−10 + 18.4) = -8.4, +5 → -3.4 dB.
  setElementGain(el, -10);
  assert.ok(Math.abs(el.volume - 0.8 * 10 ** (-3.4 / 20)) < 1e-3, `volume ${el.volume}`);
  // A quiet master would need +11.6 dB: the volume stops at the player's own.
  setElementGain(el, -25);
  assert.ok(Math.abs(el.volume - 0.8) < 1e-6);
  // A level change moves the playing element at once.
  setElementGain(el, -10);
  normalization.set("low"); // +2 dB → -6.4 dB
  assert.ok(Math.abs(el.volume - 0.8 * 10 ** (-6.4 / 20)) < 1e-3, `volume ${el.volume}`);
  normalization.set("off");
  assert.ok(Math.abs(el.volume - 0.8) < 1e-6);
  releaseElement(el);
});

test("direct: a crossfade is the same equal-power curve, on the two volumes", async () => {
  audioOutput.set("direct");
  normalization.set("off");
  const out = fakeEl();
  const inc = fakeEl();
  registerSource(out);
  wireAudio(inc);
  setPlayerVolume(1, [out, inc]);
  setFade(inc, 0);
  assert.equal(inc.volume, 0);
  assert.equal(fadeElement(inc, 1, 0.4), true);
  assert.equal(fadeElement(out, 0, 0.4), true);
  await wait(200);
  // Half way: both near sin(π/4), and their POWER sums to one — the linear
  // pair's 3 dB hole is what the curve exists to avoid.
  const p = out.volume ** 2 + inc.volume ** 2;
  assert.ok(out.volume > 0.45 && out.volume < 0.9, `outgoing at ${out.volume}`);
  assert.ok(inc.volume > 0.45 && inc.volume < 0.9, `incoming at ${inc.volume}`);
  assert.ok(Math.abs(p - 1) < 0.08, `power ${p}`);
  await wait(320);
  assert.equal(out.volume, 0);
  assert.equal(inc.volume, 1);
  // A player volume change mid-way reaches both, without undoing the fades.
  setPlayerVolume(0.5, [out, inc]);
  assert.equal(out.volume, 0);
  assert.equal(inc.volume, 0.5);
  releaseElement(out);
  releaseElement(inc);
});

test("direct: an interrupted fade continues from where it audibly is", async () => {
  audioOutput.set("direct");
  const el = fakeEl();
  registerSource(el);
  setPlayerVolume(1, [el]);
  fadeElement(el, 0, 0.4);
  await wait(150);
  const mid = el.volume;
  assert.ok(mid < 1 && mid > 0);
  fadeElement(el, 1, 0.25); // the skip was cancelled: back up
  await wait(10);
  assert.ok(Math.abs(el.volume - mid) < 0.1, `jumped from ${mid} to ${el.volume}`);
  await wait(300);
  assert.equal(el.volume, 1);
  releaseElement(el);
  audioOutput.set("auto");
});
