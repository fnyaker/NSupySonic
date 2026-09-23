// What the user can pick, and what each one costs. Deliberately SEPARATE from
// the scenes themselves.
//
// The now-playing screens, the settings page and the projector all need to know
// which modes exist and which one is in effect. Until this file existed they
// got that from `./index.js`, which imports the scene factory, which imports
// the render engine, the world registry and a two-hundred-row skin catalogue —
// on the critical path, parsed at launch by every visitor including the ones
// who never turn an animation on. Two constants are not worth that.
//
// Nothing here imports a scene, and nothing here may start doing so.

// The analysis depth each mode needs, mirroring lib/audio/engine.js#LEVEL. Kept
// as literals rather than imported for the same reason as everything else in
// this file: importing the engine to read three integers would pull the whole
// analysis tree back in.
const SPECTRUM = 0;
const RHYTHM = 1;
const SMART = 2;

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
    id: "scope",
    label: "Oscilloscope",
    hint:
      "Le signal lui-même, une trace par canal, déclenchée comme sur un vrai " +
      "oscilloscope. La précision suit le niveau de détail.",
    rhythm: false,
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
    hint:
      "Un monde par genre : la forge pour la frenchcore, le kaléidoscope pour la " +
      "psytrance, l'horizon pour la synthwave…",
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
  if (mode === "smart") return SMART;
  if (mode === "pulse") return RHYTHM;
  return SPECTRUM;
}

// Which modes need the RAW SAMPLES, per channel. Orthogonal to the level above:
// the scope wants the waveform and none of the analysis ladder, and everything
// else wants the ladder and none of the waveform. Kept here, with the rest of
// the registry, so a view can decide what to subscribe to without importing a
// scene — which is this file's whole reason for existing.
export function needsWave(mode) {
  return mode === "scope";
}
