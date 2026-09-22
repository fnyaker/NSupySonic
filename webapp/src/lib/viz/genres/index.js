// The dedicated animations, one file per genre.
//
// WHY THESE EXIST NEXT TO `lib/viz/worlds/`. A world plus a skin is a shared
// motif with a genre's numbers poured into it: it is the right answer for the
// long tail, where the alternative is no answer at all, and it is the wrong
// answer for a genre anybody actually listens to. Hardstyle and zaag both land
// on the same bouncing core with different parameters, and no amount of
// parameter is going to make one of them into a sawtooth waveform and the other
// into a stage.
//
// So a genre in here gets its own file, its own motif and its own composition,
// built from what the music actually is rather than from what the engine
// happens to have. `smart.js` prefers one of these whenever the resolved genre
// has one and falls back to the world for everything else, which means the
// catalogue can be filled in a genre at a time without a flag day.
//
// A CORRECTION WORTH WRITING DOWN, because the first version of this directory
// got it wrong. These genres are not one scene and most of them have nothing to
// do with free parties. Tribe, hardtek and raggatek genuinely come out of the
// European sound-system and teknival world, and their files say so. Everything
// else here does not, and filing them under it is both inaccurate and
// dismissive of scenes that are large, organised and above board:
//
//   gabber     Rotterdam, from the early nineties — Thunderdome and a whole
//              commercial industry around it, not a field
//   uptempo    a festival and club genre (Dominator, Masters of Hardcore,
//              Ground Zero) with its own labels
//   zaag       a Dutch hardstyle KICK DESIGN, from the Q-dance / Defqon.1
//              lineage; the name is the sound, not a place
//   hardtekk   the German club scene, Leipzig and Dresden outward
//   speedcore  a label-and-festival extreme-hardcore world
//   frenchcore started in the French free party scene and has been a festival
//              genre for two decades; saying only the first half is half of it
//
// The animations here are built from what each genre SOUNDS like — the kick,
// the swing, the tempo, the lead — which is the honest basis for a picture
// anyway, and the one that does not put words in a scene's mouth.
//
// THE RULE EVERY FILE IN HERE FOLLOWS: no constant that should be musical.
// Durations are in beats (`m.overBeats`), rates are per beat or per bar
// (`m.perBeat`, `m.sweep`), amplitudes come off `m.drive` / `m.weight` /
// `m.air` / `m.tension`, and smoothing time constants are in beats (`m.ease`).
// `webapp/test/musical.test.mjs` drives every one of them at 90 and at 180 BPM
// and fails any that does not move differently.

import * as frenchcore from "./frenchcore.js";
import * as tribecore from "./tribecore.js";
import * as raggatek from "./raggatek.js";
import * as gabber from "./gabber.js";
import * as speedcore from "./speedcore.js";
import * as hardtekk from "./hardtekk.js";
import * as zaag from "./zaag.js";
import * as uptempo from "./uptempo.js";
import * as hardstyle from "./hardstyle.js";
import * as rawstyle from "./rawstyle.js";
import * as pieep from "./pieep.js";
import * as hardtechno from "./hardtechno.js";
import * as krach from "./krach.js";
import * as hardcore from "./hardcore.js";
import * as industrial from "./industrial.js";
import * as hardpingpong from "./hardpingpong.js";
import * as germanparty from "./germanparty.js";

// Keyed by the skin id (`lib/viz/skins.js`), which is what `skinId` resolves
// any spelling, label or hand-typed tag down to.
const MODULES = {
  frenchcore,
  tribecore,
  raggatek,
  gabber,
  speedcore,
  hardtekk,
  zaag,
  uptempo,
  hardstyle,
  rawstyle,
  pieep,
  hardtechno,
  krach,
  hardcore,
  industrial,
  hardpingpong,
  germanparty,
};

// Genres whose SOUND is close enough that one file draws both. Kept explicit
// rather than guessed: "terrorcore is uptempo" is a judgement about the music,
// and it belongs somewhere a person can disagree with it. Note that these are
// musical neighbours, not scene ones — hardtek maps to the tribecore file
// because both are built on a rolling percussion bed, which is a statement
// about the drums and about nothing else.
const SAME_AS = {
  terrorcore: "uptempo",
  hardtek: "tribecore",
  tekk: "hardtekk",
  ukhardcore: "gabber",
  extratone: "speedcore",
  // Rawstyle's own neighbourhood: the same kick design taken further, which is
  // a difference of degree and is what the look vector is for.
  rawphase: "rawstyle",
  xtraraw: "rawstyle",
  // Euphoric hardstyle IS hardstyle with the anthem turned up, and the scene
  // draws the anthem from `m.melodic` — so it is the same file, honestly.
  euphoric: "hardstyle",
  euphorichardstyle: "hardstyle",
  // Schranz is hard techno's loop-and-distortion end; the scene is built on
  // exactly the property they share.
  schranz: "hardtechno",
  hardgroove: "hardtechno",
  // Millennium / mainstream hardcore and happy hardcore are the anthem-and-
  // structure branch this file is written for.
  happyhardcore: "hardcore",
  hardcoretechno: "hardcore",
  makina: "hardcore",
};

export function genreSceneFor(id) {
  return MODULES[id] || MODULES[SAME_AS[id]] || null;
}

export function hasGenreScene(id) {
  return !!genreSceneFor(id);
}

/** Every id that resolves to a dedicated animation, for the tests. */
export function dedicatedIds() {
  return [...Object.keys(MODULES), ...Object.keys(SAME_AS)];
}

export function makeGenreScene(id, preset, opts) {
  const mod = genreSceneFor(id);
  if (!mod) return null;
  return { id, trail: mod.meta.trail, label: mod.meta.label, impl: mod.create(preset, opts) };
}
