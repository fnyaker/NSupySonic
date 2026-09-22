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

import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { createGeometry } from "../src/lib/viz/geometry.js";
import { createScene, MODES, effectiveMode, levelFor } from "../src/lib/viz/index.js";
import { tierPreset, TIERS } from "../src/lib/viz/quality.js";
import { createPalette } from "../src/lib/viz/palette.js";
import { LOOK_KEYS, FAMILY_LIST } from "../src/lib/audio/style.js";
import { WORLDS } from "../src/lib/viz/worlds/index.js";
import { hasGenreScene } from "../src/lib/viz/genres/index.js";
import { SKINS, skinId, skinFor, skinCount } from "../src/lib/viz/skins.js";

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


// The scene modules are CODE-SPLIT in the app (lib/viz/index.js loads them on
// demand so a launch with animations off does not parse a third of a megabyte
// of them), which makes `createScene` a promise. These checks are about what
// the scenes DRAW, not about how they are fetched, so they load once here and
// stay synchronous. The loader's own contract is pinned separately, below.
const SCENE_FACTORY = {
  bars: (await import("../src/lib/viz/scenes/bars.js")).createBarsScene,
  pulse: (await import("../src/lib/viz/scenes/pulse.js")).createPulseScene,
  aurora: (await import("../src/lib/viz/scenes/aurora.js")).createAuroraScene,
  smart: (await import("../src/lib/viz/scenes/smart.js")).createSmartScene,
};
const makeScene = (mode, opts) => (SCENE_FACTORY[mode] ? SCENE_FACTORY[mode](opts) : null);

// Run a scene for a while and return where it drew.
function paint(mode, { w, h, occl = null, style = null, tier = "high", seconds = 6 } = {}) {
  const preset = tierPreset(tier);
  const geometry = createGeometry();
  geometry.set(w, h, occl);
  const scene = makeScene(mode, { preset, layout: "full", intensity: 0.8 });
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
  // picture at different brightness. A family now maps either to its OWN
  // animation (`lib/viz/genres/`, where the id is the genre itself) or, for the
  // long tail, to a world it shares — and neither kind is a variation on the
  // others. The expected value below is whichever applies.
  const cases = {
    frenchcore: ["frenchcore", { motion: 0.96, density: 0.85, punch: 0.98, smooth: 0.12, warm: 0.82, melodic: 0.15, chaos: 0.7 }, { hard: 0.9 }],
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
    zaag: ["zaag", { motion: 0.86, density: 0.78, punch: 0.88, warm: 0.26, melodic: 0.34, chaos: 0.5 }, { hard: 0.88 }],
    hardstyle: ["hardbounce", { motion: 0.78, punch: 0.95, warm: 0.62, melodic: 0.45, chaos: 0.3 }, { hard: 0.9 }],
    trance: ["starfield", { motion: 0.62, density: 0.7, warm: 0.3, smooth: 0.72, melodic: 0.84 }, { groove: 0.5, sustain: 0.5 }],
  };
  const sigs = {};
  for (const [family, [expected, look, arche]] of Object.entries(cases)) {
    const r = paint("smart", {
      w: 1600, h: 900, seconds: 9,
      style: styleOf(arche, look, family),
    });
    assert.equal(r.scene.world, expected, `${family} did not land on its own animation`);
    assert.equal(
      r.scene.kind,
      hasGenreScene(family) ? "genre" : "world",
      `${family} should be drawn by its ${hasGenreScene(family) ? "own file" : "world"}`
    );
    assert.equal(r.scene.skin, family, `${family} was dressed as ${r.scene.skin}`);
    assert.ok(r.ink.length > 40, `${family}: ${expected} drew almost nothing`);
    sigs[family] = signature(r.ink, 1600, 900);
  }
  // ...and the pictures themselves differ, not only the label on them. These
  // are the pairs a listener would call obviously unrelated.
  const pairs = [
    ["frenchcore", "ambient"],
    ["zaag", "house"],
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

test("every family the classifier can name has its own skin", () => {
  // A family added to style.js and forgotten here would silently fall back,
  // which is exactly the kind of gap nobody notices until a genre looks wrong.
  for (const f of FAMILY_LIST) {
    const id = skinId(f.id);
    assert.ok(id, `family "${f.id}" has no skin`);
    assert.ok(WORLDS[SKINS[id].world], `family "${f.id}" points at an unknown world`);
    // ...and its LABEL resolves to the same PICTURE, because that is what a
    // hand-applied tag from the genre studio actually carries. The id and the
    // label may be two names for one sound ("garage" / "UK garage"), so what
    // has to match is the world, not the row.
    const byLabel = skinId(f.label);
    assert.ok(byLabel, `the label of "${f.id}" ("${f.label}") resolves to nothing`);
    assert.equal(
      SKINS[byLabel].world,
      SKINS[id].world,
      `"${f.label}" and "${f.id}" land in different worlds`
    );
  }
});

test("the catalogue is far wider than the detector, and every row is usable", () => {
  // The point of the skin table: the live classifier can only name what six
  // descriptors separate, but a tag or a trained model can name a sub-genre,
  // and that sub-genre should not fall back to its parent's picture.
  assert.ok(skinCount() > 150, `only ${skinCount()} genres are dressed`);
  for (const [id, sk] of Object.entries(SKINS)) {
    assert.ok(WORLDS[sk.world], `${id}: unknown world ${sk.world}`);
    for (const k of ["hue", "sat", "light", "speed", "energy"]) {
      if (sk[k] === undefined) continue;
      assert.ok(Number.isFinite(sk[k]), `${id}: ${k} is not a number`);
    }
    if (sk.sat !== undefined) assert.ok(sk.sat > 0 && sk.sat <= 2, `${id}: sat ${sk.sat}`);
    if (sk.speed !== undefined) assert.ok(sk.speed > 0 && sk.speed <= 3, `${id}: speed ${sk.speed}`);
    // Most parameters are multipliers around 1; a few are counts (the number of
    // sides on a corridor) and a few are SIGNED, because the thing they set is
    // a direction — a corridor whose rings recede, a grid that scrolls the
    // other way. All of them are bounded: a typo of 400 would allocate an array
    // that size.
    for (const v of Object.values(sk.p || {}))
      assert.ok(Number.isFinite(v) && v >= -64 && v <= 64, `${id}: odd parameter ${v}`);
  }
  // Every world is actually reached by something — a world nothing selects is
  // dead code that still has to be maintained.
  const used = new Set(Object.values(SKINS).map((x) => x.world));
  for (const w of Object.keys(WORLDS))
    assert.ok(used.has(w), `no genre uses the "${w}" world`);
});

test("a name arrives however it likes and still finds its skin", () => {
  assert.equal(skinId("Drum & Bass"), "dnb");
  assert.equal(skinId("drum and bass"), "dnb");
  assert.equal(skinId("Psytrance"), "psytrance");
  assert.equal(skinId("PSY"), "psytrance");
  assert.equal(skinId("Cordes / classique"), "strings");
  assert.equal(skinId("Hard pingpong"), "hardpingpong");
  assert.equal(skinId("musique classique"), "classical");
  assert.equal(skinId("8-bit"), "eightbit");
  // Unknown names still dress the scene rather than leaving it blank.
  assert.equal(skinId("a genre nobody has named", "hard"), "hardstyle");
  assert.ok(WORLDS[skinFor("total nonsense").world]);
});

test("two genres sharing a world still draw differently", () => {
  // The second half of the answer. Thirteen worlds cannot cover two hundred
  // genres on their own; what separates gabber from speedcore is the skin —
  // seven big slabs and a strobe against twenty splinters — and if that came
  // out identical the catalogue would be decoration.
  const pairs = [
    [["hardstyle", { chaos: 0.3, motion: 0.78, punch: 0.95 }, { hard: 0.9 }],
     ["rawstyle", { chaos: 0.45, motion: 0.8, punch: 1 }, { hard: 0.92 }]],
    [["techno", { chaos: 0.2, motion: 0.66 }, { groove: 0.85 }],
     ["acidtechno", { chaos: 0.35, motion: 0.8 }, { groove: 0.8 }]],
    [["liquiddnb", { chaos: 0.2, motion: 0.85 }, { groove: 0.6, hard: 0.4 }],
     ["drumfunk", { chaos: 0.5, motion: 0.95 }, { hard: 0.6, groove: 0.4 }]],
    [["classical", { melodic: 0.95, smooth: 0.9 }, { sustain: 0.95 }],
     ["gospel", { melodic: 0.9, smooth: 0.8, warm: 0.8 }, { voice: 0.6, sustain: 0.4 }]],
  ];
  for (const [[a, la, aa], [b, lb, ab]] of pairs) {
    const ra = paint("smart", { w: 1600, h: 900, seconds: 8, style: styleOf(aa, la, a) });
    const rb = paint("smart", { w: 1600, h: 900, seconds: 8, style: styleOf(ab, lb, b) });
    assert.equal(ra.scene.world, rb.scene.world, `${a}/${b} should share a world`);
    assert.notEqual(ra.scene.skin, rb.scene.skin);
    const d = sigDistance(signature(ra.ink, 1600, 900), signature(rb.ink, 1600, 900));
    assert.ok(d > 0.08, `${a} and ${b} came out identical (distance ${d.toFixed(3)})`);
  }
});

test("place() hands back one shared array, and the scenes know it", () => {
  // Pinning the contract rather than the consequence. `place` reuses a single
  // pair to keep a 94 Hz loop out of the garbage collector, so two results held
  // at once are the same array — and a scene that forgets draws a zero-length
  // segment, which throws nothing, logs nothing and simply is not there. It
  // cost a dashed corridor, a tonearm, a hi-hat ring, a set of spokes and a web
  // before anyone noticed, so the sharp edge is written down here.
  const geometry = createGeometry();
  geometry.set(1600, 900, null);
  const g = geometry.out;
  const a = g.place(0, 1);
  const first = [a[0], a[1]];
  const b = g.place(Math.PI, 1);
  assert.equal(a, b, "place no longer shares its buffer — update the scenes' comments");
  assert.notDeepEqual(first, [b[0], b[1]], "two different angles gave the same point");
});

test("every genre the studio offers is a genre the animation can dress", () => {
  // The two halves of the vocabulary are written in different languages and
  // have to agree: `analysis.known_genres()` is what the genre studio offers an
  // admin to tag with, and this table is what the animation does with the tag
  // that comes back. A label the studio offers and the engine cannot resolve is
  // a track that gets tagged carefully and then animated generically, which is
  // the exact failure this whole catalogue exists to fix — and nothing else in
  // either suite would catch it, because neither side is wrong on its own.
  const py = readFileSync(
    new URL("../../supysonic/deezer/analysis.py", import.meta.url),
    "utf8"
  );
  const block = py.match(/EXTRA_GENRES = \[([\s\S]*?)\n\]/);
  assert.ok(block, "EXTRA_GENRES is no longer where this test looks for it");
  const rows = [...block[1].matchAll(/\("([^"]+)",\s*"([a-z]+)"\)/g)];
  assert.ok(rows.length > 100, `only ${rows.length} extra genres parsed`);
  const orphans = [];
  for (const [, label] of rows) if (!skinId(label)) orphans.push(label);
  assert.deepEqual(orphans, [], `no skin for: ${orphans.join(", ")}`);

  // And the other direction, at the level that matters: the archetypes the
  // studio files them under are the ones the fallback knows.
  const arches = new Set(rows.map((r) => r[2]));
  for (const a of arches)
    assert.ok(skinId("a name nothing will ever match", a), `no fallback for archetype ${a}`);
});

test("a shape switch, not a multiplier, is what separates neighbours", () => {
  // The stronger version of the test above, and the one that pins the thing
  // that was missing: both sides are painted with the SAME look vector and the
  // same archetype, so the classifier is telling the two worlds exactly the
  // same story and the only difference left is the skin's shape switch. A
  // catalogue that only scaled things would fail every line of this.
  const pairs = [
    ["dubstep", "riddim"],        // a sine LFO against a square gate
    ["garage", "breakbeat"],      // columns against strips
    ["hardstyle", "pieep"],       // a streak lead against a stepped arpeggio

    ["punk", "doom"],             // lit from the front, or from behind
    ["ambient", "drone"],         // clouds against curtains
    ["downtempo", "dub"],         // a delay receding against one bouncing
    ["piano", "choral"],          // parallel shafts against a vault
    ["psytrance", "goa"],         // a kaleidoscope against a pinwheel
    ["idm", "chiptune"],          // a smooth grid against a two-level one
    ["techno", "minimal"],        // a corridor rushing at you, or away
    ["reggae", "samba"],          // a groove that never resolves, and one that does
  ];
  const look = { motion: 0.6, density: 0.6, punch: 0.6, smooth: 0.5, warm: 0.5, melodic: 0.5, chaos: 0.4 };
  const arche = { groove: 0.6, hard: 0.4 };
  for (const [a, b] of pairs) {
    const ra = paint("smart", { w: 1600, h: 900, seconds: 8, style: styleOf(arche, look, a) });
    const rb = paint("smart", { w: 1600, h: 900, seconds: 8, style: styleOf(arche, look, b) });
    assert.equal(ra.scene.world, rb.scene.world, `${a}/${b} should share a world`);
    const d = sigDistance(signature(ra.ink, 1600, 900), signature(rb.ink, 1600, 900));
    // The closest pair measures 0.22 and most are several times that, so the
    // bar is set where a real regression (a switch that stopped being read)
    // would land rather than where today's numbers happen to sit.
    assert.ok(d > 0.15, `${a} and ${b} draw in the same places (distance ${d.toFixed(3)})`);
  }

  // `vinyl` is deliberately not in that list, and the reason is worth writing
  // down. Its motif is ONE disc filling the frame, so everything it draws —
  // the tonearm, the hi-hat spokes, a warped groove — lands inside the same
  // footprint and an 8x8 histogram of where the ink fell cannot see any of it.
  // How MUCH ink there is can: boom bap is played off a deck (a tonearm, no
  // machine hats) and trap is programmed (sixteen spokes, no deck), so the two
  // put down measurably different amounts of it. Fitting the spatial threshold
  // to this pair instead would have cost the eleven pairs above their teeth.
  const ink = (g) =>
    paint("smart", { w: 1600, h: 900, seconds: 8, style: styleOf(arche, look, g) }).ink.length;
  const bap = ink("boombap");
  const trp = ink("trap");
  assert.ok(
    Math.abs(bap - trp) / Math.max(bap, trp) > 0.05,
    `boom bap and trap lay down the same ink (${bap} vs ${trp})`
  );
});

test("a change of genre is a dissolve, never a cut", () => {
  // The property the old layer engine had and this one must not lose: the
  // outgoing world keeps being drawn while the incoming one rises.
  const preset = tierPreset("high");
  const geometry = createGeometry();
  geometry.set(1280, 720, null);
  const scene = makeScene("smart", { preset, layout: "full", intensity: 0.8 });
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
  // ...and the incoming one is a DEDICATED animation, which is the case worth
  // pinning: the crossfade must not care which kind it is dissolving between.
  const hard = styleOf({ hard: 0.9 }, { motion: 0.96, chaos: 0.7 }, "frenchcore");
  run(hard, 0.2);
  assert.equal(scene.world, "frenchcore");
  assert.equal(scene.kind, "genre");
  assert.equal(scene.leaving, "nebula", "the outgoing world was cut instead of faded");
  run(hard, 4);
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

test("the scene loader hands back the same scenes, on demand", async () => {
  // The app never imports a scene statically: `createScene` fetches the module
  // the first time a mode is asked for. What must hold is that every mode in
  // the registry can still be built, that the promise resolves to a real scene,
  // and that "off" stays the one mode with nothing behind it — a launch with
  // animations off must not fetch anything at all.
  for (const m of MODES) {
    const p = createScene(m.id, { preset: tierPreset("high"), layout: "full", intensity: 0.8 });
    if (m.id === "off") {
      assert.equal(p, null, "the off mode must not load a scene");
      continue;
    }
    assert.ok(p && typeof p.then === "function", `${m.id} did not return a promise`);
    const scene = await p;
    assert.equal(typeof scene?.update, "function", `${m.id} has no update()`);
    assert.equal(typeof scene?.draw, "function", `${m.id} has no draw()`);
  }
  // Asked for twice, the module is fetched once: the second call resolves to a
  // NEW scene built from the SAME factory, not to a second download.
  const opts = { preset: tierPreset("high"), layout: "full", intensity: 0.8 };
  const [a, b] = await Promise.all([createScene("smart", opts), createScene("smart", opts)]);
  assert.ok(a && b && a !== b, "each call must build its own scene");
});

test("every world in the registry is in the catalogue, and the reverse", async () => {
  // The registry (worlds/index.js, which pulls in all eighteen scene modules)
  // and the catalogue (worlds/catalogue.js, which is just names and trails) are
  // separate files so that naming a world costs nothing. They have to agree.
  const { WORLDS } = await import("../src/lib/viz/worlds/index.js");
  const { WORLD_META } = await import("../src/lib/viz/worlds/catalogue.js");
  assert.deepEqual(Object.keys(WORLDS).sort(), Object.keys(WORLD_META).sort());
  for (const [id, w] of Object.entries(WORLDS)) {
    assert.equal(w.label, WORLD_META[id].label, `${id}: the labels differ`);
    assert.equal(w.trail, WORLD_META[id].trail, `${id}: the trails differ`);
    assert.equal(typeof w.make, "function", `${id} has no factory`);
  }
});
