// What kind of music is this, and what is its kick made of?
//
// This is deliberately a HEURISTIC classifier, not a model. It has to run on a
// phone, inside the same frame budget as the rendering, with no download and no
// warm-up, and its output drives an animation — so being roughly right within a
// couple of seconds and never flickering matters far more than being exactly
// right eventually. Every axis it uses is one of the descriptors features.js
// and tempo.js already produce for other reasons, so the classifier itself is
// essentially free.
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
  frenchcore: { motion: 0.94, density: 0.82, punch: 0.98, warm: 0.86, chaos: 0.55, melodic: 0.2 },
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
    w: (s) =>
      below(s.pulse, 0.35, 0.35) *
      below(s.perc, 0.3, 0.3) *
      below(s.flat, 0.45, 0.35) *
      below(s.level, 0.72, 0.4),
  },
  {
    id: "strings",
    label: "Cordes / classique",
    a: "sustain",
    // Very tonal, very sustained, real dynamic range (high crest — nothing has
    // been squashed by a limiter), and no machine pulse.
    w: (s) =>
      below(s.flat, 0.3, 0.25) *
      below(s.perc, 0.35, 0.3) *
      below(s.kickPulse, 0.35, 0.35) *
      above(s.crest, 3.2, 4) *
      inRange(s.centroid, 0.2, 0.55),
  },
  {
    id: "jazz",
    label: "Jazz / acoustique",
    a: "voice",
    w: (s) =>
      inRange(s.bpm, 80, 165, 45) *
      below(s.flat, 0.5, 0.3) *
      below(s.kickPulse, 0.55, 0.3) *
      above(s.crest, 2.6, 3) *
      inRange(s.centroid, 0.25, 0.6),
  },
  {
    id: "vocalPop",
    label: "Pop / chanson",
    a: "voice",
    // The syllabic-rate modulation is the whole tell here.
    w: (s) =>
      above(s.vocal, 0.28, 0.35) *
      inRange(s.bpm, 84, 138, 32) *
      below(s.flat, 0.55, 0.3) *
      inRange(s.centroid, 0.25, 0.65),
  },
  {
    id: "rnb",
    label: "R&B / soul",
    a: "voice",
    w: (s) =>
      above(s.vocal, 0.3, 0.35) *
      inRange(s.bpm, 60, 100, 25) *
      above(s.subRatio, 0.16, 0.2) *
      below(s.flat, 0.5, 0.3),
  },
  {
    id: "hiphop",
    label: "Hip-hop",
    a: "groove",
    w: (s) =>
      inRange(s.bpm, 70, 105, 22) *
      above(s.subRatio, 0.2, 0.2) *
      above(s.vocal, 0.2, 0.4) *
      below(s.kickPulse, 0.8, 0.4),
  },
  {
    id: "house",
    label: "House",
    a: "groove",
    w: (s) =>
      inRange(s.bpm, 116, 128, 12) *
      above(s.kickPulse, 0.45, 0.35) *
      s.kSoft *
      below(s.flat, 0.55, 0.3),
  },
  {
    id: "techno",
    label: "Techno",
    a: "groove",
    w: (s) =>
      inRange(s.bpm, 125, 150, 16) *
      above(s.kickPulse, 0.5, 0.3) *
      below(s.vocal, 0.45, 0.4) *
      Math.max(s.kSoft, s.kHard * 0.8),
  },
  {
    id: "trance",
    label: "Trance",
    a: "groove",
    w: (s) =>
      inRange(s.bpm, 132, 145, 12) *
      above(s.kickPulse, 0.45, 0.35) *
      below(s.flat, 0.5, 0.3) *
      above(s.airRatio, 0.1, 0.18),
  },
  {
    id: "dance",
    label: "Dance / EDM",
    a: "groove",
    // Mainstage: a clean four-on-the-floor kick under bright leads and hats.
    w: (s) =>
      inRange(s.bpm, 118, 136, 10) *
      above(s.kickPulse, 0.5, 0.3) *
      above(s.airRatio, 0.1, 0.18) *
      below(s.flat, 0.55, 0.3) *
      s.kSoft,
  },
  {
    id: "dnb",
    label: "Drum & bass",
    a: "groove",
    // Breakbeats: a steady tempo but a syncopated kick, and a lot of sub.
    w: (s) =>
      inRange(s.bpm, 160, 182, 10) *
      inRange(s.kickPulse, 0.2, 0.65, 0.25) *
      above(s.subRatio, 0.2, 0.2) *
      above(s.perc, 0.5, 0.3),
  },
  {
    id: "dubstep",
    label: "Dubstep",
    a: "groove",
    // Half-time and sparse: the kick is rare and the sub carries the drop.
    w: (s) =>
      inRange(s.bpm, 136, 148, 8) *
      below(s.kickPulse, 0.55, 0.3) *
      above(s.subRatio, 0.28, 0.2) *
      below(s.centroid, 0.55, 0.25),
  },
  {
    id: "disco",
    label: "Disco / funk",
    a: "groove",
    // Played, not programmed: four-on-the-floor with real dynamics left in it.
    w: (s) =>
      inRange(s.bpm, 106, 124, 10) *
      above(s.kickPulse, 0.45, 0.3) *
      below(s.flat, 0.45, 0.25) *
      above(s.crest, 2.6, 2.5) *
      inRange(s.centroid, 0.25, 0.6),
  },
  {
    id: "psytrance",
    label: "Psytrance",
    a: "groove",
    // A rolling bassline on a fast grid, bright and clean.
    w: (s) =>
      inRange(s.bpm, 138, 152, 10) *
      above(s.kickPulse, 0.55, 0.3) *
      inRange(s.flat, 0.25, 0.55, 0.2) *
      above(s.airRatio, 0.12, 0.18),
  },
  {
    id: "hardstyle",
    label: "Hardstyle",
    a: "hard",
    w: (s) =>
      inRange(s.bpm, 145, 162, 12) * above(s.kickPulse, 0.45, 0.3) * s.kHard,
  },
  {
    id: "hardtekk",
    label: "Hardtekk",
    a: "hard",
    // German hardtekk: hard kick, offbeat bass, a shade under hardstyle tempo
    // and considerably more raw in the mids.
    w: (s) =>
      inRange(s.bpm, 138, 165, 14) *
      above(s.kickPulse, 0.45, 0.3) *
      s.kHard *
      above(s.flat, 0.3, 0.3),
  },
  {
    id: "zaag",
    label: "Zaag",
    a: "hard",
    // "Saw": a harmonically dense, gliding lead carrying the tune rather than a
    // pad — lots of mid/high content that is rich but not pure noise.
    w: (s) =>
      inRange(s.bpm, 150, 210, 28) *
      inRange(s.flat, 0.34, 0.62, 0.22) *
      above(s.midRatio, 0.3, 0.25) *
      Math.max(s.kHard, s.kIndus * 0.7),
  },
  {
    id: "frenchcore",
    label: "Frenchcore",
    a: "hard",
    w: (s) =>
      inRange(s.bpm, 185, 230, 25) *
      above(s.kickPulse, 0.4, 0.3) *
      above(s.flat, 0.4, 0.3) *
      Math.max(s.kHard * 0.8, s.kIndus),
  },
  {
    id: "uptempo",
    label: "Uptempo",
    a: "hard",
    // A lower bar on kickPulse than the other gridded families, deliberately:
    // at 280 BPM a beat is 210 ms and the onset grid only has twenty slots to
    // describe it, so the grid measurement is at the limit of its own
    // resolution up here. The tempo itself is already most of the evidence.
    w: (s) =>
      inRange(s.bpm, 220, 300, 35) *
      above(s.kickPulse, 0.22, 0.3) *
      above(s.flat, 0.45, 0.3) *
      s.kIndus,
  },
  {
    id: "krach",
    label: "Deutscher Krach",
    a: "hard",
    // Extreme, loud, and deliberately ugly: barely any crest left, the spectrum
    // nearly flat, and a kick that is mostly distortion.
    w: (s) =>
      inRange(s.bpm, 190, 300, 45) *
      above(s.flat, 0.55, 0.25) *
      below(s.crest, 3.2, 2) *
      s.kIndus,
  },
  {
    id: "pieep",
    label: "Pieep",
    a: "hard",
    // Squeaky, very high-register tonal leads over a fast kick.
    w: (s) =>
      inRange(s.bpm, 170, 260, 40) *
      above(s.airRatio, 0.2, 0.18) *
      above(s.centroid, 0.62, 0.2) *
      below(s.flat, 0.55, 0.3),
  },
  {
    id: "hardcore",
    label: "Hardcore",
    a: "hard",
    // Mainstream hardcore: a distorted kick on every beat, squashed flat.
    w: (s) =>
      inRange(s.bpm, 148, 195, 18) *
      above(s.kickPulse, 0.45, 0.3) *
      inRange(s.flat, 0.4, 0.75, 0.2) *
      Math.max(s.kHard, s.kIndus * 0.8),
  },
  {
    id: "tribecore",
    label: "Tribe",
    a: "hard",
    // Tribe: percussive and mid-heavy rather than one wall of noise.
    w: (s) =>
      inRange(s.bpm, 150, 190, 20) *
      above(s.kickPulse, 0.45, 0.3) *
      inRange(s.flat, 0.32, 0.62, 0.2) *
      above(s.perc, 0.5, 0.3) *
      above(s.midRatio, 0.3, 0.25) *
      Math.max(s.kHard, s.kIndus * 0.7),
  },
  {
    id: "speedcore",
    label: "Speedcore",
    a: "hard",
    // Past 250 BPM the grid is at its limit; only the noise is left.
    w: (s) =>
      inRange(s.bpm, 245, 300, 22) *
      above(s.flat, 0.5, 0.22) *
      above(s.kIndus, 0.4, 0.3) *
      below(s.crest, 3.5, 2.5),
  },
  {
    id: "industrial",
    label: "Indus",
    a: "hard",
    // A metallic, noisy kick is the whole tell.
    w: (s) =>
      inRange(s.bpm, 140, 185, 22) *
      above(s.kickPulse, 0.4, 0.3) *
      above(s.flat, 0.45, 0.25) *
      above(s.kIndus, 0.45, 0.3) *
      below(s.crest, 3.6, 2.6),
  },
  {
    id: "rawstyle",
    label: "Rawstyle",
    a: "hard",
    // Hardstyle's harder cousin: same grid, a rougher, more distorted kick.
    w: (s) =>
      inRange(s.bpm, 148, 163, 10) *
      above(s.kickPulse, 0.45, 0.3) *
      inRange(s.flat, 0.45, 0.72, 0.18) *
      above(s.kHard, 0.5, 0.3) *
      below(s.crest, 3.2, 2.4),
  },
  {
    id: "hardtechno",
    label: "Hard techno",
    a: "hard",
    // Looped, driving and harder than techno proper, without the hardstyle kick.
    w: (s) =>
      inRange(s.bpm, 138, 162, 12) *
      above(s.kickPulse, 0.55, 0.3) *
      inRange(s.flat, 0.3, 0.6, 0.2) *
      Math.max(s.kHard, s.kIndus * 0.6) *
      below(s.crest, 4, 2.8),
  },
  {
    id: "rock",
    label: "Rock",
    a: "rock",
    // Guitars: a continuously loud, fairly noisy mid band, with a kick that is
    // played rather than gridded.
    w: (s) =>
      inRange(s.bpm, 95, 170, 35) *
      above(s.midRatio, 0.32, 0.25) *
      inRange(s.flat, 0.35, 0.68, 0.22) *
      below(s.kickPulse, 0.62, 0.3),
  },
  {
    id: "metal",
    label: "Metal",
    a: "rock",
    w: (s) =>
      inRange(s.bpm, 130, 220, 45) *
      above(s.midRatio, 0.34, 0.22) *
      above(s.flat, 0.5, 0.25) *
      below(s.crest, 4, 2.5) *
      below(s.kickPulse, 0.7, 0.3),
  },
  {
    id: "brutal",
    label: "Death / brutal",
    a: "rock",
    // Blast beats: very fast, wall-like, almost no dynamic range left.
    w: (s) =>
      inRange(s.bpm, 200, 300, 40) *
      above(s.flat, 0.58, 0.22) *
      below(s.crest, 3, 1.8) *
      above(s.midRatio, 0.3, 0.25),
  },
  // --- urbain / global ------------------------------------------------------
  {
    id: "rap",
    label: "Rap",
    a: "voice",
    // Words over a beat: the syllabic modulation is the tell, not the grid.
    w: (s) =>
      inRange(s.bpm, 80, 105, 18) *
      above(s.vocal, 0.32, 0.3) *
      below(s.flat, 0.45, 0.25) *
      inRange(s.centroid, 0.25, 0.6),
  },
  {
    id: "trap",
    label: "Trap",
    a: "groove",
    // Half-time 808: sparse kicks, a lot of sub, hats doing the motion.
    w: (s) =>
      inRange(s.bpm, 128, 152, 12) *
      above(s.subRatio, 0.3, 0.2) *
      below(s.kickPulse, 0.62, 0.3) *
      above(s.perc, 0.4, 0.3),
  },
  {
    id: "reggaeton",
    label: "Reggaeton",
    a: "groove",
    // Dembow: a steady mid-tempo grid with a heavy, round low end.
    w: (s) =>
      inRange(s.bpm, 86, 104, 10) *
      above(s.kickPulse, 0.45, 0.3) *
      above(s.subRatio, 0.22, 0.2) *
      below(s.flat, 0.5, 0.25),
  },
  {
    id: "afrohouse",
    label: "Afro house",
    a: "groove",
    // Percussive and organic: busy transients over a four-on-the-floor.
    w: (s) =>
      inRange(s.bpm, 116, 126, 8) *
      above(s.kickPulse, 0.5, 0.3) *
      above(s.perc, 0.5, 0.3) *
      below(s.flat, 0.45, 0.25),
  },
  {
    id: "amapiano",
    label: "Amapiano",
    a: "groove",
    // The log drum: sub-heavy, sparse and slow for a house grid.
    w: (s) =>
      inRange(s.bpm, 106, 120, 8) *
      above(s.subRatio, 0.28, 0.2) *
      below(s.kickPulse, 0.62, 0.3) *
      below(s.centroid, 0.55, 0.25),
  },
  {
    id: "garage",
    label: "UK garage",
    a: "groove",
    // Shuffled two-step: sub bass, busy percussion, off-grid hits.
    w: (s) =>
      inRange(s.bpm, 126, 140, 8) *
      inRange(s.kickPulse, 0.25, 0.65, 0.25) *
      above(s.subRatio, 0.24, 0.2) *
      above(s.perc, 0.5, 0.3),
  },
  {
    id: "breakbeat",
    label: "Breakbeat",
    a: "groove",
    // A broken beat under a steady tempo — the kick is not on every beat.
    w: (s) =>
      inRange(s.bpm, 125, 152, 10) *
      inRange(s.kickPulse, 0.25, 0.65, 0.25) *
      above(s.perc, 0.55, 0.3),
  },
  {
    id: "dancehall",
    label: "Dancehall",
    a: "groove",
    // Riddim: mid-tempo, sub-heavy, less strictly gridded than house.
    w: (s) =>
      inRange(s.bpm, 88, 112, 10) *
      above(s.kickPulse, 0.45, 0.3) *
      above(s.subRatio, 0.22, 0.2) *
      below(s.flat, 0.45, 0.25),
  },
  {
    id: "reggae",
    label: "Reggae",
    a: "groove",
    // The offbeat skank over a slow, deep one-drop.
    w: (s) =>
      inRange(s.bpm, 58, 92, 12) *
      above(s.subRatio, 0.24, 0.2) *
      below(s.flat, 0.45, 0.25) *
      above(s.perc, 0.4, 0.3),
  },
  // --- house / downtempo ----------------------------------------------------
  {
    id: "synthwave",
    label: "Synthwave",
    a: "groove",
    // Retro: a clean grid under warm, sustained analogue pads.
    w: (s) =>
      inRange(s.bpm, 98, 122, 10) *
      above(s.kickPulse, 0.4, 0.3) *
      below(s.flat, 0.42, 0.22) *
      inRange(s.centroid, 0.3, 0.65),
  },
  {
    id: "funk",
    label: "Funk",
    a: "groove",
    // Played and syncopated, bright and dry rather than distorted.
    w: (s) =>
      inRange(s.bpm, 95, 125, 12) *
      above(s.kickPulse, 0.4, 0.3) *
      above(s.perc, 0.55, 0.3) *
      below(s.flat, 0.45, 0.25),
  },
  {
    id: "lofi",
    label: "Lo-fi",
    a: "sustain",
    // Slow, soft and warm, with the top end rolled off.
    w: (s) =>
      inRange(s.bpm, 68, 98, 12) *
      below(s.kickPulse, 0.5, 0.3) *
      below(s.centroid, 0.5, 0.22) *
      below(s.perc, 0.5, 0.3),
  },
  // --- voix / racines -------------------------------------------------------
  {
    id: "pop",
    label: "Pop",
    a: "voice",
    // A sung hook, clean and bright, on a light grid.
    w: (s) =>
      inRange(s.bpm, 88, 132, 14) *
      above(s.vocal, 0.3, 0.3) *
      below(s.flat, 0.45, 0.25) *
      inRange(s.centroid, 0.3, 0.68),
  },
  {
    id: "soul",
    label: "Soul",
    a: "voice",
    // A warm, vocal, played mid-tempo with dynamics left in.
    w: (s) =>
      inRange(s.bpm, 58, 102, 16) *
      above(s.vocal, 0.3, 0.3) *
      below(s.flat, 0.45, 0.25) *
      inRange(s.centroid, 0.25, 0.6),
  },
  {
    id: "blues",
    label: "Blues",
    a: "voice",
    // Live instruments, real crest, a wide dynamic range.
    w: (s) =>
      inRange(s.bpm, 58, 122, 18) *
      below(s.flat, 0.45, 0.25) *
      above(s.crest, 2.8, 2.5) *
      inRange(s.centroid, 0.25, 0.6),
  },
  {
    id: "country",
    label: "Country",
    a: "voice",
    // Acoustic and sung, again with the dynamics a limiter would erase.
    w: (s) =>
      inRange(s.bpm, 78, 142, 20) *
      above(s.vocal, 0.25, 0.3) *
      below(s.flat, 0.45, 0.25) *
      above(s.crest, 2.8, 2.5),
  },
  {
    id: "folk",
    label: "Folk",
    a: "voice",
    // Sparse and acoustic: tonal, quiet transients, no machine pulse.
    w: (s) =>
      inRange(s.bpm, 78, 132, 18) *
      below(s.flat, 0.4, 0.22) *
      below(s.perc, 0.45, 0.3) *
      above(s.crest, 3, 2.5),
  },
  // --- rock ----------------------------------------------------------------
  {
    id: "punk",
    label: "Punk",
    a: "rock",
    // Fast, raw and loud, but played rather than programmed.
    w: (s) =>
      inRange(s.bpm, 140, 205, 20) *
      above(s.flat, 0.42, 0.22) *
      above(s.midRatio, 0.3, 0.25) *
      below(s.kickPulse, 0.65, 0.3),
  },
  {
    id: "indie",
    label: "Indie",
    a: "rock",
    // Guitars and a live kit, less saturated than metal or hard rock.
    w: (s) =>
      inRange(s.bpm, 98, 152, 18) *
      inRange(s.flat, 0.32, 0.62, 0.2) *
      above(s.midRatio, 0.28, 0.25) *
      below(s.kickPulse, 0.6, 0.3),
  },
  {
    id: "hardrock",
    label: "Hard rock",
    a: "rock",
    // Distorted guitars and a real drum kit, short of metal's wall.
    w: (s) =>
      inRange(s.bpm, 98, 152, 18) *
      above(s.flat, 0.42, 0.22) *
      above(s.midRatio, 0.32, 0.25) *
      below(s.kickPulse, 0.62, 0.3),
  },
  // --- scène / party --------------------------------------------------------
  {
    id: "phonk",
    label: "Phonk",
    a: "groove",
    // Memphis 808: a cowbell hook over a distorted, sub-heavy half-time beat.
    w: (s) =>
      inRange(s.bpm, 128, 168, 14) *
      below(s.kickPulse, 0.72, 0.3) *
      above(s.subRatio, 0.3, 0.2) *
      below(s.crest, 3.6, 2.5) *
      above(s.perc, 0.4, 0.3),
  },
  {
    id: "hardpingpong",
    label: "Hard pingpong",
    a: "hard",
    // Hardtek ping-pong: a kick on the beat, a saw bass between them, busy.
    w: (s) =>
      inRange(s.bpm, 155, 200, 18) *
      above(s.kickPulse, 0.5, 0.3) *
      above(s.flat, 0.4, 0.22) *
      above(s.perc, 0.55, 0.3) *
      Math.max(s.kHard, s.kIndus * 0.7),
  },
  {
    id: "germanparty",
    label: "German party",
    a: "hard",
    // Party hardtekk with chanted German vocals over a hard kick.
    w: (s) =>
      inRange(s.bpm, 148, 185, 16) *
      above(s.kickPulse, 0.45, 0.3) *
      inRange(s.flat, 0.38, 0.68, 0.2) *
      above(s.vocal, 0.28, 0.3) *
      Math.max(s.kHard, s.kIndus * 0.7),
  },
  {
    id: "electronic",
    label: "Électronique",
    a: "groove",
    // The catch-all for "clearly machine-made, clearly rhythmic, nothing more
    // specific fits". Weak on purpose: it should only ever win by default.
    w: (s) => 0.28 * above(s.pulse, 0.3, 0.4) * above(s.perc, 0.25, 0.3),
  },
];

const FAMILY_BY_ID = new Map(FAMILIES.map((f) => [f.id, f]));
const FAMILY_LOOK = new Map(FAMILIES.map((f) => [f.id, lookFor(f)]));
export const FAMILY_LIST = FAMILIES.map(({ id, label, a }) => ({ id, label, archetype: a }));

// --- the kick ---------------------------------------------------------------
// A kick is classified from its SHAPE, not its level: how fast it arrives, how
// much broadband click rides on top of it, how noisy it is, and how long it
// rings. Those four separate a house kick from a hardstyle one from an
// industrial one far more reliably than any single amplitude reading.
const KICK_TYPES = ["soft", "hard", "industrial"];

function createKickAnalyser() {
  let capturing = false;
  let t0 = 0;
  let peakLow = 0;
  let peakAt = 0;
  let peakHigh = 0;
  let flatSum = 0;
  let flatN = 0;
  let decayAt = 0;
  let lastKickAt = -1;
  let fluxAvg = 0;
  let fluxVar = 0;
  // Smoothed type scores, so one odd hit cannot re-colour the whole scene.
  const score = { soft: 0.34, hard: 0.33, industrial: 0.33 };
  const res = {
    type: "soft",
    strength: 0,
    attack: 0,
    decay: 0,
    click: 0,
    grit: 0,
    hit: false,
    ...score,
  };

  function process(f, energyLin, now, dt) {
    res.hit = false;
    const lowLin = energyLin.sub + energyLin.bass;
    const highLin = energyLin.high + energyLin.air;

    // Adaptive threshold on the bass onset function.
    const d = f.lowFlux - fluxAvg;
    fluxAvg += d * 0.02;
    fluxVar += (d * d - fluxVar) * 0.02;
    const sd = Math.sqrt(Math.max(fluxVar, 1e-12));
    const thr = fluxAvg + sd * 1.7;

    if (!capturing && f.lowFlux > thr && now - lastKickAt > 0.085) {
      capturing = true;
      lastKickAt = now;
      t0 = now;
      peakLow = lowLin;
      peakAt = now;
      peakHigh = highLin;
      flatSum = f.flatness;
      flatN = 1;
      decayAt = 0;
    } else if (capturing) {
      if (lowLin > peakLow) {
        peakLow = lowLin;
        peakAt = now;
      }
      if (highLin > peakHigh) peakHigh = highLin;
      flatSum += f.flatness;
      flatN++;
      if (!decayAt && lowLin < peakLow * 0.25 && now - peakAt > 0.01) decayAt = now;
      if (now - t0 > 0.42 || (decayAt && now - decayAt > 0.02)) {
        finish(now);
      }
    }
    void dt;
    res.soft = score.soft;
    res.hard = score.hard;
    res.industrial = score.industrial;
    let best = "soft";
    for (const k of KICK_TYPES) if (score[k] > score[best]) best = k;
    res.type = best;
    return res;
  }

  function finish(now) {
    capturing = false;
    const attack = Math.max(0.004, peakAt - t0);
    const decay = (decayAt || now) - peakAt;
    const click = peakLow > 1e-9 ? peakHigh / peakLow : 0;
    const grit = flatN ? flatSum / flatN : 0;

    // Three soft votes, then normalize. Overlapping on purpose: a kick that is
    // half hard and half industrial should read as exactly that, because the
    // renderer blends the two looks rather than picking one.
    const soft =
      below(click, 0.16, 0.16) * below(grit, 0.36, 0.26) * above(decay, 0.06, 0.16);
    const hard =
      above(click, 0.09, 0.14) * below(attack, 0.05, 0.05) * inRange(grit, 0.16, 0.52, 0.24);
    const indus =
      above(grit, 0.36, 0.25) * above(click, 0.18, 0.22) * above(decay, 0.05, 0.12);
    const total = soft + hard + indus;
    if (total > 1e-6) {
      const k = 0.35; // per-hit blend — a few kicks to settle, not a few bars
      score.soft += ((soft / total) - score.soft) * k;
      score.hard += ((hard / total) - score.hard) * k;
      score.industrial += ((indus / total) - score.industrial) * k;
    }
    res.attack = attack;
    res.decay = decay;
    res.click = click;
    res.grit = grit;
    res.strength = Math.max(0, Math.min(1, Math.log10(1 + peakLow * 40) * 0.6));
    res.hit = true;
  }

  function reset() {
    capturing = false;
    lastKickAt = -1;
    fluxAvg = fluxVar = 0;
    score.soft = score.hard = score.industrial = 1 / 3;
  }

  return { process, reset, out: res };
}

// --- the classifier ---------------------------------------------------------
export function createStyleClassifier() {
  const kick = createKickAnalyser();
  const weights = new Map(FAMILIES.map((f) => [f.id, 0]));
  const arche = { sustain: 0.2, voice: 0.2, groove: 0.2, hard: 0.2, rock: 0.2 };
  const look = {};
  for (const k of LOOK_KEYS) look[k] = ARCHETYPE_LOOK.groove[k];
  let dominant = "";
  let dominantSince = 0;
  let pendingDominant = "";
  let pendingSince = 0;

  const out = {
    kick: kick.out,
    families: [], // [{id, label, weight}], strongest first
    archetypes: arche,
    // Seven numbers saying what this music should LOOK like, blended across
    // the families exactly as the archetypes are. See LOOK_KEYS.
    look,
    dominant: "",
    dominantLabel: "",
    archetype: "groove",
    confidence: 0,
  };

  /**
   * @param {object} f        features.js frame
   * @param {object} beat     tempo.js frame
   * @param {object} energy   linear energy per band: {sub,bass,lowMid,mid,high,air}
   * @param {number} now      seconds (monotonic)
   * @param {number} dt       seconds since the previous frame
   */
  function process(f, beat, energy, now, dt) {
    const k = kick.process(f, energy, now, dt);

    const total =
      energy.sub + energy.bass + energy.lowMid + energy.mid + energy.high + energy.air + 1e-12;
    const s = {
      bpm: beat.locked ? beat.bpm : 0,
      pulse: beat.confidence,
      kickPulse: beat.kickPulse,
      flat: f.flatness,
      centroid: f.centroidN,
      perc: f.percussivity,
      vocal: f.vocalMod,
      crest: f.crest,
      level: f.level,
      subRatio: (energy.sub + energy.bass) / total,
      midRatio: (energy.lowMid + energy.mid) / total,
      airRatio: (energy.high + energy.air) / total,
      kSoft: k.soft,
      kHard: k.hard,
      kIndus: k.industrial,
      // The melodic channel (features.js). Available to every weighting
      // function; used sparingly, because a genre is mostly rhythm and timbre.
      melody: f.melody,
      tonalness: f.tonal,
      chord: f.chordChange,
      dyn: f.dynamics,
    };

    // No stable tempo → every tempo-driven family is guessing. Rather than let
    // them score off a BPM of 0 (which `inRange` would read as "far below the
    // band", i.e. near zero anyway, but only by accident), damp them explicitly
    // and let the two tempo-free families carry the frame.
    const tempoTrust = beat.locked ? Math.max(0.25, Math.min(1, beat.confidence * 1.6)) : 0;

    let sum = 0;
    const raw = [];
    for (const fam of FAMILIES) {
      let w = fam.w(s);
      if (fam.id !== "ambient" && fam.id !== "strings") w *= tempoTrust;
      w = Math.max(0, w);
      raw.push(w);
      sum += w;
    }
    // Nothing matched (a silent passage, or an intro with no character yet):
    // decay toward neutral instead of dividing by ~0 and amplifying noise.
    //
    // ...and LEARN MORE SLOWLY WHEN THE MUSIC IS QUIET. A breakdown has no
    // drums, no pulse and no grit, so every measurement the classifier runs on
    // says "ambient" — and the look of the whole scene would change halfway
    // through a hardcore track and change back at the drop. A quiet passage is
    // not a different genre, it is the same genre with the drums out, so the
    // classifier holds what it knows and re-forms its opinion when there is
    // something to form it from.
    // Squared, so the damping bites where it matters: a passage at half level
    // is still musically informative and only slows down a little, while a real
    // breakdown — a twentieth of the level — all but freezes the opinion until
    // the music comes back.
    const dyn = f.dynamics ?? 1;
    const a = (1 - Math.exp(-dt / 2.5)) * (0.04 + 0.96 * dyn * dyn);
    if (sum < 1e-4) {
      for (const fam of FAMILIES) weights.set(fam.id, weights.get(fam.id) * (1 - a));
    } else {
      for (let i = 0; i < FAMILIES.length; i++) {
        const id = FAMILIES[i].id;
        weights.set(id, weights.get(id) + (raw[i] / sum - weights.get(id)) * a);
      }
    }

    // Archetype mix: the families' weights, pooled. And the look vector, from
    // the same weights — one pass, so a subgenre-accurate animation costs
    // nothing beyond what the archetypes already cost.
    for (const key of ARCHETYPES) arche[key] = 0;
    for (const key of LOOK_KEYS) look[key] = 0;
    let wsum = 0;
    for (const fam of FAMILIES) {
      const w = weights.get(fam.id);
      if (w <= 0) continue;
      arche[fam.a] += w;
      const l = FAMILY_LOOK.get(fam.id);
      for (const key of LOOK_KEYS) look[key] += l[key] * w;
      wsum += w;
    }
    if (wsum > 1e-6) {
      for (const key of ARCHETYPES) arche[key] /= wsum;
      for (const key of LOOK_KEYS) look[key] /= wsum;
    }

    // Dominant family, with hysteresis: a challenger has to stay ahead by a
    // clear margin for a second and a half before it takes the name. Without
    // this, two neighbouring hardcore subgenres trade the label several times a
    // bar and anything keyed to the name strobes.
    let bestId = dominant;
    let bestW = -1;
    for (const fam of FAMILIES) {
      const w = weights.get(fam.id);
      if (w > bestW) {
        bestW = w;
        bestId = fam.id;
      }
    }
    if (!dominant) {
      dominant = bestId;
      dominantSince = now;
    } else if (bestId !== dominant) {
      const cur = weights.get(dominant);
      if (bestW > cur * 1.2) {
        if (pendingDominant !== bestId) {
          pendingDominant = bestId;
          pendingSince = now;
        } else if (now - pendingSince > 1.5) {
          dominant = bestId;
          dominantSince = now;
          pendingDominant = "";
        }
      } else {
        pendingDominant = "";
      }
    } else {
      pendingDominant = "";
    }
    void dominantSince;

    const sorted = FAMILIES.map((fam) => ({
      id: fam.id,
      label: fam.label,
      weight: weights.get(fam.id),
    })).sort((x, y) => y.weight - x.weight);

    out.families = sorted;
    out.dominant = dominant;
    out.dominantLabel = FAMILY_BY_ID.get(dominant)?.label || "";
    out.archetype = FAMILY_BY_ID.get(dominant)?.a || "groove";
    // How sure the whole read is: the top family's share, tempered by how much
    // it stands out from the second.
    const top = sorted[0]?.weight || 0;
    const next = sorted[1]?.weight || 0;
    out.confidence = Math.max(
      0,
      Math.min(1, top * 2.4 * (0.45 + 0.55 * (top > 1e-6 ? (top - next) / top : 0)))
    );
    return out;
  }

  function reset() {
    kick.reset();
    for (const fam of FAMILIES) weights.set(fam.id, 0);
    dominant = "";
    pendingDominant = "";
  }

  return { process, reset, out };
}
