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
