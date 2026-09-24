// The files the rhythm analyser is made of, as URLs Vite emits into the build:
// the WebAssembly binary in two builds (webapp/rhythm, compiled by `npm run
// wasm`) and the AudioWorklet that runs it, bundled as a worker chunk so its
// import of rhythm-core.js travels with it and it is served from the app's own
// origin.
//
// Kept out of engine.js on purpose: engine.js is imported by modules the Node
// test suite loads (lib/viz/bridge.js), and Node can neither resolve Vite's
// `?url` suffixes nor evaluate a worklet. engine.js reaches this file through a
// dynamic import(), the first time an animation actually needs the analysis.
import wasmUrl from "./rhythm.wasm?url";
import wasmSimdUrl from "./rhythm-simd.wasm?url";
import workletUrl from "./rhythm.worklet.js?worker&url";

// The smallest module that uses SIMD128 (an i8x16.splat and i8x16.popcnt, the
// probe wasm-feature-detect uses): if the engine validates it, the SIMD build
// runs there. Chrome 91, Firefox 89 and Safari 16.4 do; anything older gets the
// baseline build, which computes exactly the same frames.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253,
  98, 11,
]);

export function rhythmWasmUrl() {
  try {
    if (WebAssembly.validate(SIMD_PROBE)) return wasmSimdUrl;
  } catch {
    /* no WebAssembly.validate: the baseline it is */
  }
  return wasmUrl;
}

export { workletUrl };

// The binary, fetched and compiled ONCE per page: the analyser's AudioWorklet
// is handed the compiled module (with the bytes as the fallback for a browser
// that cannot pass a module to a worklet), and the animations instantiate the
// same module on the page for their own arithmetic (lib/viz/core.js). Two
// consumers, one download, one compile.
let binary = null;
export function rhythmBinary() {
  if (!binary) {
    binary = fetch(rhythmWasmUrl())
      .then((res) => {
        if (!res.ok) throw new Error(`rhythm.wasm: HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then(async (bytes) => ({ bytes, module: await WebAssembly.compile(bytes) }));
    // Offline and not cached yet: the next caller tries again.
    binary.catch(() => (binary = null));
  }
  return binary;
}
