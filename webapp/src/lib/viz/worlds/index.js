// The worlds, loaded one at a time.
//
// Each world is its own chunk: its GLSL, its parameters, its driver. The app
// fetches a world the first time the music (or the user) asks for it, so a
// session of techno never downloads the frenchcore forge, and a launch with the
// animations off downloads none of them.
//
// Every entry is a LITERAL import() on purpose — it is what lets the bundler
// see forty-odd separate chunks instead of one opaque dynamic path.

import { WORLD_META, GROUPS, worldFor } from "./catalogue.js";

const LOADERS = {
  pulse: () => import("./pulse.js"),
  spectrum: () => import("./spectrum.js"),
  aurora: () => import("./aurora.js"),
  forge: () => import("./forge.js"),
  lasers: () => import("./lasers.js"),
  shatter: () => import("./shatter.js"),
  bounce: () => import("./bounce.js"),
  saw: () => import("./saw.js"),
  tunnel: () => import("./tunnel.js"),
  warehouse: () => import("./warehouse.js"),
  hyperspace: () => import("./hyperspace.js"),
  kaleido: () => import("./kaleido.js"),
  wobble: () => import("./wobble.js"),
  stairs: () => import("./stairs.js"),
  pingpong: () => import("./pingpong.js"),
  soundsystem: () => import("./soundsystem.js"),
  static: () => import("./static.js"),
  microwave: () => import("./microwave.js"),
  fireworks: () => import("./fireworks.js"),
  ridges: () => import("./ridges.js"),
  lattice: () => import("./lattice.js"),
  circuit: () => import("./circuit.js"),
  galaxy: () => import("./galaxy.js"),
  flow: () => import("./flow.js"),
  chrome: () => import("./chrome.js"),
  slices: () => import("./slices.js"),
  vinyl: () => import("./vinyl.js"),
  halo: () => import("./halo.js"),
  nightdrive: () => import("./nightdrive.js"),
  neon: () => import("./neon.js"),
  bokeh: () => import("./bokeh.js"),
  discoball: () => import("./discoball.js"),
  silk: () => import("./silk.js"),
  artwork: () => import("./artwork.js"),
  plasma: () => import("./plasma.js"),
  stage: () => import("./stage.js"),
  inferno: () => import("./inferno.js"),
  storm: () => import("./storm.js"),
  nebula: () => import("./nebula.js"),
  ocean: () => import("./ocean.js"),
  cathedral: () => import("./cathedral.js"),
  ink: () => import("./ink.js"),
  rain: () => import("./rain.js"),
  fireflies: () => import("./fireflies.js"),
  carnival: () => import("./carnival.js"),
  tropics: () => import("./tropics.js"),
  horizon: () => import("./horizon.js"),
  pixels: () => import("./pixels.js"),
};

const cache = new Map();

/** True when the world exists AND has code behind it. */
export function hasWorld(id) {
  return !!LOADERS[id] && !!WORLD_META[id];
}

/** Every world with code behind it, in catalogue order. */
export function worldIds() {
  return Object.keys(WORLD_META).filter((id) => LOADERS[id]);
}

/**
 * The world's definition (its module's default export). Cached per id; a
 * failed fetch is forgotten, so going back online lets the next attempt work.
 */
export function loadWorld(id) {
  const load = LOADERS[id];
  if (!load) return Promise.reject(new Error(`no world "${id}"`));
  let p = cache.get(id);
  if (p) return p;
  p = load().then((mod) => {
    const def = mod.default;
    if (!def || def.id !== id) throw new Error(`world module "${id}" is malformed`);
    return def;
  });
  p.catch(() => cache.delete(id));
  cache.set(id, p);
  return p;
}

export { WORLD_META, GROUPS, worldFor };
