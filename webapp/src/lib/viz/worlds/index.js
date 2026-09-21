// One animation per KIND OF MUSIC, not one animation with per-genre knobs.
//
// The engine used to be a fixed set of layers whose alphas the classifier
// moved. That is the right shape for blending *within* a style and the wrong
// shape for the question actually being asked: frenchcore and ambient came out
// of the same primitives at different weights, so they looked like the same
// animation twice. They should not look related at all.
//
// So each family maps to a WORLD: a self-contained scene with its own motif,
// its own motion and its own background. Thirteen of them, drawn from what the
// genres themselves look like when someone designs a visual for them:
//
//   tunnel       a machine corridor rushing at the viewer — techno, hardtechno,
//                industrial. Strict, cold, no randomness anywhere in it.
//   shatter      the frame breaks into radiating shards on every kick, rotates
//                a notch and pulls back — hardcore, frenchcore, uptempo,
//                speedcore, krach, tribecore.
//   hardbounce   a core that squashes on the kick inside a radial bar ring,
//                with saw streaks on the lead — hardstyle, rawstyle, hardtekk,
//                zaag, hardpingpong, german party, pieep.
//   kaleido      mirrored sectors turning against each other — psytrance.
//   starfield    stars streaming out, accelerating through a build, with arcs
//                on the chord changes — trance.
//   breakgrid    the picture sliced into strips that scroll and chop on the
//                breaks — drum & bass, breakbeat, garage.
//   wobble       one band across the middle, LFO'd and chromatically split,
//                tearing on the drop — dubstep.
//   vinyl        a turning record with a boom on the kick and a slash on the
//                snare — hip-hop, rap, trap, phonk, reggaeton, dancehall.
//   stagelights  sweeping spotlights over a jagged wall, slashes on the
//                snare — rock, metal, punk, hard rock, brutal.
//   horizon      the outrun sun over a perspective floor grid — synthwave,
//                lofi.
//   bloom        soft blooms and confetti, bright and friendly — pop, dance,
//                house, disco, funk, soul, R&B, afro, amapiano, indie.
//   smoke        brush strokes appearing on the notes and drifting — jazz,
//                blues, folk, country, reggae.
//   nebula       slow clouds, no beat markers at all — ambient, strings.
//
// Each world still reads the `look` vector inside itself (style.js LOOK_KEYS),
// which is what keeps hardstyle from looking exactly like hardtekk — but the
// coarse answer, the thing you recognise across the room, is the world.
//
// NOTHING HARD-SWITCHES. The classifier's `dominant` already has hysteresis (a
// challenger must lead for a second and a half), and the compositor crossfades
// between two worlds over ~1.6 s on top of that, so a change of opinion is a
// dissolve and never a cut.

import { createTunnelWorld } from "./tunnel.js";
import { createShatterWorld } from "./shatter.js";
import { createHardbounceWorld } from "./hardbounce.js";
import { createKaleidoWorld } from "./kaleido.js";
import { createStarfieldWorld } from "./starfield.js";
import { createBreakgridWorld } from "./breakgrid.js";
import { createWobbleWorld } from "./wobble.js";
import { createVinylWorld } from "./vinyl.js";
import { createStagelightsWorld } from "./stagelights.js";
import { createHorizonWorld } from "./horizon.js";
import { createBloomWorld } from "./bloom.js";
import { createSmokeWorld } from "./smoke.js";
import { createNebulaWorld } from "./nebula.js";

// `trail` is how much of the previous frame each world keeps: the compositor
// washes with it, so a world states its own smear rather than inheriting one
// tuned for somebody else's motif.
export const WORLDS = {
  tunnel: { label: "Corridor", trail: 0.42, make: createTunnelWorld },
  shatter: { label: "Éclats", trail: 0.55, make: createShatterWorld },
  hardbounce: { label: "Rebond", trail: 0.5, make: createHardbounceWorld },
  kaleido: { label: "Kaléidoscope", trail: 0.34, make: createKaleidoWorld },
  starfield: { label: "Champ d'étoiles", trail: 0.3, make: createStarfieldWorld },
  breakgrid: { label: "Découpe", trail: 0.6, make: createBreakgridWorld },
  wobble: { label: "Wobble", trail: 0.5, make: createWobbleWorld },
  vinyl: { label: "Vinyle", trail: 0.45, make: createVinylWorld },
  stagelights: { label: "Projecteurs", trail: 0.4, make: createStagelightsWorld },
  horizon: { label: "Horizon", trail: 1, make: createHorizonWorld },
  bloom: { label: "Éclosion", trail: 0.4, make: createBloomWorld },
  smoke: { label: "Fumée", trail: 0.18, make: createSmokeWorld },
  nebula: { label: "Nébuleuse", trail: 0.12, make: createNebulaWorld },
};

// Every family the classifier can name, and the world it belongs to. Kept as
// one flat table on purpose: adding a family to style.js and forgetting to
// place it here is a one-line fix, and `worldFor` falls back by archetype in
// the meantime rather than breaking.
export const FAMILY_WORLD = {
  // --- machine -------------------------------------------------------------
  techno: "tunnel",
  hardtechno: "tunnel",
  industrial: "tunnel",
  electronic: "tunnel",
  // --- hard ----------------------------------------------------------------
  hardcore: "shatter",
  frenchcore: "shatter",
  uptempo: "shatter",
  speedcore: "shatter",
  krach: "shatter",
  tribecore: "shatter",
  hardstyle: "hardbounce",
  rawstyle: "hardbounce",
  hardtekk: "hardbounce",
  zaag: "hardbounce",
  hardpingpong: "hardbounce",
  germanparty: "hardbounce",
  pieep: "hardbounce",
  // --- melodic electronic --------------------------------------------------
  psytrance: "kaleido",
  trance: "starfield",
  // --- breaks --------------------------------------------------------------
  dnb: "breakgrid",
  breakbeat: "breakgrid",
  garage: "breakgrid",
  dubstep: "wobble",
  // --- urban ---------------------------------------------------------------
  hiphop: "vinyl",
  rap: "vinyl",
  trap: "vinyl",
  phonk: "vinyl",
  reggaeton: "vinyl",
  dancehall: "vinyl",
  // --- band ----------------------------------------------------------------
  rock: "stagelights",
  hardrock: "stagelights",
  metal: "stagelights",
  brutal: "stagelights",
  punk: "stagelights",
  // --- retro ---------------------------------------------------------------
  synthwave: "horizon",
  lofi: "horizon",
  // --- bright --------------------------------------------------------------
  pop: "bloom",
  vocalPop: "bloom",
  dance: "bloom",
  house: "bloom",
  afrohouse: "bloom",
  amapiano: "bloom",
  disco: "bloom",
  funk: "bloom",
  soul: "bloom",
  rnb: "bloom",
  indie: "bloom",
  // --- played --------------------------------------------------------------
  jazz: "smoke",
  blues: "smoke",
  folk: "smoke",
  country: "smoke",
  reggae: "smoke",
  // --- still ---------------------------------------------------------------
  ambient: "nebula",
  strings: "nebula",
};

// When the classifier has not named a family yet — the first seconds of a
// track, or a device that never reached the smart level — the archetype is
// still a better guess than one fixed default.
const ARCHETYPE_WORLD = {
  sustain: "nebula",
  voice: "bloom",
  groove: "tunnel",
  hard: "hardbounce",
  rock: "stagelights",
};

export function worldFor(family, archetype) {
  return (
    FAMILY_WORLD[family] ||
    ARCHETYPE_WORLD[archetype] ||
    "bloom"
  );
}

export function makeWorld(id, preset, opts) {
  const def = WORLDS[id] || WORLDS.bloom;
  return { id, def, impl: def.make(preset, opts) };
}
