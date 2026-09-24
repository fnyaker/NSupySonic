// The rhythm analyser (webapp/rhythm — Rust, compiled to src/lib/audio/
// rhythm.wasm), driven from Node on REAL AUDIO: samples rendered by
// test/synth.mjs and test/songs.mjs with the production recipe of every sound
// they name, pushed through the very binary the app ships, exactly as the
// AudioWorklet pushes it. `npm test`.
//
// Every assertion carries the number it was measured at. The thresholds sit
// with margin around those numbers, and where the analyser has a stated limit
// the test says so with the evidence rather than moving the material.
//
// The eval (test/eval/rhythm-eval.mjs) asks the broader question on 26
// arranged records; the browser bench (test/rhythm/run.mjs) asks it through
// the AudioWorklet and the engine's delivery in headless Chromium. This file
// pins what must never regress.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Rhythm } from "../src/lib/audio/rhythm-core.js";
import { familyAt, familyTable, tempoRangeFor, ARCHETYPES } from "../src/lib/audio/style.js";
import { renderTrack, KICKS, PATTERNS } from "./synth.mjs";
import { SONG_BY_ID } from "./songs.mjs";
import { loadSong, score } from "./eval/rhythm-eval.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const AUDIO = join(here, "../src/lib/audio");
const SR = 48000;

const BASE = readFileSync(join(AUDIO, "rhythm.wasm"));
const SIMD = readFileSync(join(AUDIO, "rhythm-simd.wasm"));
const MODULE = new WebAssembly.Module(BASE);
const TABLE = familyTable();

function analyser({ level = 2, genre = "", module = MODULE } = {}) {
  const r = Rhythm.fromModule(module, SR);
  r.loadFamilies(TABLE);
  r.setLevel(level);
  if (genre) {
    const range = tempoRangeFor(genre);
    if (range) r.setRange(range[0], range[1]);
    r.setLiveRange(false);
  }
  return r;
}

/**
 * Push `pcm` through `r` in the worklet's own 128-sample quanta, calling
 * `fn(t, get, vec)` for every frame: `get(name)` a scalar, `vec(name)` a view.
 * `seed` arrives at `seedAt` seconds, as the server's verdict does.
 */
function drive(r, pcm, fn, { seed = 0, seedAt = 4, quantum = 128 } = {}) {
  const F = r.layout.fields;
  const hopS = r.hop / SR;
  let seeded = !seed;
  let fr = null;
  const get = (n) => fr[F[n][0]];
  const vec = (n) => fr.subarray(F[n][0], F[n][0] + F[n][1]);
  for (let i = 0; i < pcm.length; i += quantum) {
    if (!seeded && i / SR >= seedAt) {
      seeded = true;
      r.seed(seed, 0.9);
    }
    const n = r.push(pcm.subarray(i, Math.min(pcm.length, i + quantum)));
    for (let k = 0; k < n; k++) {
      fr = r.frame(k);
      fn(get("frame") * hopS, get, vec);
    }
  }
}

const gain = (pcm, db) => {
  const g = Math.pow(10, db / 20);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * g;
  return out;
};

// --- the binary is the source ------------------------------------------------------------

// The same FNV-1a build.rs stamps into the binary: every src/*.rs, sorted by
// name, name bytes then file bytes.
function sourceHash() {
  const dir = join(here, "../rhythm/src");
  const names = readdirSync(dir).filter((n) => n.endsWith(".rs")).sort();
  let h = 0x811c9dc5;
  const eat = (bytes) => {
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  };
  for (const n of names) {
    eat(Buffer.from(n));
    eat(readFileSync(join(dir, n)));
  }
  return h >>> 0;
}

test("the shipped analysers are built from the Rust next to them", () => {
  // A committed binary that no longer matches its source would run old code
  // silently. `npm run wasm` rebuilds both.
  const want = sourceHash();
  for (const [name, bytes] of [["rhythm.wasm", BASE], ["rhythm-simd.wasm", SIMD]]) {
    const r = Rhythm.fromModule(new WebAssembly.Module(bytes), SR);
    assert.equal(r.srcHash(), want, `${name} is stale: run \`npm run wasm\``);
  }
});

test("the SIMD build computes the same frames as the baseline", () => {
  // It is chosen at run time wherever the browser validates SIMD128, so the
  // two must be interchangeable — measured, identical to the last bit.
  const { pcm } = renderTrack({ seconds: 8, bpm: 174, kickOpt: KICKS.frenchcore, hats: 1 });
  const out = [];
  for (const module of [MODULE, new WebAssembly.Module(SIMD)]) {
    const r = analyser({ module });
    const frames = [];
    for (let i = 0; i < pcm.length; i += 128) {
      const n = r.push(pcm.subarray(i, i + 128));
      for (let k = 0; k < n; k++) frames.push(Float32Array.from(r.frame(k)));
    }
    out.push(frames);
  }
  assert.equal(out[0].length, out[1].length);
  let worst = 0;
  for (let i = 0; i < out[0].length; i++)
    for (let k = 0; k < out[0][i].length; k++) {
      const a = out[0][i][k];
      const b = out[1][i][k];
      if (Number.isFinite(a) || Number.isFinite(b)) worst = Math.max(worst, Math.abs(a - b));
    }
  assert.ok(worst < 1e-4, `the two builds differ by ${worst}`);
});

// --- nothing from nothing ------------------------------------------------------------------

test("silence produces frames and no events at all", () => {
  let frames = 0;
  let events = 0;
  drive(analyser(), new Float32Array(SR * 10), (t, get) => {
    frames++;
    if (get("kickHit") || get("beat") || get("drop") || get("snareHit")) events++;
    for (const k of ["level", "bpm", "confidence", "styleConfidence"])
      assert.ok(Number.isFinite(get(k)), `${k} is not finite on silence`);
  });
  assert.ok(frames > 900 && frames < 950, `${frames} frames for ten seconds`);
  assert.equal(events, 0, `silence produced ${events} events`);
});

test("a tone that never changes produces no events", () => {
  // Every witness in the kick detector is a STEP or a sweep: a sustained note
  // in the kick's own register must read as nothing, for ever.
  const pcm = new Float32Array(SR * 12);
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.4 * Math.sin((2 * Math.PI * 55 * i) / SR);
  let kicks = 0;
  let drops = 0;
  drive(analyser(), pcm, (t, get) => {
    if (t > 0.5 && get("kickHit")) kicks++;
    if (get("drop")) drops++;
  });
  assert.equal(kicks, 0, `a 55 Hz tone fired ${kicks} kicks`);
  assert.equal(drops, 0);
});

// --- level is information, and it is not a verdict --------------------------------------------

test("the same beat played quieter reads quieter, in proportion, and keeps its kicks", () => {
  // THE FAULT THIS PINS: the kick detector judges a candidate against this
  // track's kicks, and only an accepted kick used to move that reference — so
  // a passage 6 dB quieter lost 25 of its 26 kicks, and never got them back.
  // A rejected candidate whose beater is unmistakable now walks the reference
  // down to it.
  //
  // One performance: ten seconds of a hardstyle bar at full level, then the
  // identical samples scaled down — which is exactly what a level change is.
  // Measured: kicks 26 / 26 / 25 of 26, the kick envelope 0.59 / 0.40 / 0.19
  // of the loud part, the dynamics gate closing to 0.42 / 0.24 / 0.04.
  const { pcm } = renderTrack({ seconds: 10, bpm: 150, kickOpt: KICKS.hardstyle, hats: 1 });
  const want = { "-6": [0.45, 0.8, 24], "-12": [0.28, 0.55, 22], "-20": [0.08, 0.32, 12] };
  let last = 1;
  for (const db of [-6, -12, -20]) {
    const both = new Float32Array(pcm.length * 2);
    both.set(pcm);
    both.set(gain(pcm, db), pcm.length);
    let loud = 0;
    let ln = 0;
    let quiet = 0;
    let qn = 0;
    let kicks = 0;
    drive(analyser(), both, (t, get) => {
      if (t < 1) return;
      if (t < 10) {
        loud += get("kick");
        ln++;
      } else {
        quiet += get("kick");
        qn++;
        if (get("kickHit")) kicks++;
      }
    });
    const ratio = quiet / qn / (loud / ln);
    const [lo, hi, minKicks] = want[String(db)];
    assert.ok(ratio > lo && ratio < hi, `${db} dB down read ${ratio.toFixed(2)} of the loud part, wanted ${lo}..${hi}`);
    assert.ok(ratio < last, `${db} dB down read louder than the step above it`);
    assert.ok(kicks >= minKicks, `${db} dB down: only ${kicks} of 26 kicks were found`);
    last = ratio;
  }
});

test("a sustained pad produces no kicks and reads tonal; a beat reads percussive", () => {
  // The pad is three DETUNED saws, so every partial beats against its
  // neighbours and the spectrum is never twice the same — the hard version.
  // Measured: midFlux 0.023 against 0.545, highFlux 0.005 against 0.132, no
  // kick at all against 18; percussivity at most 0.20 against a beat's mean
  // 0.54; the pad 0.85 tonal.
  const stats = (pcm) => {
    const s = {};
    drive(analyser(), pcm, (t, get) => {
      if (t < 1) return;
      for (const k of ["midFlux", "highFlux", "kick", "kickHit", "percussivity", "tonal"]) {
        const a = (s[k] = s[k] || { max: -Infinity, sum: 0, n: 0 });
        const v = get(k);
        a.max = Math.max(a.max, v);
        a.sum += v;
        a.n++;
      }
    });
    for (const k in s) s[k].mean = s[k].sum / s[k].n;
    return s;
  };
  const pad = stats(renderTrack({ seconds: 8, bpm: 30, kickAt: () => [], padGain: 0.25 }).pcm);
  const beat = stats(renderTrack({ seconds: 8, bpm: 150, kickOpt: KICKS.hardstyle, hats: 1 }).pcm);
  for (const k of ["midFlux", "highFlux"])
    assert.ok(pad[k].max < beat[k].max / 8, `${k}: a pad read ${pad[k].max.toFixed(3)} against a beat's ${beat[k].max.toFixed(3)}`);
  assert.equal(pad.kickHit.sum, 0, "a pad fired a kick");
  assert.ok(beat.kickHit.sum >= 17, `the beat's 18 kicks came out as ${beat.kickHit.sum}`);
  assert.ok(pad.percussivity.max < beat.percussivity.mean, "a pad peaked more percussive than a beat averages");
  assert.ok(pad.tonal.mean > 0.75, `a pad read only ${pad.tonal.mean.toFixed(2)} tonal`);
});

test("chroma says which pitches are sounding, and noise has no opinion", () => {
  // An A major triad (A3, C#4, E4) with six harmonics each at 1/h. Its energy
  // by pitch class is E 2.25, C# 1.95, A 1.75 — the harmonics of all three
  // land on E. Measured: the top two read E and C#, peak over mean 3.19;
  // white noise 1.15.
  const n = SR * 6;
  const chord = new Float32Array(n);
  const noise = new Float32Array(n);
  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const f0 of [220, 277.18, 329.63])
      for (let h = 1; h <= 6; h++) v += (Math.sin((2 * Math.PI * f0 * h * i) / SR) * 0.08) / h;
    chord[i] = v;
    noise[i] = rnd() * 0.2;
  }
  const read = (pcm) => {
    const acc = new Float64Array(12);
    drive(analyser(), pcm, (t, get, vec) => {
      if (t < 2) return;
      const c = vec("chroma");
      for (let i = 0; i < 12; i++) acc[i] += c[i];
    });
    const mean = acc.reduce((a, b) => a + b) / 12;
    const order = [...acc].map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
    return { order, peak: Math.max(...acc) / mean };
  };
  const c = read(chord);
  const chordPcs = [9, 1, 4]; // A, C#, E
  assert.ok(chordPcs.includes(c.order[0]) && chordPcs.includes(c.order[1]), `the chord read as ${c.order.slice(0, 3)}`);
  assert.ok(c.peak > 2.5, `the chord's chroma is flat (${c.peak.toFixed(2)})`);
  const z = read(noise);
  assert.ok(z.peak < 1.5, `noise has an opinion about pitch (${z.peak.toFixed(2)})`);
});

// --- tempo --------------------------------------------------------------------------------------

test("the tempo locks onto a steady pulse, and beats come one per beat", () => {
  // Techno kicks with an open hat on every offbeat — the hat puts as much
  // onset energy halfway through the beat as the kick does on it, which is
  // exactly what tempts a tracker to double. Cold, no seed. Measured: exact
  // at all four, first right at 10.2 / 3.8 / 3.5 / 3.5 s; beats in the last
  // twelve seconds 21 / 25 / 35 / 42 against 18 / 26 / 35 / 42 (the slow one
  // spends its first seconds at double).
  for (const [bpm, by] of [[90, 12], [128, 5], [174, 5], [210, 5]]) {
    const { pcm } = renderTrack({ seconds: 20, bpm, kickOpt: KICKS.techno, hats: 1 });
    let lockedAt = null;
    let last = 0;
    let beats = 0;
    drive(analyser({ level: 1 }), pcm, (t, get) => {
      if (lockedAt == null && get("locked") && Math.abs(get("bpm") / bpm - 1) < 0.04) lockedAt = t;
      last = get("bpm");
      if (t > 12 && get("beat")) beats++;
    });
    assert.ok(Math.abs(last / bpm - 1) < 0.02, `${bpm} BPM: ended on ${last.toFixed(1)}`);
    assert.ok(lockedAt != null && lockedAt < by, `${bpm} BPM: right only from ${lockedAt?.toFixed(1)} s`);
    const expected = (8 * bpm) / 60;
    assert.ok(Math.abs(beats - expected) <= 1, `${bpm} BPM: ${beats} beats in 8 s, expected ${expected.toFixed(1)}`);
  }
});

test("no confident tempo is claimed for noise", () => {
  // Measured: confidence at most 0.48, mean 0.21.
  const pcm = new Float32Array(SR * 20);
  let s = 99;
  for (let i = 0; i < pcm.length; i++) pcm[i] = (((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1) * 0.3;
  let peak = 0;
  drive(analyser({ level: 1 }), pcm, (t, get) => {
    if (t > 3) peak = Math.max(peak, get("confidence"));
  });
  assert.ok(peak < 0.55, `noise reached confidence ${peak.toFixed(2)}`);
});

test("a served tempo is heard at once, and a wrong octave is corrected by the music", () => {
  // The whole point of measuring on the server: the first bar is on the beat.
  // Measured: seeded, 174 is reported 0.16 s in; cold, 3.46 s. A figure
  // published at HALF the tempo (Deezer does this) is overruled by the kicks
  // the moment it lands — 5.0 s, one second after the seed at 4 s.
  const { pcm } = renderTrack({ seconds: 12, bpm: 174, kickOpt: KICKS.techno, hats: 1 });
  const at = (seedFirst) => {
    const r = analyser({ level: 1 });
    if (seedFirst) r.seed(174, 0.95);
    let when = null;
    drive(r, pcm, (t, get) => {
      if (when == null && get("locked") && Math.abs(get("bpm") - 174) < 5) when = t;
    });
    return when;
  };
  const seeded = at(true);
  const cold = at(false);
  assert.ok(seeded != null && seeded < 0.4, `seeded, the tempo came ${seeded?.toFixed(2)} s in`);
  assert.ok(cold != null && seeded < cold, `seeding did not help (${seeded} vs ${cold})`);
  for (const [bpm, kick] of [[200, KICKS.frenchcore], [240, KICKS.uptempo], [150, KICKS.hardstyle]]) {
    const { pcm: p } = renderTrack({ seconds: 30, bpm, kickOpt: kick });
    let last = 0;
    drive(analyser({ level: 1 }), p, (t, get) => (last = get("bpm")), { seed: bpm / 2, seedAt: 4 });
    assert.ok(Math.abs(last / bpm - 1) < 0.02, `seeded at ${bpm / 2}, a ${bpm} BPM record ended on ${last.toFixed(1)}`);
  }
});

test("a seed outside the searchable range is refused", () => {
  const r = analyser({ level: 1 });
  for (const bpm of [0, 12, 900, NaN]) assert.equal(r.seed(bpm, 0.9), false, `${bpm} was accepted`);
});

// --- the classifier ------------------------------------------------------------------------------

test("the style reading stays on the simplex, bounded, and never jumps", () => {
  // The renderer blends on these numbers every frame, so a jump is a visible
  // cut. Measured: the largest single-frame move of any look value 0.003
  // (it was 0.22 while the neutral look was swapped for the first family to
  // clear zero); the archetypes always sum to 1.
  for (const opts of [
    { seconds: 20, bpm: 220, kickOpt: KICKS.uptempo, kickAt: PATTERNS.uptempo },
    { seconds: 20, bpm: 128, kickOpt: KICKS.techno, hats: 1 },
    { seconds: 20, bpm: 30, kickAt: () => [], padGain: 0.25 },
  ]) {
    let prev = null;
    let worst = 0;
    drive(analyser(), renderTrack(opts).pcm, (t, get, vec) => {
      const a = vec("archetypes");
      const sum = a.reduce((x, y) => x + y, 0);
      assert.ok(Math.abs(sum - 1) < 1e-3, `archetypes sum to ${sum}`);
      const look = vec("look");
      for (const v of look) assert.ok(v >= 0 && v <= 1, `a look value of ${v}`);
      if (prev) for (let i = 0; i < look.length; i++) worst = Math.max(worst, Math.abs(look[i] - prev[i]));
      prev = Float32Array.from(look);
    });
    assert.ok(worst < 0.02, `the look moved ${worst.toFixed(3)} in one frame at ${opts.bpm} BPM`);
  }
});

test("a hard kick reads hard, an industrial one industrial, a techno one soft", () => {
  // The kick's SHAPE, measured on each kick by the detector: where its pitch
  // starts (160-200 Hz for hard genres, 50-100 for the rest) and how noisy
  // its body is. The old reading's thresholds sat three orders of magnitude
  // above the ratio it computed, and all three weights stayed at a third.
  // Measured on the synthesised kicks: frenchcore hard 0.83; uptempo and
  // krach-style industrial 0.79 / 0.87 on the eval's records; techno soft 1.00.
  const shape = (opts) => {
    let last = null;
    drive(analyser(), renderTrack({ seconds: 20, ...opts }).pcm, (t, get) => {
      last = { soft: get("kickSoft"), hard: get("kickHard"), indus: get("kickIndus") };
    });
    return last;
  };
  const fc = shape({ bpm: 200, kickOpt: KICKS.frenchcore, padGain: 0.05 });
  assert.ok(fc.hard > 0.6, `frenchcore read hard ${fc.hard.toFixed(2)}`);
  const tn = shape({ bpm: 128, kickOpt: KICKS.techno, hats: 1 });
  assert.ok(tn.soft > 0.8, `techno read soft ${tn.soft.toFixed(2)}`);
  const up = shape({ bpm: 220, kickOpt: KICKS.uptempo, kickAt: PATTERNS.uptempo });
  assert.ok(up.soft < 0.3, `uptempo read soft ${up.soft.toFixed(2)}`);
});

test("a hard record reads as a hard family, techno as techno, a pad as ambient", () => {
  // Measured: frenchcore -> hardcore at 1.00 with the hard archetype 0.83;
  // techno 128 -> techno at 1.00; the pad -> ambient, sustain 1.00.
  const verdict = (opts) => {
    let v = null;
    drive(analyser(), renderTrack({ seconds: 30, ...opts }).pcm, (t, get, vec) => {
      const a = vec("archetypes");
      v = { id: familyAt(Math.round(get("styleDominant")))?.id, arch: Object.fromEntries(ARCHETYPES.map((k, i) => [k, a[i]])) };
    });
    return v;
  };
  const fc = verdict({ bpm: 200, kickOpt: KICKS.frenchcore, padGain: 0.05 });
  assert.ok(fc.arch.hard > 0.6, `frenchcore: hard archetype ${fc.arch.hard.toFixed(2)} (${fc.id})`);
  const tn = verdict({ bpm: 128, kickOpt: KICKS.techno, hats: 1 });
  assert.equal(tn.id, "techno");
  const pad = verdict({ bpm: 30, kickAt: () => [], padGain: 0.25 });
  assert.ok(pad.arch.sustain > 0.8, `the pad: sustain ${pad.arch.sustain.toFixed(2)} (${pad.id})`);
});

// --- the hard genres, end to end -----------------------------------------------------------------
//
// The catalogue the JavaScript analyser was held to, each record a genre as
// that genre writes its kick and its pattern; thirty seconds, seeded at four
// like the server's figure is. Scored after six seconds, and a detection
// belongs to the kick it is NEAREST to, scored if and only if that kick is in
// the window — scoring the two ends over different windows invents faults at
// the seam.

const TRACK_SECONDS = 30;
const SCORE_FROM = 6;
const SCORE_TO = TRACK_SECONDS - 0.5;
const RUNS = new Map();

function runRecord(opts) {
  let r = RUNS.get(opts);
  if (r) return r;
  const { pcm, kicks } = renderTrack({ seconds: TRACK_SECONDS, ...opts });
  const bpms = [];
  const hits = [];
  const mains = [];
  const rolls = [];
  let drops = 0;
  let locked = 0;
  let frames = 0;
  drive(
    analyser({ genre: opts.genre || "" }),
    pcm,
    (t, get) => {
      if (t > SCORE_FROM) {
        if (get("kickHit")) hits.push(t);
        if (get("mainKick")) mains.push(t);
        if (get("rollKick")) rolls.push(t);
        if (get("drop")) drops++;
      }
      if (t > 12) {
        bpms.push(get("bpm"));
        locked += get("locked") ? 1 : 0;
        frames++;
      }
    },
    { seed: opts.seed || 0 }
  );
  const sorted = [...bpms].sort((a, b) => a - b);
  let jumps = 0;
  for (let i = 1; i < bpms.length; i++) if (Math.abs(bpms[i] - bpms[i - 1]) > 1.5) jumps++;
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
  return { perKick: r.hits.length / Math.max(1, r.kicks.length), lateMs: errs.length ? errs[(errs.length / 2) | 0] : 999 };
}

/** mainKick, which is what every animation reads: precision, and recall on the beat. */
function mainQuality(r) {
  let good = 0;
  for (const m of r.mains) {
    let best = Infinity;
    for (const k of r.kicks) best = Math.min(best, Math.abs(m - k));
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
  return { precision: good / Math.max(1, r.mains.length), recall: tp / Math.max(1, onBeat.length) };
}

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
  // Measured: 1.00 detections per kick on fourteen of the sixteen, 1.01 with
  // the kick on the offbeat and 1.20 over a reverse bass (the extras are all
  // called roll notes, not main kicks — see below); 1-12 ms late.
  for (const [name, opts] of HARD) {
    const f = fidelity(runRecord(opts));
    assert.ok(f.perKick > 0.95 && f.perKick < 1.25, `${name}: ${f.perKick.toFixed(2)} detections per kick`);
    assert.ok(f.lateMs < 20, `${name}: reported ${f.lateMs.toFixed(0)} ms late`);
  }
});

test("the main kicks are the real ones, on the beat, never two in half a beat", () => {
  // `mainKick` is what the animations throw things on. Measured: 100% precise
  // and 100% of the on-beat kicks found, on all sixteen.
  for (const [name, opts] of HARD) {
    const r = runRecord(opts);
    const q = mainQuality(r);
    assert.ok(q.precision > 0.97, `${name}: ${(q.precision * 100) | 0}% of main kicks were real kicks`);
    if (opts.kickAt !== PATTERNS.offKick)
      assert.ok(q.recall > 0.95, `${name}: ${(q.recall * 100) | 0}% of on-beat kicks were called main`);
    let close = 0;
    for (let i = 1; i < r.mains.length; i++) if (r.mains[i] - r.mains[i - 1] < r.period * 0.55) close++;
    assert.equal(close, 0, `${name}: ${close} main kicks inside half a beat of each other`);
  }
});

test("the grid lands on the kick, not on the offbeat", () => {
  // Read as a distribution: where the main kicks sit against the real ones,
  // in fractions of a beat. Measured: median 0.4-4.2%, 95th percentile at most
  // 6.4%, and not one main kick of 1150 more than a third of a beat off.
  for (const [name, opts] of HARD) {
    const r = runRecord(opts);
    const errs = [];
    for (const m of r.mains) {
      let best = Infinity;
      for (const k of r.kicks) best = Math.min(best, Math.abs(m - k));
      if (best < 0.25) errs.push(best / r.period);
    }
    errs.sort((a, b) => a - b);
    const p50 = errs[(errs.length * 0.5) | 0];
    const p95 = errs[Math.min(errs.length - 1, (errs.length * 0.95) | 0)];
    assert.ok(p50 < 0.06, `${name}: the grid sits ${(p50 * 100).toFixed(1)}% of a beat off (median)`);
    assert.ok(p95 < 0.09, `${name}: 95th percentile ${(p95 * 100).toFixed(1)}% of a beat`);
    assert.equal(errs.filter((e) => e > 1 / 3).length, 0, `${name}: a main kick landed nowhere near a real one`);
  }
});

test("the tempo is the tempo across the hard genres, and it does not move", () => {
  // Measured: exact on all sixteen, locked 100% of the time, no jump at all.
  for (const [name, opts] of HARD) {
    const r = runRecord(opts);
    assert.ok(Math.abs(r.bpm / opts.bpm - 1) < 0.01, `${name}: ${r.bpm.toFixed(1)} against ${opts.bpm}`);
    assert.ok(r.locked > 0.97, `${name}: locked ${(r.locked * 100) | 0}% of the time`);
    assert.ok(r.jumps < 2, `${name}: the reading moved ${r.jumps} times`);
  }
});

test("knowing the genre is what settles the octave", () => {
  // 250 BPM uptempo and 125 BPM house produce the same autocorrelation; what
  // separates them is knowing the record. With the genre's range and no BPM
  // at all: measured exact on all four.
  for (const [name, opts] of [
    ["speedcore 280", { bpm: 280, kickOpt: KICKS.speedcore, genre: "speedcore" }],
    ["uptempo 240 with rolls", { bpm: 240, kickOpt: KICKS.uptempo, kickAt: PATTERNS.uptempo, genre: "uptempo" }],
    ["frenchcore 200", { bpm: 200, kickOpt: KICKS.frenchcore, padGain: 0.05, genre: "frenchcore" }],
    ["techno 128", { bpm: 128, kickOpt: KICKS.techno, hats: 1, genre: "techno" }],
  ]) {
    const r = runRecord(opts);
    assert.ok(Math.abs(r.bpm / opts.bpm - 1) < 0.02, `${name}: read ${r.bpm.toFixed(1)}`);
  }
});

test("a roll is told apart from the main kicks", () => {
  // At 220 BPM a bar of sixteenths is fifteen hits in two seconds; a scene
  // throwing something on each is a strobe. Measured: 87 main kicks for 88
  // beats and 60 roll notes; frenchcore straight, 79 main and no roll.
  const rolled = runRecord(HARD.find(([n]) => n.startsWith("uptempo 220, sixteenth"))[1]);
  const beats = (TRACK_SECONDS - 6.5) * (220 / 60);
  assert.ok(rolled.mains.length > beats * 0.9 && rolled.mains.length < beats * 1.05, `${rolled.mains.length} main kicks against ${beats.toFixed(0)} beats`);
  assert.ok(rolled.rolls.length > beats * 0.5, `only ${rolled.rolls.length} roll notes`);
  const straight = runRecord(HARD.find(([n]) => n === "frenchcore 200")[1]);
  assert.ok(straight.rolls.length <= 2, `a straight pattern produced ${straight.rolls.length} roll notes`);
});

test("a lead in the kick's register, a hi-hat and a hoover are not kicks", () => {
  // The JavaScript detector read a 320 Hz stab on the sixteenths at 3.2
  // detections per kick and could not be taught otherwise from one frame;
  // measured here, 1.00 — the time-domain detector hears the pitch SWEEP a
  // kick has and a stab does not. A closed hat (it read 2.0) and a hoover
  // above the kick: 1.00 each.
  for (const [name, opts] of [
    ["a 320 Hz stab on the sixteenths", { bpm: 200, kickOpt: KICKS.frenchcore, screechAt: () => [0.25, 0.5, 0.75], screechOpt: { f: 320, lenMs: 55, gain: 0.6 }, seed: 200 }],
    ["a closed hi-hat on every offbeat", { bpm: 128, kickOpt: KICKS.techno, hats: 1.6, seed: 128 }],
    ["a hoover above the kick's register", { bpm: 200, kickOpt: KICKS.frenchcore, screechAt: () => [0.5], screechOpt: { f: 800, lenMs: 95, gain: 0.7 }, seed: 200 }],
  ]) {
    const f = fidelity(runRecord(opts));
    assert.ok(f.perKick > 0.95 && f.perKick < 1.05, `${name}: ${f.perKick.toFixed(2)} detections per kick`);
  }
});

test("the drop is found, once, and a track with none has none", () => {
  // Frenchcore with the kick out from 22 to 32 s and back. Measured: one
  // drop; the same track with no breakdown, none.
  const r = runRecord({ bpm: 200, seconds: 46, intro: 5, breakAt: [22, 32], kickOpt: KICKS.frenchcore, jitterMs: 4, ampJitter: 0.4, padGain: 0.05, seed: 200 });
  assert.equal(r.drops, 1, `${r.drops} drops in a track with one breakdown`);
  assert.equal(runRecord(HARD.find(([n]) => n === "frenchcore 200")[1]).drops, 0);
});

// --- arranged records ------------------------------------------------------------------------------

test("on arranged hard-dance records, the beats, the tempo and the drops are right", () => {
  // Whole arrangements from test/songs.mjs (intro, build, drop, breakdown,
  // build, drop), seeded as the server seeds them. Measured: beats F@70ms
  // 1.00 on all six, tempo right 100% of the time, every drop found with no
  // false one (frenchcore and uptempo also flag the start of a build whose
  // first kick lands loud after the breakdown: one each).
  for (const id of ["rawstyle-155", "frenchcore-200", "uptempo-220", "zaag-190", "krach-210", "techno-132"]) {
    const { pcm, truth } = loadSong(SONG_BY_ID.get(id));
    const rec = { beats: [], downbeats: [], kicks: [], mains: [], drops: [], bpm: [], breakdown: [], build: [], dt: 0 };
    const r = analyser({ genre: truth.genre });
    rec.dt = r.hop / SR;
    drive(
      r,
      pcm,
      (t, get) => {
        if (get("beat")) {
          rec.beats.push(t);
          if (get("downbeat")) rec.downbeats.push(t);
        }
        if (get("kickHit")) rec.kicks.push(t);
        if (get("mainKick")) rec.mains.push(t);
        if (get("drop")) rec.drops.push(t);
        if (get("locked")) rec.bpm.push([t, get("bpm")]);
        rec.breakdown.push(get("breakdown"));
        rec.build.push(get("build"));
      },
      { seed: truth.bpm, quantum: 4096 }
    );
    const s = score(rec, truth);
    assert.ok(s.F70 > 0.94, `${id}: beats F70 ${s.F70.toFixed(2)}`);
    assert.ok(s.tempo > 0.95, `${id}: tempo right ${(s.tempo * 100) | 0}% of the time`);
    const [found, of] = s.drops.split("/").map(Number);
    assert.equal(found, of, `${id}: drops ${s.drops}`);
    assert.ok(s.falseDrops <= 1, `${id}: ${s.falseDrops} false drops`);
  }
});

// --- the cost ---------------------------------------------------------------------------------------

test("the analyser keeps up with real time with room to spare", () => {
  // It runs on the audio thread, inside a render quantum. Measured in Node:
  // 30 s of frenchcore in 0.33-0.45 s — 1.1-1.5% of real time, 119-151 us a
  // frame (SIMD / baseline). The bound is loose on purpose (a slow CI box),
  // and still catches anything that turned a loop quadratic.
  const { pcm } = renderTrack({ seconds: 30, bpm: 200, kickOpt: KICKS.frenchcore, padGain: 0.05 });
  const r = analyser();
  const t0 = performance.now();
  drive(r, pcm, () => {});
  const share = (performance.now() - t0) / 30000;
  assert.ok(share < 0.1, `30 s of audio took ${(share * 100).toFixed(1)}% of real time`);
});
