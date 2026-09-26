// The scene registry: what the user can pick, what each one costs, and how to
// build it.
//
// THE SCENES ARE LOADED ON DEMAND. `createScene` is async and imports the scene
// module when a scene is actually asked for, which is the first moment anything
// in here is needed. The now-playing screens import `effectiveMode` from this
// file's registry half (`./modes.js`) and must not pay for the engine to do it.
//
// Two kinds of scene come out of here:
//
//   "gl"  every mode: the WebGL2 engine (lib/viz/scenes/gl.js) with a policy
//         for which world it shows — pulse, aurora, bars and the oscilloscope
//         are one fixed world each (`pulse`, `aurora`, `spectrum`, and the
//         `scope` instrument), smart lets the genre choose among all of them.
//   "2d"  what a device with no WebGL2 gets instead (`createFallback`): the
//         oscilloscope on a canvas for the scope mode, the spectrum bars' canvas
//         twin for every other. Their arithmetic is the same Rust either way.
//
// The host (components/Visualizer.svelte) reads `scene.kind` and hands the
// scene the right surface: a canvas cannot switch context type once it has one.

export { MODES, MODE_BY_ID, effectiveMode, levelFor, needsWave } from "./modes.js";
import { loadVizCore } from "./core.js";

// The world each fixed mode shows. Smart has none: the music decides.
const FIXED = { bars: "spectrum", pulse: "pulse", aurora: "aurora", scope: "scope" };

// One promise per module, so a scene module is fetched once however many views
// ask for it.
const loading = new Map();

function load(key, importer) {
  let p = loading.get(key);
  if (p) return p;
  p = importer();
  // A failed fetch must not be remembered as a failure for ever — offline, or
  // mid-deploy, the next attempt should be allowed to work.
  p.catch(() => loading.delete(key));
  loading.set(key, p);
  return p;
}

const glModule = () => load("gl", () => import("./scenes/gl.js"));
const scopeModule = () => load("scope", () => import("./scenes/scope.js"));
const barsModule = () => load("bars", () => import("./scenes/bars.js"));

/**
 * Build a scene. Returns a PROMISE of one, or null for a mode with no scene.
 *
 * Callers must cope with the scene arriving a frame or two late and with the
 * mode having changed again in the meantime — see components/Visualizer.svelte,
 * which discards a scene whose mode is no longer the one on screen.
 */
export function createScene(mode, opts = {}) {
  // The animation core (lib/viz/core.js, Rust) loads with the engine: every
  // scene's arithmetic runs in it — the musical reading, the spectrum and the
  // uniform block, the scope's trace — and the scene is built once both are in
  // hand. A core that cannot load (no WebAssembly at all, which also means no
  // analysis to draw) rejects like a chunk that could not be fetched, and the
  // host leaves the canvas empty.
  if (mode === "smart" || FIXED[mode])
    return Promise.all([glModule(), loadVizCore()]).then(([m, core]) =>
      m.createGLScene({ ...opts, fixed: FIXED[mode] || null, core })
    );
  return null;
}

/**
 * What a device with no WebGL2 draws instead of any GL scene: the spectrum on a
 * 2D canvas. Honest rather than impressive — it is the fallback, and a picture
 * that works is better than a black one.
 */
export function createFallback(mode, opts = {}) {
  if (mode === "scope")
    return Promise.all([scopeModule(), loadVizCore()]).then(([m, core]) => m.createScopeScene({ ...opts, core }));
  return Promise.all([barsModule(), loadVizCore()]).then(([m, core]) => m.createBarsScene({ ...opts, core }));
}

/** Start fetching a scene without building it. Fire-and-forget. */
export function preloadScene(mode) {
  const p = mode === "smart" || FIXED[mode] ? glModule() : null;
  if (p) {
    p.catch(() => {});
    loadVizCore().catch(() => {});
  }
}
