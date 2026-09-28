// The controlled player's DEVICE settings, which a remote control mirrors.
//
// They are this device's persisted stores (stores.js#persistedStores): the
// player publishes them, the controller shows them in its own Réglages and
// sends back what is changed there — the same screens, pointed at another
// player. The list is explicit: a setting is lent only by being named here.
//
// Deliberately NOT lent:
//  - `viz.flash.ack`: unleashed flashing plays only once the photosensitivity
//    warning was accepted ON the device, by whoever is in front of it (and the
//    room watching its projector accepted nothing). A controller may choose
//    `viz.flash`, and without that acceptance "unleashed" plays as "full".
//  - `viz.lookahead`: a latency of this device's own output path.
//  - UI state and history (`ui.*`, `recent.*`, `playlist.lastUsed`) and the
//    transport (`player.volume`/`muted`/`shuffle`/`repeat`), which travel as
//    commands of their own.

import { get } from "svelte/store";
import { persistedStores } from "../stores.js";

export const MIRRORED = [
  // the pictures — a read-only controller may choose these
  "viz.mode",
  "viz.world",
  "viz.quality",
  "viz.palette",
  "viz.intensity",
  "viz.beat",
  "viz.showStyle",
  "viz.fps",
  "viz.fullBleed",
  "viz.scope.orientation",
  "viz.scope.colour",
  "viz.screen.mode",
  "viz.screen.quality",
  "viz.screen.world",
  "viz.eco",
  "viz.flash",
  // the sound and the stream — full
  "fx.eq.enabled",
  "fx.eq.bands",
  "fx.bass",
  "fx.normalize",
  "fx.presets",
  "fade.enabled",
  "fade.seconds",
  "fade.onSkip",
  "fade.trim",
  "fade.trimDb",
  "player.quality",
  "cache.prefetch",
  "cache.prefetchCount",
  "cache.limit",
  "offline.quality",
  "offline.onlyDownloaded",
];

/** The level a setting needs: the animations from read, the rest from full. */
export function settingLevel(key) {
  return String(key).startsWith("viz.") ? "read" : "full";
}

/** [key, store] for every mirrored setting this build has. */
export function mirroredEntries() {
  const out = [];
  for (const k of MIRRORED) {
    const st = persistedStores.get(k);
    if (st) out.push([k, st]);
  }
  return out;
}

export function mirroredMap() {
  return new Map(mirroredEntries());
}

export function snapshotSettings() {
  const out = {};
  for (const [k, st] of mirroredEntries()) out[k] = get(st);
  return out;
}

export function sameValue(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
