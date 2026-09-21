// DUB / DUB TECHNO / TRIP-HOP / DOWNTEMPO / CLOUD RAP — depth and echo.
//
// What this music does that nothing else in the set does is REPEAT ITSELF at a
// decay: one hit, then the same hit quieter a beat later, then quieter again.
// So the world is built on echoes — every event lays down a swell, and that
// swell is re-drawn behind itself at a delay, smaller and dimmer, three or four
// times. The picture is literally a dub delay.
//
// Slow, wide, horizontal, and lit from below: the opposite of `shatter` in
// every axis.
//
// skin.p — swells (how many events are kept), echo (how many repeats and how
//          far apart), depth (how far back they recede)

import { approach, clamp, envelope, hsl } from "../util.js";

const TAU = Math.PI * 2;

// `pingpong` sends the delay's repeats alternately left and right instead of
// straight back, which is the effect dub is actually built on — a tape echo
// bouncing across the stereo field — and is a different picture rather than a
// dimmer one. `rain` hangs the repeats' tails down over the water.
export function createOceanWorld(preset, opts, skin = {}) {
  const p = skin.p || {};
  const MAX = Math.max(3, Math.round(6 * (p.swells ?? 1)));
  const PINGPONG = clamp(p.pingpong ?? 0, 0, 1);
  const RAIN = clamp(p.rain ?? 0, 0, 1);
  const swell = [];
  for (let i = 0; i < MAX; i++) swell.push({ age: -1, x: 0.5, power: 0, hue: 0 });
  let next = 0;
  let level = 0;
  let sub = 0;
  let drift = 0;
  let lastAt = -1;
  let clock = 0;

  return {
    update(frame, dt) {
      clock += dt;
      const f = frame.features;
      const e = frame.energy;
      const beat = frame.beat;
      const total = e.sub + e.bass + e.lowMid + e.mid + e.high + e.air + 1e-12;
      sub = envelope(sub, clamp(((e.sub + e.bass) / total) * 2.4, 0, 1), dt, 0.05, 0.5);
      level = approach(level, f.level || 0, 0.5, dt);
      drift += dt * 0.06;

      const hit = (beat.beat && beat.locked) || (f.kick || 0) > 0.5;
      if (hit && clock - lastAt > 0.2) {
        lastAt = clock;
        const s = swell[(next = (next + 1) % MAX)];
        s.age = 0;
        s.x = 0.25 + Math.sin(clock * 0.7) * 0.25 + 0.25;
        s.power = 0.5 + (f.kick || 0) * 0.5;
        s.hue = Math.sin(clock * 0.37) * 26;
      }
      for (const s of swell) {
        if (s.age < 0) continue;
        s.age += dt;
        if (s.age > 6) s.age = -1;
      }
    },

    draw(g, geom, pal, w) {
      const W = geom.w;
      const H = geom.h;
      // A horizon low in the frame: this world is lit from below, which is what
      // makes it read as depth rather than as a light show.
      const base = geom.hole ? Math.min(H * 0.95, geom.cy + geom.hh + H * 0.06) : H * 0.78;
      g.globalCompositeOperation = "lighter";

      // The delay line. Each swell is drawn ECHOES times, each copy further
      // back, smaller, dimmer and later — which is the effect the music is
      // made of, drawn rather than described.
      const echoes = Math.max(2, Math.round(4 * (p.echo ?? 1)));
      const spacing = 0.42 / echoes;
      const depth = p.depth ?? 1;
      for (const s of swell) {
        if (s.age < 0) continue;
        for (let k = echoes - 1; k >= 0; k--) {
          const t = (s.age - k * spacing * 3) / 3.2;
          if (t < 0 || t > 1) continue;
          const back = k / echoes;
          const fade = Math.pow(0.55, k);
          const alpha = Math.sin(Math.PI * t) * s.power * 0.024 * fade * w.energy * preset.glow;
          if (alpha < 0.004) continue;
          // Further back = higher up and narrower, as anything receding is.
          const y = base - back * (base - H * 0.12) * depth;
          const rx = W * (0.16 + t * 0.4) * (1 - back * 0.5);
          const ry = H * (0.05 + t * 0.12) * (1 - back * 0.55);
          // Straight back down the middle, or thrown side to side one repeat at
          // a time. Same delay line, read as a room instead of as a corridor.
          const x =
            PINGPONG > 0.05
              ? geom.cx + (k % 2 === 0 ? 1 : -1) * PINGPONG * W * 0.34 * back +
                (s.x - 0.5) * W * (1 - back * 0.6) * (1 - PINGPONG * 0.6)
              : geom.cx + (s.x - 0.5) * W * (1 - back * 0.6);
          const hue = pal.low + s.hue + back * 24;
          g.save();
          g.translate(x, y);
          g.scale(1, Math.max(0.04, ry / Math.max(1, rx)));
          const gr = g.createRadialGradient(0, 0, 0, 0, 0, Math.max(1, rx));
          gr.addColorStop(0, hsl(hue, pal.sat, 0.66, alpha));
          gr.addColorStop(0.6, hsl(hue + 12, pal.sat * 0.9, 0.55, alpha * 0.4));
          gr.addColorStop(1, hsl(hue + 20, pal.sat * 0.8, 0.45, 0));
          g.fillStyle = gr;
          g.beginPath();
          g.arc(0, 0, Math.max(1, rx), 0, TAU);
          g.fill();
          g.restore();
        }
      }

      // Rain: a tail hanging from each live repeat down onto the water. It is
      // the one vertical thing in a world of horizontals, so a little goes a
      // long way and only the genres built on a wet, dripping delay ask for it.
      if (RAIN > 0.05) {
        g.lineWidth = Math.max(1, H * 0.002);
        g.beginPath();
        for (const s of swell) {
          if (s.age < 0) continue;
          const t = s.age / 3.2;
          if (t > 1) continue;
          const x = geom.cx + (s.x - 0.5) * W;
          const top = base - H * 0.1 * (1 - t);
          g.moveTo(x, top);
          g.lineTo(x, base);
        }
        g.strokeStyle = hsl(pal.mid, pal.sat * 0.7, 0.6, 0.05 * RAIN * w.energy * preset.glow);
        g.stroke();
      }

      // The surface: a slow wide wave along the horizon, riding on the sub.
      const steps = Math.max(24, Math.min(90, Math.floor(W / 14)));
      g.strokeStyle = hsl(pal.mid, pal.sat * 0.8, 0.62, (0.02 + sub * 0.05) * w.energy * preset.glow);
      g.lineWidth = Math.max(1.5, H * 0.004 * (0.5 + sub));
      g.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const y =
          base +
          Math.sin(t * 4.2 + drift * 2.4) * H * 0.02 * (0.4 + sub) +
          Math.sin(t * 1.7 - drift * 1.3) * H * 0.03 * (0.3 + level);
        i === 0 ? g.moveTo(t * W, y) : g.lineTo(t * W, y);
      }
      g.stroke();

      // The deep: everything below the surface, glowing faintly.
      const dg = g.createLinearGradient(0, base, 0, H);
      dg.addColorStop(0, hsl(pal.low, pal.sat, 0.5, (0.015 + sub * 0.03) * w.energy * preset.glow));
      dg.addColorStop(1, hsl(pal.low - 16, pal.sat * 0.7, 0.3, 0));
      g.fillStyle = dg;
      g.fillRect(0, base, W, H - base);
      g.globalCompositeOperation = "source-over";
    },
  };
}
