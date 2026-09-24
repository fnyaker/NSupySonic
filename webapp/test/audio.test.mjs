// Offline checks for the JavaScript half of the audio code: the band plan
// (lib/audio/spectrum.js — what the engine falls back to when the analyser
// cannot start, and the geometry every band reader shares) and the fade
// automation in graph.js. Run with `npm test` (node --test).
//
// The ANALYSIS is no longer JavaScript: it is webapp/rhythm (Rust, compiled to
// src/lib/audio/rhythm.wasm), and test/rhythm.test.mjs drives it on real audio.
//
// What is pinned here is what went wrong before, or what would be invisible in
// the UI until someone noticed the animation was subtly lying:
//  - the band plan must not map two adjacent bars onto the same bin, which is
//    what made the old visualizer draw the bass as flat groups of four;
//  - a fade interrupted mid-curve must re-arm instead of throwing.

import test from "node:test";
import assert from "node:assert/strict";

import { buildBandPlan, buildEnergyPlan, readBands, readEnergy, ENERGY_BANDS } from "../src/lib/audio/spectrum.js";

const SR = 48000;
const FFT_LO = 8192;
const FFT_HI = 2048;
const FLOOR = -96;
const CEIL = -14;

// A spectrum with a 1/f tilt, which is roughly what music looks like: enough
// structure that a band reader returning a constant is obviously broken.
function tiltedSpectrum(n, nyquist, at = () => 0) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const hz = ((i + 0.5) / n) * nyquist;
    a[i] = Math.max(FLOOR, -28 - 12 * Math.log10(Math.max(20, hz) / 20) + at(hz));
  }
  return a;
}

test("the band plan never reads two adjacent bars from the same place", () => {
  const plan = buildBandPlan({ bands: 120, sampleRate: SR, fftLo: FFT_LO, fftHi: FFT_HI });
  let identical = 0;
  for (let i = 1; i < plan.plan.length; i++) {
    const a = plan.plan[i - 1];
    const b = plan.plan[i];
    const sa = a.mix < 1 ? a.lo : a.hi;
    const sb = b.mix < 1 ? b.lo : b.hi;
    // Same whole-bin range, or the same interpolation point: either way the two
    // bars can only ever draw the same height.
    if (sa.frac < 0 && sb.frac < 0 && sa.i0 === sb.i0 && sa.i1 === sb.i1) identical++;
    if (sa.frac >= 0 && sb.frac >= 0 && Math.abs(sa.frac - sb.frac) < 1e-6) identical++;
  }
  assert.equal(identical, 0, "adjacent bands collapse onto the same bins");
});

test("the low end is read from the fine analyser and the top from the fast one", () => {
  const plan = buildBandPlan({ bands: 120, sampleRate: SR, fftLo: FFT_LO, fftHi: FFT_HI });
  const lowest = plan.plan[0];
  const highest = plan.plan[plan.plan.length - 1];
  assert.equal(lowest.mix, 0, "the bottom band must come from the 8192-point FFT");
  assert.equal(highest.mix, 1, "the top band must come from the 2048-point FFT");
  // ...and the seam is a ramp, not a step: some band in between must be a blend.
  assert.ok(plan.plan.some((p) => p.mix > 0 && p.mix < 1), "no blend region");
});

test("a bass tone moves the bass bars and nothing else", () => {
  const plan = buildBandPlan({ bands: 120, sampleRate: SR, fftLo: FFT_LO, fftHi: FFT_HI });
  const nyq = SR / 2;
  const flat = (n) => new Float32Array(n).fill(FLOOR);
  // A 60 Hz peak, three bins wide (the analyser's window spreads it that far).
  const lo = flat(FFT_LO / 2);
  const binHz = nyq / (FFT_LO / 2);
  const centre = Math.round(60 / binHz);
  for (let d = -1; d <= 1; d++) lo[centre + d] = -20 - Math.abs(d) * 6;
  const hi = flat(FFT_HI / 2);

  const db = new Float32Array(120);
  const v = new Float32Array(120);
  readBands(plan, lo, hi, db, v, FLOOR, CEIL);

  let peak = 0;
  for (let i = 1; i < 120; i++) if (v[i] > v[peak]) peak = i;
  assert.ok(plan.centers[peak] > 45 && plan.centers[peak] < 80,
    `peak landed at ${plan.centers[peak].toFixed(1)} Hz, expected ~60`);
  // The top of the spectrum saw nothing.
  assert.ok(v[110] < 0.02, "a bass tone leaked into the treble bands");
});

test("energy bands read the register they name", () => {
  const plan = buildEnergyPlan({ sampleRate: SR, fftLo: FFT_LO, fftHi: FFT_HI });
  const nyq = SR / 2;
  const lo = new Float32Array(FFT_LO / 2).fill(FLOOR);
  const hi = new Float32Array(FFT_HI / 2).fill(FLOOR);
  // Put everything at 4 kHz — the "high" band (2-6 kHz).
  const hiBin = Math.round(4000 / (nyq / (FFT_HI / 2)));
  for (let d = -1; d <= 1; d++) hi[hiBin + d] = -20;
  const out = new Float32Array(ENERGY_BANDS.length);
  readEnergy(plan, lo, hi, out, FLOOR);
  const names = ENERGY_BANDS.map((b) => b[0]);
  let top = 0;
  for (let i = 1; i < out.length; i++) if (out[i] > out[top]) top = i;
  assert.equal(names[top], "high");
});

// -- fade automation --------------------------------------------------------
//
// An AudioParam mock that enforces the spec rule the real engine enforces:
// setValueCurveAtTime(T, D) throws NotSupportedError if ANY automation method
// is called at a time inside [T, T+D), and cancelScheduledValues(t) removes
// only the events whose time is >= t. Modeling both is what makes these tests
// mean something — a mock that accepted everything would have passed against
// the bug.
function mockParam(value = 1) {
  const events = [];
  const inLiveCurve = (t) =>
    events.some((e) => e.type === "curve" && t >= e.t && t < e.t + e.d);
  return {
    get value() {
      return value;
    },
    events,
    setValueAtTime(v, t) {
      if (inLiveCurve(t))
        throw new DOMException("setValueAtTime overlaps", "NotSupportedError");
      value = v;
      events.push({ type: "set", v, t });
      return this;
    },
    setValueCurveAtTime(c, t, d) {
      if (inLiveCurve(t) || events.some((e) => e.t > t && e.t < t + d))
        throw new DOMException("setValueCurveAtTime overlaps", "NotSupportedError");
      value = c[c.length - 1];
      events.push({ type: "curve", c, t, d });
      return this;
    },
    cancelScheduledValues(t) {
      for (let i = events.length - 1; i >= 0; i--) if (events[i].t >= t) events.splice(i, 1);
      return this;
    },
  };
}

test("interrupting a fade mid-curve re-arms instead of throwing", async () => {
  const { fadeParam } = await import("../src/lib/audio/graph.js");
  const p = mockParam(1);
  // A six-second crossfade is in flight.
  fadeParam(p, 1, 0, 0, 6);
  assert.equal(p.events.filter((e) => e.type === "curve").length, 1);
  // Now the user skips: a new fade must start while the first one is still
  // running. This is the exact sequence that produced the
  // `NotSupportedError: setValueCurveAtTime ... overlaps` seen in the log.
  assert.doesNotThrow(() => fadeParam(p, p.value, 1, 1, 0.06));
  const curves = p.events.filter((e) => e.type === "curve");
  assert.equal(curves.length, 1, "the old curve must be gone, the new one live");
  assert.equal(curves[0].t, 1);
});

test("a fade interrupted at its very start does not throw either", async () => {
  const { fadeParam } = await import("../src/lib/audio/graph.js");
  const p = mockParam(1);
  fadeParam(p, 1, 0, 0, 4);
  // Same instant: t is inside [0, 4), and the old curve's event time is < t, so
  // cancelScheduledValues(t) alone would leave it in place and the re-arm would
  // throw. This is the case the fix exists for.
  assert.doesNotThrow(() => fadeParam(p, p.value, 0.5, 0, 3));
  assert.equal(p.events.filter((e) => e.type === "curve").length, 1);
});

test("the fade still lands on its end value", async () => {
  const { fadeParam } = await import("../src/lib/audio/graph.js");
  const p = mockParam(1);
  fadeParam(p, 1, 0, 0, 2);
  const c = p.events.find((e) => e.type === "curve");
  assert.equal(c.c[c.c.length - 1], 0, "a fade to 0 must reach 0");
  fadeParam(p, 0, 1, 5, 0); // instantaneous (a skip's hard cut path)
  assert.equal(p.events.at(-1).v, 1);
});
