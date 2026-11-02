// Wires the runner to the browser: a measuring Worker (decoded audio is transferred, never
// copied), the real decoder, the real API. One lane: the machine stays the person's own.
import wasmUrl from "../measure/measure.wasm?url";
import { api } from "../api.js";
import { createRunner } from "./runner.js";
import { decodeTrack } from "./decode.js";

let runner = null;

function measureInWorker() {
  let worker = null;
  let seq = 0;
  return (job) =>
    new Promise((resolve, reject) => {
      worker ||= new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      const id = ++seq;
      const done = (ev) => {
        if (ev.data.id !== id) return;
        worker.removeEventListener("message", done);
        ev.data.error ? reject(new Error(ev.data.error)) : resolve(ev.data.out);
      };
      worker.addEventListener("message", done);
      worker.addEventListener("error", (e) => reject(new Error(e.message || "worker failed")), { once: true });
      const transfer = [...new Set(job.channels.map((c) => c.buffer)), job.mono44.buffer];
      worker.postMessage({ id, wasm: new URL(wasmUrl, location.href).href, job }, [...new Set(transfer)]);
    });
}

export function clientAnalysis() {
  runner ||= createRunner({ api, decode: decodeTrack, measure: measureInWorker(), lanes: 1 });
  return runner;
}
