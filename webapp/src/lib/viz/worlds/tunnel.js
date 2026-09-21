// TECHNO / HARDTECHNO / INDUSTRIAL — a machine corridor.
//
// The motif is a perspective tunnel: a new frame-shaped ring is laid down on
// every beat and rushes at the viewer, so the picture is literally built out of
// the beat grid. Nothing in here is random, because nothing in the music is:
// the rings are evenly spaced, the corridor edges are fixed, and the only thing
// that moves off the grid is the brightness.
//
// It fills any frame by construction — the rings ARE the frame's shape
// (geometry.place at aniso 1) — and with artwork in the middle the corridor
// simply runs around it.
//
// The skin reshapes the corridor itself, which is how eleven machine genres get
// eleven corridors: `sides` is its cross-section (a four-sided shaft for techno,
// a twenty-four-sided bore for acid), `twist` turns each ring against the one
// behind it so the shaft becomes a helix, `dir` -1 sends the rings AWAY from the
// viewer instead of at them (minimal and dub techno recede, hardtechno charges),
// `dash` breaks each ring into segments with gaps — a strobing machine rather
// than a solid one — and `depth` is how many beats a ring takes to cross.

import { approach, clamp, envelope, hsl, lerp } from "../util.js";

const TAU = Math.PI * 2;
const MAX_RINGS = 14;

export function createTunnelWorld(preset, opts, skin = {}) {
  const p = skin.p || {};
  // How many sides the corridor has. Four is a rectangular shaft (techno),
  // twenty-four is a bore (acid), and the genre decides which.
  const SIDES = Math.max(3, Math.round(p.sides ?? 4));
  const SPOKES = Math.max(0, Math.round(p.spokes ?? 4));
  const SCAN = p.scan ?? 0.15;
  const GLOW = p.glow ?? 1;
  const TWIST = p.twist ?? 0;
  const DIR = (p.dir ?? 1) < 0 ? -1 : 1;
  const DASH = clamp(p.dash ?? 0, 0, 0.9);
  const DEPTH = Math.max(1.2, 3 * (p.depth ?? 1));
  const SPEED = skin.speed ?? 1;
  const SIDE_INK = Math.min(1, Math.max(0.5, 7 / SIDES));
  const rings = [];
  for (let i = 0; i < MAX_RINGS; i++) rings.push({ z: -1, power: 0 });
  let next = 0;
  let kick = 0;
  let grit = 0;
  let scan = 0;
  let sinceRing = 0;

  function spawn(power) {
    const r = rings[(next = (next + 1) % MAX_RINGS)];
    // A corridor that recedes starts its rings at the viewer and sends them
    // down it; one that charges starts them at the far end. Same track, same
    // spacing, opposite reading — which is exactly the difference between
    // minimal and hardtechno.
    // A ring's radius is `0.06 + (1 - z²) · 1.02`, so z near 0 puts it PAST
    // the frame's edge. A corridor charging at the viewer wants that (the ring
    // leaves the picture at the end of its life), but one receding starts
    // there — and at z = 0.02 it spent its whole bright phase outside the frame
    // and only became visible once it was dim. 0.25 puts it on the edge.
    r.z = DIR > 0 ? 1 : 0.25;
    r.power = power;
  }

  return {
    update(frame, dt) {
      const beat = frame.beat;
      const f = frame.features;
      kick = envelope(kick, clamp((f.kick || 0) * 1.2, 0, 1), dt, 0.006, 0.14);
      grit = approach(grit, Math.max(SCAN, frame.style?.look?.chaos ?? 0.2), 1.2, dt);
      sinceRing += dt;
      // One ring per beat while the grid holds; a steady fallback cadence when
      // it does not, because a corridor that stops advancing looks broken.
      const every = beat.locked ? beat.period : 0.5;
      if ((beat.beat && beat.locked) || sinceRing > every * 1.6) {
        spawn(beat.downbeat ? 1 : 0.6 + (f.kick || 0) * 0.4);
        sinceRing = 0;
      }
      // Depth travel: a ring crosses the corridor in two beats, so there are
      // always a couple in flight and the spacing reads as speed.
      // Three beats to cross, so there are always three rings in flight: two
      // is a pair of rectangles, three reads as a corridor.
      const v = (dt * SPEED) / (every * DEPTH);
      for (const r of rings) {
        if (r.z < 0) continue;
        r.z -= v * DIR;
        if (r.z <= 0 || r.z >= 1) r.z = -1;
      }
      scan = (scan + dt * lerp(0.1, 0.5, grit)) % 1;
    },

    draw(g, geom, pal, w) {
      const cx = geom.cx;
      const cy = geom.cy;
      g.globalCompositeOperation = "lighter";

      // The corridor's own edges: four fixed lines from the middle out through
      // the corners. Two of them and the rings stop being a tunnel and start
      // being a stack of rectangles.
      g.strokeStyle = hsl(pal.mid, pal.sat * 0.4, 0.55, 0.1 * w.energy);
      g.lineWidth = Math.max(1, geom.rMin * 0.004);
      g.beginPath();
      for (let i = 0; i < SPOKES; i++) {
        const a = Math.PI / 4 + (i * TAU) / Math.max(1, SPOKES);
        const inner = geom.place(a, 0.02);
        const x0 = inner[0];
        const y0 = inner[1];
        const outer = geom.place(a, 1);
        g.moveTo(x0, y0);
        g.lineTo(outer[0], outer[1]);
      }
      g.stroke();

      // The rings. `1 - z²` puts them closer together far away and further
      // apart as they arrive, which is what perspective does and what makes the
      // corridor read as depth rather than as a target.
      const steps = SIDES;
      for (const r of rings) {
        if (r.z < 0) continue;
        const t = 1 - r.z * r.z;
        // A ring charging at the viewer is faint far away and bright as it
        // arrives, so its brightness and its size grow together. Receding, the
        // two FALL together — and a ring that shrinks and dims at the same
        // rate has vanished by the time it is halfway down the corridor, which
        // is how minimal ended up rendering at a third of every other skin on
        // this world. Going away, the near end stays lit.
        const ramp = DIR > 0 ? 0.1 + 0.9 * t : 0.5 + 0.5 * t;
        // A ring's ink scales with its PERIMETER, and its perimeter is set by
        // how many sides it has: a four-sided shaft cuts straight chords well
        // inside the frame, a twenty-four-sided bore hugs the frame's whole
        // outline. At one alpha the bore is several times the light of the
        // shaft for the same nominal brightness, which is how acid techno came
        // out blown when techno did not.
        const a = ramp * r.power * 0.5 * SIDE_INK * w.energy * preset.glow;
        if (a < 0.004) continue;
        const hue = pal.low + (pal.high - pal.low) * r.z;
        g.strokeStyle = hsl(hue, pal.sat * 0.75, 0.62, a);
        g.lineWidth = Math.max(1.5, geom.rMin * 0.03 * t * (0.5 + r.power));
        // Each ring is twisted by its own depth, so successive rings no longer
        // line up and the shaft reads as a screw instead of a stack.
        const roll = Math.PI / 4 + TWIST * r.z * TAU * 0.25;
        const rad = 0.06 + t * 1.02;
        if (DASH > 0.02) {
          // Drawn side by side with a gap, rather than as one closed outline:
          // a machine that strobes is not the same machine as one that hums,
          // and a dashed ring is the difference at a glance.
          g.beginPath();
          for (let i = 0; i < steps; i++) {
            const a0 = roll + (i / steps) * TAU;
            const a1 = roll + ((i + 1 - DASH) / steps) * TAU;
            // `place` returns ONE shared array (see geometry.js): holding two
            // of its results at once aliases them, the segment collapses to a
            // point and the whole ring draws nothing. Read the first out before
            // asking for the second.
            const q0 = geom.place(a0, rad);
            const x0 = q0[0];
            const y0 = q0[1];
            const q1 = geom.place(a1, rad);
            g.moveTo(x0, y0);
            g.lineTo(q1[0], q1[1]);
          }
          g.stroke();
        } else {
          g.beginPath();
          for (let i = 0; i <= steps; i++) {
            const q = geom.place(roll + (i / steps) * TAU, rad);
            i === 0 ? g.moveTo(q[0], q[1]) : g.lineTo(q[0], q[1]);
          }
          g.closePath();
          g.stroke();
        }
      }

      // The kick lights the whole corridor from the far end.
      if (kick > 0.01) {
        const inner = geom.hole ? Math.min(geom.hw, geom.hh) * 0.8 : 0;
        const gr = g.createRadialGradient(cx, cy, inner, cx, cy, Math.max(inner + 1, geom.rMax));
        gr.addColorStop(0, hsl(pal.high, pal.sat * 0.8, 0.6, 0.5 * GLOW * kick * w.energy * preset.glow));
        gr.addColorStop(0.45, hsl(pal.mid, pal.sat * 0.7, 0.5, 0.12 * kick * w.energy));
        gr.addColorStop(1, hsl(pal.low, pal.sat * 0.6, 0.4, 0));
        g.fillStyle = gr;
        g.fillRect(0, 0, geom.w, geom.h);
      }

      // Industrial gets the machine's own noise: horizontal scan bars crawling
      // down the picture, at a rate its `chaos` sets.
      if (SCAN > 0.05 && grit > 0.25 && preset.layers >= 3) {
        const bars = 5;
        g.fillStyle = hsl(pal.mid, pal.sat * 0.3, 0.7, 0.05 * grit * w.energy);
        for (let i = 0; i < bars; i++) {
          const y = (((scan + i / bars) % 1) * (geom.h + 80) - 40) | 0;
          g.fillRect(0, y, geom.w, Math.max(2, geom.h * 0.012));
        }
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}
