// The measuring thread: one wasm instance, one job at a time, so the page never runs the FFT
// nor the network. Jobs: "measure" (spectral, loudness, tempo) and "embed" (the extractor).
import { loadMeasure, measureTrack } from "./measure.js";
import { embedSamples, encodeVector } from "./embed.js";

let core = null;
let net = null; // { key, session, ort }

async function session(job) {
  if (net && net.key === job.model.url) return net;
  const ort = await import("onnxruntime-web/wasm");
  ort.env.wasm.wasmPaths = { wasm: job.model.wasm, mjs: job.model.mjs };
  ort.env.wasm.numThreads = 1; // one core: the machine stays the person's own
  ort.env.wasm.proxy = false;
  const { fetchBlocks } = await import("./download.js");
  const bytes = await fetchBlocks(job.model.url, { maxBytes: 1024 * 1024 * 1024 });
  const s = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  net = { key: job.model.url, session: s, ort };
  return net;
}

self.onmessage = async (ev) => {
  const { id, wasm, kind, job } = ev.data;
  try {
    core ||= await loadMeasure(wasm);
    if (kind === "embed") {
      const n = await session(job);
      const vec = await embedSamples(core, n.session, n.ort, job.samples);
      self.postMessage({ id, out: { version: job.version, data: encodeVector(vec) } });
    } else {
      self.postMessage({ id, out: measureTrack(core, job) });
    }
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
