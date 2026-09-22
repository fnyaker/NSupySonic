// The scene registry: what the user can pick, what each one costs, and how to
// build it.
//
// THE SCENES ARE LOADED ON DEMAND. `createScene` is async and imports the scene
// module when a scene is actually asked for, which is the first moment anything
// in here is needed. Before that split the whole animation tree — four scenes,
// eighteen worlds, eight dedicated genre animations and a 227-row skin
// catalogue, about a third of a megabyte of source — sat in the main bundle
// because the now-playing screens import `effectiveMode` from this file. Every
// launch of the app parsed all of it, including the launches with animations
// switched off entirely.
//
// The registry itself is in `./modes.js`, which imports nothing. Anything that
// only needs to know which modes exist should import THAT, not this.

export { MODES, MODE_BY_ID, effectiveMode, levelFor, needsWave } from "./modes.js";

// One promise per mode, so a scene module is fetched once however many views
// ask for it and a switch back to a mode already used is synchronous-ish.
const loading = new Map();

function load(mode) {
  let p = loading.get(mode);
  if (p) return p;
  switch (mode) {
    case "bars":
      p = import("./scenes/bars.js").then((m) => m.createBarsScene);
      break;
    case "pulse":
      p = import("./scenes/pulse.js").then((m) => m.createPulseScene);
      break;
    case "scope":
      p = import("./scenes/scope.js").then((m) => m.createScopeScene);
      break;
    case "aurora":
      p = import("./scenes/aurora.js").then((m) => m.createAuroraScene);
      break;
    case "smart":
      p = import("./scenes/smart.js").then((m) => m.createSmartScene);
      break;
    default:
      return null;
  }
  // A failed fetch must not be remembered as a failure for ever — offline, or
  // mid-deploy, the next attempt should be allowed to work.
  p.catch(() => loading.delete(mode));
  loading.set(mode, p);
  return p;
}

/**
 * Build a scene. Returns a PROMISE of one, or null for a mode with no scene.
 *
 * Callers must cope with the scene arriving a frame or two late and with the
 * mode having changed again in the meantime — see components/Visualizer.svelte,
 * which discards a scene whose mode is no longer the one on screen.
 */
export function createScene(mode, opts) {
  const p = load(mode);
  return p ? p.then((make) => make(opts)) : null;
}

/** Start fetching a scene without building it. Fire-and-forget. */
export function preloadScene(mode) {
  const p = load(mode);
  if (p) p.catch(() => {});
}
