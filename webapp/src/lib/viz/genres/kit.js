// Low-level drawing help for the dedicated genre animations.
//
// Deliberately NOT a set of motifs. The mistake this whole directory exists to
// correct was building every genre out of one shared vocabulary at different
// strengths, and a kit full of "draw a bloom", "draw a ring" would rebuild that
// mistake one level down. What is in here is the stuff that is genuinely the
// same problem everywhere — mapping a polar coordinate onto a 16:9 frame,
// stroking a polyline, keeping a pool of events — and every genre spends it on
// something different.

import { clamp, hsl } from "../util.js";

/**
 * A closed shape traced on the FRAME's polar mapping. `shape(t)` returns
 * `[angle, radial]` for t in 0..1; `aniso` is passed straight to geom.place.
 *
 * Every point is read out before the next call, because `place` hands back one
 * shared array (see geometry.js) and holding two at once silently collapses the
 * segment between them to nothing.
 */
export function tracePolar(g, geom, steps, shape, aniso = 1) {
  g.beginPath();
  for (let i = 0; i <= steps; i++) {
    const [a, r] = shape(i / steps);
    const p = geom.place(a, r, aniso);
    const x = p[0];
    const y = p[1];
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
}

/** The same, for a line: `shape(t)` returns `[x, y]` in frame coordinates. */
export function traceLine(g, steps, shape) {
  g.beginPath();
  for (let i = 0; i <= steps; i++) {
    const [x, y] = shape(i / steps);
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
}

/**
 * A fixed-size pool of events. Genres are full of "a thing happens, it lives
 * for a while, it dies" and doing that with an array that grows is how a scene
 * allocates a thousand objects a second.
 */
export function pool(n, make) {
  const items = [];
  for (let i = 0; i < n; i++) items.push(make(i));
  let next = 0;
  return {
    items,
    take() {
      next = (next + 1) % n;
      return items[next];
    },
    /** Age everything by `dt` in BEATS, and retire whatever is past `life`. */
    age(dt, beat, life) {
      const step = dt / Math.max(1e-4, beat);
      for (const it of items) {
        if (it.age < 0) continue;
        it.age += step;
        if (it.age > life) it.age = -1;
      }
    },
  };
}

/** A hard-edged quad, the workhorse of anything that reads as machinery. */
export function quad(g, x0, y0, x1, y1, x2, y2, x3, y3) {
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.lineTo(x2, y2);
  g.lineTo(x3, y3);
  g.closePath();
}

/**
 * A shock front expanding along the frame's own edge rather than as a circle,
 * so on a 16:9 screen it reaches the sides and the corners instead of
 * inscribing itself in the middle. Shared because the *mapping* is the same
 * problem everywhere; what each genre does with it is not.
 */
export function shock(g, geom, t, width, hue, sat, light, alpha, aniso = 0.55) {
  if (alpha < 0.004) return;
  g.strokeStyle = hsl(hue, sat, light, alpha);
  g.lineWidth = Math.max(1.5, width);
  tracePolar(g, geom, 44, (u) => [u * Math.PI * 2, t], aniso);
  g.closePath();
  g.stroke();
}

/** 0..1 → 0..1..0, for anything that should rise and fall over its life. */
export const arc01 = (t) => Math.sin(Math.PI * clamp(t, 0, 1));
