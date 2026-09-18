// The scene registry: what the user can pick, what each one costs, and how to
// build it.

import { LEVEL } from "../audio/engine.js";
import { createBarsScene } from "./scenes/bars.js";
import { createPulseScene } from "./scenes/pulse.js";
import { createAuroraScene } from "./scenes/aurora.js";
import { createSmartScene } from "./scenes/smart.js";

export const MODES = [
  {
    id: "off",
    label: "Aucune",
    hint: "Le lecteur seul, rien d'animé. Aucun coût.",
    rhythm: false,
    fullBleed: false,
  },
  {
    id: "bars",
    label: "Barres",
    hint: "Le spectre, avec une vraie résolution dans les graves.",
    rhythm: false,
    fullBleed: false,
  },
  {
    id: "pulse",
    label: "Pulsations",
    hint: "Couleurs au tempo, une lobe par bande de fréquence, ondes sur chaque temps.",
    rhythm: true,
    fullBleed: true,
  },
  {
    id: "aurora",
    label: "Aurore",
    hint: "Rubans lents. L'option calme, et la plus légère en plein écran.",
    rhythm: false,
    fullBleed: true,
  },
  {
    id: "smart",
    label: "Moteur intelligent",
    hint: "Écoute le morceau — tempo, type de kick, style — et compose l'animation.",
    rhythm: true,
    fullBleed: true,
  },
];

export const MODE_BY_ID = new Map(MODES.map((m) => [m.id, m]));

// A mode that needs rhythm analysis while it is switched off would draw nothing
// but its idle state, which looks broken. Degrade to the nearest mode that
// works instead of showing a dead canvas. Eco mode overrides everything: it
// means none, and none is not a scene to degrade to a cheaper one.
export function effectiveMode(mode, beatDetect, eco = false) {
  if (eco) return "off";
  if (!MODE_BY_ID.has(mode)) return "bars";
  if (beatDetect) return mode;
  if (mode === "smart") return "aurora";
  if (mode === "pulse") return "aurora";
  return mode;
}

export function levelFor(mode) {
  if (mode === "smart") return LEVEL.SMART;
  if (mode === "pulse") return LEVEL.RHYTHM;
  return LEVEL.SPECTRUM;
}

export function createScene(mode, opts) {
  switch (mode) {
    case "bars":
      return createBarsScene(opts);
    case "pulse":
      return createPulseScene(opts);
    case "aurora":
      return createAuroraScene(opts);
    case "smart":
      return createSmartScene(opts);
    default:
      return null;
  }
}
