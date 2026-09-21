// Where a scene's colours come from.
//
// The user picks the SOURCE, not the colours. Five sources, each answering a
// different want:
//
//   cover     the artwork's own colour — the scene belongs to the track
//   spectrum  hue follows what the music is doing (this is the "colours by
//             BPM and by the level of each frequency band" mode: the balance
//             between bass, mids and highs sets the hue, the tempo sets how
//             fast it drifts, and the level sets how saturated it gets)
//   neon / warm / ice   fixed schemes, for when the artwork is beige
//
// A palette exposes a base hue plus three accents (low / mid / high) and is
// updated once per analysis frame. Scenes read it; nothing allocates.

import { approach, approachAngle, clamp, mixAngle, rgbToHsl } from "./util.js";
import { skinFor } from "./skins.js";

export const PALETTES = [
  { id: "cover", label: "Pochette" },
  { id: "spectrum", label: "Spectre" },
  { id: "neon", label: "Néon" },
  { id: "warm", label: "Braise" },
  { id: "ice", label: "Glace" },
  { id: "mono", label: "Monochrome" },
];

const FIXED = {
  neon: { hue: 288, spread: 92, sat: 0.92, light: 0.58 },
  warm: { hue: 22, spread: 46, sat: 0.88, light: 0.55 },
  ice: { hue: 196, spread: 58, sat: 0.8, light: 0.6 },
  mono: { hue: 265, spread: 8, sat: 0.06, light: 0.72 },
};

export function createPalette(mode = "cover") {
  let hue = 280;
  let spread = 70;
  let sat = 0.8;
  let light = 0.58;
  let drift = 0; // continuous rotation, advanced at the tempo
  let coverHue = 280;
  let coverSat = 0.7;

  const out = {
    mode,
    hue: 280,
    spread: 70,
    sat: 0.8,
    light: 0.58,
    // Accent hues for the three broad registers, so a scene can colour a bass
    // element and a treble element differently without inventing its own scheme.
    low: 280,
    mid: 300,
    high: 320,
    energy: 0,
  };

  function setMode(m) {
    if (m && m !== mode) {
      mode = m;
      out.mode = m;
    }
  }

  // The genre's own colour temperament (lib/viz/skins.js). The `warm` lean
  // below is one axis blended across families; this is the specific thing a
  // named genre asks for — acid is not simply "warm", it is acid green, and
  // black metal is not "cold", it is bleached. Like `warm` it is a LEAN on the
  // source the user picked, never a replacement: the cover still decides which
  // colour is being leaned.
  let skinHue = 0;
  let skinSat = 1;
  let skinLight = 1;
  function setSkin(s) {
    skinHue = +(s?.hue ?? 0) || 0;
    skinSat = +(s?.sat ?? 1) || 1;
    skinLight = +(s?.light ?? 1) || 1;
  }
  // Resolved from the frame, and MEMOISED on the name: this runs ninety times a
  // second and the answer only changes when the classifier renames the family.
  let lastName = null;
  function followSkin(style) {
    const name = style ? `${style.dominant}|${style.archetype}` : "";
    if (name === lastName) return;
    lastName = name;
    setSkin(style ? skinFor(style.dominant, style.archetype) : null);
  }

  // The cover's dominant colour, as [r,g,b]. Called when the track changes.
  function setCover(rgb) {
    if (!rgb) return;
    const [h, s] = rgbToHsl(rgb);
    coverHue = h;
    // A washed-out cover would give a grey scene; floor the saturation so the
    // animation still has colour in it, and cap it so a neon sleeve does not
    // produce something painful on a big screen.
    coverSat = clamp(s * 0.85 + 0.25, 0.35, 0.92);
  }

  function update(frame, dt) {
    const f = frame.features;
    const beat = frame.beat;
    const e = frame.energy;
    const total = e.sub + e.bass + e.lowMid + e.mid + e.high + e.air + 1e-12;
    const lowShare = (e.sub + e.bass) / total;
    const highShare = (e.high + e.air) / total;
    out.energy = f ? f.level : 0;

    // Drift: a full turn every 16 bars at the detected tempo, so the colour
    // cycle is locked to the music rather than to wall-clock time. With no
    // tempo yet it creeps, which reads as "waiting" rather than "broken".
    const barLen = beat?.locked ? beat.period * beat.beatsPerBar : 2.4;
    drift = (drift + (dt / (barLen * 16)) * 360) % 360;

    let targetHue;
    let targetSat;
    let targetLight;
    let targetSpread;
    if (mode === "cover") {
      targetHue = coverHue + drift * 0.28;
      targetSat = coverSat;
      targetLight = 0.56;
      targetSpread = 64;
    } else if (mode === "spectrum") {
      // Bass-heavy → the warm end, treble-heavy → the cool end, and the whole
      // mapping rotates with the tempo so a track never sits on one colour.
      const balance = clamp(0.5 + (highShare - lowShare) * 1.6, 0, 1);
      targetHue = 8 + balance * 250 + drift;
      targetSat = clamp(0.55 + (f ? f.level : 0) * 0.45, 0.5, 1);
      targetLight = clamp(0.44 + (f ? f.level : 0) * 0.2, 0.4, 0.68);
      targetSpread = 60 + (f ? f.percussivity : 0) * 70;
    } else {
      const p = FIXED[mode] || FIXED.neon;
      targetHue = p.hue + drift * 0.16;
      targetSat = p.sat;
      targetLight = p.light;
      targetSpread = p.spread;
    }

    // The genre's own temperature, as a pull rather than an override: the user
    // picked the palette SOURCE and that choice stands, but frenchcore and
    // psytrance do not want the same end of it. `warm` is 0 for cold and 1 for
    // hot, so this leans the hue a third of the way toward red or toward cyan
    // and leaves the rest of the palette alone. See style.js's LOOK_KEYS.
    const look = frame.style?.look;
    if (look) {
      const towards = look.warm > 0.5 ? 14 : 196; // red, or cyan
      const pull = Math.abs(look.warm - 0.5) * 0.62;
      targetHue = mixAngle(targetHue, towards, pull);
      // A harmony that is moving earns a little more colour; a held drone does
      // not. This is the melodic channel showing up in the palette at all.
      targetSat = clamp(targetSat + (f?.chordChange || 0) * 0.12, 0, 1);
    }

    followSkin(frame.style);
    targetHue += skinHue;
    targetSat = clamp(targetSat * skinSat, 0.02, 1);
    targetLight = clamp(targetLight * skinLight, 0.12, 0.85);

    // Ease everything: an instant hue change on a full-screen background is a
    // flash, and this runs at ~94 Hz.
    hue = approachAngle(hue, targetHue, 0.5, dt);
    sat = approach(sat, targetSat, 0.4, dt);
    light = approach(light, targetLight, 0.4, dt);
    spread = approach(spread, targetSpread, 0.7, dt);

    out.hue = hue;
    out.sat = sat;
    out.light = light;
    out.spread = spread;
    out.low = hue - spread * 0.5;
    out.mid = hue;
    out.high = hue + spread * 0.5;
    return out;
  }

  return { update, setMode, setCover, setSkin, out };
}
