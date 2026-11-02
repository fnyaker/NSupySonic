// The client-side embedding (src/lib/analysis/embed.js): half-float packing against Python's
// struct "e", and the whole chain (front-end in the Rust core -> onnxruntime-web -> aggregation)
// on a tiny ONNX built here with the extractor's shapes and output layout (a 400-wide
// activations output BEFORE the 1280-wide embedding, as the published model has).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadMeasure } from "../src/lib/analysis/measure.js";
import { tinyModel } from "./tinyonnx.mjs";
import { embedSamples, encodeVector, toHalf, EMBED_DIM, MODEL_DIM } from "../src/lib/analysis/embed.js";

const here = dirname(fileURLToPath(import.meta.url));
const core = await loadMeasure(readFileSync(join(here, "../src/lib/measure/measure.wasm")));

test("half floats are the bits struct 'e' writes", () => {
  // from Python: struct.pack('<e', float32(v)), saturating at the largest finite half
  const table = [
    [1.0, 15360], [0.10000000149011612, 11878], [-2.0, 49152], [65504.0, 31743], [70000.0, 31744],
    [9.99999993922529e-9, 0], [5.99999978589949e-8, 1], [2.9999999242136255e-5, 503],
    [6.0999998822808266e-5, 1023], [0.3333333432674408, 13653], [9.999999747378752e-5, 1678],
    [2.499999993688107e-7, 4], [0.002458033850416541, 6409], [590.3871459960938, 24733],
    [8.446500032732729e-8, 1], [6.806962483096868e-5, 1142], [2.9794910005875863e-6, 50],
    [-0.7735880613327026, 47664], [0.07368908822536469, 11447], [8.752171516418457, 18528],
    [-5.01338581671007e-5, 33609], [-1.8369788676864118e-6, 32799], [0.08326907455921173, 11604],
    [-6.807915724493796e-7, 32779],
  ];
  for (const [v, bits] of table) assert.equal(toHalf(v), bits, String(v));
  assert.equal(toHalf(-0), 0x8000);
  assert.equal(toHalf(NaN) & 0x7c00, 0x7c00);
});

test("a vector is base64 of its halves, the server's sidecar layout", () => {
  const b = Buffer.from(encodeVector(Float32Array.of(1, -2, 0.5)), "base64");
  assert.deepEqual([...b], [0x00, 0x3c, 0x00, 0xc0, 0x00, 0x38]);
});

function tone(seconds) {
  const x = new Float32Array(16000 * seconds);
  for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin(i * 0.05) * (1 + 0.5 * Math.sin(i * 0.0003)) + 0.1 * Math.sin(i * 0.31);
  return x;
}

test("the whole chain gives the vector the front-end and the aggregation define", async () => {
  const ort = await import("onnxruntime-web/wasm");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { wasm: new URL("../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", import.meta.url).href };
  const session = await ort.InferenceSession.create(tinyModel(), { executionProviders: ["wasm"] });
  assert.deepEqual(session.outputNames, ["activations", "embedding"]);

  const samples = tone(40);
  const vec = await embedSamples(core, session, ort, samples);
  assert.equal(vec.length, EMBED_DIM);
  assert.ok(vec.every(Number.isFinite));

  // The same, worked out by hand from the core's own patches: the mean over the frame axis,
  // then the 96 -> 1280 matrix, then the core's aggregation.
  const count = core.mel_plan(samples.length);
  assert.ok(count > 5, `${count} patches`);
  for (let k = 0; k < count; k++) {
    new Float32Array(core.memory.buffer, core.mel_segment(k), 33024).set(
      samples.subarray(core.mel_offset(k), core.mel_offset(k) + 33024));
  }
  core.mel_run();
  const per = 128 * 96;
  const patches = new Float32Array(core.memory.buffer, core.mel_patches(), count * per).slice();
  const W = Float32Array.from({ length: 96 * 1280 }, (_, i) => Math.sin(i * 0.0137 + 1.1));
  const rows = new Float32Array(count * MODEL_DIM);
  for (let p = 0; p < count; p++) {
    const m = new Float64Array(96);
    for (let f = 0; f < 128; f++) for (let c = 0; c < 96; c++) m[c] += patches[p * per + f * 96 + c] / 128;
    for (let j = 0; j < MODEL_DIM; j++) {
      let s = 0;
      for (let c = 0; c < 96; c++) s += m[c] * W[c * 1280 + j];
      rows[p * MODEL_DIM + j] = s;
    }
  }
  new Float32Array(core.memory.buffer, core.mel_rows(), count * MODEL_DIM).set(rows);
  const want = new Float32Array(core.memory.buffer, core.mel_aggregate(), EMBED_DIM).slice();
  let worst = 0;
  for (let i = 0; i < EMBED_DIM; i++) worst = Math.max(worst, Math.abs(vec[i] - want[i]));
  // measured 4.7e-7 (float32 summation order in the network against float64 here); the stored
  // half floats resolve 1e-3
  assert.ok(worst < 1e-4, `worst difference ${worst}`);
});

test("a track too short for one patch is a named failure", async () => {
  const ort = await import("onnxruntime-web/wasm");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { wasm: new URL("../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", import.meta.url).href };
  const session = await ort.InferenceSession.create(tinyModel(), { executionProviders: ["wasm"] });
  await assert.rejects(embedSamples(core, session, ort, new Float32Array(100)), /too short/);
});
