// Wires the runner to the browser: a measuring Worker (decoded audio is transferred, never
// copied), the real decoder, the real API. One lane: the machine stays the person's own.
import wasmUrl from "../measure/measure.wasm?url";
// onnxruntime-web's own runtime, as a file the Worker fetches (a deep path: its package map hides it)
import ortWasmUrl from "../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url";
import ortMjsUrl from "../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url";
import { get } from "svelte/store";
import { api } from "../api.js";
import { playing } from "../stores.js";
import { createRunner } from "./runner.js";
import { decodeTrack, decodeMono16 } from "./decode.js";

let runner = null;

function workerJobs() {
  let worker = null;
  let seq = 0;
  return (kind, job, transfer) =>
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
      worker.postMessage({ id, kind, wasm: new URL(wasmUrl, location.href).href, job }, [...new Set(transfer)]);
    });
}

export function clientAnalysis() {
  if (runner) return runner;
  const send = workerJobs();
  runner = createRunner({
    api,
    decode: decodeTrack,
    measure: (job) => send("measure", job, [...job.channels.map((c) => c.buffer), job.mono44.buffer]),
    // The vector: the track as 16 kHz mono here (the browser decodes), the network in the Worker.
    embed: async (bytes, extractor) => {
      const samples = await decodeMono16(bytes);
      const model = {
        url: extractor.url,
        wasm: new URL(ortWasmUrl, location.href).href,
        mjs: new URL(ortMjsUrl, location.href).href,
      };
      return send("embed", { samples, model, version: extractor.version }, [samples.buffer]);
    },
    lanes: 1,
    busy: () => get(playing),
  });
  return runner;
}
