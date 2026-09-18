// Slow flowing ribbons. The calm option, and the cheapest full-screen one: a
// handful of filled paths and one gradient each, no particles, no per-pixel
// work. It is the scene that should still be smooth on a phone that struggles
// with everything else, which is why the mobile default falls back to it.
//
// Each ribbon is driven by one slice of the spectrum, so the bass ribbon rolls
// slowly and deeply while the top one ripples — the motion itself carries the
// music rather than just the brightness.

import { approach, clamp, hsl, wave } from "../util.js";

export function createAuroraScene(opts = {}) {
  const preset = opts.preset;
  const RIBBONS = Math.max(3, Math.min(6, preset.layers + 1));
  const amp = new Float32Array(RIBBONS);
  let phase = 0;
  let level = 0;

  function resize() {}

  function update(frame, dt) {
    const b = frame.bands;
    const per = b.length / RIBBONS;
    for (let i = 0; i < RIBBONS; i++) {
      let m = 0;
      const a = Math.floor(i * per);
      const e = Math.floor((i + 1) * per);
      for (let j = a; j < e; j++) if (b[j] > m) m = b[j];
      // Lower ribbons breathe, upper ribbons flicker: same data, different time
      // constants, and that alone makes the layers read as separate.
      const tau = 0.05 + (1 - i / RIBBONS) * 0.2;
      amp[i] = approach(amp[i], m, tau, dt);
    }
    level = approach(level, frame.features?.level || 0, 0.2, dt);
    // Drift locked to the tempo when there is one, so the flow feels like it
    // belongs to the track instead of running on its own clock.
    const beat = frame.beat;
    const speed = beat.locked ? 0.12 + clamp(beat.bpm / 900, 0, 0.35) : 0.16;
    phase += dt * speed;
  }

  function draw(g, w, h, pal) {
    g.globalCompositeOperation = "source-over";
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, hsl(pal.hue - 18, pal.sat * 0.5, 0.07, 1));
    bg.addColorStop(1, hsl(pal.hue + 26, pal.sat * 0.45, 0.04, 1));
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    g.globalCompositeOperation = "lighter";
    const steps = Math.max(24, Math.min(96, Math.floor(w / 12)));
    for (let r = 0; r < RIBBONS; r++) {
      const t = r / (RIBBONS - 1 || 1);
      const base = h * (0.22 + t * 0.56);
      const thick = h * (0.05 + amp[r] * 0.2) * (0.6 + level * 0.6);
      const hue = pal.low + (pal.high - pal.low) * t;
      const alpha = (0.14 + amp[r] * 0.42) * preset.glow;

      g.beginPath();
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * w;
        const n = wave(i / steps * 3.2, phase * (0.6 + t), r * 3.7);
        const y = base + n * h * (0.06 + amp[r] * 0.14);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      for (let i = steps; i >= 0; i--) {
        const x = (i / steps) * w;
        const n = wave(i / steps * 3.2, phase * (0.6 + t), r * 3.7);
        const y = base + n * h * (0.06 + amp[r] * 0.14) + thick;
        g.lineTo(x, y);
      }
      g.closePath();
      const gr = g.createLinearGradient(0, base - thick, 0, base + thick * 2);
      gr.addColorStop(0, hsl(hue, pal.sat, 0.62, 0));
      gr.addColorStop(0.5, hsl(hue, pal.sat, 0.58, alpha));
      gr.addColorStop(1, hsl(hue + 18, pal.sat, 0.45, 0));
      g.fillStyle = gr;
      g.fill();
    }
    g.globalCompositeOperation = "source-over";
  }

  return { resize, update, draw };
}
