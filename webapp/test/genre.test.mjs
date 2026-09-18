// The genre head: the trainers, and the wire format the server reads back.
//
// No dependency to install — `npm test` runs this with node's own runner. The
// wasm kernel is loaded straight off disk, the way the worker loads it from a
// URL in the browser.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { trainHead, encodeHead, decodeEmbedding } from "../src/lib/genre/train.js";
import { trainDeep, loadKernel } from "../src/lib/genre/deep.js";

const KERNEL = readFileSync(
  fileURLToPath(new URL("../src/lib/genre/wasm/kernel.wasm", import.meta.url))
);

function mkrand(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Well-separated clusters — what a working embedding hands the trainer. */
function clusters(C, perClass, d, noise, seed = 1) {
  const rand = mkrand(seed);
  const centres = [];
  for (let c = 0; c < C; c++) {
    const v = new Float32Array(d);
    for (let i = 0; i < d; i++) v[i] = rand() * 2 - 1;
    let n = 0;
    for (let i = 0; i < d; i++) n += v[i] * v[i];
    n = Math.sqrt(n);
    for (let i = 0; i < d; i++) v[i] /= n;
    centres.push(v);
  }
  const n = C * perClass;
  const X = new Float32Array(n * d);
  const y = new Int32Array(n);
  let k = 0;
  for (let c = 0; c < C; c++)
    for (let j = 0; j < perClass; j++) {
      for (let i = 0; i < d; i++)
        X[k * d + i] = centres[c][i] + (rand() * 2 - 1) * noise;
      y[k] = c;
      k++;
    }
  return { X, y, n, d, labels: Array.from({ length: C }, (_, i) => "g" + i) };
}

/**
 * Two lobes per class, mirrored through the origin: the class is WHICH pair of
 * lobes, so no single plane per class can pick one out. This is the shape a
 * subgenre pair has — the same region of the embedding, folded.
 */
function folded(C, perClass, d, noise, seed = 3) {
  const rand = mkrand(seed);
  const dirs = [];
  for (let c = 0; c < 3; c++) {
    const v = new Float32Array(d);
    for (let i = 0; i < d; i++) v[i] = rand() * 2 - 1;
    let n = 0;
    for (let i = 0; i < d; i++) n += v[i] * v[i];
    n = Math.sqrt(n);
    for (let i = 0; i < d; i++) v[i] /= n;
    dirs.push(v);
  }
  const [a, b, c3] = dirs;
  const n = C * perClass;
  const X = new Float32Array(n * d);
  const y = new Int32Array(n);
  let k = 0;
  for (let c = 0; c < C; c++) {
    const s1 = c & 1 ? 1 : -1;
    const s2 = c & 2 ? 1 : -1;
    const s3 = c & 4 ? 1 : -1;
    for (let j = 0; j < perClass; j++) {
      const flip = j % 2 ? -1 : 1;
      for (let i = 0; i < d; i++)
        X[k * d + i] =
          flip * (s1 * a[i] + s2 * b[i] + s3 * c3[i]) * 0.6 + (rand() * 2 - 1) * noise;
      y[k] = c;
      k++;
    }
  }
  return { X, y, n, d, labels: Array.from({ length: C }, (_, i) => "g" + i) };
}

// -- the linear head --------------------------------------------------------

test("the linear head separates well-separated genres", async () => {
  const data = clusters(6, 20, 256, 0.08, 7);
  const head = await trainHead(data, null, { proj: 0, epochs: 40, folds: 3 });
  assert.equal(head.kind, "linear");
  assert.ok(
    head.metrics.balanced > 0.95,
    `balanced accuracy was ${head.metrics.balanced}`
  );
  assert.equal(head.W.length, data.labels.length * data.d);
  assert.equal(head.b.length, data.labels.length);
});

test("the confusion matrix accounts for every held-out example", async () => {
  const data = clusters(5, 12, 128, 0.2, 11);
  const head = await trainHead(data, null, { proj: 0, epochs: 20, folds: 3 });
  let total = 0;
  for (const row of head.metrics.confusion) for (const v of row) total += v;
  // Every row is held out exactly once across the folds.
  assert.equal(total, data.n);
  assert.equal(head.metrics.confusion.length, data.labels.length);
});

test("class weights keep a rare genre from being written off", async () => {
  // Forty of one, four of the other: unweighted, the cheapest model answers
  // "the common one" every time and scores 0.91 while being useless.
  const big = clusters(2, 40, 96, 0.1, 5);
  const keep = [];
  for (let i = 0; i < big.n; i++) if (big.y[i] === 0 || i % 10 === 0) keep.push(i);
  const X = new Float32Array(keep.length * big.d);
  const y = new Int32Array(keep.length);
  keep.forEach((src, i) => {
    X.set(big.X.subarray(src * big.d, (src + 1) * big.d), i * big.d);
    y[i] = big.y[src];
  });
  const head = await trainHead(
    { X, y, n: keep.length, d: big.d, labels: big.labels },
    null,
    { proj: 0, epochs: 40, folds: 2 }
  );
  const rare = head.metrics.perClass.find((c) => c.label === "g1");
  assert.ok(rare.recall > 0.5, `rare-class recall was ${rare.recall}`);
});

// -- the wire format --------------------------------------------------------

test("encodeHead round-trips a linear head through float16", () => {
  const head = {
    kind: "linear",
    W: Float32Array.from([1, -0.5, 0.25, 2]),
    b: Float32Array.from([0.125, -1]),
  };
  const back = decodeEmbedding(encodeHead(head));
  assert.equal(back.length, 6);
  // These all have exact float16 representations, so the round trip is exact.
  assert.deepEqual(Array.from(back), [1, -0.5, 0.25, 2, 0.125, -1]);
});

test("encodeHead lays an MLP out as W1, b1, W2, b2", () => {
  const head = {
    kind: "mlp",
    W1: Float32Array.from([1, 2, 3, 4]),
    b1: Float32Array.from([0.5, 0.25]),
    W2: Float32Array.from([8, 16]),
    b2: Float32Array.from([-2]),
  };
  const back = decodeEmbedding(encodeHead(head));
  assert.deepEqual(Array.from(back), [1, 2, 3, 4, 0.5, 0.25, 8, 16, -2]);
});

test("encodeHead lays a two-layer MLP out as W1,b1,W2,b2,W3,b3", () => {
  const head = {
    kind: "mlp2",
    W1: Float32Array.from([1, 2]),
    b1: Float32Array.from([0.5]),
    W2: Float32Array.from([3]),
    b2: Float32Array.from([0.25]),
    W3: Float32Array.from([4]),
    b3: Float32Array.from([-1]),
  };
  const back = decodeEmbedding(encodeHead(head));
  assert.deepEqual(Array.from(back), [1, 2, 0.5, 3, 0.25, 4, -1]);
});

test("a big head survives encoding (no argument-count overflow)", () => {
  // String.fromCharCode.apply blows the stack past ~100k arguments, which a
  // 128x1280 first layer is well past — this is the chunking, pinned.
  const W = new Float32Array(128 * 1280);
  for (let i = 0; i < W.length; i++) W[i] = ((i % 17) - 8) / 8;
  const blob = encodeHead({ kind: "linear", W, b: new Float32Array(8) });
  const back = decodeEmbedding(blob);
  assert.equal(back.length, W.length + 8);
  assert.equal(back[0], W[0]);
  assert.equal(back[W.length - 1], W[W.length - 1]);
});

// -- the wasm kernel --------------------------------------------------------

test("the arena never overlaps the module's own stack", async () => {
  const K = await loadKernel(KERNEL, 4096);
  const heapBase = K.exports.__heap_base.value | 0;
  const first = K.alloc(16) << 2; // back to a byte offset
  assert.ok(
    first >= heapBase,
    `arena started at ${first}, below __heap_base ${heapBase}`
  );
});

test("the kernel's forward pass is a dot product plus a bias", async () => {
  const K = await loadKernel(KERNEL, 1024);
  const cols = 5;
  const rows = 2;
  const W = K.alloc(rows * cols);
  const b = K.alloc(rows);
  const x = K.alloc(cols);
  const out = K.alloc(rows);
  const m = K.f32;
  // Row 0 sums x; row 1 doubles the first element only. Both include the tail
  // the four-accumulator loop has to pick up (cols is not a multiple of four).
  for (let c = 0; c < cols; c++) m[W + c] = 1;
  for (let c = 0; c < cols; c++) m[W + cols + c] = c === 0 ? 2 : 0;
  m[b] = 10;
  m[b + 1] = -1;
  for (let c = 0; c < cols; c++) m[x + c] = c + 1; // 1..5, sum 15
  K.exports.fwd(W << 2, b << 2, x << 2, out << 2, rows, cols);
  assert.equal(K.f32[out], 25);
  assert.equal(K.f32[out + 1], 1);
});

test("adam moves a parameter downhill and clears the gradient", async () => {
  const K = await loadKernel(KERNEL, 1024);
  const p = K.alloc(2);
  const mm = K.alloc(2);
  const v = K.alloc(2);
  const g = K.alloc(2);
  const mem = K.f32;
  mem[p] = 1;
  mem[p + 1] = 1;
  mem[g] = 1; // positive gradient -> the parameter must come down
  mem[g + 1] = -1; // negative -> it must go up
  K.exports.adam(p << 2, mm << 2, v << 2, g << 2, 2, 1, 0.1, 0, 0.1, 0.001);
  const after = K.f32;
  assert.ok(after[p] < 1, `p0 went to ${after[p]}`);
  assert.ok(after[p + 1] > 1, `p1 went to ${after[p + 1]}`);
  // The gradient buffer is zeroed in place: nothing else does it, so a leftover
  // would silently accumulate across every minibatch.
  assert.equal(after[g], 0);
  assert.equal(after[g + 1], 0);
});

// -- the deep head ----------------------------------------------------------

test("the deep head matches the linear one where a plane is enough", async () => {
  const data = clusters(5, 16, 256, 0.08, 9);
  const head = await trainDeep(data, KERNEL, null, { epochs: 40, folds: 2, hidden: 64 });
  assert.equal(head.kind, "mlp");
  assert.equal(head.W1.length, head.hidden * data.d);
  assert.equal(head.b1.length, head.hidden);
  assert.equal(head.W2.length, data.labels.length * head.hidden);
  assert.equal(head.b2.length, data.labels.length);
  assert.ok(head.metrics.balanced > 0.9, `balanced was ${head.metrics.balanced}`);
});

test("the deep head beats the linear one where a plane is not enough", async () => {
  // This is the reason deep training exists at all. If it ever stops being
  // true, the extra seconds it costs are being spent for nothing.
  const opts = { proj: 0, epochs: 60, folds: 2 };
  const lin = await trainHead(folded(4, 24, 192, 0.1, 3), null, opts);
  const mlp = await trainDeep(folded(4, 24, 192, 0.1, 3), KERNEL, null, {
    ...opts,
    hidden: 64,
  });
  assert.ok(
    mlp.metrics.balanced > lin.metrics.balanced + 0.15,
    `mlp ${mlp.metrics.balanced} vs linear ${lin.metrics.balanced}`
  );
});

test("the folded-back first layer is the one that was trained", async () => {
  // With the projection on, W1 comes back in the ORIGINAL embedding space. The
  // check is that it is the composition and not the projected matrix left as
  // is: the shapes alone would pass either way.
  const data = clusters(3, 9, 128, 0.1, 21);
  const head = await trainDeep(data, KERNEL, null, {
    proj: 32,
    epochs: 5,
    folds: 2,
    hidden: 8,
  });
  assert.equal(head.metrics.projected, 32);
  assert.equal(head.W1.length, 8 * 128);
  let nonzero = 0;
  for (let i = 0; i < head.W1.length; i++) if (head.W1[i] !== 0) nonzero++;
  // A projected matrix copied straight out would leave 8*32 = 256 values and
  // the rest zero; the composition is dense.
  assert.ok(nonzero > 8 * 128 * 0.9, `only ${nonzero} non-zero weights`);
});

test("a second hidden layer ships as an mlp2 and still learns", async () => {
  const data = clusters(5, 16, 256, 0.08, 17);
  const head = await trainDeep(data, KERNEL, null, {
    epochs: 40,
    folds: 2,
    hidden: 32,
    hidden2: 32,
  });
  assert.equal(head.kind, "mlp2");
  assert.equal(head.metrics.hidden2, 32);
  assert.equal(head.W1.length, 32 * data.d);
  assert.equal(head.b1.length, 32);
  assert.equal(head.W2.length, 32 * 32);
  assert.equal(head.b2.length, 32);
  assert.equal(head.W3.length, data.labels.length * 32);
  assert.equal(head.b3.length, data.labels.length);
  assert.ok(head.metrics.balanced > 0.9, `balanced was ${head.metrics.balanced}`);
});

test("deep training refuses a set too small to mean anything", async () => {
  const data = clusters(4, 2, 64, 0.1, 4);
  await assert.rejects(() => trainDeep(data, KERNEL, null, {}), /at least three/);
});

test("progress is reported monotonically and ends at one", async () => {
  const data = clusters(3, 9, 64, 0.1, 31);
  const seen = [];
  await trainDeep(data, KERNEL, (stage, pct) => seen.push(pct), {
    epochs: 3,
    folds: 2,
    hidden: 8,
  });
  assert.ok(seen.length > 1);
  for (let i = 1; i < seen.length; i++)
    assert.ok(seen[i] >= seen[i - 1], `progress went ${seen[i - 1]} -> ${seen[i]}`);
  assert.equal(seen[seen.length - 1], 1);
});
