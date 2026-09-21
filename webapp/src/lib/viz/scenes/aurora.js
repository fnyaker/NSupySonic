// Slow flowing ribbons. The calm option, and the cheapest full-screen one: a
// handful of filled paths and one gradient each, no particles, no per-pixel
// work. It is the scene that should still be smooth on a phone that struggles
// with everything else, which is why the mobile default falls back to it.
//
// Each ribbon is driven by one slice of the spectrum, so the bass ribbon rolls
// slowly and deeply while the top one ripples — the motion itself carries the
// music rather than just the brightness.
//
// The ribbons use the WHOLE height, and where the artwork is in the way they
// are dealt into the strips above and below it instead of being drawn behind
// it. The old fixed 0.22..0.78 band was the worst of both: a letterboxed strip
// on a beamer, and exactly the part of a phone the cover covers.

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

  // Where ribbon `t` (0..1) sits. Without artwork: the full height. With it:
  // the free strips above and below, in proportion to how much of each there
  // is — so on a phone the ribbons frame the cover and on a wide screen where
  // the cover leaves little vertical room they simply spread out again.
  function baseline(t, h, geom) {
    const top = geom.hole ? geom.cy - geom.hh : 0;
    const bot = geom.hole ? geom.cy + geom.hh : h;
    const room = top + (h - bot);
    if (!geom.hole || room < h * 0.3) return h * (0.07 + t * 0.86);
    const d = t * room;
    return d < top ? h * 0.03 + d * 0.9 : bot + (d - top) * 0.92;
  }

  function draw(g, w, h, pal, geom) {
    g.globalCompositeOperation = "source-over";
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, hsl(pal.hue - 18, pal.sat * 0.5, 0.07, 1));
    bg.addColorStop(1, hsl(pal.hue + 26, pal.sat * 0.45, 0.04, 1));
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    g.globalCompositeOperation = "lighter";
    const steps = Math.max(24, Math.min(96, Math.floor(w / 12)));
    // Everything is sized against the ribbon's own SLOT — the height each one
    // gets — rather than against the frame. Sizing on the frame meant that
    // spreading them over the full height (instead of the middle half) made
    // each one two thirds taller as well, six of them overlapped completely,
    // and the scene stopped being ribbons and became a flat poster.
    const span = geom.hole ? Math.max(h * 0.28, h - 2 * geom.hh) : h;
    const slot = span / RIBBONS;
    for (let r = 0; r < RIBBONS; r++) {
      const t = r / (RIBBONS - 1 || 1);
      const base = baseline(t, h, geom);
      const thick = slot * (0.45 + amp[r] * 1.05) * (0.6 + level * 0.6);
      const hue = pal.low + (pal.high - pal.low) * t;
      const alpha = (0.07 + amp[r] * 0.2) * preset.glow;
      const swing = slot * (0.45 + amp[r] * 0.9);

      g.beginPath();
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * w;
        const n = wave((i / steps) * 3.2, phase * (0.6 + t), r * 3.7);
        const y = base + n * swing;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      for (let i = steps; i >= 0; i--) {
        const x = (i / steps) * w;
        const n = wave((i / steps) * 3.2, phase * (0.6 + t), r * 3.7);
        const y = base + n * swing + thick;
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
