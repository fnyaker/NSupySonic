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
import { createStyleClassifier, FAMILY_LIST, LOOK_KEYS } from "../src/lib/audio/style.js";

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

// Synthesise the low end of a track as a series of spectra: a sustained bass
// note at `bassDb`, plus a kick that pulses for a few frames every beat.
function kickTrain({ bpm, seconds, dt = 1 / 90, bassDb = FLOOR, click = false }) {
  const n = FFT_HI / 2;
  const hzPerBin = SR / 2 / n;
  const at = (hz) => Math.round(hz / hzPerBin);
  const lo = at(30);
  const hi = at(150);
  const c0 = at(1500);
  const c1 = at(7000);
  const period = 60 / bpm;
  const specs = [];
  let next = 0.3;
  let since = -1;
  for (let t = 0; t < seconds; t += dt) {
    if (t >= next) {
      since = 0;
      next += period;
    } else if (since >= 0) {
      since += dt;
    }
    const a = new Float32Array(n).fill(FLOOR);
    // The sustained note under everything: whatever the kick does, this never
    // moves — which is exactly the case the whitened flux is blind to.
    if (bassDb > FLOOR) for (let i = lo; i <= hi; i++) a[i] = bassDb;
    // A kick's body: a short punch, decayed over ~120 ms.
    if (since >= 0 && since < 0.12) {
      const env = 14 - since * 90;
      for (let i = lo; i <= hi; i++) a[i] = Math.max(a[i], bassDb + env);
    }
    // A hardstyle kick's click sits far above the body.
    if (click && since >= 0 && since < 0.02) {
      for (let i = c0; i <= c1; i++) a[i] = Math.max(a[i], -30);
    }
    specs.push(a);
  }
  return specs;
}

function kickReadings(specs, bpm = 0, dt = 1 / 90) {
  const fx = createFeatureExtractor({ sampleRate: SR, fftHi: FFT_HI, floorDb: FLOOR });
  const out = { peak: 0, floor: 1, lowPeak: 0, hits: 0, perKick: 0 };
  const lows = [];
  let i = 0;
  for (const s of specs) {
    const f = fx.process(s, dt);
    if (f.kick > out.peak) out.peak = f.kick;
    if (f.kick < out.floor) out.floor = f.kick;
    if (f.kickHit && i * dt > 2) out.hits++;
    lows.push(f.lowFlux);
    i++;
  }
  // `kickTrain` starts its first kick at 0.3 s and lays one down every beat.
  if (bpm) {
    const seconds = specs.length * dt;
    out.perKick = out.hits / Math.max(1, Math.floor((seconds - 2 - 0.3) * (bpm / 60)) + 1);
  }
  // How far the kick onset function stands above its own average: the contrast
  // the beat tracker's fold actually gets to work with.
  const mean = lows.reduce((a, b) => a + b, 0) / lows.length;
  out.lowPeak = Math.max(...lows) / Math.max(1e-9, mean);
  return out;
}

test("a kick reads as a hit with no bass under it (techno)", () => {
  const r = kickReadings(kickTrain({ bpm: 140, seconds: 8, click: true }), 140);
  assert.ok(r.peak > 0.6, `techno kick only reached ${r.peak.toFixed(2)}`);
  assert.ok(r.floor < 0.12, `techno kick never rests (floor ${r.floor.toFixed(2)})`);
  assert.ok(r.lowPeak > 2, `techno kick contrast only ${r.lowPeak.toFixed(1)}x`);
  // ...and exactly once per kick, which is the reading everything downstream
  // is actually built on. `kickTrain` is a deliberately idealised kick — a
  // rectangular band with a beater on top and nothing in between — and the
  // detector has to cope with it as well as with the faithful material below.
  assert.ok(
    Math.abs(r.perKick - 1) < 0.12,
    `techno fired ${r.perKick.toFixed(2)} times per kick`
  );
});

test("a kick still reads as a hit over a sustained 808 (rap)", () => {
  // The case a level-based detector is bad at: a 50 Hz note that never stops,
  // with the kick landing on top of it. The kick has to be visible as a
  // TRANSIENT, not as a level, or nothing about it can be detected. It is also
  // the case with NO beater and NO pitch movement, so it is the one the sub
  // witness in features.js exists for — without it this kick has exactly one
  // witness, and one is never enough to convict.
  const r = kickReadings(kickTrain({ bpm: 90, seconds: 8, bassDb: -26 }), 90);
  assert.ok(r.peak > 0.4, `rap kick only reached ${r.peak.toFixed(2)} over the 808`);
  assert.ok(r.floor < 0.15, `the 808 alone reads as a kick (floor ${r.floor.toFixed(2)})`);
  assert.ok(r.lowPeak > 2, `rap kick contrast only ${r.lowPeak.toFixed(1)}x`);
  assert.ok(
    Math.abs(r.perKick - 1) < 0.12,
    `the 808 kick fired ${r.perKick.toFixed(2)} times per kick`
  );
});

test("a sustained 808 with no kick does not read as a kick", () => {
  const n = FFT_HI / 2;
  const hzPerBin = SR / 2 / n;
  const flat = new Float32Array(n);
  for (let i = Math.round(30 / hzPerBin); i <= Math.round(150 / hzPerBin); i++) flat[i] = -26;
  const fx = createFeatureExtractor({ sampleRate: SR, fftHi: FFT_HI, floorDb: FLOOR });
  let peak = 0;
  for (let i = 0; i < 500; i++) peak = Math.max(peak, fx.process(flat, 1 / 90).kick);
  assert.ok(peak < 0.25, `a steady note read ${peak.toFixed(2)} as a kick`);
});

// --- the dynamics gate ------------------------------------------------------
// The complaint this exists for: "in the quiet parts the animation is frantic".
// The old extractor divided every bin by its own running maximum, which makes a
// whisper and a wall of sound produce the same numbers BY DESIGN. Measured on
// the material below, it read the same kick strength twelve decibels down, and
// a sustained pad with no attack anywhere in it produced nearly full-scale
// flux. Both are pinned here so neither can come back.

function readAll(specs, dt = 1 / 90, skip = 0) {
  const fx = createFeatureExtractor({ sampleRate: SR, fftHi: FFT_HI, floorDb: FLOOR });
  const acc = {};
  specs.forEach((s, i) => {
    const f = fx.process(s, dt);
    if (i < skip) return;
    for (const k of Object.keys(f)) {
      if (typeof f[k] !== "number") continue;
      const a = (acc[k] = acc[k] || { max: -Infinity, sum: 0, n: 0 });
      if (f[k] > a.max) a.max = f[k];
      a.sum += f[k];
      a.n++;
    }
  });
  const out = {};
  for (const [k, a] of Object.entries(acc)) out[k] = { max: a.max, mean: a.sum / a.n };
  return out;
}

// A whole spectrum at `gain` dB relative to a nominal mix, so the SAME music
// can be played loud and quiet.
function atGain(specs, gain) {
  return specs.map((s) => s.map((v) => (v <= FLOOR ? FLOOR : Math.max(FLOOR, v + gain))));
}

test("the same beat twelve decibels down reads as quieter, not as the same", () => {
  const loud = kickTrain({ bpm: 150, seconds: 10, click: true });
  // One extractor, one track: loud for ten seconds, then the identical material
  // twelve decibels down. That is a breakdown, and it must not look like a drop.
  const fx = createFeatureExtractor({ sampleRate: SR, fftHi: FFT_HI, floorDb: FLOOR });
  let hot = 0;
  for (const s of loud) hot = Math.max(hot, fx.process(s, 1 / 90).kick);
  let quiet = 0;
  let gate = 1;
  for (const s of atGain(loud, -12)) {
    const f = fx.process(s, 1 / 90);
    quiet = Math.max(quiet, f.kick);
    gate = Math.min(gate, f.dynamics);
  }
  assert.ok(hot > 0.6, `the loud part only reached ${hot.toFixed(2)}`);
  assert.ok(
    quiet < hot * 0.6,
    `twelve decibels down still read ${quiet.toFixed(2)} against ${hot.toFixed(2)}`
  );
  assert.ok(gate < 0.8, `the gate never closed (${gate.toFixed(2)})`);
});

test("a sustained pad produces no onsets at all", () => {
  // The exact failure the maximum filter is for: partials that merely sit there
  // used to produce a frame-to-frame difference every single frame.
  const n = FFT_HI / 2;
  const pad = [];
  for (let i = 0; i < 600; i++) {
    const a = new Float32Array(n).fill(FLOOR);
    const hzPerBin = SR / 2 / n;
    for (const f0 of [220, 277, 330])
      for (let h = 1; h <= 6; h++) {
        const b = Math.round((f0 * h) / hzPerBin);
        if (b < n) a[b] = -20 - 4 * h;
      }
    pad.push(a);
  }
  const r = readAll(pad, 1 / 90, 60);
  assert.ok(r.kick.max < 0.05, `a pad read ${r.kick.max.toFixed(2)} as a kick`);
  assert.ok(r.midFlux.max < 0.02, `a pad produced midFlux ${r.midFlux.max.toFixed(3)}`);
  assert.ok(r.highFlux.max < 0.02, `a pad produced highFlux ${r.highFlux.max.toFixed(3)}`);
  assert.ok(
    r.percussivity.max < 0.1,
    `a pad read ${r.percussivity.max.toFixed(2)} percussive`
  );
  // ...and it is unmistakably tonal, which is the other half of the split.
  assert.ok(r.tonal.mean > 0.7, `a pad read only ${r.tonal.mean.toFixed(2)} tonal`);
});

test("a beat is percussive and a pad is not, on the same scale", () => {
  const beat = readAll(kickTrain({ bpm: 150, seconds: 8, click: true }), 1 / 90, 90);
  assert.ok(
    beat.percussivity.max > 0.45,
    `a four-on-the-floor read only ${beat.percussivity.max.toFixed(2)} percussive`
  );
});

// --- the melodic channel ----------------------------------------------------

test("chroma says which pitches are sounding, and noise has no opinion", () => {
  const n = FFT_HI / 2;
  const hzPerBin = SR / 2 / n;
  const chord = new Float32Array(n).fill(FLOOR);
  for (const f0 of [220, 277, 330])
    for (let h = 1; h <= 6; h++) {
      const b = Math.round((f0 * h) / hzPerBin);
      if (b < n) chord[b] = -20 - 4 * h;
    }
  const noise = tiltedSpectrum(n, SR / 2, () => 0);

  const tonal = readAll(new Array(600).fill(chord), 1 / 90, 120);
  const flat = readAll(new Array(600).fill(noise), 1 / 90, 120);
  assert.ok(
    tonal.melody.mean > flat.melody.mean + 0.2,
    `a chord (${tonal.melody.mean.toFixed(2)}) is not clearly more melodic than noise (${flat.melody.mean.toFixed(2)})`
  );
  // An FFT is linear and pitch is logarithmic, so without dividing by how many
  // bins land on each class, flat noise comes out with a strongly peaked chroma
  // and reads as a clear melody — exactly backwards.
  assert.ok(flat.melody.mean < 0.45, `noise read ${flat.melody.mean.toFixed(2)} melodic`);
});

test("the harmony reading moves on a chord change and not on a held one", () => {
  const n = FFT_HI / 2;
  const hzPerBin = SR / 2 / n;
  const voicing = (roots) => {
    const a = new Float32Array(n).fill(FLOOR);
    for (const f0 of roots)
      for (let h = 1; h <= 6; h++) {
        const b = Math.round((f0 * h) / hzPerBin);
        if (b < n) a[b] = -20 - 4 * h;
      }
    return a;
  };
  const A = voicing([220, 277, 330]);
  const B = voicing([246, 311, 370]);
  const held = new Array(1200).fill(A);
  const moving = [];
  for (let i = 0; i < 1200; i++) moving.push(i % 270 < 135 ? A : B);

  const h = readAll(held, 1 / 90, 90);
  const m = readAll(moving, 1 / 90, 90);
  assert.ok(h.chordChange.max < 0.05, `a held chord read ${h.chordChange.max.toFixed(3)}`);
  assert.ok(
    m.chordChange.mean > 0.05,
    `a progression only read ${m.chordChange.mean.toFixed(3)}`
  );
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

// A classifier driven with the shape of a hard, fast, gridded track.
function hardDriver() {
  const energy = { sub: 0.5, bass: 0.9, lowMid: 0.2, mid: 0.25, high: 0.2, air: 0.1 };
  const features = {
    level: 0.85, flux: 0.2, lowFlux: 0, midFlux: 0.05, highFlux: 0.05,
    centroidN: 0.55, flatness: 0.62, percussivity: 0.9, vocalMod: 0.03,
    crest: 2.4, silent: false, dynamics: 1, melody: 0.1, tonal: 0.3, chordChange: 0.02,
  };
  const beat = {
    bpm: 205, confidence: 0.9, phase: 0, beat: false, beatIndex: 0, barPos: 0,
    beatsPerBar: 4, downbeat: false, onset: 0, kickPulse: 0.92, period: 60 / 205,
    locked: true,
  };
  return { energy, features, beat };
}

function driveHard(cls, frames, t0 = 0, mutate = () => {}) {
  const { energy, features, beat } = hardDriver();
  const dt = 1 / 90;
  let out = null;
  for (let i = 0; i < frames; i++) {
    const t = t0 + i * dt;
    const phase = (t % beat.period) / beat.period;
    features.lowFlux = phase < 0.03 ? 1.2 : 0.01;
    features.highFlux = phase < 0.05 ? 0.4 : 0.02;
    mutate(features, beat, energy, i);
    out = cls.process(features, beat, energy, t, dt);
  }
  return out;
}

test("the look vector is a blend, always inside its own range", () => {
  const cls = createStyleClassifier();
  const out = driveHard(cls, 1800);
  for (const k of LOOK_KEYS) {
    assert.ok(Number.isFinite(out.look[k]), `${k} is not finite`);
    assert.ok(out.look[k] >= 0 && out.look[k] <= 1, `${k} left 0..1 at ${out.look[k]}`);
  }
});

test("a hard track and an ambient one do not look the same", () => {
  const hard = driveHard(createStyleClassifier(), 1800).look;

  const cls = createStyleClassifier();
  const energy = { sub: 0.2, bass: 0.2, lowMid: 0.3, mid: 0.3, high: 0.1, air: 0.05 };
  const features = {
    level: 0.4, flux: 0.002, lowFlux: 0.001, midFlux: 0.001, highFlux: 0.001,
    centroidN: 0.3, flatness: 0.18, percussivity: 0.02, vocalMod: 0.02,
    crest: 5.5, silent: false, dynamics: 1, melody: 0.9, tonal: 0.95, chordChange: 0.05,
  };
  const beat = {
    bpm: 0, confidence: 0.05, phase: 0, beat: false, beatIndex: 0, barPos: 0,
    beatsPerBar: 4, downbeat: false, onset: 0, kickPulse: 0.02, period: 0.5, locked: false,
  };
  let calm = null;
  for (let i = 0; i < 1800; i++) calm = cls.process(features, beat, energy, i / 90, 1 / 90);

  assert.ok(
    hard.motion > calm.look.motion + 0.25,
    `motion ${hard.motion.toFixed(2)} vs ${calm.look.motion.toFixed(2)}`
  );
  assert.ok(
    hard.punch > calm.look.punch + 0.3,
    `punch ${hard.punch.toFixed(2)} vs ${calm.look.punch.toFixed(2)}`
  );
  assert.ok(
    calm.look.melodic > hard.melodic + 0.2,
    `melodic ${calm.look.melodic.toFixed(2)} vs ${hard.melodic.toFixed(2)}`
  );
});

test("the look never jumps between frames", () => {
  // The whole reason this is numbers and not a name: a scene that re-drew
  // itself every time the classifier changed its mind between two neighbouring
  // hardcore subgenres would be unwatchable.
  const cls = createStyleClassifier();
  driveHard(cls, 900);
  let prev = { ...cls.out.look };
  let worst = 0;
  driveHard(cls, 900, 10, () => {});
  for (let i = 0; i < 900; i++) {
    const out = driveHard(cls, 1, 20 + i / 90);
    for (const k of LOOK_KEYS) worst = Math.max(worst, Math.abs(out.look[k] - prev[k]));
    prev = { ...out.look };
  }
  assert.ok(worst < 0.02, `the look moved ${worst.toFixed(3)} in a single frame`);
});

test("a breakdown does not re-classify the track", () => {
  // No drums, no pulse, no grit: every measurement says "ambient". But a quiet
  // passage is not a different genre, it is the same genre with the drums out —
  // and the look of the whole scene changing halfway through a hardcore track
  // and changing back at the drop is the bug this guards.
  const cls = createStyleClassifier();
  const loud = driveHard(cls, 2700);
  const before = { ...loud.look };
  const beforeHard = loud.archetypes.hard;

  // Eight seconds of breakdown: the gate is nearly shut, so the classifier
  // should barely move.
  const quiet = driveHard(cls, 720, 30, (features, beat) => {
    features.dynamics = 0.05;
    features.percussivity = 0.02;
    features.flatness = 0.2;
    features.crest = 5;
    features.lowFlux = 0.001;
    features.highFlux = 0.001;
    beat.kickPulse = 0.05;
    beat.confidence = 0.1;
  });
  assert.ok(
    quiet.archetypes.hard > beforeHard * 0.75,
    `a breakdown dropped the hard archetype from ${beforeHard.toFixed(2)} to ${quiet.archetypes.hard.toFixed(2)}`
  );
  assert.ok(
    Math.abs(quiet.look.motion - before.motion) < 0.15,
    `motion moved ${Math.abs(quiet.look.motion - before.motion).toFixed(2)} through a breakdown`
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

// -- the tracker against material that used to move it ----------------------
//
// The generators below schedule onsets on a TIMELINE and render them into
// frames, rather than asking "is the current frame near a beat". The naive
// version silently drops events at high tempo — a 190 BPM beat is 29 frames
// and a phase window a fraction of a beat wide is less than one — and a tracker
// fed a train with holes in it is being tested against nothing.
function renderOdf(events, { seconds, dt = 1 / 94, noise = 0.004, beds = [] }) {
  const n = Math.ceil(seconds / dt);
  const flux = new Float64Array(n);
  const low = new Float64Array(n);
  for (const e of events) {
    const i = Math.round(e.t / dt);
    if (i < 0 || i >= n) continue;
    // A transient spread over ~3 frames, as an analyser window spreads one.
    for (let k = 0; k < 3; k++) {
      const w = [1, 0.45, 0.15][k];
      if (i + k < n) {
        flux[i + k] += e.f * w;
        low[i + k] += (e.l || 0) * w;
      }
    }
  }
  const frames = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);
  for (let i = 0; i < n; i++) {
    let f = flux[i] + noise * (0.6 + rnd() * 0.8);
    let l = low[i] + noise * 0.5 * (0.6 + rnd() * 0.8);
    for (const bed of beds) {
      const [bf, bl] = bed(i * dt);
      f += bf;
      l += bl;
    }
    frames.push([f, l, dt]);
  }
  return frames;
}

// Four-to-the-floor with sixteenth percussion, a clap, a riser before every
// eighth bar, a four-bar breakdown every sixteen, and the occasional enormous
// FX stab. Everything in there is something that used to move the reading.
function clubTrack(bpm, { seconds = 90, sixteenths = 0.7, breakdown = true, fx = true } = {}) {
  const period = 60 / bpm;
  const bar = period * 4;
  const ev = [];
  const inBreak = (t) =>
    breakdown && Math.floor(t / bar) % 16 >= 8 && Math.floor(t / bar) % 16 < 12;
  let seed = 3;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);
  for (let b = 0; b * period < seconds; b++) {
    const t = b * period;
    if (inBreak(t)) continue;
    ev.push({ t, f: 0.09, l: 0.14 });
    for (const s of [0.25, 0.5, 0.75])
      ev.push({ t: t + s * period, f: 0.09 * sixteenths * (s === 0.5 ? 1 : 0.8), l: 0 });
    if (b % 4 === 2) ev.push({ t: t + 0.001, f: 0.05, l: 0 });
  }
  if (fx) for (let t = 3; t < seconds; t += 1) if (rnd() < 0.08) ev.push({ t, f: 0.7, l: 0.35 });
  const beds = [
    (t) => {
      const i = Math.floor(t / bar) % 8;
      if (i < 6) return [0, 0];
      const p = ((t % (bar * 8)) - bar * 6) / (bar * 2);
      return [0.06 * p * p, 0.02 * p * p]; // a riser
    },
    (t) => (inBreak(t) ? [0.012, 0.004] : [0, 0]), // a pad under the breakdown
  ];
  return renderOdf(ev, { seconds, beds });
}

function readTempo(tracker, frames, { warmup = 20 } = {}) {
  const reads = [];
  let t = 0;
  for (const [f, l, dt] of frames) {
    const o = tracker.process(f, l, dt);
    t += dt;
    if (t > warmup) reads.push(o.locked ? o.bpm : 0);
  }
  const sorted = [...reads].sort((a, b) => a - b);
  let jumps = 0;
  for (let i = 1; i < reads.length; i++) if (Math.abs(reads[i] - reads[i - 1]) > 2) jumps++;
  return { median: sorted[(sorted.length / 2) | 0], jumps, reads };
}

test("the tempo holds through risers, breakdowns and FX stabs", () => {
  // This is the complaint the conditioning, the running tempogram and the
  // persistence rules exist for: the reading used to walk off to a harmonic
  // and back several times a track. It must now be one number.
  for (const bpm of [128, 150, 175, 190, 230]) {
    const { median, jumps } = readTempo(createBeatTracker(), clubTrack(bpm));
    assert.ok(
      Math.abs(median / bpm - 1) < 0.03,
      `${bpm} BPM tracked at ${median.toFixed(1)}`
    );
    assert.equal(jumps, 0, `${bpm} BPM: the reading moved ${jumps} times`);
  }
});

test("a loud sixteenth layer does not double the tempo", () => {
  // Sixteenths land on the beat grid AND on a grid twice as fast, so the
  // autocorrelation cannot separate them: it is the bass fold that has to.
  const { median } = readTempo(createBeatTracker(), clubTrack(150, { sixteenths: 0.9 }));
  assert.ok(Math.abs(median / 150 - 1) < 0.03, `tracked ${median.toFixed(1)} instead of 150`);
});

test("a kick every other beat does not halve the tempo", () => {
  // Half-time: the kick is on 1 and 3, the snare on 2 and 4. Asking the bass
  // alone whether anything happens in between gets this exactly wrong — which
  // is why the slow-down test reads the whole band.
  const period = 60 / 140;
  const ev = [];
  for (let b = 0; b * period < 90; b++) {
    const t = b * period;
    if (b % 2 === 0) ev.push({ t, f: 0.08, l: 0.13 });
    else ev.push({ t, f: 0.07, l: 0.01 });
    ev.push({ t: t + period / 2, f: 0.02, l: 0 });
  }
  const { median } = readTempo(createBeatTracker(), renderOdf(ev, { seconds: 90 }));
  assert.ok(Math.abs(median / 140 - 1) < 0.03, `tracked ${median.toFixed(1)} instead of 140`);
});

test("hats on the offbeat do not double a slow tempo either", () => {
  // The mirror case: a 92 BPM ballad with an eighth-note hat. The eighth grid
  // holds every onset there is, so it wins the autocorrelation outright — and
  // the bass, which has nothing on the offbeat, is what says otherwise.
  const period = 60 / 92;
  const ev = [];
  for (let b = 0; b * period < 90; b++) {
    const t = b * period;
    if (b % 2 === 0) ev.push({ t, f: 0.06, l: 0.1 });
    else ev.push({ t, f: 0.07, l: 0.01 });
    ev.push({ t: t + period / 2, f: 0.012, l: 0 });
  }
  const { median } = readTempo(createBeatTracker(), renderOdf(ev, { seconds: 90 }));
  assert.ok(Math.abs(median / 92 - 1) < 0.04, `tracked ${median.toFixed(1)} instead of 92`);
});

test("a breakdown is not a tempo change", () => {
  // Four bars with no drums in them say nothing about the tempo, and the
  // estimate used to be adopted anyway — which is where a 128 BPM track spent
  // the bars after a breakdown at 64 and then at 255.
  const frames = clubTrack(128, { seconds: 120 });
  const tr = createBeatTracker();
  const reads = [];
  let t = 0;
  for (const [f, l, dt] of frames) {
    const o = tr.process(f, l, dt);
    t += dt;
    if (t > 20 && o.locked) reads.push(o.bpm);
  }
  const lo = Math.min(...reads);
  const hi = Math.max(...reads);
  assert.ok(hi - lo < 2, `the tempo wandered over [${lo.toFixed(1)}..${hi.toFixed(1)}]`);
});

test("a served tempo survives the track, and a wrong one is corrected", () => {
  // The seed stays in play as a prior, not just as a starting point: a good
  // figure holds through an ambiguous bar...
  const good = createBeatTracker();
  good.seed(175);
  const a = readTempo(good, clubTrack(175));
  assert.ok(Math.abs(a.median / 175 - 1) < 0.03, `seeded 175 drifted to ${a.median.toFixed(1)}`);
  assert.equal(a.jumps, 0);
  // ...and a figure the music disagrees with is still overruled by it.
  const wrong = createBeatTracker();
  wrong.seed(117);
  const b = readTempo(wrong, clubTrack(175));
  assert.ok(
    Math.abs(b.median / 175 - 1) < 0.03,
    `a wrong seed was obeyed: ${b.median.toFixed(1)}`
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

// ============================================================================
// THE HARD GENRES, END TO END
// ============================================================================
//
// Everything above this line drives one module at a time with material chosen
// to exercise that module. This section drives the WHOLE CHAIN — synthetic
// spectra through features.js into tempo.js into pattern.js — on the music this
// player is actually pointed at, because that is where it was wrong and nothing
// above it noticed.
//
// The numbers in the comments are measurements of the code as it stood before
// this section was written. They are not decoration: each one is a different
// fault, and the tests are what stop them coming back.
//
//   techno 128            1.94 kick detections per kick — a phantom 64 ms after
//                         each one, from the tail re-triggering the detector
//   frenchcore 200        2.08 per kick, same cause, worse
//   uptempo 240           0.40 per kick — SIXTY PER CENT MISSED, because the
//                         kick's fundamental starts ABOVE the band the detector
//                         was watching and sweeps down into it
//   frenchcore + screech  3.74 per kick — the beater band could convict alone,
//                         so any bright transient was a kick
//   uptempo 240 + rolls   the tempo read 60 BPM, a quarter of the truth
//   uptempo off-kick      seeded at t=0 it read 220; seeded at t=4 s, as the
//                         request ladder actually delivers, it read 110 — the
//                         server's figure was thrown away because the grid had
//                         already locked

import { renderTrack, PATTERNS, KICKS } from "./hardgen.mjs";
import { tempoRangeFor } from "../src/lib/audio/style.js";
import { createPattern } from "../src/lib/audio/pattern.js";

const HARD_DT = 1 / 94;
// Long enough for the grid to settle and be measured for half a minute after.
const HARD_SECONDS = 42;

/**
 * Drive the real chain and report what it made of the track.
 *
 * `seedAt` is the moment the server's figure arrives. It defaults to 4 seconds
 * rather than 0 on purpose: the verdict travels over the network behind the
 * audio, so a test that seeds at t=0 is testing a case that does not happen.
 */
// Rendering eighty seconds of 1024-bin spectra is the expensive half and the
// same tracks are analysed several times over (once for the kick, once for the
// tempo, once seeded), so each options object renders once. Keyed by identity:
// every case below is a literal built once at module scope.
const RENDERED = new Map();
function render(opts) {
  let specs = RENDERED.get(opts);
  if (!specs) RENDERED.set(opts, (specs = renderTrack(opts)));
  return specs;
}

// ...and the analysis pass over them is memoised the same way, since several
// tests ask different questions of the same run.
const ANALYSED = new Map();
function analyse(opts, o = {}) {
  let byOpts = ANALYSED.get(opts);
  if (!byOpts) ANALYSED.set(opts, (byOpts = new Map()));
  const key = `${o.seed || 0}/${o.seedAt ?? 4}/${o.genre || ""}`;
  let res = byOpts.get(key);
  if (!res) byOpts.set(key, (res = analyseOnce(opts, o)));
  return res;
}

function analyseOnce(opts, { seed = 0, seedAt = 4, genre = "" } = {}) {
  const specs = render(opts);
  const fx = createFeatureExtractor({ sampleRate: SR, fftHi: FFT_HI, floorDb: FLOOR });
  const tr = createBeatTracker();
  const pat = createPattern();
  if (genre) {
    const range = tempoRangeFor(genre);
    if (range) tr.setTempoRange(range[0], range[1]);
  }
  let seeded = !seed;
  const bpms = [];
  const hits = [];
  const mains = [];
  const rolls = [];
  let drops = 0;
  let locked = 0;
  let n = 0;
  const shim = { features: null, beat: null };
  for (let i = 0; i < specs.length; i++) {
    const t = i * HARD_DT;
    if (!seeded && t >= seedAt) {
      seeded = true;
      tr.seed(seed);
    }
    const f = fx.process(specs[i], HARD_DT);
    const b = tr.process(f.flux, f.lowFlux, HARD_DT);
    shim.features = f;
    shim.beat = b;
    const pt = pat.update(shim, HARD_DT);
    if (t > 5) {
      if (f.kickHit) hits.push(t);
      if (pt.mainKick) mains.push(t);
      if (pt.rollKick) rolls.push(t);
      if (pt.drop) drops++;
    }
    if (t > 14) {
      bpms.push(b.bpm);
      locked += b.locked ? 1 : 0;
      n++;
    }
  }
  const sorted = [...bpms].sort((a, b) => a - b);
  let jumps = 0;
  for (let i = 1; i < bpms.length; i++) if (Math.abs(bpms[i] - bpms[i - 1]) > 1.5) jumps++;
  return {
    bpm: sorted[(sorted.length / 2) | 0] || 0,
    locked: n ? locked / n : 0,
    jumps,
    hits,
    mains,
    rolls,
    drops,
  };
}

/** The kick times the generator laid down, so fidelity can be measured. */
function trueKicks(opts) {
  const period = 60 / opts.bpm;
  const at = opts.kickAt || PATTERNS.four;
  const out = [];
  for (let bt = 0; bt * period < (opts.seconds || 80); bt++) {
    const t0 = bt * period;
    if (opts.intro && t0 < opts.intro) continue;
    if (opts.breakAt && t0 >= opts.breakAt[0] && t0 < opts.breakAt[1]) continue;
    for (const off of at(bt, Math.floor(bt / 4))) out.push(t0 + off * period);
  }
  return out.filter((t) => t > 5);
}

/** Hits per kick, and the median lateness in milliseconds. */
function fidelity(res, opts) {
  const want = trueKicks(opts);
  const errs = [];
  for (const h of res.hits) {
    let best = Infinity;
    for (const k of want) {
      const d = h - k;
      if (d >= -0.03 && d < best) best = d;
    }
    if (best < 0.25) errs.push(best * 1000);
  }
  errs.sort((a, b) => a - b);
  return {
    perKick: res.hits.length / Math.max(1, want.length),
    lateMs: errs.length ? errs[(errs.length / 2) | 0] : 999,
  };
}

const SEED_CASES = [
  ["uptempo, kick on the offbeat", { seconds: HARD_SECONDS, bpm: 220, kickOpt: KICKS.uptempo, kickAt: PATTERNS.offKick }, 220],
  ["uptempo 240 with rolls", { seconds: HARD_SECONDS, bpm: 240, kickOpt: KICKS.uptempo, kickAt: PATTERNS.uptempo }, 240],
  ["frenchcore with a beat left out", { seconds: HARD_SECONDS, bpm: 200, kickOpt: KICKS.frenchcore, kickAt: PATTERNS.skipFourth }, 200],
  ["speedcore 280", { seconds: HARD_SECONDS, bpm: 280, kickOpt: KICKS.speedcore }, 280],
];

const RANGE_CASES = [
  ["speedcore 280", { seconds: HARD_SECONDS, bpm: 280, kickOpt: KICKS.speedcore }, 280, "speedcore"],
  ["uptempo 240 with rolls", { seconds: HARD_SECONDS, bpm: 240, kickOpt: KICKS.uptempo, kickAt: PATTERNS.uptempo }, 240, "uptempo"],
  ["frenchcore 200", { seconds: HARD_SECONDS, bpm: 200, kickOpt: KICKS.frenchcore, padGain: -20 }, 200, "frenchcore"],
  ["techno 128", { seconds: HARD_SECONDS, bpm: 128, kickOpt: KICKS.techno, hats: 1 }, 128, "techno"],
  ["trap 80", { seconds: HARD_SECONDS, bpm: 80, kickOpt: KICKS.trap, padGain: -26 }, 80, "hip-hop"],
];

const GABBER_190 = { seconds: HARD_SECONDS, bpm: 190, kickOpt: KICKS.gabber };

const STRAIGHT_200 = { seconds: HARD_SECONDS, bpm: 200, kickOpt: KICKS.frenchcore };

const HARD_CASES = [
  ["techno 128", { seconds: HARD_SECONDS, bpm: 128, kickOpt: KICKS.techno, hats: 1 }],
  ["hardtekk 155, swung hats", { seconds: HARD_SECONDS, bpm: 155, kickOpt: KICKS.hardtekk, hats: 1.4, swing: 0.16, padGain: -22 }],
  ["trap 80 over an 808", { seconds: HARD_SECONDS, bpm: 80, kickOpt: KICKS.trap, padGain: -26 }],
  ["gabber 190", { seconds: HARD_SECONDS, bpm: 190, kickOpt: KICKS.gabber }],
  ["frenchcore 200", { seconds: HARD_SECONDS, bpm: 200, kickOpt: KICKS.frenchcore, padGain: -20 }],
  ["frenchcore 205, triplet rolls", { seconds: HARD_SECONDS, bpm: 205, kickOpt: KICKS.frenchcore, kickAt: PATTERNS.tripletRoll, padGain: -20 }],
  ["uptempo 200, rolls", { seconds: HARD_SECONDS, bpm: 200, kickOpt: KICKS.uptempo, kickAt: PATTERNS.uptempo }],
  ["uptempo 220, sixteenth rolls", { seconds: HARD_SECONDS, bpm: 220, kickOpt: KICKS.uptempo, kickAt: PATTERNS.heavyRoll }],
  ["uptempo 240, rolls", { seconds: HARD_SECONDS, bpm: 240, kickOpt: KICKS.uptempo, kickAt: PATTERNS.uptempo }],
  ["zaag 160", { seconds: HARD_SECONDS, bpm: 160, kickOpt: KICKS.zaag, padGain: -22 }],
  ["zaag 175", { seconds: HARD_SECONDS, bpm: 175, kickOpt: KICKS.zaag, padGain: -22 }],
  ["speedcore 280", { seconds: HARD_SECONDS, bpm: 280, kickOpt: KICKS.speedcore }],
  ["frenchcore + an eighth-note lead", { seconds: HARD_SECONDS, bpm: 200, kickOpt: KICKS.frenchcore, screechAt: () => [0.5], screechOpt: { gain: 8, len: 0.09 } }],
  ["uptempo + an eighth-note lead", { seconds: HARD_SECONDS, bpm: 240, kickOpt: KICKS.uptempo, screechAt: () => [0.5], screechOpt: { gain: 8, len: 0.07 } }],
  ["frenchcore + a reverse bass", { seconds: HARD_SECONDS, bpm: 200, kickOpt: KICKS.frenchcore, rbassAt: () => [0.5], rbassOpt: { gain: -2 } }],
  ["hardstyle 150 + a reverse bass", { seconds: HARD_SECONDS, bpm: 150, kickOpt: KICKS.hardtekk, rbassAt: () => [0.5], rbassOpt: { gain: -2, len: 0.16 } }],
  ["frenchcore with a beat left out", { seconds: HARD_SECONDS, bpm: 200, kickOpt: KICKS.frenchcore, kickAt: PATTERNS.skipFourth, screechAt: (b) => (b % 4 === 3 ? [0, 0.5] : []), screechOpt: { gain: 6 } }],
  ["frenchcore, a half-time section", { seconds: HARD_SECONDS, bpm: 200, kickOpt: KICKS.frenchcore, kickAt: (b) => (b % 64 >= 32 ? (b % 2 ? [] : [0]) : [0]) }],
  ["frenchcore 203, played not programmed", { seconds: HARD_SECONDS, bpm: 203, kickOpt: KICKS.frenchcore, jitterMs: 6, ampJitter: 0.5 }],
  ["frenchcore 243, played not programmed", { seconds: HARD_SECONDS, bpm: 243, kickOpt: KICKS.frenchcore, jitterMs: 6, ampJitter: 0.5 }],
  ["frenchcore, a whole arrangement", { bpm: 200, seconds: 110, intro: 7, breakAt: [45, 60], kickOpt: KICKS.frenchcore, jitterMs: 4, ampJitter: 0.4, padGain: -20 }],
  ["uptempo 235, a whole arrangement", { bpm: 235, seconds: 110, intro: 7, breakAt: [45, 60], kickOpt: KICKS.uptempo, kickAt: PATTERNS.uptempo, jitterMs: 4, ampJitter: 0.4 }],
];

test("the kick is detected once per kick, on every hard genre", () => {
  // THE test for features.js. One hit per kick, and on time. A detector that
  // fires twice is a strobe; one that fires on two kicks in five is worse than
  // nothing, because every animation downstream is then keyed to noise.
  const report = [];
  for (const [name, opts] of HARD_CASES) {
    // Seeded, so this run is shared with the tempo test below. The kick
    // detector does not read the tracker at all, so the seed cannot affect it.
    const r = analyse(opts, { seed: opts.bpm, seedAt: 4 });
    const f = fidelity(r, opts);
    report.push(`${name} ${f.perKick.toFixed(2)}`);
    assert.ok(
      f.perKick > 0.88 && f.perKick < 1.15,
      `${name}: ${f.perKick.toFixed(2)} detections per kick. Full set: ${report.join(", ")}`
    );
    assert.ok(
      f.lateMs < 40,
      `${name}: the kick is reported ${f.lateMs.toFixed(0)} ms late, which is a fifth of a beat here`
    );
  }
});

test("a lead in the kick's own register is the one thing that still fools it", () => {
  // An honest limit, pinned so it is noticed if it ever gets worse — and so
  // nobody "fixes" the detector into the far worse failure of missing kicks.
  //
  // A 320 Hz stab is not a screech, it is a mid-bass: its fundamental is inside
  // the region the kick's own attack lives in, it has harmonics to the top of
  // the spectrum, and it is louder than the kick. Three of the four witnesses
  // fire on it honestly. Every attempt to exclude it cost real kicks elsewhere
  // — a sub-band veto took uptempo from 1.00 to 0.72 — and a false flash on a
  // loud percussive stab is a far cheaper mistake than a missed kick.
  const opts = {
    bpm: 200,
    kickOpt: KICKS.frenchcore,
    screechAt: () => [0.25, 0.5, 0.75],
    screechOpt: { gain: 8, len: 0.05, f: 320 },
  };
  const f = fidelity(analyse(opts), opts);
  assert.ok(f.perKick > 0.95, `it must still catch the kicks (${f.perKick.toFixed(2)})`);
  assert.ok(
    f.perKick < 3.2,
    `a 320 Hz stab now fires ${f.perKick.toFixed(2)} times per kick, which is worse than when this was written (2.6)`
  );
  // ...and the same pattern with the lead where a lead actually sits is clean.
  const high = { ...opts, screechOpt: { gain: 8, len: 0.05 } };
  const g = fidelity(analyse(high), high);
  assert.ok(
    Math.abs(g.perKick - 1) < 0.15,
    `a lead at 800 Hz must not be a kick (${g.perKick.toFixed(2)} per kick)`
  );
});

test("the served tempo is adopted even when the grid already locked", () => {
  // THE structural fix. The verdict travels over the network behind the audio,
  // so it lands seconds after the tracker locked on whatever the intro was.
  // Seeding only an unlocked tracker therefore meant not seeding at all in the
  // one case it was needed, and the user's report of it was exact: "it tries to
  // overwrite the tempo the server sent it with nothing".
  const cases = SEED_CASES;
  for (const [name, opts, bpm] of cases) {
    const r = analyse(opts, { seed: bpm, seedAt: 4 });
    assert.ok(
      Math.abs(r.bpm / bpm - 1) < 0.04,
      `${name}: served ${bpm} at four seconds, tracker settled on ${r.bpm.toFixed(1)}`
    );
    assert.ok(r.locked > 0.9, `${name}: the grid only held a lock ${(r.locked * 100) | 0}% of the time`);
    assert.ok(r.jumps < 4, `${name}: the reading moved ${r.jumps} times`);
  }
});

test("knowing the genre is what settles the octave", () => {
  // The published result on tempo octave errors in electronic music, and the
  // only thing that can work: 250 BPM uptempo and 125 BPM house produce the
  // same autocorrelation, so no amount of signal processing separates them.
  // What separates them is knowing which record is playing.
  const cases = RANGE_CASES;
  for (const [name, opts, bpm, genre] of cases) {
    const r = analyse(opts, { genre });
    assert.ok(
      Math.abs(r.bpm / bpm - 1) < 0.04,
      `${name} as ${genre}: read ${r.bpm.toFixed(1)}, wanted ${bpm}`
    );
  }
  // And the range never moves a reading that was already right.
  const plain = analyse(GABBER_190);
  const ranged = analyse(GABBER_190, { genre: "gabber" });
  assert.ok(Math.abs(plain.bpm - ranged.bpm) < 2, "the range moved a correct reading");
});

test("the tempo does not wander across the hard genres", () => {
  // The reading has to be ONE number. Everything downstream — the animation's
  // grid, the classifier, the label in the header — re-times with it.
  for (const [name, opts] of HARD_CASES) {
    const r = analyse(opts, { seed: opts.bpm, seedAt: 4 });
    assert.ok(
      Math.abs(r.bpm / opts.bpm - 1) < 0.04,
      `${name}: settled on ${r.bpm.toFixed(1)} against ${opts.bpm}`
    );
    assert.ok(r.jumps < 6, `${name}: the reading moved ${r.jumps} times`);
  }
});

test("a roll is told apart from the main kicks", () => {
  // What the whole of pattern.js exists for: at 220 BPM a bar of sixteenth
  // rolls is fifteen hits in two seconds, and a scene that throws something on
  // every one of them is a strobe rather than an animation.
  const opts = { seconds: HARD_SECONDS, bpm: 220, kickOpt: KICKS.uptempo, kickAt: PATTERNS.heavyRoll };
  const r = analyse(opts, { seed: 220, seedAt: 4 });
  // Twelve plain beats and four beats of sixteenths per sixteen: three quarters
  // of the beats carry a main kick and the rolls carry the rest.
  const beats = Math.floor((HARD_SECONDS - 5) * (220 / 60));
  assert.ok(
    r.mains.length > beats * 0.55 && r.mains.length < beats * 1.05,
    `${r.mains.length} main kicks against ${beats} beats`
  );
  assert.ok(r.rolls.length > beats * 0.2, `only ${r.rolls.length} roll notes were seen`);
  // A main kick is on the grid: no two of them closer than most of a beat.
  let tooClose = 0;
  for (let i = 1; i < r.mains.length; i++)
    if (r.mains[i] - r.mains[i - 1] < (60 / 220) * 0.7) tooClose++;
  assert.equal(tooClose, 0, `${tooClose} "main" kicks landed inside a beat of each other`);
  // ...and a straight four-on-the-floor has no rolls in it at all.
  const straight = analyse(STRAIGHT_200, { seed: 200, seedAt: 4 });
  assert.ok(
    straight.rolls.length < straight.mains.length * 0.1,
    `a straight pattern produced ${straight.rolls.length} roll notes`
  );
});

test("the drop is detected, and only the drop", () => {
  // A breakdown and the moment it ends. The arrangement going out for fifteen
  // seconds and coming back is the single most important event in any of these
  // tracks, and nothing below this layer could see it.
  const opts = {
    bpm: 200,
    seconds: 110,
    intro: 7,
    breakAt: [45, 60],
    kickOpt: KICKS.frenchcore,
    jitterMs: 4,
    ampJitter: 0.4,
    padGain: -20,
  };
  const r = analyse(opts, { seed: 200, seedAt: 4 });
  assert.ok(r.drops >= 1, "the arrangement came back and nothing noticed");
  assert.ok(r.drops <= 3, `${r.drops} drops in a track with one breakdown`);
  // A track that never goes quiet never drops.
  const flat = analyse(STRAIGHT_200, { seed: 200, seedAt: 4 });
  assert.equal(flat.drops, 0, "a track with no breakdown reported a drop");
});
