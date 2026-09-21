// Offline checks for the animation scenes (lib/viz/*).
//
// The scenes only ever touch a CanvasRenderingContext2D, which is a recordable
// interface — so they can be driven from Node against a stub that writes down
// where they drew, and then asked the two questions that actually matter and
// that nothing else can answer without a person looking at a screen:
//
//   1. DOES IT FILL THE FRAME? Every scene used to be built on `min(w, h)`,
//      which on a 16:9 projector is a circle inscribed in the middle and a
//      third of the picture left black.
//   2. DOES IT KEEP OFF THE ARTWORK? In the full-screen player the cover sits
//      in the middle, and the scenes put their brightest material exactly
//      there — behind it.
//
// Plus the third one, for the smart engine: does a different genre actually
// produce a different picture, or only a differently-tinted one?

import test from "node:test";
import assert from "node:assert/strict";

import { createGeometry } from "../src/lib/viz/geometry.js";
import { createScene, MODES, effectiveMode, levelFor } from "../src/lib/viz/index.js";
import { tierPreset, TIERS } from "../src/lib/viz/quality.js";
import { createPalette } from "../src/lib/viz/palette.js";
import { LOOK_KEYS } from "../src/lib/audio/style.js";

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
  const grad = () => ({ addColorStop() {} });
  const put = (px, py) => {
    if (Number.isFinite(px) && Number.isFinite(py)) ink.push([px, py]);
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
    save() {},
    restore() {},
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
    ink,
    get lastPoint() {
      return [x, y];
    },
  };
  return g;
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
  };
}

function styleOf(arche, look, dominant = "techno") {
  const a = { sustain: 0, voice: 0, groove: 0, hard: 0, rock: 0, ...arche };
  const l = {};
  for (const k of LOOK_KEYS) l[k] = look[k] ?? 0.5;
  return {
    archetypes: a,
    look: l,
    dominant,
    dominantLabel: dominant,
    archetype: "groove",
    confidence: 0.8,
    kick: { type: "hard", strength: 0.8, decay: 0.12, hit: true },
  };
}

// Run a scene for a while and return where it drew.
function paint(mode, { w, h, occl = null, style = null, tier = "high", seconds = 6 } = {}) {
  const preset = tierPreset(tier);
  const geometry = createGeometry();
  geometry.set(w, h, occl);
  const scene = createScene(mode, { preset, layout: "full", intensity: 0.8 });
  scene.resize(w, h, preset, geometry.out);
  const pal = createPalette("neon");
  const g = recorder(w, h);
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const f = makeFrame(i * dt, { style });
    pal.update(f, dt);
    scene.update(f, dt, geometry.out);
    scene.draw(g, w, h, pal.out, geometry.out);
  }
  return { ink: g.ink, scene, geom: geometry.out };
}

const SCENES = MODES.filter((m) => m.id !== "off" && m.id !== "bars").map((m) => m.id);

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

test("every scene fills a 16:9 frame instead of a circle in the middle of it", () => {
  const w = 1920;
  const h = 1080;
  for (const mode of SCENES) {
    const { ink } = paint(mode, { w, h, style: styleOf({ hard: 0.6, groove: 0.4 }, { motion: 0.8 }) });
    assert.ok(ink.length > 50, `${mode}: drew almost nothing (${ink.length} points)`);
    const { minX, maxX, minY, maxY } = extent(ink);
    assert.ok(minX < w * 0.15, `${mode}: nothing drawn on the left (min x ${minX.toFixed(0)})`);
    assert.ok(maxX > w * 0.85, `${mode}: nothing drawn on the right (max x ${maxX.toFixed(0)})`);
    assert.ok(minY < h * 0.2, `${mode}: nothing drawn at the top (min y ${minY.toFixed(0)})`);
    assert.ok(maxY > h * 0.8, `${mode}: nothing drawn at the bottom (max y ${maxY.toFixed(0)})`);
  }
});

test("every scene keeps its material off the artwork", () => {
  // A phone in the full-screen player: the cover is a square across most of
  // the width, dead centre. Anything drawn inside it is drawn for nobody.
  const w = 420;
  const h = 900;
  const side = w * 0.72;
  const occl = { x: (w - side) / 2, y: (h - side) / 2, w: side, h: side };
  for (const mode of SCENES) {
    const { ink, geom } = paint(mode, {
      w, h, occl,
      style: styleOf({ hard: 0.5, groove: 0.5 }, { motion: 0.8, chaos: 0.5, melodic: 0.6 }),
    });
    const inside = ink.filter(
      (p) => Math.abs(p[0] - geom.cx) < geom.hw && Math.abs(p[1] - geom.cy) < geom.hh
    ).length;
    assert.ok(
      inside / ink.length < 0.25,
      `${mode}: ${((inside / ink.length) * 100) | 0}% of the drawing is behind the cover`
    );
  }
});

test("the smart engine draws a different picture for a different genre", () => {
  // The complaint this answers: every genre used to come out of the same five
  // layers, so frenchcore and ambient differed in tint and in speed but not in
  // WHAT was on screen.
  const hardcore = styleOf(
    { hard: 0.85, groove: 0.15 },
    { motion: 0.96, density: 0.85, punch: 0.98, smooth: 0.12, warm: 0.82, melodic: 0.15, chaos: 0.7 },
    "frenchcore"
  );
  const ambient = styleOf(
    { sustain: 0.9, voice: 0.1 },
    { motion: 0.06, density: 0.16, punch: 0.04, smooth: 0.93, warm: 0.38, melodic: 0.9, chaos: 0.04 },
    "ambient"
  );
  const a = paint("smart", { w: 1600, h: 900, style: hardcore, seconds: 8 });
  const b = paint("smart", { w: 1600, h: 900, style: ambient, seconds: 8 });
  const on = (r) =>
    new Set(r.scene.layers.filter((l) => l.weight > 0.12).map((l) => l.def.id));
  const A = on(a);
  const B = on(b);
  assert.ok(A.has("hard"), `frenchcore did not light the kick layer (${[...A]})`);
  assert.ok(A.has("warp"), `frenchcore did not light the speed layer (${[...A]})`);
  assert.ok(A.has("lattice"), `frenchcore did not light the chaos layer (${[...A]})`);
  assert.ok(B.has("haze"), `ambient did not light the calm layer (${[...B]})`);
  assert.ok(B.has("bow"), `ambient did not light the sustained layer (${[...B]})`);
  assert.ok(!B.has("warp"), `ambient lit the speed layer (${[...B]})`);
  assert.ok(!B.has("lattice"), `ambient lit the chaos layer (${[...B]})`);
  // ...and the two sets genuinely differ, rather than one being the other's
  // subset with the weights turned down.
  const shared = [...A].filter((k) => B.has(k)).length;
  assert.ok(shared <= 1, `the two genres drew the same layers (${[...A]} vs ${[...B]})`);
});

test("no scene draws more layers than its tier allows", () => {
  // Nine layers at once is soup as well as work. A busy, everything-at-once
  // style must still respect the budget.
  const busy = styleOf(
    { sustain: 0.2, voice: 0.2, groove: 0.2, hard: 0.2, rock: 0.2 },
    { motion: 0.9, density: 0.9, punch: 0.9, smooth: 0.9, warm: 0.5, melodic: 0.9, chaos: 0.9 }
  );
  for (const tier of TIERS) {
    const { scene } = paint("smart", { w: 1280, h: 720, style: busy, tier, seconds: 5 });
    const budget = Math.max(3, tierPreset(tier).layers + 1);
    const drawn = scene.layers.filter((l) => l.weight > 0.035).length;
    assert.ok(drawn >= 3, `${tier}: only ${drawn} layers wanted by an everything style`);
    // The scene itself caps what it DRAWS; this pins the budget it caps to.
    assert.ok(budget <= 6 && budget >= 3, `${tier}: odd budget ${budget}`);
  }
});

test("every scene survives every tier, aspect and artwork, at any frame", () => {
  // The cheap insurance: a scene that throws takes the whole render loop with
  // it, and a projector nobody is looking at is exactly where that happens.
  const shapes = [
    [1920, 1080, null],
    [390, 844, { x: 20, y: 300, w: 350, h: 350 }],
    [3440, 1440, null],
    [800, 800, { x: 100, y: 100, w: 600, h: 600 }],
    [200, 120, null],
  ];
  for (const mode of ["bars", ...SCENES]) {
    for (const tier of TIERS) {
      for (const [w, h, occl] of shapes) {
        assert.doesNotThrow(
          () => paint(mode, { w, h, occl, tier, seconds: 1, style: styleOf({ groove: 1 }, {}) }),
          `${mode} @ ${tier} ${w}x${h}${occl ? " with artwork" : ""}`
        );
      }
    }
  }
});

test("a scene with no style yet still draws, and still fills the frame", () => {
  // The first seconds of a track, and every track on a device where the smart
  // level has not been reached: `frame.style` is null and every layer has to
  // fall back to something sane rather than to nothing.
  for (const mode of SCENES) {
    const { ink } = paint(mode, { w: 1600, h: 900, style: null, seconds: 4 });
    assert.ok(ink.length > 30, `${mode}: drew nothing without a style verdict`);
    const { maxX } = extent(ink);
    assert.ok(maxX > 1600 * 0.8, `${mode}: stayed in the middle without a style verdict`);
  }
});

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
