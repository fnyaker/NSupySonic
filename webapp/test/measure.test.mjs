// The whole-track measures (webapp/measure → src/lib/measure/measure.wasm), WIP.
// Pins: the committed binary matches its source, a sine reads as a sine, and the
// loudness meter gives the figure BS.1770 defines for a known signal. Parity with
// ffmpeg and the Python twin is checked by tests/test_measure.py when a native
// build of the crate exists.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(join(here, "../src/lib/measure/measure.wasm"));
const { instance } = await WebAssembly.instantiate(bytes, {});
const x = instance.exports;

function fnv() {
  const dir = join(here, "../measure/src");
  let h = 0x811c9dc5;
  const add = (b) => {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (const n of readdirSync(dir).filter((n) => n.endsWith(".rs")).sort()) {
    for (const b of Buffer.from(n)) add(b);
    for (const b of readFileSync(join(dir, n))) add(b);
  }
  return h >>> 0;
}

function run(channels, rate) {
  assert.equal(x.ms_begin(channels.length, channels[0].length, rate), 1);
  channels.forEach((ch, i) => {
    new Float32Array(x.memory.buffer, x.ms_channel(i), ch.length).set(ch);
  });
  assert.equal(x.ms_run(), 1);
  return Object.fromEntries(
    ["centroid", "spread", "flatness", "flatness_hi", "entropy", "rolloff", "flux_peak", "lufs", "lra", "frames"].map(
      (k, i) => [k, x.ms_out(i)]
    )
  );
}

const sine = (f, amp, n, rate) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / rate));

test("the committed binary was built from the source next to it", () => {
  assert.equal(x.ms_src_hash() >>> 0, fnv(), "run `npm run wasm` and commit measure.wasm");
});

test("a sine reads as a sine", () => {
  const rate = 44100;
  const s = run([sine(1000, 0.1, rate * 4, rate)], rate);
  assert.ok(Math.abs(s.centroid - 1000) < 15, `centroid ${s.centroid}`);
  assert.ok(s.spread < 60, `spread ${s.spread}`);
  assert.ok(Math.abs(s.rolloff - 1000) < 60, `rolloff ${s.rolloff}`);
});

test("a 997 Hz sine at -20 dBFS in both channels is -20 LUFS (0 LUFS at full scale on two channels) and has no range", () => {
  const rate = 48000;
  const ch = sine(997, 0.1, rate * 6, rate);
  const s = run([ch, ch], rate);
  assert.ok(Math.abs(s.lufs + 20.0) < 0.1, `lufs ${s.lufs}`);
  assert.ok(s.lra < 0.2, `lra ${s.lra}`);
});

test("hostile sizes are refused, not trusted", () => {
  assert.equal(x.ms_begin(0, 10000, 44100), 0);
  assert.equal(x.ms_begin(2, 100, 44100), 0);
  assert.equal(x.ms_begin(2, 10000, 1), 0);
  assert.equal(x.ms_begin(99, 10000, 44100), 0);
});
