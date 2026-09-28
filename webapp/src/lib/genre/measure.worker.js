// The studio's construction measurer: the player's own analyser (rhythm.wasm),
// run over a decoded track as fast as it goes, summarised exactly as the
// player summarises what it hears (construction.js). For tagged tracks nobody
// has played with the analysis on — without it the head would learn from the
// "no summary" flag instead of from the kicks.
//
// One `measure` message in (mono PCM, transferred), one `done` or `error` out.
// The analyser costs ~0.1 ms a frame, so a four-minute track is ~2 s here.

import { Rhythm } from "../audio/rhythm-core.js";
import { familyTable } from "../audio/style.js";
import { rhythmWasmUrl } from "../audio/rhythm-assets.js";
import { ConstructionMeter } from "./construction.js";

let module = null;
async function compiled() {
  if (module) return module;
  const res = await fetch(rhythmWasmUrl());
  if (!res.ok) throw new Error("analyser unavailable");
  module = await WebAssembly.compile(await res.arrayBuffer());
  return module;
}

const LEVEL_SMART = 2;
const CHUNK = 4096;

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type !== "measure") return;
  const { id, pcm, sampleRate, bpm } = msg;
  try {
    const r = Rhythm.fromModule(await compiled(), sampleRate);
    r.loadFamilies(familyTable());
    r.setLevel(LEVEL_SMART);
    // The served tempo seeds the grid, as it does in the player.
    if (bpm > 20 && bpm < 400) r.seed(bpm, 0.9);
    const I = {};
    for (const k in r.layout.fields) I[k] = r.layout.fields[k][0];
    const meter = new ConstructionMeter();
    const samples = new Float32Array(pcm);
    for (let i = 0; i < samples.length; i += CHUNK) {
      const n = r.push(samples.subarray(i, Math.min(samples.length, i + CHUNK)));
      for (let k = 0; k < n; k++) meter.add(r.frame(k), I);
    }
    self.postMessage({ type: "done", id, summary: meter.summary() });
  } catch (err) {
    self.postMessage({ type: "error", id, message: String((err && err.message) || err) });
  }
};
