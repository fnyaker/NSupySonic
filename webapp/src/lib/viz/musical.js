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
//   m.mainKick  the frame a MAIN kick lands — not a roll note (pattern.js)
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

import { approach, clamp, envelope } from "./util.js";

// Where a tempo-locked value goes when there is no tempo yet. Not a "default
// speed": it is one guess, used in one place, and everything derived from it
// re-times the instant the tracker locks.
const FALLBACK_BPM = 124;
const FALLBACK_BEAT = 60 / FALLBACK_BPM;
// How fast the clock is pulled onto the tracker's grid, in seconds. Fast enough
// that a re-lock is caught within a beat, slow enough that the correction is
// never visible as a lurch.
const CORRECT_TAU = 0.12;
// The clock never runs slower than this share of its tempo while it is being
// corrected — pulled back, never stopped.
const MIN_ADVANCE = 0.3;

// The secondary drum events. Each is a spike of its own band's flux against a
// slow average of it, with a refractory period in BEATS so a roll of
// sixteenths reads as sixteenths at any tempo.
const SNARE = { rise: 1.8, floor: 0.004, avgBeats: 2, gapBeats: 0.42 };
const HAT = { rise: 1.6, floor: 0.002, avgBeats: 1, gapBeats: 0.2 };
const NOTE = { rise: 1.7, floor: 0.002, avgBeats: 2, gapBeats: 0.24 };
const CHORD = { on: 0.3, gapBeats: 1 };
const NEVER = -1e9;

export function createMusical() {
  let beats = 0;
  let bars = 0;
  let phrases = 0;
  let drive = 0.3;
  let weight = 0.4;
  let air = 0.3;
  let tension = 0;
  let calm = 0.5;
  let attack = 0;
  let lastBeatIndex = -1;
  let barsSinceKick = 0;
  let midAvg = 0;
  let highAvg = 0;
  let noteAvg = 0;
  let chordWas = 0;

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
    // --- the MUSICAL reading (lib/audio/pattern.js) --------------------------
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
      return bars * turns * Math.PI * 2;
    },
    /** The same, per phrase — for things that should move once a section. */
    slowSweep(turns = 1) {
      return phrases * turns * Math.PI * 2;
    },
    /** The same, per beat — for things that should step with the kick. */
    fastSweep(turns = 1) {
      return beats * turns * Math.PI * 2;
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
      return beats - stamp;
    },

    update(frame, dt) {
      const f = frame.features || {};
      const b = frame.beat || {};
      const e = frame.energy;
      const look = frame.style?.look;

      // --- the grid ---------------------------------------------------------
      // `period` is the tracker's, and it is trusted only while it is locked:
      // an unlocked period is whatever the autocorrelation last guessed and
      // re-timing the whole picture to it would be worse than the fallback.
      const period = b.locked && b.period > 0.15 && b.period < 2 ? b.period : FALLBACK_BEAT;
      const bpb = Math.max(2, b.beatsPerBar || 4);
      m.beat = period;
      m.bar = period * bpb;
      m.phrase = m.bar * 4;
      m.beatsPerBar = bpb;
      m.bpm = b.bpm || 0;
      m.locked = !!b.locked;

      const prevPhrasePhase = m.phrasePhase;
      m.beatPhase = clamp(b.phase ?? 0, 0, 1);
      const idx = b.beatIndex || 0;
      m.barPhase = (((b.barPos || 0) + m.beatPhase) / bpb) % 1;
      m.phrasePhase = ((((idx % (bpb * 4)) + m.beatPhase) / (bpb * 4)) % 1 + 1) % 1;
      m.onBeat = !!b.beat && idx !== lastBeatIndex;
      if (m.onBeat) lastBeatIndex = idx;
      m.onBar = m.onBeat && !!b.downbeat;
      // A phrase turns over when its phase wraps, which is robust to a dropped
      // frame in a way that counting downbeats is not.
      m.onPhrase = m.phrasePhase < prevPhrasePhase;

      // --- the clock ----------------------------------------------------------
      const adv = dt / m.beat;
      let next = beats + adv;
      if (m.locked) {
        // Pull onto the tracker's grid. The integer part is whichever beat is
        // NEAREST, so a track change (the tracker's index resets) or a re-lock
        // becomes a sub-beat phase correction rather than a jump of hundreds.
        const tgt = idx + m.beatPhase;
        const err = tgt + Math.round(next - tgt) - next;
        next += err * (1 - Math.exp(-dt / CORRECT_TAU));
      }
      next = Math.max(beats + adv * MIN_ADVANCE, next);
      const step = next - beats;
      beats = next;
      bars += step / bpb;
      phrases += step / (bpb * 4);
      m.beats = beats;
      m.bars = bars;
      m.phrases = phrases;
      m.beatIndex = idx;
      if (m.onBeat) {
        m.stamp.beat = beats;
        m.count.beat++;
      }
      if (m.onBar) {
        m.stamp.bar = beats;
        m.count.bar++;
        m.barIndex++;
      }

      // --- events -----------------------------------------------------------
      m.kick = f.kick || 0;
      m.hit = !!f.kickHit;
      // The musical layer is optional: the engine only runs it at rhythm level
      // and above. Without it every accepted kick is treated as a main one,
      // which is what a scene written before pattern.js already assumed.
      const pat = frame.pattern;
      m.mainKick = pat ? !!pat.mainKick : m.hit;
      m.mainPower = pat?.mainPower ?? (m.hit ? m.kick : m.mainPower);
      m.bigKick = !!pat?.bigKick;
      m.rollKick = !!pat?.rollKick;
      m.roll = pat?.roll ?? 0;
      m.rollDiv = pat?.rollDiv ?? 0;
      m.drop = !!pat?.drop;
      m.dropped = pat?.dropped ?? 0;
      m.sinceDrop = pat?.sinceDrop ?? 999;
      m.build = pat?.build ?? 0;
      m.breakdown = pat?.breakdown ?? 0;
      m.note = f.melodyFlux || 0;
      m.chord = f.chordChange || 0;
      m.onset = b.onset || 0;
      if (m.hit) {
        m.stamp.kick = beats;
        m.count.kick++;
      }
      if (m.mainKick) {
        m.stamp.main = beats;
        m.count.main++;
      }
      if (m.bigKick) m.stamp.big = beats;
      if (m.rollKick) m.stamp.roll = beats;
      if (m.drop) {
        m.stamp.drop = beats;
        m.count.drop++;
      }

      // The snare, the hats, the notes: a spike of the band's own flux over a
      // slow average of it. Each with a refractory period in beats, and the
      // snare refuses a frame the kick detector already claimed — a kick moves
      // the mids too, and "the snare fired on every kick" is the one failure
      // that makes a backbeat animation pointless.
      const mid = f.midFlux || 0;
      const high = f.highFlux || 0;
      const nt = f.melodyFlux || 0;
      m.snareHit =
        !m.hit &&
        mid > SNARE.floor &&
        mid > midAvg * SNARE.rise &&
        beats - m.stamp.snare > SNARE.gapBeats;
      m.hatHit = high > HAT.floor && high > highAvg * HAT.rise && beats - m.stamp.hat > HAT.gapBeats;
      m.noteHit = nt > NOTE.floor && nt > noteAvg * NOTE.rise && beats - m.stamp.note > NOTE.gapBeats;
      midAvg = m.ease(midAvg, mid, SNARE.avgBeats, dt);
      highAvg = m.ease(highAvg, high, HAT.avgBeats, dt);
      noteAvg = m.ease(noteAvg, nt, NOTE.avgBeats, dt);
      if (m.snareHit) {
        m.stamp.snare = beats;
        m.count.snare++;
      }
      if (m.hatHit) m.stamp.hat = beats;
      if (m.noteHit) m.stamp.note = beats;
      if (m.chord > CHORD.on && chordWas <= CHORD.on && beats - m.stamp.chord > CHORD.gapBeats)
        m.stamp.chord = beats;
      chordWas = m.chord;

      // A flash envelope: up in a fiftieth of a beat, down over a quarter of
      // one. Both in beats, so a flash is a musical length and not 120 ms.
      attack = envelope(
        attack,
        clamp(Math.max(m.kick, m.onset) * 1.1, 0, 1),
        dt,
        m.beat * 0.02,
        m.beat * 0.25
      );
      m.attack = attack;

      // --- shape ------------------------------------------------------------
      const level = f.level || 0;
      const dyn = f.dynamics ?? 1;
      m.level = level;
      m.dynamics = dyn;

      // How hard it is pushing. Percussivity is in there because a wall of
      // sustained noise at the same level is not the same thing as a beat.
      const push = clamp(level * (0.45 + (f.percussivity || 0) * 0.9) * dyn * 1.25, 0, 1);
      drive = m.ease(drive, push, 1.5, dt);
      m.drive = drive;

      if (e) {
        const total = e.sub + e.bass + e.lowMid + e.mid + e.high + e.air + 1e-12;
        weight = m.ease(weight, clamp(((e.sub + e.bass) / total) * 2.4, 0, 1), 2, dt);
      }
      m.weight = weight;
      air = m.ease(air, clamp(f.centroidN || 0, 0, 1), 2, dt);
      m.air = air;

      // A BUILD is the one thing worth detecting that no single feature names:
      // the level climbing and the spectrum opening while the drums thin out.
      // Counted in bars, because a riser is a musical span — eight bars of it
      // is a build, half a second of it is a fill.
      if (m.onBar) barsSinceKick = m.kick > 0.25 ? 0 : barsSinceKick + 1;
      const thinning = clamp(barsSinceKick / 3, 0, 1);
      const rising = clamp((level - 0.25) * 1.6, 0, 1) * clamp(air * 1.4, 0, 1);
      // pattern.js has its own, better-informed reading of a build; take
      // whichever is stronger so neither can hide the other.
      tension = m.ease(tension, Math.max(thinning * rising, m.build), 2, dt);
      m.tension = tension;

      // ...and its opposite, deliberately asymmetric: calm arrives slowly and
      // leaves instantly, because a drop should not have to wait for it.
      const quiet = 1 - clamp(drive * 1.3, 0, 1);
      calm = quiet > calm ? m.ease(calm, quiet, 6, dt) : m.ease(calm, quiet, 0.4, dt);
      m.calm = calm;

      // --- the look vector, blended so a scene never has to ------------------
      if (look) {
        m.motion = m.ease(m.motion, look.motion, 3, dt);
        m.density = m.ease(m.density, look.density, 3, dt);
        m.punch = m.ease(m.punch, look.punch, 3, dt);
        m.smooth = m.ease(m.smooth, look.smooth, 3, dt);
        m.warm = m.ease(m.warm, look.warm, 3, dt);
        m.melodic = m.ease(m.melodic, look.melodic, 3, dt);
        m.chaos = m.ease(m.chaos, look.chaos, 3, dt);
      }
      return m;
    },
  };
  return m;
}
