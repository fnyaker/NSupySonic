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
  // The first hidden layer. 128 was the whole model before; a wider one is the
  // cheapest accuracy there is, and the kernel is generic over the width.
  hidden: 256,
  // A SECOND hidden layer, 0 for none. The boundary between neighbouring
  // subgenres (hardtekk against frenchcore, zaag against uptempo) is not one
  // plane, and one hidden layer only bends it once. This bends it again.
  hidden2: 0,
  // More epochs than a tiny net needs: a bigger one also takes longer to
  // converge, and training was never the slow part of this workflow.
  epochs: 120,
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

/** One fully-connected layer's parameters, gradients and Adam moments. */
function makeLayer(K, out, inDim) {
  return {
    out,
    in: inDim,
    W: K.alloc(out * inDim), b: K.alloc(out),
    gW: K.alloc(out * inDim), gb: K.alloc(out),
    mW: K.alloc(out * inDim), vW: K.alloc(out * inDim),
    mb: K.alloc(out), vb: K.alloc(out),
  };
}

/**
 * A stack of dense layers: `widths` are the hidden widths then the class count.
 * Everything lives in wasm memory; `X` is the (projected) training matrix.
 */
function buildNet(K, Xp, widths) {
  const layers = [];
  for (let i = 1; i < widths.length; i++) {
    layers.push(makeLayer(K, widths[i], widths[i - 1]));
  }
  const acts = [];
  const dacts = [];
  for (let l = 0; l < layers.length - 1; l++) {
    acts.push(K.alloc(layers[l].out));
    dacts.push(K.alloc(layers[l].out));
  }
  const logits = K.alloc(layers[layers.length - 1].out);
  return { X: Xp, layers, acts, dacts, logits };
}

function netFloats(widths) {
  // [d, h1, (h2), C]: four copies of every weight (value, grad, two moments)
  // and of every bias, plus the activation buffers and the logits.
  let total = 0;
  for (let i = 1; i < widths.length; i++) {
    total += widths[i] * widths[i - 1] * 4 + widths[i] * 4;
  }
  for (let i = 1; i < widths.length - 1; i++) total += widths[i] * 2;
  total += widths[widths.length - 1];
  return total;
}

function initNet(K, net, d) {
  const mem = K.f32;
  const rand = rng((Math.random() * 0xffffffff) >>> 0);
  for (const layer of net.layers) {
    // He initialisation: a relu layer started from a uniform scale either dies
    // or saturates, and either way the first epochs are wasted.
    const s = Math.sqrt(2 / layer.in);
    for (let i = 0; i < layer.out * layer.in; i++) mem[layer.W + i] = gauss(rand) * s;
    mem.fill(0, layer.b, layer.b + layer.out);
    for (const [p, len] of [
      [layer.gW, layer.out * layer.in], [layer.gb, layer.out],
      [layer.mW, layer.out * layer.in], [layer.vW, layer.out * layer.in],
      [layer.mb, layer.out], [layer.vb, layer.out],
    ])
      mem.fill(0, p, p + len);
  }
}

/**
 * Train the stack over rows already in wasm memory, with Adam, L2, class
 * weights and a cosine-decayed learning rate.
 */
function fitNet(K, net, n, d, C, y, classW, opt, order) {
  const E = K.exports;
  const mem = K.f32;
  const { layers, acts, dacts, logits } = net;
  const L = layers.length;
  const b1a = 0.9;
  const b2a = 0.999;
  let t = 0;
  const logitsView = new Float32Array(C);

  for (let epoch = 0; epoch < opt.epochs; epoch++) {
    // Cosine decay to a quarter of the rate: a big net trains fast at first and
    // then needs to settle, and a fixed rate either overshoots at the end or
    // crawls at the start.
    const lr =
      opt.lr * (0.25 + 0.75 * (0.5 + 0.5 * Math.cos((Math.PI * epoch) / Math.max(1, opt.epochs))));
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
        const x = net.X + i * d;
        // Forward, storing every hidden activation for the backward pass.
        let prev = x;
        let prevLen = d;
        for (let l = 0; l < L; l++) {
          const layer = layers[l];
          const isLast = l === L - 1;
          const outPtr = isLast ? logits : acts[l];
          E.fwd(layer.W << 2, layer.b << 2, prev << 2, outPtr << 2, layer.out, prevLen);
          if (!isLast) E.relu(outPtr << 2, layer.out);
          prev = outPtr;
          prevLen = layer.out;
        }
        for (let c = 0; c < C; c++) logitsView[c] = mem[logits + c];
        softmax(logitsView, C);
        const w = classW[y[i]];
        wsum += w;
        for (let c = 0; c < C; c++)
          mem[logits + c] = w * (logitsView[c] - (c === y[i] ? 1 : 0));
        // Backward through every layer.
        let g = logits;
        for (let l = L - 1; l >= 0; l--) {
          const layer = layers[l];
          const aPrev = l === 0 ? x : acts[l - 1];
          const aPrevLen = l === 0 ? d : layers[l - 1].out;
          E.accum_outer(layer.gW << 2, g << 2, aPrev << 2, layer.out, aPrevLen);
          for (let r = 0; r < layer.out; r++) mem[layer.gb + r] += mem[g + r];
          if (l > 0) {
            const dPrev = dacts[l - 1];
            E.matvec_t(layer.W << 2, g << 2, dPrev << 2, layer.out, aPrevLen);
            E.relu_back(dPrev << 2, acts[l - 1] << 2, aPrevLen);
            g = dPrev;
          }
        }
      }
      t++;
      const scale = 1 / (wsum || 1);
      const bc1 = 1 - Math.pow(b1a, t);
      const bc2 = 1 - Math.pow(b2a, t);
      for (const layer of layers) {
        E.adam(layer.W << 2, layer.mW << 2, layer.vW << 2, layer.gW << 2,
               layer.out * layer.in, scale, lr, opt.l2, bc1, bc2);
        E.adam(layer.b << 2, layer.mb << 2, layer.vb << 2, layer.gb << 2,
               layer.out, scale, lr, 0, bc1, bc2);
      }
    }
  }
}

function predictNet(K, net, i, d, C, out) {
  const E = K.exports;
  const mem = K.f32;
  const { layers, acts, logits } = net;
  const L = layers.length;
  let prev = net.X + i * d;
  let prevLen = d;
  for (let l = 0; l < L; l++) {
    const layer = layers[l];
    const isLast = l === L - 1;
    const outPtr = isLast ? logits : acts[l];
    E.fwd(layer.W << 2, layer.b << 2, prev << 2, outPtr << 2, layer.out, prevLen);
    if (!isLast) E.relu(outPtr << 2, layer.out);
    prev = outPtr;
    prevLen = layer.out;
  }
  for (let c = 0; c < C; c++) out[c] = mem[logits + c];
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
  const h = Math.max(1, opt.hidden | 0);
  const h2 = Math.max(0, opt.hidden2 | 0);
  const seed = (Math.random() * 0xffffffff) >>> 0;
  // [input, hidden1, (hidden2), classes]: one hidden layer, or two.
  const widths = h2 > 0 ? [k, h, h2, C] : [k, h, C];

  const need = n * k + netFloats(widths) + 4096;
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

  const net = buildNet(K, Xp, widths);

  const counts = new Float32Array(C);
  for (let i = 0; i < n; i++) counts[y[i]]++;
  const classW = new Float32Array(C);
  let wsum = 0;
  for (let c = 0; c < C; c++) {
    classW[c] = counts[c] > 0 ? n / (C * counts[c]) : 0;
    wsum += classW[c];
  }
  for (let c = 0; c < C; c++) classW[c] *= C / (wsum || 1);

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
    initNet(K, net, k);
    const order = Int32Array.from(trainIdx);
    // fitNet shuffles `order` in place and indexes X by its values, so the
    // fold's own row indices go in directly — no packing needed.
    fitNet(K, net, trainIdx.length, k, C, y, classW, opt, order);
    for (const i of testIdx) {
      const got = predictNet(K, net, i, k, C, scratch);
      confusion[y[i]][got]++;
      if (got === y[i]) correct++;
      total++;
    }
  }

  report("deep", 0.85);
  await yieldToUI();
  initNet(K, net, k);
  const allOrder = new Int32Array(n);
  for (let i = 0; i < n; i++) allOrder[i] = i;
  fitNet(K, net, n, k, C, y, classW, opt, allOrder);

  // Pull every layer out of wasm, folding the projection back into the first
  // one, so what ships is a plain MLP over the original embedding and the
  // server knows nothing about any of this.
  const mem = K.f32;
  const blocks = net.layers.map((layer, l) => {
    const inDim = l === 0 ? d : layer.in;
    const W = new Float32Array(layer.out * inDim);
    if (l === 0 && useProj) {
      for (let r = 0; r < layer.out; r++) {
        const wr = layer.W + r * k;
        const orow = r * d;
        for (let i = 0; i < k; i++) {
          const w = mem[wr + i];
          if (w === 0) continue;
          const prow = i * d;
          for (let j = 0; j < d; j++) W[orow + j] += w * P[prow + j];
        }
      }
    } else {
      W.set(mem.subarray(layer.W, layer.W + layer.out * layer.in));
    }
    return { W, b: mem.slice(layer.b, layer.b + layer.out) };
  });

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

  const head = {
    // "mlp" is one hidden layer (W1,b1,W2,b2); "mlp2" is two (W1,b1,W2,b2,W3,b3).
    // Named rather than assumed: encodeHead's layout and the server's reader
    // both branch on it.
    kind: widths.length === 4 ? "mlp2" : "mlp",
    labels,
    dim: d,
    hidden: h,
    metrics: {
      examples: n,
      classes: C,
      folds,
      hidden: h,
      hidden2: h2,
      projected: useProj ? k : 0,
      accuracy: total ? +(correct / total).toFixed(3) : 0,
      balanced: +balanced.toFixed(3),
      perClass,
      confusion: confusion.map((r) => Array.from(r)),
    },
  };
  blocks.forEach((blk, i) => {
    head[`W${i + 1}`] = blk.W;
    head[`b${i + 1}`] = blk.b;
  });
  return head;
}
