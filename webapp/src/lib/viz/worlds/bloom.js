// POP / DANCE / HOUSE / DISCO / FUNK / SOUL / R&B / AFRO / AMAPIANO / INDIE —
// blooms and confetti.
//
// This music is written to feel good in a room full of people, and the visual
// that belongs to it is generous rather than aggressive: soft circles opening
// on the beat from several points at once, warm light, and a throw of confetti
// on the downbeat. It is the brightest world in the set on purpose — everything
// else is lit out of darkness, this one is lit out of colour.
//
// The blooms come from `geometry.nodes`, so on a wide screen there are three of
// them spread across it and beside artwork there is one on each flank — the
// scene is never one circle in the middle.
//
// Eighteen genres open out of this one, so the skin changes what a bloom IS:
// `petal` gives it lobes, and a five-lobed flower and a plain ring are not the
// same picture at any brightness (disco and k-pop bloom in petals, deep house
// never does). `ray` fires spokes of light out of each one — a mirror ball.
// `float` is the confetti's gravity and it may be NEGATIVE, so amapiano and
// soul rise where eurodance falls.

import { approach, clamp, envelope, hsl, lerp, rng } from "../util.js";

const TAU = Math.PI * 2;

export function createBloomWorld(preset, opts, skin = {}) {
  const p = skin.p || {};
  const BLOOMS = p.blooms ?? 1;
  const CONFETTI = p.confetti ?? 1;
  const VOICE = p.voice ?? 1;
  const PETAL = Math.max(0, Math.round(p.petal ?? 0));
  const RAY = clamp(p.ray ?? 0, 0, 2);
  const FLOAT = p.float ?? 1;
  const MAX = 10;
  const blooms = [];
  for (let i = 0; i < MAX; i++) blooms.push({ age: -1, node: 0, hue: 0, p: 0 });
  let next = 0;
  const N = Math.max(24, Math.floor(preset.particles * 0.8));
  const conf = new Float32Array(N * 6); // x, y, vx, vy, life, seed
  let confNext = 0;
  const rand = rng(2468);
  let level = 0;
  let warm = 0.7;
  let melodic = 0.7;
  let vocal = 0;

  return {
    update(frame, dt, geom) {
      const f = frame.features;
      const beat = frame.beat;
      const look = frame.style?.look;
      warm = approach(warm, look ? look.warm : 0.7, 1.2, dt);
      melodic = approach(melodic, look ? look.melodic : 0.7, 1.2, dt);
      level = approach(level, f.level || 0, 0.2, dt);
      vocal = envelope(vocal, f.vocalMod || 0, dt, 0.06, 0.4);

      const nodes = geom.nodes.length || 1;
      if (beat.beat || (!beat.locked && beat.onset > 0.5)) {
        const b = blooms[(next = (next + 1) % MAX)];
        b.age = 0;
        b.node = (rand() * nodes) | 0;
        b.hue = (rand() - 0.5) * 50;
        b.p = (0.55 + (f.kick || 0) * 0.5) * BLOOMS;
      }
      for (const b of blooms) {
        if (b.age < 0) continue;
        b.age += dt;
        if (b.age > 1.1) b.age = -1;
      }

      // Confetti on the downbeat — the one moment a room throws its hands up.
      if (beat.downbeat && !opts.reducedMotion) {
        const n = Math.min(20, Math.round((5 + level * 12) * CONFETTI));
        for (let k = 0; k < n; k++) {
          const i = (confNext = (confNext + 1) % N) * 6;
          conf[i] = 0.1 + rand() * 0.8;
          conf[i + 1] = 0.25 + rand() * 0.3;
          conf[i + 2] = (rand() - 0.5) * 0.35;
          // Thrown up, then carried by whichever way this genre's gravity runs.
        conf[i + 3] = (-0.25 - rand() * 0.45) * (FLOAT < 0 ? 0.4 : 1);
          conf[i + 4] = 1;
          conf[i + 5] = rand();
        }
      }
      for (let k = 0; k < N; k++) {
        const i = k * 6;
        if (conf[i + 4] <= 0) continue;
        conf[i] += conf[i + 2] * dt;
        conf[i + 1] += conf[i + 3] * dt;
        conf[i + 3] += dt * 0.55 * FLOAT; // gravity, or lift where it is negative
        conf[i + 4] -= dt * 0.5;
      }
    },

    draw(g, geom, pal, w) {
      g.globalCompositeOperation = "lighter";
      const nodes = geom.nodes;

      // A warm floor of light, so the world is bright rather than dark with
      // things in it.
      const inner = geom.hole ? Math.min(geom.hw, geom.hh) * 0.85 : 0;
      const fg = g.createRadialGradient(
        geom.cx, geom.cy, inner, geom.cx, geom.cy, Math.max(inner + 1, geom.rMax)
      );
      fg.addColorStop(0, hsl(pal.mid, pal.sat, 0.6, (0.06 + level * 0.1) * w.energy * preset.glow));
      fg.addColorStop(1, hsl(pal.low, pal.sat * 0.8, 0.45, 0));
      g.fillStyle = fg;
      g.fillRect(0, 0, geom.w, geom.h);

      // The blooms: a ring opening out of a node, soft-edged so a dozen of them
      // overlapping stays creamy rather than stripy.
      for (const b of blooms) {
        if (b.age < 0) continue;
        const nd = nodes[Math.min(nodes.length - 1, b.node)] || nodes[0];
        if (!nd) continue;
        const t = b.age / 1.1;
        const r = geom.rMin * (0.1 + t * 0.95) * (0.7 + nd.w * 0.5);
        const a = (1 - t) * (1 - t) * b.p * 0.3 * w.energy * preset.glow;
        if (a < 0.005) continue;
        const hue = pal.mid + b.hue;
        const gr = g.createRadialGradient(nd.x, nd.y, r * 0.55, nd.x, nd.y, Math.max(1, r));
        gr.addColorStop(0, hsl(hue, pal.sat, 0.7, 0));
        gr.addColorStop(0.7, hsl(hue, pal.sat, 0.72, a));
        gr.addColorStop(1, hsl(hue + 18, pal.sat, 0.6, 0));
        g.fillStyle = gr;
        g.beginPath();
        if (PETAL >= 3) {
          // A flower rather than a ring: the same gradient, read through a
          // lobed outline. Rotated by its own age so it opens as it turns.
          const steps = PETAL * 12;
          for (let k = 0; k <= steps; k++) {
            const ang = (k / steps) * TAU + t * 0.8;
            const rr = r * (0.62 + 0.38 * Math.abs(Math.cos(ang * PETAL * 0.5)));
            const x = nd.x + Math.cos(ang) * rr;
            const y = nd.y + Math.sin(ang) * rr;
            k === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
          }
          g.closePath();
        } else {
          g.arc(nd.x, nd.y, r, 0, TAU);
        }
        g.fill();

        // Mirror-ball spokes: straight light leaving the bloom. Only the
        // genres that are actually played under one ask for them.
        if (RAY > 0.05) {
          g.strokeStyle = hsl(hue, pal.sat, 0.82, a * 0.5 * RAY);
          g.lineWidth = Math.max(1, geom.rMin * 0.004);
          g.beginPath();
          for (let k = 0; k < 8; k++) {
            const ang = (k / 8) * TAU + b.hue * 0.02;
            const co = Math.cos(ang);
            const si = Math.sin(ang);
            g.moveTo(nd.x + co * r * 0.5, nd.y + si * r * 0.5);
            g.lineTo(nd.x + co * r * 2.1, nd.y + si * r * 2.1);
          }
          g.stroke();
        }
      }

      // The voice, where there is one: a soft column of light rising through
      // the middle of the picture at the syllable rate.
      if (VOICE > 0.1 && vocal > 0.06 && melodic * VOICE > 0.35) {
        const vw = geom.w * (0.1 + vocal * 0.2);
        const vg = g.createLinearGradient(geom.cx - vw, 0, geom.cx + vw, 0);
        vg.addColorStop(0, hsl(pal.high, pal.sat, 0.78, 0));
        vg.addColorStop(0.5, hsl(pal.high, pal.sat, 0.8, vocal * 0.14 * VOICE * w.energy * preset.glow));
        vg.addColorStop(1, hsl(pal.high, pal.sat, 0.78, 0));
        g.fillStyle = vg;
        g.fillRect(geom.cx - vw, 0, vw * 2, geom.h);
      }

      // Confetti.
      const s = Math.max(2, geom.rMin * 0.012);
      for (let k = 0; k < N; k++) {
        const i = k * 6;
        const life = conf[i + 4];
        if (life <= 0) continue;
        const hue = pal.low + (pal.high - pal.low) * conf[i + 5];
        g.fillStyle = hsl(hue, pal.sat, lerp(0.65, 0.78, warm), life * 0.7 * w.energy);
        g.fillRect(conf[i] * geom.w, conf[i + 1] * geom.h, s, s * (1 + conf[i + 5]));
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}
