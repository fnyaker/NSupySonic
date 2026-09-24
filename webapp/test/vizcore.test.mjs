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
