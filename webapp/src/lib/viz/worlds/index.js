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
//   cathedral    shafts of light through a nave over a rose window — classical,
//                orchestral, opera, choral, film score, gospel.
//   carnival     concentric rings of different lengths going in and out of
//                phase — salsa, afrobeats, amapiano, reggae, reggaeton, ska.
//   pixels       a coarse lit grid with sprites on it, tearing into offset rows
//                — chiptune, hyperpop, breakcore, IDM, glitch, grime.
//   ocean        every event re-drawn behind itself at a decay: a dub delay,
//                drawn — dub, dub techno, trip-hop, downtempo, cloud rap.
//   neon         tubes hanging in the dark over a wet reflection, through a VHS
//                tracking error — vaporwave, city pop, synthpop, future funk.
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
import { createCathedralWorld } from "./cathedral.js";
import { createCarnivalWorld } from "./carnival.js";
import { createPixelsWorld } from "./pixels.js";
import { createOceanWorld } from "./ocean.js";
import { createNeonWorld } from "./neon.js";
import { WORLD_META, worldFor } from "./catalogue.js";

// The registry: each world's metadata (./catalogue.js) plus the factory that
// draws it. Importing THIS file pulls in all eighteen scene modules, which is
// why anything that only needs a name or a trail imports the catalogue instead.
export const WORLDS = {
  tunnel: { ...WORLD_META.tunnel, make: createTunnelWorld },
  shatter: { ...WORLD_META.shatter, make: createShatterWorld },
  hardbounce: { ...WORLD_META.hardbounce, make: createHardbounceWorld },
  kaleido: { ...WORLD_META.kaleido, make: createKaleidoWorld },
  starfield: { ...WORLD_META.starfield, make: createStarfieldWorld },
  breakgrid: { ...WORLD_META.breakgrid, make: createBreakgridWorld },
  wobble: { ...WORLD_META.wobble, make: createWobbleWorld },
  vinyl: { ...WORLD_META.vinyl, make: createVinylWorld },
  stagelights: { ...WORLD_META.stagelights, make: createStagelightsWorld },
  horizon: { ...WORLD_META.horizon, make: createHorizonWorld },
  bloom: { ...WORLD_META.bloom, make: createBloomWorld },
  smoke: { ...WORLD_META.smoke, make: createSmokeWorld },
  nebula: { ...WORLD_META.nebula, make: createNebulaWorld },
  cathedral: { ...WORLD_META.cathedral, make: createCathedralWorld },
  carnival: { ...WORLD_META.carnival, make: createCarnivalWorld },
  pixels: { ...WORLD_META.pixels, make: createPixelsWorld },
  ocean: { ...WORLD_META.ocean, make: createOceanWorld },
  neon: { ...WORLD_META.neon, make: createNeonWorld },
};


export { WORLD_META, worldFor };

export function makeWorld(id, preset, opts, skin = {}) {
  const def = WORLDS[id] || WORLDS.bloom;
  // The skin is handed to the world at CONSTRUCTION, not per frame: how many
  // shards a genre has or how coarse its grid is decides the size of the arrays
  // it allocates, and re-deciding that every frame would be both wasteful and
  // impossible to animate. A genre change builds a new instance and the
  // compositor crossfades to it, which is what it already does for a world
  // change — the two are the same event.
  return { id, def, skin, impl: def.make(preset, opts, skin) };
}
