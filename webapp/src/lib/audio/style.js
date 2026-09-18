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
  let dominant = "";
  let dominantSince = 0;
  let pendingDominant = "";
  let pendingSince = 0;

  const out = {
    kick: kick.out,
    families: [], // [{id, label, weight}], strongest first
    archetypes: arche,
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
    const a = 1 - Math.exp(-dt / 2.5); // ~2.5 s to follow a genuine change
    if (sum < 1e-4) {
      for (const fam of FAMILIES) weights.set(fam.id, weights.get(fam.id) * (1 - a));
    } else {
      for (let i = 0; i < FAMILIES.length; i++) {
        const id = FAMILIES[i].id;
        weights.set(id, weights.get(id) + (raw[i] / sum - weights.get(id)) * a);
      }
    }

    // Archetype mix: the families' weights, pooled.
    for (const key of ARCHETYPES) arche[key] = 0;
    let wsum = 0;
    for (const fam of FAMILIES) {
      const w = weights.get(fam.id);
      arche[fam.a] += w;
      wsum += w;
    }
    if (wsum > 1e-6) for (const key of ARCHETYPES) arche[key] /= wsum;

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
