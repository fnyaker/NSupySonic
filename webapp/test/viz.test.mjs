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
import { LOOK_KEYS, FAMILY_LIST } from "../src/lib/audio/style.js";
import { FAMILY_WORLD, WORLDS } from "../src/lib/viz/worlds/index.js";

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
  const put = (px, py) => {
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    ink.push([m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]]);
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

// Where a scene spent its ink, as an 8×8 histogram normalised to sum to 1.
// Two animations that genuinely differ put their material in different places;
// two that are the same primitives at different brightness do not.
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

test("every genre gets its own animation, not the same one re-weighted", () => {
  // THE complaint this design answers: the old engine drew one visual
  // vocabulary at per-genre strengths, so frenchcore and ambient were the same
  // picture at different brightness. Each family now maps to a WORLD, and the
  // worlds are not variations on each other.
  const cases = {
    frenchcore: ["shatter", { motion: 0.96, density: 0.85, punch: 0.98, smooth: 0.12, warm: 0.82, melodic: 0.15, chaos: 0.7 }, { hard: 0.9 }],
    techno: ["tunnel", { motion: 0.66, density: 0.62, smooth: 0.38, warm: 0.28, melodic: 0.28, chaos: 0.2 }, { groove: 0.85 }],
    psytrance: ["kaleido", { motion: 0.9, density: 0.86, smooth: 0.3, warm: 0.22, melodic: 0.4, chaos: 0.32 }, { hard: 0.6, groove: 0.4 }],
    rap: ["vinyl", { motion: 0.46, punch: 0.7, warm: 0.62, melodic: 0.35, smooth: 0.6 }, { groove: 0.6, voice: 0.4 }],
    metal: ["stagelights", { motion: 0.78, density: 0.72, punch: 0.84, warm: 0.62, chaos: 0.5, smooth: 0.22 }, { rock: 0.9 }],
    synthwave: ["horizon", { motion: 0.44, density: 0.5, smooth: 0.8, warm: 0.88, melodic: 0.78 }, { groove: 0.5, voice: 0.5 }],
    ambient: ["nebula", { motion: 0.06, density: 0.16, punch: 0.04, smooth: 0.93, warm: 0.38, melodic: 0.9, chaos: 0.04 }, { sustain: 0.95 }],
    dnb: ["breakgrid", { motion: 0.88, density: 0.8, punch: 0.72, warm: 0.36, chaos: 0.34, smooth: 0.26 }, { hard: 0.5, groove: 0.5 }],
    dubstep: ["wobble", { motion: 0.7, density: 0.7, punch: 0.88, warm: 0.34, chaos: 0.55, smooth: 0.2 }, { hard: 0.8 }],
    jazz: ["smoke", { motion: 0.4, density: 0.46, warm: 0.7, chaos: 0.2, smooth: 0.66, melodic: 0.85 }, { voice: 0.6, sustain: 0.4 }],
    house: ["bloom", { motion: 0.5, density: 0.55, warm: 0.6, smooth: 0.58, melodic: 0.55 }, { groove: 0.7, voice: 0.3 }],
    hardstyle: ["hardbounce", { motion: 0.78, punch: 0.95, warm: 0.62, melodic: 0.45, chaos: 0.3 }, { hard: 0.9 }],
    trance: ["starfield", { motion: 0.62, density: 0.7, warm: 0.3, smooth: 0.72, melodic: 0.84 }, { groove: 0.5, sustain: 0.5 }],
  };
  const sigs = {};
  for (const [family, [expected, look, arche]] of Object.entries(cases)) {
    const r = paint("smart", {
      w: 1600, h: 900, seconds: 9,
      style: styleOf(arche, look, family),
    });
    assert.equal(r.scene.world, expected, `${family} did not land on its own world`);
    assert.ok(r.ink.length > 40, `${family}: ${expected} drew almost nothing`);
    sigs[family] = signature(r.ink, 1600, 900);
  }
  // ...and the pictures themselves differ, not only the label on them. These
  // are the pairs a listener would call obviously unrelated.
  const pairs = [
    ["frenchcore", "ambient"],
    ["techno", "rap"],
    ["synthwave", "dubstep"],
    ["psytrance", "metal"],
    ["jazz", "dnb"],
    ["hardstyle", "trance"],
  ];
  for (const [a, b] of pairs) {
    const d = sigDistance(sigs[a], sigs[b]);
    assert.ok(d > 0.3, `${a} and ${b} draw in the same places (distance ${d.toFixed(2)})`);
  }
});

test("every family the classifier can name has a world", () => {
  // A family added to style.js and forgotten here would silently fall back,
  // which is exactly the kind of gap nobody notices until a genre looks wrong.
  for (const f of FAMILY_LIST) {
    assert.ok(
      FAMILY_WORLD[f.id],
      `family "${f.id}" has no world (falls back to the archetype default)`
    );
    assert.ok(WORLDS[FAMILY_WORLD[f.id]], `family "${f.id}" points at an unknown world`);
  }
});

test("a change of genre is a dissolve, never a cut", () => {
  // The property the old layer engine had and this one must not lose: the
  // outgoing world keeps being drawn while the incoming one rises.
  const preset = tierPreset("high");
  const geometry = createGeometry();
  geometry.set(1280, 720, null);
  const scene = createScene("smart", { preset, layout: "full", intensity: 0.8 });
  const pal = createPalette("neon");
  const g = recorder(1280, 720);
  const dt = 1 / 60;
  const run = (style, seconds) => {
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      const f = makeFrame(i * dt, { style });
      pal.update(f, dt);
      scene.update(f, dt, geometry.out);
      scene.draw(g, 1280, 720, pal.out, geometry.out);
    }
  };
  run(styleOf({ sustain: 0.95 }, { motion: 0.06, smooth: 0.93 }, "ambient"), 3);
  assert.equal(scene.world, "nebula");
  assert.equal(scene.leaving, null);
  // One tenth of a second of the new genre: the old world must still be there.
  const hard = styleOf({ hard: 0.9 }, { motion: 0.96, chaos: 0.7 }, "frenchcore");
  run(hard, 0.2);
  assert.equal(scene.world, "shatter");
  assert.equal(scene.leaving, "nebula", "the outgoing world was cut instead of faded");
  run(hard, 2.5);
  assert.equal(scene.leaving, null, "the dissolve never finished");
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
