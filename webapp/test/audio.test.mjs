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
import { renderTrack, analyse, KICKS, PATTERNS, DT } from "./synth.mjs";

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

// A TRACK, PLAYED AT A CHOSEN LEVEL. `renderTrack` limits to a ceiling like a
// master does, and scaling the samples afterwards is exactly what a quiet
// passage is: the same master, further down. Re-analysed, not re-rendered, so
// the two readings are the identical performance.
function atGain(pcm, db) {
  const g = Math.pow(10, db / 20);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * g;
  return analyse(out);
}

test("an input that never changes produces no events at all", () => {
  // Not a claim about music — the musical version of this is the reverse bass
  // in the catalogue below, which is a real note that really swells. This is
  // the degenerate case: the same frame, five hundred times. Every witness in
  // features.js is a STEP, so all of them must read zero for ever, and any
  // that drifts, accumulates or divides by its own reference will show up here
  // as a kick that nothing played.
  const n = FFT_HI / 2;
  const hzPerBin = SR / 2 / n;
  const flat = new Float32Array(n).fill(FLOOR);
  for (let i = Math.round(30 / hzPerBin); i <= Math.round(150 / hzPerBin); i++) flat[i] = -26;
  const fx = createFeatureExtractor({ sampleRate: SR, fftHi: FFT_HI, floorDb: FLOOR });
  let peak = 0;
  let hits = 0;
  for (let i = 0; i < 500; i++) {
    const f = fx.process(flat, 1 / 90);
    peak = Math.max(peak, f.kick);
    if (f.kickHit) hits++;
  }
  assert.equal(hits, 0, `a frozen spectrum fired ${hits} kicks`);
  assert.ok(peak < 0.25, `a frozen spectrum read ${peak.toFixed(2)} as a kick`);
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

test("the same beat played quieter reads as quieter, in proportion", () => {
  // The complaint this exists for: "in the quiet parts the animation is
  // frantic". The old extractor divided every bin by its own running maximum,
  // which makes a whisper and a wall of sound produce the same numbers BY
  // DESIGN — measured on identical material twelve decibels down it read the
  // same kick strength, 0.365 against 0.355.
  //
  // ONE extractor, ONE performance, played at four levels: ten seconds of a
  // hardstyle master, then the identical samples scaled down. Scaling after the
  // limiter is exactly what a level change is, and it is the only way to move
  // the level and nothing else.
  //
  // Read as a MEAN, not as a peak. `loudRef` follows the track down over about
  // half a minute — that is the design, and it is why a long quiet passage
  // eventually becomes the new normal — so the single loudest frame of a ten
  // second passage is measuring its END rather than the passage.
  const { pcm, spectra } = renderTrack({
    seconds: 10,
    bpm: 150,
    kickOpt: KICKS.hardstyle,
    hats: 1,
  });
  // Each level is its own run: the loud ten seconds, THEN the quiet ten, from a
  // cold extractor. That is the real arrangement — a breakdown always follows
  // loud music — and it is also the only way the three levels are comparable,
  // since `loudRef` carries state from whatever came before it.
  const play = (db) => {
    const fx = createFeatureExtractor({ sampleRate: SR, fftHi: FFT_HI, floorDb: FLOOR });
    let hot = 0;
    let sum = 0;
    for (const sp of spectra) {
      const f = fx.process(sp, DT);
      hot = Math.max(hot, f.kick);
      sum += f.kick;
    }
    const loud = sum / spectra.length;
    if (db === 0) return { loud, hot, ratio: 1, gate: 1 };
    let q = 0;
    let gate = 1;
    let n = 0;
    for (const sp of atGain(pcm, db)) {
      const f = fx.process(sp, DT);
      q += f.kick;
      gate = Math.min(gate, f.dynamics);
      n++;
    }
    return { loud, hot, ratio: q / n / loud, gate };
  };
  assert.ok(play(0).hot > 0.6, `the loud part only reached ${play(0).hot.toFixed(2)}`);

  // Measured: 0.89 / 0.65 / 0.31 of the loud reading, with the gate reaching
  // 0.417 / 0.236 / 0.038.
  const want = { "-6": [0.8, 0.98, 0.7], "-12": [0.5, 0.78, 0.4], "-20": [0.15, 0.45, 0.12] };
  let last = 1;
  for (const db of [-6, -12, -20]) {
    const { ratio, gate } = play(db);
    const [lo, hi, gateMax] = want[String(db)];
    assert.ok(
      ratio > lo && ratio < hi,
      `${db} dB down read ${ratio.toFixed(2)} of the loud part, wanted ${lo}..${hi}`
    );
    assert.ok(gate < gateMax, `${db} dB down: the gate only closed to ${gate.toFixed(2)}`);
    // ...and it has to be MONOTONE. A reading that falls and then rises again
    // as the music gets quieter is worse than one that does not move at all.
    assert.ok(ratio < last, `${db} dB down read ${ratio.toFixed(2)}, louder than the step above it`);
    last = ratio;
  }
});

test("a sustained pad produces no onsets, and a beat does", () => {
  // The exact failure the maximum filter is for: partials that merely sit there
  // used to produce a frame-to-frame difference every single frame. Measured on
  // a sustained chord with no attack anywhere in it, plain flux read 0.987 out
  // of 1.
  //
  // This pad is the hard version of that, not the easy one: three DETUNED saws,
  // so every partial beats against its neighbours several times a second and
  // the spectrum is never twice the same. A drawn spectrum that literally does
  // not change is a test of nothing — the only thing it can prove is that zero
  // minus zero is zero, and it is what let `percussivity` ship reading 0.60 on
  // an ambient track.
  //
  // Read as a COMPARISON against a real beat through the same extractor, which
  // is the only form of this claim that means anything: "not percussive" is a
  // statement about a scale, and a scale needs both ends.
  const pad = readAll(
    renderTrack({ seconds: 8, bpm: 30, kickAt: () => [], padGain: 0.25 }).spectra,
    DT,
    60
  );
  const beat = readAll(
    renderTrack({ seconds: 8, bpm: 150, kickOpt: KICKS.hardstyle, hats: 1 }).spectra,
    DT,
    60
  );
  // Measured: midFlux 0.022 against 0.530, highFlux 0.005 against 0.138, kick
  // 0.000 against 0.821 — between one and two orders of magnitude on every one.
  for (const k of ["midFlux", "highFlux", "kick"]) {
    assert.ok(
      pad[k].max < beat[k].max / 8,
      `a pad read ${pad[k].max.toFixed(3)} for ${k} against a beat's ${beat[k].max.toFixed(3)}`
    );
  }
  assert.equal(pad.kick.max, 0, `a pad read ${pad.kick.max.toFixed(2)} as a kick`);
  // Percussivity is the axis the classifier is handed to tell an ambient track
  // from a hard one, so the pad's WORST frame must stay under the beat's
  // ordinary one. Measured, 0.16 against a mean of 0.53.
  assert.ok(
    pad.percussivity.max < beat.percussivity.mean,
    `a pad peaked at ${pad.percussivity.max.toFixed(2)} percussive, a beat averages ${beat.percussivity.mean.toFixed(2)}`
  );
  assert.ok(
    beat.percussivity.max > 0.45,
    `a four-on-the-floor read only ${beat.percussivity.max.toFixed(2)} percussive`
  );
  // ...and the pad is unmistakably tonal, which is the other half of the split.
  assert.ok(pad.tonal.mean > 0.7, `a pad read only ${pad.tonal.mean.toFixed(2)} tonal`);
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
// THE HARD GENRES, END TO END, ON REAL AUDIO
// ============================================================================
//
// Everything above this line drives one module with material chosen to exercise
// that module. This section drives the WHOLE CHAIN — synthesised samples
// through a real FFT into features.js, tempo.js and pattern.js — on the music
// this player is actually pointed at.
//
// It replaced a bench that DREW spectra: one that placed a bin per harmonic at
// a level chosen by hand and handed the result to the analyser. That bench was
// a theory of what a kick looks like, so an analyser tuned against it was tuned
// against the theory, and it could not contain the three things that actually
// break detectors — spectral leakage, phase between overlapping sounds, and the
// real harmonic series a distortion produces. The difference was not academic.
// Every figure below is what the REAL audio exposed on code the drawn bench had
// pronounced perfect at 1.00 detections per kick:
//
//   a closed hi-hat fired the kick detector — techno read 2.00 per kick, every
//     extra one on the offbeat, because a hat is broadband and, added to a band
//     holding only the previous kick's 50 Hz tail, pulls that band's centroid up
//   a reverse bass swelling back between kicks fired it — hardstyle 1.63
//   the beat tracker locked the right TEMPO on the wrong HALF of the beat and
//     stayed there: techno's kicks landed at phase 0.45, trap's at 0.60, so
//     every animation firing on the beat was firing on the offbeat, all track,
//     with the readout saying the tempo was right
//   pattern.js reported ZERO main kicks on techno, trap and every off-beat
//     pattern, because it asked "is this close to the last hit" before "is this
//     on the beat", and a roll LEADS INTO the downbeat
//   at 280 BPM a twelfth of a beat is eighteen milliseconds — less than the
//     detector's own latency — so a quarter of speedcore's main kicks fell
//     outside their own window
//
// None of those are visible in a drawing.

import { createPattern } from "../src/lib/audio/pattern.js";
import { tempoRangeFor } from "../src/lib/audio/style.js";

// Long enough for the grid to settle and be measured for twenty seconds after.
const TRACK_SECONDS = 30;
// The window everything is scored over. The grid needs a few seconds to settle
// and the last half second of the render is the analyser's own zero-padded
// tail, so neither end is music.
//
// AND THE TWO ENDS MUST BE THE SAME WINDOW. Scoring detections over one
// interval and ground truth over another invents faults at the seam: a kick
// rendered at exactly 30.000 s was dropped from the ground truth and its
// perfectly good detection at 30.016 s then read as a main kick landing "94%
// of a beat" from the nearest real one, which was the previous kick. Two of
// the three outliers in this whole suite were that, and nothing else. So a
// detection is scored if and only if the kick it is NEAREST TO is in the
// window — which has no seam at all.
const SCORE_FROM = 6;
const SCORE_TO = TRACK_SECONDS - 0.5;
// When the server's figure arrives. Four seconds, not zero, because that is
// when it actually arrives: it travels over the network behind the audio in the
// request ladder, so a test that seeds at t=0 is testing a case that does not
// happen. See tempo.js#seed.
const SEED_AT = 4;

// Rendering and analysing thirty seconds of audio is the expensive half and
// several tests ask different questions of the same run, so each case renders
// and is driven once. Keyed by identity: every case is a literal built once at
// module scope.
const RUNS = new Map();
function drive(opts) {
  let r = RUNS.get(opts);
  if (r) return r;
  const { spectra, kicks } = renderTrack({ seconds: TRACK_SECONDS, ...opts });
  const fx = createFeatureExtractor({ sampleRate: SR, fftHi: FFT_HI, floorDb: FLOOR });
  const tr = createBeatTracker();
  const pat = createPattern();
  if (opts.genre) {
    const range = tempoRangeFor(opts.genre);
    if (range) tr.setTempoRange(range[0], range[1]);
  }
  let seeded = !opts.seed;
  const bpms = [];
  const hits = [];
  const mains = [];
  const rolls = [];
  let drops = 0;
  let locked = 0;
  let frames = 0;
  const shim = { features: null, beat: null };
  for (let i = 0; i < spectra.length; i++) {
    const t = spectra.at(i);
    if (!seeded && t >= SEED_AT) {
      seeded = true;
      tr.seed(opts.seed);
    }
    const f = fx.process(spectra[i], DT);
    const b = tr.process(f.flux, f.lowFlux, DT);
    shim.features = f;
    shim.beat = b;
    const p = pat.update(shim, DT);
    if (t > SCORE_FROM) {
      if (f.kickHit) hits.push(t);
      if (p.mainKick) mains.push(t);
      if (p.rollKick) rolls.push(t);
      if (p.drop) drops++;
    }
    if (t > 12) {
      bpms.push(b.bpm);
      locked += b.locked ? 1 : 0;
      frames++;
    }
  }
  const sorted = [...bpms].sort((a, b) => a - b);
  let jumps = 0;
  for (let i = 1; i < bpms.length; i++) if (Math.abs(bpms[i] - bpms[i - 1]) > 1.5) jumps++;
  // A detection belongs to the kick it is nearest to; it is scored if and only
  // if that kick is inside the window, which is what keeps the two ends aligned.
  const owned = (list) =>
    list.filter((t) => {
      let best = Infinity;
      let at = -1;
      for (const k of kicks) {
        const d = Math.abs(t - k);
        if (d < best) {
          best = d;
          at = k;
        }
      }
      return at >= SCORE_FROM && at <= SCORE_TO;
    });
  r = {
    bpm: sorted[(sorted.length / 2) | 0] || 0,
    locked: frames ? locked / frames : 0,
    jumps,
    hits: owned(hits),
    mains: owned(mains),
    rolls: owned(rolls),
    drops,
    kicks: kicks.filter((k) => k >= SCORE_FROM && k <= SCORE_TO),
    period: 60 / opts.bpm,
  };
  RUNS.set(opts, r);
  return r;
}

/** Detections per real kick, and the median lateness in milliseconds. */
function fidelity(r) {
  const errs = [];
  for (const h of r.hits) {
    let best = Infinity;
    for (const k of r.kicks) {
      const d = h - k;
      if (d >= -0.03 && d < best) best = d;
    }
    if (best < 0.25) errs.push(best * 1000);
  }
  errs.sort((a, b) => a - b);
  return {
    perKick: r.hits.length / Math.max(1, r.kicks.length),
    lateMs: errs.length ? errs[(errs.length / 2) | 0] : 999,
  };
}

/**
 * How good `mainKick` is — which is what every animation actually reads.
 *
 * PRECISION: a main kick coincides with a real kick. A scene must not throw
 * something when nothing was struck.
 * RECALL: of the kicks that land on a beat, how many were called main.
 */
function mainQuality(r) {
  let good = 0;
  for (const m of r.mains) {
    let best = Infinity;
    for (const k of r.kicks) {
      const d = Math.abs(m - k);
      if (d < best) best = d;
    }
    if (best < 0.07) good++;
  }
  const onBeat = r.kicks.filter((k) => {
    const ph = (k % r.period) / r.period;
    return Math.min(ph, 1 - ph) < 0.1;
  });
  let tp = 0;
  const used = new Set();
  for (const m of r.mains) {
    let best = Infinity;
    let bk = -1;
    for (const k of onBeat) {
      const d = Math.abs(m - k);
      if (d < best) {
        best = d;
        bk = k;
      }
    }
    if (best < 0.07 && !used.has(bk)) {
      tp++;
      used.add(bk);
    }
  }
  return {
    precision: good / Math.max(1, r.mains.length),
    recall: tp / Math.max(1, onBeat.length),
  };
}

// The catalogue. Each is a record somebody makes, with the kick designed the
// way that genre designs it and the pattern written the way it is written.
const HARD = [
  ["techno 128, offbeat hats", { bpm: 128, kickOpt: KICKS.techno, hats: 1, padGain: 0.05, seed: 128 }],
  ["hardtekk 155, swung hats", { bpm: 155, kickOpt: KICKS.hardtekk, hats: 1.2, swing: 0.3, padGain: 0.06, seed: 155 }],
  ["trap 80 over an 808", { bpm: 80, kickOpt: KICKS.trap, padGain: 0.07, seed: 80 }],
  ["gabber 190", { bpm: 190, kickOpt: KICKS.gabber, seed: 190 }],
  ["frenchcore 200", { bpm: 200, kickOpt: KICKS.frenchcore, padGain: 0.05, seed: 200 }],
  ["frenchcore 205, triplet rolls", { bpm: 205, kickOpt: KICKS.frenchcore, kickAt: PATTERNS.tripletRoll, seed: 205 }],
  ["uptempo 200, rolls", { bpm: 200, kickOpt: KICKS.uptempo, kickAt: PATTERNS.uptempo, seed: 200 }],
  ["uptempo 220, sixteenth rolls", { bpm: 220, kickOpt: KICKS.uptempo, kickAt: PATTERNS.heavyRoll, seed: 220 }],
  ["uptempo 240, rolls", { bpm: 240, kickOpt: KICKS.uptempo, kickAt: PATTERNS.uptempo, seed: 240 }],
  ["zaag 175", { bpm: 175, kickOpt: KICKS.zaag, padGain: 0.05, seed: 175 }],
  ["speedcore 280", { bpm: 280, kickOpt: KICKS.speedcore, seed: 280 }],
  ["frenchcore + a hoover on the eighths", { bpm: 200, kickOpt: KICKS.frenchcore, screechAt: () => [0.5], screechOpt: { f: 800, lenMs: 95, gain: 0.6 }, seed: 200 }],
  ["hardstyle 150 + a reverse bass", { bpm: 150, kickOpt: KICKS.hardstyle, rbass: { f: 72, gain: 0.55 }, seed: 150 }],
  ["uptempo 220, kick on the offbeat", { bpm: 220, kickOpt: KICKS.uptempo, kickAt: PATTERNS.offKick, seed: 220 }],
  ["frenchcore 203, played not programmed", { bpm: 203, kickOpt: KICKS.frenchcore, jitterMs: 7, ampJitter: 0.45, seed: 203 }],
  ["frenchcore 243, played not programmed", { bpm: 243, kickOpt: KICKS.frenchcore, jitterMs: 7, ampJitter: 0.45, seed: 243 }],
];

test("every kick is detected, once, on time", () => {
  // The recall test for features.js, and the one that matters: a detector that
  // misses kicks leaves every animation downstream keyed to nothing. Uptempo
  // used to miss SIXTY PER CENT of them, because a hardcore kick's fundamental
  // starts at 190-260 Hz and sweeps down, so the band the old detector watched
  // was four to six decibels DOWN at the attack.
  const report = [];
  for (const [name, opts] of HARD) {
    const f = fidelity(drive(opts));
    report.push(`${name} ${f.perKick.toFixed(2)}`);
    assert.ok(
      f.perKick > 0.92,
      `${name}: only ${f.perKick.toFixed(2)} detections per kick. Full set: ${report.join(", ")}`
    );
    assert.ok(
      f.perKick < 1.3,
      `${name}: ${f.perKick.toFixed(2)} detections per kick — it is firing on something else`
    );
    // A fifth of a beat at 200 BPM is 60 ms; anything near that is visible as
    // an animation lagging the music.
    assert.ok(f.lateMs < 35, `${name}: the kick is reported ${f.lateMs.toFixed(0)} ms late`);
  }
});

test("the main kicks are found, and nothing else is called one", () => {
  // THE test for pattern.js, because `mainKick` is what the animations read.
  // Precision is the one that shows: a scene throwing a slab when nothing was
  // struck is a fault anybody can see.
  const report = [];
  for (const [name, opts] of HARD) {
    const r = drive(opts);
    const q = mainQuality(r);
    report.push(`${name} ${(q.precision * 100) | 0}/${(q.recall * 100) | 0}`);
    assert.ok(
      q.precision > 0.9,
      `${name}: ${(q.precision * 100) | 0}% of main kicks coincided with a real kick. Full set: ${report.join(", ")}`
    );
    // Two main kicks cannot be a sixteenth apart: they are on the grid.
    let tooClose = 0;
    for (let i = 1; i < r.mains.length; i++)
      if (r.mains[i] - r.mains[i - 1] < r.period * 0.55) tooClose++;
    assert.equal(tooClose, 0, `${name}: ${tooClose} main kicks landed inside half a beat of each other`);
  }
});

test("the main kicks are on the beat the music is on", () => {
  // Recall, against the grid the pattern was written on. Separated from the
  // test above because one case has no answer to it: with the kick alternating
  // between the beat and the offbeat, WHICH of the two positions is "the beat"
  // is genuinely ambiguous, and the tracker picking the other one is not wrong.
  for (const [name, opts] of HARD) {
    if (opts.kickAt === PATTERNS.offKick) continue;
    const q = mainQuality(drive(opts));
    assert.ok(
      q.recall > 0.84,
      `${name}: only ${(q.recall * 100) | 0}% of the kicks on a beat were called main kicks`
    );
  }
});

test("a lead in the kick's own register is where this stops working", () => {
  // AN HONEST LIMIT, pinned with the measurement that establishes it rather
  // than asserted, and pinned at BOTH layers because only one of them fails.
  //
  // A 320 Hz saw stab, as loud as the kick, on every sixteenth. Measured, its
  // evidence at the frame it arrives is:
  //
  //             lift  pitch  click   sub
  //   the stab  0.24   1.00   0.95  0.00
  //   a real uptempo kick landing on a low end its predecessor has already
  //   filled — the normal case in this music, and the hardest —
  //             0.23   1.39   0.95  0.00
  //
  // Those are the same numbers. There is no threshold between them, and every
  // attempt to invent one cost real kicks elsewhere: a sub-band veto took
  // uptempo from 1.00 detections per kick to 0.72. From a single frame, a
  // percussive attack in the kick's register IS a kick.
  //
  // So features.js does not try, and the layer that CAN tell them apart — the
  // one that knows where the beat is — does. That is the whole reason
  // pattern.js exists, and this is the case that proves it.
  const stab = {
    bpm: 200,
    kickOpt: KICKS.frenchcore,
    screechAt: () => [0.25, 0.5, 0.75],
    screechOpt: { f: 320, lenMs: 55, gain: 0.6 },
    seed: 200,
  };
  const r = drive(stab);
  const f = fidelity(r);
  assert.ok(f.perKick > 0.95, `it must still catch every kick (${f.perKick.toFixed(2)})`);
  assert.ok(
    f.perKick < 4,
    `the raw detector now fires ${f.perKick.toFixed(2)} times per kick, worse than when this was measured (3.2)`
  );
  // ...and the musical layer is unaffected by it.
  const q = mainQuality(r);
  assert.ok(
    q.precision > 0.9 && q.recall > 0.9,
    `mainKick should be unaffected: precision ${(q.precision * 100) | 0}%, recall ${(q.recall * 100) | 0}%`
  );
});

test("a hi-hat, a reverse bass and a hoover are not kicks", () => {
  // The three false-positive classes that ARE separable, each with the measured
  // figure the current code replaced. They are separable because each is
  // missing a different half of a kick's evidence: the hat has the beater and
  // no low end, the reverse bass has the low end and never strikes, the hoover
  // has neither.
  const cases = [
    ["a closed hi-hat on every offbeat", { bpm: 128, kickOpt: KICKS.techno, hats: 1.6, seed: 128 }, 2.0],
    ["a reverse bass between the kicks", { bpm: 150, kickOpt: KICKS.hardstyle, rbass: { f: 72, gain: 0.6 }, seed: 150 }, 1.63],
    ["a hoover above the kick's register", { bpm: 200, kickOpt: KICKS.frenchcore, screechAt: () => [0.5], screechOpt: { f: 800, lenMs: 95, gain: 0.7 }, seed: 200 }, 1.0],
  ];
  for (const [name, opts, was] of cases) {
    const f = fidelity(drive(opts));
    assert.ok(
      f.perKick < 1.15,
      `${name}: ${f.perKick.toFixed(2)} detections per kick (it was ${was} before this was fixed)`
    );
    assert.ok(f.perKick > 0.92, `${name}: and it must still catch the kicks (${f.perKick.toFixed(2)})`);
  }
});

test("the grid lands on the kick, not on the offbeat", () => {
  // The fault this catches is invisible in every other reading: the tempo is
  // right, the confidence is high, the readout says 128 BPM — and the beat is
  // on the wrong half of the bar, because the PLL was pulled onto a loud
  // offbeat hi-hat and `phaseFromFold` only ever ran when the TEMPO moved.
  // Measured, techno's kicks landed at phase 0.45 and trap's at 0.60.
  for (const [name, opts] of HARD) {
    const r = drive(opts);
    if (!r.mains.length) continue;
    // Read as a DISTRIBUTION, not as a worst case. "Where is the beat" is a
    // question about a hundred events, and one stray detection cannot answer
    // it either way — whether a main kick should have been called at all is
    // the precision question, and it has its own test above. Measured across
    // these sixteen records the 95th percentile runs 0.026 to 0.090 of a beat
    // and the median 0.019 to 0.067, while two of them carry a single outlier
    // at 0.55 and 1.08: bounding the maximum would be testing those two events
    // and nothing else.
    const errs = [];
    for (const m of r.mains) {
      let best = Infinity;
      for (const k of r.kicks) {
        const d = Math.abs(m - k);
        if (d < best) best = d;
      }
      if (best < 0.25) errs.push(best / r.period);
    }
    errs.sort((a, b) => a - b);
    const p50 = errs[(errs.length * 0.5) | 0];
    const p95 = errs[Math.min(errs.length - 1, (errs.length * 0.95) | 0)];
    assert.ok(
      p50 < 0.09,
      `${name}: the grid sits ${(p50 * 100) | 0}% of a beat off the kicks (median)`
    );
    assert.ok(
      p95 < 0.13,
      `${name}: one main kick in twenty landed ${(p95 * 100) | 0}% of a beat from the nearest real one`
    );
    // ...and the grid being right is not a licence to fire anywhere. Not ONE
    // main kick in the whole catalogue — 1157 of them across sixteen records —
    // may land more than a third of a beat from a real one.
    const stray = errs.filter((e) => e > 1 / 3).length;
    assert.equal(
      stray,
      0,
      `${name}: ${stray} of ${errs.length} main kicks landed nowhere near a real one`
    );
  }
});

test("the tempo is the tempo, on real audio, across the hard genres", () => {
  const report = [];
  for (const [name, opts] of HARD) {
    const r = drive(opts);
    report.push(`${name} ${r.bpm.toFixed(0)}`);
    assert.ok(
      Math.abs(r.bpm / opts.bpm - 1) < 0.04,
      `${name}: settled on ${r.bpm.toFixed(1)} against ${opts.bpm}. Full set: ${report.join(", ")}`
    );
    assert.ok(r.locked > 0.9, `${name}: the grid only held a lock ${(r.locked * 100) | 0}% of the time`);
    assert.ok(r.jumps < 6, `${name}: the reading moved ${r.jumps} times`);
  }
});

test("knowing the genre is what settles the octave", () => {
  // The published result on tempo octave errors in electronic music, and the
  // only thing that can work: 250 BPM uptempo and 125 BPM house produce the
  // same autocorrelation. What separates them is knowing which record it is.
  for (const [name, opts, genre] of RANGE_ON_REAL) {
    const r = drive(opts);
    assert.ok(
      Math.abs(r.bpm / opts.bpm - 1) < 0.04,
      `${name} as ${genre}: read ${r.bpm.toFixed(1)}, wanted ${opts.bpm}`
    );
  }
});

const RANGE_ON_REAL = [
  ["speedcore 280", { bpm: 280, kickOpt: KICKS.speedcore, genre: "speedcore" }, "speedcore"],
  ["uptempo 240 with rolls", { bpm: 240, kickOpt: KICKS.uptempo, kickAt: PATTERNS.uptempo, genre: "uptempo" }, "uptempo"],
  ["frenchcore 200", { bpm: 200, kickOpt: KICKS.frenchcore, padGain: 0.05, genre: "frenchcore" }, "frenchcore"],
  ["techno 128", { bpm: 128, kickOpt: KICKS.techno, hats: 1, genre: "techno" }, "techno"],
];

test("a roll is told apart from the main kicks", () => {
  // What pattern.js exists for: at 220 BPM a bar of sixteenth rolls is fifteen
  // hits in two seconds, and a scene that throws something on every one of them
  // is a strobe rather than an animation.
  const rolled = drive(HARD.find(([n]) => n.startsWith("uptempo 220, sixteenth"))[1]);
  const beats = (TRACK_SECONDS - 6) * (220 / 60);
  assert.ok(
    rolled.mains.length > beats * 0.55 && rolled.mains.length < beats * 1.1,
    `${rolled.mains.length} main kicks against ${beats.toFixed(0)} beats`
  );
  assert.ok(rolled.rolls.length > beats * 0.2, `only ${rolled.rolls.length} roll notes were seen`);
  // ...and a straight four-on-the-floor has almost none.
  const straight = drive(HARD.find(([n]) => n === "frenchcore 200")[1]);
  assert.ok(
    straight.rolls.length < straight.mains.length * 0.12,
    `a straight pattern produced ${straight.rolls.length} roll notes against ${straight.mains.length} main kicks`
  );
});

test("the drop is detected, and only the drop", () => {
  // The arrangement going out and coming back is the single most important
  // event in any of these tracks, and nothing below pattern.js could see it.
  const r = drive(ARRANGED);
  assert.ok(r.drops >= 1, "the arrangement came back and nothing noticed");
  assert.ok(r.drops <= 3, `${r.drops} drops in a track with one breakdown`);
  const flat = drive(HARD.find(([n]) => n === "frenchcore 200")[1]);
  assert.equal(flat.drops, 0, "a track with no breakdown reported a drop");
});

const ARRANGED = {
  bpm: 200,
  seconds: 46,
  intro: 5,
  breakAt: [22, 32],
  kickOpt: KICKS.frenchcore,
  jitterMs: 4,
  ampJitter: 0.4,
  padGain: 0.05,
  seed: 200,
};
