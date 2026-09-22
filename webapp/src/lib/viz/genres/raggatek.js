// RAGGATEK — the sound system, and the skank between the kicks.
//
// Raggatek is French hardtek carrying Jamaican ragga: the 4/4 and the overdriven
// kick of a free party, with a toasted vocal over it and — the thing that makes
// it raggatek and not hardtek — an OFF-BEAT SKANK. The stab lands between the
// kicks, on the and, exactly where a reggae guitar chop goes. Every other genre
// in this directory is built around what happens ON the beat; this one is built
// around what happens between them, and the picture has to say so.
//
// So the frame is a sound system seen head on: two stacks of speaker boxes at
// the sides, breathing on the four. And in the gap between every pair of kicks,
// a SKANK — a hard bright bar thrown across the middle, on the off-beat, which
// is the only thing in here that is allowed to be loud. The kicks move the
// boxes; the skank cuts the room.
//
// The vocal is a horn: a slow bend that rises across the phrase when there is a
// sustained voice in the mix, and is simply absent when there is not.

import { clamp, hsl, lerp } from "../util.js";
import { pool, quad } from "./kit.js";

export const meta = { label: "Raggatek", trail: 0.34 };

export function create(preset, opts) {
  // Four boxes a side, sized like a real stack: the bass bins at the bottom.
  const BOXES = 4;
  const left = new Float32Array(BOXES);
  const right = new Float32Array(BOXES);
  const skanks = pool(4, () => ({ age: -1, y: 0.5, power: 0, dir: 1 }));
  const SKANK_LIFE = 0.9; // beats — it is a chop, it does not linger
  let lastHalf = -1;
  let horn = 0;

  return {
    update(frame, dt, geom, m) {
      // The stacks. Each box follows a band, bass at the bottom, and the whole
      // thing punches on the kick — a rig moves as one object.
      const e = frame.energy;
      if (e) {
        const total = e.sub + e.bass + e.lowMid + e.mid + e.high + e.air + 1e-12;
        const bands = [
          (e.sub + e.bass) / total,
          e.lowMid / total,
          e.mid / total,
          (e.high + e.air) / total,
        ];
        for (let i = 0; i < BOXES; i++) {
          const v = clamp(bands[i] * 2.6, 0, 1);
          // The two stacks are not in sync: a real rig is two piles of boxes,
          // and driving them from the same number makes one wide speaker.
          left[i] = m.ease(left[i], v, 0.25 + i * 0.1, dt);
          right[i] = m.ease(right[i], v, 0.3 + i * 0.12, dt);
        }
      }

      // THE SKANK. Half-beat positions 1 and 3 are the offbeats; fire there,
      // and only when there is actually something in the mid band to fire on,
      // so a bar with no stab draws no bar.
      const half = Math.floor(m.beatPhase * 2) + Math.floor(m.barPhase * 8) * 2;
      if (half !== lastHalf) {
        lastHalf = half;
        const offbeat = m.beatPhase > 0.45 && m.beatPhase < 0.8;
        const stab = (frame.features?.midFlux || 0) * 50 + m.onset * 0.5;
        if (offbeat && stab > 0.35) {
          const s = skanks.take();
          s.age = 0;
          s.power = clamp(stab, 0.4, 1.2);
          s.y = 0.32 + ((half * 0.37) % 1) * 0.36;
          s.dir = half % 2 ? 1 : -1;
        }
      }
      skanks.age(dt, m.beat, SKANK_LIFE);

      // The toast: a sustained voice, held over bars rather than frames.
      horn = m.ease(horn, clamp((frame.features?.vocalMod || 0) * 1.6, 0, 1), 3, dt);
    },

    draw(g, geom, pal, w, m) {
      const W = geom.w;
      const H = geom.h;
      g.globalCompositeOperation = "lighter";
      // The stack punches outward on the kick: the boxes physically move.
      const punch = m.kick * m.punch * 0.03;
      const bw = W * (0.1 + m.weight * 0.03);

      for (const side of [-1, 1]) {
        const amps = side < 0 ? left : right;
        const x0 = side < 0 ? -punch * W : W - bw + punch * W;
        for (let i = 0; i < BOXES; i++) {
          const v = amps[i];
          // A box with nothing coming out of it is not lit. Drawing the whole
          // stack whatever the music is doing made a breakdown and a drop the
          // same picture, which is what the "answers the moment" test is for.
          if (v < 0.04 && i > 0) continue;
          // Bass bins are wide and short, tops are narrow and tall — which is
          // what a stack actually looks like and why it reads as one.
          const hFrac = i === 0 ? 0.34 : 0.22;
          const y0 = H * (0.12 + i * 0.2);
          const inset = bw * (i === 0 ? 0 : 0.12 * i);
          const a = (0.05 + v * 0.3) * w.energy * preset.glow;
          const hue = pal.low + (pal.high - pal.low) * (i / BOXES);
          g.fillStyle = hsl(hue, pal.sat, lerp(0.42, 0.75, v), a);
          quad(
            g,
            x0 + inset, y0,
            x0 + bw - inset, y0,
            x0 + bw - inset, y0 + H * hFrac,
            x0 + inset, y0 + H * hFrac
          );
          g.fill();
          // The cone: a bright disc in the middle of the box, driven by the
          // band. It is what stops the stack reading as a stack of rectangles.
          if (v > 0.06) {
            const cx = x0 + bw / 2;
            const cy = y0 + H * hFrac * 0.5;
            const cr = Math.min(bw, H * hFrac) * (0.22 + v * 0.26);
            const cg = g.createRadialGradient(cx, cy, 0, cx, cy, cr);
            cg.addColorStop(0, hsl(hue + 14, pal.sat, 0.85, v * 0.5 * w.energy * preset.glow));
            cg.addColorStop(1, hsl(hue, pal.sat, 0.5, 0));
            g.fillStyle = cg;
            g.beginPath();
            g.arc(cx, cy, cr, 0, Math.PI * 2);
            g.fill();
          }
        }
      }

      // THE SKANK, across the middle, between the stacks. Hard-edged and short.
      for (const s of skanks.items) {
        if (s.age < 0) continue;
        const t = s.age / SKANK_LIFE;
        const a = (1 - t) * (1 - t) * s.power * 0.55 * w.energy * preset.glow;
        if (a < 0.005) continue;
        const y = s.y * H;
        const reach = lerp(0.15, 1, t) * W;
        const thick = H * (0.012 + s.power * 0.02) * (1 - t * 0.5);
        const gr = g.createLinearGradient(
          s.dir > 0 ? bw : W - bw, y, s.dir > 0 ? bw + reach : W - bw - reach, y
        );
        gr.addColorStop(0, hsl(pal.high, pal.sat * 0.6, 0.95, a));
        gr.addColorStop(1, hsl(pal.mid, pal.sat, 0.6, 0));
        g.fillStyle = gr;
        g.fillRect(s.dir > 0 ? bw : W - bw - reach, y - thick / 2, reach, thick);
      }

      // The toast: a bent horn across the upper frame, only when there is a
      // voice. Its bend follows the melody's pitch, so it moves with the MC.
      if (horn > 0.08) {
        const pitch = clamp(m.melodic * 0.4 + 0.3, 0, 1);
        g.strokeStyle = hsl(pal.high + 20, pal.sat, 0.8, horn * 0.22 * w.energy * preset.glow);
        g.lineWidth = Math.max(2, H * 0.006 * (0.5 + horn));
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(bw, H * 0.2);
        g.quadraticCurveTo(W * 0.5, H * (0.2 - pitch * 0.14 - horn * 0.06), W - bw, H * 0.2);
        g.stroke();
      }
      g.globalCompositeOperation = "source-over";
      void opts;
    },
  };
}
