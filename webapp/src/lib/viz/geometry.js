// Where a scene is allowed to draw, and where the good parts of it should go.
//
// Two complaints produced this file, and they are the same complaint seen from
// two sides:
//
//  - IN THE PLAYER, the artwork sits in the middle of the screen, and every
//    scene put its best material exactly there. A shockwave that expands from
//    the centre spends its first and brightest third behind the cover; a bloom
//    keyed to the voice was never visible at all.
//  - ON A SECOND SCREEN, there is no artwork and the frame is 16:9, but the
//    scenes were built around `Math.min(w, h)` — so everything happened inside
//    a circle in the middle and a third of a beamer stayed black.
//
// Both are fixed by the same two primitives, and every scene is written on them
// instead of on `w/2, h/2, min(w,h)`:
//
//   place(angle, radial)  polar coordinates for THIS frame. `radial` 0 is the
//                         inner boundary — the edge of the artwork, or the
//                         centre when there is none — and 1 is the frame's own
//                         edge along that angle. So radial 1 is the corner in
//                         the corners and the side in the sides: a "ring" of
//                         points at radial 1 traces the screen, not a circle
//                         inscribed in it.
//   ringRx/ringRy(t)      an expanding ellipse that starts at the artwork's rim
//                         and leaves through the corners, reaching the sides
//                         and the top at the same moment whatever the aspect.
//
// The occluder is measured from the DOM (Visualizer.svelte hands over the
// element), never guessed from a magic number: the cover is 72vw on a phone,
// min(46vh, 100%) on a desktop and absent on the projector, and a scene should
// not have to know any of that.

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// The occluder is never allowed to eat the whole frame: past this much of an
// axis there would be nowhere left to draw, and a scene that renders into a
// two-pixel band looks broken rather than considerate.
const HOLE_MAX = 0.42;
// Breathing room around the artwork, as a share of the frame's short side. A
// ring born exactly on the cover's edge reads as a rim light on the cover
// rather than as something the music did.
const HOLE_PAD = 0.03;
// How far past the frame an expanding ring travels before it is done. √2 would
// reach the corners of a square; a little more covers any aspect.
const RING_OUT = 1.5;
// How much of the frame's shape an expanding ring takes on. Fully anisotropic
// (1) reads as a squashed circle rather than as a shockwave; fully isotropic
// (0) spends the first half of its life nowhere near the sides of a 16:9
// screen. Just under half is a ring that is recognisably a ring and still
// reaches the edges of a wide frame while it is bright.
const RING_ANISO = 0.45;

export function createGeometry() {
  // Reused by `place`: scenes read the two numbers immediately, exactly as they
  // read the engine's frame object. Nothing here allocates per call.
  const pt = [0, 0];

  const out = {
    w: 0,
    h: 0,
    cx: 0,
    cy: 0,
    rx: 0, // half-width
    ry: 0, // half-height
    rMin: 0, // inscribed radius — the old min(w,h)/2, kept for line widths
    rMax: 0, // to the corner
    aspect: 1,
    wide: false, // a screen, not a phone: worth spreading across
    // The artwork, as half-extents around (hx, hy). All zero when nothing is
    // in the way, which is the projector's case and the settings preview's.
    // 0..1: how much of the frame the artwork takes along whichever axis it
    // takes most of. The MOST, not the least — a square cover in a 16:9 frame
    // covers two thirds of the height and a third of the width, and "a third"
    // is not what a scene needs to hear about it.
    hole: 0,
    hx: 0,
    hy: 0,
    hw: 0,
    hh: 0,
    nodes: [], // emission points spread over the usable area, strongest first
    place,
    edgeAt,
    innerAt,
    ringRx,
    ringRy,
    ringT,
  };

  /** Distance from the centre to the frame's edge along `a`. */
  function edgeAt(a) {
    const ex = Math.abs(Math.cos(a));
    const ey = Math.abs(Math.sin(a));
    const dx = ex > 1e-6 ? out.rx / ex : Infinity;
    const dy = ey > 1e-6 ? out.ry / ey : Infinity;
    return Math.min(dx, dy);
  }

  /**
   * Distance from the centre to the inner boundary along `a`: the artwork's
   * rim where there is artwork, zero where there is not. Rectangular, because
   * a cover is.
   */
  function innerAt(a) {
    if (!out.hw && !out.hh) return 0;
    const ex = Math.abs(Math.cos(a));
    const ey = Math.abs(Math.sin(a));
    const dx = ex > 1e-6 ? out.hw / ex : Infinity;
    const dy = ey > 1e-6 ? out.hh / ey : Infinity;
    return Math.min(dx, dy);
  }

  /**
   * Polar → frame. `radial` 0 is the inner boundary, 1 the frame's edge; past
   * 1 is off screen, which is a perfectly good place for something travelling.
   * Returns a SHARED pair — read it now, do not keep it.
   *
   * `aniso` is how much of the frame's SHAPE the mapping takes on. At 1 a ring
   * of points traces the frame, which is what something meant to fill the
   * screen wants. At 0 it traces a circle through the corners, which is what a
   * SHAPE wants — a polygon drawn at aniso 1 on a 16:9 screen stops reading as
   * a polygon and starts reading as a border round the picture.
   */
  function place(a, radial, aniso = 1) {
    const inner = innerAt(a);
    let edge = edgeAt(a);
    if (aniso < 1) edge = out.rMax + (edge - out.rMax) * aniso;
    const d = inner + (edge - inner) * radial;
    pt[0] = out.cx + Math.cos(a) * d;
    pt[1] = out.cy + Math.sin(a) * d;
    return pt;
  }

  // An expanding ring, from the artwork's rim to past the corners, leaning
  // toward the frame's shape so it fills a wide screen without turning into a
  // flattened oval. `endRx`/`endRy` are recomputed on resize, not per call.
  let endRx = 0;
  let endRy = 0;
  function ringRx(t) {
    return out.hw + (endRx - out.hw) * t;
  }
  function ringRy(t) {
    return out.hh + (endRy - out.hh) * t;
  }
  // Where in a ring's life it crosses the frame's nearest edge — the moment it
  // stops being a shape and starts being a wash. Scenes fade out around it.
  function ringT() {
    const tx = endRx > out.hw ? (out.rx - out.hw) / (endRx - out.hw) : 1;
    const ty = endRy > out.hh ? (out.ry - out.hh) / (endRy - out.hh) : 1;
    return Math.max(0.05, Math.min(1, Math.max(tx, ty)));
  }

  /**
   * @param {number} w  frame width in CSS pixels
   * @param {number} h  frame height
   * @param {{x:number,y:number,w:number,h:number}|null} occl
   *        the artwork's box, in the same coordinates, or null.
   */
  function set(w, h, occl) {
    out.w = w;
    out.h = h;
    out.cx = w / 2;
    out.cy = h / 2;
    out.rx = w / 2;
    out.ry = h / 2;
    out.rMin = Math.min(w, h) / 2;
    out.rMax = Math.hypot(w, h) / 2;
    out.aspect = h > 0 ? w / h : 1;
    out.wide = out.aspect >= 1.45;

    const short = Math.min(w, h);
    if (occl && occl.w > 8 && occl.h > 8) {
      const pad = short * HOLE_PAD;
      out.hx = occl.x + occl.w / 2;
      out.hy = occl.y + occl.h / 2;
      out.hw = Math.min(occl.w / 2 + pad, w * HOLE_MAX);
      out.hh = Math.min(occl.h / 2 + pad, h * HOLE_MAX);
      out.hole = clamp01(Math.max(out.hw / out.rx, out.hh / out.ry));
      // `place` is polar around the FRAME's centre, so an artwork that is not
      // centred would leave the ring lopsided. It always is centred in both
      // players, and pretending otherwise would cost a second centre in every
      // scene for a case that does not exist — so the boundary is grown to
      // cover it instead, which is correct for any position and costs nothing.
      out.hw = Math.min(out.hw + Math.abs(out.hx - out.cx), w * HOLE_MAX);
      out.hh = Math.min(out.hh + Math.abs(out.hy - out.cy), h * HOLE_MAX);
    } else {
      out.hx = out.cx;
      out.hy = out.cy;
      out.hw = 0;
      out.hh = 0;
      out.hole = 0;
    }

    endRx = out.rMax + (out.rx * RING_OUT - out.rMax) * RING_ANISO;
    endRy = out.rMax + (out.ry * RING_OUT - out.rMax) * RING_ANISO;
    buildNodes();
    return out;
  }

  // Emission points. One scene wants a single origin, another wants the energy
  // spread across a beamer; both ask for `nodes` and use as many as their
  // quality tier allows. The weights say which one is the main event.
  function buildNodes() {
    const n = out.nodes;
    n.length = 0;
    if (out.hole > 0.25) {
      // Around the artwork: the two flanks first (there is always room beside
      // it), then above and below when the frame is tall enough to have any.
      const sideX = (out.hw + out.rx) / 2;
      n.push({ x: out.cx - sideX, y: out.cy, w: 1 });
      n.push({ x: out.cx + sideX, y: out.cy, w: 1 });
      if (out.ry - out.hh > out.rMin * 0.28) {
        const sideY = (out.hh + out.ry) / 2;
        n.push({ x: out.cx, y: out.cy - sideY, w: 0.7 });
        n.push({ x: out.cx, y: out.cy + sideY, w: 0.7 });
      }
    } else if (out.wide) {
      // A screen. One centre and two flanks, so the sides are not just the
      // tail of something happening in the middle.
      n.push({ x: out.cx, y: out.cy, w: 1 });
      const d = out.rx * (out.aspect > 2.1 ? 0.62 : 0.5);
      n.push({ x: out.cx - d, y: out.cy, w: 0.72 });
      n.push({ x: out.cx + d, y: out.cy, w: 0.72 });
    } else {
      n.push({ x: out.cx, y: out.cy, w: 1 });
    }
  }

  set(0, 0, null);
  return { set, out, TAU };
}

export { TAU };
