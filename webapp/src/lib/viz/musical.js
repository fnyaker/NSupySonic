// The layer that makes a constant illegal.
//
// Every animation in here used to be full of numbers that knew nothing about
// the music: `spin += dt * 0.05`, `if (s.age > 3.4)`, `blur * 2.2`. A scene
// written that way turns at the same rate through a 90 BPM intro and a 200 BPM
// drop, holds a trail for the same 3.4 seconds whether that is half a bar or
// six, and has exactly one character however the track moves underneath it.
// That is the difference between an animation that is PLAYING THE TRACK and one
// that is merely running while the track happens.
//
// So nothing downstream is allowed to express a duration in seconds or a rate
// in "per second". The vocabulary is:
//
//   m.beat / m.bar / m.phrase     how long those are, right now, in seconds
//   m.overBeats(n)                a lifetime: n beats, whatever that is today
//   m.perBeat(n)                  a rate: n cycles per beat, in cycles/second
//   m.beatPhase / barPhase        where we are inside one, 0..1
//   m.sweep(n)                    an ever-rising angle at n turns per bar
//
// ...and the SHAPE of the moment, each 0..1 and each smoothed over a musically
// sensible span rather than an arbitrary one:
//
//   m.drive     how hard the track is pushing (level x percussivity x dynamics)
//   m.weight    how much of it is low end
//   m.air       how bright it is
//   m.tension   a build: rising, brightening, and the drums thinning out
//   m.calm      the opposite, slow to arrive and slow to leave
//   m.motion    what the look vector asked for, already blended in
//
// A scene multiplies its own numbers by these instead of choosing them. The
// test `webapp/test/musical.test.mjs` drives a scene at 90 and at 180 BPM and
// fails it if the picture does not move twice as fast, which is the only way to
// hold this line — a constant that creeps back in is invisible in review and
// obvious to a stopwatch.

import { approach, clamp, envelope, lerp } from "./util.js";

// Where a tempo-locked value goes when there is no tempo yet. Not a "default
// speed": it is one guess, used in one place, and everything derived from it
// re-times the instant the tracker locks.
const FALLBACK_BPM = 124;
const FALLBACK_BEAT = 60 / FALLBACK_BPM;

export function createMusical() {
  // Angles that only ever increase, so a scene can read them without keeping
  // its own clock — and because they advance by (dt / bar), they re-time
  // themselves when the tempo moves instead of jumping.
  let barSweep = 0;
  let phraseSweep = 0;
  let beatSweep = 0;
  let drive = 0.3;
  let weight = 0.4;
  let air = 0.3;
  let tension = 0;
  let calm = 0.5;
  let attack = 0;
  let lastBeatIndex = -1;
  let barsSinceKick = 0;

  const m = {
    // --- time ---------------------------------------------------------------
    beat: FALLBACK_BEAT,
    bar: FALLBACK_BEAT * 4,
    phrase: FALLBACK_BEAT * 16,
    beatPhase: 0,
    barPhase: 0,
    phrasePhase: 0,
    bpm: 0,
    locked: false,
    // True on the frame a beat / a bar / a phrase begins.
    onBeat: false,
    onBar: false,
    onPhrase: false,
    // --- events -------------------------------------------------------------
    kick: 0, // 0..1, how hard, now
    hit: false, // the frame a kick was accepted
    note: 0, // a melodic attack, not a drum
    chord: 0, // harmony moving
    onset: 0,
    // --- shape --------------------------------------------------------------
    drive: 0.3,
    weight: 0.4,
    air: 0.3,
    tension: 0,
    calm: 0.5,
    attack: 0, // a fast envelope on the onset: use for flashes
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
      return barSweep * turns * Math.PI * 2;
    },
    /** The same, per phrase — for things that should move once a section. */
    slowSweep(turns = 1) {
      return phraseSweep * turns * Math.PI * 2;
    },
    /** The same, per beat — for things that should step with the kick. */
    fastSweep(turns = 1) {
      return beatSweep * turns * Math.PI * 2;
    },
    /**
     * An exponential approach whose time constant is expressed in BEATS, so a
     * smoothing that feels right at 130 BPM still feels right at 200.
     */
    ease(current, target, beats, dt) {
      return approach(current, target, Math.max(0.001, beats * m.beat), dt);
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
      m.bpm = b.bpm || 0;
      m.locked = !!b.locked;

      const prevBarPhase = m.barPhase;
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
      void prevBarPhase;

      // The sweeps advance in BARS, so the same code gives the same rotation
      // per bar at any tempo and speeds up smoothly when the track does.
      beatSweep += dt / m.beat;
      barSweep += dt / m.bar;
      phraseSweep += dt / m.phrase;

      // --- events -----------------------------------------------------------
      m.kick = f.kick || 0;
      m.hit = !!f.kickHit;
      m.note = f.melodyFlux || 0;
      m.chord = f.chordChange || 0;
      m.onset = b.onset || 0;
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
      tension = m.ease(tension, thinning * rising, 2, dt);
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
  void lerp;
  return m;
}
