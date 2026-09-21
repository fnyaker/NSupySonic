// JAZZ / BLUES / FOLK / COUNTRY / REGGAE — brush strokes.
//
// Played music has no grid to draw. What it has is NOTES, arriving when the
// player decides, so the motif is a brush stroke thrown on each note attack —
// `melodyFlux`, the onset function with the drums taken out of it — which then
// drifts and dissolves. High notes sit high, low notes sit low, and the
// picture is whatever the last few seconds of playing left behind.
//
// The whole world is a long exposure (`trail: 0.18` in the registry), which is
// the opposite end of the same dial that makes speedcore a strobe.

import { approach, clamp, envelope, hsl, lerp, rng } from "../util.js";

const TAU = Math.PI * 2;

export function createSmokeWorld(preset, opts) {
  const MAX = Math.max(8, Math.min(22, preset.layers * 5));
  const rand = rng(1959);
  const stroke = [];
  for (let i = 0; i < MAX; i++)
    stroke.push({ age: -1, x: 0, y: 0, len: 0, tilt: 0, curve: 0, p: 0, hue: 0 });
  let next = 0;
  let lull = 0;
  let sway = 0;
  let warm = 0.75;
  let level = 0;
  let prevFlux = 0;

  return {
    update(frame, dt) {
      const f = frame.features;
      const beat = frame.beat;
      const look = frame.style?.look;
      warm = approach(warm, look ? look.warm : 0.75, 1.2, dt);
      level = approach(level, f.level || 0, 0.35, dt);
      lull += dt;
      // The sway is a swing, not a pulse: one slow cycle per bar, which is how
      // this music moves.
      const barLen = beat.locked ? beat.period * beat.beatsPerBar : 2.6;
      sway += (dt / barLen) * TAU * 0.5;

      const flux = f.melodyFlux || 0;
      const attack = flux > 0.01 && flux > prevFlux * 1.5;
      prevFlux = approach(prevFlux, flux, 0.18, dt);
      if ((attack && lull > 0.12) || lull > lerp(2.4, 0.8, level)) {
        lull = 0;
        const s = stroke[(next = (next + 1) % MAX)];
        s.age = 0;
        // Pitch decides height, as it does on a stave.
        const pitch = f.melodyPitch ?? 0.5;
        s.y = clamp(0.86 - pitch * 0.7 + (rand() - 0.5) * 0.14, 0.08, 0.92);
        s.x = 0.1 + rand() * 0.8;
        s.len = 0.18 + rand() * 0.4 + level * 0.2;
        s.tilt = (rand() - 0.5) * 0.5;
        s.curve = (rand() - 0.5) * 0.3;
        s.p = clamp(0.35 + flux * 30, 0.3, 1);
        s.hue = (rand() - 0.5) * 44;
      }
      for (const s of stroke) {
        if (s.age < 0) continue;
        s.age += dt;
        // Drifting up and apart as they dissolve, like smoke off a stage.
        s.y -= dt * 0.012;
        s.len += dt * 0.05;
        if (s.age > 3.4) s.age = -1;
      }
    },

    draw(g, geom, pal, w) {
      const W = geom.w;
      const H = geom.h;
      g.globalCompositeOperation = "lighter";
      g.lineCap = "round";

      for (const s of stroke) {
        if (s.age < 0) continue;
        const t = s.age / 3.4;
        // In fast, out slow: a brush lands and then fades.
        const a = Math.min(1, t * 9) * (1 - t) * (1 - t) * s.p * 0.13 * w.energy * preset.glow;
        if (a < 0.004) continue;
        const drift = Math.sin(sway + s.hue) * 0.02;
        const cx = (s.x + drift) * W;
        const cy = s.y * H;
        const half = (s.len * W) / 2;
        const dy = s.tilt * H * 0.12;
        const hue = pal.mid + s.hue;
        const gr = g.createLinearGradient(cx - half, cy - dy, cx + half, cy + dy);
        gr.addColorStop(0, hsl(hue, pal.sat * 0.9, 0.62, 0));
        gr.addColorStop(0.5, hsl(hue, pal.sat, lerp(0.6, 0.72, warm), a));
        gr.addColorStop(1, hsl(hue + 14, pal.sat * 0.9, 0.62, 0));
        g.strokeStyle = gr;
        g.lineWidth = Math.max(2, H * 0.02 * (0.4 + s.p) * (1 - t * 0.5));
        g.beginPath();
        g.moveTo(cx - half, cy - dy);
        g.quadraticCurveTo(cx, cy + s.curve * H * 0.16, cx + half, cy + dy);
        g.stroke();
      }

      // A warm haze underneath, breathing with the sway. It is what keeps the
      // picture from being strokes floating on black.
      const hx = geom.cx + Math.sin(sway * 0.6) * W * 0.12;
      const hy = geom.cy + Math.cos(sway * 0.45) * H * 0.1;
      const hg = g.createRadialGradient(hx, hy, 0, hx, hy, geom.rMax * 0.9);
      hg.addColorStop(0, hsl(pal.low, pal.sat * 0.85, 0.5, (0.014 + level * 0.02) * w.energy * preset.glow));
      hg.addColorStop(1, hsl(pal.low - 14, pal.sat * 0.6, 0.35, 0));
      g.fillStyle = hg;
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = "source-over";
    },
  };
}
