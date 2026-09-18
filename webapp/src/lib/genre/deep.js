// Deep training: an MLP head, on the WebAssembly kernel.
//
// The linear head in train.js is the right default — it trains in a second and
// separates genres that are actually far apart. This is the escalation for the
// ones that are not: hardtekk against frenchcore, zaag against uptempo, where
// the boundary is not a plane and no amount of extra tagging makes it one.
//
// A hidden layer is about a hundred times the arithmetic of a linear head, and
// that is precisely why it is compiled: wasm/kernel.c does the two big matrix
// loops (forward through the hidden layer, and the outer product that is the
// gradient) at eight and twelve times what the identical JavaScript manages on
// the same 128x1280 data — measured, not assumed. The .wasm is committed, so
// nobody needs a toolchain to build this repository.
//
// The random projection the linear trainer leans on is available here too (the
// first layer is linear, so it folds straight back into it and what ships is a
// plain MLP over the original embedding) but it is OFF by default, and that is
// a measured decision rather than an oversight. Measured on three shapes of
// 1280-d data, projecting to 384 costs ten points of balanced accuracy on
// marginal data (0.890 against 0.998) to save about five seconds. On the one
// code path that exists BECAUSE the accuracy was not good enough, five seconds
// is not worth ten points. It stays available for very large label sets.

const ALIGN = 16;

export const DEEP_DEFAULTS = {
  hidden: 128,
  // Forty epochs left it visibly undertrained (0.571 where eighty reach 0.679
  // on the same non-separable set); past eighty it only overfits and slows.
  epochs: 80,
  // 0.02 is not the fastest to converge, but it is the steadiest: at 0.03-0.04
  // the run-to-run spread on hard data is wider than the gain.
  lr: 0.02,
  l2: 3e-4,
  batch: 32,
  folds: 3,
  proj: 0,
};

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rand) {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Instantiate the kernel over a linear memory big enough for `floats`. */
export async function loadKernel(source, floats) {
  const pages = Math.max(16, Math.ceil((floats * 4) / 65536) + 4);
  const memory = new WebAssembly.Memory({ initial: pages });
  const bytes =
    source instanceof ArrayBuffer || ArrayBuffer.isView(source)
      ? source
      : await (await fetch(source)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
  // clang's freestanding output brings its own memory unless one is imported;
  // whichever we end up with is the one the views must look at.
  const mem = instance.exports.memory || memory;
  // The arena must start above the module's own data AND its C stack: wasm-ld
  // lays memory out as [data][stack][heap] and exports __heap_base at the end
  // of that, so anything written below it is written over the stack the
  // kernels spill into.
  const base = instance.exports.__heap_base
    ? instance.exports.__heap_base.value | 0
    : 65536;
  const need = base + floats * 4 + 1024;
  if (mem.buffer.byteLength < need)
    mem.grow(Math.ceil((need - mem.buffer.byteLength) / 65536));
  let top = base;
  const arena = {
    exports: instance.exports,
    get f32() {
      return new Float32Array(mem.buffer);
    },
    alloc(n) {
      const off = (top + ALIGN - 1) & ~(ALIGN - 1);
      top = off + n * 4;
      if (mem.buffer.byteLength < top + 64)
        mem.grow(Math.ceil((top + 65536 - mem.buffer.byteLength) / 65536));
      return off >> 2; // as a float index
    },
    reset() {
      top = base;
    },
  };
  return arena;
}

function softmax(v, n) {
  let top = -Infinity;
  for (let i = 0; i < n; i++) if (v[i] > top) top = v[i];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    v[i] = Math.exp(v[i] - top);
    sum += v[i];
  }
  const inv = 1 / (sum || 1);
  for (let i = 0; i < n; i++) v[i] *= inv;
}

/**
 * Train one MLP over rows already in wasm memory.
 * Returns float indices of the four parameter blocks.
 */
function fitMLP(K, ptrs, n, d, h, C, y, classW, opt, order) {
  const E = K.exports;
  const { X, W1, b1, W2, b2, gW1, gb1, gW2, gb2, mW1, vW1, mb1, vb1, mW2, vW2,
          mb2, vb2, hid, logits, dh } = ptrs;
  // Nothing in here grows the arena, so one view for the whole fit — rebuilding
  // it per example was an allocation on the hot path.
  const mem = K.f32;
  const b1a = 0.9;
  const b2a = 0.999;
  let t = 0;
  const logitsView = new Float32Array(C);

  for (let epoch = 0; epoch < opt.epochs; epoch++) {
    for (let i = n - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }
    for (let start = 0; start < n; start += opt.batch) {
      const end = Math.min(n, start + opt.batch);
      let wsum = 0;
      for (let k = start; k < end; k++) {
        const i = order[k];
        const x = X + i * d;
        E.fwd(W1 << 2, b1 << 2, x << 2, hid << 2, h, d);
        E.relu(hid << 2, h);
        E.fwd(W2 << 2, b2 << 2, hid << 2, logits << 2, C, h);
        for (let c = 0; c < C; c++) logitsView[c] = mem[logits + c];
        softmax(logitsView, C);
        const w = classW[y[i]];
        wsum += w;
        for (let c = 0; c < C; c++)
          mem[logits + c] = w * (logitsView[c] - (c === y[i] ? 1 : 0));
        E.accum_outer(gW2 << 2, logits << 2, hid << 2, C, h);
        for (let c = 0; c < C; c++) mem[gb2 + c] += mem[logits + c];
        E.matvec_t(W2 << 2, logits << 2, dh << 2, C, h);
        E.relu_back(dh << 2, hid << 2, h);
        E.accum_outer(gW1 << 2, dh << 2, x << 2, h, d);
        for (let j2 = 0; j2 < h; j2++) mem[gb1 + j2] += mem[dh + j2];
      }
      t++;
      const scale = 1 / (wsum || 1);
      const bc1 = 1 - Math.pow(b1a, t);
      const bc2 = 1 - Math.pow(b2a, t);
      E.adam(W1 << 2, mW1 << 2, vW1 << 2, gW1 << 2, h * d, scale, opt.lr, opt.l2, bc1, bc2);
      E.adam(b1 << 2, mb1 << 2, vb1 << 2, gb1 << 2, h, scale, opt.lr, 0, bc1, bc2);
      E.adam(W2 << 2, mW2 << 2, vW2 << 2, gW2 << 2, C * h, scale, opt.lr, opt.l2, bc1, bc2);
      E.adam(b2 << 2, mb2 << 2, vb2 << 2, gb2 << 2, C, scale, opt.lr, 0, bc1, bc2);
    }
  }
}

function predictMLP(K, ptrs, i, d, h, C, out) {
  const E = K.exports;
  E.fwd(ptrs.W1 << 2, ptrs.b1 << 2, (ptrs.X + i * d) << 2, ptrs.hid << 2, h, d);
  E.relu(ptrs.hid << 2, h);
  E.fwd(ptrs.W2 << 2, ptrs.b2 << 2, ptrs.hid << 2, ptrs.logits << 2, C, h);
  const mem = K.f32;
  for (let c = 0; c < C; c++) out[c] = mem[ptrs.logits + c];
  let best = 0;
  for (let c = 1; c < C; c++) if (out[c] > out[best]) best = c;
  return best;
}

/**
 * @param {{X: Float32Array, y: Int32Array, n: number, d: number, labels: string[]}} data
 * @param {ArrayBuffer|string} wasm  the kernel, as bytes or a URL
 */
export async function trainDeep(data, wasm, onProgress, options = {}) {
  const opt = { ...DEEP_DEFAULTS, ...options };
  const { X, y, n, d, labels } = data;
  const C = labels.length;
  if (n < C * 3) throw new Error("deep training needs at least three examples per genre");
  const report = (stage, pct) => onProgress && onProgress(stage, pct);
  const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

  const useProj = opt.proj > 0 && d > opt.proj * 1.5;
  const k = useProj ? opt.proj : d;
  const h = opt.hidden;
  const seed = (Math.random() * 0xffffffff) >>> 0;

  // Room for the training rows plus every parameter, gradient and Adam moment
  // (four copies of every block: value, gradient, and Adam's two moments).
  const params = h * k + h + C * h + C;
  const need = n * k + 4 * params + h + C + h + 4096;
  const K = await loadKernel(wasm, need);

  // Project (or copy) the training rows into wasm memory.
  const Xp = K.alloc(n * k);
  let P = null;
  if (useProj) {
    const rand = rng(seed);
    P = new Float32Array(k * d);
    const scale = 1 / Math.sqrt(k);
    for (let i = 0; i < k * d; i++) P[i] = gauss(rand) * scale;
    const mem = K.f32;
    for (let i = 0; i < n; i++) {
      const src = i * d;
      const dst = Xp + i * k;
      for (let c = 0; c < k; c++) {
        const row = c * d;
        let acc = 0;
        for (let j = 0; j < d; j++) acc += P[row + j] * X[src + j];
        mem[dst + c] = acc;
      }
    }
  } else {
    K.f32.set(X, Xp);
  }

  const ptrs = {
    X: Xp,
    W1: K.alloc(h * k), b1: K.alloc(h), W2: K.alloc(C * h), b2: K.alloc(C),
    gW1: K.alloc(h * k), gb1: K.alloc(h), gW2: K.alloc(C * h), gb2: K.alloc(C),
    mW1: K.alloc(h * k), vW1: K.alloc(h * k), mb1: K.alloc(h), vb1: K.alloc(h),
    mW2: K.alloc(C * h), vW2: K.alloc(C * h), mb2: K.alloc(C), vb2: K.alloc(C),
    hid: K.alloc(h), logits: K.alloc(C), dh: K.alloc(h),
  };

  const counts = new Float32Array(C);
  for (let i = 0; i < n; i++) counts[y[i]]++;
  const classW = new Float32Array(C);
  let wsum = 0;
  for (let c = 0; c < C; c++) {
    classW[c] = counts[c] > 0 ? n / (C * counts[c]) : 0;
    wsum += classW[c];
  }
  for (let c = 0; c < C; c++) classW[c] *= C / (wsum || 1);

  function initParams() {
    const mem = K.f32;
    const rand = rng((Math.random() * 0xffffffff) >>> 0);
    // He initialisation: a relu layer started from a uniform scale either dies
    // or saturates, and either way the first epochs are wasted.
    const s1 = Math.sqrt(2 / k);
    for (let i = 0; i < h * k; i++) mem[ptrs.W1 + i] = gauss(rand) * s1;
    const s2 = Math.sqrt(2 / h);
    for (let i = 0; i < C * h; i++) mem[ptrs.W2 + i] = gauss(rand) * s2;
    for (const [p, len] of [[ptrs.b1, h], [ptrs.b2, C]]) mem.fill(0, p, p + len);
    for (const [p, len] of [
      [ptrs.gW1, h * k], [ptrs.gb1, h], [ptrs.gW2, C * h], [ptrs.gb2, C],
      [ptrs.mW1, h * k], [ptrs.vW1, h * k], [ptrs.mb1, h], [ptrs.vb1, h],
      [ptrs.mW2, C * h], [ptrs.vW2, C * h], [ptrs.mb2, C], [ptrs.vb2, C],
    ])
      mem.fill(0, p, p + len);
  }

  // Stratified folds, as in the linear trainer.
  const byClass = Array.from({ length: C }, () => []);
  for (let i = 0; i < n; i++) byClass[y[i]].push(i);
  const smallest = Math.min(...byClass.map((a) => a.length).filter((v) => v > 0));
  const folds = Math.max(2, Math.min(opt.folds, smallest || 2));
  const assign = new Int32Array(n);
  for (let c = 0; c < C; c++) {
    const list = byClass[c];
    for (let i = list.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [list[i], list[j]] = [list[j], list[i]];
    }
    list.forEach((idx, kk) => (assign[idx] = kk % folds));
  }

  const confusion = Array.from({ length: C }, () => new Int32Array(C));
  const scratch = new Float32Array(C);
  let correct = 0;
  let total = 0;
  for (let f = 0; f < folds; f++) {
    report("deep", (0.8 * f) / folds);
    await yieldToUI();
    const trainIdx = [];
    const testIdx = [];
    for (let i = 0; i < n; i++) (assign[i] === f ? testIdx : trainIdx).push(i);
    if (!trainIdx.length || !testIdx.length) continue;
    initParams();
    const order = Int32Array.from(trainIdx);
    fitMLP(K, ptrs, trainIdx.length, k, h, C, y, classW, opt,
           // fitMLP shuffles `order` in place and indexes X by its values, so
           // the fold's own row indices go in directly — no packing needed.
           order);
    for (const i of testIdx) {
      const got = predictMLP(K, ptrs, i, k, h, C, scratch);
      confusion[y[i]][got]++;
      if (got === y[i]) correct++;
      total++;
    }
  }

  report("deep", 0.85);
  await yieldToUI();
  initParams();
  const allOrder = new Int32Array(n);
  for (let i = 0; i < n; i++) allOrder[i] = i;
  fitMLP(K, ptrs, n, k, h, C, y, classW, opt, allOrder);

  // Fold the projection back into the first layer, so what ships is a plain
  // MLP over the original embedding and the server knows nothing about any of
  // this.
  const mem = K.f32;
  const W1 = new Float32Array(h * d);
  if (useProj) {
    for (let r = 0; r < h; r++) {
      const wr = ptrs.W1 + r * k;
      const orow = r * d;
      for (let i = 0; i < k; i++) {
        const w = mem[wr + i];
        if (w === 0) continue;
        const prow = i * d;
        for (let j = 0; j < d; j++) W1[orow + j] += w * P[prow + j];
      }
    }
  } else {
    W1.set(mem.subarray(ptrs.W1, ptrs.W1 + h * d));
  }
  const b1 = mem.slice(ptrs.b1, ptrs.b1 + h);
  const W2 = mem.slice(ptrs.W2, ptrs.W2 + C * h);
  const b2 = mem.slice(ptrs.b2, ptrs.b2 + C);

  const perClass = labels.map((name, c) => {
    const row = confusion[c];
    const hit = row[c];
    let seen = 0;
    for (let kk = 0; kk < C; kk++) seen += row[kk];
    let predicted = 0;
    for (let kk = 0; kk < C; kk++) predicted += confusion[kk][c];
    return {
      label: name,
      examples: byClass[c].length,
      recall: seen ? +(hit / seen).toFixed(3) : 0,
      precision: predicted ? +(hit / predicted).toFixed(3) : 0,
    };
  });
  const scored = perClass.filter((c) => c.examples);
  const balanced = scored.reduce((a, c) => a + c.recall, 0) / (scored.length || 1);
  report("done", 1);

  return {
    kind: "mlp",
    labels,
    dim: d,
    hidden: h,
    W1,
    b1,
    W2,
    b2,
    metrics: {
      examples: n,
      classes: C,
      folds,
      hidden: h,
      projected: useProj ? k : 0,
      accuracy: total ? +(correct / total).toFixed(3) : 0,
      balanced: +balanced.toFixed(3),
      perClass,
      confusion: confusion.map((r) => Array.from(r)),
    },
  };
}
