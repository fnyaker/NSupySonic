// The training worker.
//
// Training a head is between one second and several minutes of solid
// arithmetic. On the main thread that is a page that does not scroll, a player
// that does not repaint and a browser offering to kill the tab — not a progress
// bar, a freeze. So it runs here, on the Rust trainer (core.js), and the studio
// gets progress messages instead.
//
// The protocol is deliberately small: one `train` message in, `progress`
// messages out, one `done` or `error` to finish. The embeddings arrive as a
// transferred ArrayBuffer (no copy), and the trained head goes back the same
// way.

import { loadTrainer, trainOn } from "./core.js";
import wasmUrl from "./trainer.wasm?url";
import wasmSimdUrl from "./trainer-simd.wasm?url";

// The smallest module that uses SIMD128 (the probe wasm-feature-detect uses,
// as rhythm-assets.js does for the analyser). The SIMD build computes the same
// bits as the baseline one, only faster.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253,
  98, 11,
]);

let trainer = null;

async function load() {
  if (trainer) return trainer;
  let url = wasmUrl;
  try {
    if (WebAssembly.validate(SIMD_PROBE)) url = wasmSimdUrl;
  } catch {
    /* no WebAssembly.validate: the baseline it is */
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error("trainer unavailable");
  trainer = await loadTrainer(await res.arrayBuffer());
  return trainer;
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type !== "train") return;
  const { id, mode, X, y, groups, n, dim, labels, options } = msg;
  const data = {
    X: new Float32Array(X),
    y: new Int32Array(y),
    groups: groups ? new Int32Array(groups) : null,
    n,
    d: dim,
    labels,
  };
  const onProgress = (stage, pct) => self.postMessage({ type: "progress", id, stage, pct });
  try {
    const head = trainOn(await load(), data, mode === "deep" ? "deep" : "linear", options || {}, onProgress);
    // Float32Arrays cross as transferables, so a head with a 512x2560 first
    // layer (5 MB) costs nothing to hand back.
    const transfer = [];
    for (const key of ["W", "b", "W1", "b1", "W2", "b2", "W3", "b3"])
      if (head[key]) transfer.push(head[key].buffer);
    self.postMessage({ type: "done", id, head }, transfer);
  } catch (err) {
    self.postMessage({ type: "error", id, message: String((err && err.message) || err) });
  }
};
