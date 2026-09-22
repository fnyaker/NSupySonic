// RAWSTYLE — the scream in the dark.
//
// Rawstyle split off from hardstyle in 2011 and kept one half of it: "raw runs
// on heavily distorted kicks, screeches and reverse bass… it favours harsher
// sound design, minor tonalities, and cinematic, ominous breakdowns over big
// melodic climaxes". Euphoric hardstyle has the anthem; this has the SCREECH,
// which is a pitched, distorted scream that bends as it sounds.
//
// So the motif is a MOUTH in the middle of the frame — a pair of jagged bands
// that part on the screech and shut on the kick — with the picture around it
// going dark rather than bright. It is the one scene in the catalogue that
// answers a loud moment by opening a hole, because that is what the music
// sounds like: everything drops out around the scream.
//
// The screech is read off the melodic channel (`m.note`, `m.melodic`) and the
// kick shuts the mouth, so the two alternate on their own without either being
// scheduled. `m.chaos` decides how ragged the teeth are, which is the whole
// difference between rawstyle and the xtra-raw end of it.

import { clamp, hsl, lerp } from "../util.js";
import { pool, traceLine } from "./kit.js";

export const meta = { label: "Rawstyle", trail: 0.5 };

export function create(preset, opts) {
  const TEETH = 22;
  const jag = new Float32Array(TEETH);
  for (let i = 0; i < TEETH; i++) jag[i] = 0.35 + ((i * 13) % 7) / 10;
  let open = 0; // how far the mouth is parted
  let shut = 0; // the kick's slam, closing it
  const shards = pool(10, () => ({ age: -1, a: 0, r: 0, power: 0 }));
  const SHARD_LIFE = 2.2; // beats

  return {
    update(frame, dt, geom, m) {
      // The screech opens it. A melodic attack in a distorted track is a
      // screech and almost nothing else, which is why this reads `m.note`
      // rather than the onset: an onset is every drum in the bar.
      const scream = clamp(m.note * 14 + m.melodic * 0.5 + m.air * 0.3, 0, 1.3);
      open = m.ease(open, scream * (0.4 + m.drive * 0.6), 0.6, dt);

      if (m.mainKick || m.hit || (m.onBeat && m.kick > 0.3)) {
        shut = clamp(0.55 + (m.mainPower || m.kick) * 0.75, 0, 1.3);
        const s = shards.take();
        s.age = 0;
        s.a = m.barPhase * Math.PI * 2;
        s.r = 0.25 + m.weight * 0.25;
        s.power = shut;
      }
      shut = m.ease(shut, 0, 0.45, dt);
      shards.age(dt, m.beat, SHARD_LIFE);

      // The teeth crawl, slowly, so the mouth is never the same shape twice.
      // Per BAR, so it keeps time with the track rather than with the clock.
      const crawl = m.perBar(0.25) * dt * (0.4 + m.chaos);
      for (let i = 0; i < TEETH; i++) {
        jag[i] += crawl * ((i % 3) - 1);
        if (jag[i] > 1) jag[i] -= 1;
        if (jag[i] < 0) jag[i] += 1;
      }
    },

    draw(g, geom, pal, w, m) {
      const W = geom.w;
      const H = geom.h;
      // The mouth sits in the band the artwork leaves free, and — the part that
      // was wrong — it OPENS inside that band rather than through the cover.
      // Sizing the gap to a fixed share of the frame and then placing the
      // centre just below the artwork means the upper jaw bites straight back
      // up into it on every scream: measured, a quarter of this scene's ink.
      const cy = geom.hole ? geom.floorY + geom.floorH * 0.5 : H * 0.5;
      const room = geom.hole ? geom.floorH * 0.42 : H * 0.29;
      g.globalCompositeOperation = "lighter";

      // The gap, in frame heights. Shut by the kick, opened by the scream —
      // and never fully closed, or the picture would go black on every beat.
      const gap = room * (0.1 + clamp(open - shut * 0.5, 0, 1.2) * 0.9);
      const ragged = 0.35 + m.chaos * 0.9;

      for (const dir of [-1, 1]) {
        const lit = clamp(0.25 + open * 0.6 + (dir > 0 ? shut * 0.2 : 0), 0, 1);
        const a = (0.09 + lit * 0.4) * w.energy * preset.glow;
        if (a < 0.006) continue;
        g.strokeStyle = hsl(pal.low + lit * 34, pal.sat, lerp(0.42, 0.9, lit), a);
        g.lineWidth = Math.max(1.5, H * (0.006 + shut * 0.012));
        g.lineJoin = "miter";
        traceLine(g, TEETH, (t) => {
          const i = Math.min(TEETH - 1, Math.round(t * TEETH));
          // The teeth reach further out at the edges of the frame, so the
          // mouth is as wide as the screen rather than a shape in the middle.
          const bite = jag[i] * ragged * (0.5 + Math.abs(t - 0.5) * 1.4);
          return [t * W, cy + dir * (gap + bite * room * 0.35)];
        });
        g.stroke();
      }

      // The throat: a dark-to-bright wash inside the gap, so the opening reads
      // as depth rather than as a line moving.
      if (gap > room * 0.3) {
        const tg = g.createLinearGradient(0, cy - gap, 0, cy + gap);
        tg.addColorStop(0, hsl(pal.mid, pal.sat, 0.5, 0));
        tg.addColorStop(0.5, hsl(pal.high, pal.sat * 0.8, 0.7, open * 0.3 * w.energy * preset.glow));
        tg.addColorStop(1, hsl(pal.mid, pal.sat, 0.5, 0));
        g.fillStyle = tg;
        g.fillRect(0, cy - gap, W, gap * 2);
      }

      // The kick's shards, thrown OUT through the frame's corners: the scene
      // has to reach the edges, and an inscribed ring would not.
      for (const s of shards.items) {
        if (s.age < 0) continue;
        const t = s.age / SHARD_LIFE;
        const a = (1 - t) * (1 - t) * s.power * 0.34 * w.energy * preset.glow;
        if (a < 0.005) continue;
        const p0 = geom.place(s.a, s.r + t * 1.1, 0.55);
        const x0 = p0[0];
        const y0 = p0[1];
        const p1 = geom.place(s.a + 0.09, s.r + t * 1.1 + 0.16, 0.55);
        g.strokeStyle = hsl(pal.low + 8, pal.sat, lerp(0.75, 0.45, t), a);
        g.lineWidth = Math.max(1.5, geom.rMin * 0.01 * (1 - t * 0.5));
        g.lineCap = "butt";
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(p1[0], p1[1]);
        g.stroke();
      }
      g.globalCompositeOperation = "source-over";
      void opts;
    },
  };
}
