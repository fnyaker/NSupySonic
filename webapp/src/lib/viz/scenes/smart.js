// The style-aware engine: it picks the ANIMATION, not the weights.
//
// What this replaced, and why. The engine used to be one fixed set of layers
// whose alphas the classifier moved — a bloom for the voice, a shockwave for
// the kick, a wall for the guitars, and four more keyed to the `look` vector.
// That is the right shape for blending *within* a style and the wrong shape for
// the question actually being asked. Every genre came out of the same
// primitives at different strengths, so frenchcore and ambient looked like the
// same animation twice: same soft radial vocabulary, different brightness.
//
// So the classifier's `dominant` family now chooses a WORLD — a complete,
// self-contained scene with its own motif, motion and background (see
// `lib/viz/worlds/`). A corridor for techno. Radiating shards for frenchcore. A
// mirrored mandala for psytrance. A turning record for rap. A sun over a grid
// for synthwave. Clouds with no events in them at all for ambient. Thirteen of
// them, covering all fifty-odd families, and they are not variations on each
// other — that is the point.
//
// NOTHING HARD-SWITCHES, which is the property the old design had and this one
// must not lose. Two things protect it:
//
//  - style.js already refuses to rename the dominant family until a challenger
//    has led by a clear margin for a second and a half, so the input to this
//    file is already slow;
//  - and a change is a CROSSFADE, not a cut: the outgoing world keeps being
//    updated and drawn at a falling weight for `FADE` seconds while the
//    incoming one rises. A track that drifts between two neighbouring families
//    dissolves between two pictures instead of flickering between them.
//
// The world is also what owns the trail wash now (`WORLDS[id].trail`), because
// how much of the previous frame to keep is a property of the motif: speedcore
// wants a strobe, ambient wants a minute-long exposure, and a single number
// tuned for one of them is wrong for the other.
//
// AND A GENRE MAY BRING ITS OWN ANIMATION ENTIRELY (`lib/viz/genres/`). A world
// plus a skin is a shared motif with a genre's numbers in it, which is the
// right answer for the long tail and the wrong one for a genre somebody
// actually listens to — no parameter turns a bouncing core into a sawtooth
// waveform. So a genre with a file of its own gets that instead, and the
// fallback is unchanged for everything else. The crossfade does not care which
// kind it is dissolving between.
//
// Both kinds are handed `m`, the musical layer (`lib/viz/musical.js`): the beat
// and bar lengths, the phase inside them, and the shape of the moment. It is
// there so that no animation ever has to write down a duration in seconds.

import { approach, clamp, hsl, lerp } from "../util.js";
import { WORLDS, makeWorld, worldFor } from "../worlds/index.js";
import { skinFor, skinId } from "../skins.js";
import { makeGenreScene } from "../genres/index.js";
import { createMusical } from "../musical.js";

export function createSmartScene(opts = {}) {
  const preset = opts.preset;
  const o = { intensity: opts.intensity ?? 0.7, reducedMotion: !!opts.reducedMotion };

  // At most two are ever alive: the one on screen and the one leaving.
  let curId = "";
  let cur = makeStage("", skinFor("", "groove"));
  let prev = null;
  let fade = 1; // 0 → prev is fully in front, 1 → cur is

  let dyn = 1;
  let level = 0;
  let trail = cur.trail;
  const m = createMusical();

  // The crossfade is keyed to the GENRE, not to the world. Two genres sharing a
  // world are still two different pictures — gabber's seven slabs against
  // speedcore's twenty splinters are both `shatter` — so a change between them
  // has to build the new instance and dissolve to it exactly as a change of
  // world does.
  // A stage is whichever kind of animation this genre gets, wrapped so the rest
  // of this file never has to ask which.
  function makeStage(id, skin) {
    const dedicated = makeGenreScene(id, preset, o);
    if (dedicated) return { ...dedicated, kind: "genre", skin };
    const world = makeWorld(skin.world, preset, o, skin);
    return { ...world, kind: "world", trail: WORLDS[world.id].trail };
  }

  function switchTo(id, skin) {
    if (id === curId) return;
    curId = id;
    // A second change while the first is still dissolving: the one that was
    // leaving is dropped outright. Three worlds on screen is not a crossfade,
    // it is a mess, and it is also three times the work.
    prev = fade > 0.08 ? cur : prev;
    cur = makeStage(id, skin);
    fade = 0;
  }

  function resize() {}

  function update(frame, dt, geom) {
    const st = frame.style;
    const family = st?.dominant || "";
    const arche = st?.archetype || "";
    // `skinId` normalises whatever it is handed — an id, a French label, an
    // admin's own spelling — and falls back through the archetype, so there is
    // always something to dress the scene in.
    const id = skinId(family, arche) || "@" + (arche || "none");
    switchTo(id, skinFor(family, arche));

    // The musical layer is built once and handed to whatever is on screen, so
    // two animations dissolving into each other are reading the same beat.
    m.update(frame, dt);

    dyn = approach(dyn, frame.features?.dynamics ?? 1, 0.12, dt);
    level = approach(level, frame.features?.level || 0, 0.14, dt);
    // The dissolve is a musical length too: one bar, so a change of genre lands
    // on the grid instead of finishing in the middle of a phrase.
    fade = Math.min(1, fade + dt / clamp(m.bar, 0.8, 3));
    if (fade >= 1 && prev) prev = null;

    // The wash follows whichever animation is in front, so a dissolve carries
    // the smear across with it instead of stepping.
    const want = prev ? lerp(prev.trail, cur.trail, fade) : cur.trail;
    trail = approach(trail, want, 0.35, dt);

    prev?.impl.update(frame, dt, geom, m);
    cur.impl.update(frame, dt, geom, m);
  }

  function draw(g, w, h, pal, geom) {
    // The wash IS the clear. A world that wants no trail at all asks for 1 and
    // gets a full repaint; one that wants a long exposure asks for 0.12.
    g.globalCompositeOperation = "source-over";
    g.fillStyle = hsl(pal.hue, 0.45, 0.045, clamp(trail, 0.05, 1));
    g.fillRect(0, 0, w, h);

    // `energy` is what a world scales its living content by: how loud this
    // moment is against the track's own loud reference, and how much the user
    // asked for. `fade` is the crossfade alone, for the parts of a world that
    // are a PLACE rather than an event — a sky must not dim in a breakdown.
    const gain = (0.55 + o.intensity * 0.9) * (0.22 + 0.78 * dyn);
    if (prev) {
      const f = 1 - fade;
      const e = (prev.skin?.energy ?? 1) * f * gain;
      prev.impl.draw(g, geom, pal, { fade: f, energy: Math.min(1.3, e) }, m);
    }
    const e = (cur.skin?.energy ?? 1) * fade * gain;
    cur.impl.draw(g, geom, pal, { fade, energy: Math.min(1.3, e) }, m);
    void level;
  }

  // Intensity and the reduced-motion flag are read live from `o`, so the
  // settings preview can move them without the scene being rebuilt under it.
  function setOptions(next) {
    if (next.intensity != null) o.intensity = next.intensity;
    if (next.reducedMotion != null) o.reducedMotion = !!next.reducedMotion;
  }

  return {
    resize,
    update,
    draw,
    setOptions,
    // For the tests and the settings readout: which animation is on screen,
    // and which genre is dressing it.
    get world() {
      return cur.id;
    },
    /** "genre" when this animation was written for it, "world" when dressed. */
    get kind() {
      return cur.kind;
    },
    get skin() {
      return curId;
    },
    get leaving() {
      return prev?.id || null;
    },
  };
}
