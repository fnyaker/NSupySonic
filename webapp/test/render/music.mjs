// A synthetic ARRANGEMENT, frame by frame, in the exact shape the analysis
// engine publishes (lib/audio/engine.js `frame`): bands, energies, features,
// the beat grid, the musical pattern and the style verdict.
//
// It is what the render bench and the node tests drive the worlds with, and it
// is written as a TRACK rather than as a signal on purpose. The questions a
// world has to answer are musical ones — does the drop land, does the
// breakdown settle, does the build build, does the picture move twice as fast
// at twice the tempo — and they can only be asked of material that has a drop,
// a breakdown and a build in it. A sine with a kick on it has none of those.
//
// The structure is the one every genre this player is pointed at is written
// in: an intro, an eight-bar build that ends in a roll, a sixteen-bar drop, an
// eight-bar breakdown with the drums out and the melody up front, a short
// second build, and the drop again. `moments` names the instants worth
// photographing.
//
// The scales follow what the real extractor produces (features.js): bands in
// 0..1 of the display range, energies as linear power, fluxes as the small
// per-bin averages they are, `kick` as a 0..1 envelope. Deterministic: the same
// arguments always give the same track.

import { familyLook, FAMILY_LIST, LOOK_KEYS } from "../../src/lib/audio/style.js";

export const SECTIONS = [
  { name: "intro", bars: 4, level: 0.5, kick: 0.7, hats: 0.6, melody: 0.15, snare: 0, pad: 0.3 },
  { name: "build", bars: 8, level: 0.35, kick: 0, hats: 0.8, melody: 0.35, snare: 0.6, pad: 0.4, ramp: true },
  { name: "drop", bars: 16, level: 0.88, kick: 1, hats: 0.8, melody: 0.7, snare: 1, pad: 0.3 },
  { name: "breakdown", bars: 8, level: 0.3, kick: 0, hats: 0.15, melody: 0.9, snare: 0, pad: 0.9 },
  { name: "build2", bars: 4, level: 0.4, kick: 0, hats: 0.9, melody: 0.5, snare: 0.8, pad: 0.5, ramp: true },
  { name: "drop2", bars: 16, level: 0.9, kick: 1, hats: 0.85, melody: 0.75, snare: 1, pad: 0.3 },
];

const BAR_STARTS = [];
{
  let b = 0;
  for (const s of SECTIONS) {
    BAR_STARTS.push(b);
    b += s.bars;
  }
}
export const TOTAL_BARS = SECTIONS.reduce((a, s) => a + s.bars, 0);

function sectionAtBar(bar) {
  for (let i = SECTIONS.length - 1; i >= 0; i--) if (bar >= BAR_STARTS[i]) return i;
  return 0;
}

/** The instants worth a picture, in seconds, for a given tempo. */
export function moments(bpm) {
  const beat = 60 / bpm;
  const bar = beat * 4;
  const at = (name) => BAR_STARTS[SECTIONS.findIndex((s) => s.name === name)] * bar;
  return {
    // Mid-breakdown, just after a beat: the quiet picture.
    breakdown: at("breakdown") + 4 * bar + beat * 0.12,
    // Three quarters into the second build: tension.
    build: at("build2") + 3 * bar + beat * 1.5,
    // Two bars into the second drop, one tick after a MAIN kick on a downbeat.
    drop: at("drop2") + 2 * bar + beat * 0.06,
    // ...and half a beat later: the picture between two hits.
    dropOff: at("drop2") + 2 * bar + beat * 0.55,
    // The very instant the drop lands, and a beat after it.
    impact: at("drop2") + beat * 0.08,
    afterImpact: at("drop2") + beat * 1.1,
    // The whole piece.
    end: TOTAL_BARS * bar,
  };
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// The chord progression, as pitch-class sets: i - VI - III - VII in A minor.
const CHORDS = [
  [9, 0, 4],
  [5, 9, 0],
  [0, 4, 7],
  [7, 11, 2],
];

/**
 * Build a track. `genre` is any skin id or family; `loud` scales the whole
 * thing (0.12 is a whisper, for "does the breakdown look like a breakdown").
 */
export function createTrack({ bpm = 128, genre = "techno", archetype = null, loud = 1, seed = 7 } = {}) {
  const beat = 60 / bpm;
  const rand = rng(seed);
  const fam = FAMILY_LIST.find((f) => f.id === genre);
  const arche = archetype || fam?.archetype || "groove";
  const look = {};
  const known = familyLook(genre);
  for (const k of LOOK_KEYS) look[k] = known ? known[k] : 0.5;

  const bands = new Float32Array(120);
  const chroma = new Float32Array(12);
  const energy = { sub: 0, bass: 0, lowMid: 0, mid: 0, high: 0, air: 0 };
  const features = {
    level: 0, levelDb: -30, peak: 0, crest: 3, dynamics: 1, flux: 0, lowFlux: 0,
    midFlux: 0, highFlux: 0, kick: 0, kickHit: false, centroid: 1500, centroidN: 0.4,
    flatness: 0.3, rolloff: 4000, rolloffN: 0.4, percussivity: 0.5, vocalMod: 0.2,
    tonal: 0.4, melody: 0.5, melodyPitch: 0.5, melodyFlux: 0, chordChange: 0,
    silent: false, chroma,
  };
  const beatObj = {
    bpm, confidence: 0.9, phase: 0, beat: false, beatIndex: 0, barPos: 0,
    beatsPerBar: 4, downbeat: false, onset: 0, kickPulse: 0, sinceBeat: 0,
    period: beat, locked: false,
  };
  const pattern = {
    mainKick: false, mainPower: 0, bigKick: false, rollKick: false, roll: 0,
    rollDiv: 0, rollNotes: 0, drop: false, sinceDrop: 999, dropped: 0,
    breakdown: 0, build: 0, energy: 1,
  };
  const archetypes = { sustain: 0, voice: 0, groove: 0, hard: 0, rock: 0 };
  archetypes[arche] = 0.85;
  const style = {
    archetypes, look, dominant: genre, dominantLabel: fam?.label || genre,
    archetype: arche, confidence: 0.88,
    kick: { type: arche === "hard" ? "hard" : "soft", strength: 0.8, decay: 0.12, hit: false },
    families: [],
  };
  const frame = {
    t: 0, dt: 1 / 94, bands, bandsDb: bands, energy, features, beat: beatObj,
    pattern, style, wave: null, silent: false, level: 2,
  };

  let lastIdx = -1;
  let lastSix = -1;
  let lastEighth = -1;
  let kickEnv = 0;
  let kickAmp = 0;
  let snareEnv = 0;
  let hatEnv = 0;
  let noteEnv = 0;
  let lastT = -1;
  let prevSection = -1;
  let dropAt = -1e9;
  let levelSm = 0.4;

  function frameAt(t) {
    const dt = lastT < 0 ? 1 / 94 : Math.max(1e-4, t - lastT);
    lastT = t;
    frame.t = t;
    frame.dt = dt;
    const pos = t / beat;
    const idx = Math.floor(pos);
    const phase = pos - idx;
    const bar = Math.floor(idx / 4);
    const barPos = idx % 4;
    const si = sectionAtBar(bar % TOTAL_BARS);
    const sec = SECTIONS[si];
    const inSec = (bar % TOTAL_BARS) - BAR_STARTS[si];
    const secProg = (inSec + (barPos + phase) / 4) / sec.bars;
    const isBeat = idx !== lastIdx;
    lastIdx = idx;

    // --- the grid ---
    beatObj.phase = phase;
    beatObj.beat = isBeat && t > 1.5;
    beatObj.beatIndex = idx;
    beatObj.barPos = barPos;
    beatObj.downbeat = beatObj.beat && barPos === 0;
    beatObj.sinceBeat = phase * beat;
    beatObj.locked = t > 1.5;

    // --- the arrangement ---
    const ramp = sec.ramp ? secProg : 1;
    let level = sec.ramp ? sec.level + (0.8 - sec.level) * secProg : sec.level;
    level *= loud;
    const drop = si !== prevSection && sec.name.startsWith("drop");
    if (drop) dropAt = t;
    prevSection = si;

    // Kicks: every beat where the section has them; the last bar of a build
    // is a sixteenth-note roll, which is what separates a roll from a pattern.
    const six = Math.floor(pos * 4);
    const newSix = six !== lastSix;
    lastSix = six;
    const lastBar = sec.ramp && inSec === sec.bars - 1;
    let hit = false;
    let main = false;
    let roll = false;
    if (sec.kick > 0 && isBeat) {
      hit = main = true;
      kickAmp = sec.kick * loud;
    } else if (lastBar && newSix) {
      hit = roll = true;
      kickAmp = (0.5 + 0.4 * ((six % 16) / 16)) * loud;
    }
    if (hit) kickEnv = kickAmp;
    kickEnv *= Math.exp(-dt / (beat * 0.14));
    features.kick = kickEnv;
    features.kickHit = hit;
    style.kick.hit = hit;

    // Snare / clap on 2 and 4.
    if (isBeat && (barPos === 1 || barPos === 3) && sec.snare > 0) snareEnv = sec.snare * loud;
    snareEnv *= Math.exp(-dt / (beat * 0.1));
    // Hats on the off-beats.
    const eighth = Math.floor(pos * 2);
    const newEighth = eighth !== lastEighth;
    lastEighth = eighth;
    if (newEighth && eighth % 2 === 1 && sec.hats > 0) hatEnv = sec.hats * loud;
    hatEnv *= Math.exp(-dt / (beat * 0.06));
    // Melody: eighth notes, the pitch walking the chord.
    if (newEighth && sec.melody > 0 && rand() < 0.8) noteEnv = sec.melody * loud;
    noteEnv *= Math.exp(-dt / (beat * 0.12));
    const chord = CHORDS[Math.floor(bar / 2) % CHORDS.length];
    const note = chord[eighth % 3];
    features.melodyPitch = 0.3 + (note / 12) * 0.5;
    features.melody = sec.melody;
    features.melodyFlux = noteEnv * 0.03;
    features.chordChange = (bar % 2 === 0 && barPos === 0 && phase < 0.4 ? 0.7 : 0.05) * sec.melody;
    chroma.fill(0.08);
    for (const c of chord) chroma[c] = 0.5 + 0.5 * sec.pad;
    chroma[note] = Math.min(1, chroma[note] + noteEnv);

    levelSm += (level - levelSm) * Math.min(1, dt / 0.3);
    features.level = levelSm;
    features.levelDb = 20 * Math.log10(Math.max(1e-4, levelSm));
    features.dynamics = Math.min(1.2, levelSm / 0.85);
    features.percussivity = sec.kick * 0.8 + sec.hats * 0.15;
    features.midFlux = snareEnv * 0.03 + noteEnv * 0.004;
    features.highFlux = hatEnv * 0.02 + snareEnv * 0.006;
    features.lowFlux = kickEnv * 0.05;
    features.flux = kickEnv * 0.04 + hatEnv * 0.01 + snareEnv * 0.02;
    features.centroidN = 0.35 + 0.3 * (sec.ramp ? ramp : 0.3) + 0.1 * hatEnv;
    features.tonal = 0.3 + 0.5 * sec.pad;
    features.vocalMod = 0.15 + 0.2 * sec.melody;
    beatObj.onset = hit ? kickAmp : snareEnv > 0.9 ? 0.6 : 0;
    beatObj.kickPulse = kickEnv;

    // --- the spectrum ---
    const pitchBand = 38 + note * 2.4;
    for (let i = 0; i < 120; i++) {
      const f = i / 119;
      let v = (0.62 - 0.38 * f) * levelSm;
      v += kickEnv * Math.exp(-f * 13) * 0.6;
      v += sec.pad * loud * 0.18 * Math.exp(-((i - 55) * (i - 55)) / 900);
      v += noteEnv * 0.35 * Math.exp(-((i - pitchBand) * (i - pitchBand)) / 6);
      v += hatEnv * 0.3 * Math.max(0, f - 0.7) * 3;
      v += snareEnv * 0.25 * Math.exp(-((i - 70) * (i - 70)) / 400);
      v += (rand() - 0.5) * 0.04 * levelSm;
      bands[i] = Math.max(0, Math.min(1, v));
    }
    const pw = (a, b) => {
      let s = 0;
      for (let i = a; i < b; i++) s += bands[i] * bands[i];
      return s / (b - a);
    };
    energy.sub = pw(0, 10);
    energy.bass = pw(10, 24);
    energy.lowMid = pw(24, 44);
    energy.mid = pw(44, 72);
    energy.high = pw(72, 100);
    energy.air = pw(100, 120);

    // --- the pattern ---
    pattern.mainKick = main;
    pattern.mainPower = main ? kickAmp : pattern.mainPower;
    pattern.bigKick = main && barPos === 0;
    pattern.rollKick = roll;
    pattern.roll = lastBar ? 1 : Math.max(0, pattern.roll - dt * 2);
    pattern.rollDiv = lastBar ? 4 : 0;
    pattern.rollNotes = lastBar ? six % 16 : 0;
    pattern.drop = drop;
    pattern.sinceDrop = t - dropAt;
    pattern.dropped = Math.exp(-(t - dropAt) / 6);
    pattern.breakdown = sec.name === "breakdown" ? Math.min(1, inSec / 2 + 0.3) : 0;
    pattern.build = sec.ramp ? ramp : 0;
    pattern.energy = levelSm;
    return frame;
  }

  return { frameAt, beat, bpm, moments: moments(bpm) };
}
