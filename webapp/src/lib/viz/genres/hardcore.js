// HARDCORE — the anthem and the wall.
//
// Mainstream / millennium hardcore is the gabber lineage grown up: the same
// enormous kick, but written as SONGS — an anthem, a breakdown, a drop, a
// vocal. It sits between gabber (which is the kick and the crowd) and
// frenchcore (which is the kick and the speed), and what it has that neither
// of them has is STRUCTURE: sixteen bars out, sixteen bars in, and everybody in
// the room knows which bar it is.
//
// So this is the one scene in the catalogue built on the ARRANGEMENT rather
// than on the beat. A wall of light rises across the frame as the phrase fills
// (`m.phrasePhase`), collapses at the drop, and the kick hammers columns out of
// it. During a breakdown the wall comes apart into its columns and drifts; on
// the drop they slam back together. `lib/audio/pattern.js` is what makes that
// possible — `m.drop`, `m.build` and `m.breakdown` did not exist before it.

import { clamp, hsl, lerp } from "../util.js";
import { pool } from "./kit.js";

export const meta = { label: "Hardcore", trail: 0.44 };

export function create(preset, opts) {
  const COLS = 24;
  const hit = new Float32Array(COLS);
  const drift = new Float32Array(COLS);
  const rings = pool(5, () => ({ age: -1, power: 0 }));
  const RING_LIFE = 3; // beats
  let wall = 0;
  let blast = 0;

  return {
    update(frame, dt, geom, m) {
      // The kick lights a column. Which one walks across the frame with the
      // bar, so a bar of four is four columns and not four flashes in one.
      if (m.mainKick || m.hit || (m.onBeat && m.kick > 0.3)) {
        const c = Math.floor(m.barPhase * COLS) % COLS;
        const power = clamp(0.55 + (m.mainPower || m.kick) * 0.8, 0, 1.4);
        for (let d = -1; d <= 1; d++) {
          const j = (c + d + COLS) % COLS;
          hit[j] = Math.max(hit[j], power * (d === 0 ? 1 : 0.45));
        }
        if (m.bigKick) {
          const r = rings.take();
          r.age = 0;
          r.power = power;
        }
      }
      // A roll rattles the whole row rather than lighting one column: it is
      // the same hit repeated, not a new place being struck.
      if (m.rollKick) for (let i = 0; i < COLS; i++) hit[i] = Math.max(hit[i], 0.2 + m.roll * 0.3);

      const fade = dt / Math.max(1e-4, m.overBeats(0.9));
      for (let i = 0; i < COLS; i++) hit[i] = Math.max(0, hit[i] - fade);
      rings.age(dt, m.beat, RING_LIFE);

      // The wall: full at the end of a phrase, gone at a breakdown, slammed
      // back by a drop.
      const want = (0.25 + m.phrasePhase * 0.75) * (1 - m.breakdown * 0.85) + m.dropped * 0.5;
      wall = m.ease(wall, clamp(want, 0, 1.3), 1.6, dt);
      if (m.drop) blast = 1.3;
      blast = m.ease(blast, 0, 1.2, dt);

      // In a breakdown the columns come apart; on the drop they snap back.
      const spread = m.breakdown * (0.4 + m.air * 0.5);
      for (let i = 0; i < COLS; i++)
        drift[i] = m.ease(drift[i], spread * (((i * 17) % 9) / 9 - 0.5) * 2, 3, dt);
    },

    draw(g, geom, pal, w, m) {
      const W = geom.w;
      const H = geom.h;
      g.globalCompositeOperation = "lighter";
      const cw = W / COLS;

      for (let i = 0; i < COLS; i++) {
        const v = clamp(hit[i] + wall * 0.4 + blast * 0.4, 0, 1.5);
        const a = (0.02 + v * 0.3) * w.energy * preset.glow;
        if (a < 0.005) continue;
        // A column is full height and full frame: the wall is the screen.
        const x = i * cw + drift[i] * cw * 2.5;
        const h = H * clamp(0.25 + v * 0.75, 0, 1);
        const y = H / 2 - h / 2;
        const hue = pal.low + (pal.high - pal.low) * (i / COLS) + v * 20;
        const cg = g.createLinearGradient(0, y, 0, y + h);
        cg.addColorStop(0, hsl(hue, pal.sat, 0.55, 0));
        cg.addColorStop(0.5, hsl(hue, pal.sat, lerp(0.5, 0.9, clamp(v, 0, 1)), a));
        cg.addColorStop(1, hsl(hue, pal.sat, 0.55, 0));
        g.fillStyle = cg;
        g.fillRect(x + cw * 0.12, y, cw * 0.76, h);
      }

      // The drop, and the big kicks inside it: a front leaving through the
      // corners rather than a circle in the middle.
      for (const r of rings.items) {
        if (r.age < 0) continue;
        const t = r.age / RING_LIFE;
        const a = (1 - t) * (1 - t) * r.power * 0.3 * w.energy * preset.glow;
        if (a < 0.005) continue;
        g.strokeStyle = hsl(pal.high, pal.sat * 0.6, lerp(0.9, 0.5, t), a);
        g.lineWidth = Math.max(2, geom.rMin * (0.02 + t * 0.05));
        g.beginPath();
        const steps = 40;
        for (let s = 0; s <= steps; s++) {
          const p = geom.place((s / steps) * Math.PI * 2, 0.1 + t * 1.3, 0.55);
          s === 0 ? g.moveTo(p[0], p[1]) : g.lineTo(p[0], p[1]);
        }
        g.closePath();
        g.stroke();
      }

      // The drop's own flash, across everything.
      if (blast > 0.04) {
        g.fillStyle = hsl(pal.high, pal.sat * 0.4, 0.95, blast * 0.1 * w.energy * preset.glow);
        g.fillRect(0, 0, W, H);
      }
      g.globalCompositeOperation = "source-over";
      void opts;
    },
  };
}
