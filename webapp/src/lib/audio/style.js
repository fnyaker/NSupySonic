// What kind of music is this, and what is its kick made of?
//
// This is deliberately a HEURISTIC classifier, not a model. It has to run on a
// phone, inside the same frame budget as the rendering, with no download and no
// warm-up, and its output drives an animation — so being roughly right within a
// couple of seconds and never flickering matters far more than being exactly
// right eventually. Every axis it uses is one of the descriptors the rhythm
// analyser already produces for other reasons (webapp/rhythm/src/features.rs,
// tempo.rs), so the classifier itself is essentially free. This file is its
// VOCABULARY — the families, their looks, their tempo ranges and their rules,
// written as data; the arithmetic runs in rhythm/src/style.rs, on the audio
// thread, from the table `familyTable()` hands it.
//
// TWO OUTPUTS, for two different jobs:
//
//  - `families` is the fine-grained read (techno / hardcore / tribe / uptempo /
//    frenchcore / zaag / drum & bass / dance / …). It exists because it is
//    legible: it
//    is what the UI shows the user, and what makes the mode feel like it is
//    actually listening.
//  - `archetypes` is the coarse read the renderer blends on — sustain, voice,
//    groove, hard, rock. Animations interpolate between five archetypes
//    smoothly; they cannot interpolate between eighteen genre names, and a
//    scene that re-draws itself every time the classifier changes its mind
//    between two neighbouring hardcore subgenres would be unwatchable.
//
// Nothing here ever hard-switches. Both outputs are weights, smoothed over
// seconds, and the dominant family only changes with hysteresis.

// --- fuzzy membership helpers ---------------------------------------------
// Trapezoids with soft shoulders. `w` is the width of the ramp on each side.
function inRange(x, lo, hi, w = (hi - lo) * 0.45) {
  if (x >= lo && x <= hi) return 1;
  if (x < lo) return Math.max(0, 1 - (lo - x) / w);
  return Math.max(0, 1 - (x - hi) / w);
}
function above(x, t, w) {
  return Math.max(0, Math.min(1, (x - t) / w));
}
function below(x, t, w) {
  return Math.max(0, Math.min(1, (t - x) / w));
}

// The visual archetypes the renderer understands.
export const ARCHETYPES = ["sustain", "voice", "groove", "hard", "rock"];

// --- what a genre LOOKS like ------------------------------------------------
// Five archetypes are enough for a renderer to blend between, and not nearly
// enough to tell hardtekk from frenchcore — which is the whole complaint the
// `look` vector answers. It is deliberately NOT a name: a name cannot be
// interpolated, and a scene that re-drew itself every time the classifier
// changed its mind between two neighbouring hardcore subgenres would be
// unwatchable. It is seven numbers, blended by the same family weights the
// archetypes are pooled from, so it moves exactly as smoothly as they do and
// says far more.
//
//   motion   how fast things travel
//   density  how much is on screen
//   punch    how hard a beat hits the image
//   smooth   how much easing and trail (the opposite of snap)
//   warm     palette temperature bias — 0 is cold and blue, 1 is hot and red
//   melodic  how much the melody drives it rather than the drums
//   chaos    how much randomness, glitch and distortion belongs in it
export const LOOK_KEYS = ["motion", "density", "punch", "smooth", "warm", "melodic", "chaos"];

// Every family starts from its archetype and overrides only what it actually
// differs on, so a new family costs one line and the table stays readable.
const ARCHETYPE_LOOK = {
  sustain: { motion: 0.16, density: 0.28, punch: 0.1, smooth: 0.93, warm: 0.45, melodic: 0.88, chaos: 0.04 },
  voice: { motion: 0.34, density: 0.42, punch: 0.3, smooth: 0.74, warm: 0.62, melodic: 0.8, chaos: 0.08 },
  groove: { motion: 0.56, density: 0.58, punch: 0.58, smooth: 0.5, warm: 0.5, melodic: 0.45, chaos: 0.16 },
  hard: { motion: 0.82, density: 0.72, punch: 0.92, smooth: 0.2, warm: 0.7, melodic: 0.22, chaos: 0.45 },
  rock: { motion: 0.62, density: 0.55, punch: 0.72, smooth: 0.36, warm: 0.7, melodic: 0.5, chaos: 0.3 },
};

// Only where a subgenre genuinely reads differently from its neighbours. The
// numbers are the point of this table, so each line is a claim about the music:
// psytrance is fast and cold and relentless; lofi barely moves and is warm;
// zaag is a cold buzzing lead and frenchcore is a red wall.
const LOOK_OVERRIDES = {
  ambient: { motion: 0.06, density: 0.16, punch: 0.04, warm: 0.38 },
  strings: { motion: 0.2, density: 0.34, warm: 0.55, melodic: 0.95 },
  jazz: { motion: 0.4, density: 0.46, warm: 0.7, chaos: 0.2, smooth: 0.66 },
  lofi: { motion: 0.2, density: 0.3, punch: 0.22, smooth: 0.9, warm: 0.78, chaos: 0.14 },
  synthwave: { motion: 0.44, density: 0.5, smooth: 0.8, warm: 0.88, melodic: 0.78 },
  soul: { warm: 0.8, melodic: 0.82, smooth: 0.8 },
  blues: { warm: 0.78, melodic: 0.85, motion: 0.3 },
  folk: { motion: 0.24, density: 0.3, warm: 0.66, melodic: 0.9, chaos: 0.04 },
  country: { warm: 0.72, melodic: 0.85, motion: 0.36 },
  rnb: { warm: 0.74, smooth: 0.82, melodic: 0.8 },
  reggae: { motion: 0.36, warm: 0.62, smooth: 0.76, melodic: 0.6 },
  dancehall: { motion: 0.5, warm: 0.74, chaos: 0.2 },
  reggaeton: { motion: 0.52, warm: 0.76, punch: 0.62 },
  hiphop: { motion: 0.42, punch: 0.66, warm: 0.6, melodic: 0.4, smooth: 0.6 },
  rap: { motion: 0.46, punch: 0.7, warm: 0.62, melodic: 0.35 },
  trap: { motion: 0.5, density: 0.5, punch: 0.78, warm: 0.42, chaos: 0.26, melodic: 0.3 },
  phonk: { motion: 0.54, punch: 0.8, warm: 0.3, chaos: 0.34, smooth: 0.4 },
  drill: { motion: 0.5, punch: 0.74, warm: 0.3, chaos: 0.3 },
  house: { motion: 0.5, density: 0.55, warm: 0.6, smooth: 0.58, melodic: 0.55 },
  afrohouse: { motion: 0.52, warm: 0.78, melodic: 0.6, density: 0.6 },
  amapiano: { motion: 0.44, warm: 0.76, smooth: 0.7, melodic: 0.62 },
  disco: { motion: 0.56, warm: 0.85, melodic: 0.7, density: 0.62 },
  funk: { motion: 0.58, warm: 0.84, melodic: 0.68, punch: 0.62 },
  garage: { motion: 0.62, density: 0.6, chaos: 0.24, warm: 0.5 },
  breakbeat: { motion: 0.7, density: 0.66, chaos: 0.34, punch: 0.66 },
  techno: { motion: 0.66, density: 0.62, warm: 0.28, smooth: 0.38, melodic: 0.28, chaos: 0.2 },
  hardtechno: { motion: 0.8, density: 0.7, warm: 0.3, punch: 0.82, chaos: 0.34, smooth: 0.24 },
  trance: { motion: 0.62, density: 0.7, warm: 0.3, smooth: 0.72, melodic: 0.84 },
  psytrance: { motion: 0.9, density: 0.86, warm: 0.22, smooth: 0.3, melodic: 0.4, chaos: 0.32 },
  dance: { motion: 0.58, warm: 0.66, melodic: 0.66, density: 0.6 },
  germanparty: { motion: 0.56, warm: 0.88, melodic: 0.74, chaos: 0.12 },
  dnb: { motion: 0.88, density: 0.8, punch: 0.72, warm: 0.36, chaos: 0.34, smooth: 0.26, melodic: 0.4 },
  dubstep: { motion: 0.7, density: 0.7, punch: 0.88, warm: 0.34, chaos: 0.55, smooth: 0.2 },
  hardstyle: { motion: 0.78, punch: 0.95, warm: 0.62, melodic: 0.45, chaos: 0.3 },
  rawstyle: { motion: 0.84, punch: 0.98, warm: 0.5, chaos: 0.5, melodic: 0.24 },
  hardtekk: { motion: 0.8, density: 0.66, punch: 0.86, warm: 0.5, melodic: 0.5, chaos: 0.28 },
  zaag: { motion: 0.86, density: 0.78, punch: 0.88, warm: 0.26, melodic: 0.34, chaos: 0.5 },
  // The melodic side of hardcore: the kick is huge, but it is the lead the
  // crowd sings, so it weighs more than on any other 200 BPM family.
  frenchcore: { motion: 0.94, density: 0.82, punch: 0.98, warm: 0.86, chaos: 0.5, melodic: 0.55 },
  uptempo: { motion: 0.97, density: 0.88, punch: 1, warm: 0.78, chaos: 0.66, melodic: 0.14 },
  hardcore: { motion: 0.9, density: 0.8, punch: 0.95, warm: 0.74, chaos: 0.5 },
  tribecore: { motion: 0.88, density: 0.84, warm: 0.6, chaos: 0.6, melodic: 0.2 },
  speedcore: { motion: 1, density: 0.95, punch: 1, warm: 0.8, chaos: 0.88, melodic: 0.08, smooth: 0.1 },
  industrial: { motion: 0.76, density: 0.7, warm: 0.2, chaos: 0.8, melodic: 0.12, smooth: 0.16 },
  krach: { motion: 0.95, density: 0.9, warm: 0.4, chaos: 0.95, melodic: 0.06, smooth: 0.08 },
  pieep: { motion: 0.88, density: 0.62, warm: 0.36, chaos: 0.42, melodic: 0.62 },
  hardpingpong: { motion: 0.9, density: 0.7, warm: 0.44, chaos: 0.5, melodic: 0.4 },
  rock: { motion: 0.6, warm: 0.72, melodic: 0.55, chaos: 0.26 },
  hardrock: { motion: 0.7, punch: 0.8, warm: 0.76, chaos: 0.36 },
  punk: { motion: 0.82, punch: 0.8, warm: 0.74, chaos: 0.5, smooth: 0.2 },
  metal: { motion: 0.78, density: 0.72, punch: 0.84, warm: 0.62, chaos: 0.5, smooth: 0.22 },
  brutal: { motion: 0.9, density: 0.82, punch: 0.92, warm: 0.5, chaos: 0.75, smooth: 0.12 },
  indie: { motion: 0.48, warm: 0.66, melodic: 0.7, smooth: 0.55 },
  pop: { motion: 0.46, warm: 0.7, melodic: 0.74, smooth: 0.64 },
  vocalPop: { motion: 0.4, warm: 0.7, melodic: 0.82, smooth: 0.7 },
  electronic: { motion: 0.58, warm: 0.5, melodic: 0.5 },
};

function lookFor(family) {
  const base = ARCHETYPE_LOOK[family.a] || ARCHETYPE_LOOK.groove;
  return { ...base, ...(LOOK_OVERRIDES[family.id] || {}) };
}

// Genre families. `w` is the weighting function; `a` is the archetype it feeds.
// The comment on each says which measurement is actually doing the work, so a
// later tweak knows what it is trading against.
const FAMILIES = [
  {
    id: "ambient",
    label: "Ambient",
    a: "sustain",
    // No pulse, nothing moving, nothing bright.
    rule: [
      ["below", "pulse", 0.35, 0.35],
      ["below", "perc", 0.3, 0.3],
      ["below", "flat", 0.45, 0.35],
      ["below", "level", 0.72, 0.4],
    ],
  },
  {
    id: "strings",
    label: "Cordes / classique",
    a: "sustain",
    // Very tonal, very sustained, real dynamic range (high crest — nothing has
    // been squashed by a limiter), and no machine pulse.
    rule: [
      ["below", "flat", 0.3, 0.25],
      ["below", "perc", 0.35, 0.3],
      ["below", "kickPulse", 0.35, 0.35],
      ["above", "crest", 3.2, 4],
      ["in", "centroid", 0.2, 0.55],
    ],
  },
  {
    id: "jazz",
    label: "Jazz / acoustique",
    a: "voice",
    rule: [
      ["in", "bpm", 80, 165, 45],
      ["below", "flat", 0.5, 0.3],
      ["below", "kickPulse", 0.55, 0.3],
      ["above", "crest", 2.6, 3],
      ["in", "centroid", 0.25, 0.6],
    ],
  },
  {
    id: "vocalPop",
    label: "Pop / chanson",
    a: "voice",
    // The syllabic-rate modulation is the whole tell here.
    rule: [
      ["above", "vocal", 0.28, 0.35],
      ["in", "bpm", 84, 138, 32],
      ["below", "flat", 0.55, 0.3],
      ["in", "centroid", 0.25, 0.65],
    ],
  },
  {
    id: "rnb",
    label: "R&B / soul",
    a: "voice",
    rule: [
      ["above", "vocal", 0.3, 0.35],
      ["in", "bpm", 60, 100, 25],
      ["above", "subRatio", 0.16, 0.2],
      ["below", "flat", 0.5, 0.3],
    ],
  },
  {
    id: "hiphop",
    label: "Hip-hop",
    a: "groove",
    rule: [
      ["in", "bpm", 70, 105, 22],
      ["above", "subRatio", 0.2, 0.2],
      ["above", "vocal", 0.2, 0.4],
      ["below", "kickPulse", 0.8, 0.4],
    ],
  },
  {
    id: "house",
    label: "House",
    a: "groove",
    rule: [
      ["in", "bpm", 116, 128, 12],
      ["above", "kickPulse", 0.45, 0.35],
      ["raw", "kSoft"],
      ["below", "flat", 0.55, 0.3],
    ],
  },
  {
    id: "techno",
    label: "Techno",
    a: "groove",
    rule: [
      ["in", "bpm", 125, 150, 16],
      ["above", "kickPulse", 0.5, 0.3],
      ["below", "vocal", 0.45, 0.4],
      ["max", "kSoft", 1, "kHard", 0.8],
    ],
  },
  {
    id: "trance",
    label: "Trance",
    a: "groove",
    rule: [
      ["in", "bpm", 132, 145, 12],
      ["above", "kickPulse", 0.45, 0.35],
      ["below", "flat", 0.5, 0.3],
      ["above", "airRatio", 0.1, 0.18],
    ],
  },
  {
    id: "dance",
    label: "Dance / EDM",
    a: "groove",
    // Mainstage: a clean four-on-the-floor kick under bright leads and hats.
    rule: [
      ["in", "bpm", 118, 136, 10],
      ["above", "kickPulse", 0.5, 0.3],
      ["above", "airRatio", 0.1, 0.18],
      ["below", "flat", 0.55, 0.3],
      ["raw", "kSoft"],
    ],
  },
  {
    id: "dnb",
    label: "Drum & bass",
    a: "groove",
    // Breakbeats: a steady tempo but a syncopated kick, and a lot of sub.
    rule: [
      ["in", "bpm", 160, 182, 10],
      ["in", "kickPulse", 0.2, 0.65, 0.25],
      ["above", "subRatio", 0.2, 0.2],
      ["above", "perc", 0.5, 0.3],
    ],
  },
  {
    id: "dubstep",
    label: "Dubstep",
    a: "groove",
    // Half-time and sparse: the kick is rare and the sub carries the drop.
    rule: [
      ["in", "bpm", 136, 148, 8],
      ["below", "kickPulse", 0.55, 0.3],
      ["above", "subRatio", 0.28, 0.2],
      ["below", "centroid", 0.55, 0.25],
    ],
  },
  {
    id: "disco",
    label: "Disco / funk",
    a: "groove",
    // Played, not programmed: four-on-the-floor with real dynamics left in it.
    rule: [
      ["in", "bpm", 106, 124, 10],
      ["above", "kickPulse", 0.45, 0.3],
      ["below", "flat", 0.45, 0.25],
      ["above", "crest", 2.6, 2.5],
      ["in", "centroid", 0.25, 0.6],
    ],
  },
  {
    id: "psytrance",
    label: "Psytrance",
    a: "groove",
    // A rolling bassline on a fast grid, bright and clean.
    rule: [
      ["in", "bpm", 138, 152, 10],
      ["above", "kickPulse", 0.55, 0.3],
      ["in", "flat", 0.25, 0.55, 0.2],
      ["above", "airRatio", 0.12, 0.18],
    ],
  },
  {
    id: "hardstyle",
    label: "Hardstyle",
    a: "hard",
    rule: [
      ["in", "bpm", 145, 162, 12],
      ["above", "kickPulse", 0.45, 0.3],
      ["raw", "kHard"],
    ],
  },
  {
    id: "hardtekk",
    label: "Hardtekk",
    a: "hard",
    // German hardtekk: hard kick, offbeat bass, a shade under hardstyle tempo
    // and considerably more raw in the mids.
    rule: [
      ["in", "bpm", 138, 165, 14],
      ["above", "kickPulse", 0.45, 0.3],
      ["raw", "kHard"],
      ["above", "flat", 0.3, 0.3],
    ],
  },
  {
    id: "zaag",
    label: "Zaag",
    a: "hard",
    // "Saw": a harmonically dense, gliding lead carrying the tune rather than a
    // pad — lots of mid/high content that is rich but not pure noise.
    rule: [
      ["in", "bpm", 150, 210, 28],
      ["in", "flat", 0.34, 0.62, 0.22],
      ["above", "midRatio", 0.3, 0.25],
      ["max", "kHard", 1, "kIndus", 0.7],
    ],
  },
  {
    id: "frenchcore",
    label: "Frenchcore",
    a: "hard",
    rule: [
      ["in", "bpm", 185, 230, 25],
      ["above", "kickPulse", 0.4, 0.3],
      ["above", "flat", 0.4, 0.3],
      ["max", "kHard", 0.8, "kIndus", 1],
    ],
  },
  {
    id: "uptempo",
    label: "Uptempo",
    a: "hard",
    // A lower bar on kickPulse than the other gridded families, deliberately:
    // at 280 BPM a beat is 210 ms and the onset grid only has twenty slots to
    // describe it, so the grid measurement is at the limit of its own
    // resolution up here. The tempo itself is already most of the evidence.
    rule: [
      ["in", "bpm", 220, 300, 35],
      ["above", "kickPulse", 0.22, 0.3],
      ["above", "flat", 0.45, 0.3],
      ["raw", "kIndus"],
    ],
  },
  {
    id: "krach",
    label: "Deutscher Krach",
    a: "hard",
    // Extreme, loud, and deliberately ugly: barely any crest left, the spectrum
    // nearly flat, and a kick that is mostly distortion.
    rule: [
      ["in", "bpm", 190, 300, 45],
      ["above", "flat", 0.55, 0.25],
      ["below", "crest", 3.2, 2],
      ["raw", "kIndus"],
    ],
  },
  {
    id: "pieep",
    label: "Pieep",
    a: "hard",
    // Squeaky, very high-register tonal leads over a fast kick.
    rule: [
      ["in", "bpm", 170, 260, 40],
      ["above", "airRatio", 0.2, 0.18],
      ["above", "centroid", 0.62, 0.2],
      ["below", "flat", 0.55, 0.3],
    ],
  },
  {
    id: "hardcore",
    label: "Hardcore",
    a: "hard",
    // Mainstream hardcore: a distorted kick on every beat, squashed flat.
    rule: [
      ["in", "bpm", 148, 195, 18],
      ["above", "kickPulse", 0.45, 0.3],
      ["in", "flat", 0.4, 0.75, 0.2],
      ["max", "kHard", 1, "kIndus", 0.8],
    ],
  },
  {
    id: "tribecore",
    label: "Tribe",
    a: "hard",
    // Tribe: percussive and mid-heavy rather than one wall of noise.
    rule: [
      ["in", "bpm", 150, 190, 20],
      ["above", "kickPulse", 0.45, 0.3],
      ["in", "flat", 0.32, 0.62, 0.2],
      ["above", "perc", 0.5, 0.3],
      ["above", "midRatio", 0.3, 0.25],
      ["max", "kHard", 1, "kIndus", 0.7],
    ],
  },
  {
    id: "speedcore",
    label: "Speedcore",
    a: "hard",
    // Past 250 BPM the grid is at its limit; only the noise is left.
    rule: [
      ["in", "bpm", 245, 300, 22],
      ["above", "flat", 0.5, 0.22],
      ["above", "kIndus", 0.4, 0.3],
      ["below", "crest", 3.5, 2.5],
    ],
  },
  {
    id: "industrial",
    label: "Indus",
    a: "hard",
    // A metallic, noisy kick is the whole tell.
    rule: [
      ["in", "bpm", 140, 185, 22],
      ["above", "kickPulse", 0.4, 0.3],
      ["above", "flat", 0.45, 0.25],
      ["above", "kIndus", 0.45, 0.3],
      ["below", "crest", 3.6, 2.6],
    ],
  },
  {
    id: "rawstyle",
    label: "Rawstyle",
    a: "hard",
    // Hardstyle's harder cousin: same grid, a rougher, more distorted kick.
    rule: [
      ["in", "bpm", 148, 163, 10],
      ["above", "kickPulse", 0.45, 0.3],
      ["in", "flat", 0.45, 0.72, 0.18],
      ["above", "kHard", 0.5, 0.3],
      ["below", "crest", 3.2, 2.4],
    ],
  },
  {
    id: "hardtechno",
    label: "Hard techno",
    a: "hard",
    // Looped, driving and harder than techno proper, without the hardstyle kick.
    rule: [
      ["in", "bpm", 138, 162, 12],
      ["above", "kickPulse", 0.55, 0.3],
      ["in", "flat", 0.3, 0.6, 0.2],
      ["max", "kHard", 1, "kIndus", 0.6],
      ["below", "crest", 4, 2.8],
    ],
  },
  {
    id: "rock",
    label: "Rock",
    a: "rock",
    // Guitars: a continuously loud, fairly noisy mid band, with a kick that is
    // played rather than gridded.
    rule: [
      ["in", "bpm", 95, 170, 35],
      ["above", "midRatio", 0.32, 0.25],
      ["in", "flat", 0.35, 0.68, 0.22],
      ["below", "kickPulse", 0.62, 0.3],
    ],
  },
  {
    id: "metal",
    label: "Metal",
    a: "rock",
    rule: [
      ["in", "bpm", 130, 220, 45],
      ["above", "midRatio", 0.34, 0.22],
      ["above", "flat", 0.5, 0.25],
      ["below", "crest", 4, 2.5],
      ["below", "kickPulse", 0.7, 0.3],
    ],
  },
  {
    id: "brutal",
    label: "Death / brutal",
    a: "rock",
    // Blast beats: very fast, wall-like, almost no dynamic range left.
    rule: [
      ["in", "bpm", 200, 300, 40],
      ["above", "flat", 0.58, 0.22],
      ["below", "crest", 3, 1.8],
      ["above", "midRatio", 0.3, 0.25],
    ],
  },
  // --- urbain / global ------------------------------------------------------
  {
    id: "rap",
    label: "Rap",
    a: "voice",
    // Words over a beat: the syllabic modulation is the tell, not the grid.
    rule: [
      ["in", "bpm", 80, 105, 18],
      ["above", "vocal", 0.32, 0.3],
      ["below", "flat", 0.45, 0.25],
      ["in", "centroid", 0.25, 0.6],
    ],
  },
  {
    id: "trap",
    label: "Trap",
    a: "groove",
    // Half-time 808: sparse kicks, a lot of sub, hats doing the motion.
    rule: [
      ["in", "bpm", 128, 152, 12],
      ["above", "subRatio", 0.3, 0.2],
      ["below", "kickPulse", 0.62, 0.3],
      ["above", "perc", 0.4, 0.3],
    ],
  },
  {
    id: "reggaeton",
    label: "Reggaeton",
    a: "groove",
    // Dembow: a steady mid-tempo grid with a heavy, round low end.
    rule: [
      ["in", "bpm", 86, 104, 10],
      ["above", "kickPulse", 0.45, 0.3],
      ["above", "subRatio", 0.22, 0.2],
      ["below", "flat", 0.5, 0.25],
    ],
  },
  {
    id: "afrohouse",
    label: "Afro house",
    a: "groove",
    // Percussive and organic: busy transients over a four-on-the-floor.
    rule: [
      ["in", "bpm", 116, 126, 8],
      ["above", "kickPulse", 0.5, 0.3],
      ["above", "perc", 0.5, 0.3],
      ["below", "flat", 0.45, 0.25],
    ],
  },
  {
    id: "amapiano",
    label: "Amapiano",
    a: "groove",
    // The log drum: sub-heavy, sparse and slow for a house grid.
    rule: [
      ["in", "bpm", 106, 120, 8],
      ["above", "subRatio", 0.28, 0.2],
      ["below", "kickPulse", 0.62, 0.3],
      ["below", "centroid", 0.55, 0.25],
    ],
  },
  {
    id: "garage",
    label: "UK garage",
    a: "groove",
    // Shuffled two-step: sub bass, busy percussion, off-grid hits.
    rule: [
      ["in", "bpm", 126, 140, 8],
      ["in", "kickPulse", 0.25, 0.65, 0.25],
      ["above", "subRatio", 0.24, 0.2],
      ["above", "perc", 0.5, 0.3],
    ],
  },
  {
    id: "breakbeat",
    label: "Breakbeat",
    a: "groove",
    // A broken beat under a steady tempo — the kick is not on every beat.
    rule: [
      ["in", "bpm", 125, 152, 10],
      ["in", "kickPulse", 0.25, 0.65, 0.25],
      ["above", "perc", 0.55, 0.3],
    ],
  },
  {
    id: "dancehall",
    label: "Dancehall",
    a: "groove",
    // Riddim: mid-tempo, sub-heavy, less strictly gridded than house.
    rule: [
      ["in", "bpm", 88, 112, 10],
      ["above", "kickPulse", 0.45, 0.3],
      ["above", "subRatio", 0.22, 0.2],
      ["below", "flat", 0.45, 0.25],
    ],
  },
  {
    id: "reggae",
    label: "Reggae",
    a: "groove",
    // The offbeat skank over a slow, deep one-drop.
    rule: [
      ["in", "bpm", 58, 92, 12],
      ["above", "subRatio", 0.24, 0.2],
      ["below", "flat", 0.45, 0.25],
      ["above", "perc", 0.4, 0.3],
    ],
  },
  // --- house / downtempo ----------------------------------------------------
  {
    id: "synthwave",
    label: "Synthwave",
    a: "groove",
    // Retro: a clean grid under warm, sustained analogue pads.
    rule: [
      ["in", "bpm", 98, 122, 10],
      ["above", "kickPulse", 0.4, 0.3],
      ["below", "flat", 0.42, 0.22],
      ["in", "centroid", 0.3, 0.65],
    ],
  },
  {
    id: "funk",
    label: "Funk",
    a: "groove",
    // Played and syncopated, bright and dry rather than distorted.
    rule: [
      ["in", "bpm", 95, 125, 12],
      ["above", "kickPulse", 0.4, 0.3],
      ["above", "perc", 0.55, 0.3],
      ["below", "flat", 0.45, 0.25],
    ],
  },
  {
    id: "lofi",
    label: "Lo-fi",
    a: "sustain",
    // Slow, soft and warm, with the top end rolled off.
    rule: [
      ["in", "bpm", 68, 98, 12],
      ["below", "kickPulse", 0.5, 0.3],
      ["below", "centroid", 0.5, 0.22],
      ["below", "perc", 0.5, 0.3],
    ],
  },
  // --- voix / racines -------------------------------------------------------
  {
    id: "pop",
    label: "Pop",
    a: "voice",
    // A sung hook, clean and bright, on a light grid.
    rule: [
      ["in", "bpm", 88, 132, 14],
      ["above", "vocal", 0.3, 0.3],
      ["below", "flat", 0.45, 0.25],
      ["in", "centroid", 0.3, 0.68],
    ],
  },
  {
    id: "soul",
    label: "Soul",
    a: "voice",
    // A warm, vocal, played mid-tempo with dynamics left in.
    rule: [
      ["in", "bpm", 58, 102, 16],
      ["above", "vocal", 0.3, 0.3],
      ["below", "flat", 0.45, 0.25],
      ["in", "centroid", 0.25, 0.6],
    ],
  },
  {
    id: "blues",
    label: "Blues",
    a: "voice",
    // Live instruments, real crest, a wide dynamic range.
    rule: [
      ["in", "bpm", 58, 122, 18],
      ["below", "flat", 0.45, 0.25],
      ["above", "crest", 2.8, 2.5],
      ["in", "centroid", 0.25, 0.6],
    ],
  },
  {
    id: "country",
    label: "Country",
    a: "voice",
    // Acoustic and sung, again with the dynamics a limiter would erase.
    rule: [
      ["in", "bpm", 78, 142, 20],
      ["above", "vocal", 0.25, 0.3],
      ["below", "flat", 0.45, 0.25],
      ["above", "crest", 2.8, 2.5],
    ],
  },
  {
    id: "folk",
    label: "Folk",
    a: "voice",
    // Sparse and acoustic: tonal, quiet transients, no machine pulse.
    rule: [
      ["in", "bpm", 78, 132, 18],
      ["below", "flat", 0.4, 0.22],
      ["below", "perc", 0.45, 0.3],
      ["above", "crest", 3, 2.5],
    ],
  },
  // --- rock ----------------------------------------------------------------
  {
    id: "punk",
    label: "Punk",
    a: "rock",
    // Fast, raw and loud, but played rather than programmed.
    rule: [
      ["in", "bpm", 140, 205, 20],
      ["above", "flat", 0.42, 0.22],
      ["above", "midRatio", 0.3, 0.25],
      ["below", "kickPulse", 0.65, 0.3],
    ],
  },
  {
    id: "indie",
    label: "Indie",
    a: "rock",
    // Guitars and a live kit, less saturated than metal or hard rock.
    rule: [
      ["in", "bpm", 98, 152, 18],
      ["in", "flat", 0.32, 0.62, 0.2],
      ["above", "midRatio", 0.28, 0.25],
      ["below", "kickPulse", 0.6, 0.3],
    ],
  },
  {
    id: "hardrock",
    label: "Hard rock",
    a: "rock",
    // Distorted guitars and a real drum kit, short of metal's wall.
    rule: [
      ["in", "bpm", 98, 152, 18],
      ["above", "flat", 0.42, 0.22],
      ["above", "midRatio", 0.32, 0.25],
      ["below", "kickPulse", 0.62, 0.3],
    ],
  },
  // --- scène / party --------------------------------------------------------
  {
    id: "phonk",
    label: "Phonk",
    a: "groove",
    // Memphis 808: a cowbell hook over a distorted, sub-heavy half-time beat.
    rule: [
      ["in", "bpm", 128, 168, 14],
      ["below", "kickPulse", 0.72, 0.3],
      ["above", "subRatio", 0.3, 0.2],
      ["below", "crest", 3.6, 2.5],
      ["above", "perc", 0.4, 0.3],
    ],
  },
  {
    id: "hardpingpong",
    label: "Hard pingpong",
    a: "hard",
    // Hardtek ping-pong: a kick on the beat, a saw bass between them, busy.
    rule: [
      ["in", "bpm", 155, 200, 18],
      ["above", "kickPulse", 0.5, 0.3],
      ["above", "flat", 0.4, 0.22],
      ["above", "perc", 0.55, 0.3],
      ["max", "kHard", 1, "kIndus", 0.7],
    ],
  },
  {
    id: "germanparty",
    label: "German party",
    a: "hard",
    // Party hardtekk with chanted German vocals over a hard kick.
    rule: [
      ["in", "bpm", 148, 185, 16],
      ["above", "kickPulse", 0.45, 0.3],
      ["in", "flat", 0.38, 0.68, 0.2],
      ["above", "vocal", 0.28, 0.3],
      ["max", "kHard", 1, "kIndus", 0.7],
    ],
  },
  {
    id: "electronic",
    label: "Électronique",
    a: "groove",
    // The catch-all for "clearly machine-made, clearly rhythmic, nothing more
    // specific fits". Weak on purpose: it should only ever win by default.
    rule: [
      ["k", 0.28],
      ["above", "pulse", 0.3, 0.4],
      ["above", "perc", 0.25, 0.3],
    ],
  },
];

const FAMILY_BY_ID = new Map(FAMILIES.map((f) => [f.id, f]));
const FAMILY_LOOK = new Map(FAMILIES.map((f) => [f.id, lookFor(f)]));
export const FAMILY_LIST = FAMILIES.map(({ id, label, a }) => ({ id, label, archetype: a }));

/**
 * What one named family looks like, for a verdict that arrives already decided.
 *
 * The server measures the whole track and serves a family NAME; the renderer
 * needs seven numbers. Without this the served verdict replaced the live one
 * and took the look vector with it — so the moment a track had been analysed,
 * every scene fell back to the neutral default and the genre-specific layers
 * switched off. Exactly backwards: knowing the genre for certain is when the
 * look should be most confident.
 */
export function familyLook(id) {
  return FAMILY_LOOK.get(id) || null;
}

/**
 * The tempo range a genre is actually written in, as [lo, hi] BPM.
 *
 * THIS IS THE ANSWER TO THE OCTAVE PROBLEM, and there is no other one. An
 * autocorrelation cannot tell 250 BPM uptempo from 125 BPM house: the two
 * produce the same peaks, at the same lags, in the same proportions, and every
 * beat tracker ever written gets this wrong without outside help. What decides
 * it is knowing which record is playing — the published work on tempo octave
 * errors in electronic music says exactly that, and this table is that
 * knowledge, written down.
 *
 * The figures are the genres' own, from how the music is made rather than from
 * what a detector happens to like: frenchcore is 180-210 and a producer writing
 * it puts a kick on every quarter note; uptempo runs 180-220 and its terror
 * lane pushes past that; hardtekk is 150-170; hardstyle and rawstyle sit at
 * 150-160; drum & bass is 160-180 with the half-time feel on top of it.
 *
 * Ranges are deliberately WIDE — they set a plateau, not a target, and the
 * music still decides inside them. What they are for is making the octave
 * either side implausible, which is all the tracker needs.
 *
 * MAINTAINING THIS: add a row when a family is added to FAMILIES above, or when
 * a served genre name turns out to be read often and to sit outside its
 * family's range. A missing row is not a bug — the tracker falls back to the
 * default plateau, which is what it always used to have.
 */
const TEMPO_BANDS = {
  // --- the hard end, which is the whole reason this table exists -------------
  frenchcore: [170, 230],
  uptempo: [170, 260],
  speedcore: [200, 300],
  krach: [170, 260],
  hardcore: [160, 250],
  tribecore: [170, 230],
  gabber: [160, 230],
  terrorcore: [190, 280],
  extratone: [220, 300],
  zaag: [140, 200],
  hardstyle: [140, 165],
  rawstyle: [145, 170],
  hardtekk: [140, 180],
  hardpingpong: [140, 185],
  germanparty: [140, 180],
  pieep: [150, 200],
  hardtechno: [140, 175],
  industrial: [130, 200],
  // --- everything else ------------------------------------------------------
  techno: [120, 150],
  house: [118, 132],
  afrohouse: [115, 128],
  amapiano: [108, 118],
  disco: [110, 130],
  dance: [120, 135],
  trance: [130, 145],
  psytrance: [138, 150],
  dnb: [160, 180],
  breakbeat: [125, 160],
  garage: [125, 140],
  dubstep: [135, 150],
  synthwave: [95, 125],
  electronic: [100, 150],
  hiphop: [80, 105],
  rap: [80, 105],
  trap: [130, 160],
  phonk: [130, 160],
  reggaeton: [88, 102],
  dancehall: [90, 110],
  reggae: [65, 95],
  rock: [100, 160],
  hardrock: [110, 165],
  punk: [150, 200],
  metal: [120, 200],
  brutal: [150, 250],
  funk: [95, 120],
  soul: [70, 110],
  rnb: [60, 100],
  blues: [60, 120],
  jazz: [80, 200],
  country: [80, 140],
  folk: [70, 130],
  pop: [90, 130],
  vocalPop: [84, 138],
  indie: [90, 140],
  lofi: [70, 95],
  ambient: [60, 120],
  strings: [50, 160],
};

/**
 * Look a genre name up in the table above, tolerating whatever shape it
 * arrives in: a family id from the live classifier, a served genre, a
 * hand-typed tag with spaces, accents or hyphens.
 *
 * Returns null when nothing matches, which means "use the default plateau" —
 * never a guess, because a wrong range is worse than no range.
 */
export function tempoRangeFor(name) {
  if (!name) return null;
  const raw = String(name);
  if (TEMPO_BANDS[raw]) return TEMPO_BANDS[raw];
  const flatten = (v) =>
    v
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  const id = flatten(raw);
  const direct = TEMPO_BANDS[id] || TEMPO_BANDS[TEMPO_ALIASES[id]];
  if (direct) return direct;
  // A compound name puts the SPECIFIC genre first and its family after it —
  // "uptempo hardcore", "raw hardstyle", "melodic dubstep", "tech house" — so
  // the first word that names something wins. Taking the longest match instead
  // reads "uptempo hardcore" as hardcore, which is a different record.
  for (const word of raw.split(/[^\p{L}\p{N}]+/u)) {
    const w = flatten(word);
    if (!w) continue;
    const hit = TEMPO_BANDS[w] || TEMPO_BANDS[TEMPO_ALIASES[w]];
    if (hit) return hit;
  }
  // Last resort, for a name written without separators. Longest match, so
  // "hardtechno" is not read as "techno".
  let best = null;
  let bestLen = 0;
  for (const key of Object.keys(TEMPO_BANDS))
    if (key.length > bestLen && id.includes(key)) {
      best = TEMPO_BANDS[key];
      bestLen = key.length;
    }
  return best;
}

// Names that are read often and are spelled nothing like their family.
const TEMPO_ALIASES = {
  drumandbass: "dnb",
  drumnbass: "dnb",
  drumbass: "dnb",
  jungle: "dnb",
  liquid: "dnb",
  neurofunk: "dnb",
  jumpup: "dnb",
  happyhardcore: "hardcore",
  ukhardcore: "hardcore",
  hardcoretechno: "hardcore",
  makina: "hardcore",
  hardtek: "tribecore",
  tribe: "tribecore",
  raggatek: "tribecore",
  acidcore: "tribecore",
  tekk: "hardtekk",
  tekno: "hardtekk",
  schranz: "hardtechno",
  hardgroove: "hardtechno",
  splittercore: "extratone",
  flashcore: "speedcore",
  frenchtek: "frenchcore",
  rawphase: "rawstyle",
  xtraraw: "rawstyle",
  euphoric: "hardstyle",
  dubtechno: "techno",
  minimal: "techno",
  deephouse: "house",
  techhouse: "house",
  progressivehouse: "house",
  bigroom: "dance",
  hardance: "dance",
  eurodance: "dance",
  hyperpop: "dance",
  future: "dance",
  riddim: "dubstep",
  brostep: "dubstep",
  grime: "garage",
  ukgarage: "garage",
  jerseyclub: "garage",
  footwork: "breakbeat",
  breakcore: "breakbeat",
  bassline: "garage",
  boombap: "hiphop",
  drill: "trap",
  cloudrap: "trap",
  afrobeat: "afrohouse",
  afrobeats: "afrohouse",
  salsa: "funk",
  samba: "funk",
  ska: "reggae",
  dub: "reggae",
  triphop: "lofi",
  downtempo: "lofi",
  chillout: "ambient",
  drone: "ambient",
  shoegaze: "ambient",
  vaporwave: "lofi",
  citypop: "pop",
  synthpop: "synthwave",
  italodisco: "disco",
  orchestral: "strings",
  classical: "strings",
  choral: "strings",
  opera: "strings",
  filmscore: "strings",
  gospel: "soul",
  chiptune: "dance",
  idm: "breakbeat",
  glitch: "breakbeat",
  deathmetal: "brutal",
  blackmetal: "brutal",
  doom: "metal",
  thrash: "metal",
  hardrockband: "hardrock",
};

// --- the rules, as data -------------------------------------------------------
//
// Every family above is a PRODUCT of fuzzy memberships over the frame's
// descriptors, written as data rather than as a function so the same table can
// be handed to the analyser that actually runs it (webapp/rhythm/src/style.rs,
// on the audio thread) and still be read and edited here. The terms:
//
//   ["in", x, lo, hi, w?]   trapezoid, soft shoulders w wide (default 45% of the span)
//   ["above", x, t, w]      0 below t, 1 at t + w
//   ["below", x, t, w]      1 at t - w, 0 at t
//   ["raw", x]              the descriptor itself (the kick-shape scores)
//   ["max", x, kx, y, ky]   max(x * kx, y * ky)
//   ["k", c]                a constant
//
// The descriptor names, in the order the analyser stores them.
export const RULE_FEATURES = [
  "bpm", "pulse", "kickPulse", "flat", "centroid", "perc", "vocal", "crest", "level",
  "subRatio", "midRatio", "airRatio", "kSoft", "kHard", "kIndus", "melody", "tonalness",
  "chord", "dyn",
];
const FEATURE_INDEX = new Map(RULE_FEATURES.map((k, i) => [k, i]));
const OPS = { k: 0, in: 1, above: 2, below: 3, raw: 4, max: 5 };
// The two families that do not need a tempo to be judged: everything else is
// damped while the beat grid is not locked.
const TEMPO_FREE = new Set(["ambient", "strings"]);

/** One family's raw weight for a descriptor object — the reference the
 * analyser's evaluator is tested against. */
export function ruleWeight(rule, s) {
  let w = 1;
  for (const t of rule) {
    const [op, x] = t;
    const v = s[x];
    switch (op) {
      case "in":
        w *= t[4] == null ? inRange(v, t[2], t[3]) : inRange(v, t[2], t[3], t[4]);
        break;
      case "above":
        w *= above(v, t[2], t[3]);
        break;
      case "below":
        w *= below(v, t[2], t[3]);
        break;
      case "raw":
        w *= v;
        break;
      case "max":
        w *= Math.max(v * t[2], s[t[3]] * t[4]);
        break;
      case "k":
        w *= t[1];
        break;
      default:
        break;
    }
  }
  return Math.max(0, w);
}

/**
 * The whole vocabulary, flattened for the analyser (style.rs#load_families):
 * [count, then per family: archetype, tempoFree, look x7, rangeLo, rangeHi,
 *  nTerms, then per term: op, a, b, p1, p2, p3].
 */
export function familyTable() {
  const out = [FAMILIES.length];
  for (const f of FAMILIES) {
    out.push(Math.max(0, ARCHETYPES.indexOf(f.a)), TEMPO_FREE.has(f.id) ? 1 : 0);
    const look = FAMILY_LOOK.get(f.id);
    for (const k of LOOK_KEYS) out.push(look[k]);
    const range = TEMPO_BANDS[f.id] || [0, 0];
    out.push(range[0], range[1], f.rule.length);
    for (const t of f.rule) {
      const op = OPS[t[0]];
      if (op == null) throw new Error(`unknown rule op ${t[0]} in ${f.id}`);
      if (t[0] === "k") {
        out.push(op, 0, 0, t[1], 0, 0);
        continue;
      }
      const a = FEATURE_INDEX.get(t[1]);
      if (a == null) throw new Error(`unknown descriptor ${t[1]} in ${f.id}`);
      if (t[0] === "max") {
        const b = FEATURE_INDEX.get(t[3]);
        if (b == null) throw new Error(`unknown descriptor ${t[3]} in ${f.id}`);
        out.push(op, a, b, t[2], t[4], 0);
      } else if (t[0] === "raw") {
        out.push(op, a, 0, 1, 0, 0);
      } else if (t[0] === "in") {
        out.push(op, a, 0, t[2], t[3], t[4] ?? 0);
      } else {
        out.push(op, a, 0, t[2], t[3], 0);
      }
    }
  }
  return new Float32Array(out);
}

/** The family behind an index the analyser reports, or null. */
export function familyAt(index) {
  return index >= 0 && index < FAMILIES.length ? FAMILY_LIST[index] : null;
}

// The kick types the analyser names (style.rs `KickShape.kind`), in order.
export const KICK_TYPES = ["soft", "hard", "industrial"];
