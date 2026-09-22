// WHICH worlds exist, and what each one is called — without the code that
// draws them.
//
// Two very different things used to live in one file. `lib/viz/skins.js` needs
// to know that a world id is real (a skin naming a world that does not exist
// would render nothing at all, which is much worse than rendering the wrong
// one), and the settings panel needs to name the world the engine resolved.
// Neither needs the eighteen scene modules that draw them — a hundred and forty
// kilobytes of source — and importing the registry to get a label is what put
// all of it in the main bundle, on the critical path, for every visitor
// including the ones who never turn an animation on.
//
// `trail` is how much of the previous frame each world keeps: the compositor
// washes with it, so a world states its own smear rather than inheriting one
// tuned for somebody else's motif. It lives here rather than next to the code
// because the compositor is told it, and the compositor is not the world.
//
// MAINTAINING THIS: a world needs a row here AND a factory in ./index.js. The
// test `webapp/test/viz.test.mjs` fails if the two lists disagree.
export const WORLD_META = {
  tunnel: { label: "Corridor", trail: 0.42 },
  shatter: { label: "Éclats", trail: 0.55 },
  hardbounce: { label: "Rebond", trail: 0.5 },
  kaleido: { label: "Kaléidoscope", trail: 0.34 },
  starfield: { label: "Champ d'étoiles", trail: 0.3 },
  breakgrid: { label: "Découpe", trail: 0.6 },
  wobble: { label: "Wobble", trail: 0.5 },
  vinyl: { label: "Vinyle", trail: 0.45 },
  stagelights: { label: "Projecteurs", trail: 0.4 },
  horizon: { label: "Horizon", trail: 1 },
  bloom: { label: "Éclosion", trail: 0.4 },
  smoke: { label: "Fumée", trail: 0.18 },
  nebula: { label: "Nébuleuse", trail: 0.12 },
  cathedral: { label: "Nef", trail: 0.16 },
  carnival: { label: "Carnaval", trail: 0.3 },
  pixels: { label: "Pixels", trail: 0.5 },
  ocean: { label: "Océan", trail: 0.14 },
  neon: { label: "Néon", trail: 0.28 },
};

/** When nothing names a genre at all, the archetype is still a better guess
 * than one fixed default. Genre → world is decided by `lib/viz/skins.js`; this
 * is only the floor under it. */
const ARCHETYPE_WORLD = {
  sustain: "nebula",
  voice: "bloom",
  groove: "tunnel",
  hard: "hardbounce",
  rock: "stagelights",
};

export function worldFor(archetype) {
  return ARCHETYPE_WORLD[archetype] || "bloom";
}
