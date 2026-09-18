// Training the genre head, in the browser, in plain JavaScript.
//
// This is the part people expect to need a machine-learning framework and a
// WebAssembly build, and it does not — because the big model is never trained.
// It is frozen upstream and only ever turns a track into a 1280-number vector;
// what is learned here is a single linear map from those vectors to the user's
// own genre names. For a few hundred tracks and a couple of dozen genres that
// is a problem measured in millions of multiply-adds, which is a second or two
// of ordinary JavaScript.
//
// Softmax regression (multinomial logistic), Adam, L2, class-balanced:
//
//  - CLASS BALANCE matters more than anything else here. A personal library is
//    never evenly spread — there will be two hundred techno tracks and eleven
//    tagged "zaag" — and unweighted training answers "techno" to everything and
//    reports a fine accuracy for doing so.
//  - The accuracy shown to the user is CROSS-VALIDATED, never the training
//    score. A linear model on 1280 dimensions can memorise a few hundred
//    examples perfectly, so the training score is always excellent and always
//    meaningless; the held-out one is the only number that answers "is my
//    tagging enough yet?".
//  - Training YIELDS between epochs. This runs on the UI thread on purpose (a
//    worker would have to ship the whole training set across), so it hands
//    control back often enough that the page never freezes.

export const DEFAULTS = {
  epochs: 60,
  lr: 0.08,
  l2: 1e-4,
  batch: 32,
  folds: 5,
  // Train in a randomly projected space when the embedding is wide (see
  // project() below). 0 disables it.
  proj: 256,
};

// A cross-validated balanced accuracy below this is weak enough that the
// projection is worth ruling out as the cause — see the end of trainHead.
const RETRY_BELOW = 0.8;

// A fixed-stream PRNG, so a training run is reproducible while it lasts.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random projection down to `k` dimensions, and the matrix to undo it with.
 *
 * 1280 dimensions for a few hundred examples is wildly over-parameterised, and
 * every epoch pays for all of them. Johnson-Lindenstrauss says a random
 * projection to a few hundred dimensions keeps the distances that matter, which
 * makes training several times cheaper — and because the head is LINEAR, the
 * result folds straight back: a head trained on P·x is exactly the head W·P on
 * x. So the server still receives a plain 1280-wide matrix and knows nothing
 * about any of this.
 */
function project(X, n, d, k, seed) {
  const rand = rng(seed);
  const P = new Float32Array(k * d);
  const scale = 1 / Math.sqrt(k);
  for (let i = 0; i < k * d; i++) {
    // Box-Muller, so the entries are Gaussian rather than uniform.
    const u = Math.max(1e-12, rand());
    const v = rand();
    P[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * scale;
  }
  const Z = new Float32Array(n * k);
  for (let i = 0; i < n; i++) {
    const src = i * d;
    const dst = i * k;
    for (let c = 0; c < k; c++) {
      const row = c * d;
      let acc = 0;
      for (let j = 0; j < d; j++) acc += P[row + j] * X[src + j];
      Z[dst + c] = acc;
    }
  }
  return { Z, P };
}

/** W (C x k) in the projected space -> W (C x d) in the original one. */
function unproject(W, P, C, k, d) {
  const out = new Float32Array(C * d);
  for (let c = 0; c < C; c++) {
    const wrow = c * k;
    const orow = c * d;
    for (let i = 0; i < k; i++) {
      const w = W[wrow + i];
      if (w === 0) continue;
      const prow = i * d;
      for (let j = 0; j < d; j++) out[orow + j] += w * P[prow + j];
    }
  }
  return out;
}

function softmaxInto(out, x, W, b, d, C, off) {
  let top = -Infinity;
  for (let c = 0; c < C; c++) {
    let acc = b[c];
    const row = c * d;
    for (let i = 0; i < d; i++) acc += W[row + i] * x[off + i];
    out[c] = acc;
    if (acc > top) top = acc;
  }
  let sum = 0;
  for (let c = 0; c < C; c++) {
    out[c] = Math.exp(out[c] - top);
    sum += out[c];
  }
  const inv = 1 / (sum || 1);
  for (let c = 0; c < C; c++) out[c] *= inv;
}

/**
 * Fit one head.
 * @param {Float32Array} X  n*d, row-major
 * @param {Int32Array}   y  n class indices
 * @param {number} n @param {number} d @param {number} C
 */
function fit(X, y, n, d, C, opt, order) {
  const W = new Float32Array(C * d);
  const b = new Float32Array(C);
  const mW = new Float32Array(C * d);
  const vW = new Float32Array(C * d);
  const mB = new Float32Array(C);
  const vB = new Float32Array(C);
  const p = new Float32Array(C);
  const gW = new Float32Array(C * d);
  const gB = new Float32Array(C);

  // Inverse-frequency weights, normalized to mean 1 so the learning rate keeps
  // meaning the same thing whatever the class balance is.
  const counts = new Float32Array(C);
  for (let i = 0; i < n; i++) counts[y[i]]++;
  const cw = new Float32Array(C);
  let wsum = 0;
  for (let c = 0; c < C; c++) {
    cw[c] = counts[c] > 0 ? n / (C * counts[c]) : 0;
    wsum += cw[c];
  }
  const wnorm = C / (wsum || 1);
  for (let c = 0; c < C; c++) cw[c] *= wnorm;

  const { epochs, lr, l2, batch } = opt;
  const b1 = 0.9;
  const b2 = 0.999;
  const eps = 1e-8;
  let t = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    // Shuffle the index order in place (Fisher-Yates) so batches differ.
    for (let i = n - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }
    for (let start = 0; start < n; start += batch) {
      const end = Math.min(n, start + batch);
      gW.fill(0);
      gB.fill(0);
      let wsumBatch = 0;
      for (let k = start; k < end; k++) {
        const i = order[k];
        const off = i * d;
        softmaxInto(p, X, W, b, d, C, off);
        const w = cw[y[i]];
        wsumBatch += w;
        for (let c = 0; c < C; c++) {
          const g = w * (p[c] - (c === y[i] ? 1 : 0));
          if (g === 0) continue;
          const row = c * d;
          for (let j2 = 0; j2 < d; j2++) gW[row + j2] += g * X[off + j2];
          gB[c] += g;
        }
      }
      const inv = 1 / (wsumBatch || 1);
      t++;
      const bc1 = 1 - Math.pow(b1, t);
      const bc2 = 1 - Math.pow(b2, t);
      for (let idx = 0; idx < C * d; idx++) {
        const g = gW[idx] * inv + l2 * W[idx];
        mW[idx] = b1 * mW[idx] + (1 - b1) * g;
        vW[idx] = b2 * vW[idx] + (1 - b2) * g * g;
        W[idx] -= (lr * (mW[idx] / bc1)) / (Math.sqrt(vW[idx] / bc2) + eps);
      }
      for (let c = 0; c < C; c++) {
        const g = gB[c] * inv;
        mB[c] = b1 * mB[c] + (1 - b1) * g;
        vB[c] = b2 * vB[c] + (1 - b2) * g * g;
        b[c] -= (lr * (mB[c] / bc1)) / (Math.sqrt(vB[c] / bc2) + eps);
      }
    }
  }
  return { W, b };
}

function predictIndex(x, off, W, b, d, C, p) {
  softmaxInto(p, x, W, b, d, C, off);
  let best = 0;
  for (let c = 1; c < C; c++) if (p[c] > p[best]) best = c;
  return best;
}

/**
 * Train a head, with honest held-out metrics.
 *
 * @param {{X: Float32Array, y: Int32Array, n: number, d: number, labels: string[]}} data
 * @param {(stage: string, pct: number) => void} [onProgress]
 */
export async function trainHead(data, onProgress, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const { X, y, n, d, labels } = data;
  const C = labels.length;
  if (n < C * 2) throw new Error("not enough labelled tracks");

  const report = (stage, pct) => onProgress && onProgress(stage, pct);
  const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

  // Stratified folds, computed once and shared by both attempts below so the
  // two scores are comparable. With eleven examples of a genre, a random split
  // can put all of them in one fold and the score becomes a coin toss.
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
    list.forEach((idx, k) => (assign[idx] = k % folds));
  }

  async function run(projDim, label) {
    report(label, 0.02);
    await yieldToUI();
    const useProj = projDim > 0 && d > projDim * 1.5;
    const { Z, P } = useProj
      ? project(X, n, d, projDim, (Math.random() * 0xffffffff) >>> 0)
      : { Z: X, P: null };
    const dim = useProj ? projDim : d;

    const confusion = Array.from({ length: C }, () => new Int32Array(C));
    const p = new Float32Array(C);
    let correct = 0;
    let total = 0;
    for (let f = 0; f < folds; f++) {
      report(label, 0.05 + (0.75 * f) / folds);
      await yieldToUI();
      const trainIdx = [];
      const testIdx = [];
      for (let i = 0; i < n; i++) (assign[i] === f ? testIdx : trainIdx).push(i);
      if (!testIdx.length || !trainIdx.length) continue;
      // Pack the fold's rows contiguously: the inner loops are the whole cost
      // of training and should not be chasing an index array.
      const Xf = new Float32Array(trainIdx.length * dim);
      const yf = new Int32Array(trainIdx.length);
      trainIdx.forEach((src, k) => {
        Xf.set(Z.subarray(src * dim, src * dim + dim), k * dim);
        yf[k] = y[src];
      });
      const order = new Int32Array(trainIdx.length);
      for (let i = 0; i < order.length; i++) order[i] = i;
      const m = fit(Xf, yf, trainIdx.length, dim, C, opt, order);
      for (const i of testIdx) {
        const got = predictIndex(Z, i * dim, m.W, m.b, dim, C, p);
        confusion[y[i]][got]++;
        if (got === y[i]) correct++;
        total++;
      }
    }

    report(label, 0.85);
    await yieldToUI();
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const final = fit(Z, y, n, dim, C, opt, order);
    // Fold the projection into the weights: what leaves here is always a plain
    // head over the original embedding, whatever was done to train it.
    const W = useProj ? unproject(final.W, P, C, dim, d) : final.W;

    // Per-class recall is what actually tells the user where to tag more: a
    // genre the model never gets right is a genre with too few examples.
    const perClass = labels.map((name, c) => {
      const row = confusion[c];
      const hit = row[c];
      let seen = 0;
      for (let k = 0; k < C; k++) seen += row[k];
      let predicted = 0;
      for (let k = 0; k < C; k++) predicted += confusion[k][c];
      return {
        label: name,
        examples: byClass[c].length,
        recall: seen ? +(hit / seen).toFixed(3) : 0,
        precision: predicted ? +(hit / predicted).toFixed(3) : 0,
      };
    });
    // Balanced accuracy, not raw: with one dominant genre the raw figure
    // flatters a model that simply always answers it.
    const scored = perClass.filter((c) => c.examples);
    const balanced = scored.reduce((a, c) => a + c.recall, 0) / (scored.length || 1);

    return {
      // Named rather than assumed: encodeHead's layout and the server's reader
      // both branch on this, and a head that arrived without it would be
      // stored as whatever the default happened to be that day.
      kind: "linear",
      labels,
      dim: d,
      W,
      b: final.b,
      metrics: {
        examples: n,
        classes: C,
        folds,
        projected: useProj ? projDim : 0,
        accuracy: total ? +(correct / total).toFixed(3) : 0,
        balanced: +balanced.toFixed(3),
        perClass,
        confusion: confusion.map((r) => Array.from(r)),
      },
    };
  }

  // Train in the projected space first, because when it works it is several
  // times faster for exactly the same result. It does NOT always work: the
  // projection costs a few percent of distance, and on classes that are barely
  // separated to begin with that is enough to lose them. So the score decides —
  // a weak result is retried at full width and the better model is the one that
  // ships. Nothing here can make the model worse than training without it.
  const fast = await run(opt.proj, "training");
  if (!opt.proj || d <= opt.proj * 1.5 || fast.metrics.balanced >= RETRY_BELOW) {
    report("done", 1);
    return fast;
  }
  const full = await run(0, "refining");
  report("done", 1);
  const winner = full.metrics.balanced > fast.metrics.balanced ? full : fast;
  winner.metrics.retried = true;
  return winner;
}

// --- wire format -----------------------------------------------------------
// float16 base64: the weight matrix row-major, then the bias. Half the bytes
// for a precision nothing downstream can resolve.
function f32ToF16(value) {
  const f = new Float32Array(1);
  const i = new Int32Array(f.buffer);
  f[0] = value;
  const x = i[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) return sign; // underflow to signed zero
  if (exp >= 0x1f) return sign | 0x7c00; // overflow to infinity
  mant = mant >> 13;
  return sign | (exp << 10) | mant;
}

/**
 * A head -> the base64 float16 blob the server stores.
 *
 * One flat buffer, in the order the server reads it back: a linear head is
 * W then b; an MLP is W1, b1, W2, b2. Half precision halves the payload and
 * costs nothing that matters — these are weights over a normalised embedding,
 * not an accumulator.
 */
export function encodeHead(head) {
  const blocks =
    head.kind === "mlp2"
      ? [head.W1, head.b1, head.W2, head.b2, head.W3, head.b3]
      : head.kind === "mlp"
        ? [head.W1, head.b1, head.W2, head.b2]
        : [head.W, head.b];
  let total = 0;
  for (const blk of blocks) total += blk.length;
  const out = new Uint16Array(total);
  let o = 0;
  for (const blk of blocks) {
    for (let i = 0; i < blk.length; i++) out[o + i] = f32ToF16(blk[i]);
    o += blk.length;
  }
  const bytes = new Uint8Array(out.buffer);
  let bin = "";
  const CHUNK = 0x8000; // String.fromCharCode blows the stack past ~100k args
  for (let i = 0; i < bytes.length; i += CHUNK)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** base64 float16 -> Float32Array, for the vectors the server hands back. */
export function decodeEmbedding(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const half = new Uint16Array(bytes.buffer);
  const out = new Float32Array(half.length);
  for (let i = 0; i < half.length; i++) {
    const h = half[i];
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const mant = h & 0x3ff;
    if (exp === 0) out[i] = sign * mant * Math.pow(2, -24);
    else if (exp === 0x1f) out[i] = mant ? NaN : sign * Infinity;
    else out[i] = sign * (mant + 1024) * Math.pow(2, exp - 25);
  }
  return out;
}
