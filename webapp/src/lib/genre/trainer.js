// Main-thread side of the training worker.
//
// One worker, created on demand and kept for the session: spinning one up costs
// a module graph and a WebAssembly compile, and the studio trains repeatedly
// (that is the whole workflow — tag a few more, retrain, look at the numbers).

let worker = null;
let seq = 0;
const pending = new Map();

function ensure() {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (ev) => {
    const msg = ev.data || {};
    const job = pending.get(msg.id);
    if (!job) return;
    if (msg.type === "progress") job.onProgress?.(msg.stage, msg.pct);
    else if (msg.type === "done") {
      pending.delete(msg.id);
      job.resolve(msg.head);
    } else if (msg.type === "error") {
      pending.delete(msg.id);
      job.reject(new Error(msg.message));
    }
  };
  worker.onerror = (ev) => {
    // A worker that failed to start (a blocked module URL, a hostile CSP) must
    // not leave the studio spinning for ever.
    const err = new Error(ev.message || "training worker failed");
    for (const [, job] of pending) job.reject(err);
    pending.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

/**
 * Train a head off the main thread.
 *
 * @param {{X: Float32Array, y: Int32Array, n: number, d: number, labels: string[]}} data
 * @param {"linear"|"deep"} mode
 */
export function train(data, mode = "linear", onProgress = null, options = {}) {
  const w = ensure();
  const id = ++seq;
  // The caller's arrays are transferred, so they are detached here afterwards —
  // the studio rebuilds its matrix per run, which is cheap next to training.
  const X = data.X.buffer;
  const y = data.y.buffer;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage(
      {
        type: "train",
        id,
        mode,
        X,
        y,
        n: data.n,
        dim: data.d,
        labels: data.labels,
        options,
      },
      [X, y]
    );
  });
}

/** Drop the worker (the studio does this when its page unmounts). */
export function release() {
  if (!worker) return;
  worker.terminate();
  worker = null;
  for (const [, job] of pending) job.reject(new Error("cancelled"));
  pending.clear();
}
