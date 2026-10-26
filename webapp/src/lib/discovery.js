// The discovery level: how far from what you already play the Flow and the
// "pour vous" rows reach (0 = what you know, 1 = far from it). One value per
// PERSON, kept by the server (/api/discover/prefs) so the phone and the desktop
// agree; a copy on the device paints the slider at once before the server
// answers.
//
// Moving the slider while the Flow plays re-tunes it: the next title is chosen
// again at the new level (the track you are hearing is never cut). Both the save and the re-tune wait for the hand to
// settle, so dragging the slider costs one request, not one per pixel.

import { get, writable } from "svelte/store";
import { api } from "./api.js";
import { player } from "./stores.js";
import { adoptPrefs, retune } from "./flow.js";

const KEY = "discover.level";
export const DEFAULT_LEVEL = 0.35;
export const STEPS = [
  { name: "Proche", from: 0, hint: "Des titres qui sonnent comme ce que vous écoutez" },
  { name: "Voisin", from: 0.25, hint: "Les artistes proches de vos favoris" },
  { name: "Exploration", from: 0.5, hint: "Des genres voisins, des artistes à deux pas" },
  { name: "Aventure", from: 0.75, hint: "Loin de vos habitudes" },
];
const SETTLE_MS = 450;

function readLocal() {
  try {
    const v = parseFloat(localStorage.getItem(KEY));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_LEVEL;
  } catch {
    return DEFAULT_LEVEL;
  }
}

export const discoveryLevel = writable(readLocal());

export function stepOf(level) {
  let out = STEPS[0];
  for (const s of STEPS) if (level >= s.from) out = s;
  return out;
}

let loaded = false;
export async function loadDiscovery() {
  if (loaded) return get(discoveryLevel);
  loaded = true;
  try {
    const r = await api.discoverPrefs();
    adoptPrefs(r);
    if (r && Number.isFinite(r.level)) {
      discoveryLevel.set(r.level);
      try {
        localStorage.setItem(KEY, String(r.level));
      } catch {
        /* storage is a convenience */
      }
    }
  } catch {
    loaded = false; // ask again next time
  }
  return get(discoveryLevel);
}

let timer = null;
const listeners = new Set();
// Told once the level has settled (the home's rows refetch on it).
export function onDiscoverySettled(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setDiscovery(level) {
  const v = Math.min(1, Math.max(0, Number(level) || 0));
  discoveryLevel.set(v);
  try {
    localStorage.setItem(KEY, String(v));
  } catch {
    /* storage is a convenience */
  }
  clearTimeout(timer);
  timer = setTimeout(() => settle(v), SETTLE_MS);
}

async function settle(v) {
  api.setDiscoverLevel(v).catch(() => {});
  for (const fn of listeners) {
    try {
      fn(v);
    } catch {
      /* one listener never stops the others */
    }
  }
  // The Flow playing chooses its next title again at the new level.
  const s = get(player);
  if (s.context && s.context.kind === "flow" && s.index >= 0) retune();
}
