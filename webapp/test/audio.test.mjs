// Offline checks for the analysis DSP (lib/audio/*).
//
// These modules are plain ESM with no browser dependency — they take arrays of
// dB values and return numbers — so they can be driven from Node with
// synthetic spectra and checked for the properties that actually matter. Run
// with `npm test` (node --test; no dependency to install).
//
// What is pinned here is what went wrong before, or what would be invisible in
// the UI until someone noticed the animation was subtly lying:
//  - the band plan must not map two adjacent bars onto the same bin, which is
//    what made the old visualizer draw the bass as flat groups of four;
//  - the tempo tracker must lock onto a known pulse and report that tempo, and
//    must NOT report a confident tempo for noise.

import test from "node:test";
import assert from "node:assert/strict";

import { buildBandPlan, buildEnergyPlan, readBands, readEnergy, ENERGY_BANDS } from "../src/lib/audio/spectrum.js";
import { createFeatureExtractor } from "../src/lib/audio/features.js";
import { createBeatTracker, ODF_HZ } from "../src/lib/audio/tempo.js";
import { createStyleClassifier, FAMILY_LIST } from "../src/lib/audio/style.js";

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

test("features separate a tone from noise", () => {
  const nyq = SR / 2;
  const n = FFT_HI / 2;
  const fx = createFeatureExtractor({ sampleRate: SR, fftHi: FFT_HI, floorDb: FLOOR });
  const tone = new Float32Array(n).fill(FLOOR);
  const toneBin = Math.round(800 / (nyq / n));
  for (let d = -2; d <= 2; d++) tone[toneBin + d] = -18 - Math.abs(d) * 8;
  const noise = tiltedSpectrum(n, nyq, () => 0);

  let flatTone = 0;
  let flatNoise = 0;
  for (let i = 0; i < 200; i++) flatTone = fx.process(tone, 1 / 90).flatness;
  fx.reset();
  for (let i = 0; i < 200; i++) flatNoise = fx.process(noise, 1 / 90).flatness;
  assert.ok(flatNoise > flatTone * 2,
    `flatness did not separate noise (${flatNoise.toFixed(3)}) from a tone (${flatTone.toFixed(3)})`);
});

// Drive the beat tracker with a synthetic onset train at a known tempo.
function runTempo(bpm, { jitter = 0, seconds = 20, noise = 0 } = {}) {
  const tr = createBeatTracker();
  const dt = 1 / 90;
  const period = 60 / bpm;
  let next = 0.4;
  let beats = 0;
  let out = null;
  for (let t = 0; t < seconds; t += dt) {
    let flux = noise * Math.random() * 0.02;
    let low = flux;
    if (t >= next) {
      flux += 1;
      low += 1;
      next += period * (1 + (Math.random() - 0.5) * 2 * jitter);
    }
    out = tr.process(flux, low, dt);
    if (t > seconds * 0.6 && out.beat) beats++;
  }
  return { out, beats, seconds };
}

test("the tempo tracker locks onto a steady pulse", () => {
  for (const bpm of [90, 128, 174, 210]) {
    const { out } = runTempo(bpm);
    assert.ok(out.locked, `${bpm} BPM: never locked`);
    // Half and double time are the classic ambiguity; accept an octave, since
    // the animation is driven by the beat GRID and an octave of it still lands
    // on real beats.
    const ratios = [out.bpm / bpm, out.bpm / (bpm / 2), out.bpm / (bpm * 2)];
    assert.ok(
      ratios.some((r) => Math.abs(r - 1) < 0.06),
      `${bpm} BPM: tracked ${out.bpm.toFixed(1)}`
    );
  }
});

test("the tracker emits beats at roughly the tracked rate", () => {
  const bpm = 128;
  const { out, beats, seconds } = runTempo(bpm, { seconds: 30 });
  const window = seconds * 0.4;
  const expected = (out.bpm / 60) * window;
  assert.ok(
    Math.abs(beats - expected) / expected < 0.2,
    `emitted ${beats} beats, expected about ${expected.toFixed(1)}`
  );
});

test("no confident tempo is claimed for noise", () => {
  const tr = createBeatTracker();
  const dt = 1 / 90;
  let out = null;
  for (let t = 0; t < 20; t += dt) {
    const v = Math.random() * 0.4;
    out = tr.process(v, v * Math.random(), dt);
  }
  assert.ok(out.confidence < 0.55, `noise reported confidence ${out.confidence.toFixed(2)}`);
});

test("gridded bass reads as a machine pulse, scattered bass does not", () => {
  const strict = runTempo(140).out;
  const loose = runTempo(140, { jitter: 0.35, noise: 1 }).out;
  assert.ok(strict.kickPulse > 0.5, `four-on-the-floor read ${strict.kickPulse.toFixed(2)}`);
  assert.ok(
    loose.kickPulse < strict.kickPulse,
    "a scattered kick should not read as gridded as a strict one"
  );
});

test("the classifier stays on the simplex and never flickers on silence", () => {
  const cls = createStyleClassifier();
  const energy = { sub: 0, bass: 0, lowMid: 0, mid: 0, high: 0, air: 0 };
  const features = {
    level: 0, flux: 0, lowFlux: 0, midFlux: 0, highFlux: 0, centroidN: 0,
    flatness: 0, percussivity: 0, vocalMod: 0, crest: 0, silent: true,
  };
  const beat = {
    bpm: 0, confidence: 0, phase: 0, beat: false, beatIndex: 0, barPos: 0,
    beatsPerBar: 4, downbeat: false, onset: 0, kickPulse: 0, period: 0.5, locked: false,
  };
  let out = null;
  for (let i = 0; i < 400; i++) out = cls.process(features, beat, energy, i / 90, 1 / 90);
  const sum = Object.values(out.archetypes).reduce((a, b) => a + b, 0);
  assert.ok(sum === 0 || Math.abs(sum - 1) < 1e-6, `archetypes sum to ${sum}`);
  for (const f of out.families) assert.ok(Number.isFinite(f.weight), `${f.id} is not finite`);
});

test("a fast, distorted, gridded kick reads as one of the hard families", () => {
  const cls = createStyleClassifier();
  const energy = { sub: 0.5, bass: 0.9, lowMid: 0.2, mid: 0.25, high: 0.2, air: 0.1 };
  const features = {
    level: 0.85, flux: 0.2, lowFlux: 0, midFlux: 0.05, highFlux: 0.05,
    centroidN: 0.55, flatness: 0.62, percussivity: 0.9, vocalMod: 0.03,
    crest: 2.4, silent: false,
  };
  const beat = {
    bpm: 205, confidence: 0.9, phase: 0, beat: false, beatIndex: 0, barPos: 0,
    beatsPerBar: 4, downbeat: false, onset: 0, kickPulse: 0.92, period: 60 / 205,
    locked: true,
  };
  let out = null;
  const dt = 1 / 90;
  for (let i = 0; i < 1800; i++) {
    // A kick every beat: a spike in the bass onset function, with the broadband
    // click and the long noisy tail an industrial kick has.
    const t = i * dt;
    const phase = (t % beat.period) / beat.period;
    features.lowFlux = phase < 0.03 ? 1.2 : 0.01;
    features.highFlux = phase < 0.05 ? 0.4 : 0.02;
    out = cls.process(features, beat, energy, t, dt);
  }
  const hard = out.archetypes.hard;
  assert.ok(hard > 0.4, `hard archetype only reached ${hard.toFixed(2)} (${out.dominant})`);
  assert.ok(
    ["industrial", "hard"].includes(out.kick.type),
    `kick classified as ${out.kick.type}`
  );
});

test("the added families are all reachable", () => {
  const ids = new Set(FAMILY_LIST.map((f) => f.id));
  for (const id of [
    "hardcore", "tribecore", "speedcore", "industrial", "rawstyle",
    "hardtechno", "dance", "dnb", "dubstep", "disco", "psytrance",
    "phonk", "hardpingpong", "germanparty",
  ])
    assert.ok(ids.has(id), `${id} is missing from the client families`);
});

test("a syncopated, sub-heavy 174 BPM groove reads as drum & bass", () => {
  const cls = createStyleClassifier();
  const energy = { sub: 0.45, bass: 0.6, lowMid: 0.2, mid: 0.25, high: 0.15, air: 0.08 };
  const features = {
    level: 0.8, flux: 0.15, lowFlux: 0, midFlux: 0.06, highFlux: 0.04,
    centroidN: 0.45, flatness: 0.4, percussivity: 0.8, vocalMod: 0.05,
    crest: 3.2, silent: false,
  };
  const beat = {
    bpm: 174, confidence: 0.9, phase: 0, beat: false, beatIndex: 0, barPos: 0,
    beatsPerBar: 4, downbeat: false, onset: 0, kickPulse: 0.4, period: 60 / 174,
    locked: true,
  };
  let out = null;
  const dt = 1 / 90;
  for (let i = 0; i < 900; i++) out = cls.process(features, beat, energy, i * dt, dt);
  assert.equal(out.dominant, "dnb", `dominant was ${out.dominant}`);
});

test("a sustained, tonal, tempo-less signal reads as sustained", () => {
  const cls = createStyleClassifier();
  const energy = { sub: 0.05, bass: 0.2, lowMid: 0.5, mid: 0.6, high: 0.15, air: 0.05 };
  const features = {
    level: 0.45, flux: 0.004, lowFlux: 0.0005, midFlux: 0.002, highFlux: 0.001,
    centroidN: 0.38, flatness: 0.14, percussivity: 0.08, vocalMod: 0.05,
    crest: 6.5, silent: false,
  };
  const beat = {
    bpm: 0, confidence: 0.05, phase: 0, beat: false, beatIndex: 0, barPos: 0,
    beatsPerBar: 4, downbeat: false, onset: 0, kickPulse: 0.02, period: 0.5,
    locked: false,
  };
  let out = null;
  const dt = 1 / 90;
  for (let i = 0; i < 1200; i++) out = cls.process(features, beat, energy, i * dt, dt);
  assert.ok(
    out.archetypes.sustain > 0.5,
    `sustain only reached ${out.archetypes.sustain.toFixed(2)} (${out.dominant})`
  );
});

test("a served tempo starts the tracker locked instead of hunting", () => {
  // The whole point of measuring the tempo on the server: the first bar is
  // already on the beat, rather than the fourth.
  const seeded = createBeatTracker();
  assert.equal(seeded.seed(174, 0.95), true);
  assert.equal(seeded.out.locked ?? true, true);

  const cold = createBeatTracker();
  const dt = 1 / 90;
  const period = 60 / 174;
  let next = 0.4;
  let coldLockedAt = null;
  let seededLockedAt = null;
  for (let t = 0; t < 12; t += dt) {
    let flux = Math.random() * 0.03;
    if (t >= next) {
      flux += 1;
      next += period;
    }
    const a = seeded.process(flux, flux, dt);
    const b = cold.process(flux, flux, dt);
    if (seededLockedAt === null && a.locked && Math.abs(a.bpm - 174) < 12)
      seededLockedAt = t;
    if (coldLockedAt === null && b.locked && Math.abs(b.bpm - 174) < 12) coldLockedAt = t;
  }
  assert.ok(seededLockedAt !== null, "the seeded tracker never reported the tempo");
  assert.ok(
    seededLockedAt < 0.2,
    `seeded tracker took ${seededLockedAt?.toFixed(2)}s to report its tempo`
  );
  assert.ok(
    coldLockedAt === null || seededLockedAt < coldLockedAt,
    `seeding did not help (${seededLockedAt} vs ${coldLockedAt})`
  );
});

test("a seed outside the searchable range is refused", () => {
  const tr = createBeatTracker();
  assert.equal(tr.seed(0), false);
  assert.equal(tr.seed(12), false);
  assert.equal(tr.seed(900), false);
  assert.equal(tr.seed(NaN), false);
  assert.equal(tr.out.locked, false);
});
