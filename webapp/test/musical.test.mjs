// Does the animation actually play the track?
//
// This is the test that holds the line the whole `lib/viz/musical.js` layer
// exists for. A constant that should have been musical is invisible in review —
// `spin += dt * 0.05` looks exactly like `spin += dt * m.perBar(1)` in a diff —
// and it is obvious to a stopwatch: the first one turns at the same rate through
// a 90 BPM intro and a 180 BPM drop, and the second one turns twice as fast.
//
// So every dedicated animation is driven twice over identical wall-clock time,
// once at 90 BPM and once at 180, and the picture has to MOVE about twice as
// much in the second. Nothing else in either suite would catch a regression
// here, because a scene with a hard-coded rate renders perfectly well — it is
// just not listening.
//
// The second half asks the other question: does it respond to the moment, not
// only to the grid? Same tempo, a loud dense passage against a quiet one, and
// the picture has to differ. An animation that ignores `m.drive` draws a
// breakdown exactly like a drop.

import test from "node:test";
import assert from "node:assert/strict";

import { createGeometry } from "../src/lib/viz/geometry.js";
// Loaded directly: the app code-splits the scenes (lib/viz/index.js), and
// these checks are about what a scene draws rather than how it is fetched.
import { createSmartScene } from "../src/lib/viz/scenes/smart.js";
import { tierPreset } from "../src/lib/viz/quality.js";
import { createPalette } from "../src/lib/viz/palette.js";
import { createMusical } from "../src/lib/viz/musical.js";
import { LOOK_KEYS } from "../src/lib/audio/style.js";
import { dedicatedIds, genreSceneFor } from "../src/lib/viz/genres/index.js";

const W = 1280;
const H = 720;

// A context that records where ink was put, so "how much did the picture move"
// can be answered by comparing two frames.
function recorder() {
  const ink = [];
  const noop = () => {};
  const grad = { addColorStop: noop };
  const ctx = new Proxy(
    {
      ink,
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      filter: "none",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      strokeStyle: "",
      fillStyle: "",
      moveTo: (x, y) => ink.push(x, y),
      lineTo: (x, y) => ink.push(x, y),
      arc: (x, y) => ink.push(x, y),
      rect: (x, y) => ink.push(x, y),
      fillRect: (x, y, w, h) => ink.push(x + w / 2, y + h / 2),
      strokeRect: (x, y, w, h) => ink.push(x + w / 2, y + h / 2),
      quadraticCurveTo: (cx, cy, x, y) => ink.push(x, y),
      createLinearGradient: () => grad,
      createRadialGradient: () => grad,
      createPattern: () => null,
    },
    {
      get: (t, k) => (k in t ? t[k] : noop),
      set: (t, k, v) => ((t[k] = v), true),
    }
  );
  return ctx;
}

/** One synthetic frame of a track at `bpm`, `t` seconds in. */
function frameAt(t, { bpm, loud = 1, genre = "frenchcore", arche = { hard: 0.9 } }) {
  const period = 60 / bpm;
  const ph = (t % period) / period;
  const idx = Math.floor(t / period);
  const kick = Math.max(0, 1 - ph * 7) * loud;
  const bands = new Float32Array(120);
  for (let i = 0; i < 120; i++) {
    const f = i / 120;
    bands[i] = Math.min(1, (Math.pow(1 - f, 1.4) * 0.8 + kick * Math.pow(1 - f, 6)) * loud);
  }
  const look = {};
  for (const k of LOOK_KEYS) look[k] = 0.6;
  return {
    t,
    dt: 1 / 60,
    bands,
    bandsDb: bands,
    energy: {
      sub: 0.4 * loud, bass: 0.45 * loud, lowMid: 0.3 * loud,
      mid: 0.3 * loud, high: 0.2 * loud, air: 0.1 * loud,
    },
    features: {
      level: 0.7 * loud, levelDb: -12, peak: 0.9, crest: 3, dynamics: loud,
      flux: 0.02 * loud, lowFlux: 0.03 * loud, midFlux: 0.02 * loud, highFlux: 0.012 * loud,
      kick, kickHit: ph < 1 / 60 / period, centroid: 1500, centroidN: 0.45,
      flatness: 0.35, rolloff: 4000, rolloffN: 0.4, percussivity: 0.7 * loud,
      vocalMod: 0.2, tonal: 0.4, melody: 0.5, melodyPitch: 0.5,
      melodyFlux: 0.03 * loud, chordChange: 0.1, silent: false,
    },
    beat: {
      bpm, confidence: 0.9, phase: ph, beat: ph < 1 / 60 / period, beatIndex: idx,
      barPos: idx % 4, beatsPerBar: 4, downbeat: ph < 1 / 60 / period && idx % 4 === 0,
      onset: ph < 1 / 60 / period ? 0.8 : 0, kickPulse: kick,
      sinceBeat: t % period, period, locked: true,
    },
    style: {
      archetypes: { sustain: 0, voice: 0, groove: 0, hard: 0, rock: 0, ...arche },
      look, dominant: genre, dominantLabel: genre,
      archetype: Object.keys(arche)[0], confidence: 0.9,
      kick: { type: "hard", strength: 0.9, decay: 0.12, hit: false },
    },
  };
}

/** How far the drawing moved between the last two frames of a run. */
function travel({ bpm, seconds, loud = 1, genre, arche }) {
  const geometry = createGeometry();
  geometry.set(W, H, null);
  const scene = createSmartScene({
    preset: tierPreset("high"), layout: "full", intensity: 0.8,
  });
  const pal = createPalette("neon");
  const dt = 1 / 60;
  const n = Math.round(seconds / dt);
  // Measured over a WINDOW, not over the last two frames. A picture whose
  // event happened to fall between the two sampled frames scores zero and a
  // picture that is between events scores zero too — raggatek, whose stacks sit
  // still between skanks, read 0.00 at both tempos and the ratio came out 0/0.
  // Summing the change over the last stretch asks the question that was meant:
  // how much does this animation move, per second, at this tempo.
  const WINDOW = 90; // frames
  let prev = null;
  let moved = 0;
  let ink = 0;
  for (let i = 0; i < n; i++) {
    const f = frameAt(i * dt, { bpm, loud, genre, arche });
    f.style.kick.hit = f.beat.beat;
    pal.update(f, dt);
    scene.update(f, dt, geometry.out);
    if (i >= n - WINDOW) {
      const g = recorder();
      scene.draw(g, W, H, pal.out, geometry.out);
      if (prev) moved += histDistance(prev, g.ink);
      prev = g.ink;
      ink += g.ink.length;
    }
  }
  return { moved, ink: Math.round(ink / WINDOW) };
}

/**
 * How much the picture changed between two frames, as the L1 distance between
 * 8x8 histograms of where the ink fell.
 *
 * Comparing the two point lists index by index looks simpler and is wrong: a
 * scene skips an element whose alpha rounded to nothing, the arrays shift by
 * one, and every later point is compared against its neighbour. Measured, that
 * made a ring rotating twice as fast score LOWER than the same ring at half the
 * speed. A histogram does not care what order the points arrived in.
 */
function histDistance(a, b) {
  const ha = hist(a);
  const hb = hist(b);
  let d = 0;
  for (let i = 0; i < ha.length; i++) d += Math.abs(ha[i] - hb[i]);
  return d;
}

function hist(pts) {
  const h = new Float64Array(64);
  let n = 0;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const cx = Math.max(0, Math.min(7, Math.floor((x / W) * 8)));
    const cy = Math.max(0, Math.min(7, Math.floor((y / H) * 8)));
    h[cy * 8 + cx]++;
    n++;
  }
  if (n) for (let i = 0; i < 64; i++) h[i] /= n;
  return h;
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

test("every dedicated animation moves with the tempo", () => {
  // The stopwatch. Same wall clock, twice the tempo: the picture has to move
  // materially more. A hard-coded rate scores ~1.0 here and fails.
  const ids = [...new Set(dedicatedIds())];
  const slack = [];
  for (const id of ids) {
    const arche = { hard: 0.9 };
    const slow = travel({ bpm: 90, seconds: 6, genre: id, arche });
    const fast = travel({ bpm: 180, seconds: 6, genre: id, arche });
    assert.ok(fast.ink > 20, `${id} drew almost nothing`);
    const ratio = fast.moved / Math.max(1e-6, slow.moved);
    slack.push(`${id} ${ratio.toFixed(2)}`);
    assert.ok(
      ratio > 1.25,
      `${id} moves the same at 90 and 180 BPM (ratio ${ratio.toFixed(2)}) — ` +
        `something in it is timed in seconds. Full set: ${slack.join(", ")}`
    );
  }
});

test("every dedicated animation answers the moment, not only the grid", () => {
  // Same tempo, a drop against a breakdown. An animation that reads only the
  // beat grid draws them identically, which is the other half of "adapts to
  // the music" and is not caught by the tempo test at all.
  for (const id of [...new Set(dedicatedIds())]) {
    const arche = { hard: 0.9 };
    const loud = travel({ bpm: 150, seconds: 5, loud: 1, genre: id, arche });
    const quiet = travel({ bpm: 150, seconds: 5, loud: 0.12, genre: id, arche });
    const diff = Math.abs(loud.ink - quiet.ink) / Math.max(1, loud.ink);
    const moved = Math.abs(loud.moved - quiet.moved) / Math.max(1e-6, loud.moved);
    assert.ok(
      diff > 0.02 || moved > 0.05,
      `${id} draws a breakdown exactly like a drop (ink ${loud.ink}/${quiet.ink})`
    );
  }
});

test("a dedicated animation declares what it is and how much trail it wants", () => {
  for (const id of [...new Set(dedicatedIds())]) {
    const mod = genreSceneFor(id);
    assert.ok(mod, `${id} has no module`);
    assert.ok(mod.meta && mod.meta.label, `${id} has no label`);
    assert.ok(
      mod.meta.trail > 0.05 && mod.meta.trail <= 1,
      `${id} trail ${mod.meta.trail} is outside the usable range`
    );
    assert.equal(typeof mod.create, "function", `${id} exports no create()`);
  }
});
