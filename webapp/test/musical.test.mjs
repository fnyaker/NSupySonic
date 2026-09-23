// Does the animation actually play the track?
//
// This is the test that holds the line the whole `lib/viz/musical.js` layer
// exists for. A constant that should have been musical is invisible in review —
// `t += dt * 0.5` looks exactly like `t += dt / m.beat * 0.5` in a diff — and it
// is obvious to a stopwatch: the first one runs at the same rate through a 90
// BPM intro and a 180 BPM drop, and the second one runs twice as fast.
//
// The worlds' SHADERS cannot make that mistake: the engine gives them no
// seconds clock at all (pinned in viz.test.mjs), only beats, bars and phrases.
// What can make it is a world's DRIVER — the few lines of JavaScript that
// integrate a camera's travel, a stepped rotation, a runner's stride — because
// the driver is handed the render dt in seconds. So every driver is run twice
// over identical wall-clock time, at 90 BPM and at 180, and whatever it
// integrates has to move about twice as far in the second.
//
// The pixels themselves are asked the same question by the render bench
// (`node test/render/run.mjs --tempo`), which needs a browser.

import test from "node:test";
import assert from "node:assert/strict";

import { createMusical } from "../src/lib/viz/musical.js";
import { LOOK_KEYS } from "../src/lib/audio/style.js";
import { worldIds, loadWorld } from "../src/lib/viz/worlds/index.js";

/**
 * One synthetic frame of a track at `bpm`, `t` seconds in, with an
 * arrangement: a build from 8 s, the drop at 16 s, a breakdown from 32 s to
 * 40 s and a second drop at 40 s — the shape the drivers react to — plus a
 * snare on beats 2 and 4 and a melody that moves.
 */
function frameAt(t, { bpm, dt = 1 / 60, steady = false }) {
  const period = 60 / bpm;
  const ph = (t % period) / period;
  const idx = Math.floor(t / period);
  const hit = ph < dt / period;
  // `steady` is the same groove with no arrangement: a drop lands at a time
  // in SECONDS here, so everything a drop sets off would count the same at
  // both tempos and drag a tempo comparison toward 1.
  const section = steady ? 0 : t % 48;
  const breakdown = section >= 32 && section < 40 ? 1 : 0;
  const build = section >= 8 && section < 16 ? (section - 8) / 8 : 0;
  const drop = (section >= 16 && section - dt < 16) || (section >= 40 && section - dt < 40);
  const loud = breakdown ? 0.2 : 1;
  const kick = breakdown ? 0 : Math.max(0, 1 - ph * 7);
  const snare = !breakdown && hit && idx % 2 === 1;
  const bands = new Float32Array(120);
  for (let i = 0; i < 120; i++) {
    const f = i / 120;
    bands[i] = Math.min(1, (Math.pow(1 - f, 1.4) * 0.8 + kick * Math.pow(1 - f, 6)) * loud);
  }
  const look = {};
  for (const k of LOOK_KEYS) look[k] = 0.6;
  return {
    t,
    dt,
    bands,
    bandsDb: bands,
    energy: {
      sub: 0.4 * loud, bass: 0.45 * loud, lowMid: 0.3 * loud,
      mid: 0.3 * loud, high: 0.2 * loud, air: 0.1 * loud,
    },
    features: {
      level: 0.7 * loud, levelDb: -12, peak: 0.9, crest: 3, dynamics: loud,
      flux: 0.02 * loud, lowFlux: 0.03 * loud, midFlux: snare ? 0.4 : 0.01 * loud,
      highFlux: hit ? 0.1 : 0.01, kick, kickHit: hit && !breakdown, centroid: 1500,
      centroidN: 0.45, flatness: 0.35, rolloff: 4000, rolloffN: 0.4,
      percussivity: 0.7 * loud, vocalMod: 0.2, tonal: 0.4, melody: 0.5,
      melodyPitch: 0.5 + 0.3 * Math.sin(t * 1.3), melodyFlux: idx % 2 === 0 && hit ? 0.3 : 0.01,
      chordChange: idx % 8 === 0 && hit ? 0.6 : 0.05, silent: false,
    },
    beat: {
      bpm, confidence: 0.9, phase: ph, beat: hit, beatIndex: idx, barPos: idx % 4,
      beatsPerBar: 4, downbeat: hit && idx % 4 === 0, onset: hit ? 0.8 : 0,
      kickPulse: kick, sinceBeat: t % period, period, locked: true,
    },
    pattern: {
      mainKick: hit && !breakdown, mainPower: 0.9, bigKick: hit && idx % 16 === 0,
      rollKick: false, roll: 0, rollDiv: 0, drop, dropped: 0, sinceDrop: 999,
      build, breakdown, energy: loud,
    },
    style: {
      archetypes: { sustain: 0, voice: 0, groove: 0, hard: 0.9, rock: 0 },
      look, dominant: "techno", dominantLabel: "techno", archetype: "hard", confidence: 0.9,
      kick: { type: "hard", strength: 0.9, decay: 0.12, hit },
    },
  };
}

const WORLDS = [];
for (const id of worldIds()) WORLDS.push([id, await loadWorld(id)]);

/**
 * Run one world's driver the way scenes/gl.js does — the musical layer fed at
 * the analysis rate, the driver stepped with the render dt — and report how far
 * its state travelled over the second half of the run, what it asked of the
 * flash and what it put in the event pool.
 */
function drive(def, { bpm, seconds, dt = 1 / 60, hitchEvery = 0, steady = false }) {
  const state = new Float32Array(8);
  const ev = new Float32Array(32);
  const flashes = [];
  const driver = def.create({
    params: { ...(def.params || {}) },
    preset: {},
    skin: {},
    opts: {},
    flash: (p) => flashes.push(p),
    state,
    ev,
  });
  const m = createMusical();
  const clocks = {
    beats: 0, bars: 0, phrases: 0, dt, aspect: 16 / 9, spec: new Float32Array(128),
    pitch: 0.5, melody: 0.5, hole: [0, 0, 0, 0],
  };
  const prev = new Float32Array(8);
  const before = new Float32Array(32);
  const births = [];
  let moved = 0;
  let peak = 0;
  let bad = null;
  const n = Math.round(seconds / dt);
  let t = 0;
  for (let i = 0; i < n; i++) {
    // A hitch — a tab brought back to the front, a GC pause — is a render dt
    // of a quarter of a second, the most the engine ever hands a driver.
    const step = hitchEvery && i % hitchEvery === hitchEvery - 1 ? 0.25 : dt;
    t += step;
    m.update(frameAt(t, { bpm, dt: step, steady }), step);
    clocks.beats = (t * bpm) / 60;
    clocks.bars = clocks.beats / 4;
    clocks.phrases = clocks.bars / 8;
    clocks.dt = step;
    clocks.pitch = 0.5 + 0.3 * Math.sin(t);
    before.set(ev);
    driver.step?.(step, m, clocks);
    // Only the slots this step wrote: the ring keeps its older events.
    for (let k = 0; k < 32; k += 4)
      if (ev[k] !== before[k] || ev[k + 1] !== before[k + 1]) births.push([ev[k], clocks.beats]);
    for (let k = 0; k < 8; k++) {
      if (!Number.isFinite(state[k])) bad ??= `state[${k}] = ${state[k]} at ${t.toFixed(1)} s`;
      peak = Math.max(peak, Math.abs(state[k]));
    }
    if (i > n / 2) for (let k = 0; k < 8; k++) moved += Math.abs(state[k] - prev[k]);
    prev.set(state);
  }
  return { moved, peak, bad, flashes, births };
}

test("the musical layer re-times everything when the tempo changes", () => {
  const m = createMusical();
  const feed = (bpm, n = 40) => {
    for (let i = 0; i < n; i++) m.update(frameAt(i / 60, { bpm }), 1 / 60);
  };
  feed(90);
  const slowBeat = m.beat;
  const slowLife = m.overBeats(4);
  const slowRate = m.perBeat(1);
  feed(180);
  assert.ok(Math.abs(m.beat - slowBeat / 2) < 0.02, `beat ${m.beat} vs ${slowBeat}`);
  // A lifetime expressed in beats halves; a rate expressed per beat doubles.
  assert.ok(Math.abs(m.overBeats(4) - slowLife / 2) < 0.05);
  assert.ok(Math.abs(m.perBeat(1) - slowRate * 2) < 0.2);
  // And a bar is beats, not a number someone wrote down.
  assert.ok(Math.abs(m.bar - m.beat * 4) < 1e-6);
});

test("every world's driver keeps musical time", () => {
  // Measured when the catalogue was written, over 16 s of a steady groove at
  // each tempo: every driver that integrates anything moves 1.82x (flow) to
  // 2.31x (forge) as far at 180 BPM as at 90 — bounce's spring sits at 1.92,
  // because an overshoot is a property of the spring, not of the tempo. A
  // rate written in seconds scores 1.00. `ocean` used to follow only the
  // square root of the tempo (1.41x) and was moved onto the beat clock:
  // 140 BPM half-time rolled at barely the speed of a 90 BPM track. Drivers
  // that integrate nothing (their shader does all the moving on the beat
  // clock) move under half a unit and are not asked.
  const ratios = [];
  for (const [id, def] of WORLDS) {
    if (!def.create) continue;
    const slow = drive(def, { bpm: 90, seconds: 16, steady: true });
    const fast = drive(def, { bpm: 180, seconds: 16, steady: true });
    if (slow.moved < 0.5) continue;
    const r = fast.moved / slow.moved;
    ratios.push(`${id} ${r.toFixed(2)}`);
    assert.ok(r > 1.3, `${id}: moved ${r.toFixed(2)}x as far at twice the tempo — a clock in seconds?`);
  }
  assert.ok(ratios.length >= 20, `only ${ratios.length} drivers integrate anything: ${ratios.join(", ")}`);
});

test("every driver survives any tempo, hitches and ten minutes of music", () => {
  // The projector at a party: nobody watching, the tab backgrounded and
  // brought back, a track at 60 and the next at 250. A NaN in a driver's state
  // is a uniform the GPU turns into a black world for the rest of the night,
  // and a state that grows without bound loses a float32 uniform's precision
  // — a phase of 1e6 moves in steps of 0.06, which is a visible stutter.
  // Measured: before the long clocks were wrapped, the wobble's LFO phase
  // reached 3.4e4 in ten minutes at 250 BPM, the night drive's road 2.3e4 and
  // the pixel runner's scroll 2.9e4 — a few hours on, a float32 step there is
  // a twentieth of a unit. Every long clock now wraps at a period its shader
  // is exactly periodic in; the largest state left is the vinyl's turn at
  // 8.4e3 (a float32 step of 0.001 of a turn).
  for (const [id, def] of WORLDS) {
    if (!def.create) continue;
    for (const bpm of [60, 250]) {
      const r = drive(def, { bpm, seconds: 600, dt: 1 / 30, hitchEvery: 97 });
      assert.equal(r.bad, null, `${id} @ ${bpm}: ${r.bad}`);
      assert.ok(r.peak < 1e4, `${id} @ ${bpm}: state reached ${r.peak.toExponential(1)}`);
      for (const p of r.flashes) assert.ok(p >= 0 && p <= 1, `${id}: flash(${p})`);
    }
  }
});

test("every event a driver schedules is stamped in beats, near now", () => {
  // Events live in the uEv pool as (birth in beats, ...), and the shader ages
  // them against uClock.x. A birth stamped in seconds, or at a stale beat,
  // plays its animation at the wrong moment or never — and renders perfectly
  // well, so nothing but this would notice. Fireworks aim a shell at the NEXT
  // beat, which is the furthest ahead anything schedules.
  for (const [id, def] of WORLDS) {
    if (!def.create) continue;
    const r = drive(def, { bpm: 140, seconds: 48 });
    for (const [birth, now] of r.births)
      assert.ok(birth > now - 4 && birth < now + 2.5, `${id}: event born at ${birth.toFixed(1)} with the clock at ${now.toFixed(1)}`);
  }
});

test("the unleashed strobe plays the kicks of a drop, and leaves the breakdown dark", async () => {
  // "Débridé" (Réglages → Animations, behind a photosensitivity warning) turns
  // the engine into a strobe. The worlds only ask for a flash on a drop — once
  // a minute — so what this mode adds is the ENGINE's own policy
  // (scenes/gl.js#strobePower), run here the way the engine runs it: event
  // stamps read at the render clock, then the ten-a-second cap. Material:
  // frenchcore at 200 BPM through the arrangement above (build 8-16 s, drop at
  // 16 s, breakdown 32-40 s), with the pattern layer's `dropped` held for
  // eight seconds after each drop exactly as audio/pattern.js holds it.
  const { strobePower, STROBE_MIN_INTERVAL, FLASH_MIN_INTERVAL } = await import("../src/lib/viz/scenes/gl.js");
  const bpm = 200;
  const dt = 1 / 60;
  const m = createMusical();
  let seen = { main: m.stamp.main, snare: m.stamp.snare, drop: m.stamp.drop };
  let last = -1e9;
  const onsets = [];
  let kicks = 0;
  for (let t = dt; t < 48; t += dt) {
    const f = frameAt(t, { bpm, dt });
    const since = t >= 40 ? t - 40 : t >= 16 ? t - 16 : 999;
    f.pattern.dropped = Math.max(0, 1 - since / 8);
    if (f.pattern.mainKick && t >= 16 && t < 24) kicks++;
    m.update(f, dt);
    const st = m.stamp;
    const p = strobePower(m, st.main !== seen.main, st.snare !== seen.snare, st.drop !== seen.drop);
    seen = { main: st.main, snare: st.snare, drop: st.drop };
    if (p > 0 && t - last >= STROBE_MIN_INTERVAL) {
      last = t;
      onsets.push(t);
    }
  }
  const within = (a, b) => onsets.filter((t) => t >= a && t < b).length;
  let busiest = 0;
  for (const t of onsets) busiest = Math.max(busiest, within(t, t + 1));
  // Measured: 27 flashes over the eight seconds of the drop for its 26 main
  // kicks (every one of them, plus the drop itself) — 3.4 a second, past the
  // three a second every other level is held to, which is the whole point of
  // the mode. None at all in the breakdown. At most five in any one second
  // (the kicks plus the build's snares), well inside the ten-a-second cap.
  assert.ok(within(16, 24) >= kicks, `${within(16, 24)} flashes for ${kicks} kicks in the drop`);
  assert.ok(within(16, 24) / 8 > 1 / FLASH_MIN_INTERVAL, "no faster than the capped levels");
  assert.equal(within(32.5, 40), 0, "the breakdown strobes");
  assert.ok(busiest <= 1 / STROBE_MIN_INTERVAL, `${busiest} flashes in one second`);
  // And nothing is asked of a moment with no event in it.
  assert.equal(strobePower(m, false, false, false), 0);
});
