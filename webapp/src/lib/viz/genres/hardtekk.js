// HARDTEKK — the swing.
//
// German hardtekk is not French hardtek with a different spelling. The kick is
// SHORT and heavily saturated rather than long and rolling, the melodic content
// is almost nothing, and the identity of the genre is in the hats and claps:
// they are shuffled, and that shuffle leans the whole groove forward. Anyone
// who has heard it can pick it out of a hard-dance set in two bars from the
// swing alone.
//
// So the scene draws the swing and nothing else much. A body bounces across a
// grid, and it does not land on the half — it lands LATE, on the swung
// sixteenth, and the picture is built so that lateness is the visible feature:
// the grid marks where a straight beat would be, and the body is visibly past
// it. Hats are small ticks placed on the same swung positions.
//
// The swing amount is not a constant. It is read from where the actual onsets
// fall inside the beat: a straight track pulls it toward 0.5 and a heavily
// shuffled one toward 0.62, so the picture leans as much as the track does.

import { clamp, hsl, lerp } from "../util.js";
import { pool } from "./kit.js";

export const meta = { label: "Hardtekk", trail: 0.4 };

export function create(preset, opts) {
  // Where in the beat the offbeat events actually land, averaged over bars.
  let swing = 0.55;
  let bounce = 0; // the body's height, 0 on the floor
  let squash = 0;
  let lastHalf = -1;
  const hats = pool(12, () => ({ age: -1, x: 0, power: 0 }));
  const HAT_LIFE = 1.2; // beats

  return {
    update(frame, dt, geom, m) {
      // Measure the shuffle. An onset in the second half of the beat tells us
      // where that half is being played; averaged slowly, that IS the swing.
      if (m.onset > 0.35 && m.beatPhase > 0.35 && m.beatPhase < 0.95) {
        swing = m.ease(swing, clamp(m.beatPhase, 0.5, 0.72), 8, dt);
      }

      // The body: thrown up on the beat, landing on the swung offbeat, thrown
      // again on the next beat. Its height is a parabola over the beat, which
      // is what a bounce is — and the apex sits at the swing point, not at 0.5.
      const p = m.beatPhase;
      const apex = swing;
      const h = p < apex ? p / apex : 1 - (p - apex) / (1 - apex);
      bounce = Math.max(0, Math.sin(h * Math.PI * 0.5));

      if (m.hit || (m.onBeat && m.kick > 0.25)) squash = 0.3 + m.kick * 0.4 * m.punch;
      squash = m.ease(squash, 0, 0.3, dt);

      // Hats on the swung sixteenths. Fired from the actual high-band flux, so
      // a bar with no hats draws none.
      const half = Math.floor(p * 4) + Math.floor(m.barPhase * 16) * 4;
      if (half !== lastHalf) {
        lastHalf = half;
        const hi = (frame.features?.highFlux || 0) * 60;
        if (hi > 0.3) {
          const t = hats.take();
          t.age = 0;
          t.power = clamp(hi, 0.3, 1);
          t.x = (half % 8) / 8;
        }
      }
      hats.age(dt, m.beat, HAT_LIFE);
    },

    draw(g, geom, pal, w, m) {
      const W = geom.w;
      const H = geom.h;
      const floor = H * 0.78;
      g.globalCompositeOperation = "lighter";

      // The grid: eight marks across, at the STRAIGHT positions. They are the
      // reference the swing is late against, so they are deliberately even and
      // deliberately dim.
      g.strokeStyle = hsl(pal.mid, pal.sat * 0.4, 0.55, 0.07 * w.energy);
      g.lineWidth = Math.max(1, H * 0.0015);
      g.beginPath();
      for (let i = 0; i <= 8; i++) {
        const x = (i / 8) * W;
        g.moveTo(x, floor - H * 0.02);
        g.lineTo(x, floor + H * 0.02);
      }
      g.stroke();

      // ...and the swung positions, marked brighter. Seeing the two rows of
      // marks side by side is what makes the lateness legible rather than just
      // a thing the animation happens to do.
      g.strokeStyle = hsl(pal.high, pal.sat * 0.7, 0.75, (0.05 + m.drive * 0.1) * w.energy);
      g.lineWidth = Math.max(1.5, H * 0.0025);
      g.beginPath();
      for (let i = 0; i < 4; i++) {
        const x = ((i + swing) / 4) * W;
        g.moveTo(x, floor - H * 0.035);
        g.lineTo(x, floor + H * 0.035);
      }
      g.stroke();

      // The hats: ticks above the floor at whatever swung position fired them.
      for (const t of hats.items) {
        if (t.age < 0) continue;
        const k = 1 - t.age / HAT_LIFE;
        const a = k * k * t.power * 0.4 * w.energy * preset.glow;
        if (a < 0.005) continue;
        const x = t.x * W;
        g.strokeStyle = hsl(pal.high + 20, pal.sat * 0.5, 0.9, a);
        g.lineWidth = Math.max(1, H * 0.003);
        g.beginPath();
        g.moveTo(x, floor - H * (0.08 + t.power * 0.06));
        g.lineTo(x, floor - H * 0.05);
        g.stroke();
      }

      // THE BODY. Travelling left to right over one bar, bouncing once a beat,
      // squashing flat at the moment it lands.
      const x = m.barPhase * W;
      const y = floor - bounce * H * (0.24 + m.drive * 0.16);
      const r = geom.rMin * (0.09 + m.weight * 0.05);
      const rx = r * (1 + squash * 0.7);
      const ry = r * (1 - squash * 0.5);
      g.save();
      g.translate(x, y);
      g.scale(1, Math.max(0.08, ry / Math.max(1, rx)));
      const bg = g.createRadialGradient(0, 0, 0, 0, 0, Math.max(1, rx));
      bg.addColorStop(0, hsl(pal.high, pal.sat, 0.92, (0.3 + squash * 0.5) * w.energy * preset.glow));
      bg.addColorStop(0.5, hsl(pal.mid, pal.sat, 0.7, 0.2 * w.energy * preset.glow));
      bg.addColorStop(1, hsl(pal.low, pal.sat, 0.5, 0));
      g.fillStyle = bg;
      g.beginPath();
      g.arc(0, 0, Math.max(1, rx), 0, Math.PI * 2);
      g.fill();
      g.restore();

      // The floor line, lit where the body is about to land: the impact is
      // announced, which is what a groove this forward-leaning feels like.
      const lead = clamp(1 - bounce, 0, 1);
      const fg = g.createLinearGradient(x - W * 0.2, 0, x + W * 0.2, 0);
      fg.addColorStop(0, hsl(pal.low, pal.sat, 0.5, 0));
      fg.addColorStop(0.5, hsl(pal.mid, pal.sat, 0.7, lead * 0.18 * w.energy * preset.glow));
      fg.addColorStop(1, hsl(pal.low, pal.sat, 0.5, 0));
      g.fillStyle = fg;
      g.fillRect(0, floor - H * 0.006, W, H * 0.012);
      g.globalCompositeOperation = "source-over";
      void opts;
      void lerp;
    },
  };
}
