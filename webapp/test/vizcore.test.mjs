// The animations' arithmetic moved to Rust (webapp/rhythm/src/viz*.rs). This
// holds each piece to the JavaScript it replaced, kept as an ORACLE in
// test/reference/: both run side by side on the same material and must DRAW
// the same thing — every stroke's every point, recorded from the canvas calls
// — and the Rust has to be measurably faster, or there was no point moving it.
//
// The material is music, not a test tone alone: a pitched kick swept and
// clipped, a lead panned right, hats on the offbeats (the same instrument as
// viz.test.mjs), plus the steady tone, which is the one signal whose trace
// should not move at all.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { vizCoreFromBytes } from "../src/lib/viz/core.js";
import { createScopeScene } from "../src/lib/viz/scenes/scope.js";
import { createBarsScene } from "../src/lib/viz/scenes/bars.js";
import { createScopeScene as refScope } from "./reference/scope.js";
import { createBarsScene as refBars } from "./reference/bars.js";
import { tierPreset } from "../src/lib/viz/quality.js";
import { createGeometry } from "../src/lib/viz/geometry.js";
import { createPalette } from "../src/lib/viz/palette.js";

const core = vizCoreFromBytes(readFileSync(new URL("../src/lib/audio/rhythm.wasm", import.meta.url)));

// The scenes read the clock for their phosphor; both must see the same one, or
// the trigger marker (drawn only above a threshold of that exposure) appears in
// one and not the other.
let clockMs = 1000;
performance.now = () => clockMs;

// --- the material ------------------------------------------------------------------
const SR = 48000;
const LEN = SR * 4;
const musicL = new Float32Array(LEN * 2);
const musicR = new Float32Array(LEN * 2);
const toneSrc = new Float32Array(LEN * 2);
{
  let ph = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const beat = 60 / 174;
  for (let i = 0; i < LEN; i++) {
    const t = i / SR;
    const inBeat = t % beat;
    ph += (2 * Math.PI * (45 + 135 * Math.exp(-inBeat * 26))) / SR;
    const kick = Math.tanh(Math.sin(ph) * 3.2) * Math.exp(-inBeat * 9) * 0.75;
    const lead =
      (Math.sin(2 * Math.PI * 220 * t) * 0.5 + Math.sin(2 * Math.PI * 440 * t) * 0.22 + Math.sin(2 * Math.PI * 660 * t) * 0.11) * 0.32;
    const hat = rnd() * Math.exp(-((inBeat - beat / 2 + beat) % beat) * 90) * 0.12;
    musicL[i] = Math.max(-1, Math.min(1, kick + lead * 0.35 + hat));
    musicR[i] = Math.max(-1, Math.min(1, kick + lead + hat * 0.6));
    toneSrc[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.6;
  }
  musicL.copyWithin(LEN, 0, LEN);
  musicR.copyWithin(LEN, 0, LEN);
  toneSrc.copyWithin(LEN, 0, LEN);
}

function waveAt(t, size, tone = false) {
  const off = Math.floor(t * SR) % LEN;
  return {
    left: (tone ? toneSrc : musicL).subarray(off, off + size),
    right: (tone ? toneSrc : musicR).subarray(off, off + size),
    size,
    sampleRate: SR,
  };
}

function bandsAt(t) {
  const b = new Float32Array(120);
  for (let i = 0; i < 120; i++) b[i] = Math.min(1, 0.25 + 0.55 * Math.abs(Math.sin(i * 0.21 + t * 3.1)) * (0.6 + 0.4 * Math.sin(t * 7)));
  return b;
}

// A canvas that writes down every point of every path and every fill.
function recorder() {
  const ops = [];
  const grad = { addColorStop() {} };
  const g = {
    ops,
    createLinearGradient: () => grad,
    beginPath: () => ops.push("B"),
    moveTo: (x, y) => ops.push(x, y),
    lineTo: (x, y) => ops.push(x, y),
    quadraticCurveTo: (a, b, x, y) => ops.push(a, b, x, y),
    closePath() {},
    stroke: () => ops.push("S"),
    fill: () => ops.push("F"),
    clearRect() {},
    fillRect() {},
    fillText() {},
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: "",
    lineJoin: "",
    lineCap: "",
    font: "",
    textAlign: "",
    textBaseline: "",
  };
  return g;
}

function worstDiff(a, b) {
  assert.equal(a.length, b.length, "the two drew a different number of things");
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    if (typeof a[i] === "string" || typeof b[i] === "string") {
      assert.equal(a[i], b[i]);
      continue;
    }
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) worst = d;
  }
  return worst;
}

// --- the oscilloscope ------------------------------------------------------------------

test("the Rust scope draws what the JavaScript one drew, at every tier", () => {
  // Measured: the two agree to 0 px on every frame at every tier — the Rust
  // keeps the positions and the trigger filter in f64 exactly as JavaScript's
  // numbers were, so the trace comes out bit for bit.
  for (const tier of ["low", "medium", "high", "ultra"]) {
    for (const tone of [false, true]) {
      const preset = tierPreset(tier);
      const size = preset.scope.buffer;
      const geom = createGeometry();
      geom.set(1600, 900, { x: 600, y: 250, w: 400, h: 400 });
      const pal = createPalette("neon");
      const a = refScope({ preset, intensity: 0.8 });
      const b = createScopeScene({ preset, intensity: 0.8, core });
      a.resize(1600, 900, preset, geom.out);
      b.resize(1600, 900, preset, geom.out);
      assert.equal(a.cols, b.cols);
      let worst = 0;
      let worstGain = 0;
      for (let i = 0; i < 150; i++) {
        const t = i / 94;
        const f = { wave: i % 37 === 36 ? null : waveAt(t, size, tone) };
        a.update(f, 1 / 94);
        b.update(f, 1 / 94);
        worstGain = Math.max(worstGain, Math.abs(a.gain - b.gain), Math.abs(a.locked - b.locked));
        if (i % 5 === 0) {
          clockMs += 1000 / 60;
          const ga = recorder();
          const gb = recorder();
          a.draw(ga, 1600, 900, pal.out);
          b.draw(gb, 1600, 900, pal.out);
          worst = Math.max(worst, worstDiff(ga.ops, gb.ops));
        }
      }
      b.dispose();
      assert.ok(worst < 0.01, `${tier}${tone ? " tone" : ""}: the traces differ by ${worst.toFixed(4)} px`);
      assert.ok(worstGain < 1e-5, `${tier}: gain or lock differ by ${worstGain}`);
    }
  }
});

test("the Rust scope is faster than the JavaScript it replaced", () => {
  // Measured on this suite's machine (V8, the shipped baseline binary, the
  // high tier: 8192 samples a channel, 120 ms of trigger search, 1868
  // columns): JavaScript ~95 us an analysis frame, Rust ~40 us including the
  // copy of both channels into its memory. Held to "clearly faster" rather
  // than to a ratio, so a busy test machine cannot fail it.
  const preset = tierPreset("high");
  const size = preset.scope.buffer;
  const geom = createGeometry();
  geom.set(1920, 1080, null);
  const frames = Array.from({ length: 256 }, (_, i) => ({ wave: waveAt(i / 94, size) }));
  const time = (scene) => {
    scene.resize(1920, 1080, preset, geom.out);
    for (let i = 0; i < 400; i++) scene.update(frames[i & 255], 1 / 94);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 3000; i++) scene.update(frames[i & 255], 1 / 94);
    return Number(process.hrtime.bigint() - t0) / 1000 / 3000;
  };
  const js = time(refScope({ preset }));
  const b = createScopeScene({ preset, core });
  const rust = time(b);
  b.dispose();
  console.log(`# scope update, high tier: JavaScript ${js.toFixed(1)} us, Rust ${rust.toFixed(1)} us`);
  assert.ok(rust < js * 0.8, `Rust ${rust.toFixed(1)} us against JavaScript ${js.toFixed(1)} us`);
});

test("scopes do not share state: two on screen trigger independently", () => {
  const preset = tierPreset("high");
  const size = preset.scope.buffer;
  const geom = createGeometry();
  geom.set(1200, 700, null);
  const a = createScopeScene({ preset, core });
  const b = createScopeScene({ preset, core });
  a.resize(1200, 700, preset, geom.out);
  b.resize(1200, 700, preset, geom.out);
  for (let i = 0; i < 120; i++) {
    a.update({ wave: waveAt(i / 94, size, true) }, 1 / 94);
    b.update({ wave: null }, 1 / 94);
  }
  assert.ok(a.locked > 0.9, `the fed scope locked (${a.locked.toFixed(2)})`);
  assert.ok(b.locked < 0.01, `the idle one did not (${b.locked.toFixed(2)})`);
  a.dispose();
  b.dispose();
});

// --- the bars ------------------------------------------------------------------------

test("the Rust bars draw what the JavaScript ones drew", () => {
  // Measured: identical to within 1e-9 px — the levelling keeps JavaScript's
  // f64 arithmetic and stores the same f32 values it did.
  for (const tier of ["low", "high", "ultra"]) {
    for (const layout of ["full", "strip"]) {
      const preset = tierPreset(tier);
      const pal = createPalette("neon");
      const a = refBars({ layout });
      const b = createBarsScene({ layout, core });
      a.resize(1600, 400, preset);
      b.resize(1600, 400, preset);
      assert.equal(a.bars, b.bars);
      let worst = 0;
      for (let i = 0; i < 300; i++) {
        const t = i / 60;
        const f = { bands: bandsAt(t), features: { level: 0.4 + 0.3 * Math.sin(t) } };
        a.update(f, 1 / 60);
        b.update(f, 1 / 60);
        if (i % 7 === 0) {
          const ga = recorder();
          const gb = recorder();
          a.draw(ga, 1600, 400, pal.out);
          b.draw(gb, 1600, 400, pal.out);
          worst = Math.max(worst, worstDiff(ga.ops, gb.ops));
        }
      }
      assert.ok(Math.abs(a.level - b.level) < 1e-9, `${tier} ${layout}: level`);
      b.dispose();
      assert.ok(worst < 1e-3, `${tier} ${layout}: the bars differ by ${worst} px`);
    }
  }
});

// --- the musical reading and the GL scene ------------------------------------------------
//
// Fed what the analyser really says about real records: test/songs.mjs builds
// them the way each genre is produced (an intro with no kick, builds whose
// snares accelerate, the silence before a hardcore drop, a breakdown with no
// drums, a waltz's three-beat bar) and the shipped analyser reads them hop by
// hop, exactly as the AudioWorklet does. Each frame is decoded into the shape
// lib/audio/engine.js hands the animations.

import { Rhythm } from "../src/lib/audio/rhythm-core.js";
import { familyTable, familyAt, ARCHETYPES, LOOK_KEYS } from "../src/lib/audio/style.js";
import { ENERGY_BANDS } from "../src/lib/audio/spectrum.js";
import { SONG_BY_ID, SR as SONG_SR } from "./songs.mjs";
import { loadSong } from "./eval/rhythm-eval.mjs";
import { createMusical, LOOK_ORDER, GENRE_ORDER } from "../src/lib/viz/musical.js";
import { createMusical as refMusical } from "./reference/musical.js";
import { createGLScene } from "../src/lib/viz/scenes/gl.js";
import { createGLScene as refGLScene } from "./reference/gl.js";
import { loadWorld } from "../src/lib/viz/worlds/index.js";

const RHYTHM = new WebAssembly.Module(readFileSync(new URL("../src/lib/audio/rhythm.wasm", import.meta.url)));
const GENRE_KEYS = ["lead", "buzz", "screech", "sub", "offbeat", "density", "tail", "grit"];

const analysed = new Map();
/** A record's analysis, one frame object per hop: `{ frames, hop }`. */
function analyse(id, seconds = 0) {
  const key = `${id}:${seconds}`;
  if (analysed.has(key)) return analysed.get(key);
  const { pcm } = loadSong(SONG_BY_ID.get(id));
  const src = seconds ? pcm.subarray(0, Math.min(pcm.length, seconds * SONG_SR)) : pcm;
  const r = Rhythm.fromModule(RHYTHM, SONG_SR);
  r.loadFamilies(familyTable());
  r.setLevel(2);
  const F = r.layout.fields;
  const hop = r.hop / SONG_SR;
  const frames = [];
  for (let i = 0; i < src.length; i += 4096) {
    const n = r.push(src.subarray(i, Math.min(src.length, i + 4096)));
    for (let k = 0; k < n; k++) frames.push(decode(r.frame(k), F));
  }
  const out = { frames, hop };
  analysed.set(key, out);
  return out;
}

function decode(b, F) {
  const v = (n) => b[F[n][0]];
  const vec = (n) => b.slice(F[n][0], F[n][0] + F[n][1]);
  const energy = {};
  ENERGY_BANDS.forEach(([name], i) => (energy[name] = b[F.energy[0] + i]));
  const look = {};
  LOOK_KEYS.forEach((k, i) => (look[k] = b[F.look[0] + i]));
  const genre = {};
  GENRE_KEYS.forEach((k, i) => (genre[k] = b[F.genre[0] + i]));
  const dom = familyAt(Math.round(v("styleDominant")));
  let arche = 0;
  for (let i = 1; i < ARCHETYPES.length; i++) if (b[F.archetypes[0] + i] > b[F.archetypes[0] + arche]) arche = i;
  return {
    bands: vec("bands"),
    energy,
    features: {
      level: v("level"), dynamics: v("dynamics"), kick: v("kick"), kickHit: v("kickHit") > 0,
      midFlux: v("midFlux"), highFlux: v("highFlux"), centroidN: v("centroidN"),
      percussivity: v("percussivity"), chroma: vec("chroma"), melody: v("melody"),
      melodyPitch: v("melodyPitch"), melodyFlux: v("melodyFlux"), chordChange: v("chordChange"),
    },
    beat: {
      bpm: v("bpm"), phase: v("phase"), beat: v("beat") > 0, beatIndex: v("beatIndex"),
      barPos: v("barPos"), beatsPerBar: v("beatsPerBar") || 4, downbeat: v("downbeat") > 0,
      onset: v("onset"), period: v("period"), locked: v("locked") > 0,
    },
    pattern: {
      mainKick: v("mainKick") > 0, mainPower: v("mainPower"), bigKick: v("bigKick") > 0,
      rollKick: v("rollKick") > 0, roll: v("roll"), rollDiv: v("rollDiv"), drop: v("drop") > 0,
      sinceDrop: v("sinceDrop"), dropped: v("dropped"), breakdown: v("breakdown"), build: v("build"),
    },
    style: { dominant: dom ? dom.id : "", archetype: ARCHETYPES[arche], look },
    genre,
  };
}

// Every field of the reading, flattened: [name, value] in a fixed order.
function fieldsOf(m) {
  const out = [];
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === "function") continue;
    if (v && typeof v === "object") for (const [k2, v2] of Object.entries(v)) out.push([`${k}.${k2}`, v2]);
    else out.push([k, v]);
  }
  return out;
}

test("the Rust musical reading reads every record exactly as the JavaScript did", () => {
  // Five records chosen for what they put the reading through: frenchcore's
  // rolls, builds and drops; techno's steady grid; dubstep's half time; a
  // waltz, whose bar is THREE beats; ambient pads, with no beat to lock to.
  // Every analysis frame, a hitch now and then (a hidden tab brought back),
  // and every field compared after every frame.
  // Measured: every event, every boolean and every count identical on all
  // 25 302 frames (310 main kicks among them); the largest numeric difference
  // 0 — the clock's correction and every smoothing are the same f64
  // arithmetic in the same order, and V8's exp and the Rust one agreed on
  // every argument this material produced.
  let frames = 0;
  let worst = 0;
  let events = 0;
  for (const id of ["frenchcore-200", "techno-132", "dubstep-140", "waltz-3-4-160", "ambient-pads"]) {
    const { frames: fr, hop } = analyse(id);
    const a = refMusical();
    const b = createMusical();
    assert.deepEqual(fieldsOf(b).map(([k]) => k), fieldsOf(a).map(([k]) => k), "the two readings expose the same fields");
    for (let i = 0; i < fr.length; i++) {
      const dt = i % 500 === 499 ? 0.25 : hop;
      a.update(fr[i], dt);
      b.update(fr[i], dt);
      const fa = fieldsOf(a);
      const fb = fieldsOf(b);
      for (let k = 0; k < fa.length; k++) {
        const [name, va] = fa[k];
        const vb = fb[k][1];
        if (typeof va === "boolean") {
          assert.equal(vb, va, `${id} frame ${i}: ${name}`);
          if (va && name === "mainKick") events++;
          continue;
        }
        const d = Math.abs(va - vb) / Math.max(1, Math.abs(va));
        assert.ok(d < 1e-9, `${id} frame ${i}: ${name} ${va} against ${vb}`);
        if (d > worst) worst = d;
      }
    }
    frames += fr.length;
    b.dispose();
  }
  console.log(`# musical reading: ${frames} frames, ${events} main kicks, largest difference ${worst.toExponential(2)}`);
  assert.ok(events > 250, `the material has kicks in it (${events})`);
});

test("the look and genre orders are the analyser's own", () => {
  assert.deepEqual(LOOK_ORDER, LOOK_KEYS);
  assert.deepEqual(GENRE_ORDER, GENRE_KEYS);
});

// A renderer that draws nothing and writes down what each picture uploaded.
function recordingRenderer() {
  const pictures = [];
  const prog = () => ({ ready: true, failed: false });
  return {
    pictures,
    lost: false,
    gpuMs: 0,
    program: prog,
    worldTarget: () => ({ dispose() {} }),
    dataTexture: () => ({ upload() {}, dispose() {} }),
    setSize() {},
    setCover() {},
    clear() {},
    beginFrame(block, spec, row) {
      pictures.push({ block: Float32Array.from(block), spec: Uint8Array.from(spec), row: row ? Uint8Array.from(row) : null });
      return true;
    },
    drawWorld() {},
    present() {},
  };
}

/**
 * Both scenes, fed the same analysis on one simulated clock: analysis frames at
 * their hop, pictures at `fps`, the palette following the music the way the
 * host drives it.
 */
async function sideBySide(id, { world, flash = "soft", layout = "full", fps = 60, seconds = 0, dpr = 1, cover = true }) {
  const { frames, hop } = analyse(id, seconds);
  let simT = 0;
  const now = () => simT;
  const preset = tierPreset("high");
  const geom = createGeometry();
  geom.set(1600, 900, cover ? { x: 600, y: 180, w: 400, h: 400 } : null);
  const pal = createPalette("spectrum");
  const make = (factory) => {
    const r = recordingRenderer();
    const s = factory({ preset, fixed: world, flash, layout, fps, intensity: 0.8, now, core });
    s.attach(r);
    s.resize(1600, 900, preset, geom.out, dpr);
    return { s, r };
  };
  const A = make(refGLScene);
  const B = make(createGLScene);
  // The world's module loads asynchronously; both scenes wait for it together.
  simT = 0;
  pal.update(frames[0], hop);
  A.s.update(frames[0], hop);
  B.s.update(frames[0], hop);
  await loadWorld(world);
  await new Promise((r) => setImmediate(r));
  let i = 1;
  let nextDraw = hop / 2;
  while (i < frames.length) {
    const tu = i * hop;
    if (tu <= nextDraw) {
      simT = tu;
      const dt = i % 700 === 699 ? 0.25 : hop;
      pal.update(frames[i], dt);
      A.s.update(frames[i], dt);
      B.s.update(frames[i], dt);
      i++;
    } else {
      simT = nextDraw;
      A.s.draw(null, 1600, 900, pal.out, geom.out);
      B.s.draw(null, 1600, 900, pal.out, geom.out);
      nextDraw += 1 / fps;
    }
  }
  A.s.dispose();
  B.s.dispose();
  return { a: A.r.pictures, b: B.r.pictures };
}

function comparePictures(label, a, b) {
  assert.equal(b.length, a.length, `${label}: pictures`);
  assert.ok(a.length > 100, `${label}: only ${a.length} pictures`);
  let worst = 0;
  let floats = 0;
  let differing = 0;
  let specOff = 0;
  let rows = 0;
  for (let k = 0; k < a.length; k++) {
    const pa = a[k];
    const pb = b[k];
    assert.equal(pb.block.length, pa.block.length);
    for (let j = 0; j < pa.block.length; j++) {
      floats++;
      if (Object.is(pa.block[j], pb.block[j])) continue;
      differing++;
      const d = Math.abs(pa.block[j] - pb.block[j]) / Math.max(1, Math.abs(pa.block[j]));
      assert.ok(d < 1e-5, `${label} picture ${k}: block[${j}] ${pa.block[j]} against ${pb.block[j]}`);
      if (d > worst) worst = d;
    }
    for (let j = 0; j < pa.spec.length; j++) {
      const d = Math.abs(pa.spec[j] - pb.spec[j]);
      assert.ok(d <= 1, `${label} picture ${k}: spectrum texel ${j}`);
      specOff += d;
    }
    assert.equal(!!pb.row, !!pa.row, `${label} picture ${k}: a history row in one and not the other`);
    if (pa.row) {
      rows++;
      for (let j = 0; j < pa.row.length; j++) assert.ok(Math.abs(pa.row[j] - pb.row[j]) <= 1);
    }
  }
  return { pictures: a.length, floats, differing, worst, specOff, rows };
}

test("the Rust scene packs the block the JavaScript packed, picture by picture", async () => {
  // Two worlds, two layouts, the strobe on, the artwork in the frame and out
  // of it, the projector's pixel ratio: the whole uniform block, both
  // spectrum rows and every history row, compared on every picture.
  // Measured: 0 floats out of 1 065 904 differ over 9 517 pictures, and the
  // spectrum texture and all 1 283 history rows are byte-identical — the Rust
  // is the JavaScript's arithmetic, rounded where the JavaScript rounded.
  const runs = [
    ["frenchcore-200", { world: "forge", flash: "unleashed", seconds: 60 }],
    ["dubstep-140", { world: "spectrum", layout: "strip", dpr: 2, cover: false, seconds: 60 }],
    ["waltz-3-4-160", { world: "piano", fps: 144, seconds: 30 }],
  ];
  const lines = [];
  for (const [id, opt] of runs) {
    const { a, b } = await sideBySide(id, opt);
    const r = comparePictures(`${id} on ${opt.world}`, a, b);
    lines.push(`${opt.world}: ${r.pictures} pictures, ${r.differing}/${r.floats} floats differ (worst ${r.worst.toExponential(1)}), spectrum off by ${r.specOff}, ${r.rows} history rows`);
  }
  for (const l of lines) console.log(`# ${l}`);
});

test("the Rust reading and scene cost less than the JavaScript they replaced", async () => {
  // Measured on this suite's machine (V8, the shipped baseline binary, the
  // frenchcore record through the forge world, a renderer that draws nothing
  // so only the CPU side is timed), best of three:
  //   the reading alone        JavaScript 1.23 us a frame   Rust 0.60 us
  //   the scene, per frame     3.2 us                       2.5 us
  //   the scene, per picture   7.7 us                       4.5 us
  //   a second of use          765 us                       502 us
  // Of the Rust reading's 0.60 us, 0.25 is the arithmetic and the rest is
  // crossing into it and back: the frame written in, the reading copied out
  // into `m` — every store NAMED, since a store through a computed key is
  // V8's slow path and, looped over a list of keys, cost more than the whole
  // reading. Part of the picture's saving is JavaScript: the resolution
  // governor's median, sorted in place rather than Array.from + sort on
  // every picture (the most expensive line of the old draw without a GPU
  // timer), and no closure or view allocated per picture. Held to "clearly
  // cheaper" on a second of use (94 frames and 60 pictures), not to a ratio
  // per call, so a busy machine cannot fail it.
  const { frames, hop } = analyse("frenchcore-200", 60);
  const best = (fn) => Math.min(fn(), fn(), fn());
  const reading = (make) => () => {
    const m = make();
    for (let i = 0; i < 2000; i++) m.update(frames[i % frames.length], hop);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20000; i++) m.update(frames[i % frames.length], hop);
    const us = Number(process.hrtime.bigint() - t0) / 1000 / 20000;
    m.dispose?.();
    return us;
  };
  const jsReading = best(reading(refMusical));
  const rustReading = best(reading(createMusical));

  const quiet = () => ({
    lost: false, gpuMs: 0, program: () => ({ ready: true }), worldTarget: () => ({ dispose() {} }),
    dataTexture: () => ({ upload() {}, dispose() {} }), setSize() {}, setCover() {}, clear() {},
    beginFrame: () => true, drawWorld() {}, present() {},
  });
  async function scene(factory) {
    let simT = 0;
    const preset = tierPreset("high");
    const geom = createGeometry();
    geom.set(1600, 900, { x: 600, y: 180, w: 400, h: 400 });
    const pal = createPalette("spectrum");
    const s = factory({ preset, fixed: "forge", now: () => simT, fps: 60, intensity: 0.8, core });
    s.attach(quiet());
    s.resize(1600, 900, preset, geom.out, 1);
    s.update(frames[0], hop);
    await loadWorld("forge");
    await new Promise((r) => setImmediate(r));
    let up = 0n;
    let dr = 0n;
    let nu = 0;
    let nd = 0;
    let nextDraw = hop / 2;
    for (let pass = 0; pass < 3; pass++)
      for (let i = 1; i < frames.length; i++) {
        const tu = (pass * frames.length + i) * hop;
        while (nextDraw < tu) {
          simT = nextDraw;
          const t0 = process.hrtime.bigint();
          s.draw(null, 1600, 900, pal.out, geom.out);
          if (pass) (dr += process.hrtime.bigint() - t0), nd++;
          nextDraw += 1 / 60;
        }
        simT = tu;
        pal.update(frames[i], hop);
        const t0 = process.hrtime.bigint();
        s.update(frames[i], hop);
        if (pass) (up += process.hrtime.bigint() - t0), nu++;
      }
    s.dispose();
    return { update: Number(up) / 1000 / nu, draw: Number(dr) / 1000 / nd };
  }
  const runs = { js: [], rust: [] };
  for (let k = 0; k < 3; k++) {
    runs.js.push(await scene(refGLScene));
    runs.rust.push(await scene(createGLScene));
  }
  const least = (list, key) => Math.min(...list.map((r) => r[key]));
  const js = { update: least(runs.js, "update"), draw: least(runs.js, "draw") };
  const rust = { update: least(runs.rust, "update"), draw: least(runs.rust, "draw") };
  const perSecond = (c) => 94 * c.update + 60 * c.draw;
  console.log(
    `# reading ${jsReading.toFixed(2)} -> ${rustReading.toFixed(2)} us; scene per frame ${js.update.toFixed(2)} -> ${rust.update.toFixed(2)} us, ` +
      `per picture ${js.draw.toFixed(2)} -> ${rust.draw.toFixed(2)} us; a second of use ${perSecond(js).toFixed(0)} -> ${perSecond(rust).toFixed(0)} us`
  );
  assert.ok(rustReading < jsReading * 0.85, `the reading: Rust ${rustReading.toFixed(2)} us against ${jsReading.toFixed(2)} us`);
  assert.ok(perSecond(rust) < perSecond(js) * 0.85, `the scene: ${perSecond(rust).toFixed(0)} us a second against ${perSecond(js).toFixed(0)}`);
});
