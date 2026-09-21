// UPTEMPO — the drop forge.
//
// Uptempo (uptempo hardcore, "terror" to its neighbours) sits at 200-250 BPM
// with a kick that is longer and more distorted than frenchcore's and a
// deliberate absence of anything euphoric. Where frenchcore has an anthem over
// the violence, uptempo has more violence. So the scene is the machine that
// frenchcore's hammer belongs to, run at speed and with nothing singing.
//
// The motif is a DROP FORGE: slabs fall from the top of the frame, hit a die at
// the bottom and flatten, throwing sparks along the floor. One slab per kick.
// At 230 BPM three are in the air at once, and the picture is never still and
// never soft.
//
// The fall time is a beat and a half, always — so at 210 BPM a slab falls for
// 430 ms and at 250 for 360, and the sense of "heavier, faster, harder" comes
// out of the tempo rather than out of a number in this file.

import { clamp, hsl, lerp } from "../util.js";
import { pool, quad } from "./kit.js";

export const meta = { label: "Uptempo", trail: 0.52 };

export function create(preset, opts) {
  const FALL = 1.5; // beats from release to impact
  const slabs = pool(6, () => ({ age: -1, x: 0.5, wide: 0.3, power: 0 }));
  const sparks = pool(20, () => ({ age: -1, x: 0, vx: 0, power: 0 }));
  const SPARK_LIFE = 1.2; // beats
  let ring = 0;

  return {
    update(frame, dt, geom, m) {
      if (m.hit || (m.onBeat && m.kick > 0.28)) {
        const s = slabs.take();
        s.age = 0;
        s.power = clamp(0.5 + m.kick * 0.7, 0, 1.3);
        // Across the frame rather than always in the middle: a forge line, and
        // it keeps the picture from being one column.
        s.x = 0.16 + ((m.barPhase * 4) % 1) * 0.68;
        s.wide = lerp(0.14, 0.32, m.weight) * (0.7 + s.power * 0.5);
      }
      slabs.age(dt, m.beat, FALL + 0.6);

      // An impact is the frame a slab crosses its landing: throw sparks then,
      // not on the kick, because the picture's own timing is what the eye is
      // following by that point.
      for (const s of slabs.items) {
        if (s.age < 0 || s.landed) continue;
        if (s.age >= FALL) {
          s.landed = true;
          ring = clamp(ring + s.power * 0.7, 0, 1.4);
          const n = 3 + Math.round(m.chaos * 5);
          for (let i = 0; i < n; i++) {
            const k = sparks.take();
            k.age = 0;
            k.x = s.x;
            k.vx = (i / n - 0.5) * lerp(1.2, 3.4, m.chaos) * (0.6 + s.power);
            k.power = s.power * (0.4 + (i % 3) / 3);
          }
        }
      }
      for (const s of slabs.items) if (s.age < 0) s.landed = false;
      sparks.age(dt, m.beat, SPARK_LIFE);
      ring = m.ease(ring, 0, 0.6, dt);
    },

    draw(g, geom, pal, w, m) {
      const W = geom.w;
      const H = geom.h;
      const die = geom.hole ? Math.min(H * 0.96, geom.cy + geom.hh + H * 0.1) : H * 0.82;
      g.globalCompositeOperation = "lighter";

      // The die: the anvil everything lands on, lit by whatever just hit it.
      const dg = g.createLinearGradient(0, die - H * 0.04, 0, die + H * 0.06);
      dg.addColorStop(0, hsl(pal.low, pal.sat, 0.5, 0));
      dg.addColorStop(0.45, hsl(pal.high, pal.sat * 0.7, 0.78, (0.08 + ring * 0.4) * w.energy * preset.glow));
      dg.addColorStop(1, hsl(pal.low, pal.sat, 0.4, 0));
      g.fillStyle = dg;
      g.fillRect(0, die - H * 0.04, W, H * 0.1);

      // The slabs. Accelerating, because they are falling — a linear descent
      // reads as a lift going down.
      for (const s of slabs.items) {
        if (s.age < 0) continue;
        const t = clamp(s.age / FALL, 0, 1);
        const fall = t * t;
        const flat = clamp((s.age - FALL) / 0.6, 0, 1);
        const y = lerp(-H * 0.2, die, fall);
        // On impact it spreads sideways and loses height: the metal deforms.
        const halfW = W * s.wide * (1 + flat * 0.7) * 0.5;
        const thick = H * (0.07 + s.power * 0.04) * (1 - flat * 0.75);
        const a = (0.12 + s.power * 0.3 * (1 - flat * 0.6)) * w.energy * preset.glow;
        if (a < 0.006) continue;
        const x = s.x * W;
        const hue = pal.low + s.power * 26;
        const sg = g.createLinearGradient(x, y - thick, x, y);
        sg.addColorStop(0, hsl(hue, pal.sat, lerp(0.5, 0.85, t), a * 0.5));
        sg.addColorStop(1, hsl(hue + 12, pal.sat, lerp(0.6, 0.95, t), a));
        g.fillStyle = sg;
        quad(g, x - halfW, y - thick, x + halfW, y - thick, x + halfW * 1.04, y, x - halfW * 1.04, y);
        g.fill();
      }

      // Sparks, along the floor. They travel, they do not rise: this is metal
      // on metal, not a firework.
      for (const k of sparks.items) {
        if (k.age < 0) continue;
        const t = k.age / SPARK_LIFE;
        const a = (1 - t) * (1 - t) * k.power * 0.5 * w.energy * preset.glow;
        if (a < 0.005) continue;
        const x = (k.x + k.vx * t * 0.3) * W;
        const y = die - H * 0.01 - t * H * 0.03;
        const len = W * 0.02 * (0.5 + Math.abs(k.vx));
        g.strokeStyle = hsl(pal.high, pal.sat * 0.5, 0.95, a);
        g.lineWidth = Math.max(1, H * 0.003 * (1 - t));
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(x - len * Math.sign(k.vx), y);
        g.lineTo(x, y);
        g.stroke();
      }
      g.globalCompositeOperation = "source-over";
      void opts;
    },
  };
}
