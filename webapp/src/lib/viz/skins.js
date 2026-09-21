// One visual identity per GENRE, not per world.
//
// The worlds (`lib/viz/worlds/`) are the machinery — a corridor, a field of
// shards, a turning record. A SKIN is what one genre does with that machinery:
// which world it uses, how its palette leans, and a handful of parameters the
// world reads (how many shards, how wide the cracks, how many sectors in the
// mandala, whether the sun is banded or bare). Two genres can share a world and
// still be told apart across a room, which is the whole point: gabber and
// speedcore are both `shatter`, and one is a slow seven-piece strobe while the
// other is a twenty-piece blur.
//
// EVERY FIELD IS OPTIONAL. A world states its own defaults and a skin overrides
// only what that genre actually differs on, so a new sub-genre costs one line
// and the table stays readable.
//
//   world   which world renders it
//   hue     degrees to lean the palette by — the genre's own colour temperament
//   sat     saturation multiplier          light  lightness multiplier
//   speed   how fast the world's motion runs
//   energy  overall brightness multiplier
//   p       the world's own parameters (see each world file for its vocabulary)
//
// `p` carries two KINDS of parameter, and the difference is the whole reason
// this table is worth its length. A scaling one (`shards`, `dots`, `beams`)
// says how MUCH of the motif there is; those alone make two genres on one world
// the same picture at two brightnesses. A shape one changes what the motif IS,
// and every world has a few:
//
//   tunnel       twist (a helix), dir -1 (the rings recede), dash (a strobing
//                ring), depth (beats to cross), sides
//   shatter      even (clean slabs), edge (a splintered rim), drift (the disc
//                rolls), flash (white strobe against a coloured one)
//   hardbounce   lead 0/1/2 (streak / staircase / saw), spike (a stabbing core)
//   breakgrid    axis (columns instead of strips), stutter (the ratchet),
//                tear (a chopped strip reverses)
//   bloom        petal (lobes — a flower, not a ring), ray (mirror-ball
//                spokes), float (confetti may RISE)
//   vinyl        arm (the tonearm), warp (a bent record), label
//   stagelights  teeth (the silhouette's profile), haze, backlit (the rig moves
//                behind the band)
//   kaleido      mirror 0 (a pinwheel, not a kaleidoscope), aniso, web
//   starfield    spiral (a vortex), dot (a still sky)
//   wobble       wave 0/1/2 (sine / square / saw — the LFO's own shape)
//   horizon      peaks (a ridge), reverse (the floor recedes)
//   smoke        ink (a dry, plucked brush), stave
//   nebula       veil (curtains, not clouds), fall
//   cathedral    fan (a vault), dust
//   carnival     bar (clave blocks), meet (the polyrhythm coincides), skip
//   pixels       steps (the grid's bit depth), scroll
//   ocean        pingpong (the delay bounces), rain
//   neon         bend (an L of tube — lettering), wet
//
// A world states its own default for every one of them, so a row overrides only
// what that genre actually differs on and the four anchor rows (techno, house,
// ambient, electronic) deliberately override almost nothing: they ARE the
// default each world was written around.
//
// THE VOCABULARY IS DELIBERATELY WIDER THAN THE DETECTOR. The live classifier
// (`audio/style.js`) and the server's (`deezer/analysis.py`) name ~54 families,
// because that is what six audio descriptors can honestly separate. A name can
// also arrive from the genre studio — a hand-applied tag, or a trained model's
// prediction — and those are not limited to what a heuristic can guess. So this
// table covers the sub-genres too, and `skinFor` normalises whatever it is
// handed (an id, a French label, a spelling with spaces or hyphens) before
// looking it up.

import { WORLDS } from "./worlds/index.js";

// --- the catalogue ----------------------------------------------------------
export const SKINS = {
  // === machine techno ======================================================
  // Cold, strict, rectangular. The corridor is the motif; what changes between
  // them is its shape, its speed and how much machine noise rides on it.
  techno: { world: "tunnel", hue: -30, sat: 0.8, p: { sides: 4, scan: 0.15 } },
  minimal: { world: "tunnel", hue: -40, sat: 0.7, light: 0.95, speed: 0.75, p: { sides: 4, spokes: 2, scan: 0.05, glow: 0.9, dir: -1, depth: 1.4, dash: 0.3 } },
  detroit: { world: "tunnel", hue: -18, sat: 0.9, speed: 0.85, p: { sides: 6, scan: 0.1, twist: 0.15, depth: 1.2 } },
  acidtechno: { world: "tunnel", hue: 62, sat: 1.05, p: { sides: 24, scan: 0.35, glow: 1, speed: 1.2, twist: 1.1 } },
  hardtechno: { world: "tunnel", hue: -12, sat: 0.95, speed: 1.35, p: { sides: 4, scan: 0.4, glow: 1.35, depth: 0.7 } },
  schranz: { world: "tunnel", hue: -6, sat: 0.7, light: 1.1, speed: 1.55, p: { sides: 4, scan: 0.65, glow: 1.4, dash: 0.5, depth: 0.8 } },
  industrialtechno: { world: "tunnel", hue: -55, sat: 0.35, light: 1.1, speed: 1.2, p: { sides: 4, scan: 0.8, glow: 1.1, dash: 0.35, twist: 0.2 } },
  industrial: { world: "tunnel", hue: -60, sat: 0.3, light: 1.15, p: { sides: 4, scan: 0.9, glow: 1, dash: 0.25, depth: 1.1 } },
  ebm: { world: "tunnel", hue: -70, sat: 0.45, speed: 1.1, p: { sides: 6, scan: 0.6, dash: 0.4, depth: 1.2 } },
  peaktime: { world: "tunnel", hue: -20, sat: 0.95, speed: 1.15, p: { sides: 8, scan: 0.25, glow: 1.2, depth: 0.85 } },
  electronic: { world: "tunnel", hue: 0, p: { sides: 8, scan: 0.12 } },
  idm: { world: "pixels", hue: -35, sat: 0.7, p: { cell: 0.7, glitch: 0.55, sprites: 0.3, steps: 0, scroll: 0.2 } },
  glitch: { world: "pixels", hue: -25, sat: 0.8, p: { cell: 0.55, glitch: 0.9, sprites: 0.25, steps: 3, scroll: 0.6 } },
  experimental: { world: "pixels", hue: -45, sat: 0.5, p: { cell: 1.2, glitch: 0.7, scroll: -0.3 } },
  noise: { world: "pixels", hue: 0, sat: 0.25, light: 1.1, p: { cell: 0.4, glitch: 1, steps: 2, scroll: 1.4 } },

  // === house & disco =======================================================
  // Warm, round, generous. `bloom` for all of it; the differences are how much
  // confetti, how bright, how vocal.
  house: { world: "bloom", hue: 12, p: { blooms: 1, confetti: 0.8 } },
  deephouse: { world: "bloom", hue: -14, sat: 0.85, light: 0.95, speed: 0.85, p: { blooms: 0.75, confetti: 0.3, voice: 1.1, float: 0.5 } },
  techhouse: { world: "bloom", hue: -20, sat: 0.8, p: { blooms: 0.9, confetti: 0.4, float: 1.1 } },
  proghouse: { world: "starfield", hue: -8, sat: 0.9, speed: 0.85, p: { arcs: 1.2, stars: 0.9, dot: 0.6 } },
  melodichouse: { world: "starfield", hue: 8, p: { arcs: 1.4, stars: 0.85, speed: 0.9, spiral: 0.25 } },
  bigroom: { world: "bloom", hue: 20, sat: 1.1, light: 1.05, p: { blooms: 1.4, confetti: 1.5, petal: 6, ray: 0.8 } },
  electrohouse: { world: "bloom", hue: 28, sat: 1.15, p: { blooms: 1.2, confetti: 1.1, petal: 4 } },
  frenchhouse: { world: "vinyl", hue: 26, sat: 1.05, p: { grooves: 1.1, bass: 0.8, slash: 0.7, arm: 0.9, label: 1.1, hats: 0.3 } },
  ghettohouse: { world: "bloom", hue: 32, sat: 1.1, speed: 1.2, p: { confetti: 1.3, float: 1.3 } },
  afrohouse: { world: "carnival", hue: 26, sat: 1.05, p: { rings: 1.1, dots: 1.2, meet: 0.9, bar: 0.3 } },
  amapiano: { world: "carnival", hue: 34, sat: 1, speed: 0.8, p: { rings: 0.85, dots: 1.4, sway: 1.3, skip: 2, meet: 0.7 } },
  gqom: { world: "carnival", hue: -10, sat: 0.9, speed: 1.1, p: { rings: 1.2, dots: 0.9, bar: 0.8, meet: 0.5 } },
  disco: { world: "bloom", hue: 30, sat: 1.15, light: 1.05, p: { blooms: 1.2, confetti: 1.6, voice: 1.1, petal: 8, ray: 1.4 } },
  italodisco: { world: "neon", hue: 36, sat: 1.15, p: { signs: 1.2, vhs: 0.3, bend: 0.5 } },
  nudisco: { world: "bloom", hue: 24, sat: 1.05, p: { blooms: 1.1, confetti: 1.2, petal: 6, ray: 0.8 } },
  funk: { world: "vinyl", hue: 34, sat: 1.1, p: { bass: 1.3, slash: 1.2, grooves: 0.9, arm: 0.6, label: 0.9, hats: 0.2 } },
  boogie: { world: "vinyl", hue: 30, sat: 1.05, speed: 0.9, p: { bass: 1.2, slash: 1, arm: 0.7, hats: 0.2 } },
  eurodance: { world: "bloom", hue: 40, sat: 1.2, light: 1.05, speed: 1.15, p: { confetti: 1.8, blooms: 1.2, petal: 5, float: 1.2 } },
  hardhouse: { world: "hardbounce", hue: 30, sat: 1.05, speed: 1.15, p: { bars: 0.9, saw: 0.6, lead: 0 } },
  hardbass: { world: "hardbounce", hue: 18, sat: 1.1, speed: 1.3, p: { bars: 1.1, squash: 1.2, saw: 0.8, lead: 2, spike: 0.4 } },
  jumpstyle: { world: "hardbounce", hue: 24, sat: 1.05, speed: 1.25, p: { squash: 1.35, bars: 0.8, saw: 0.5, lead: 1 } },

  // === garage & breaks =====================================================
  garage: { world: "breakgrid", hue: 10, sat: 0.95, p: { rows: 0.9, chop: 0.8, axis: 1, stutter: 0.3 } },
  ukgarage: { world: "breakgrid", hue: 14, sat: 1, p: { rows: 0.9, chop: 0.9, snare: 1.2, axis: 1, stutter: 0.5 } },
  twostep: { world: "breakgrid", hue: 6, sat: 0.95, speed: 0.9, p: { rows: 0.8, chop: 1, axis: 1, stutter: 0.6 } },
  speedgarage: { world: "breakgrid", hue: 0, speed: 1.15, p: { chop: 1.1, axis: 1, stutter: 0.4 } },
  bassline: { world: "wobble", hue: 8, p: { rate: 0.85, split: 0.8, wave: 1 } },
  breakbeat: { world: "breakgrid", hue: -6, p: { rows: 1.1, chop: 1.1, stutter: 0.2 } },
  bigbeat: { world: "breakgrid", hue: 16, sat: 1.05, p: { rows: 0.85, chop: 1.2, snare: 1.3, tear: 0.5 } },
  nubreaks: { world: "breakgrid", hue: -12, p: { chop: 1.2, speed: 1.1, stutter: 0.4 } },
  jersey: { world: "pixels", hue: 30, sat: 1.1, speed: 1.2, p: { cell: 0.8, glitch: 0.6, sprites: 0.9, steps: 2, scroll: 1.1 } },
  moombahton: { world: "carnival", hue: 20, sat: 1.05, speed: 0.9, p: { dots: 1.1, skip: 2, meet: 0.6 } },
  glitchhop: { world: "pixels", hue: -8, sat: 0.9, p: { cell: 0.9, glitch: 0.8, steps: 3, scroll: 0.5 } },

  // === drum & bass =========================================================
  dnb: { world: "breakgrid", hue: -16, sat: 0.95, speed: 1.2, p: { rows: 1.2, chop: 1.1, snare: 1.1, stutter: 0.35 } },
  liquiddnb: { world: "breakgrid", hue: -4, sat: 0.9, light: 1.05, speed: 1.05, p: { rows: 1, chop: 0.55, snare: 0.8, stutter: 0.1 } },
  neurofunk: { world: "breakgrid", hue: -50, sat: 0.6, light: 1.05, speed: 1.3, p: { rows: 1.3, chop: 1.5, snare: 1.2, tear: 0.9, stutter: 0.7 } },
  jumpup: { world: "breakgrid", hue: 22, sat: 1.15, speed: 1.25, p: { chop: 1.3, snare: 1.4, stutter: 0.8 } },
  jungle: { world: "breakgrid", hue: 30, sat: 1, speed: 1.35, p: { rows: 1.4, chop: 1.6, stutter: 1, tear: 0.6 } },
  darkstep: { world: "breakgrid", hue: -62, sat: 0.5, speed: 1.3, p: { rows: 1.3, chop: 1.3, tear: 0.7, stutter: 0.5 } },
  drumfunk: { world: "breakgrid", hue: -20, sat: 0.85, speed: 1.4, p: { rows: 1.5, chop: 1.7, stutter: 1, tear: 0.8 } },

  // === dubstep & bass ======================================================
  dubstep: { world: "wobble", hue: -30, sat: 0.9, p: { rate: 1, split: 1, band: 1, wave: 0 } },
  brostep: { world: "wobble", hue: -14, sat: 1.05, p: { rate: 1.25, split: 1.5, tear: 1.3, wave: 2 } },
  riddim: { world: "wobble", hue: -40, sat: 0.7, p: { rate: 1.5, split: 1.2, band: 0.8, tear: 1.2, wave: 1 } },
  melodicdubstep: { world: "starfield", hue: -18, sat: 0.95, p: { arcs: 1.3, spiral: 0.2, dot: 0.3 } },
  futurebass: { world: "bloom", hue: -4, sat: 1.15, light: 1.05, p: { blooms: 1.3, confetti: 1.2, voice: 1.2, petal: 6, ray: 0.5, float: 0.4 } },
  trapedm: { world: "wobble", hue: -22, sat: 0.95, speed: 0.85, p: { rate: 0.7, split: 1.1, wave: 1 } },
  hardtrap: { world: "wobble", hue: -8, sat: 1, speed: 1.1, p: { rate: 0.9, tear: 1.2, wave: 2 } },

  // === trance & psy ========================================================
  trance: { world: "starfield", hue: -22, sat: 0.95, p: { stars: 1, arcs: 1, spiral: 0.15 } },
  upliftingtrance: { world: "starfield", hue: -18, sat: 1.05, light: 1.05, p: { stars: 1.2, arcs: 1.5, spiral: 0.5 } },
  progtrance: { world: "starfield", hue: -28, sat: 0.9, speed: 0.85, p: { stars: 0.9, arcs: 0.9, dot: 0.5 } },
  vocaltrance: { world: "starfield", hue: -10, sat: 1, p: { arcs: 1.4, stars: 0.95, spiral: 0.3, dot: 0.2 } },
  hardtrance: { world: "starfield", hue: -6, sat: 1.05, speed: 1.3, p: { stars: 1.3, arcs: 1.1, spiral: 0.35 } },
  goa: { world: "kaleido", hue: 48, sat: 1.05, p: { sectors: 0.8, petals: 1.1, twist: 1.2, mirror: 0, aniso: 0.2 } },
  psytrance: { world: "kaleido", hue: -46, sat: 1, p: { sectors: 1, petals: 1, aniso: 0.3 } },
  fullon: { world: "kaleido", hue: 52, sat: 1.15, speed: 1.15, p: { sectors: 1.1, petals: 1.3, beads: 1.3, aniso: 0.35 } },
  darkpsy: { world: "kaleido", hue: -80, sat: 0.6, speed: 1.4, p: { sectors: 1.3, petals: 1.4, twist: 1.6, web: 0.9, aniso: 0.25 } },
  hitech: { world: "kaleido", hue: 96, sat: 0.9, speed: 1.7, p: { sectors: 1.4, petals: 1.5, twist: 1.8, web: 0.6, aniso: 0.55 } },
  forest: { world: "kaleido", hue: 110, sat: 0.75, light: 0.95, speed: 1.25, p: { sectors: 1.2, petals: 1.2, web: 1, aniso: 0.15 } },
  psydub: { world: "ocean", hue: 80, sat: 0.7, p: { echo: 1.3, depth: 1.2, pingpong: 0.8, rain: 0.5 } },

  // === hard (the shattering half) ==========================================
  hardcore: { world: "shatter", hue: 4, sat: 1, p: { shards: 1, jag: 0.9, spin: 1, edge: 0.3, flash: 0.6 } },
  frenchcore: { world: "shatter", hue: 8, sat: 1.05, speed: 1.15, p: { shards: 1.1, jag: 1.1, spin: 1.2, core: 1.1, edge: 0.5, flash: 0.2, drift: 0.2 } },
  uptempo: { world: "shatter", hue: 14, sat: 1.05, speed: 1.35, p: { shards: 1.3, jag: 1.3, spin: 1.4, strobe: 1.2, edge: 0.7, flash: 0.4 } },
  gabber: { world: "shatter", hue: -2, sat: 0.45, light: 1.2, speed: 1.1, p: { shards: 0.6, jag: 0.4, spin: 1.6, strobe: 1.5, core: 0.8, even: 0.85, edge: 0, flash: 1 } },
  ukhardcore: { world: "shatter", hue: 34, sat: 1.15, light: 1.05, p: { shards: 0.9, jag: 0.7, strobe: 1.2, even: 0.5, flash: 0.9 } },
  happyhardcore: { world: "bloom", hue: 44, sat: 1.2, light: 1.1, speed: 1.4, p: { confetti: 2, blooms: 1.4, petal: 6, ray: 1, float: 1.1 } },
  terrorcore: { world: "shatter", hue: -8, sat: 0.6, light: 1.15, speed: 1.6, p: { shards: 1.5, jag: 1.6, spin: 1.8, strobe: 1.6, edge: 1, flash: 0.9, drift: 0.3 } },
  speedcore: { world: "shatter", hue: 0, sat: 0.5, light: 1.2, speed: 1.9, p: { shards: 1.8, jag: 1.8, spin: 2, strobe: 1.8, edge: 1, flash: 1 } },
  extratone: { world: "shatter", hue: 0, sat: 0.2, light: 1.3, speed: 2.4, p: { shards: 2, jag: 2, spin: 2.4, strobe: 2, edge: 1, flash: 1, drift: 0.6 } },
  krach: { world: "shatter", hue: -16, sat: 0.55, light: 1.1, speed: 1.7, p: { shards: 1.6, jag: 1.9, spin: 1.9, strobe: 1.5, edge: 0.95, flash: 0.8, drift: 0.2 } },
  tribecore: { world: "shatter", hue: 24, sat: 1.05, speed: 1.2, p: { shards: 1.2, jag: 1.2, spin: 0.7, drift: 0.8, edge: 0.4, flash: 0.3 } },
  hardtek: { world: "shatter", hue: 30, sat: 1, speed: 1.1, p: { shards: 0.9, jag: 0.8, spin: 0.8, drift: 0.7, edge: 0.35, flash: 0.35 } },
  acidcore: { world: "shatter", hue: 66, sat: 1.15, speed: 1.3, p: { shards: 1.2, jag: 1.1, spin: 1.5, drift: 0.5, edge: 0.6, flash: 0.5 } },
  raggatek: { world: "shatter", hue: 88, sat: 1.05, speed: 1.15, p: { shards: 1, jag: 0.9, spin: 0.9, drift: 0.9, edge: 0.3, flash: 0.25 } },
  industrialhardcore: { world: "shatter", hue: -60, sat: 0.35, light: 1.15, speed: 1.4, p: { shards: 1.3, jag: 1.5, strobe: 1.3, edge: 0.8, flash: 1, even: 0.3 } },
  crossbreed: { world: "breakgrid", hue: -56, sat: 0.55, speed: 1.5, p: { rows: 1.4, chop: 1.8, tear: 1, stutter: 0.8 } },
  doomcore: { world: "shatter", hue: -44, sat: 0.5, light: 0.9, speed: 0.55, p: { shards: 0.7, jag: 1.2, spin: 0.4, even: 0.6, edge: 0.5, flash: 0.5 } },
  breakcore: { world: "pixels", hue: 20, sat: 1.1, speed: 1.6, p: { cell: 0.5, glitch: 1.3, sprites: 1.2, steps: 4, scroll: 2 } },
  lolicore: { world: "pixels", hue: 40, sat: 1.25, light: 1.1, speed: 1.9, p: { cell: 0.4, glitch: 1.5, sprites: 1.5, steps: 3, scroll: 2.6 } },
  makina: { world: "hardbounce", hue: 46, sat: 1.15, speed: 1.3, p: { bars: 1.1, saw: 1.2, lead: 1, spike: 0.2 } },

  // === hard (the bouncing half) ============================================
  hardstyle: { world: "hardbounce", hue: 12, sat: 1.05, p: { bars: 1, squash: 1, saw: 0.9, lead: 0, spike: 0.15 } },
  euphorichardstyle: { world: "hardbounce", hue: 24, sat: 1.1, light: 1.05, p: { bars: 0.9, saw: 1.3, ring: 1.1, lead: 0 } },
  rawstyle: { world: "hardbounce", hue: -10, sat: 0.8, light: 1.05, speed: 1.15, p: { bars: 1.2, squash: 1.3, saw: 0.7, spike: 0.8 } },
  rawphase: { world: "hardbounce", hue: -26, sat: 0.6, speed: 1.2, p: { bars: 1.3, squash: 1.4, saw: 0.5, spike: 1 } },
  hardtekk: { world: "hardbounce", hue: 6, sat: 1, speed: 1.1, p: { bars: 1, saw: 1.2, lead: 0, spike: 0.2 } },
  tekk: { world: "hardbounce", hue: 0, sat: 0.95, speed: 1.05, p: { saw: 1.1, lead: 0 } },
  zaag: { world: "hardbounce", hue: -34, sat: 1.05, speed: 1.2, p: { bars: 1.1, saw: 1.6, squash: 0.9, lead: 2 } },
  hardpingpong: { world: "hardbounce", hue: 18, sat: 1, speed: 1.25, p: { bars: 1.2, saw: 1.1, squash: 1.1, lead: 1 } },
  germanparty: { world: "hardbounce", hue: 38, sat: 1.15, light: 1.05, p: { bars: 0.85, saw: 1.3, ring: 1.15, lead: 1 } },
  pieep: { world: "hardbounce", hue: -18, sat: 1.1, speed: 1.35, p: { bars: 1.3, saw: 1.5, lead: 1, spike: 0.1 } },
  bouncy: { world: "hardbounce", hue: 42, sat: 1.1, speed: 1.2, p: { squash: 1.4, saw: 1, lead: 1 } },

  // === urban ===============================================================
  hiphop: { world: "vinyl", hue: 18, sat: 0.95, p: { grooves: 1, bass: 1, slash: 1, arm: 0.8, hats: 0.3 } },
  boombap: { world: "vinyl", hue: 22, sat: 0.9, light: 0.95, speed: 0.85, p: { grooves: 1.2, bass: 0.9, slash: 1.2, arm: 1, label: 1.15 } },
  rap: { world: "vinyl", hue: 14, sat: 1, p: { bass: 1.1, arm: 0.6, hats: 0.5 } },
  trap: { world: "vinyl", hue: -28, sat: 0.85, speed: 0.8, p: { grooves: 0.8, bass: 1.5, slash: 0.8, arm: 0, label: 0.7, hats: 1.2 } },
  drill: { world: "vinyl", hue: -48, sat: 0.6, light: 0.95, speed: 0.8, p: { grooves: 0.7, bass: 1.6, slash: 0.9, arm: 0, label: 0.6, hats: 1.3 } },
  ukdrill: { world: "vinyl", hue: -54, sat: 0.55, speed: 0.8, p: { grooves: 0.7, bass: 1.6, arm: 0, label: 0.6, hats: 1.3 } },
  phonk: { world: "vinyl", hue: -66, sat: 0.7, light: 1.05, p: { grooves: 1.3, bass: 1.4, slash: 1.3, warp: 1.2, arm: 0.5, hats: 1 } },
  cloudrap: { world: "ocean", hue: -12, sat: 0.8, p: { swells: 0.8, echo: 1.3, pingpong: 0.5, rain: 0.7 } },
  emorap: { world: "ocean", hue: -34, sat: 0.75, p: { swells: 0.9, echo: 1.1, rain: 0.8, pingpong: 0.2 } },
  gfunk: { world: "vinyl", hue: 30, sat: 1.05, speed: 0.85, p: { slash: 1.1, bass: 1.1, arm: 0.7, warp: 0.3, hats: 0.4 } },
  lofihiphop: { world: "horizon", hue: 26, sat: 0.8, light: 0.95, speed: 0.6, p: { sun: 0.8, grid: 0.7, scan: 1.4, peaks: 0.5 } },
  grime: { world: "pixels", hue: -20, sat: 0.9, speed: 1.15, p: { cell: 0.7, glitch: 0.7, sprites: 0.8, steps: 2, scroll: 0.9 } },
  reggaeton: { world: "carnival", hue: 14, sat: 1.05, p: { rings: 1, dots: 1.1, bar: 0.6, meet: 0.4, hats: 0.5 } },
  dembow: { world: "carnival", hue: 18, sat: 1.1, speed: 1.1, p: { dots: 1.3, bar: 0.7, meet: 0.5, skip: 2 } },
  dancehall: { world: "carnival", hue: 40, sat: 1.1, p: { rings: 1.1, dots: 1.2, sway: 1.2, bar: 0.5, meet: 0.6 } },
  afrobeats: { world: "carnival", hue: 30, sat: 1.1, p: { rings: 1.2, dots: 1.3, meet: 1, bar: 0.2 } },
  afroswing: { world: "carnival", hue: 26, sat: 1.05, p: { dots: 1.1, meet: 0.7 } },

  // === rock & metal ========================================================
  rock: { world: "stagelights", hue: 12, p: { beams: 1, wall: 1, teeth: 1, haze: 0.3 } },
  hardrock: { world: "stagelights", hue: 8, sat: 1.05, p: { beams: 1.1, wall: 1.1, strobe: 0.8, teeth: 1.1, haze: 0.5 } },
  garagerock: { world: "stagelights", hue: 20, sat: 0.95, p: { beams: 0.8, wall: 1.1, teeth: 1.2, haze: 0.15 } },
  psychrock: { world: "kaleido", hue: 56, sat: 1, speed: 0.7, p: { sectors: 0.7, petals: 0.9, twist: 0.6, aniso: 0.12, web: 0.2 } },
  progrock: { world: "stagelights", hue: -10, sat: 0.9, speed: 0.85, p: { beams: 1.3, swing: 0.7, teeth: 0.5, haze: 0.7 } },
  punk: { world: "stagelights", hue: 4, sat: 1, light: 1.05, speed: 1.35, p: { beams: 0.7, strobe: 1.4, swing: 1.5, teeth: 1.5, haze: 0 } },
  hardcorepunk: { world: "stagelights", hue: 0, sat: 0.8, light: 1.1, speed: 1.5, p: { beams: 0.6, strobe: 1.6, swing: 1.6, teeth: 1.7, haze: 0 } },
  postpunk: { world: "stagelights", hue: -40, sat: 0.6, speed: 0.9, p: { beams: 1.2, strobe: 0.4, teeth: 0.8, haze: 0.9, backlit: 1 } },
  poppunk: { world: "stagelights", hue: 22, sat: 1.1, speed: 1.2, p: { beams: 0.9, strobe: 1, teeth: 1.3, haze: 0.2 } },
  skapunk: { world: "carnival", hue: 44, sat: 1.1, speed: 1.2, p: { dots: 1.3, sway: 1.4, bar: 0.9, meet: 0.6, skip: 2 } },
  ska: { world: "carnival", hue: 48, sat: 1.05, p: { dots: 1.2, sway: 1.3, bar: 1, meet: 0.5 } },
  grunge: { world: "stagelights", hue: -16, sat: 0.7, speed: 0.9, p: { beams: 0.8, wall: 1.2, teeth: 1.1, haze: 0.8 } },
  emo: { world: "stagelights", hue: -30, sat: 0.8, p: { beams: 0.9, teeth: 0.9, haze: 0.6 } },
  shoegaze: { world: "nebula", hue: -18, sat: 0.85, p: { clouds: 1.3, band: 1.2, veil: 0.7 } },
  indie: { world: "bloom", hue: 6, sat: 0.9, speed: 0.9, p: { blooms: 0.9, confetti: 0.6, float: 0.8 } },
  metal: { world: "stagelights", hue: -6, sat: 0.9, light: 1.05, speed: 1.1, p: { beams: 1.2, wall: 1.3, strobe: 1.1, teeth: 1.4, haze: 0.7 } },
  heavymetal: { world: "stagelights", hue: 6, sat: 1, p: { beams: 1.2, wall: 1.2, teeth: 1.3, haze: 0.6 } },
  thrash: { world: "stagelights", hue: -4, sat: 0.85, light: 1.05, speed: 1.4, p: { wall: 1.4, strobe: 1.3, swing: 1.4, teeth: 1.9, haze: 0.4 } },
  deathmetal: { world: "stagelights", hue: -22, sat: 0.55, light: 1.05, speed: 1.35, p: { wall: 1.5, strobe: 1.2, teeth: 2, haze: 0.9, backlit: 1 } },
  blackmetal: { world: "stagelights", hue: -90, sat: 0.2, light: 1.15, speed: 1.3, p: { beams: 1.4, wall: 1.4, strobe: 1.4, teeth: 2, haze: 1.4, backlit: 1 } },
  doom: { world: "stagelights", hue: -40, sat: 0.6, light: 0.9, speed: 0.5, p: { beams: 1.3, wall: 1.3, strobe: 0.3, teeth: 0.6, haze: 1.5, backlit: 1 } },
  sludge: { world: "stagelights", hue: -34, sat: 0.55, speed: 0.6, p: { wall: 1.4, teeth: 0.8, haze: 1.3, backlit: 1 } },
  metalcore: { world: "stagelights", hue: -12, sat: 0.9, speed: 1.25, p: { wall: 1.4, strobe: 1.3, teeth: 1.6, haze: 0.5 } },
  deathcore: { world: "stagelights", hue: -26, sat: 0.6, speed: 1.3, p: { wall: 1.5, strobe: 1.4, teeth: 1.9, haze: 0.8, backlit: 1 } },
  djent: { world: "pixels", hue: -46, sat: 0.6, p: { cell: 1, glitch: 0.5, sprites: 0.4, steps: 2, scroll: 0.3 } },
  numetal: { world: "stagelights", hue: -18, sat: 0.8, speed: 1.15, p: { wall: 1.3, teeth: 1.2, haze: 0.5 } },
  powermetal: { world: "stagelights", hue: 30, sat: 1.1, light: 1.05, p: { beams: 1.4, strobe: 1, teeth: 0.7, haze: 0.6 } },
  symphonicmetal: { world: "cathedral", hue: -16, sat: 1, p: { shafts: 1.2, rose: 1.2, swell: 1.2, fan: 0.7, dust: 1 } },
  brutal: { world: "stagelights", hue: -20, sat: 0.5, light: 1.1, speed: 1.45, p: { wall: 1.6, strobe: 1.5, teeth: 2, haze: 1, backlit: 1 } },

  // === pop & vocal =========================================================
  pop: { world: "bloom", hue: 16, sat: 1.05, p: { blooms: 1, confetti: 1, voice: 1.1, petal: 5, ray: 0.3 } },
  vocalPop: { world: "bloom", hue: 10, sat: 1, speed: 0.9, p: { voice: 1.4, confetti: 0.7, float: 0.6 } },
  synthpop: { world: "neon", hue: 20, sat: 1.1, p: { signs: 1, vhs: 0.4, bend: 0.6, wet: 0.3 } },
  dreampop: { world: "nebula", hue: -8, sat: 0.9, light: 1.05, p: { clouds: 1.2, motes: 1.2, veil: 0.4, fall: 1 } },
  hyperpop: { world: "pixels", hue: 46, sat: 1.3, light: 1.1, speed: 1.5, p: { cell: 0.45, glitch: 1.1, sprites: 1.4, steps: 3, scroll: 1.8 } },
  kpop: { world: "bloom", hue: 34, sat: 1.2, light: 1.05, speed: 1.15, p: { confetti: 1.7, blooms: 1.2, voice: 1.2, petal: 8, ray: 1.1 } },
  jpop: { world: "bloom", hue: 40, sat: 1.15, speed: 1.1, p: { confetti: 1.5, voice: 1.2, petal: 6, ray: 0.6 } },
  citypop: { world: "neon", hue: 30, sat: 1.05, speed: 0.85, p: { signs: 1.2, vhs: 0.7, bend: 0.8, wet: 0.15 } },
  vaporwave: { world: "neon", hue: -6, sat: 1.1, light: 1.05, speed: 0.55, p: { signs: 1.1, vhs: 1.5, flicker: 1.3, bend: 0.35, wet: 1 } },
  futurefunk: { world: "neon", hue: 26, sat: 1.15, speed: 1.1, p: { signs: 1.3, vhs: 0.9, bend: 0.7, wet: 0.6 } },
  latinpop: { world: "carnival", hue: 22, sat: 1.1, p: { dots: 1.2, rings: 1, meet: 0.7, bar: 0.3 } },
  chanson: { world: "smoke", hue: 16, sat: 0.9, speed: 0.8, p: { strokes: 0.9, curve: 1.2, stave: 0.8 } },
  schlager: { world: "bloom", hue: 38, sat: 1.15, p: { confetti: 1.6, voice: 1.2, petal: 6, ray: 0.7 } },
  rnb: { world: "bloom", hue: 4, sat: 0.95, speed: 0.8, p: { voice: 1.5, confetti: 0.4, blooms: 0.9, float: 0.3 } },
  neosoul: { world: "smoke", hue: 20, sat: 0.95, speed: 0.75, p: { strokes: 1.1, drift: 1.2, stave: 0.4 } },
  soul: { world: "bloom", hue: 26, sat: 1.05, speed: 0.85, p: { voice: 1.4, confetti: 0.6, petal: 4, ray: 0.5, float: 0.5 } },
  motown: { world: "vinyl", hue: 28, sat: 1.05, speed: 0.9, p: { grooves: 1.2, slash: 1.1, arm: 1, label: 1.2 } },
  gospel: { world: "cathedral", hue: 32, sat: 1.05, light: 1.05, p: { shafts: 1.3, swell: 1.3, fan: 0.9, dust: 1.2 } },

  // === chill & downtempo ===================================================
  lofi: { world: "horizon", hue: 22, sat: 0.8, light: 0.95, speed: 0.6, p: { sun: 0.85, grid: 0.75, scan: 1.3, peaks: 0.6 } },
  chillhop: { world: "horizon", hue: 18, sat: 0.85, speed: 0.7, p: { scan: 1.1, grid: 0.8, peaks: 0.4 } },
  downtempo: { world: "ocean", hue: -14, sat: 0.85, speed: 0.7, p: { swells: 1, echo: 1.1, rain: 0.4 } },
  triphop: { world: "ocean", hue: -30, sat: 0.75, speed: 0.75, p: { swells: 1.1, echo: 1.2, depth: 1.2, pingpong: 0.4, rain: 0.9 } },
  chillout: { world: "ocean", hue: -6, sat: 0.85, speed: 0.65, p: { swells: 0.9, echo: 1, rain: 0.2 } },
  dub: { world: "ocean", hue: 76, sat: 0.9, speed: 0.7, p: { echo: 1.6, depth: 1.3, pingpong: 1, rain: 1 } },
  dubtechno: { world: "ocean", hue: -44, sat: 0.55, speed: 0.75, p: { echo: 1.5, depth: 1.4, swells: 0.9, pingpong: 0.9, rain: 0.3 } },
  synthwave: { world: "horizon", hue: 4, sat: 1.1, p: { sun: 1, bands: 1, grid: 1, peaks: 0.8 } },
  retrowave: { world: "horizon", hue: 8, sat: 1.1, p: { sun: 1.05, grid: 1, peaks: 0.7 } },
  outrun: { world: "horizon", hue: -4, sat: 1.15, speed: 1.3, p: { grid: 1.3, sun: 0.95, peaks: 1 } },
  darksynth: { world: "horizon", hue: -34, sat: 0.9, light: 0.95, speed: 1.15, p: { sun: 0.9, grid: 1.1, scan: 0.8, peaks: 0.9, reverse: 1 } },
  darkwave: { world: "nebula", hue: -60, sat: 0.55, p: { clouds: 1.1, motes: 0.8, veil: 0.8, fall: 1 } },
  coldwave: { world: "nebula", hue: -72, sat: 0.45, p: { clouds: 1, band: 0.8, veil: 0.9, fall: 1 } },
  gothic: { world: "cathedral", hue: -58, sat: 0.6, light: 0.9, p: { shafts: 1.2, rose: 1.3, fan: 0.5, dust: 0.8 } },
  witchhouse: { world: "pixels", hue: -66, sat: 0.6, speed: 0.7, p: { cell: 1.1, glitch: 0.9, steps: 2, scroll: -0.4 } },

  // === still ===============================================================
  ambient: { world: "nebula", hue: -10, sat: 0.9, speed: 0.8, p: { clouds: 1, motes: 1 } },
  darkambient: { world: "nebula", hue: -76, sat: 0.45, light: 0.9, speed: 0.6, p: { clouds: 1.2, motes: 0.6, band: 0.7, veil: 0.6, fall: 1 } },
  drone: { world: "nebula", hue: -50, sat: 0.5, speed: 0.4, p: { clouds: 1.3, motes: 0.4, band: 1.3, veil: 1, fall: 1 } },
  newage: { world: "nebula", hue: 34, sat: 0.8, light: 1.05, speed: 0.7, p: { motes: 1.3, band: 1.2, veil: 0.2 } },
  minimalism: { world: "cathedral", hue: -4, sat: 0.7, speed: 0.6, p: { shafts: 0.8, rose: 0.7, swell: 0.8, fan: 0.2, dust: 0.4 } },

  // === played ==============================================================
  jazz: { world: "smoke", hue: 20, sat: 1, p: { strokes: 1, curve: 1, stave: 0.5 } },
  bebop: { world: "smoke", hue: 24, sat: 1.05, speed: 1.3, p: { strokes: 1.4, curve: 1.2, ink: 0.2, stave: 0.9 } },
  swing: { world: "smoke", hue: 28, sat: 1.05, speed: 1.1, p: { strokes: 1.2, drift: 1.2, ink: 0.15, stave: 0.6 } },
  bigband: { world: "stagelights", hue: 32, sat: 1.05, p: { beams: 1.3, wall: 0.8, strobe: 0.4, teeth: 0.2, haze: 0.5 } },
  smoothjazz: { world: "smoke", hue: 16, sat: 0.9, speed: 0.75, p: { strokes: 0.8, drift: 1.3, stave: 0.3 } },
  jazzfusion: { world: "smoke", hue: 10, sat: 1, speed: 1.15, p: { strokes: 1.3, ink: 0.3, stave: 0.6 } },
  blues: { world: "smoke", hue: -22, sat: 0.9, speed: 0.8, p: { strokes: 0.9, curve: 1.3, ink: 0.35, stave: 0.4 } },
  deltablues: { world: "smoke", hue: -14, sat: 0.85, speed: 0.7, p: { strokes: 0.8, curve: 1.4, ink: 0.8, stave: 0.2 } },
  country: { world: "smoke", hue: 32, sat: 0.95, p: { strokes: 1, drift: 0.9, ink: 0.7, stave: 0.3 } },
  bluegrass: { world: "smoke", hue: 36, sat: 1, speed: 1.25, p: { strokes: 1.4, ink: 1, stave: 0.4 } },
  folk: { world: "smoke", hue: 26, sat: 0.9, speed: 0.85, p: { strokes: 0.9, ink: 0.6 } },
  singersongwriter: { world: "smoke", hue: 18, sat: 0.85, speed: 0.75, p: { strokes: 0.8, drift: 1.1, ink: 0.4, stave: 0.3 } },
  celtic: { world: "smoke", hue: 96, sat: 0.9, p: { strokes: 1.1, curve: 1.2, ink: 0.5, stave: 0.2 } },
  flamenco: { world: "carnival", hue: 6, sat: 1.1, speed: 1.15, p: { dots: 1.3, sway: 1.2, bar: 1, meet: 0.9 } },
  tango: { world: "carnival", hue: -4, sat: 1, speed: 0.9, p: { rings: 1.1, sway: 1.4, bar: 0.8, meet: 0.4 } },
  salsa: { world: "carnival", hue: 22, sat: 1.15, speed: 1.2, p: { rings: 1.2, dots: 1.4, sway: 1.3, bar: 0.6, meet: 1.2 } },
  cumbia: { world: "carnival", hue: 34, sat: 1.1, p: { dots: 1.2, sway: 1.2, bar: 0.5, meet: 0.7 } },
  samba: { world: "carnival", hue: 40, sat: 1.15, speed: 1.3, p: { dots: 1.5, rings: 1.2, meet: 1.4, bar: 0.3, skip: 2 } },
  bossanova: { world: "smoke", hue: 44, sat: 0.9, speed: 0.8, p: { strokes: 0.9, drift: 1.2, ink: 0.3, stave: 0.5 } },
  reggae: { world: "carnival", hue: 84, sat: 1, speed: 0.85, p: { rings: 0.9, sway: 1.4, bar: 0.9, meet: 0 } },
  rocksteady: { world: "carnival", hue: 78, sat: 0.95, speed: 0.8, p: { sway: 1.5, bar: 0.9, meet: 0 } },
  afrobeat: { world: "carnival", hue: 36, sat: 1.05, p: { rings: 1.3, dots: 1.3, meet: 1.3, bar: 0.2 } },
  highlife: { world: "carnival", hue: 42, sat: 1.05, p: { dots: 1.2, meet: 0.8 } },
  kizomba: { world: "carnival", hue: 16, sat: 0.95, speed: 0.8, p: { sway: 1.5, dots: 0.9, meet: 0, bar: 0.4 } },
  bollywood: { world: "carnival", hue: 50, sat: 1.2, speed: 1.1, p: { rings: 1.3, dots: 1.4, meet: 1, bar: 0.5 } },
  arabic: { world: "kaleido", hue: 38, sat: 1.05, speed: 0.75, p: { sectors: 1.2, petals: 1.1, twist: 0.6, aniso: 0.08, web: 0.3 } },

  // === classical ===========================================================
  classical: { world: "cathedral", hue: 0, sat: 0.85, p: { shafts: 1, rose: 1, swell: 1, fan: 0.5, dust: 0.6 } },
  strings: { world: "cathedral", hue: -6, sat: 0.85, p: { shafts: 1.1, swell: 1.1, rose: 0.8, fan: 0.4, dust: 0.8 } },
  orchestral: { world: "cathedral", hue: 4, sat: 0.95, p: { shafts: 1.3, swell: 1.3, fan: 0.8, dust: 0.9 } },
  opera: { world: "cathedral", hue: 12, sat: 1, p: { shafts: 1.2, swell: 1.4, rose: 1.1, fan: 0.7, dust: 1 } },
  choral: { world: "cathedral", hue: 8, sat: 0.9, light: 1.05, p: { shafts: 1.4, swell: 1.2, fan: 1, dust: 1.2 } },
  baroque: { world: "cathedral", hue: 30, sat: 0.9, p: { rose: 1.4, shafts: 0.9, fan: 0.3, dust: 0.5 } },
  romantic: { world: "cathedral", hue: -12, sat: 0.95, p: { swell: 1.3, shafts: 1.1, fan: 0.6, dust: 0.9 } },
  piano: { world: "cathedral", hue: -2, sat: 0.7, speed: 0.8, p: { shafts: 0.8, rose: 0.6, swell: 0.9, fan: 0, dust: 0.3 } },
  filmscore: { world: "cathedral", hue: -20, sat: 0.9, p: { shafts: 1.3, swell: 1.4, rose: 0.9, fan: 0.85, dust: 1.1 } },
  soundtrack: { world: "cathedral", hue: -16, sat: 0.9, p: { shafts: 1.2, swell: 1.3, fan: 0.8, dust: 1 } },

  // === other ===============================================================
  chiptune: { world: "pixels", energy: 0.82, hue: 100, sat: 1.2, p: { cell: 1.3, glitch: 0.3, sprites: 1.4, steps: 2, scroll: 1 } },
  eightbit: { world: "pixels", energy: 0.82, hue: 108, sat: 1.25, p: { cell: 1.5, glitch: 0.25, sprites: 1.5, steps: 2, scroll: 0.8 } },
  dance: { world: "bloom", hue: 22, sat: 1.1, p: { confetti: 1.3, blooms: 1.1, petal: 5, ray: 0.5 } },
};

// --- aliases ----------------------------------------------------------------
// The name can arrive as an id, as a French label from the classifier, or as
// whatever an admin typed into the genre studio. Everything is normalised first
// (lowercased, accents and punctuation removed), so only genuinely different
// WORDS need a line here.
export const ALIASES = {
  // ids that differ from the normalised label
  "cordesclassique": "strings",
  "popchanson": "vocalPop",
  "rbsoul": "rnb",
  "hiphoprap": "hiphop",
  "electronique": "electronic",
  "jazzacoustique": "jazz",
  // spellings and synonyms
  "drumandbass": "dnb",
  "drumnbass": "dnb",
  "drumbass": "dnb",
  "dandb": "dnb",
  "liquid": "liquiddnb",
  "neuro": "neurofunk",
  "psy": "psytrance",
  "psychedelictrance": "psytrance",
  "goatrance": "goa",
  "fullonpsytrance": "fullon",
  "hitechpsy": "hitech",
  "forestpsy": "forest",
  "tekno": "hardtek",
  "tribe": "tribecore",
  "frenchtek": "hardtek",
  "mainstreamhardcore": "hardcore",
  "millennium": "hardcore",
  "earlyhardcore": "gabber",
  "rotterdam": "gabber",
  "happycore": "happyhardcore",
  "uktempo": "uptempo",
  "terror": "terrorcore",
  "splittercore": "extratone",
  "flashcore": "extratone",
  "hardtechnoindustrial": "industrialtechno",
  "rawhardstyle": "rawstyle",
  "euphoric": "euphorichardstyle",
  "xtraraw": "rawphase",
  "hardtechnoschranz": "schranz",
  "acidhouse": "acidtechno",
  "acid": "acidtechno",
  "progressivehouse": "proghouse",
  "progressivetrance": "progtrance",
  "upliftingtrance": "upliftingtrance",
  "uplifting": "upliftingtrance",
  "melodictechno": "melodichouse",
  "organichouse": "deephouse",
  "frenchtouch": "frenchhouse",
  "ukg": "ukgarage",
  "2step": "twostep",
  "deuxstep": "twostep",
  "future": "futurebass",
  "wave": "darkwave",
  "phonkdrift": "phonk",
  "driftphonk": "phonk",
  "memphisrap": "phonk",
  "lofihiphopbeats": "lofihiphop",
  "lofibeats": "lofihiphop",
  "jazzrap": "boombap",
  "boombapsoul": "boombap",
  "hiphopusa": "hiphop",
  "afrobeatsnaija": "afrobeats",
  "amapianoyanos": "amapiano",
  "reggaetonlatino": "reggaeton",
  "latin": "latinpop",
  "musiquelatine": "latinpop",
  "metalcorehardcore": "metalcore",
  "deathmetalbrutal": "deathmetal",
  "blackmetalatmospheric": "blackmetal",
  "doommetal": "doom",
  "stonerrock": "sludge",
  "nu": "numetal",
  "numetalrap": "numetal",
  "hardrockmetal": "hardrock",
  "punkrock": "punk",
  "jerseyclub": "jersey",
  "popunk": "poppunk",
  "postrock": "shoegaze",
  "dreamwave": "dreampop",
  "citypopjapan": "citypop",
  "vapor": "vaporwave",
  "vaporwavemall": "vaporwave",
  "synthwaveretro": "synthwave",
  "musiqueclassique": "classical",
  "classique": "classical",
  "orchestre": "orchestral",
  "bandeoriginale": "filmscore",
  "bo": "filmscore",
  "musiquedefilm": "filmscore",
  "chorale": "choral",
  "chant": "choral",
  "8bit": "eightbit",
  "huitbit": "eightbit",
  "videogame": "chiptune",
  "jeuvideo": "chiptune",
  "ambiant": "ambient",
  "nebuleuse": "ambient",
  "worldmusic": "afrobeat",
  "musiquedumonde": "afrobeat",
  "variete": "vocalPop",
  "varietefrancaise": "chanson",
  "frenchvariety": "chanson",
  "edm": "bigroom",
  "mainstage": "bigroom",
  "clubdance": "dance",
  // the classifier's own French labels, where they are not simply the id
  "danceedm": "dance",
  "discofunk": "disco",
  "deutscherkrach": "krach",
  "indus": "industrial",
  "deathbrutal": "brutal",
  "hardtekkzaag": "zaag",
  "germanhardtekk": "germanparty",
  "partytekk": "germanparty",
  "hardpingpongtekk": "hardpingpong",
};

// When nothing in the catalogue matches, the archetype still says something.
const ARCHETYPE_SKIN = {
  sustain: "ambient",
  voice: "pop",
  groove: "techno",
  hard: "hardstyle",
  rock: "rock",
};

// Accents out, punctuation out, lowercase. "Hard Ping-Pong" and "hardpingpong"
// are the same genre, and so are "Cordes / classique" and its id.
function normalise(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const BY_KEY = new Map();
for (const id of Object.keys(SKINS)) BY_KEY.set(normalise(id), id);
for (const [from, to] of Object.entries(ALIASES)) {
  if (SKINS[to]) BY_KEY.set(normalise(from), to);
}

/** The catalogue id for whatever name was handed over, or "" when unknown. */
export function skinId(name, archetype = "") {
  const hit = BY_KEY.get(normalise(name));
  if (hit) return hit;
  return ARCHETYPE_SKIN[archetype] || "";
}

const EMPTY = { world: "bloom", p: {} };

/** The skin itself, always usable: an unknown name still returns something. */
export function skinFor(name, archetype = "") {
  const id = skinId(name, archetype);
  const s = (id && SKINS[id]) || EMPTY;
  // A skin naming a world that does not exist would render nothing at all,
  // which is a much worse failure than rendering the wrong one.
  return WORLDS[s.world] ? s : { ...s, world: "bloom" };
}

/** How many genres the animation engine can dress differently. */
export function skinCount() {
  return Object.keys(SKINS).length;
}
