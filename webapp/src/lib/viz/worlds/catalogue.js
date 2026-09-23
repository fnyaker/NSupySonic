// WHICH worlds exist, what each one is called and what it looks like —
// without the code that draws them.
//
// Three consumers need this and none of them should pay for a shader:
// `lib/viz/skins.js` has to know a world id is real (a skin naming a world that
// does not exist would render nothing), the settings panel shows the gallery
// and names the world the engine resolved, and the tests check that the
// catalogue and the loader agree. The GLSL itself is code-split one chunk per
// world (./index.js) and fetched the first time that world is on screen.
//
// `group` is the gallery's shelf, `blurb` the one line under its name. They are
// written for a person choosing a picture, not for a programmer: what you will
// SEE, not how it is made.
//
// MAINTAINING THIS: a world needs a row here AND a loader in ./index.js. The
// test suite fails if the two disagree.

export const GROUPS = [
  { id: "hard", label: "Hard" },
  { id: "techno", label: "Techno & machines" },
  { id: "trance", label: "Trance & psy" },
  { id: "bass", label: "Bass & breaks" },
  { id: "urban", label: "Urbain" },
  { id: "groove", label: "Pop & groove" },
  { id: "rock", label: "Rock & metal" },
  { id: "calm", label: "Calme" },
  { id: "world", label: "Monde" },
  { id: "retro", label: "Rétro" },
  { id: "modes", label: "Classiques" },
];

export const WORLD_META = {
  // --- hard ------------------------------------------------------------------
  forge: { group: "hard", label: "Forge", blurb: "L'enclume frappée à chaque kick, des gerbes d'étincelles qui roulent au sol, l'hymne en ruban d'or." },
  shatter: { group: "hard", label: "Éclats", blurb: "Le cadre vole en éclats de verre qui réfractent la lumière, relancés à chaque kick." },
  lasers: { group: "hard", label: "Lasers", blurb: "La mainstage vue de la foule : lasers dans la fumée, flammes sur les gros kicks, les mains qui se lèvent sur le drop." },
  bounce: { group: "hard", label: "Rebond", blurb: "Une bille de gelée lumineuse qui s'écrase sur le kick et rebondit sur le temps." },
  saw: { group: "hard", label: "Scie", blurb: "Une lame qui tourne et des dents de scie laser — le zaag, littéralement." },
  stairs: { group: "hard", label: "Arpège", blurb: "Un escalier de lumière dont chaque marche s'allume sur une note de l'arpège." },
  pingpong: { group: "hard", label: "Ping-pong", blurb: "Un échange au néon : deux raquettes de verre qui renvoient une balle de lumière sur chaque temps." },
  soundsystem: { group: "hard", label: "Sound system", blurb: "Un mur d'enceintes dont les membranes pompent sous chaque basse." },
  static: { group: "hard", label: "Parasites", blurb: "Le signal qui se déchire : blocs arrachés, bandes décalées, bruit d'antenne." },
  fireworks: { group: "hard", label: "Feu d'artifice", blurb: "Des bouquets qui éclatent sur les temps forts et retombent en pluie d'or." },

  // --- techno & machines -------------------------------------------------------
  tunnel: { group: "techno", label: "Corridor", blurb: "Un couloir d'acier éclairé par ses anneaux, une lumière qui file au fond à chaque temps, un sol qui les reflète." },
  warehouse: { group: "techno", label: "Hangar", blurb: "Piliers de béton dans le brouillard, lampes au sodium et stroboscopes." },
  ridges: { group: "techno", label: "Crêtes", blurb: "Le spectre en lignes de crête qui défilent, à la manière d'Unknown Pleasures." },
  lattice: { group: "techno", label: "Treillis", blurb: "Un treillis de poutres lumineuses infini, traversé au tempo." },
  circuit: { group: "techno", label: "Circuit", blurb: "Des pistes de circuit imprimé où les impulsions courent sur chaque frappe." },

  // --- trance & psy ------------------------------------------------------------
  hyperspace: { group: "trance", label: "Hyperespace", blurb: "Les étoiles s'étirent, accélèrent pendant la montée et bondissent au drop." },
  kaleido: { group: "trance", label: "Kaléidoscope", blurb: "Une fractale en miroir qui tourne, zoome et fleurit avec le son." },
  galaxy: { group: "trance", label: "Galaxie", blurb: "Une galaxie spirale de milliers d'étoiles qui respire avec la basse." },
  flow: { group: "trance", label: "Flux", blurb: "Un champ de courants colorés qui s'enroule sur lui-même, sans jamais se répéter." },

  // --- bass & breaks -----------------------------------------------------------
  wobble: { group: "bass", label: "Wobble", blurb: "Une membrane de basse qui ondule à la forme du LFO et se déchire au drop." },
  chrome: { group: "bass", label: "Chrome", blurb: "Une goutte de métal liquide qui se déforme sous les basses." },
  slices: { group: "bass", label: "Découpe", blurb: "L'image tranchée en bandes qui glissent et se décalent sur chaque break." },

  // --- urbain -----------------------------------------------------------------
  vinyl: { group: "urban", label: "Vinyle", blurb: "Un disque qui tourne sous la lampe, sa pochette en étiquette." },
  halo: { group: "urban", label: "Halo", blurb: "Le spectre en couronne autour de la pochette, des poussières de lumière." },
  nightdrive: { group: "urban", label: "Route de nuit", blurb: "L'autoroute de nuit, les lampadaires qui défilent au tempo." },
  neon: { group: "urban", label: "Néon", blurb: "Une rue mouillée sous des enseignes au néon qui se reflètent." },

  // --- pop & groove ------------------------------------------------------------
  bokeh: { group: "groove", label: "Bokeh", blurb: "Des disques de lumière floue qui éclosent sur les temps." },
  discoball: { group: "groove", label: "Boule à facettes", blurb: "La boule tourne et balaie la salle de ses taches de lumière." },
  silk: { group: "groove", label: "Soie", blurb: "Des rubans de soie qui ondulent au fil de la voix." },
  artwork: { group: "groove", label: "Pochette vivante", blurb: "Les couleurs de la pochette, fondues en un dégradé qui respire." },
  plasma: { group: "groove", label: "Lampe à lave", blurb: "Des bulles de lumière qui fusionnent et se séparent au groove." },

  // --- rock & metal ------------------------------------------------------------
  stage: { group: "rock", label: "Scène", blurb: "Le groupe en contre-jour devant un mur LED qui montre la pochette, les faisceaux dans la fumée, la foule." },
  inferno: { group: "rock", label: "Brasier", blurb: "Des flammes qui rugissent et des braises qui montent." },
  storm: { group: "rock", label: "Orage", blurb: "Un ciel d'orage où la foudre tombe sur les frappes." },

  // --- calme -----------------------------------------------------------------
  nebula: { group: "calm", label: "Nébuleuse", blurb: "Des nuages de gaz et de poussière d'étoiles, sans un seul à-coup." },
  aurora: { group: "calm", label: "Aurore", blurb: "Des rideaux d'aurore boréale au-dessus de l'eau." },
  ocean: { group: "calm", label: "Océan", blurb: "La houle de nuit sous la lune, qui se gonfle avec la basse." },
  cathedral: { group: "calm", label: "Nef", blurb: "Des rais de lumière à travers un vitrail, la poussière qui danse dedans." },
  ink: { group: "calm", label: "Encre", blurb: "De l'encre qui s'épanouit dans l'eau, une volute par note." },
  rain: { group: "calm", label: "Pluie", blurb: "La pluie sur la vitre, les lumières de la ville floues derrière." },
  fireflies: { group: "calm", label: "Lucioles", blurb: "Une prairie de nuit où les lucioles s'allument sur la mélodie." },

  // --- monde -----------------------------------------------------------------
  carnival: { group: "world", label: "Carnaval", blurb: "Des anneaux de perles qui tournent en polyrythmie et se retrouvent." },
  tropics: { group: "world", label: "Tropiques", blurb: "Le soleil couchant derrière les palmes, l'air qui ondule de chaleur." },

  // --- rétro -----------------------------------------------------------------
  horizon: { group: "retro", label: "Horizon", blurb: "Le soleil rayé sur la grille néon, les montagnes au loin." },
  pixels: { group: "retro", label: "Pixels", blurb: "Un écran cathodique, des pixels qui sautent et un sprite qui court." },

  // --- classiques (also the fixed modes) --------------------------------------
  pulse: { group: "modes", label: "Pulsations", blurb: "Un bassin de lumière : une onde par temps, un lobe par bande." },
  spectrum: { group: "modes", label: "Spectre", blurb: "Le spectre en barres de verre lumineux, avec une vraie résolution dans les graves." },
};

/** When nothing names a genre at all, the archetype is still a better guess
 * than one fixed default. Genre -> world is decided by `lib/viz/skins.js`; this
 * is only the floor under it. */
const ARCHETYPE_WORLD = {
  sustain: "nebula",
  voice: "bokeh",
  groove: "tunnel",
  hard: "lasers",
  rock: "stage",
};

export function worldFor(archetype) {
  return ARCHETYPE_WORLD[archetype] || "bokeh";
}
