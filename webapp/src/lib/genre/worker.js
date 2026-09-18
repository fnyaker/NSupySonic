// The training worker.
//
// Training a head is between one and ten seconds of solid arithmetic. On the
// main thread that is one to ten seconds during which the page does not scroll,
// the player does not repaint and the browser offers to kill the tab — which is
// not a progress bar, it is a freeze. So it runs here, and the studio gets
// progress messages instead.
//
// The protocol is deliberately small: one `train` message in, `progress`
// messages out, one `done` or `error` to finish. The embeddings arrive as a
// transferred ArrayBuffer (no copy), and the trained head goes back the same
// way.

import { trainHead } from "./train.js";
import { trainDeep } from "./deep.js";
import kernelUrl from "./wasm/kernel.wasm?url";

let kernelBytes = null;

async function kernel() {
  if (kernelBytes) return kernelBytes;
  const res = await fetch(kernelUrl);
  if (!res.ok) throw new Error("kernel unavailable");
  kernelBytes = await res.arrayBuffer();
  return kernelBytes;
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type !== "train") return;
  const { id, mode, X, y, n, dim, labels, options } = msg;
  const data = {
    X: new Float32Array(X),
    y: new Int32Array(y),
    n,
    d: dim,
    labels,
  };
  const onProgress = (stage, pct) =>
    self.postMessage({ type: "progress", id, stage, pct });
  try {
    const head =
      mode === "deep"
        ? await trainDeep(data, await kernel(), onProgress, options || {})
        : await trainHead(data, null, options || {});
    // Float32Arrays cross as transferables, so a head with a 128x1280 first
    // layer (640 KB) costs nothing to hand back.
    const transfer = [];
    for (const key of ["W", "b", "W1", "b1", "W2", "b2"])
      if (head[key]) transfer.push(head[key].buffer);
    self.postMessage({ type: "done", id, head }, transfer);
  } catch (err) {
    self.postMessage({ type: "error", id, message: String((err && err.message) || err) });
  }
};
