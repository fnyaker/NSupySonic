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

import { approach, clamp, envelope, hsl, lerp } from "../util.js";

const TAU = Math.PI * 2;
const MAX_RINGS = 14;

export function createTunnelWorld(preset, opts) {
  const rings = [];
  for (let i = 0; i < MAX_RINGS; i++) rings.push({ z: -1, power: 0 });
  let next = 0;
  let kick = 0;
  let grit = 0;
  let scan = 0;
  let sinceRing = 0;

  function spawn(power) {
    const r = rings[(next = (next + 1) % MAX_RINGS)];
    r.z = 1;
    r.power = power;
  }

  return {
    update(frame, dt) {
      const beat = frame.beat;
      const f = frame.features;
      kick = envelope(kick, clamp((f.kick || 0) * 1.2, 0, 1), dt, 0.006, 0.14);
      grit = approach(grit, frame.style?.look?.chaos ?? 0.2, 1.2, dt);
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
      const v = dt / (every * 3);
      for (const r of rings) {
        if (r.z < 0) continue;
        r.z -= v;
        if (r.z <= 0) r.z = -1;
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
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2;
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
      const steps = 4;
      for (const r of rings) {
        if (r.z < 0) continue;
        const t = 1 - r.z * r.z;
        const a = (0.1 + 0.9 * t) * r.power * 0.5 * w.energy * preset.glow;
        if (a < 0.004) continue;
        const hue = pal.low + (pal.high - pal.low) * r.z;
        g.strokeStyle = hsl(hue, pal.sat * 0.75, 0.62, a);
        g.lineWidth = Math.max(1.5, geom.rMin * 0.03 * t * (0.5 + r.power));
        g.beginPath();
        for (let i = 0; i <= steps; i++) {
          const ang = Math.PI / 4 + (i / steps) * TAU;
          const p = geom.place(ang, 0.06 + t * 1.02);
          i === 0 ? g.moveTo(p[0], p[1]) : g.lineTo(p[0], p[1]);
        }
        g.closePath();
        g.stroke();
      }

      // The kick lights the whole corridor from the far end.
      if (kick > 0.01) {
        const inner = geom.hole ? Math.min(geom.hw, geom.hh) * 0.8 : 0;
        const gr = g.createRadialGradient(cx, cy, inner, cx, cy, Math.max(inner + 1, geom.rMax));
        gr.addColorStop(0, hsl(pal.high, pal.sat * 0.8, 0.6, 0.5 * kick * w.energy * preset.glow));
        gr.addColorStop(0.45, hsl(pal.mid, pal.sat * 0.7, 0.5, 0.12 * kick * w.energy));
        gr.addColorStop(1, hsl(pal.low, pal.sat * 0.6, 0.4, 0));
        g.fillStyle = gr;
        g.fillRect(0, 0, geom.w, geom.h);
      }

      // Industrial gets the machine's own noise: horizontal scan bars crawling
      // down the picture, at a rate its `chaos` sets.
      if (grit > 0.3 && preset.layers >= 3) {
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
