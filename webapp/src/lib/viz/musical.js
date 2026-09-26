// The layer that makes a constant illegal.
//
// Every animation used to be full of numbers that knew nothing about the
// music: `spin += dt * 0.05`, `if (s.age > 3.4)`. A scene written that way
// turns at the same rate through a 90 BPM intro and a 200 BPM drop, holds a
// trail for the same 3.4 seconds whether that is half a bar or six, and has
// exactly one character however the track moves underneath it. That is the
// difference between an animation that is PLAYING THE TRACK and one that is
// merely running while the track happens.
//
// So nothing downstream expresses a duration in seconds or a rate in "per
// second". The vocabulary is:
//
//   m.beat / m.bar / m.phrase     how long those are, right now, in seconds
//   m.beats / m.bars / m.phrases  CLOCKS: how many have elapsed, continuous
//   m.overBeats(n)                a lifetime: n beats, whatever that is today
//   m.perBeat(n)                  a rate: n cycles per beat, in cycles/second
//   m.beatPhase / barPhase        where we are inside one, 0..1
//   m.sweep(n)                    an ever-rising angle at n turns per bar
//   m.stamp.kick / .main / ...    WHEN an event happened, on the beat clock
//
// ...and the SHAPE of the moment, each 0..1 and each smoothed over a musically
// sensible span rather than an arbitrary one:
//
//   m.mainKick  the frame a MAIN kick lands — not a roll note (rhythm/src/pattern.rs)
//   m.bigKick   ...and one that is big for this track
//   m.roll      0..1, how much of a roll is going on; m.rollDiv, its subdivision
//   m.drop      the frame the arrangement comes back; m.dropped decays from it
//   m.build / m.breakdown   where in the arrangement we are
//   m.drive     how hard the track is pushing (level x percussivity x dynamics)
//   m.weight    how much of it is low end
//   m.air       how bright it is
//   m.tension   a build: rising, brightening, and the drums thinning out
//   m.calm      the opposite, slow to arrive and slow to leave
//
// THE BEAT CLOCK IS THE SPINE OF THE GL ENGINE. The shaders are given no
// wall-clock time at all (lib/viz/gl/glsl.js), only this clock and the stamps
// on it, so every rate on screen is a rate per beat by construction. It is
// monotonic — a picture that runs backwards for a frame is a glitch nobody
// forgives — and PHASE-LOCKED: while the tracker holds the grid, the clock is
// slewed toward its beat index, so `fract(beats)` is on the beat instead of
// drifting away from it the way a free integral of dt/beat does. It never
// jumps: a correction is spread over CORRECT_TAU and can slow the clock down
// but never make it stand still or go back.
//
// THE READING IS RUST (webapp/rhythm/src/viz_motion.rs), ported rule for rule
// from the JavaScript this file used to be — which is kept, unchanged, as the
// oracle test/vizcore.test.mjs holds it to (test/reference/musical.js). What
// is left here is the object the worlds read: the same `m`, the same `stamp`,
// `count` and `genre` objects for its whole life, refreshed in place after
// every analysis frame, and the helpers that turn beats into seconds.

import { approach } from "./util.js";
import { SceneCore, vizCore } from "./core.js";

// The orders viz_motion.rs keeps its look and genre channel in (as are the
// stamps — kick, main, big, roll, snare, hat, note, chord, drop, bar, beat —
// and the counts — kick, main, snare, drop, bar, beat — written out in `pull`).
export const LOOK_ORDER = ["motion", "density", "punch", "smooth", "warm", "melodic", "chaos"];
export const GENRE_ORDER = ["lead", "buzz", "screech", "sub", "offbeat", "density", "tail", "grit"];
// Where a tempo-locked value goes when there is no tempo yet (the Rust holds
// the same number): one guess, re-timed the instant the tracker locks.
const FALLBACK_BEAT = 60 / 124;
const NEVER = -1e9;
const NONE = {};

/**
 * The reading bound to one scene core: `m` (what the worlds read), `write`
 * (an analysis frame into the core's input) and `pull` (the core's output back
 * into `m`, in place). scenes/gl.js drives the two halves itself, around the
 * rest of the frame's arithmetic; everyone else calls `m.update`.
 */
export function bindMusical(sc) {
  const I = sc.L.in;
  const O = sc.L.out;
  const iLocked = I.I_LOCKED, iPeriod = I.I_PERIOD, iBpb = I.I_BPB, iBpm = I.I_BPM, iPhase = I.I_PHASE;
  const iBeatIndex = I.I_BEAT_INDEX, iBarPos = I.I_BAR_POS, iBeat = I.I_BEAT, iDownbeat = I.I_DOWNBEAT;
  const iOnset = I.I_ONSET, iKick = I.I_KICK, iKickHit = I.I_KICK_HIT, iLevel = I.I_LEVEL;
  const iDynamics = I.I_DYNAMICS, iPerc = I.I_PERCUSSIVITY, iCentroid = I.I_CENTROID_N;
  const iMidFlux = I.I_MID_FLUX, iHighFlux = I.I_HIGH_FLUX, iMelodyFlux = I.I_MELODY_FLUX;
  const iChord = I.I_CHORD_CHANGE, iHasPattern = I.I_HAS_PATTERN, iMainKick = I.I_MAIN_KICK;
  const iMainPower = I.I_MAIN_POWER, iHasMainPower = I.I_HAS_MAIN_POWER, iBigKick = I.I_BIG_KICK;
  const iRollKick = I.I_ROLL_KICK, iRoll = I.I_ROLL, iRollDiv = I.I_ROLL_DIV, iDrop = I.I_DROP;
  const iDropped = I.I_DROPPED, iSinceDrop = I.I_SINCE_DROP, iBuild = I.I_BUILD, iBreakdown = I.I_BREAKDOWN;
  const iHasEnergy = I.I_HAS_ENERGY, iEnergy = I.I_ENERGY, iHasLook = I.I_HAS_LOOK, iLook = I.I_LOOK;
  const iHasGenre = I.I_HAS_GENRE, iGenre = I.I_GENRE;
  const oStamp = O.O_STAMP, oCount = O.O_COUNT, oLook = O.O_LOOK, oGenre = O.O_GENRE;

  const m = {
    // --- time ---------------------------------------------------------------
    beat: FALLBACK_BEAT,
    bar: FALLBACK_BEAT * 4,
    phrase: FALLBACK_BEAT * 16,
    beatsPerBar: 4,
    beatPhase: 0,
    barPhase: 0,
    phrasePhase: 0,
    bpm: 0,
    locked: false,
    // The clocks: continuous, monotonic, beats / bars / phrases elapsed.
    beats: 0,
    bars: 0,
    phrases: 0,
    // True on the frame a beat / a bar / a phrase begins.
    onBeat: false,
    onBar: false,
    onPhrase: false,
    beatIndex: 0,
    barIndex: 0,
    // --- events -------------------------------------------------------------
    kick: 0, // 0..1, how hard, now
    hit: false, // the frame a kick was accepted
    note: 0, // a melodic attack, not a drum
    chord: 0, // harmony moving
    onset: 0,
    snareHit: false,
    hatHit: false,
    noteHit: false,
    // When each event last happened, on the beat clock. A world's envelope is
    // `exp(-(beats - stamp) / decay)`, computed wherever it is needed — so it is
    // exact at any frame rate and needs no state of its own.
    stamp: {
      kick: NEVER, main: NEVER, big: NEVER, roll: NEVER, snare: NEVER, hat: NEVER,
      note: NEVER, chord: NEVER, drop: NEVER, bar: NEVER, beat: NEVER,
    },
    // How many, so far — for per-event variety that is stable for the life of
    // the event (a world hashes the count).
    count: { kick: 0, main: 0, snare: 0, drop: 0, bar: 0, beat: 0 },
    // --- the MUSICAL reading (webapp/rhythm/src/pattern.rs) -------------------
    mainKick: false,
    mainPower: 0,
    bigKick: false,
    rollKick: false,
    roll: 0,
    rollDiv: 0,
    drop: false,
    dropped: 0,
    sinceDrop: 999,
    build: 0,
    breakdown: 0,
    // --- shape --------------------------------------------------------------
    drive: 0.3,
    weight: 0.4,
    air: 0.3,
    tension: 0,
    calm: 0.5,
    attack: 0,
    dynamics: 1,
    level: 0,
    // --- look, already resolved ---------------------------------------------
    motion: 0.6,
    density: 0.6,
    punch: 0.6,
    smooth: 0.5,
    warm: 0.5,
    melodic: 0.5,
    chaos: 0.4,
    // --- the GENRE CHANNEL (webapp/rhythm/src/genre.rs) ----------------------
    // What only some genres are made of, 0..1 each: the sung lead, the BUZZ
    // (a saw stack, a distorted kick's tail — zaag, krach), a screech, how
    // much of the power sits in the bottom two octaves, the offbeat's share of
    // the groove, onsets per beat, how long the kick rings and how noisy it
    // is. Eased over a beat, so a world can read them raw.
    genre: { lead: 0, buzz: 0, screech: 0, sub: 0, offbeat: 0, density: 0, tail: 0, grit: 0 },

    /** Seconds for `n` beats — a lifetime, a decay, a fade. */
    overBeats(n) {
      return n * m.beat;
    },
    /** Cycles per SECOND such that `n` cycles happen per beat. */
    perBeat(n) {
      return n / m.beat;
    },
    /** Cycles per second such that `n` cycles happen per bar. */
    perBar(n) {
      return n / m.bar;
    },
    /** An ever-rising angle, `turns` full turns per bar. */
    sweep(turns = 1) {
      return m.bars * turns * Math.PI * 2;
    },
    /** The same, per phrase — for things that should move once a section. */
    slowSweep(turns = 1) {
      return m.phrases * turns * Math.PI * 2;
    },
    /** The same, per beat — for things that should step with the kick. */
    fastSweep(turns = 1) {
      return m.beats * turns * Math.PI * 2;
    },
    /**
     * An exponential approach whose time constant is expressed in BEATS, so a
     * smoothing that feels right at 130 BPM still feels right at 200.
     */
    ease(current, target, nBeats, dt) {
      return approach(current, target, Math.max(0.001, nBeats * m.beat), dt);
    },
    /** Beats since a stamp, at the clock's current reading. */
    since(stamp) {
      return m.beats - stamp;
    },
    /** One analysis frame, `dt` seconds after the last. */
    update(frame, dt) {
      write(frame);
      sc.update(dt, 0, 0, 0, 0, 0, 1);
      pull();
      return m;
    },
  };

  // The analysis frame, flattened the way the Rust reads it. Every default
  // here is the one the JavaScript applied (`|| 0`, `?? 1`...), so a missing
  // field means exactly what it meant before.
  function write(frame) {
    const i = sc.input();
    const f = frame.features || NONE;
    const b = frame.beat || NONE;
    i[iLocked] = b.locked ? 1 : 0;
    i[iPeriod] = +b.period || 0;
    i[iBpb] = b.beatsPerBar || 0;
    i[iBpm] = b.bpm || 0;
    i[iPhase] = b.phase ?? 0;
    i[iBeatIndex] = b.beatIndex || 0;
    i[iBarPos] = b.barPos || 0;
    i[iBeat] = b.beat ? 1 : 0;
    i[iDownbeat] = b.downbeat ? 1 : 0;
    i[iOnset] = b.onset || 0;
    i[iKick] = f.kick || 0;
    i[iKickHit] = f.kickHit ? 1 : 0;
    i[iLevel] = f.level || 0;
    i[iDynamics] = f.dynamics ?? 1;
    i[iPerc] = f.percussivity || 0;
    i[iCentroid] = f.centroidN || 0;
    i[iMidFlux] = f.midFlux || 0;
    i[iHighFlux] = f.highFlux || 0;
    i[iMelodyFlux] = f.melodyFlux || 0;
    i[iChord] = f.chordChange || 0;
    const pat = frame.pattern;
    if (pat) {
      i[iHasPattern] = 1;
      i[iMainKick] = pat.mainKick ? 1 : 0;
      i[iHasMainPower] = pat.mainPower != null ? 1 : 0;
      i[iMainPower] = pat.mainPower ?? 0;
      i[iBigKick] = pat.bigKick ? 1 : 0;
      i[iRollKick] = pat.rollKick ? 1 : 0;
      i[iRoll] = pat.roll ?? 0;
      i[iRollDiv] = pat.rollDiv ?? 0;
      i[iDrop] = pat.drop ? 1 : 0;
      i[iDropped] = pat.dropped ?? 0;
      i[iSinceDrop] = pat.sinceDrop ?? 999;
      i[iBuild] = pat.build ?? 0;
      i[iBreakdown] = pat.breakdown ?? 0;
    } else i[iHasPattern] = 0;
    const e = frame.energy;
    if (e) {
      i[iHasEnergy] = 1;
      i[iEnergy] = e.sub;
      i[iEnergy + 1] = e.bass;
      i[iEnergy + 2] = e.lowMid;
      i[iEnergy + 3] = e.mid;
      i[iEnergy + 4] = e.high;
      i[iEnergy + 5] = e.air;
    } else i[iHasEnergy] = 0;
    // Named, not looped over a list of keys: a store through a computed key
    // is V8's slow path, and this runs ninety times a second (measured, the
    // looped version cost more than the whole reading in Rust).
    const look = frame.style?.look;
    if (look) {
      i[iHasLook] = 1;
      i[iLook] = look.motion;
      i[iLook + 1] = look.density;
      i[iLook + 2] = look.punch;
      i[iLook + 3] = look.smooth;
      i[iLook + 4] = look.warm;
      i[iLook + 5] = look.melodic;
      i[iLook + 6] = look.chaos;
    } else i[iHasLook] = 0;
    const g = frame.genre;
    if (g) {
      i[iHasGenre] = 1;
      i[iGenre] = g.lead || 0;
      i[iGenre + 1] = g.buzz || 0;
      i[iGenre + 2] = g.screech || 0;
      i[iGenre + 3] = g.sub || 0;
      i[iGenre + 4] = g.offbeat || 0;
      i[iGenre + 5] = g.density || 0;
      i[iGenre + 6] = g.tail || 0;
      i[iGenre + 7] = g.grit || 0;
    } else i[iHasGenre] = 0;
  }

  // The core's output back into `m`, in place. Every store names its field
  // (see `write`) and every index is a constant resolved once from the layout.
  const oBeat = O.O_BEAT, oBar = O.O_BAR, oPhrase = O.O_PHRASE, oBpb = O.O_BPB;
  const oBeatPhase = O.O_BEAT_PHASE, oBarPhase = O.O_BAR_PHASE, oPhrasePhase = O.O_PHRASE_PHASE;
  const oBpm = O.O_BPM, oLocked = O.O_LOCKED, oBeats = O.O_BEATS, oBars = O.O_BARS, oPhrases = O.O_PHRASES;
  const oOnBeat = O.O_ON_BEAT, oOnBar = O.O_ON_BAR, oOnPhrase = O.O_ON_PHRASE;
  const oBeatIndex = O.O_BEAT_INDEX, oBarIndex = O.O_BAR_INDEX, oKick = O.O_KICK, oHit = O.O_HIT;
  const oNote = O.O_NOTE, oChord = O.O_CHORD, oOnset = O.O_ONSET, oSnareHit = O.O_SNARE_HIT;
  const oHatHit = O.O_HAT_HIT, oNoteHit = O.O_NOTE_HIT, oMainKick = O.O_MAIN_KICK;
  const oMainPower = O.O_MAIN_POWER, oBigKick = O.O_BIG_KICK, oRollKick = O.O_ROLL_KICK;
  const oRoll = O.O_ROLL, oRollDiv = O.O_ROLL_DIV, oDrop = O.O_DROP, oDropped = O.O_DROPPED;
  const oSinceDrop = O.O_SINCE_DROP, oBuild = O.O_BUILD, oBreakdown = O.O_BREAKDOWN;
  const oDrive = O.O_DRIVE, oWeight = O.O_WEIGHT, oAir = O.O_AIR, oTension = O.O_TENSION;
  const oCalm = O.O_CALM, oAttack = O.O_ATTACK, oDynamics = O.O_DYNAMICS, oLevel = O.O_LEVEL;
  function pull() {
    const o = sc.output();
    m.beat = o[oBeat];
    m.bar = o[oBar];
    m.phrase = o[oPhrase];
    m.beatsPerBar = o[oBpb];
    m.beatPhase = o[oBeatPhase];
    m.barPhase = o[oBarPhase];
    m.phrasePhase = o[oPhrasePhase];
    m.bpm = o[oBpm];
    m.locked = o[oLocked] !== 0;
    m.beats = o[oBeats];
    m.bars = o[oBars];
    m.phrases = o[oPhrases];
    m.onBeat = o[oOnBeat] !== 0;
    m.onBar = o[oOnBar] !== 0;
    m.onPhrase = o[oOnPhrase] !== 0;
    m.beatIndex = o[oBeatIndex];
    m.barIndex = o[oBarIndex];
    m.kick = o[oKick];
    m.hit = o[oHit] !== 0;
    m.note = o[oNote];
    m.chord = o[oChord];
    m.onset = o[oOnset];
    m.snareHit = o[oSnareHit] !== 0;
    m.hatHit = o[oHatHit] !== 0;
    m.noteHit = o[oNoteHit] !== 0;
    const st = m.stamp;
    st.kick = o[oStamp];
    st.main = o[oStamp + 1];
    st.big = o[oStamp + 2];
    st.roll = o[oStamp + 3];
    st.snare = o[oStamp + 4];
    st.hat = o[oStamp + 5];
    st.note = o[oStamp + 6];
    st.chord = o[oStamp + 7];
    st.drop = o[oStamp + 8];
    st.bar = o[oStamp + 9];
    st.beat = o[oStamp + 10];
    const ct = m.count;
    ct.kick = o[oCount];
    ct.main = o[oCount + 1];
    ct.snare = o[oCount + 2];
    ct.drop = o[oCount + 3];
    ct.bar = o[oCount + 4];
    ct.beat = o[oCount + 5];
    m.mainKick = o[oMainKick] !== 0;
    m.mainPower = o[oMainPower];
    m.bigKick = o[oBigKick] !== 0;
    m.rollKick = o[oRollKick] !== 0;
    m.roll = o[oRoll];
    m.rollDiv = o[oRollDiv];
    m.drop = o[oDrop] !== 0;
    m.dropped = o[oDropped];
    m.sinceDrop = o[oSinceDrop];
    m.build = o[oBuild];
    m.breakdown = o[oBreakdown];
    m.drive = o[oDrive];
    m.weight = o[oWeight];
    m.air = o[oAir];
    m.tension = o[oTension];
    m.calm = o[oCalm];
    m.attack = o[oAttack];
    m.dynamics = o[oDynamics];
    m.level = o[oLevel];
    m.motion = o[oLook];
    m.density = o[oLook + 1];
    m.punch = o[oLook + 2];
    m.smooth = o[oLook + 3];
    m.warm = o[oLook + 4];
    m.melodic = o[oLook + 5];
    m.chaos = o[oLook + 6];
    const gch = m.genre;
    gch.lead = o[oGenre];
    gch.buzz = o[oGenre + 1];
    gch.screech = o[oGenre + 2];
    gch.sub = o[oGenre + 3];
    gch.offbeat = o[oGenre + 4];
    gch.density = o[oGenre + 5];
    gch.tail = o[oGenre + 6];
    gch.grit = o[oGenre + 7];
  }

  return { m, write, pull };
}

/**
 * A reading of its own — for a caller with no GL scene around it (the tests,
 * a bench). Needs the animation core loaded (lib/viz/core.js#loadVizCore).
 * `m.dispose()` gives its slot in the core back.
 */
export function createMusical(sc = null) {
  let own = null;
  if (!sc) {
    const core = vizCore();
    if (!core) throw new Error("musical: the animation core is not loaded");
    own = sc = new SceneCore(core);
  }
  const { m } = bindMusical(sc);
  m.dispose = () => own?.free();
  return m;
}
