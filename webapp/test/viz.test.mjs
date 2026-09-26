// Offline checks for the animation layer (lib/viz/*).
//
// Two kinds of scene come out of lib/viz, and they are checked in two places.
//
// THE CANVAS SCENES — the oscilloscope and the spectrum bars' no-WebGL twin —
// only ever touch a CanvasRenderingContext2D, which is a recordable interface:
// they are driven here against a stub that writes down where they drew, and
// asked whether they fill the frame, keep off the artwork and (the scope)
// actually draw the SAMPLES.
//
// THE WORLDS are fragment shaders. Node has no GPU, so what they draw is asked
// of real pixels by the render bench (test/render/run.mjs --check), which
// renders every one in headless Chromium. What this file pins about them is
// everything that can be decided WITHOUT a GPU and that a GPU would only report
// as a black screen: the catalogue, the loader and the skins agree with each
// other; every genre either vocabulary can name resolves to a world that
// exists, with parameters that world actually reads; every P_ define and every
// uniform a shader mentions is one the engine declares; and no shader can ask
// for wall-clock time, because the engine does not give it any.

import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { createGeometry } from "../src/lib/viz/geometry.js";
import { vizCoreFromBytes } from "../src/lib/viz/core.js";
import { createScene, createFallback, MODES, effectiveMode, levelFor } from "../src/lib/viz/index.js";
import { tierPreset, TIERS } from "../src/lib/viz/quality.js";
import { createPalette } from "../src/lib/viz/palette.js";
import { FAMILY_LIST } from "../src/lib/audio/style.js";
import { WORLD_META, GROUPS, worldFor } from "../src/lib/viz/worlds/catalogue.js";
import { worldIds, loadWorld, hasWorld, instrumentIds } from "../src/lib/viz/worlds/index.js";
import { SKINS, ALIASES, skinId, skinFor, skinCount } from "../src/lib/viz/skins.js";
import { worldFragment, particleVertex, particleFragment, WORLD_UNIFORMS } from "../src/lib/viz/gl/glsl.js";

// The scenes' arithmetic is Rust (lib/viz/core.js); in the app the core loads
// with the scene, here it is instantiated once from the shipped binary.
vizCoreFromBytes(readFileSync(new URL("../src/lib/audio/rhythm.wasm", import.meta.url)));

// --- a canvas that remembers where it was drawn on --------------------------
//
// `ink` collects the coordinates of everything with a POSITION: path points,
// arc and ellipse extremes, non-full-frame rectangles. A full-frame fillRect is
// deliberately NOT counted — it is the trail wash and the colour floor, every
// scene paints one, and counting it would make "does it fill the frame" pass
// for a scene that draws a dot in the middle.
function recorder(w, h) {
  const ink = [];
  let x = 0;
  let y = 0;
  // A 2×3 affine stack, because some worlds squash a shape with
  // save/translate/scale rather than recomputing its geometry — a recorder that
  // ignored that would file those points in the wrong place.
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const grad = () => ({ addColorStop() {} });
  // The third element is the compositing mode the point was drawn under. Every
  // caller that only wants coordinates destructures the first two and is
  // unaffected; what it buys is telling a scene's GLOW layer from its line work
  // — and, for the oscilloscope, its trace (additive) from the graticule it is
  // drawn against (which is not).
  const put = (px, py) => {
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    ink.push([m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5], g.globalCompositeOperation]);
  };
  const g = {
    canvas: { width: w, height: h },
    globalCompositeOperation: "source-over",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    createLinearGradient: grad,
    createRadialGradient: grad,
    setTransform() {},
    save() {
      stack.push(m.slice());
    },
    restore() {
      if (stack.length) m = stack.pop();
    },
    translate(tx, ty) {
      m = [m[0], m[1], m[2], m[3], m[0] * tx + m[2] * ty + m[4], m[1] * tx + m[3] * ty + m[5]];
    },
    scale(sx, sy) {
      m = [m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy, m[4], m[5]];
    },
    rotate(r) {
      const c = Math.cos(r);
      const si = Math.sin(r);
      m = [
        m[0] * c + m[2] * si, m[1] * c + m[3] * si,
        m[0] * -si + m[2] * c, m[1] * -si + m[3] * c,
        m[4], m[5],
      ];
    },
    clearRect() {},
    beginPath() {},
    closePath() {},
    fill() {},
    stroke() {},
    moveTo(a, b) {
      x = a;
      y = b;
      put(a, b);
    },
    lineTo(a, b) {
      x = a;
      y = b;
      put(a, b);
    },
    quadraticCurveTo(cx, cy, a, b) {
      put(cx, cy);
      put(a, b);
      x = a;
      y = b;
    },
    arc(cx, cy, r) {
      put(cx - r, cy);
      put(cx + r, cy);
      put(cx, cy - r);
      put(cx, cy + r);
    },
    ellipse(cx, cy, rx, ry) {
      put(cx - rx, cy);
      put(cx + rx, cy);
      put(cx, cy - ry);
      put(cx, cy + ry);
    },
    fillRect(a, b, rw, rh) {
      // A full-frame wash says nothing about where the scene put its material.
      if (a <= 0.5 && b <= 0.5 && rw >= w - 1 && rh >= h - 1) return;
      put(a, b);
      put(a + rw, b + rh);
    },
    // Text is ink with a position like any other: the scope names its two
    // traces, and a recorder without `fillText` would take the suite down
    // rather than measure it (see `strokeRect` below, which already did).
    fillText(_text, a, b) {
      put(a, b);
    },
    measureText(t) {
      return { width: String(t).length * 6 };
    },
    // A recorder that is MISSING a canvas call does not measure the scene
    // wrongly, it throws — `industrial` draws its frames with `strokeRect` and
    // took the whole suite down with "g.strokeRect is not a function" the first
    // time anything asked it to paint.
    strokeRect(a, b, rw, rh) {
      if (a <= 0.5 && b <= 0.5 && rw >= w - 1 && rh >= h - 1) return;
      put(a, b);
      put(a + rw, b + rh);
    },
    roundRect(a, b, rw, rh) {
      put(a, b);
      put(a + rw, b + rh);
    },
    arcTo(cx, cy, a, b) {
      put(cx, cy);
      put(a, b);
      x = a;
      y = b;
    },
    bezierCurveTo(c1x, c1y, c2x, c2y, a, b) {
      put(c1x, c1y);
      put(c2x, c2y);
      put(a, b);
      x = a;
      y = b;
    },
    rect(a, b, rw, rh) {
      put(a, b);
      put(a + rw, b + rh);
    },
    ink,
    get lastPoint() {
      return [x, y];
    },
  };
  return g;
}

// --- the audio the scenes are driven with -----------------------------------
//
// The oscilloscope draws the SAMPLES, so a frame with no samples in it tests
// nothing about it — and a drawn sine would test its own drawing. This is one
// looping second of the kind of record this player exists for, written as
// samples: a pitched kick swept 180 -> 45 Hz into a soft clipper twice a second,
// a saw lead panned right, hats on the offbeats, and the two channels genuinely
// different so "one trace per channel" is a claim a test can check.
//
// Built ONCE and stored twice end to end, so any offset yields a contiguous
// window without a wrap and a frame costs a subarray rather than a synthesis.
const WAVE_SR = 48000;
const WAVE_LEN = WAVE_SR;
const waveSrcL = new Float32Array(WAVE_LEN * 2);
const waveSrcR = new Float32Array(WAVE_LEN * 2);
(function buildWave() {
  const beat = 0.5; // 120 BPM
  let hatSeed = 12345;
  const rnd = () => ((hatSeed = (hatSeed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  let kickPhase = 0;
  for (let i = 0; i < WAVE_LEN; i++) {
    const t = i / WAVE_SR;
    const inBeat = t % beat;
    // The kick: a sine whose frequency falls through the first 50 ms, driven
    // into a clipper. Its own low end is what the scope's trigger locks to.
    const kEnv = Math.exp(-inBeat * 9);
    const kHz = 45 + 135 * Math.exp(-inBeat * 26);
    kickPhase += (2 * Math.PI * kHz) / WAVE_SR;
    const kick = Math.tanh(Math.sin(kickPhase) * 3.2) * kEnv * 0.75;
    // The lead: three harmonics of 220 Hz, panned right.
    const lead =
      (Math.sin(2 * Math.PI * 220 * t) * 0.5 +
        Math.sin(2 * Math.PI * 440 * t) * 0.22 +
        Math.sin(2 * Math.PI * 660 * t) * 0.11) *
      0.32;
    // Hats on the offbeats: short bursts of noise.
    const hEnv = Math.exp(-((inBeat - beat / 2 + beat) % beat) * 90);
    const hat = rnd() * hEnv * 0.12;
    waveSrcL[i] = Math.max(-1, Math.min(1, kick + lead * 0.35 + hat));
    waveSrcR[i] = Math.max(-1, Math.min(1, kick + lead + hat * 0.6));
  }
  waveSrcL.copyWithin(WAVE_LEN, 0, WAVE_LEN);
  waveSrcR.copyWithin(WAVE_LEN, 0, WAVE_LEN);
})();

const silentWave = new Float32Array(WAVE_LEN);

// A sustained 220 Hz tone. Music is the right material for almost everything
// here, but not for "does the trace stand still": on real music consecutive
// windows share only 60% of their audio, so the picture legitimately changes
// whatever the trigger does, and the measurement says nothing. A steady tone is
// the one signal where the trace SHOULD be identical frame to frame, which
// makes the trigger the only thing the number can be about.
const toneSrc = new Float32Array(WAVE_LEN * 2);
for (let i = 0; i < toneSrc.length; i++)
  toneSrc[i] = Math.sin((2 * Math.PI * 220 * i) / WAVE_SR) * 0.6;

function waveAt(t, size = 4096, mode = "music") {
  if (mode === "tone") {
    const off = Math.floor(t * WAVE_SR) % WAVE_LEN;
    return {
      left: toneSrc.subarray(off, off + size),
      right: toneSrc.subarray(off, off + size),
      size,
      sampleRate: WAVE_SR,
    };
  }
  if (mode === "silent")
    return {
      left: silentWave.subarray(0, size),
      right: silentWave.subarray(0, size),
      size,
      sampleRate: WAVE_SR,
    };
  const off = Math.floor(t * WAVE_SR) % WAVE_LEN;
  return {
    left: waveSrcL.subarray(off, off + size),
    right: waveSrcR.subarray(off, off + size),
    size,
    sampleRate: WAVE_SR,
  };
}

// --- a frame the scenes can be driven with ----------------------------------
const BANDS = 120;
function makeFrame(t, opts = {}) {
  const bands = new Float32Array(BANDS);
  for (let i = 0; i < BANDS; i++) bands[i] = 0.3 + 0.5 * Math.abs(Math.sin(i * 0.21 + t * 3));
  const chroma = new Float32Array(12);
  for (let i = 0; i < 12; i++) chroma[i] = i % 4 === 0 ? 0.9 : 0.2;
  const beatEvery = 0.5;
  const beat = Math.floor(t / beatEvery) !== Math.floor((t - 1 / 60) / beatEvery);
  const idx = Math.floor(t / beatEvery);
  return {
    t,
    dt: 1 / 60,
    bands,
    energy: { sub: 0.4, bass: 0.5, lowMid: 0.3, mid: 0.35, high: 0.2, air: 0.12 },
    features: {
      level: 0.7, flux: 0.02, lowFlux: 0.03, midFlux: 0.02, highFlux: 0.01,
      centroidN: 0.45, flatness: 0.35, percussivity: 0.6, vocalMod: 0.4, crest: 3,
      silent: false, kick: beat ? 0.9 : 0.2, dynamics: 1, tonal: 0.5, melody: 0.6,
      melodyPitch: 0.5, melodyFlux: 0.03, chordChange: 0.1, chroma,
    },
    beat: {
      bpm: 120, confidence: 0.8, phase: (t % beatEvery) / beatEvery, beat,
      beatIndex: idx, barPos: idx % 4, beatsPerBar: 4, downbeat: beat && idx % 4 === 0,
      onset: beat ? 0.8 : 0, kickPulse: 0.8, sinceBeat: t % beatEvery,
      period: beatEvery, locked: true,
    },
    style: opts.style ?? null,
    wave: opts.wave === null ? null : waveAt(t, opts.waveSize || 4096, opts.wave),
  };
}


// The canvas scenes are CODE-SPLIT in the app (lib/viz/index.js loads them on
// demand), which makes `createScene` a promise. These checks are about what
// they DRAW, so they load once here and stay synchronous; the loader's own
// contract is pinned separately, below.
const SCENE_FACTORY = {
  bars: (await import("../src/lib/viz/scenes/bars.js")).createBarsScene,
  scope: (await import("../src/lib/viz/scenes/scope.js")).createScopeScene,
};
const makeScene = (mode, opts) => (SCENE_FACTORY[mode] ? SCENE_FACTORY[mode](opts) : null);

// Run a scene for a while and return where it drew.
function paint(
  mode,
  {
    w, h, occl = null, style = null, tier = "high", seconds = 6,
    orientation = "horizontal", colour = "duo", wave, waveSize,
  } = {}
) {
  const preset = tierPreset(tier);
  const geometry = createGeometry();
  geometry.set(w, h, occl);
  const scene = makeScene(mode, {
    preset, layout: "full", intensity: 0.8, orientation, colour,
  });
  scene.resize(w, h, preset, geometry.out);
  const pal = createPalette("neon");
  const g = recorder(w, h);
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const f = makeFrame(i * dt, { style, wave, waveSize });
    pal.update(f, dt);
    scene.update(f, dt, geometry.out);
    scene.draw(g, w, h, pal.out, geometry.out);
  }
  return { ink: g.ink, scene, geom: geometry.out };
}


// Where a scene spent its ink, as an 8×8 histogram normalised to sum to 1.
function signature(ink, w, h) {
  const n = 8;
  const cell = new Float64Array(n * n);
  let total = 0;
  for (const [px, py] of ink) {
    const cx = Math.min(n - 1, Math.max(0, Math.floor((px / w) * n)));
    const cy = Math.min(n - 1, Math.max(0, Math.floor((py / h) * n)));
    cell[cy * n + cx]++;
    total++;
  }
  if (total) for (let i = 0; i < cell.length; i++) cell[i] /= total;
  return cell;
}
function sigDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d; // 0 identical, 2 disjoint
}

// `Math.min(...array)` on a few hundred thousand points overflows the stack,
// which is a very confusing way for a coverage test to fail.
function extent(ink) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ink) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

test("the geometry maps radial 1 onto the frame's own edge, not onto a circle", () => {
  const { set, out } = createGeometry();
  set(1920, 1080, null);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const p = out.place(a, 1);
    const onEdge =
      Math.abs(p[0]) < 1 || Math.abs(p[0] - 1920) < 1 ||
      Math.abs(p[1]) < 1 || Math.abs(p[1] - 1080) < 1;
    assert.ok(onEdge, `radial 1 at ${a.toFixed(2)} landed at ${p[0].toFixed(0)},${p[1].toFixed(0)}`);
    assert.ok(p[0] >= -1 && p[0] <= 1921 && p[1] >= -1 && p[1] <= 1081, "outside the frame");
  }
  // ...and an expanding ring covers the whole frame before it is done.
  assert.ok(out.ringRx(1) >= 960, "a finished ring does not reach the sides");
  assert.ok(out.ringRy(1) >= 540, "a finished ring does not reach the top");
});

test("with artwork in the way, radial 0 is its rim", () => {
  const { set, out } = createGeometry();
  const occl = { x: 660, y: 240, w: 600, h: 600 };
  set(1920, 1080, occl);
  assert.ok(out.hole > 0.5, `hole read as ${out.hole.toFixed(2)}`);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const p = out.place(a, 0);
    const dx = Math.abs(p[0] - out.cx);
    const dy = Math.abs(p[1] - out.cy);
    // On the boundary of the (padded) artwork box: one axis at its half-extent,
    // neither beyond it.
    assert.ok(
      Math.abs(dx - out.hw) < 1 || Math.abs(dy - out.hh) < 1,
      `radial 0 at ${a.toFixed(2)} is not on the rim`
    );
    assert.ok(dx <= out.hw + 1 && dy <= out.hh + 1, "radial 0 escaped the rim");
  }
  // The artwork can never eat the frame, however big it is reported to be.
  set(400, 400, { x: -50, y: -50, w: 500, h: 500 });
  assert.ok(out.hw < 200 && out.hh < 200, "the artwork was allowed to cover everything");
});

test("the GL engine is told where the artwork really is, not where a centred one would be", () => {
  // The mobile player's cover sits ABOVE the middle of the canvas (the
  // controls are under it). The canvas-era geometry grows its box around the
  // frame's centre so its polar primitives stay honest, and the GL engine
  // used to be handed that grown box: every world centred its motif 7% of
  // the frame below the cover it was framing and dimmed the wrong region.
  const { set, out } = createGeometry();
  const w = 390;
  const h = 844;
  const occl = { x: 40, y: 250, w: 310, h: 310 }; // centre y 405, frame centre 422
  set(w, h, occl);
  assert.equal(out.hx, 195);
  assert.equal(out.hy, 405);
  // The artwork's own padded box: its half-size plus the pad, and no more.
  assert.ok(out.ahw >= 155 && out.ahw < 155 + 0.08 * w, `ahw ${out.ahw}`);
  assert.ok(out.ahh >= 155 && out.ahh < 155 + 0.08 * w, `ahh ${out.ahh}`);
  // The grown one still contains it, for the scope's primitives.
  assert.ok(out.hh >= out.ahh + Math.abs(out.hy - out.cy) - 1e-9, "the grown box lost the artwork");
  // And the free band under the artwork starts under the ARTWORK.
  assert.ok(Math.abs(out.afloorY - (out.hy + out.ahh)) < 1e-9);
  assert.ok(out.afloorY < out.floorY, "the true floor should sit above the grown one");
});

test("the canvas scenes survive every tier, aspect and artwork, at any frame", () => {
  // The cheap insurance: a scene that throws takes the whole render loop with
  // it, and a projector nobody is looking at is exactly where that happens.
  // The bars are what a device with no WebGL2 gets instead of every world.
  const shapes = [
    [1920, 1080, null],
    [390, 844, { x: 20, y: 300, w: 350, h: 350 }],
    [3440, 1440, null],
    [800, 800, { x: 100, y: 100, w: 600, h: 600 }],
    [200, 120, null],
  ];
  for (const mode of ["bars", "scope"]) {
    for (const tier of TIERS) {
      for (const [w, h, occl] of shapes) {
        assert.doesNotThrow(
          () => paint(mode, { w, h, occl, tier, seconds: 1 }),
          `${mode} @ ${tier} ${w}x${h}${occl ? " with artwork" : ""}`
        );
      }
    }
  }
});

test("the scope fills a 16:9 frame and keeps off the artwork", () => {
  const w = 1920;
  const h = 1080;
  const { ink } = paint("scope", { w, h });
  assert.ok(ink.length > 50, `drew almost nothing (${ink.length} points)`);
  const { minX, maxX, minY, maxY } = extent(ink);
  assert.ok(minX < w * 0.15 && maxX > w * 0.85, `left/right ${minX.toFixed(0)}..${maxX.toFixed(0)}`);
  assert.ok(minY < h * 0.2 && maxY > h * 0.8, `top/bottom ${minY.toFixed(0)}..${maxY.toFixed(0)}`);
  // A phone in the full-screen player: the cover is a square across most of
  // the width, dead centre. Anything drawn inside it is drawn for nobody.
  const pw = 420;
  const ph = 900;
  const side = pw * 0.72;
  const occl = { x: (pw - side) / 2, y: (ph - side) / 2, w: side, h: side };
  const r = paint("scope", { w: pw, h: ph, occl });
  const inside = r.ink.filter(
    (p) => Math.abs(p[0] - r.geom.cx) < r.geom.hw && Math.abs(p[1] - r.geom.cy) < r.geom.hh
  ).length;
  assert.ok(inside / r.ink.length < 0.25, `${((inside / r.ink.length) * 100) | 0}% is behind the cover`);
});

// --- the oscilloscope -------------------------------------------------------
//
// The two tests above ask the scope whether it fills the frame and keeps off
// the artwork, and it answers both. Neither of them would notice if it
// drew its graticule and nothing else — which is why what follows drives the
// SAMPLES through it and measures the trace on its own. The recorder tags each
// point with the compositing mode it was drawn under, and the scope's trace is
// the only thing it draws additively, so `lighter` separates the beam from the
// instrument it is drawn on.

const SCOPE_W = 1600;
const SCOPE_H = 900;

/**
 * Drive the scope and hand back, per frame, the TRACE's points split by lane.
 * `rows` is the trace read back one frame at a time, which is what a question
 * about stability needs; the generic `paint` above accumulates everything.
 */
function scopeRun({
  w = SCOPE_W, h = SCOPE_H, tier = "high", orientation = "horizontal",
  wave = "music", occl = null, seconds = 4, settle = 1,
} = {}) {
  const preset = tierPreset(tier);
  const geometry = createGeometry();
  geometry.set(w, h, occl);
  const scene = makeScene("scope", { preset, layout: "full", intensity: 0.8, orientation });
  scene.resize(w, h, preset, geometry.out);
  const pal = createPalette("neon");
  const dt = 1 / 60;
  const rows = [];
  const axis = orientation === "horizontal" ? 1 : 0;
  const cut = orientation === "horizontal" ? h / 2 : w / 2;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const f = makeFrame(i * dt, { wave });
    pal.update(f, dt);
    scene.update(f, dt, geometry.out);
    const g = recorder(w, h);
    scene.draw(g, w, h, pal.out, geometry.out);
    if (i * dt < settle) continue; // let the auto-range and the lock settle
    const trace = g.ink.filter((pt) => pt[2] === "lighter");
    rows.push([
      trace.filter((pt) => pt[axis] < cut).map((pt) => pt[axis]),
      trace.filter((pt) => pt[axis] >= cut).map((pt) => pt[axis]),
    ]);
  }
  return { rows, scene, axis, geom: geometry.out };
}

const deflection = (rows, lane, zero) => {
  let max = 0;
  let sum = 0;
  let n = 0;
  for (const r of rows)
    for (const v of r[lane]) {
      const d = Math.abs(v - zero);
      if (d > max) max = d;
      sum += d;
      n++;
    }
  return { max, mean: n ? sum / n : 0, n };
};

test("the scope draws the signal, one trace per channel, and goes flat without one", () => {
  // Horizontal, no artwork: lane G is the top half (zero line at h/4), lane D
  // the bottom (3h/4).
  const zeroG = SCOPE_H / 4;
  const zeroD = (SCOPE_H * 3) / 4;

  const music = scopeRun({ wave: "music" });
  const g = deflection(music.rows, 0, zeroG);
  const d = deflection(music.rows, 1, zeroD);
  assert.ok(g.n > 1000 && d.n > 1000, "the scope drew almost no trace");
  // Measured on the bench material: 168.2 px and 196.1 px of peak deflection
  // against a lane half-height of 199 — the auto-range lets the loudest kicks
  // reach the rails on purpose, which is what a scope does.
  assert.ok(g.max > 60, `left trace barely moved (${g.max.toFixed(1)} px)`);
  assert.ok(d.max > 60, `right trace barely moved (${d.max.toFixed(1)} px)`);

  // THE TWO CHANNELS ARE READ SEPARATELY, which is the whole reason there are
  // two of them. The bench signal puts the lead almost three times louder on
  // the right, and between kicks that is most of what is in the window —
  // measured, the right trace's mean deflection is 1.26x the left's. A scope
  // fed one summed signal (which is all an AnalyserNode can give, hence the
  // dedicated tap in lib/audio/graph.js) would read exactly 1.00 here.
  const ratio = d.mean / g.mean;
  assert.ok(ratio > 1.1, `the two channels drew the same thing (ratio ${ratio.toFixed(3)})`);

  // Silence is a flat line ON the zero line, not an empty canvas: an
  // instrument showing nothing and an instrument that has stopped are
  // different things, and the auto-range must not invent a signal out of the
  // noise floor either.
  const quiet = scopeRun({ wave: "silent" });
  const qg = deflection(quiet.rows, 0, zeroG);
  assert.ok(qg.n > 1000, "the scope stopped drawing on silence");
  assert.ok(qg.max < 1, `silence deflected the trace by ${qg.max.toFixed(2)} px`);
  assert.equal(quiet.scene.locked < 0.05, true, "silence must not report a trigger lock");

  // ...and with no tap at all (an older projector feed, or before the graph
  // exists) it still draws its face rather than throwing or blanking.
  const none = scopeRun({ wave: null });
  assert.ok(deflection(none.rows, 0, zeroG).n > 1000, "no tap left the scope blank");
});

test("triggering is what holds the trace still", () => {
  // On a sustained tone a triggered trace must be the SAME trace every frame.
  // The reference is the same windows read from the end of the buffer, which
  // is exactly what a scope with no trigger shows.
  const tone = scopeRun({ wave: "tone", tier: "high", seconds: 3 });
  assert.ok(tone.scene.locked > 0.9, `no lock on a steady tone (${tone.scene.locked.toFixed(2)})`);

  const drift = (rows, lane) => {
    let sum = 0;
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1][lane];
      const b = rows[i][lane];
      const m = Math.min(a.length, b.length);
      for (let c = 0; c < m; c++) {
        sum += Math.abs(a[c] - b[c]);
        n++;
      }
    }
    return n ? sum / n : 0;
  };
  const moved = drift(tone.rows, 0);
  // Measured: 0.007 px triggered against 86.5 px free-running on this tone —
  // four orders of magnitude, and the difference between an instrument and a
  // waveform sliding off the side of the screen.
  assert.ok(moved < 2, `the trace slid ${moved.toFixed(3)} px a frame on a steady tone`);
});

test("the scope's precision climbs with the quality tier, and ultra is the exact one", () => {
  // Precision, not timebase: every tier shows the same slice of time. What
  // changes is how much of it survives to the screen.
  //
  // Measured on a 4K-wide frame, where the lane is wider than the tiers'
  // ceilings and each one's own limit is what bites: 256 / 512 / 2048 / 4044
  // columns. (On a 1600-wide frame high and ultra both reach one column per
  // pixel, which is as precise as a display can be asked to be.)
  const cols = TIERS.map((t) => scopeRun({ tier: t, w: 4096, h: 2160, seconds: 0.6, settle: 0 }).scene.cols);
  for (let i = 1; i < cols.length; i++)
    assert.ok(cols[i] > cols[i - 1], `${TIERS[i]} is no finer than ${TIERS[i - 1]} (${cols.join(" / ")})`);
  assert.ok(cols[3] >= 4000, `ultra capped at ${cols[3]} columns on a 4K lane`);

  // And the step that is NOT a column count: the sub-sample trigger. Below
  // `high` the window starts on a whole sample, so the trace shifts a whole
  // sample at a time — ~0.95 px on a 1920-wide lane, seen as a shimmer down
  // the whole trace. Measured on the steady tone: 1.03 px a frame at medium,
  // 0.007 px at high, a factor of 158.
  const drift = (run) => {
    const rows = run.rows;
    let sum = 0;
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1][0];
      const b = rows[i][0];
      const m = Math.min(a.length, b.length);
      for (let c = 0; c < m; c++) {
        sum += Math.abs(a[c] - b[c]);
        n++;
      }
    }
    return n ? sum / n : 0;
  };
  const coarse = drift(scopeRun({ wave: "tone", tier: "medium", seconds: 3 }));
  const fine = drift(scopeRun({ wave: "tone", tier: "high", seconds: 3 }));
  assert.ok(
    fine < coarse * 0.2,
    `the sub-sample trigger bought nothing (medium ${coarse.toFixed(3)} px, high ${fine.toFixed(3)} px)`
  );
});

test("the scope's orientation moves the lanes, and both keep off the artwork", () => {
  // Horizontal is two bands stacked; vertical is two columns side by side. The
  // claim is that the SAME signal lands somewhere else, not that a label
  // changed.
  const flat = paint("scope", { w: SCOPE_W, h: SCOPE_H, orientation: "horizontal" });
  const tall = paint("scope", { w: SCOPE_W, h: SCOPE_H, orientation: "vertical" });
  const a = signature(flat.ink, SCOPE_W, SCOPE_H);
  const b = signature(tall.ink, SCOPE_W, SCOPE_H);
  assert.ok(
    sigDistance(a, b) > 0.5,
    `the two orientations drew in the same places (${sigDistance(a, b).toFixed(2)})`
  );

  // Both have to route around the cover in the full-screen player — the
  // horizontal one into the strips above and below it, the vertical one into
  // the columns beside it. The generic test above only ever asked the default.
  const w = 420;
  const h = 900;
  const side = w * 0.72;
  const occl = { x: (w - side) / 2, y: (h - side) / 2, w: side, h: side };
  for (const orientation of ["horizontal", "vertical"]) {
    const r = paint("scope", { w, h, occl, orientation });
    const inside = r.ink.filter(
      (pt) => Math.abs(pt[0] - r.geom.cx) < r.geom.hw && Math.abs(pt[1] - r.geom.cy) < r.geom.hh
    ).length;
    assert.ok(r.ink.length > 50, `scope/${orientation}: drew almost nothing`);
    assert.ok(
      inside / r.ink.length < 0.25,
      `scope/${orientation}: ${((inside / r.ink.length) * 100) | 0}% of the drawing is behind the cover`
    );
  }
});
// --- the registry and the loader ---------------------------------------------

test("the mode registry stays consistent with what the scenes can do", () => {
  for (const m of MODES) {
    assert.equal(typeof m.label, "string");
    assert.ok(m.label.length > 0);
    if (m.id === "off") continue;
    assert.equal(typeof levelFor(m.id), "number");
  }
  // Eco mode means none, and a rhythm scene with the analysis off degrades
  // rather than rendering a dead canvas.
  assert.equal(effectiveMode("smart", true, true), "off");
  assert.equal(effectiveMode("smart", false, false), "aurora");
  assert.equal(effectiveMode("bars", false, false), "bars");
});

test("the scene loader hands back the right KIND of scene, on demand", async () => {
  // The app never imports a scene statically: `createScene` fetches the module
  // the first time a mode is asked for. The host reads `kind` to decide which
  // context to give the canvas — a canvas cannot switch from 2D to WebGL once
  // it has one — so the kind is part of the contract, not a detail.
  const opts = { preset: tierPreset("high"), layout: "full", intensity: 0.8 };
  for (const m of MODES) {
    const p = createScene(m.id, opts);
    if (m.id === "off") {
      assert.equal(p, null, "the off mode must not load a scene");
      continue;
    }
    assert.ok(p && typeof p.then === "function", `${m.id} did not return a promise`);
    const scene = await p;
    assert.equal(typeof scene?.update, "function", `${m.id} has no update()`);
    assert.equal(typeof scene?.draw, "function", `${m.id} has no draw()`);
    // Every mode is the GL engine now, the oscilloscope included (the scope
    // instrument, worlds/scope.js). The canvas scenes carry no `kind`: the
    // host reads anything that is not "gl" as a 2D scene.
    assert.equal(scene.kind === "gl" ? "gl" : "2d", "gl", `${m.id} is the wrong kind of scene`);
    scene.dispose?.();
  }
  const [a, b] = await Promise.all([createScene("smart", opts), createScene("smart", opts)]);
  assert.ok(a && b && a !== b, "each call must build its own scene");
  // Without WebGL2, each mode's canvas version: the scope for the scope, the
  // spectrum bars for everything else — both on the same Rust arithmetic.
  const fbScope = await createFallback("scope", opts);
  const fbBars = await createFallback("smart", opts);
  assert.notEqual(fbScope.kind, "gl");
  assert.notEqual(fbBars.kind, "gl");
  assert.equal(typeof fbScope.setOptions, "function", "the scope fallback takes the scope's settings");
  assert.ok("bars" in fbBars, "every other mode falls back to the bars");
  fbScope.dispose();
  fbBars.dispose();
});

test("every world in the loader is in the catalogue, and the reverse", async () => {
  // The loader (worlds/index.js: one literal import() per world, so each is its
  // own chunk) and the catalogue (worlds/catalogue.js: names and blurbs, no
  // shader) are separate files so that naming a world costs nothing. They have
  // to agree, or a gallery offers a world that cannot load.
  assert.deepEqual([...worldIds()].sort(), Object.keys(WORLD_META).sort());
  const groups = new Set(GROUPS.map((g) => g.id));
  const used = new Set();
  for (const id of worldIds()) {
    const meta = WORLD_META[id];
    assert.ok(groups.has(meta.group), `${id}: unknown shelf "${meta.group}"`);
    used.add(meta.group);
    assert.ok(meta.label && meta.blurb, `${id}: no label or blurb`);
    const def = await loadWorld(id);
    assert.equal(def?.id, id, `${id}: the module calls itself "${def?.id}"`);
  }
  for (const g of GROUPS) assert.ok(used.has(g.id), `shelf "${g.id}" is empty`);
  assert.ok(!hasWorld("no-such-world"));
  // The floor under the skins names real worlds too.
  for (const a of ["sustain", "voice", "groove", "hard", "rock", "?"]) assert.ok(WORLD_META[worldFor(a)], a);
});

// --- the shaders, as far as they can be checked without a GPU ------------------
//
// A shader that does not compile is a black screen and a line in the console of
// a browser nobody is looking at — a projector at a party. The render bench
// compiles every world for real; these are the mistakes it has actually caught,
// turned into checks that run in a second on every `npm test`.

const WORLDS = [];
for (const id of worldIds()) WORLDS.push([id, await loadWorld(id)]);
// The instruments (the scope) are GL scenes too, held to the same shader rules;
// they are nobody's genre, so the catalogue's own checks leave them out.
const INSTRUMENTS = [];
for (const id of instrumentIds()) INSTRUMENTS.push([id, await loadWorld(id)]);
const { paramDefines } = await import("../src/lib/viz/scenes/gl.js");

// GLSL ES 3.00's reserved words and the built-in functions a world calls.
// Declaring a local with one of these names is legal right up to the first
// call it shadows — `float all = …` compiled, and then `all(lessThan(…))` a few
// lines down did not, and the world rendered black.
const RESERVED = new Set(
  (
    "attribute const uniform varying layout centroid flat smooth break continue do for while switch " +
    "case default if else in out inout float int uint void bool true false invariant discard return " +
    "struct precision highp mediump lowp coherent volatile restrict readonly writeonly resource " +
    "atomic_uint noperspective patch sample subroutine common partition active asm class union enum " +
    "typedef template this goto inline noinline public static extern external interface long short " +
    "double half fixed unsigned superp input output filter sizeof cast namespace using " +
    "all any not min max step mix length distance dot cross normalize reflect refract sign floor ceil " +
    "round trunc fract mod modf clamp smoothstep abs sin cos tan asin acos atan pow exp exp2 log log2 " +
    "sqrt inversesqrt texture textureLod texelFetch equal notEqual lessThan greaterThan lessThanEqual " +
    "greaterThanEqual radians degrees transpose inverse determinant outerProduct matrixCompMult " +
    "faceforward isnan isinf fwidth dFdx dFdy"
  ).split(/\s+/)
);

function glslBodies(def) {
  const out = [["fragment", def.fragment]];
  if (def.particles) {
    out.push(["particle vertex", def.particles.vertex]);
    out.push(["particle fragment", def.particles.fragment]);
  }
  return out;
}

test("every world's shader asks only for what the engine declares", () => {
  const declared = new Set(WORLD_UNIFORMS.match(/\bu[A-Z]\w*/g));
  assert.ok(INSTRUMENTS.length > 0, "the scope instrument is checked too");
  for (const [id, def] of [...WORLDS, ...INSTRUMENTS]) {
    const names = Object.keys(def.params || {});
    assert.ok(names.length <= 16, `${id}: ${names.length} params, the engine packs 16`);
    for (const [k, v] of Object.entries(def.params || {}))
      assert.ok(Number.isFinite(v), `${id}: param ${k} is not a number`);
    const defines = paramDefines(names);
    for (const [where, body] of glslBodies(def)) {
      assert.equal(typeof body, "string", `${id}: no ${where}`);
      // Every P_ a world mentions is one of its own parameters: an undefined
      // define is a compile error, and a skin can only ever set a param that
      // exists.
      for (const p of new Set(body.match(/\bP_[A-Z0-9_]+\b/g) || []))
        assert.ok(defines.includes(`#define ${p} `), `${id} (${where}): ${p} is not one of its params`);
      for (const u of new Set(body.match(/\bu[A-Z]\w*/g) || []))
        assert.ok(declared.has(u), `${id} (${where}): uniform ${u} does not exist`);
      for (const [open, close] of [["{", "}"], ["(", ")"]]) {
        const a = body.split(open).length;
        const b = body.split(close).length;
        assert.equal(a, b, `${id} (${where}): unbalanced ${open}${close}`);
      }
      for (const m of body.matchAll(/\b(?:float|int|uint|bool|vec[234]|ivec[234]|mat[234])\s+([A-Za-z_]\w*)\s*[=;,)[]/g))
        assert.ok(!RESERVED.has(m[1]), `${id} (${where}): a variable called "${m[1]}" shadows GLSL`);
    }
    // And the whole thing assembles: every chunk it uses exists.
    assert.doesNotThrow(() => worldFragment(def.fragment, def.uses || [], defines), `${id}: fragment`);
    if (def.particles) {
      assert.match(def.particles.vertex, /void particle\(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind\)/, `${id}: particle() signature`);
      assert.match(def.particles.fragment, /vec4 sprite\(vec2 \w+, vec4 \w+, float \w+\)/, `${id}: sprite() signature`);
      assert.doesNotThrow(() => particleVertex(def.particles.vertex, def.particles.uses || [], defines));
      assert.doesNotThrow(() => particleFragment(def.particles.fragment, def.particles.uses || [], defines));
    }
  }
});

test("a world cannot see wall-clock time, because the engine gives it none", () => {
  // Every clock a shader has is counted in beats, bars and phrases (uClock),
  // so a rate written in a shader is a rate per beat by construction and the
  // picture plays the track at any tempo. That only holds while there is no
  // seconds uniform to reach for; this is the line.
  const declared = WORLD_UNIFORMS.match(/\bu[A-Z]\w*/g);
  for (const u of declared) assert.doesNotMatch(u, /time|sec|second/i, `${u} looks like wall-clock time`);
  for (const [id, def] of WORLDS)
    for (const [where, body] of glslBodies(def))
      assert.doesNotMatch(body, /\biTime\b|\buTime\b|\bu_time\b/, `${id} (${where}) reaches for a seconds clock`);
});

// --- the skins -----------------------------------------------------------------

const EXTRA = (() => {
  const py = readFileSync(new URL("../../supysonic/deezer/analysis.py", import.meta.url), "utf8");
  const block = py.match(/EXTRA_GENRES = \[([\s\S]*?)\n\]/);
  assert.ok(block, "EXTRA_GENRES is no longer where this test looks for it");
  return [...block[1].matchAll(/\("([^"]+)",\s*"([a-z]+)"\)/g)].map((m) => [m[1], m[2]]);
})();

test("every family the classifier can name has its own skin, by id and by label", () => {
  for (const f of FAMILY_LIST) {
    assert.equal(skinId(f.id), f.id, `family "${f.id}" has no row of its own`);
    // The classifier's French label is what a served verdict or the readout
    // hands over, and it must land on the same row.
    assert.equal(skinId(f.label), f.id, `label "${f.label}" resolves to "${skinId(f.label)}"`);
  }
});

test("every genre the studio offers is a genre the animation can dress", () => {
  // The two halves of the vocabulary are written in different languages and
  // have to agree: `analysis.known_genres()` is what the genre studio offers an
  // admin to tag with, and this table is what the animation does with the tag
  // that comes back. A label that only reaches the archetype fallback is a
  // track tagged carefully and then animated generically.
  assert.ok(EXTRA.length > 100, `only ${EXTRA.length} extra genres parsed`);
  const orphans = EXTRA.filter(([label]) => !SKINS[skinId(label)] || !skinId(label)).map(([l]) => l);
  assert.deepEqual(orphans, [], `no skin for: ${orphans.join(", ")}`);
  const arches = new Set(EXTRA.map((r) => r[1]));
  for (const a of arches) assert.ok(skinId("a name nothing will ever match", a), `no fallback for ${a}`);
});

test("every skin names a real world, with parameters that world reads", () => {
  const params = Object.fromEntries(WORLDS.map(([id, def]) => [id, def.params || {}]));
  for (const [id, s] of Object.entries(SKINS)) {
    assert.ok(WORLD_META[s.world], `${id}: unknown world "${s.world}"`);
    for (const [k, v] of Object.entries(s.p || {})) {
      // A key the world does not declare is silently ignored by the engine,
      // which is exactly how a skin ends up looking like its anchor row.
      assert.ok(k in params[s.world], `${id}: "${s.world}" has no parameter "${k}"`);
      assert.ok(Number.isFinite(v), `${id}: ${k} is not a number`);
    }
    for (const k of ["hue", "sat", "light", "speed", "energy"])
      if (k in s) assert.ok(Number.isFinite(s[k]), `${id}: ${k} is not a number`);
    for (const k of ["sat", "light", "speed", "energy"]) if (k in s) assert.ok(s[k] > 0, `${id}: ${k} <= 0`);
  }
  for (const [from, to] of Object.entries(ALIASES)) assert.ok(SKINS[to], `alias ${from} -> missing ${to}`);
});

test("every world is somebody's genre, and the catalogue is far wider than the detector", () => {
  // A world no genre resolves to is one "auto" never shows: forty-seven
  // worlds were written so that the genres would stop sharing five.
  const used = new Set(Object.values(SKINS).map((s) => s.world));
  const unused = Object.keys(WORLD_META).filter((w) => !used.has(w));
  assert.deepEqual(unused, [], `no genre resolves to: ${unused.join(", ")}`);
  // Measured when the catalogue was written: 226 rows across 49 worlds, the
  // busiest world (slices, every break-driven genre) carrying 12.
  assert.ok(skinCount() >= 220, `only ${skinCount()} genres are dressed`);
  const per = {};
  for (const s of Object.values(SKINS)) per[s.world] = (per[s.world] || 0) + 1;
  assert.ok(Math.max(...Object.values(per)) <= 14, `one world carries ${Math.max(...Object.values(per))} genres`);
});

test("a name arrives however it likes and still finds its skin", () => {
  assert.equal(skinId("Drum & Bass"), "dnb");
  assert.equal(skinId("drum and bass"), "dnb");
  assert.equal(skinId("PSY"), "psytrance");
  assert.equal(skinId("Cordes / classique"), "strings");
  assert.equal(skinId("Hard Ping-Pong"), "hardpingpong");
  assert.equal(skinId("Deutscher Krach"), "krach");
  assert.equal(skinId("Électronique"), "electronic");
  assert.equal(skinId("musique classique"), "classical");
  assert.equal(skinId("8-bit"), "eightbit");
  assert.equal(skinId("UK garage"), "garage");
  // Unknown names still dress the scene rather than leaving it blank, and the
  // floor agrees with the catalogue's own archetype fallback.
  for (const a of ["sustain", "voice", "groove", "hard", "rock"])
    assert.equal(skinFor("a genre nobody has named", a).world, worldFor(a), a);
  assert.ok(WORLD_META[skinFor("total nonsense").world]);
});

test("neighbours sharing a world are told apart by a SHAPE switch, not a brightness", () => {
  // The pairs the catalogue exists for: same world, and at least one parameter
  // that changes what the motif IS rather than how much of it there is.
  const SHAPE = {
    kaleido: ["mirror", "web", "sectors", "iter"],
    wobble: ["wave"],
    lasers: ["raw"],
    forge: ["anvils"],
    microwave: ["dish"],
    slices: ["axis", "angle"],
    shatter: ["shards"],
    tunnel: ["sides", "twist", "dash", "dir"],
    bounce: ["twins"],
    vinyl: ["rpm", "arm"],
    carnival: ["rings"],
  };
  const pairs = [
    ["goa", "darkpsy"], ["dubstep", "brostep"], ["brostep", "riddim"], ["hardstyle", "euphorichardstyle"], ["rawstyle", "rawphase"],
    ["krach", "zaag"], ["zaag", "uptempo"], ["krach", "uptempo"],
    ["dnb", "jungle"], ["gabber", "speedcore"], ["techno", "ebm"], ["jumpstyle", "hardbass"],
    ["boombap", "swing"], ["salsa", "dembow"], ["psytrance", "hitech"],
  ];
  for (const [a, b] of pairs) {
    const sa = SKINS[a];
    const sb = SKINS[b];
    assert.equal(sa.world, sb.world, `${a}/${b} no longer share a world`);
    const keys = SHAPE[sa.world];
    const differ = keys.some((k) => (sa.p?.[k] ?? "default") !== (sb.p?.[k] ?? "default"));
    assert.ok(differ, `${a} and ${b} differ on no shape switch of ${sa.world} (${keys.join(", ")})`);
  }
});
