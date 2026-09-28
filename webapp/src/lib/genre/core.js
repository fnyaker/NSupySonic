// The genre studio's trainer, on the Rust core (webapp/trainer, compiled to
// trainer.wasm / trainer-simd.wasm).
//
// It replaced two JavaScript trainers and a C kernel (test/reference/genre-*):
// the linear softmax head and the stack of dense layers are one crate now, with
// the whole run inside it — folds (by artist when asked), bags, the random
// projection and its retry, the temperature, the confusion matrix. What stays
// here is the page's half: copying the rows in, stepping the job so the worker
// can report progress, and turning the numbers back into the head object the
// studio shows and ships (`wire.js#encodeHead`), in the shape the JavaScript
// trainers returned it.
//
// No `?url` imports on purpose: the worker picks the binary and hands the
// bytes over, so the Node test suite can load this module and the binary
// straight off disk.

/** The linear head's defaults (as the JavaScript trainer had them). */
export const DEFAULTS = {
  epochs: 60,
  lr: 0.08,
  l2: 1e-4,
  batch: 32,
  folds: 5,
  // Train in a randomly projected space when the embedding is wide, and retry
  // at full width if the score comes back weak. 0 disables it.
  proj: 256,
  // Fits averaged into the shipped head (and into every held-out verdict).
  bag: 3,
};

/** The dense stack's defaults. */
export const DEEP_DEFAULTS = {
  hidden: 256,
  hidden2: 0,
  epochs: 120,
  lr: 0.02,
  l2: 3e-4,
  batch: 32,
  folds: 3,
  // Measured: projecting to 384 cost ten points of balanced accuracy on
  // marginal data (0.890 against 0.998). Off, on the path that exists because
  // the accuracy was not good enough.
  proj: 0,
};

const ERRORS = {
  1: "not enough labelled tracks",
  2: "deep training needs at least three examples per genre",
  3: "the training data is not usable (a vector with a non-finite value?)",
  4: "at least two genres are needed",
};

/** Instantiate the trainer from its bytes (or an already compiled module). */
export async function loadTrainer(source) {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * Train a head.
 *
 * @param x        the trainer's exports (loadTrainer)
 * @param data     { X: Float32Array (n*d), y: Int32Array, n, d, labels: string[],
 *                   groups?: Int32Array (an artist id per row, -1 for none) }
 * @param mode     "linear" | "deep"
 * @param options  overrides of DEFAULTS / DEEP_DEFAULTS, plus `grouped` (hold
 *                 out whole artists) and `seed` (repeat a run exactly)
 * @param onProgress (stage, pct) — called between epochs, at most every
 *                 `options.progressEvery` ms (80 by default)
 */
export function trainOn(x, data, mode = "linear", options = {}, onProgress = null) {
  const deep = mode === "deep";
  const opt = { ...(deep ? DEEP_DEFAULTS : DEFAULTS), ...options };
  const { X, y, n, d, labels } = data;
  const C = labels.length;
  const groups = data.groups && data.groups.length === n ? data.groups : null;
  const grouped = !!opt.grouped && !!groups;
  const seed = Number.isFinite(opt.seed) ? opt.seed >>> 0 : (Math.random() * 0x100000000) >>> 0;
  if (!x.tr_new(n, d, C)) throw new Error(ERRORS[3]);
  try {
    new Float32Array(x.memory.buffer, x.tr_x(), n * d).set(X.subarray(0, n * d));
    new Int32Array(x.memory.buffer, x.tr_y(), n).set(y.subarray(0, n));
    if (groups) new Int32Array(x.memory.buffer, x.tr_groups(), n).set(groups);
    x.tr_config(
      deep ? 1 : 0,
      opt.epochs | 0,
      +opt.lr,
      +opt.l2,
      opt.batch | 0,
      opt.folds | 0,
      Math.max(0, opt.proj | 0),
      deep ? 1 : Math.max(1, (opt.bag ?? 1) | 0),
      Math.max(1, (opt.hidden ?? 1) | 0),
      Math.max(0, (opt.hidden2 ?? 0) | 0),
      deep ? 0 : Math.max(0, Number(opt.noise) || 0),
      seed,
      grouped ? 1 : 0
    );
    const err = x.tr_start();
    if (err) throw new Error(ERRORS[err] || `training refused (${err})`);
    const stage = deep ? "deep" : "training";
    const every = Number.isFinite(opt.progressEvery) ? opt.progressEvery : 80;
    let p = 0;
    let last = now();
    while (p < 1) {
      p = x.tr_step(1);
      if (onProgress && p < 1 && now() - last >= every) {
        last = now();
        onProgress(stage, p);
      }
    }
    if (onProgress) onProgress("done", 1);
    return readHead(x, data, deep, opt, seed, grouped, groups);
  } finally {
    x.tr_free();
  }
}

function readHead(x, data, deep, opt, seed, grouped, groups) {
  const { y, n, d, labels } = data;
  const C = labels.length;
  const res = new Float64Array(x.memory.buffer, x.tr_res(), 16).slice();
  const kindCode = res[0];
  const confFlat = new Int32Array(x.memory.buffer, x.tr_conf(), C * C).slice();
  const layers = [];
  for (let l = 0; l < res[9]; l++) {
    const rows = x.tr_rows(l);
    const cols = x.tr_cols(l);
    layers.push({
      W: new Float32Array(x.memory.buffer, x.tr_w(l), rows * cols).slice(),
      b: new Float32Array(x.memory.buffer, x.tr_b(l), rows).slice(),
      rows,
      cols,
    });
  }
  const confusion = [];
  for (let c = 0; c < C; c++) confusion.push(Array.from(confFlat.subarray(c * C, (c + 1) * C)));

  const examples = new Array(C).fill(0);
  for (let i = 0; i < n; i++) examples[y[i]]++;
  // How many DIFFERENT artists each genre's examples come from: the number
  // that says whether a score can mean "this genre" or only "these artists".
  let artists = null;
  if (groups) {
    const sets = Array.from({ length: C }, () => new Set());
    let solo = 0;
    for (let i = 0; i < n; i++) sets[y[i]].add(groups[i] >= 0 ? groups[i] : `solo${solo++}`);
    artists = sets.map((s) => s.size);
  }
  // Per-class recall is what tells the user where to tag more; precision is
  // what says which label the model reaches for when it is unsure.
  const perClass = labels.map((label, c) => {
    const row = confusion[c];
    const hit = row[c];
    let seen = 0;
    for (let k = 0; k < C; k++) seen += row[k];
    let predicted = 0;
    for (let k = 0; k < C; k++) predicted += confusion[k][c];
    const out = {
      label,
      examples: examples[c],
      recall: seen ? +(hit / seen).toFixed(3) : 0,
      precision: predicted ? +(hit / predicted).toFixed(3) : 0,
    };
    if (artists) out.artists = artists[c];
    return out;
  });
  // The pairs the model mixes up, read straight off the matrix. Two labels it
  // keeps swapping are either two genres that genuinely sound alike or ONE
  // genre tagged inconsistently; the studio shows the pair and the person who
  // knows what they meant decides.
  const confusions = [];
  for (let a = 0; a < C; a++)
    for (let b = 0; b < C; b++) {
      if (a === b || !confusion[a][b]) continue;
      confusions.push({
        from: labels[a],
        to: labels[b],
        count: confusion[a][b],
        share: examples[a] ? +(confusion[a][b] / examples[a]).toFixed(3) : 0,
      });
    }
  confusions.sort((p, q) => q.count - p.count);

  const metrics = {
    examples: n,
    classes: C,
    folds: res[1],
    projected: res[2],
    accuracy: res[4],
    balanced: res[5],
    temperature: res[6],
    grouped,
    seed,
    perClass,
    confusions,
    confusion,
  };
  if (res[7]) metrics.retried = true;
  if (deep) {
    metrics.hidden = Math.max(1, opt.hidden | 0);
    metrics.hidden2 = Math.max(0, opt.hidden2 | 0);
    const head = {
      kind: kindCode === 2 ? "mlp2" : "mlp",
      labels,
      dim: d,
      hidden: metrics.hidden,
      metrics,
    };
    layers.forEach((layer, i) => {
      head[`W${i + 1}`] = layer.W;
      head[`b${i + 1}`] = layer.b;
    });
    return head;
  }
  metrics.bagged = res[3];
  metrics.noise = Math.max(0, Number(opt.noise) || 0);
  return { kind: "linear", labels, dim: d, W: layers[0].W, b: layers[0].b, metrics };
}

/** The temperature the trainer fits on held-out logits (rows of C), for tests. */
export function fitTemperatureOn(x, held, labels, C) {
  const rows = held.length;
  const ptr = x.tr_temp_logits(rows, C);
  const L = new Float32Array(x.memory.buffer, ptr, rows * C);
  held.forEach((r, i) => L.set(r, i * C));
  new Int32Array(x.memory.buffer, x.tr_temp_labels(), rows).set(labels);
  return x.tr_temperature(rows, C);
}
