// One visual identity per GENRE, not per world.
//
// The worlds (`lib/viz/worlds/`) are the machinery — a corridor, a sheet of
// glass, a turning record, a meadow of fireflies. A SKIN is what one genre
// does with that machinery: which world it uses, how its palette leans, and a
// handful of parameters the world reads. Two genres can share a world and still
// be told apart across a room, which is the whole point: gabber and speedcore
// are both `shatter`, and one breaks into a few long slabs while the other is
// crushed into a web.
//
// EVERY FIELD IS OPTIONAL. A world states its own default for every parameter
// and a skin overrides only what that genre actually differs on, so a new
// sub-genre costs one line and the table stays readable.
//
//   world   which world renders it (an id from worlds/catalogue.js)
//   hue     degrees to lean the palette by — the genre's colour temperament
//   sat     saturation multiplier          light  lightness multiplier
//   speed   how fast the world's own motion runs (its clock, not the tempo)
//   energy  overall brightness multiplier
//   p       the world's own parameters (each world file lists its vocabulary)
//
// `p` carries two KINDS of parameter, and the difference is the reason this
// table is worth its length. A SCALING one (`sparks`, `shards`, `count`) says
// how much of the motif there is; a table of nothing but those is two hundred
// brightness settings. A SHAPE one changes what the motif IS, and those are
// what separate neighbours sharing a world:
//
//   kaleido     mirror 0 (a pinwheel — goa), web 1 (a web, not a crystal —
//               darkpsy, forest), sectors, iter (how deep the fold goes)
//   tunnel      sides (a shaft, a hexagon, a bore), twist (a helix), dir -1
//               (the corridor recedes), dash (strobing rings), scan (machine
//               crawl)
//   wobble      wave 0/1/2 (sine / square / saw — the LFO's own shape)
//   lasers      raw 0..1 (euphoric sweeps to raw red fire)
//   forge       anvils 1/3 (one great anvil for rawstyle, the blows walked
//               across three for uptempo)
//   slices      axis 1 (falling columns instead of bands), angle
//   shatter     shards (few slabs to a crushed web), jag (how far they fly)
//   ridges      mirror (peaks centred like the Joy Division sleeve, or bass
//               on the left)
//   galaxy      arms 2/4, tilt (face-on to edge-on)
//   bounce      twins (the off-beat pair), spikes (the crown)
//   vinyl       arm (the tonearm), rpm (a 78 turns faster than a 33)
//   stairs      steps per turn, rise
//   carnival    rings (how many patterns turn against each other)
//   pixels      steps (colour depth), glitch, coins
//
// The anchor rows (techno, house, ambient, pop, hardstyle, rock, electronic)
// deliberately override almost nothing: they ARE the default each world was
// written around.
//
// THE VOCABULARY IS DELIBERATELY WIDER THAN THE DETECTOR. The live classifier
// (`audio/style.js`) and the server's (`deezer/analysis.py`) name ~54 families,
// because that is what six audio descriptors can honestly separate. A name can
// also arrive from the genre studio — a hand-applied tag, or a trained model's
// prediction — and those are not limited to what a heuristic can guess. So this
// table covers the ~170 sub-genres the studio offers too (`EXTRA_GENRES`), and
// `skinFor` normalises whatever it is handed (an id, a French label, a spelling
// with spaces, accents or hyphens) before looking it up. A test reads both
// vocabularies and fails on any name that does not resolve.

// The catalogue, NOT the registry: this file only needs to know that a world
// id is real, and importing the registry would drag every world's shader in
// behind it (see worlds/catalogue.js).
import { WORLD_META } from "./worlds/catalogue.js";

// --- the catalogue ----------------------------------------------------------
export const SKINS = {
  // === hard: the kick is the event ===========================================
  hardcore: { world: "shatter" },
  frenchcore: { world: "cymatics" },
  uptempo: { world: "microwave", hue: -12, sat: 1.1, speed: 1.2, p: { dish: 2, hum: 1.3, arcs: 0.8, field: 1.15 } },
  gabber: { world: "shatter", hue: -8, p: { shards: 0.55, jag: 1.35, flash: 0.8, leds: 0.6 } },
  speedcore: { world: "shatter", hue: -20, speed: 1.4, p: { shards: 2.1, jag: 0.8, spin: 1.5, burst: 1.2 } },
  terrorcore: { world: "shatter", hue: -28, sat: 1.15, p: { shards: 1.6, jag: 1.5, burst: 0.6, leds: 0.4 } },
  crossbreed: { world: "shatter", hue: 150, sat: 0.8, p: { shards: 1.3, jag: 1.1, leds: 0.4 } },
  ukhardcore: { world: "fireworks", hue: 30, p: { shells: 1.3, size: 1.05 } },
  happyhardcore: { world: "fireworks", hue: 45, sat: 1.2, p: { shells: 1.5, size: 1.1, smoke: 0.7 } },
  hardstyle: { world: "lasers" },
  rawstyle: { world: "forge", hue: -18, sat: 1.1, p: { heat: 1.35, anthem: 0.35, sparks: 1.4, smoke: 1.2, anvils: 1 } },
  euphorichardstyle: { world: "lasers", hue: 20, p: { raw: 0, beams: 9, fire: 0.6, sweep: 0.8 } },
  rawphase: { world: "forge", hue: -28, sat: 1.2, speed: 1.15, p: { heat: 1.6, anthem: 0.2, sparks: 1.7, smoke: 0.9, anvils: 3 } },
  hardhouse: { world: "lasers", hue: 25, p: { raw: 0.5, fire: 0.5, beams: 6, emitters: 3 } },
  hardtrance: { world: "lasers", hue: 180, p: { raw: 0.15, fire: 0.3, beams: 9, sweep: 1.3 } },
  hardtekk: { world: "bounce" },
  germanparty: { world: "bounce", hue: 30, sat: 1.15, p: { height: 1.2, gloss: 1.2 } },
  jumpstyle: { world: "bounce", hue: -15, p: { height: 1.4, squash: 0.7, twins: 0 } },
  hardbass: { world: "bounce", hue: 200, sat: 0.9, p: { squash: 1.4, twins: 1, spikes: 1.3 } },
  bouncy: { world: "bounce", hue: 15, p: { height: 1.3, twins: 1 } },
  tekk: { world: "bounce", hue: -10, p: { spikes: 1.2 } },
  makina: { world: "bounce", hue: 60, p: { height: 1.1, spikes: 1.2, twins: 0 } },
  zaag: { world: "microwave", hue: 20, sat: 1.05, p: { dish: 1, hum: 1.15, arcs: 1.2, spin: 1.3 } },
  pieep: { world: "stairs", hue: 35, p: { steps: 16, trail: 0.7 } },
  acidtechno: { world: "stairs", hue: 70, sat: 1.1, p: { steps: 12, rise: 0.16, trail: 1.4 } },
  acidcore: { world: "stairs", hue: 60, speed: 1.3, p: { steps: 20, rise: 0.1, trail: 0.6 } },
  hardpingpong: { world: "pingpong" },
  tribecore: { world: "soundsystem" },
  hardtek: { world: "soundsystem", hue: -10, p: { cols: 9, shake: 1.3 } },
  raggatek: { world: "soundsystem", hue: 55, sat: 1.15, p: { cols: 6, uv: 1.4 } },
  krach: { world: "microwave" },
  noise: { world: "static", sat: 0.7, p: { snow: 1.6, tear: 0.8, blocks: 0.8 } },
  industrial: { world: "static", hue: -10, sat: 0.7, p: { blocks: 1.3, split: 0.6 } },
  industrialhardcore: { world: "saw", hue: -20, sat: 0.85, p: { teeth: 30, sparks: 1.3, hot: 1.2 } },
  extratone: { world: "static", speed: 1.5, p: { tear: 1.6, snow: 1.5, split: 1.4 } },
  darkstep: { world: "static", sat: 0.6, p: { tear: 0.9, blocks: 1 } },
  bigroom: { world: "fireworks", p: { shells: 1.4, size: 1.3, smoke: 1.2 } },
  doomcore: { world: "warehouse", sat: 0.7, speed: 0.7, p: { strobe: 0.4, fog: 1.6, lamps: 0.6 } },

  // === techno & machines =====================================================
  techno: { world: "tunnel" },
  peaktime: { world: "tunnel", hue: -10, p: { dash: 1, depth: 0.8 } },
  ebm: { world: "tunnel", hue: -25, sat: 0.9, p: { sides: 3, twist: 0.4, scan: 0.4 } },
  hardtechno: { world: "warehouse", p: { strobe: 1.2 } },
  schranz: { world: "warehouse", hue: -10, speed: 1.2, p: { strobe: 1.6, fog: 1.3 } },
  industrialtechno: { world: "warehouse", sat: 0.8, p: { warm: 0.3 } },
  gqom: { world: "warehouse", hue: 20, p: { warm: 1.3, strobe: 0.6, fog: 1.2 } },
  minimal: { world: "ridges", sat: 0.8, p: { lines: 0.8, height: 0.8 } },
  postpunk: { world: "ridges", sat: 0.15, p: { lines: 1, height: 1.2, mirror: 1 } },
  darkwave: { world: "ridges", hue: -40, sat: 0.5, p: { height: 1.1 } },
  coldwave: { world: "ridges", hue: 180, sat: 0.5, p: { height: 0.9, mirror: 0 } },
  electronic: { world: "lattice" },
  detroit: { world: "lattice", hue: 160, p: { rod: 0.8, pulses: 1.3, bank: 0.6 } },
  idm: { world: "circuit", hue: 120, p: { packets: 1.4, chips: 1.2 } },
  dubtechno: { world: "ocean", sat: 0.6, p: { swell: 1, wind: 0.7, moon: 0.7 } },

  // === trance & psy ==========================================================
  trance: { world: "hyperspace" },
  uplifting: { world: "hyperspace", hue: 15, p: { gates: 1.3, nebula: 1.2 } },
  vocaltrance: { world: "hyperspace", hue: 30, p: { nebula: 1.4, gates: 0.7 } },
  progtrance: { world: "galaxy", p: { arms: 2, tilt: 0.6 } },
  psytrance: { world: "kaleido" },
  goa: { world: "kaleido", hue: 40, sat: 1.15, p: { mirror: 0, sectors: 6 } },
  fullon: { world: "kaleido", hue: 20, p: { sectors: 10, twist: 1.3 } },
  darkpsy: { world: "kaleido", hue: -40, sat: 0.7, light: 0.8, p: { web: 1, sectors: 7 } },
  hitech: { world: "kaleido", speed: 1.4, p: { sectors: 12, twist: 2, iter: 8 } },
  forest: { world: "kaleido", hue: 90, sat: 0.85, p: { web: 1, sectors: 6 } },
  psydub: { world: "flow", hue: 60, p: { speed: 0.7, scale: 1.3 } },

  // === house, dance, disco ===================================================
  house: { world: "pulse" },
  deephouse: { world: "pulse", hue: 20, speed: 0.8, p: { caustic: 1.2, spin: 0.7 } },
  techhouse: { world: "pulse", hue: -15, p: { caustic: 1.3, spin: 1.3, ripple: 1.2 } },
  proghouse: { world: "galaxy", hue: 20, p: { arms: 4, tilt: 0.3 } },
  melodichouse: { world: "aurora", hue: 25, p: { rays: 1.1, water: 1.2 } },
  electrohouse: { world: "spectrum", hue: -20 },
  bigbeat: { world: "spectrum", hue: 30, p: { width: 0.72, curve: 1.3 } },
  frenchhouse: { world: "discoball", hue: 15, p: { spots: 1.2, turn: 1.2, beams: 1.3 } },
  ghettohouse: { world: "slices", hue: -15, p: { angle: 45, bands: 12, jump: 1.4 } },
  dance: { world: "discoball", hue: 200, p: { beams: 1.2, turn: 1.3 } },
  disco: { world: "discoball" },
  nudisco: { world: "discoball", hue: 30, p: { spots: 1, beams: 0.7 } },
  boogie: { world: "discoball", hue: 25, p: { spots: 0.9, turn: 0.8 } },
  eurodance: { world: "discoball", hue: 200, sat: 1.15, p: { spots: 1.4, turn: 1.4 } },
  schlager: { world: "discoball", hue: 40, p: { spots: 1.2 } },
  funk: { world: "plasma", hue: 20, p: { blobs: 8, heat: 1.1 } },

  // === bass & breaks =========================================================
  dnb: { world: "slices" },
  jungle: { world: "slices", hue: 90, p: { axis: 1, bands: 11, jump: 1.3 } },
  breakbeat: { world: "slices", hue: 30, p: { angle: 12, bands: 7 } },
  nubreaks: { world: "slices", hue: -20, p: { angle: 24, bands: 8 } },
  drumfunk: { world: "slices", hue: 40, p: { axis: 1, bands: 7 } },
  jumpup: { world: "slices", hue: 60, speed: 1.2, p: { jump: 1.6, bands: 10 } },
  garage: { world: "slices", hue: -15, p: { angle: -15, bands: 8, jump: 0.8 } },
  twostep: { world: "slices", hue: 10, p: { angle: 30, bands: 6 } },
  speedgarage: { world: "slices", hue: -30, p: { angle: 18, bands: 10, jump: 1.2 } },
  jerseyclub: { world: "slices", hue: 50, speed: 1.2, p: { angle: 60, bands: 10, jump: 1.5 } },
  grime: { world: "slices", sat: 0.6, p: { angle: 0, bands: 12, jump: 1.2 } },
  liquiddnb: { world: "flow", hue: 170, p: { speed: 1.2, scale: 0.8, fade: 1.2 } },
  neurofunk: { world: "circuit", hue: 170, speed: 1.2, p: { packets: 1.6, lanes: 1.2, tilt: 1.2 } },
  dubstep: { world: "wobble" },
  brostep: { world: "wobble", hue: -20, p: { wave: 2, split: 1.3, tear: 1.3 } },
  riddim: { world: "wobble", hue: 40, p: { wave: 1, rate: 1.2 } },
  melodicdubstep: { world: "wobble", hue: 30, p: { wave: 0, rate: 0.7, split: 0.6, tear: 0.6 } },
  bassline: { world: "wobble", hue: -40, p: { wave: 1, rate: 1.4, grid: 0.6 } },
  trapedm: { world: "chrome", hue: -10, p: { blobs: 4, spikes: 1.2 } },
  hardtrap: { world: "chrome", hue: -25, p: { spikes: 1.6, blobs: 3 } },
  futurebass: { world: "bokeh", hue: 30, sat: 1.2, p: { count: 1.4, blades: 6 } },

  // === urban =================================================================
  hiphop: { world: "vinyl" },
  boombap: { world: "vinyl", hue: 20, sat: 0.85, p: { arm: 1, gloss: 0.8 } },
  rap: { world: "halo" },
  trap: { world: "halo", hue: -20, p: { echoes: 1.3, reach: 1.2 } },
  drill: { world: "halo", hue: 200, sat: 0.8, p: { echoes: 0.8, reach: 1.4 } },
  ukdrill: { world: "halo", hue: 210, sat: 0.6, p: { echoes: 0.8, reach: 1.4, dust: 0.6 } },
  cloudrap: { world: "ocean", hue: 280, p: { swell: 0.8, wind: 0.6, moon: 1.3 } },
  emorap: { world: "rain", hue: 220, sat: 0.6, p: { drops: 1.3, runners: 1.4 } },
  lofihiphop: { world: "rain", hue: 20, p: { runners: 1.2 } },
  phonk: { world: "nightdrive", hue: -30, p: { lamps: 0.8, rain: 1.2, traffic: 1.2 } },
  gfunk: { world: "nightdrive", hue: 30, p: { rain: 0, lamps: 1.2, traffic: 0.8 } },
  outrun: { world: "nightdrive", hue: -60, sat: 1.2, p: { rain: 0, city: 1.2 } },

  // === pop, voice, soul ======================================================
  pop: { world: "bokeh" },
  vocalPop: { world: "bokeh", hue: 10, p: { blades: 0 } },
  kpop: { world: "bokeh", hue: -20, sat: 1.25, p: { count: 1.3, blades: 5 } },
  jpop: { world: "bokeh", hue: 20, sat: 1.15, p: { count: 1.2, blades: 7 } },
  smoothjazz: { world: "bokeh", hue: 25, sat: 0.85, speed: 0.7, p: { count: 0.7, blades: 0, drift: 0.6 } },
  rnb: { world: "silk", p: { ribbons: 3 } },
  soul: { world: "silk", hue: 20, p: { ribbons: 4, width: 1.2 } },
  neosoul: { world: "silk", hue: 30, p: { ribbons: 3, twist: 0.7 } },
  kizomba: { world: "silk", hue: -10, p: { ribbons: 2, width: 1.3, twist: 0.6 } },
  dreampop: { world: "silk", sat: 0.8, p: { ribbons: 5, width: 1.4, twist: 0.5 } },
  tango: { world: "silk", hue: -20, sat: 1.1, p: { ribbons: 2, width: 0.8, twist: 1.4 } },
  motown: { world: "vinyl", hue: 25, p: { arm: 1, gloss: 1.2 } },
  chanson: { world: "artwork", p: { blobs: 4, swirl: 0.7 } },
  indie: { world: "artwork", p: { blobs: 5 } },
  synthpop: { world: "neon" },
  vaporwave: { world: "neon", hue: -60, sat: 0.9, speed: 0.7, p: { signs: 6, rain: 0.4 } },
  citypop: { world: "neon", hue: -30, p: { signs: 10, rain: 0.3, wet: 0.8 } },
  italodisco: { world: "neon", hue: 20, p: { signs: 9, rain: 0.5 } },
  futurefunk: { world: "neon", hue: -45, sat: 1.2, p: { signs: 12, rain: 0, wet: 0.6 } },
  hyperpop: { world: "pixels", hue: -60, sat: 1.3, p: { glitch: 1.4, steps: 12 } },
  latinpop: { world: "tropics", hue: 15, p: { glitter: 1.3 } },

  // === rock & metal ==========================================================
  rock: { world: "stage" },
  hardrock: { world: "stage", hue: -10, p: { beams: 10, wall: 1.2 } },
  garagerock: { world: "stage", hue: 20, sat: 0.85, p: { beams: 6, smoke: 0.8 } },
  poppunk: { world: "stage", hue: 10, sat: 1.15, p: { beams: 8, wall: 1.3 } },
  numetal: { world: "stage", hue: -15, sat: 0.8, p: { beams: 8, wall: 1.4 } },
  powermetal: { world: "stage", hue: 30, p: { beams: 12, wall: 1.4 } },
  symphonicmetal: { world: "stage", hue: 200, p: { beams: 12, smoke: 1.3, wall: 0.8 } },
  bigband: { world: "stage", hue: 30, sat: 0.9, p: { beams: 6, wall: 0.5 } },
  blues: { world: "stage", hue: 210, sat: 0.8, p: { beams: 4, smoke: 1.3, wall: 0.3 } },
  metal: { world: "inferno" },
  brutal: { world: "inferno", sat: 0.8, p: { height: 1.3, embers: 1.3, tint: 0.3 } },
  heavymetal: { world: "inferno", p: { tint: 0.6 } },
  deathmetal: { world: "inferno", light: 0.85, p: { height: 1.2, tint: 0.2 } },
  deathcore: { world: "inferno", p: { height: 1.3, embers: 1.4, tint: 0.3 } },
  sludge: { world: "inferno", sat: 0.8, speed: 0.6, p: { height: 0.8, embers: 0.6 } },
  flamenco: { world: "inferno", hue: 10, p: { height: 0.9, embers: 1.2, tint: 0.8 } },
  punk: { world: "storm", p: { bolts: 1.2 } },
  hardcorepunk: { world: "storm", p: { bolts: 1.4, rain: 1.2 } },
  thrash: { world: "storm", hue: -15, p: { bolts: 1.5, rain: 1.3 } },
  blackmetal: { world: "storm", sat: 0.3, light: 0.9, p: { bolts: 1.1, rain: 0.6 } },
  doom: { world: "storm", sat: 0.7, speed: 0.6, p: { bolts: 0.5, rain: 1.2 } },
  metalcore: { world: "storm", hue: 20, p: { bolts: 1.3 } },
  djent: { world: "storm", hue: 170, sat: 0.8, p: { bolts: 1.2, hills: 0.6 } },
  grunge: { world: "storm", sat: 0.6, p: { bolts: 0.6, rain: 1.4 } },
  psychrock: { world: "plasma", hue: 60, sat: 1.2, p: { blobs: 10, speed: 1.3, heat: 1.2 } },
  progrock: { world: "galaxy", hue: -20, p: { arms: 2, tilt: 0.8, dust: 1.3 } },
  emo: { world: "rain", sat: 0.7, p: { drops: 1.2, runners: 1.2 } },
  gothic: { world: "cathedral", sat: 0.6, light: 0.8, p: { shafts: 0.7, window: 1.3 } },
  witchhouse: { world: "nebula", hue: -60, sat: 0.6, p: { glow: 0.7, dust: 1.2 } },

  // === calm ==================================================================
  ambient: { world: "nebula" },
  drone: { world: "nebula", speed: 0.7, p: { glow: 0.8, dust: 1.3, stars: 0.4 } },
  darkambient: { world: "nebula", sat: 0.7, light: 0.8, p: { glow: 0.6, dust: 1.4 } },
  newage: { world: "aurora" },
  shoegaze: { world: "aurora", sat: 0.85, p: { rays: 0.6, spread: 1.4, height: 1.2 } },
  soundtrack: { world: "aurora", hue: -15, p: { height: 1.2, rays: 1.2 } },
  celtic: { world: "aurora", hue: 100, p: { stars: 1.2 } },
  downtempo: { world: "ocean" },
  chillout: { world: "tropics", speed: 0.8, p: { sway: 0.6, glitter: 1.2 } },
  dub: { world: "ocean", hue: 60, p: { swell: 1.3, wind: 0.8 } },
  lofi: { world: "rain" },
  chillhop: { world: "rain", hue: 20, p: { drops: 0.8, city: 1.2 } },
  strings: { world: "cathedral" },
  classical: { world: "cathedral" },
  orchestral: { world: "cathedral", hue: -10, p: { shafts: 1.2 } },
  opera: { world: "cathedral", hue: 10, p: { window: 1.3, shafts: 1.1 } },
  choral: { world: "cathedral", hue: 20, p: { shafts: 1.3, dust: 1.2 } },
  baroque: { world: "cathedral", hue: 25, p: { window: 1.2 } },
  gospel: { world: "cathedral", hue: 30, p: { shafts: 1.4, window: 1.2 } },
  filmscore: { world: "cathedral", hue: -20, p: { shafts: 1.3, dust: 1.3 } },
  piano: { world: "piano", sat: 0.85, p: { haze: 0.8, sparkle: 0.6, gliss: 0 } },
  romantic: { world: "ink", hue: -15, p: { fade: 1.2 } },
  minimalism: { world: "ink", sat: 0.6, speed: 0.7, p: { ink: 0.6, curl: 0.5, fade: 1.5 } },
  triphop: { world: "ink", sat: 0.6, p: { ink: 1.2, curl: 1.3 } },
  experimental: { world: "ink", hue: 90, p: { ink: 1.3, curl: 1.6 } },

  // === acoustic, folk, jazz ==================================================
  jazz: { world: "vinyl", hue: 20, sat: 0.8, p: { arm: 1, rpm: 0.8 } },
  bebop: { world: "vinyl", sat: 0.7, p: { arm: 1, rpm: 0.8 } },
  swing: { world: "vinyl", hue: 25, sat: 0.75, p: { arm: 1, rpm: 1.5 } },
  jazzfusion: { world: "flow", hue: 30, p: { speed: 0.9, ink: 1.2 } },
  folk: { world: "fireflies" },
  country: { world: "fireflies", hue: 25, p: { flies: 0.8 } },
  bluegrass: { world: "fireflies", hue: 15, p: { flies: 1.2, wind: 1.2 } },
  deltablues: { world: "fireflies", hue: 20, speed: 0.8, p: { flies: 0.7, wind: 0.6 } },
  singersongwriter: { world: "fireflies", p: { flies: 0.9, sync: 0.6 } },

  // === world =================================================================
  salsa: { world: "carnival", p: { rings: 5 } },
  samba: { world: "carnival", hue: 30, p: { rings: 6, confetti: 1.4 } },
  cumbia: { world: "carnival", hue: 15, p: { rings: 4, size: 1.1 } },
  afrobeat: { world: "carnival", hue: 30, p: { rings: 5 } },
  afrohouse: { world: "carnival", hue: 20, p: { rings: 5, confetti: 0.8 } },
  amapiano: { world: "carnival", hue: 35, p: { rings: 4, confetti: 0.6, size: 1.2 } },
  dembow: { world: "carnival", hue: -10, p: { rings: 3, size: 1.3 } },
  ska: { world: "carnival", sat: 0.4, p: { rings: 4 } },
  skapunk: { world: "carnival", sat: 0.5, p: { rings: 5 } },
  bollywood: { world: "carnival", hue: 40, sat: 1.2, p: { rings: 6, confetti: 1.5 } },
  arabic: { world: "kaleido", hue: 30, p: { sectors: 12, twist: 0.5 } },
  reggae: { world: "tropics", p: { sway: 0.8 } },
  reggaeton: { world: "tropics", hue: -10, p: { glitter: 1.3, sway: 1.2 } },
  dancehall: { world: "soundsystem", hue: 30, p: { cols: 5, rings: 1.2, uv: 0.6 } },
  rocksteady: { world: "tropics", hue: 20, p: { sway: 0.7 } },
  afrobeats: { world: "tropics", hue: 15, p: { glitter: 1.1 } },
  afroswing: { world: "tropics", hue: 5, p: { sway: 1.1 } },
  bossanova: { world: "tropics", hue: 10, speed: 0.8, p: { sway: 0.6, glitter: 0.8 } },
  highlife: { world: "tropics", hue: 25, p: { sway: 1.2 } },
  moombahton: { world: "tropics", hue: -15, p: { glitter: 1.2, sway: 1.3 } },

  // === retro =================================================================
  synthwave: { world: "horizon" },
  retrowave: { world: "horizon", hue: 10, p: { sun: 1.1 } },
  darksynth: { world: "horizon", hue: -40, p: { sun: 0.8, peaks: 1.4, grid: 1.2 } },
  chiptune: { world: "pixels" },
  eightbit: { world: "pixels", hue: 20, p: { cell: 1.3, steps: 5 } },
  glitch: { world: "pixels", hue: 150, p: { glitch: 1.8, steps: 6 } },
  glitchhop: { world: "pixels", hue: 40, p: { glitch: 1.3, coins: 0.5 } },
  breakcore: { world: "pixels", hue: -30, speed: 1.3, p: { glitch: 2, scroll: 1.4, coins: 0 } },
  lolicore: { world: "pixels", hue: -50, sat: 1.2, p: { glitch: 1.6, coins: 1.2 } },
};

// --- aliases ----------------------------------------------------------------
// The name can arrive as an id, as a French label from the classifier, or as
// whatever an admin typed into the genre studio. Everything is normalised first
// (lowercased, accents and punctuation removed), so only genuinely different
// WORDS need a line here.
export const ALIASES = {
  // the classifier's own French labels, where they are not simply the id
  cordesclassique: "strings",
  jazzacoustique: "jazz",
  popchanson: "vocalPop",
  rbsoul: "rnb",
  danceedm: "dance",
  discofunk: "disco",
  deutscherkrach: "krach",
  tribe: "tribecore",
  indus: "industrial",
  deathbrutal: "brutal",
  ukgarage: "garage",
  drumbass: "dnb",
  electronique: "electronic",
  // spellings people actually type
  drumandbass: "dnb",
  drumnbass: "dnb",
  randb: "rnb",
  edm: "bigroom",
  mainstage: "bigroom",
  clubdance: "dance",
  variete: "vocalPop",
  varietefrancaise: "chanson",
  frenchvariety: "chanson",
  chansonfrancaise: "chanson",
  musiquedumonde: "afrobeat",
  worldmusic: "afrobeat",
  hardtekkzaag: "zaag",
  germanhardtekk: "germanparty",
  partytekk: "germanparty",
  hardpingpongtekk: "hardpingpong",
  frenchtek: "hardtek",
  tekno: "hardtek",
  freeparty: "tribecore",
  teknival: "tribecore",
  terror: "terrorcore",
  neuro: "neurofunk",
  liquid: "liquiddnb",
  liquidfunk: "liquiddnb",
  ukg: "garage",
  "2step": "twostep",
  goatrance: "goa",
  psy: "psytrance",
  darkpsytrance: "darkpsy",
  upliftingtrance: "uplifting",
  progressivetrance: "progtrance",
  progressivehouse: "proghouse",
  progressiverock: "progrock",
  psychedelicrock: "psychrock",
  classique: "classical",
  musiqueclassique: "classical",
  bandeoriginale: "filmscore",
  musiquedefilm: "filmscore",
  ost: "soundtrack",
  hiphopfr: "hiphop",
  rapfr: "rap",
  chill: "chillout",
  balearic: "chillout",
  latin: "latinpop",
  afro: "afrohouse",
  electro: "electrohouse",
  "8bit": "eightbit",
  bitpop: "chiptune",
  vgm: "chiptune",
  retro: "synthwave",
  newwave: "synthpop",
};

// When nothing in the catalogue matches, the archetype still says something.
// Kept in step with worlds/catalogue.js#worldFor.
const ARCHETYPE_SKIN = {
  sustain: "ambient",
  voice: "pop",
  groove: "techno",
  hard: "hardstyle",
  rock: "rock",
};

// Accents out, punctuation out, lowercase. "Hard Ping-Pong" and "hardpingpong"
// are the same genre, and so are "Cordes / classique" and its alias.
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
  if (SKINS[to] && !BY_KEY.has(normalise(from))) BY_KEY.set(normalise(from), to);
}

/** The catalogue id for whatever name was handed over, or "" when unknown. */
export function skinId(name, archetype = "") {
  const hit = BY_KEY.get(normalise(name));
  if (hit) return hit;
  return ARCHETYPE_SKIN[archetype] || "";
}

// The floor under everything: an unknown name with no archetype.
const EMPTY = { world: "bokeh", p: {} };

/** The skin itself, always usable: an unknown name still returns something. */
export function skinFor(name, archetype = "") {
  const id = skinId(name, archetype);
  const s = (id && SKINS[id]) || EMPTY;
  // A skin naming a world that does not exist would render nothing at all,
  // which is a much worse failure than rendering the wrong one.
  return WORLD_META[s.world] ? s : { ...s, world: EMPTY.world };
}

/** How many genres the animation engine can dress differently. */
export function skinCount() {
  return Object.keys(SKINS).length;
}
