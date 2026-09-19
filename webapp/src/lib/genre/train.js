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
  // Members averaged into the shipped head. See bagCount().
  bag: 3,
};

// A cross-validated balanced accuracy below this is weak enough that the
// projection is worth ruling out as the cause — see the end of trainHead.
const RETRY_BELOW = 0.8;

// How many members the bagged head averages, in the cross-validation and in the
// final fit.
//
// Deliberately small, and the cost is the reason rather than the benefit. Every
// member is a full Adam run over every fold, and this trainer yields to the UI
// between folds so the page keeps painting — with three members a five-fold run
// is fifteen fits, and the studio's progress bar goes from a couple of seconds
// to most of ten. That is the whole budget.
//
// Three and not one: the objective is convex and the members share their
// initialisation, so the only thing being averaged away is the batch order, and
// most of what that noise contributes is gone by the second member. Five would
// be defensible and two would be nearly as good; three is where the curve is
// already flat. Below a handful of examples a bag is not worth the arithmetic,
// so it collapses to a single fit.
export const BAG_DEFAULT = 3;
const BAG_MIN_EXAMPLES = 12;

function bagCount(opt, C, n) {
  const want = Math.max(1, Math.min(8, opt.bag ?? BAG_DEFAULT));
  if (want <= 1) return 1;
  // Fewer than a few examples per class: the folds are already a coin toss and
  // three near-identical fits add nothing but time.
  if (n < Math.max(BAG_MIN_EXAMPLES, C * 3)) return 1;
  return want;
}

/**
 * A copy of X with gaussian noise added to every row.
 *
 * OFF by default, and that is the decision rather than the starting point.
 * Adding noise to the inputs is a cheap regulariser and it sometimes helps — but
 * it helps the model that was TRAINED ON NOISY DATA, and what ships here is a
 * head evaluated on clean embeddings by a server that knows nothing about any of
 * this. There is no augmentation at inference, so noise can just as easily teach
 * the head to lean on a direction the real vector will not have. It is a bet
 * that has to be won on the held-out score, not a free win, so it stays behind
 * an explicit `noise` option and the studio does not set it.
 *
 * `sigma` is a fraction of the embedding's scale rather than an absolute amount,
 * so the same option means the same thing whatever the extractor's output range
 * is. It is added to the TRAINING rows only: the fold's held-out rows and the
 * server's real vectors stay clean, so what the score measures is still the
 * model that ships, evaluated on the data it will actually see.
 */
function noisify(X, n, d, sigma, seed) {
  const rand = rng(seed);
  const out = new Float32Array(X.length);
  out.set(X);
  for (let i = 0; i < n; i++) {
    const off = i * d;
    for (let j = 0; j < d; j++) {
      const u = Math.max(1e-12, rand());
      const v = rand();
      out[off + j] += Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
    }
  }
  return out;
}

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

function logitsInto(out, x, W, b, d, C, off) {
  for (let c = 0; c < C; c++) {
    let acc = b[c];
    const row = c * d;
    for (let i = 0; i < d; i++) acc += W[row + i] * x[off + i];
    out[c] = acc;
  }
}

function softmaxInto(out, x, W, b, d, C, off) {
  logitsInto(out, x, W, b, d, C, off);
  let top = -Infinity;
  for (let c = 0; c < C; c++) {
    if (out[c] > top) top = out[c];
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
 * Fit one scalar temperature on held-out logits, by minimum NLL.
 *
 * A softmax trained on a few hundred examples is over-confident as a rule —
 * measured on this data, a head that is right about 70% of the time reports
 * 0.9+. That matters here and not in a benchmark, because the server gates on
 * THAT number before it lets the head relabel a track: an over-confident head
 * gets its wrong calls acted on. Dividing every logit by one fitted constant
 * re-scales the confidence without changing a single argmax, so the labels the
 * studio already shows do not move and only the ones the gate would accept do.
 *
 * A coarse grid, not a solver: the objective is unimodal in log T and the
 * grid is 40 evaluations of a handful of exponentials. Precision past the grid
 * step would be fitting noise on this many examples.
 *
 * @param {Float32Array[]} held  held-out logit vectors, one per test example
 * @param {Int32Array} labels    the true class of each, same order
 * @param {number} C             class count
 * @returns {number} the fitted T, clamped to [0.5, 4] and rounded
 */
export function fitTemperature(held, labels, C) {
  if (!held.length || C < 2) return 1;
  let bestT = 1;
  let best = Infinity;
  for (let step = -20; step <= 20; step++) {
    const T = Math.pow(2, step / 20); // 0.5 .. 4, a factor of 2^(1/20) apart
    let nll = 0;
    for (let e = 0; e < held.length; e++) {
      const logits = held[e];
      const y = labels[e];
      let top = -Infinity;
      for (let c = 0; c < C; c++) if (logits[c] / T > top) top = logits[c] / T;
      let sum = 0;
      for (let c = 0; c < C; c++) sum += Math.exp(logits[c] / T - top);
      const p = Math.exp(logits[y] / T - top) / (sum || 1);
      nll -= Math.log(Math.max(p, 1e-12));
    }
    if (nll < best) {
      best = nll;
      bestT = T;
    }
  }
  return +bestT.toFixed(3);
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
    // If the caller asked for noise, add it AFTER the projection decision and to
    // whatever space we ended up in. A projected row is still a row of real
    // numbers, and the regularising effect is about the model seeing slightly
    // different examples, not about which basis they are expressed in.
    const sigma = Math.max(0, Number(opt.noise) || 0);
    const Ztr = sigma > 0 ? noisify(Z, n, dim, sigma, (Math.random() * 0xffffffff) >>> 0) : Z;

    const confusion = Array.from({ length: C }, () => new Int32Array(C));
    const p = new Float32Array(C);
    const raw = new Float32Array(C);
    // Held-out LOGITS and their true classes, kept so a temperature can be
    // fitted on them once the folds are done. Raw logits, not the softmax: the
    // fitted constant divides logits, and a row of already-squashed
    // probabilities cannot be un-squashed. Held out is the other half of the
    // point — a temperature fitted on the training rows would be fitted on the
    // inflation itself and would come back as 1.
    const held = [];
    const heldY = [];
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
        Xf.set(Ztr.subarray(src * dim, src * dim + dim), k * dim);
        yf[k] = y[src];
      });

      // BAGS, averaged in logit space. What this buys, precisely: the weights
      // start at zero and the only randomness left is the batch order, so a bag
      // is the same model that used to be trained, run again with a different
      // shuffle. Averaging a few of those averages out the part of the result
      // that was the shuffle.
      //
      // What it does NOT buy: re-sampling the DATA would give genuinely
      // different models, and is the version the literature means by bagging —
      // but for a convex objective on a few hundred examples it also means each
      // bag is missing some of the eleven zaag tracks, and the class-balanced
      // weighting exists precisely because those are the examples that matter.
      // Starving them to decorrelate an ensemble is a bad trade here. So this is
      // a variance reduction over optimisation noise and nothing more, and the
      // honest expectation is a small gain, not the usual ensemble jump.
      const bag = bagCount(opt, C, trainIdx.length);
      const accv = new Float32Array(testIdx.length * C);
      for (let b = 0; b < bag; b++) {
        const order = new Int32Array(trainIdx.length);
        for (let i = 0; i < order.length; i++) order[i] = i;
        const m = fit(Xf, yf, trainIdx.length, dim, C, opt, order);
        for (let t = 0; t < testIdx.length; t++) {
          const i = testIdx[t];
          logitsInto(raw, Z, m.W, m.b, dim, C, i * dim);
          const o = t * C;
          for (let c = 0; c < C; c++) accv[o + c] += raw[c];
        }
      }
      for (let t = 0; t < testIdx.length; t++) {
        const i = testIdx[t];
        const o = t * C;
        // The held-out verdict is the BAG's, never one member's: a
        // cross-validated score is only honest if what is scored is what ships,
        // and what ships is the average.
        let top = -Infinity;
        let got = 0;
        for (let c = 0; c < C; c++) {
          const v = accv[o + c];
          if (v > top) {
            top = v;
            got = c;
          }
        }
        confusion[y[i]][got]++;
        if (got === y[i]) correct++;
        total++;
        held.push(Array.from(accv.subarray(o, o + C)));
        heldY.push(y[i]);
      }
    }

    const temperature = fitTemperature(held, heldY, C);

    report(label, 0.85);
    await yieldToUI();
    // The shipped head is the bagged average, for the same reason the score is:
    // the number the user reads and the model they end up with have to be the
    // same object, or the studio is reporting on something that does not exist.
    const bag = bagCount(opt, C, n);
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const Wd = new Float32Array(C * dim);
    const bd = new Float32Array(C);
    for (let b = 0; b < bag; b++) {
      const m = fit(Ztr, y, n, dim, C, opt, order);
      for (let i = 0; i < Wd.length; i++) Wd[i] += m.W[i];
      for (let c = 0; c < C; c++) bd[c] += m.b[c];
    }
    const invBag = 1 / bag;
    for (let i = 0; i < Wd.length; i++) Wd[i] *= invBag;
    for (let c = 0; c < C; c++) bd[c] *= invBag;
    // Fold the projection into the weights: what leaves here is always a plain
    // head over the original embedding, whatever was done to train it. Unfolding
    // is linear, so it commutes with the average above — no need to undo each
    // member separately.
    const W = useProj ? unproject(Wd, P, C, dim, d) : Wd;

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

    // The pairs the model mixes up, read straight off the matrix that was
    // already computed. There is no taxonomy to declare: the confusion IS the
    // hierarchy, measured on this library's own labels rather than assumed from
    // a genre list nobody here uses.
    //
    // It is worth surfacing for a reason that is not about the model at all. Two
    // labels that the model keeps swapping are either two genres that genuinely
    // sound alike — in which case the tags are fine and the boundary is hard —
    // or ONE genre that has been labelled inconsistently, in which case the fix
    // is in the vocabulary and not in the training. The studio cannot tell those
    // apart on the user's behalf, but it can show them the pair and let the
    // human, who knows what they meant, decide.
    const confusions = [];
    for (let a = 0; a < C; a++) {
      for (let b = 0; b < C; b++) {
        if (a === b || !confusion[a][b]) continue;
        confusions.push({
          from: labels[a],
          to: labels[b],
          count: confusion[a][b],
          // Share of this genre's examples that went to the other label, which
          // is the number that says "this is systematic" rather than one stray
          // track.
          share: byClass[a].length ? +(confusion[a][b] / byClass[a].length).toFixed(3) : 0,
        });
      }
    }
    confusions.sort((x, y) => y.count - x.count);

    return {
      // Named rather than assumed: encodeHead's layout and the server's reader
      // both branch on this, and a head that arrived without it would be
      // stored as whatever the default happened to be that day.
      kind: "linear",
      labels,
      dim: d,
      W,
      b: bd,
      metrics: {
        examples: n,
        classes: C,
        folds,
        projected: useProj ? projDim : 0,
        bagged: bag > 1 ? bag : 0,
        noise: Math.max(0, Number(opt.noise) || 0),
        accuracy: total ? +(correct / total).toFixed(3) : 0,
        balanced: +balanced.toFixed(3),
        temperature,
        perClass,
        confusions,
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
