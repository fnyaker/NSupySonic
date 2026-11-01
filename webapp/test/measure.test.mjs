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

// -- the beat tracker, as a stream -------------------------------------------------------

function clicks(bpm, seconds, rate = 44100) {
  // a pitched kick on every beat over a little noise (deterministic)
  const n = Math.round(seconds * rate), out = new Float32Array(n);
  let s = 12345;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = 0.01 * (s / 0x7fffffff - 0.5);
  }
  const period = (60 / bpm) * rate, len = Math.round(0.12 * rate);
  for (let b = 0; b * period < n - len; b++) {
    const at = Math.round(b * period);
    for (let k = 0; k < len; k++) {
      const t = k / rate;
      out[at + k] += 0.8 * Math.sin(2 * Math.PI * (55 * t + 90 * 0.0011 * (1 - Math.exp(-t / 0.0011)))) * Math.exp(-k / 2500);
    }
  }
  return out;
}

function track(samples, chunk = 44100) {
  assert.equal(x.tp_begin(), 1);
  for (let at = 0; at < samples.length; at += chunk) {
    const part = samples.subarray(at, Math.min(samples.length, at + chunk));
    const ptr = x.tp_chunk(part.length);
    assert.ok(ptr !== 0);
    new Float32Array(x.memory.buffer, ptr, part.length).set(part);
    x.tp_push();
  }
  if (!x.tp_finish()) return null;
  return {
    bpm: x.tp_out(0), confidence: x.tp_out(1), doubled: x.tp_out(3) === 1,
    beats: Array.from({ length: x.tp_out(5) }, (_, i) => x.tp_beat(i)),
  };
}

test("a kick on every beat reads its tempo, whatever the chunking", () => {
  const a = clicks(132, 30);
  const one = track(a, 44100);
  const two = track(a, 3000);
  assert.ok(Math.abs(one.bpm - 132) < 0.05, `bpm ${one.bpm}`);
  assert.ok(one.confidence > 0.8, `confidence ${one.confidence}`);
  // the stream is the same however it is cut
  assert.equal(two.bpm, one.bpm);
  assert.deepEqual(two.beats, one.beats);
  // beats land on the kicks (every 60/132 s, within a frame)
  const gap = one.beats.slice(1).map((b, i) => b - one.beats[i]);
  assert.ok(gap.every((g) => Math.abs(g - 60 / 132) < 0.03));
});

test("no beat gives no tempo, and a hostile chunk is refused", () => {
  assert.equal(track(new Float32Array(44100 * 10)), null);
  assert.equal(x.tp_chunk(0), 0);
  assert.equal(x.tp_chunk((1 << 20) + 1), 0);
});

// -- the extractor's front-end and aggregation -------------------------------------------

function melPatches(samples) {
  const n = x.mel_plan(samples.length);
  for (let k = 0; k < n; k++) {
    const at = x.mel_offset(k);
    new Float32Array(x.memory.buffer, x.mel_segment(k), 33024).set(samples.subarray(at, at + 33024));
  }
  assert.equal(x.mel_run(), n ? 1 : 0);
  return n;
}

test("a track yields patches spread over it, log-mel shaped and finite", () => {
  const rate = 16000, s = new Float32Array(rate * 90);
  for (let i = 0; i < s.length; i++) s[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate) * (i % (rate * 2) < rate ? 1 : 0.2);
  const n = melPatches(s);
  assert.ok(n >= 20 && n <= 60, `patches ${n}`);
  assert.equal(x.mel_offset(0), 0);
  assert.ok(x.mel_offset(n - 1) <= s.length - 33024);
  const p = new Float32Array(x.memory.buffer, x.mel_patches(), n * 128 * 96);
  assert.ok(p.every(Number.isFinite));
  assert.ok(p.some((v) => v > 1), "a loud tone reaches the log scale's upper range");
});

test("too short or absurdly long a track is refused", () => {
  assert.equal(x.mel_plan(1000), 0);
  assert.equal(x.mel_plan(0xffffffff), 0);
});

test("the stored vector is 3840 numbers: unit mean+spread block, then the loud half", () => {
  const rate = 16000, s = new Float32Array(rate * 60);
  for (let i = 0; i < s.length; i++) s[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / rate);
  const n = melPatches(s);
  const rows = new Float32Array(x.memory.buffer, x.mel_rows(), n * 1280);
  let seed = 7;
  for (let i = 0; i < rows.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; rows[i] = seed / 0x7fffffff - 0.5; }
  const v = new Float32Array(x.memory.buffer, x.mel_aggregate(), 3840).slice();
  const norm = (a) => Math.sqrt(a.reduce((t, e) => t + e * e, 0));
  assert.ok(Math.abs(norm(v.subarray(0, 2560)) - 1) < 1e-4, "the v2 vector is unit");
  assert.ok(Math.abs(norm(v.subarray(2560)) - norm(v.subarray(0, 1280))) < 1e-4, "the loud block weighs what the mean block does");
});
