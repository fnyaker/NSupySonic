// CLASSICAL / ORCHESTRAL / OPERA / CHORAL / FILM SCORE / GOSPEL — a nave.
//
// Written music has no grid and no kick, but it does have something none of the
// other worlds draw: SWELL. A phrase rises over bars and resolves, and the
// visual that has always belonged to it is light through tall windows — shafts
// that brighten together as the orchestra does, over a rose window that turns
// on the harmony.
//
// Distinct from `nebula` (which also has no beat) by being ARCHITECTURAL: hard
// vertical edges, symmetry, and a floor. Ambient is weather; this is a room.
//
// skin.p — shafts (how many and how wide), swell (how far the light travels on
//          a crescendo), rose (the window's size and detail)

import { approach, clamp, hsl, lerp, rng } from "../util.js";

const TAU = Math.PI * 2;

export function createCathedralWorld(preset, opts, skin = {}) {
  const p = skin.p || {};
  const N = Math.max(3, Math.round((preset.layers + 2) * (p.shafts ?? 1)));
  const PETALS = Math.max(6, Math.round(12 * (p.rose ?? 1)));
  // `fan` converges the shafts on a point high in the frame instead of leaving
  // them parallel — a vaulted nave rather than a row of windows, which is what
  // an organ and a choir sound like and what solo piano does not. `dust` lights
  // the air the shafts pass through, and is the whole difference between a lit
  // room and a drawn one.
  const FAN = clamp(p.fan ?? 0, 0, 1);
  const DUST = clamp(p.dust ?? 0, 0, 1);
  const rand = rng(1685);
  const shaft = [];
  for (let i = 0; i < N; i++)
    shaft.push({ x: (i + 0.5) / N, lit: 0, seed: rand(), lean: (rand() - 0.5) * 0.18 });
  const petal = new Float32Array(PETALS);
  let swell = 0;
  let tonal = 0;
  let spin = 0;
  let pitch = 0.5;

  return {
    update(frame, dt) {
      const f = frame.features;
      // Everything here is eased over a PHRASE, not a bar: the fastest thing in
      // this world is slower than the slowest thing in any other.
      swell = approach(swell, clamp((f.level || 0) * 1.15, 0, 1), 0.9, dt);
      tonal = approach(tonal, f.tonal || 0, 1.4, dt);
      pitch = approach(pitch, f.melodyPitch ?? 0.5, 1.8, dt);
      const c = f.chroma;
      for (let i = 0; i < PETALS; i++) {
        const v = c ? c[i % 12] || 0 : 0;
        petal[i] = approach(petal[i], v, 0.55, dt);
      }
      for (const s of shaft) {
        // Each window lights at its own pace, so a crescendo sweeps the nave
        // rather than switching it on.
        const want = clamp(swell * (0.55 + s.seed * 0.7), 0, 1);
        s.lit = approach(s.lit, want, 0.4 + s.seed * 0.5, dt);
      }
      spin += dt * 0.05 * (1 + tonal);
    },

    draw(g, geom, pal, w) {
      const W = geom.w;
      const H = geom.h;
      const floor = H * 0.88;
      g.globalCompositeOperation = "lighter";

      // The shafts: tall, near-vertical, leaning in slightly, landing on a
      // floor. The lean is what stops them reading as a bar chart.
      const reach = lerp(0.55, 1, (p.swell ?? 1) * swell);
      for (const s of shaft) {
        if (s.lit < 0.02) continue;
        const x = s.x * W;
        const halfTop = W * 0.012;
        const halfBot = W * (0.035 + s.lit * 0.03);
        const landX = x + s.lean * W * 0.35;
        const top = -H * 0.05;
        // Converged on the middle at the top: every shaft points at the same
        // place, which is what a vault does to the light coming through it.
        const originX = lerp(x, geom.cx, FAN * 0.85);
        const bottom = lerp(H * 0.35, floor, reach);
        const gr = g.createLinearGradient(originX, top, landX, bottom);
        gr.addColorStop(0, hsl(pal.high, pal.sat * 0.5, 0.9, 0.032 * s.lit * w.energy * preset.glow));
        gr.addColorStop(0.65, hsl(pal.mid, pal.sat * 0.7, 0.66, 0.016 * s.lit * w.energy * preset.glow));
        gr.addColorStop(1, hsl(pal.low, pal.sat * 0.8, 0.5, 0));
        g.fillStyle = gr;
        g.beginPath();
        g.moveTo(originX - halfTop, top);
        g.lineTo(originX + halfTop, top);
        g.lineTo(landX + halfBot, bottom);
        g.lineTo(landX - halfBot, bottom);
        g.closePath();
        g.fill();
      }

      // Dust in the light. Drawn as one wash across the lit part of the nave
      // rather than as particles: motes would be an event, and this world is
      // deliberately the one with none.
      if (DUST > 0.05 && swell > 0.05) {
        const dg = g.createLinearGradient(0, 0, 0, floor);
        dg.addColorStop(0, hsl(pal.high, pal.sat * 0.4, 0.8, 0));
        dg.addColorStop(0.55, hsl(pal.mid, pal.sat * 0.5, 0.7, 0.014 * DUST * swell * w.energy * preset.glow));
        dg.addColorStop(1, hsl(pal.low, pal.sat * 0.5, 0.5, 0));
        g.fillStyle = dg;
        g.fillRect(0, 0, W, floor);
      }

      // The rose window: one petal per pitch class, opening on the harmony,
      // turning very slowly. It is the only round thing in a world of verticals,
      // so it reads as the window rather than as another effect.
      const cy = geom.hole ? geom.cy - geom.hh - geom.rMin * 0.12 : H * 0.36;
      const R = geom.rMin * 0.42 * (p.rose ?? 1) * (geom.hole ? 0.6 : 1);
      if (R > 8) {
        for (let i = 0; i < PETALS; i++) {
          const v = petal[i];
          if (v < 0.06) continue;
          const a0 = spin + (i / PETALS) * TAU;
          const a1 = a0 + (TAU / PETALS) * 0.78;
          const rad = R * (0.35 + v * 0.75);
          const hue = pal.low + ((pal.high - pal.low) * i) / (PETALS - 1);
          g.fillStyle = hsl(hue, pal.sat, 0.66, (0.014 + v * 0.045) * w.energy * preset.glow);
          g.beginPath();
          g.moveTo(geom.cx, cy);
          const steps = 5;
          for (let k = 0; k <= steps; k++) {
            const a = a0 + ((a1 - a0) * k) / steps;
            g.lineTo(geom.cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
          }
          g.closePath();
          g.fill();
        }
        // The tracery: thin ribs, always there, so the window has a body even
        // when nothing is sounding.
        g.strokeStyle = hsl(pal.mid, pal.sat * 0.5, 0.7, 0.022 * w.energy);
        g.lineWidth = Math.max(1, geom.rMin * 0.003);
        g.beginPath();
        for (let i = 0; i < PETALS; i++) {
          const a = spin + (i / PETALS) * TAU;
          g.moveTo(geom.cx, cy);
          g.lineTo(geom.cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        }
        g.stroke();
      }

      // The floor the light lands on, and a band of glow at the height the
      // melody sits — the one thing in here that follows a note.
      // A wide, soft wash rather than a stripe: the floor is where the light
      // lands, and a hard-edged band across it reads as a horizon line in a
      // world that has no horizon.
      const y = lerp(floor, H * 0.42, clamp(pitch, 0, 1));
      const fg = g.createLinearGradient(0, y - H * 0.24, 0, H);
      fg.addColorStop(0, hsl(pal.mid, pal.sat * 0.7, 0.6, 0));
      fg.addColorStop(0.6, hsl(pal.low, pal.sat, 0.55, (0.012 + swell * 0.028) * w.energy * preset.glow));
      fg.addColorStop(1, hsl(pal.low, pal.sat * 0.8, 0.45, 0));
      g.fillStyle = fg;
      g.fillRect(0, y - H * 0.24, W, H - y + H * 0.24);
      g.globalCompositeOperation = "source-over";
    },
  };
}
