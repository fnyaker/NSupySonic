// The genre head: the Rust trainer the studio ships (webapp/trainer through
// src/lib/genre/core.js), held to what the JavaScript trainers it replaced
// could do (test/reference/genre-*.js, run side by side), and the wire format
// the server reads back.
//
// No dependency to install — `npm test` runs this with node's own runner. Both
// binaries are loaded straight off disk, the way the worker fetches one of them.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadTrainer, trainOn, fitTemperatureOn } from "../src/lib/genre/core.js";
import { encodeHead, decodeEmbedding } from "../src/lib/genre/wire.js";
import { trainHead as oracleLinear } from "./reference/genre-train.js";
import { trainDeep as oracleDeep } from "./reference/genre-deep.js";

const here = dirname(fileURLToPath(import.meta.url));
const bin = (name) => readFileSync(join(here, "../src/lib/genre", name));
const SIMD = await loadTrainer(bin("trainer-simd.wasm"));
const BASE = await loadTrainer(bin("trainer.wasm"));
const KERNEL = readFileSync(join(here, "reference/genre-kernel/kernel.wasm"));

const linear = (data, options = {}) => trainOn(SIMD, copy(data), "linear", options);
const deep = (data, options = {}) => trainOn(SIMD, copy(data), "deep", options);

function copy(d) {
  return { ...d, X: d.X.slice(), y: d.y.slice(), groups: d.groups ? d.groups.slice() : undefined };
}

function mkrand(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function unit(d, rand) {
  const v = new Float32Array(d);
  for (let i = 0; i < d; i++) v[i] = rand() * 2 - 1;
  let n = 0;
  for (let i = 0; i < d; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  for (let i = 0; i < d; i++) v[i] /= n;
  return v;
}

/** Well-separated clusters — what a working embedding hands the trainer. */
function clusters(C, perClass, d, noise, seed = 1) {
  const rand = mkrand(seed);
  const centres = [];
  for (let c = 0; c < C; c++) centres.push(unit(d, rand));
  const n = C * perClass;
  const X = new Float32Array(n * d);
  const y = new Int32Array(n);
  let k = 0;
  for (let c = 0; c < C; c++)
    for (let j = 0; j < perClass; j++) {
      for (let i = 0; i < d; i++) X[k * d + i] = centres[c][i] + (rand() * 2 - 1) * noise;
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
  const [a, b, c3] = [unit(d, rand), unit(d, rand), unit(d, rand)];
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
        X[k * d + i] = flip * (s1 * a[i] + s2 * b[i] + s3 * c3[i]) * 0.6 + (rand() * 2 - 1) * noise;
      y[k] = c;
      k++;
    }
  }
  return { X, y, n, d, labels: Array.from({ length: C }, (_, i) => "g" + i) };
}

/**
 * The album effect, as a library has it: every ARTIST has a sound of its own
 * (a production, a mastering chain) stronger than what its genre shares with
 * the rest of the genre. A head can score by recognising artists; the question
 * the studio asks is whether it recognises the genre on artists it never heard.
 */
function byArtist(C, A, per, d, genreW, artistW, noise, seed = 21) {
  const rand = mkrand(seed);
  const centres = [];
  for (let c = 0; c < C; c++) centres.push(unit(d, rand));
  const n = C * A * per;
  const X = new Float32Array(n * d);
  const y = new Int32Array(n);
  const groups = new Int32Array(n);
  let k = 0;
  for (let c = 0; c < C; c++)
    for (let a = 0; a < A; a++) {
      const own = unit(d, rand);
      for (let j = 0; j < per; j++) {
        for (let i = 0; i < d; i++)
          X[k * d + i] = genreW * centres[c][i] + artistW * own[i] + (rand() * 2 - 1) * noise;
        y[k] = c;
        groups[k] = c * A + a;
        k++;
      }
    }
  return { X, y, groups, n, d, labels: Array.from({ length: C }, (_, i) => "g" + i) };
}

// --- the binary is the source -------------------------------------------------

function sourceHash() {
  const dir = join(here, "../trainer/src");
  const names = readdirSync(dir).filter((n) => n.endsWith(".rs")).sort();
  let h = 0x811c9dc5;
  const eat = (bytes) => {
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  };
  for (const n of names) {
    eat(Buffer.from(n));
    eat(readFileSync(join(dir, n)));
  }
  return h >>> 0;
}

test("both shipped trainers are built from the Rust next to them", () => {
  // `>>> 0`: a wasm u32 reaches JavaScript as a signed i32.
  assert.equal(SIMD.tr_src_hash() >>> 0, sourceHash(), "trainer-simd.wasm is stale: run `npm run wasm`");
  assert.equal(BASE.tr_src_hash() >>> 0, sourceHash(), "trainer.wasm is stale: run `npm run wasm`");
});

test("the SIMD build trains the same head as the baseline one, weight for weight", () => {
  // Every browser gets one of the two; they must be the same trainer. The
  // scalar loops keep their partial sums exactly where the vector lanes keep
  // theirs (linalg.rs), so this is equality, not a tolerance.
  const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const lin = clusters(4, 14, 200, 0.4, 5);
  const o = { seed: 11, proj: 64, epochs: 12, bag: 2 };
  const a = trainOn(SIMD, copy(lin), "linear", o);
  const b = trainOn(BASE, copy(lin), "linear", o);
  assert.ok(same(a.W, b.W) && same(a.b, b.b), "linear heads differ");
  assert.equal(a.metrics.temperature, b.metrics.temperature);
  const d1 = { seed: 3, epochs: 6, folds: 2, hidden: 12, hidden2: 9 };
  const p = trainOn(SIMD, copy(lin), "deep", d1);
  const q = trainOn(BASE, copy(lin), "deep", d1);
  for (const k of ["W1", "b1", "W2", "b2", "W3", "b3"]) assert.ok(same(p[k], q[k]), `${k} differs`);
});

test("a seed repeats a run exactly, and another seed is another run", () => {
  const data = clusters(3, 12, 48, 0.6, 8);
  const a = linear(data, { seed: 5, proj: 0, bag: 1, epochs: 8 });
  const b = linear(data, { seed: 5, proj: 0, bag: 1, epochs: 8 });
  const c = linear(data, { seed: 6, proj: 0, bag: 1, epochs: 8 });
  assert.deepEqual(Array.from(a.W), Array.from(b.W));
  assert.notDeepEqual(Array.from(a.W), Array.from(c.W));
  assert.equal(a.metrics.seed, 5);
});

// -- the linear head --------------------------------------------------------

test("the linear head separates well-separated genres", () => {
  const data = clusters(6, 20, 256, 0.08, 7);
  const head = linear(data, { proj: 0, epochs: 40, folds: 3 });
  assert.equal(head.kind, "linear");
  assert.ok(head.metrics.balanced > 0.95, `balanced accuracy was ${head.metrics.balanced}`);
  assert.equal(head.W.length, data.labels.length * data.d);
  assert.equal(head.b.length, data.labels.length);
});

test("the confusion matrix accounts for every held-out example", () => {
  const data = clusters(5, 12, 128, 0.2, 11);
  const head = linear(data, { proj: 0, epochs: 20, folds: 3 });
  let total = 0;
  for (const row of head.metrics.confusion) for (const v of row) total += v;
  // Every row is held out exactly once across the folds.
  assert.equal(total, data.n);
  assert.equal(head.metrics.confusion.length, data.labels.length);
});

test("class weights keep a rare genre from being written off", () => {
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
  const head = linear({ X, y, n: keep.length, d: big.d, labels: big.labels }, { proj: 0, epochs: 40, folds: 2 });
  const rare = head.metrics.perClass.find((c) => c.label === "g1");
  assert.ok(rare.recall > 0.5, `rare-class recall was ${rare.recall}`);
});

test("the projection folds back into a plain head over the full embedding", () => {
  // Trained on P·x, shipped as W·P: the server receives a C × d matrix and
  // knows nothing about the projection.
  const data = clusters(4, 16, 512, 0.1, 13);
  const head = linear(data, { proj: 64, epochs: 20 });
  assert.equal(head.metrics.projected, 64);
  assert.equal(head.W.length, 4 * 512);
  assert.ok(head.metrics.balanced > 0.95, `balanced ${head.metrics.balanced}`);
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

// -- the deep head ----------------------------------------------------------

test("the deep head matches the linear one where a plane is enough", () => {
  const data = clusters(5, 16, 256, 0.08, 9);
  const head = deep(data, { epochs: 40, folds: 2, hidden: 64 });
  assert.equal(head.kind, "mlp");
  assert.equal(head.W1.length, head.hidden * data.d);
  assert.equal(head.b1.length, head.hidden);
  assert.equal(head.W2.length, data.labels.length * head.hidden);
  assert.equal(head.b2.length, data.labels.length);
  assert.ok(head.metrics.balanced > 0.9, `balanced was ${head.metrics.balanced}`);
});

test("the deep head beats the linear one where a plane is not enough", () => {
  // This is the reason deep training exists at all. If it ever stops being
  // true, the extra seconds it costs are being spent for nothing.
  const opts = { proj: 0, epochs: 60, folds: 2 };
  const lin = linear(folded(4, 24, 192, 0.1, 3), opts);
  const mlp = deep(folded(4, 24, 192, 0.1, 3), { ...opts, hidden: 64 });
  assert.ok(
    mlp.metrics.balanced > lin.metrics.balanced + 0.15,
    `mlp ${mlp.metrics.balanced} vs linear ${lin.metrics.balanced}`
  );
});

test("the folded-back first layer is the one that was trained", () => {
  // With the projection on, W1 comes back in the ORIGINAL embedding space. The
  // check is that it is the composition and not the projected matrix left as
  // is: the shapes alone would pass either way.
  const data = clusters(3, 9, 128, 0.1, 21);
  const head = deep(data, { proj: 32, epochs: 5, folds: 2, hidden: 8 });
  assert.equal(head.metrics.projected, 32);
  assert.equal(head.W1.length, 8 * 128);
  let nonzero = 0;
  for (let i = 0; i < head.W1.length; i++) if (head.W1[i] !== 0) nonzero++;
  // A projected matrix copied straight out would leave 8*32 = 256 values and
  // the rest zero; the composition is dense.
  assert.ok(nonzero > 8 * 128 * 0.9, `only ${nonzero} non-zero weights`);
});

test("a second hidden layer ships as an mlp2 and still learns", () => {
  const data = clusters(5, 16, 256, 0.08, 17);
  const head = deep(data, { epochs: 40, folds: 2, hidden: 32, hidden2: 32 });
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

test("training refuses a set too small to mean anything", () => {
  const data = clusters(4, 2, 64, 0.1, 4);
  assert.throws(() => deep(data), /at least three/);
  assert.throws(() => linear(clusters(4, 1, 64, 0.1, 4)), /not enough labelled/);
});

test("a vector with a non-finite value is refused, not trained into NaN", () => {
  const data = clusters(3, 6, 16, 0.1, 4);
  data.X[5] = NaN;
  assert.throws(() => linear(data), /not usable/);
});

test("progress is reported monotonically and ends at one", () => {
  const data = clusters(3, 9, 64, 0.1, 31);
  const seen = [];
  trainOn(SIMD, copy(data), "deep", { epochs: 20, folds: 2, hidden: 16, progressEvery: 0 }, (stage, pct) =>
    seen.push(pct)
  );
  assert.ok(seen.length > 1, `only ${seen.length} progress reports`);
  for (let i = 1; i < seen.length; i++)
    assert.ok(seen[i] >= seen[i - 1], `progress went ${seen[i - 1]} -> ${seen[i]}`);
  assert.equal(seen[seen.length - 1], 1);
});

// --- temperature calibration -------------------------------------------------

test("a temperature of one leaves an already-honest head alone", () => {
  // A head that means what it says: on 75% of the held-out set its top logit
  // really is the truth, and its margin encodes exactly that (sigmoid(1.0986)
  // = 0.75). A calibrated head like this needs no rescaling.
  const held = [];
  const y = [];
  const M = Math.log(3);
  for (let i = 0; i < 100; i++) {
    const right = i % 4 !== 0; // 75 of 100
    held.push(right ? Float32Array.from([M, 0]) : Float32Array.from([0, M]));
    y.push(0);
  }
  const T = fitTemperatureOn(SIMD, held, Int32Array.from(y), 2);
  assert.ok(T > 0.85 && T < 1.2, `T was ${T}`);
});

test("an over-confident head is flattened, and its argmax never moves", () => {
  // The head says 0.999 for a class it is right about half the time — the
  // situation the gate in analysis.py has to survive.
  const held = [];
  const y = [];
  for (let i = 0; i < 40; i++) {
    held.push(i % 2 === 0 ? Float32Array.from([12, 0]) : Float32Array.from([0, 9]));
    y.push(0);
  }
  const T = fitTemperatureOn(SIMD, held, Int32Array.from(y), 2);
  assert.ok(T > 1.4, `an over-confident head should want T > 1, got ${T}`);
  // Whatever T is, the larger logit stays larger: it cannot change a decision.
  for (const logits of held) assert.equal(logits[0] / T > logits[1] / T, logits[0] > logits[1]);
});

test("a confidently wrong head is pushed back toward the centre", () => {
  const held = [];
  const y = [];
  for (let i = 0; i < 30; i++) {
    held.push(Float32Array.from([5, -5]));
    y.push(i % 2); // wrong half the time
  }
  const T = fitTemperatureOn(SIMD, held, Int32Array.from(y), 2);
  assert.ok(T > 1.2, `T was ${T}`);
});

test("both heads carry a temperature the server will accept", () => {
  const data = clusters(3, 12, 64, 0.1, 77);
  const T = linear(data).metrics.temperature;
  assert.equal(typeof T, "number");
  assert.ok(T >= 0.5 && T <= 4, `T out of range: ${T}`);
  const Td = deep(data, { epochs: 4, folds: 2, hidden: 8 }).metrics.temperature;
  assert.ok(Td >= 0.5 && Td <= 4, `deep T out of range: ${Td}`);
});

test("a bag's temperature is fitted on what ships, not on the members' sum", () => {
  // The JavaScript summed the members' held-out logits while shipping their
  // average, so a bag of three fitted T on logits three times too large and
  // the server then read the shipped head as far LESS sure than it is — its
  // good calls fell under the 0.45 gate. Measured on these clusters (noise 0.5,
  // three seeds): the oracle's T went 1.19 / 1.32 / 1.07 without a bag and
  // 2.00 every time with one; the Rust stays at 1.11-1.15 either way.
  const data = clusters(4, 20, 64, 0.5, 12);
  for (const seed of [1, 2, 3]) {
    const t1 = linear(data, { proj: 0, bag: 1, seed }).metrics.temperature;
    const t3 = linear(data, { proj: 0, bag: 3, seed }).metrics.temperature;
    assert.ok(t3 / t1 < 1.2 && t3 / t1 > 0.83, `seed ${seed}: T ${t1} alone, ${t3} bagged`);
  }
});

// --- folds by artist -------------------------------------------------------------

test("holding out whole artists scores the genre, not the album", () => {
  // Four genres, five artists each, six tracks per artist, every artist's own
  // sound stronger than its genre's. Measured over three seeds: stratified
  // folds score 0.96-0.98 because a held-out track's album-mates trained the
  // model; artist folds score 0.74-0.83 — what the head is worth on an artist
  // it has never heard — and fit T 1.00-1.23 instead of 0.60-0.68, i.e. they
  // stop the calibration from making an album-recogniser look sure of genres.
  const data = byArtist(4, 5, 6, 96, 0.6, 1.0, 0.3);
  for (const seed of [1, 2, 3]) {
    const s = linear(data, { proj: 0, seed });
    const g = linear(data, { proj: 0, seed, grouped: true });
    assert.equal(g.metrics.grouped, true);
    assert.equal(s.metrics.grouped, false);
    assert.ok(s.metrics.balanced - g.metrics.balanced > 0.08, `seed ${seed}: ${s.metrics.balanced} vs ${g.metrics.balanced}`);
    assert.ok(g.metrics.temperature > s.metrics.temperature, `seed ${seed}: T ${s.metrics.temperature} vs ${g.metrics.temperature}`);
  }
  // And the per-genre artist count is reported, the number that says whether
  // a score can mean anything at all.
  const head = linear(data, { proj: 0, grouped: true });
  assert.deepEqual(head.metrics.perClass.map((c) => c.artists), [5, 5, 5, 5]);
});

test("a genre with ONE artist cannot pretend to generalise", () => {
  // Eleven zaag tracks, all by the same producer: with artist folds, whenever
  // they are held out nobody else's zaag trained the model — and the score says
  // so rather than rewarding the model for knowing that one artist.
  const data = byArtist(3, 4, 6, 64, 0.7, 1.0, 0.2, 5);
  for (let i = 0; i < data.n; i++) if (data.y[i] === 2) data.groups[i] = 999;
  const g = linear(data, { proj: 0, grouped: true, seed: 2 });
  const solo = g.metrics.perClass.find((c) => c.label === "g2");
  assert.equal(solo.artists, 1);
  assert.equal(solo.recall, 0);
});

// --- bagging, augmentation, and the confusion audit ---------------------------

test("a bagged head over several shuffles still ships a usable model", () => {
  const data = clusters(3, 14, 48, 0.1, 91);
  const head = linear(data);
  assert.ok(head.metrics.bagged >= 2, `bag was ${head.metrics.bagged}`);
  assert.equal(head.W.length, head.labels.length * head.dim);
  assert.equal(head.b.length, head.labels.length);
  assert.ok(head.metrics.balanced >= 0.8, `balanced ${head.metrics.balanced}`);
});

test("a bag of one is allowed", () => {
  const head = linear(clusters(3, 14, 48, 0.1, 92), { bag: 1 });
  assert.equal(head.metrics.bagged, 0);
  assert.equal(head.W.length, head.labels.length * head.dim);
});

test("no noise is added unless it was asked for", () => {
  const data = clusters(3, 14, 48, 0.1, 93);
  assert.equal(linear(data, { bag: 1 }).metrics.noise, 0);
  assert.equal(linear(data, { bag: 1, noise: 0 }).metrics.noise, 0);
});

test("the confused pairs are read off the matrix, not invented", () => {
  const data = clusters(3, 16, 32, 0.05, 94);
  const head = linear(data, { bag: 1 });
  const m = head.metrics;
  assert.ok(Array.isArray(m.confusions));
  let total = 0;
  for (const c of m.confusions) {
    const i = head.labels.indexOf(c.from);
    const j = head.labels.indexOf(c.to);
    assert.ok(i >= 0 && j >= 0);
    assert.equal(m.confusion[i][j], c.count);
    total += c.count;
  }
  let offDiag = 0;
  for (let i = 0; i < m.confusion.length; i++)
    for (let j = 0; j < m.confusion.length; j++) if (i !== j) offDiag += m.confusion[i][j];
  assert.equal(total, offDiag);
  for (let k = 1; k < m.confusions.length; k++) assert.ok(m.confusions[k - 1].count >= m.confusions[k].count);
});

// --- against the JavaScript it replaced ------------------------------------------

/** Run `f` with Math.random replaced by a seeded stream (the oracle shuffles
 * with Math.random, and a comparison against a moving target is a flaky one). */
async function seededRandom(seed, f) {
  const real = Math.random;
  let s = seed >>> 0;
  Math.random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return await f();
  } finally {
    Math.random = real;
  }
}

test("the Rust trainers score what the JavaScript ones scored", async () => {
  // Same data, three seeds each (a single run of either is one draw of the
  // shuffles): the mean balanced accuracies agree. Measured: clusters 0.983 /
  // 1 / 1 on both sides, the folded set (where a plane cannot work) 0.213 /
  // 0.2 / 0.213 against 0.212 / 0.2 / 0.212, the dense stack 1 / 1 / 1 on both.
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const cases = [
    ["clusters", clusters(5, 12, 128, 0.35, 41), { proj: 0, epochs: 30, folds: 3 }],
    ["folded", folded(4, 20, 96, 0.1, 42), { proj: 0, epochs: 40, folds: 2 }],
  ];
  for (const [name, data, o] of cases) {
    const rs = [];
    const js = [];
    for (const seed of [1, 2, 3]) {
      rs.push(linear(data, { ...o, seed }).metrics.balanced);
      js.push((await seededRandom(seed, () => oracleLinear(copy(data), null, o))).metrics.balanced);
    }
    assert.ok(Math.abs(mean(rs) - mean(js)) <= 0.03, `${name} linear: rust ${rs} js ${js}`);
  }
  const data = folded(4, 20, 96, 0.1, 43);
  const o = { epochs: 60, folds: 2, hidden: 32 };
  const rs = [];
  const js = [];
  for (const seed of [1, 2, 3]) {
    rs.push(deep(data, { ...o, seed }).metrics.balanced);
    js.push((await seededRandom(seed, () => oracleDeep(copy(data), KERNEL, null, o))).metrics.balanced);
  }
  assert.ok(mean(rs) >= mean(js) - 0.03, `deep: rust ${rs} js ${js}`);
});

test("the Rust trainers are faster than the JavaScript they replaced", async () => {
  // Best of three, same work. Measured on this machine: the linear head 17x
  // (clean) and 22x (noisy, where every softmax error is non-zero) faster; on
  // 2560-d embeddings, 12 genres x 15 tracks full width, 9.5 s against 0.66 s,
  // and 30 genres x 20 with the full-width retry 136 s against 9.3 s. The dense
  // stack against the C kernel it replaced: 1.1 s against 0.62 s (10 x 12 x
  // 2560, 128 hidden, 20 epochs).
  const best = async (f) => {
    let b = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await f();
      b = Math.min(b, performance.now() - t0);
    }
    return b;
  };
  for (const noise of [0.1, 1.2]) {
    const data = clusters(8, 12, 1024, noise, 3);
    const o = { proj: 0, epochs: 20, bag: 1, folds: 3 };
    const tj = await best(() => oracleLinear(copy(data), null, o));
    const tr = await best(() => linear(data, { ...o, seed: 1 }));
    assert.ok(tr * 4 < tj, `linear noise ${noise}: rust ${tr.toFixed(0)} ms, js ${tj.toFixed(0)} ms`);
  }
  const data = clusters(6, 10, 1024, 0.1, 4);
  const o = { epochs: 12, folds: 2, hidden: 96 };
  const tj = await best(() => oracleDeep(copy(data), KERNEL, null, o));
  const tr = await best(() => deep(data, { ...o, seed: 1 }));
  assert.ok(tr < tj, `deep: rust ${tr.toFixed(0)} ms, js+C ${tj.toFixed(0)} ms`);
});
