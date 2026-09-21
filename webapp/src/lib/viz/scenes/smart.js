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

import { approach, clamp, hsl, lerp } from "../util.js";
import { WORLDS, makeWorld, worldFor } from "../worlds/index.js";

// How long a change of world takes. Long enough to read as a dissolve rather
// than a cut, short enough that it is over before the next chorus.
const FADE = 1.6;

export function createSmartScene(opts = {}) {
  const preset = opts.preset;
  const o = { intensity: opts.intensity ?? 0.7, reducedMotion: !!opts.reducedMotion };

  // At most two are ever alive: the one on screen and the one leaving.
  let cur = makeWorld(worldFor("", "groove"), preset, o);
  let prev = null;
  let fade = 1; // 0 → prev is fully in front, 1 → cur is

  let dyn = 1;
  let level = 0;
  let trail = WORLDS[cur.id].trail;

  function switchTo(id) {
    if (id === cur.id) return;
    // A second change while the first is still dissolving: the one that was
    // leaving is dropped outright. Three worlds on screen is not a crossfade,
    // it is a mess, and it is also three times the work.
    prev = fade > 0.08 ? cur : prev;
    cur = makeWorld(id, preset, o);
    fade = 0;
  }

  function resize() {}

  function update(frame, dt, geom) {
    const st = frame.style;
    switchTo(worldFor(st?.dominant || "", st?.archetype || ""));

    dyn = approach(dyn, frame.features?.dynamics ?? 1, 0.12, dt);
    level = approach(level, frame.features?.level || 0, 0.14, dt);
    fade = Math.min(1, fade + dt / FADE);
    if (fade >= 1 && prev) prev = null;

    // The wash follows whichever world is in front, so a dissolve carries the
    // smear across with it instead of stepping.
    const want = prev
      ? lerp(WORLDS[prev.id].trail, WORLDS[cur.id].trail, fade)
      : WORLDS[cur.id].trail;
    trail = approach(trail, want, 0.35, dt);

    prev?.impl.update(frame, dt, geom);
    cur.impl.update(frame, dt, geom);
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
      prev.impl.draw(g, geom, pal, { fade: f, energy: Math.min(1.3, f * gain) });
    }
    cur.impl.draw(g, geom, pal, { fade, energy: Math.min(1.3, fade * gain) });
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
    // For the tests and the settings readout: which animation is on screen.
    get world() {
      return cur.id;
    },
    get leaving() {
      return prev?.id || null;
    },
  };
}
