// The measuring thread: one wasm instance, one job at a time, so the page never runs the FFT.
import { loadMeasure, measureTrack } from "./measure.js";

let core = null;
self.onmessage = async (ev) => {
  const { id, wasm, job } = ev.data;
  try {
    core ||= await loadMeasure(wasm);
    const out = measureTrack(core, job);
    self.postMessage({ id, out });
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
