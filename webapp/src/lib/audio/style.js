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
  // Krach is a PARTY: uptempo's kick under a euphoric lead and a sung hook —
  // hot, dense and melodic, not the noise wall it was once written as.
  krach: { motion: 0.95, density: 0.88, punch: 1, warm: 0.84, chaos: 0.48, melodic: 0.66, smooth: 0.18 },
  // Pieep is tekk: a short stomp with a squeak on it and very little melody.
  pieep: { motion: 0.84, density: 0.6, punch: 0.94, warm: 0.5, chaos: 0.34, melodic: 0.24, smooth: 0.16 },
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
      ["below", "four", 0.7, 0.25],
      ["in", "centroid", 0.2, 0.55],
    ],
  },
  {
    id: "jazz",
    label: "Jazz / acoustique",
    a: "voice",
    rule: [
      ["in", "bpm", 80, 165, 45],
      ["below", "flat", 0.35, 0.15],
      ["above", "kSoft", 0.4, 0.3],
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
      ["above", "subRatio", 0.5, 0.25],
      ["below", "flat", 0.5, 0.3],
    ],
  },
  {
    id: "hiphop",
    label: "Hip-hop",
    a: "groove",
    rule: [
      ["in", "bpm", 70, 105, 22],
      ["above", "subRatio", 0.5, 0.25],
      ["above", "vocal", 0.2, 0.4],
      ["below", "four", 0.7, 0.25],
    ],
  },
  {
    id: "house",
    label: "House",
    a: "groove",
    rule: [
      ["in", "bpm", 116, 128, 12],
      ["above", "four", 0.7, 0.2],
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
      ["above", "four", 0.7, 0.2],
      ["below", "vocal", 0.45, 0.4],
      ["max", "kSoft", 1, "kHard", 0.8],
      ["below", "density", 0.85, 0.2],
      ["below", "piep", 0.5, 0.3],
    ],
  },
  {
    id: "trance",
    label: "Trance",
    a: "groove",
    rule: [
      ["in", "bpm", 128, 142, 8],
      ["above", "four", 0.55, 0.25],
      ["above", "kSoft", 0.5, 0.3],
      ["above", "density", 0.7, 0.2],
      ["below", "flat", 0.62, 0.3],
    ],
  },
  {
    id: "dance",
    label: "Dance / EDM",
    a: "groove",
    // Mainstage: a clean four-on-the-floor kick under bright leads and hats.
    rule: [
      ["in", "bpm", 118, 136, 10],
      ["above", "four", 0.7, 0.2],
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
      ["below", "four", 0.7, 0.25],
      ["above", "subRatio", 0.5, 0.25],
      ["above", "perc", 0.5, 0.3],
      ["above", "offbeat", 0.2, 0.15],
    ],
  },
  {
    id: "dubstep",
    label: "Dubstep",
    a: "groove",
    // Half-time and sparse: the kick is rare and the sub carries the drop.
    rule: [
      ["in", "bpm", 136, 148, 8],
      ["below", "four", 0.7, 0.25],
      ["above", "subRatio", 0.5, 0.25],
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
      ["above", "four", 0.55, 0.25],
      ["below", "flat", 0.45, 0.25],
      ["in", "centroid", 0.25, 0.6],
    ],
  },
  {
    id: "psytrance",
    label: "Psytrance",
    a: "groove",
    // A rolling bassline on a fast grid, bright and clean.
    rule: [
      ["in", "bpm", 140, 152, 6],
      ["above", "four", 0.7, 0.2],
      ["above", "kSoft", 0.6, 0.3],
      ["above", "density", 0.85, 0.15],
      ["below", "tail", 0.3, 0.15],
      ["in", "flat", 0.25, 0.65, 0.2],
    ],
  },
  {
    id: "hardstyle",
    label: "Hardstyle",
    a: "hard",
    // The pitched kick with a long, clean tail (and the reverse bass that swells
    // back into it): hard, ringing, not yet the rawstyle's distorted buzz.
    rule: [
      ["in", "bpm", 145, 162, 12],
      ["above", "four", 0.55, 0.25],
      ["max", "kHard", 1, "kIndus", 0.8],
      ["above", "tail", 0.35, 0.25],
      ["below", "buzz", 0.55, 0.2],
      ["below", "piep", 0.5, 0.3],
    ],
  },
  {
    id: "hardtekk",
    label: "Hardtekk",
    a: "hard",
    // German hardtekk: a SHORT, saturated stomp on every beat (hardstyle's tail
    // rings on), offbeat bass, raw in the mids — and no piep on the kick, or
    // it is pieep.
    rule: [
      ["in", "bpm", 138, 172, 14],
      ["above", "four", 0.55, 0.25],
      ["max", "kHard", 1, "kIndus", 0.8],
      ["above", "flat", 0.3, 0.3],
      ["below", "tail", 0.45, 0.25],
      ["below", "piep", 0.4, 0.3],
      ["below", "roll", 0.1, 0.1],
    ],
  },
  {
    id: "zaag",
    label: "Zaag",
    a: "hard",
    // "Saw": a detuned, driven saw stack carrying the tune — a sustained buzz
    // (genre.rs) over a kick that is hard but not uptempo's industrial one.
    rule: [
      ["in", "bpm", 150, 210, 28],
      ["above", "buzz", 0.6, 0.15],
      ["in", "flat", 0.4, 0.65, 0.2],
      ["below", "kSoft", 0.75, 0.3],
      ["below", "kIndus", 0.8, 0.25],
      ["below", "airRatio", 0.09, 0.04],
      ["below", "piep", 0.5, 0.3],
    ],
  },
  {
    id: "frenchcore",
    label: "Frenchcore",
    a: "hard",
    // A HARD pitched kick on every beat around 200 BPM — hard rather than
    // uptempo's industrial grit — under the melodic lead the crowd sings.
    rule: [
      ["in", "bpm", 190, 230, 15],
      ["above", "four", 0.55, 0.25],
      ["above", "kHard", 0.55, 0.3],
      ["below", "piep", 0.5, 0.3],
    ],
  },
  {
    id: "uptempo",
    label: "Uptempo",
    a: "hard",
    // The industrial kick — distorted until it is noise — past 200 BPM, rolls all
    // over, screeches rather than a melody: the noisiest mix of the hard end.
    rule: [
      ["in", "bpm", 195, 290, 25],
      ["above", "kIndus", 0.45, 0.35],
      ["above", "flat", 0.45, 0.2],
      ["below", "piep", 0.5, 0.3],
    ],
  },
  {
    id: "krach",
    label: "Deutscher Krach",
    a: "hard",
    // DEUTSCHER KRACH (2023, Noiseflow): uptempo's kick past 200 BPM, but a
    // PARTY — a euphoric, hardstyle-leaning lead and sung German hooks over it,
    // so a pitched lead (genre.rs `lead`) and a less noisy mix than dark
    // uptempo. It used to be written as the opposite — a noise wall with no
    // melody — which is what the genre is NOT.
    rule: [
      ["in", "bpm", 195, 235, 15],
      ["max", "kIndus", 1, "kHard", 0.85],
      ["above", "lead", 0.6, 0.2],
      ["below", "flat", 0.6, 0.15],
      ["below", "piep", 0.5, 0.3],
    ],
  },
  {
    id: "pieep",
    label: "Pieep",
    a: "hard",
    // Tekk built on the PIEP KICK: a pitched squeak on the attack of every kick.
    // It used to be read as a squeaky high LEAD (the air and the centroid) — which
    // is not what a piep is, and which the air share could not even measure: the
    // squeak is read on the kick itself (features.rs `piep`, 0.97 of the piep
    // record's kicks against 0.17 at most anywhere else).
    rule: [
      ["in", "bpm", 150, 195, 20],
      ["above", "four", 0.55, 0.25],
      ["above", "piep", 0.45, 0.35],
    ],
  },
  {
    id: "hardcore",
    label: "Hardcore",
    a: "hard",
    // Mainstream hardcore / gabber: a hard distorted kick on every beat, under
    // frenchcore's tempo.
    rule: [
      ["in", "bpm", 163, 195, 10],
      ["above", "four", 0.55, 0.25],
      ["above", "kHard", 0.5, 0.3],
      ["in", "flat", 0.35, 0.7, 0.2],
      ["below", "piep", 0.5, 0.3],
    ],
  },
  {
    id: "tribecore",
    label: "Tribe",
    a: "hard",
    // Tribe: the kick under busy tribal percussion — many onsets a beat, a lot of
    // them between the beats.
    rule: [
      ["in", "bpm", 150, 190, 20],
      ["above", "four", 0.55, 0.25],
      ["in", "flat", 0.32, 0.62, 0.2],
      ["above", "perc", 0.5, 0.3],
      ["above", "density", 0.8, 0.2],
      ["above", "offbeat", 0.15, 0.15],
      ["max", "kHard", 1, "kIndus", 0.7],
      ["below", "piep", 0.5, 0.3],
    ],
  },
  {
    id: "speedcore",
    label: "Speedcore",
    a: "hard",
    // Past 250 BPM the grid is at its limit; only the noise and the kick are left.
    rule: [
      ["in", "bpm", 240, 300, 22],
      ["above", "flat", 0.4, 0.2],
      ["max", "kHard", 0.8, "kIndus", 1],
    ],
  },
  {
    id: "industrial",
    label: "Indus",
    a: "hard",
    // A metallic, noisy kick is the whole tell.
    rule: [
      ["in", "bpm", 140, 185, 22],
      ["above", "four", 0.55, 0.25],
      ["above", "flat", 0.5, 0.2],
      ["above", "kIndus", 0.5, 0.3],
      ["below", "piep", 0.5, 0.3],
    ],
  },
  {
    id: "rawstyle",
    label: "Rawstyle",
    a: "hard",
    // Hardstyle's harder cousin: the same grid, the kick's tail driven into a
    // distorted buzz (genre.rs `buzz`).
    rule: [
      ["in", "bpm", 148, 163, 10],
      ["above", "four", 0.55, 0.25],
      ["above", "kHard", 0.5, 0.3],
      ["above", "buzz", 0.45, 0.2],
      ["below", "piep", 0.5, 0.3],
    ],
  },
  {
    id: "hardtechno",
    label: "Hard techno",
    a: "hard",
    // Looped, driving and harder than techno proper, without the hardstyle
    // kick's ringing tail.
    rule: [
      ["in", "bpm", 138, 162, 12],
      ["above", "four", 0.55, 0.25],
      ["in", "flat", 0.3, 0.6, 0.2],
      ["max", "kHard", 1, "kIndus", 0.6],
      ["below", "tail", 0.5, 0.2],
      ["below", "piep", 0.5, 0.3],
    ],
  },
  {
    id: "rock",
    label: "Rock",
    a: "rock",
    // Guitars: a continuously loud, fairly noisy mid band, with a kick that is
    // played rather than gridded.
    rule: [
      ["in", "bpm", 95, 165, 20],
      ["above", "airRatio", 0.08, 0.06],
      ["in", "flat", 0.35, 0.68, 0.22],
      ["below", "four", 0.75, 0.25],
    ],
  },
  {
    id: "metal",
    label: "Metal",
    a: "rock",
    // Distorted guitars (a bright, noisy top end) over an acoustic kit, whose
    // double kick still leaves some beats without one.
    rule: [
      ["in", "bpm", 130, 220, 45],
      ["above", "airRatio", 0.08, 0.06],
      ["above", "flat", 0.5, 0.25],
      ["above", "kSoft", 0.3, 0.3],
      ["below", "four", 0.85, 0.2],
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
      ["above", "airRatio", 0.08, 0.06],
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
      ["in", "bpm", 124, 152, 12],
      ["above", "subRatio", 0.5, 0.25],
      ["below", "four", 0.65, 0.25],
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
      ["above", "four", 0.55, 0.25],
      ["above", "subRatio", 0.5, 0.25],
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
      ["above", "four", 0.55, 0.25],
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
      ["above", "subRatio", 0.5, 0.25],
      ["below", "four", 0.7, 0.25],
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
      ["below", "four", 0.7, 0.25],
      ["above", "subRatio", 0.5, 0.25],
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
      ["below", "four", 0.7, 0.25],
      ["above", "perc", 0.55, 0.3],
      ["above", "offbeat", 0.1, 0.1],
    ],
  },
  {
    id: "dancehall",
    label: "Dancehall",
    a: "groove",
    // Riddim: mid-tempo, sub-heavy, less strictly gridded than house.
    rule: [
      ["in", "bpm", 88, 112, 10],
      ["above", "four", 0.55, 0.25],
      ["above", "subRatio", 0.5, 0.25],
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
      ["above", "subRatio", 0.5, 0.25],
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
      ["above", "four", 0.55, 0.25],
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
      ["above", "four", 0.55, 0.25],
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
      ["below", "four", 0.7, 0.25],
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
      ["above", "vocal", 0.12, 0.2],
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
      ["above", "vocal", 0.25, 0.3],
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
      ["above", "airRatio", 0.08, 0.06],
      ["below", "four", 0.7, 0.25],
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
      ["above", "airRatio", 0.08, 0.06],
      ["below", "four", 0.7, 0.25],
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
      ["above", "airRatio", 0.08, 0.06],
      ["below", "four", 0.7, 0.25],
    ],
  },
  // --- scène / party --------------------------------------------------------
  {
    id: "phonk",
    label: "Phonk",
    a: "groove",
    // Memphis 808: a cowbell hook over a distorted, sub-heavy half-time beat.
    rule: [
      ["in", "bpm", 125, 165, 8],
      ["below", "four", 0.7, 0.25],
      ["above", "subRatio", 0.5, 0.25],
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
      ["above", "four", 0.55, 0.25],
      ["above", "flat", 0.4, 0.22],
      ["above", "perc", 0.55, 0.3],
      ["max", "kHard", 1, "kIndus", 0.7],
      ["below", "airRatio", 0.09, 0.04],
      ["below", "piep", 0.5, 0.3],
    ],
  },
  {
    id: "germanparty",
    label: "German party",
    a: "hard",
    // Party hardtekk with chanted German vocals over a hard kick.
    rule: [
      ["in", "bpm", 148, 185, 16],
      ["above", "four", 0.55, 0.25],
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
    // specific fits". Weak on purpose: it should only ever win by default. At
    // 0.28 it won by default on uptempo, speedcore, trap, pop and hip-hop — the
    // specific rules multiply four or five soft terms and rarely clear that.
    rule: [
      ["k", 0.12],
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
export function familyLook(name) {
  return FAMILY_LOOK.get(name) || FAMILY_LOOK.get(genreOf(name)?.family) || null;
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
 * MAINTAINING THIS: add a row when a family is added to FAMILIES above. A
 * sub-genre written outside its family's range gets its own band in
 * GENRE_ALIASES below, not a row here. A missing row is not a bug — the tracker
 * falls back to the default plateau, which is what it always used to have.
 */
const TEMPO_BANDS = {
  // --- the hard end, which is the whole reason this table exists -------------
  frenchcore: [170, 230],
  uptempo: [170, 260],
  speedcore: [200, 300],
  krach: [170, 260],
  hardcore: [160, 250],
  tribecore: [170, 230],
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
  // No row for the catch-all "electronic": it knows nothing, and a range set
  // from it only ever confirmed whatever octave the grid was on.
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
 * WHICH FAMILY A GENRE NAME BELONGS TO, and the tempo it is written at.
 *
 * A name reaches the engine in one of three shapes: a family id (the live
 * classifier, the server's rules), a family's French label, and — from the
 * genre studio — any of the ~170 sub-genres an admin can tag with and the
 * trained model then predicts (`analysis.EXTRA_GENRES`). That last shape is the
 * one that matters most, since a tag or the model is a genre somebody CHOSE,
 * and it used to reach almost nothing: the look and the bar model were written
 * for family ids only, so a track the model named "Schranz" or "Gabber" had its
 * bar read the generic way and no genre look at all, and guessing from the
 * words in a name gave "Garage rock" UK garage's tempo and "Drumfunk" funk's.
 *
 * So every name resolves to `{ family, band, groove, by }`:
 *   family — whose look and groove it takes;
 *   band   — its own tempo range where it is written at a tempo of its own,
 *            its family's otherwise, null where it spans octaves (a wrong range
 *            is worse than none);
 *   groove — set only where it builds its beat unlike its family (gqom's
 *            broken kick under afro house, hardbass's plain four under hard
 *            techno);
 *   by     — "name" when the whole name is known, "word" / "part" when it was
 *            read from a piece of it (a hand-typed tag). Every name the studio
 *            offers is known by name: `test/viz.test.mjs` reads the Python list
 *            and holds it to that.
 *
 * Keys are flattened (lowercase, accents and everything but letters and digits
 * dropped). A value is a family id, or [family, band?, groove?] with band
 * undefined for the family's own and null for none.
 */
const GENRE_ALIASES = {
  // --- spellings -------------------------------------------------------------
  drumandbass: "dnb",
  drumnbass: "dnb",
  drumbass: "dnb",
  hardcoretechno: "hardcore",
  hardrockband: "hardrock",
  // --- techno & machines -----------------------------------------------------
  minimal: "techno",
  detroit: "techno",
  acidtechno: "techno",
  peaktime: "techno",
  dubtechno: "techno",
  // Body music is a sequenced four-to-the-floor, and it sits under techno.
  ebm: ["techno", [110, 135]],
  schranz: "hardtechno",
  hardgroove: "hardtechno",
  industrialtechno: ["industrial", [125, 155]],
  idm: ["breakbeat", null],
  glitch: ["breakbeat", null],
  experimental: ["electronic", null],
  noise: ["industrial", null, "unknown"],
  // --- house & disco -----------------------------------------------------------
  deephouse: "house",
  techhouse: "house",
  progressivehouse: "house",
  proghouse: "house",
  melodichouse: "house",
  electrohouse: "house",
  frenchhouse: "house",
  ghettohouse: "house",
  witchhouse: ["electronic", null],
  hardhouse: ["house", [135, 155]],
  gqom: ["afrohouse", [115, 130], "broken"],
  afrobeat: "afrohouse",
  afrobeats: "afrohouse",
  italodisco: "disco",
  nudisco: "disco",
  boogie: "disco",
  futurefunk: "disco",
  bigroom: "dance",
  hardance: "dance",
  eurodance: "dance",
  future: "dance",
  futurebass: ["dance", [130, 165], "broken"],
  hyperpop: ["dance", null],
  chiptune: "dance",
  eightbit: "dance",
  hardbass: ["hardtechno", [140, 175], "four"],
  // --- garage & breaks -----------------------------------------------------------
  ukgarage: "garage",
  twostep: "garage",
  speedgarage: "garage",
  bassline: "garage",
  grime: "garage",
  jerseyclub: "garage",
  nubreaks: "breakbeat",
  bigbeat: ["breakbeat", [95, 140]],
  glitchhop: ["breakbeat", [85, 115]],
  footwork: ["breakbeat", [150, 170]],
  breakcore: ["breakbeat", [150, 250]],
  lolicore: ["breakbeat", [150, 250]],
  // --- drum & bass -------------------------------------------------------------
  jungle: "dnb",
  liquid: "dnb",
  liquiddnb: "dnb",
  neurofunk: "dnb",
  jumpup: "dnb",
  darkstep: "dnb",
  drumfunk: "dnb",
  crossbreed: "dnb",
  // --- dubstep & trap ----------------------------------------------------------
  riddim: "dubstep",
  brostep: "dubstep",
  melodicdubstep: "dubstep",
  trapedm: "trap",
  hardtrap: "trap",
  drill: "trap",
  ukdrill: "trap",
  cloudrap: "trap",
  // --- trance & psy ---------------------------------------------------------------
  upliftingtrance: "trance",
  progtrance: "trance",
  vocaltrance: "trance",
  hardtrance: ["trance", [138, 160]],
  goa: "psytrance",
  fullon: "psytrance",
  forest: ["psytrance", [140, 165]],
  darkpsy: ["psytrance", [145, 175]],
  hitech: ["psytrance", [160, 220]],
  psydub: ["psytrance", null, "unknown"],
  // --- hardcore -----------------------------------------------------------------
  gabber: ["hardcore", [160, 230]],
  happyhardcore: "hardcore",
  ukhardcore: "hardcore",
  makina: "hardcore",
  bouncy: "hardcore",
  doomcore: ["hardcore", [130, 170]],
  industrialhardcore: ["industrial", [140, 200]],
  terrorcore: ["speedcore", [190, 280]],
  extratone: ["speedcore", [220, 300]],
  splittercore: ["speedcore", [220, 300]],
  flashcore: "speedcore",
  hardtek: "tribecore",
  tribe: "tribecore",
  raggatek: "tribecore",
  acidcore: "tribecore",
  frenchtek: "frenchcore",
  // --- hardstyle & tekk ----------------------------------------------------------
  euphoric: "hardstyle",
  euphorichardstyle: "hardstyle",
  jumpstyle: "hardstyle",
  rawphase: "rawstyle",
  xtraraw: "rawstyle",
  tekk: "hardtekk",
  tekno: "hardtekk",
  // --- hip-hop & latin ------------------------------------------------------------
  boombap: "hiphop",
  gfunk: "hiphop",
  emorap: "rap",
  lofihiphop: "lofi",
  afroswing: "dancehall",
  moombahton: ["reggaeton", [100, 118]],
  // Dominican dembow runs at 115-130, reggaeton's at 90-100: the name alone
  // cannot say which octave.
  dembow: ["reggaeton", null],
  // --- rock & metal ---------------------------------------------------------------
  garagerock: "rock",
  psychrock: "rock",
  progrock: "rock",
  grunge: "rock",
  emo: "rock",
  gothic: ["rock", null],
  hardcorepunk: ["punk", [150, 250]],
  postpunk: ["punk", [110, 170]],
  poppunk: "punk",
  skapunk: "punk",
  heavymetal: "metal",
  thrash: "metal",
  metalcore: "metal",
  deathcore: "metal",
  djent: "metal",
  powermetal: "metal",
  symphonicmetal: "metal",
  // Nu metal grooves at hip-hop tempi: metal's 120-200 would double a 100.
  numetal: ["metal", [80, 125]],
  doom: ["metal", [50, 100]],
  sludge: ["metal", [55, 110]],
  deathmetal: "brutal",
  blackmetal: "brutal",
  // --- pop, soul & song ---------------------------------------------------------------
  synthpop: "synthwave",
  citypop: "pop",
  kpop: "pop",
  jpop: "pop",
  latinpop: "pop",
  dreampop: "pop",
  chanson: "vocalPop",
  schlager: ["vocalPop", null],
  bollywood: ["vocalPop", null],
  neosoul: "soul",
  gospel: "soul",
  motown: ["soul", null],
  kizomba: "rnb",
  // --- chill, dub & reggae ---------------------------------------------------------------
  triphop: "lofi",
  downtempo: "lofi",
  vaporwave: "lofi",
  chillhop: "lofi",
  chillout: "ambient",
  drone: "ambient",
  darkambient: "ambient",
  newage: "ambient",
  shoegaze: "ambient",
  dub: "reggae",
  rocksteady: "reggae",
  // Ska's offbeat is counted as the beat: 100-160, not reggae's one-drop.
  ska: ["reggae", [100, 160]],
  // --- synth ---------------------------------------------------------------------------
  retrowave: "synthwave",
  outrun: "synthwave",
  darksynth: "synthwave",
  darkwave: ["synthwave", null],
  coldwave: ["synthwave", null],
  // --- jazz, folk & the world ----------------------------------------------------------
  bebop: "jazz",
  swing: "jazz",
  bigband: "jazz",
  smoothjazz: "jazz",
  jazzfusion: "jazz",
  bossanova: "jazz",
  deltablues: "blues",
  bluegrass: "country",
  singersongwriter: "folk",
  celtic: "folk",
  flamenco: ["folk", null],
  tango: ["folk", null],
  arabic: ["folk", null],
  salsa: "funk",
  samba: "funk",
  cumbia: "funk",
  highlife: "funk",
  // --- classical -------------------------------------------------------------------------
  classical: "strings",
  orchestral: "strings",
  choral: "strings",
  opera: "strings",
  filmscore: "strings",
  soundtrack: "strings",
  baroque: "strings",
  romantic: "strings",
  minimalism: "strings",
  piano: "strings",
};

const flatten = (v) =>
  String(v)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
const FAMILY_BY_FLAT = new Map();
for (const f of FAMILIES) {
  FAMILY_BY_FLAT.set(flatten(f.id), f.id);
  FAMILY_BY_FLAT.set(flatten(f.label), f.id);
}
// What the last-resort substring pass may find inside a name written without
// separators: the family ids, and the aliases long enough not to turn up by
// accident ("emo", "dub" and "ska" are inside far too many words).
const PARTS = [...new Set([...FAMILIES.map((f) => flatten(f.id)), ...Object.keys(GENRE_ALIASES)])].filter(
  (k) => k.length >= 5,
);

function genreEntry(key, by) {
  const fam = FAMILY_BY_FLAT.get(key);
  if (fam) return { family: fam, band: TEMPO_BANDS[fam] || null, groove: null, by };
  const a = GENRE_ALIASES[key];
  if (a == null) return null;
  const [family, band, groove] = typeof a === "string" ? [a] : a;
  return { family, band: band === undefined ? TEMPO_BANDS[family] || null : band, groove: groove || null, by };
}

const RESOLVED = new Map();

/**
 * Resolve any genre name (see above). Null when nothing matches, which means
 * "the generic reading": the default plateau, the generic bar, no look.
 */
export function genreOf(name) {
  if (!name) return null;
  const raw = String(name);
  if (RESOLVED.has(raw)) return RESOLVED.get(raw);
  let hit = genreEntry(flatten(raw), "name");
  // A compound name puts the SPECIFIC genre first and its family after it —
  // "uptempo hardcore", "raw hardstyle", "melodic dubstep" — so the first word
  // that names something wins. Taking the longest match instead reads
  // "uptempo hardcore" as hardcore, which is a different record.
  if (!hit)
    for (const word of raw.split(/[^\p{L}\p{N}]+/u)) {
      const w = flatten(word);
      if (w && (hit = genreEntry(w, "word"))) break;
    }
  // Last resort, for a name written without separators. Longest match, so
  // "hardtechno" is not read as "techno".
  if (!hit) {
    const id = flatten(raw);
    let best = "";
    for (const k of PARTS) if (k.length > best.length && id.includes(k)) best = k;
    if (best) hit = genreEntry(best, "part");
  }
  if (RESOLVED.size > 512) RESOLVED.clear();
  RESOLVED.set(raw, hit);
  return hit;
}

/**
 * The tempo range a genre name is written in, [lo, hi] BPM, or null for "use
 * the default plateau" — never a guess, because a wrong range is worse than no
 * range.
 */
export function tempoRangeFor(name) {
  return genreOf(name)?.band || null;
}

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
  "bpm", "pulse", "kickPulse", "flat", "centroid", "perc", "vocal", "range", "level",
  "subRatio", "midRatio", "airRatio", "kSoft", "kHard", "kIndus", "melody", "tonalness",
  "chord", "dyn",
  // What the music is built from (rhythm/src/style.rs F_KF0..F_ROLL).
  "kickF0", "piep", "tail", "lead", "buzz", "screech", "offbeat", "density", "roll", "four",
];
const FEATURE_INDEX = new Map(RULE_FEATURES.map((k, i) => [k, i]));
const OPS = { k: 0, in: 1, above: 2, below: 3, raw: 4, max: 5 };
// The two families that do not need a tempo to be judged: everything else is
// damped while the beat grid is not locked.
const TEMPO_FREE = new Set(["ambient", "strings"]);
// The catch-all, which wins by default and is evidence of nothing: the
// classifier's confidence is only backed by what the OTHER rules found.
export const FALLBACK = "electronic";

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
 * HOW EACH GENRE BUILDS ITS GROOVE, which is how its bar has to be read
 * (rhythm/src/beat.rs `DOWN_MODELS`): 1 a kick on every beat with the backbeat
 * clap hidden under it, 2 hard dance (the same, and rolls closing the bars),
 * 3 a broken beat, 4 a live kit; 0 unknown, the generic reading.
 */
export const GROOVES = { unknown: 0, four: 1, hard: 2, broken: 3, live: 4 };
const GROOVE_OF = {
  four: ["house", "techno", "trance", "dance", "disco", "psytrance", "afrohouse", "synthwave", "germanparty"],
  broken: ["dnb", "dubstep", "breakbeat", "garage", "trap", "hiphop", "rap", "phonk", "amapiano", "reggaeton", "dancehall"],
  live: ["rock", "metal", "punk", "indie", "hardrock", "brutal", "pop", "vocalPop", "funk", "soul", "blues", "country", "rnb", "reggae", "jazz"],
};
const GROOVE_BY_ID = new Map();
for (const [g, ids] of Object.entries(GROOVE_OF)) for (const id of ids) GROOVE_BY_ID.set(id, GROOVES[g]);

/** The groove class of any genre name (genreOf), 0 for the generic reading. */
export function grooveOf(name) {
  const g = genreOf(name);
  if (!g) return GROOVES.unknown;
  if (g.groove) return GROOVES[g.groove];
  if (GROOVE_BY_ID.has(g.family)) return GROOVE_BY_ID.get(g.family);
  return FAMILY_BY_ID.get(g.family)?.a === "hard" ? GROOVES.hard : GROOVES.unknown;
}

/**
 * The whole vocabulary, flattened for the analyser (style.rs#load_families):
 * [count, then per family: archetype, flag (1 tempo-free, 2 the fallback), look x7, rangeLo, rangeHi, groove,
 *  nTerms, then per term: op, a, b, p1, p2, p3].
 */
export function familyTable() {
  const out = [FAMILIES.length];
  for (const f of FAMILIES) {
    out.push(Math.max(0, ARCHETYPES.indexOf(f.a)), TEMPO_FREE.has(f.id) ? 1 : f.id === FALLBACK ? 2 : 0);
    const look = FAMILY_LOOK.get(f.id);
    for (const k of LOOK_KEYS) out.push(look[k]);
    const range = TEMPO_BANDS[f.id] || [0, 0];
    out.push(range[0], range[1], grooveOf(f.id), f.rule.length);
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
/** The families' ids and rules, in table order — for the tests. */
export function familyRules() {
  return FAMILIES.map(({ id, rule }) => ({ id, rule }));
}

export function familyAt(index) {
  return index >= 0 && index < FAMILIES.length ? FAMILY_LIST[index] : null;
}

// The kick types the analyser names (style.rs `KickShape.kind`), in order.
export const KICK_TYPES = ["soft", "hard", "industrial"];
