// HARDSTYLE / RAWSTYLE / HARDTEKK / ZAAG / HARDPINGPONG / GERMAN PARTY / PIEEP —
// the bouncing kick.
//
// These genres are not built on breaking things (that is `shatter`), they are
// built on ONE enormous kick that pitches down through the beat, with a saw
// lead on top. So the motif is a core that squashes and stretches on every hit
// — hard down, elastic back — inside a ring of radial bars driven by the
// spectrum, with the lead drawn as streaks across the picture when it is there.
//
// The core is a DISC normally and a RIM when there is artwork in the way, which
// is the same object seen around the cover rather than a second design.

import { approach, clamp, envelope, hsl, lerp } from "../util.js";

const TAU = Math.PI * 2;

export function createHardbounceWorld(preset, opts) {
  const BARS = Math.max(28, Math.min(72, preset.bars));
  const bar = new Float32Array(BARS);
  let squash = 0; // >0 wide and flat, <0 tall and narrow
  let bounce = 0;
  let kick = 0;
  let saw = 0;
  let melodic = 0.5;
  let punch = 0.9;
  let spin = 0;
  let lastHit = -1;
  let clock = 0;

  return {
    update(frame, dt, geom) {
      clock += dt;
      const f = frame.features;
      const beat = frame.beat;
      const look = frame.style?.look;
      melodic = approach(melodic, look ? look.melodic : 0.5, 1.2, dt);
      punch = approach(punch, look ? look.punch : 0.9, 1.2, dt);

      const det = f.kick || 0;
      const hit =
        (frame.style?.kick?.hit || (beat.beat && beat.locked) || det > 0.55) &&
        clock - lastHit > 0.09;
      if (hit) {
        lastHit = clock;
        bounce = lerp(0.35, 1, punch) * (0.65 + det * 0.5);
      }
      // The squash is a damped spring, not an envelope: a kick this size has to
      // overshoot on the way back or it reads as a fade rather than as a hit.
      bounce = approach(bounce, 0, 0.11, dt);
      squash = approach(squash, bounce - bounce * bounce * 0.9, 0.035, dt);
      kick = envelope(kick, clamp(det * 1.2, 0, 1), dt, 0.005, 0.13);
      saw = envelope(saw, clamp((f.midFlux || 0) * 14, 0, 1), dt, 0.02, 0.2);

      const b = frame.bands;
      const per = b.length / BARS;
      for (let i = 0; i < BARS; i++) {
        let m = 0;
        const a = Math.floor(i * per);
        const e = Math.floor((i + 1) * per);
        for (let j = a; j < e && j < b.length; j++) if (b[j] > m) m = b[j];
        bar[i] = envelope(bar[i], m, dt, 0.02, 0.16);
      }
      const barLen = beat.locked ? beat.period * beat.beatsPerBar : 3;
      spin += (dt / (barLen * 6)) * TAU;
      void geom;
    },

    draw(g, geom, pal, w) {
      g.globalCompositeOperation = "lighter";

      // The radial bar ring: one bar per band, standing outward from the core.
      // Laid out on the frame's own polar mapping so it spreads across a wide
      // screen instead of staying inside a circle.
      for (let i = 0; i < BARS; i++) {
        const v = bar[i];
        if (v < 0.02) continue;
        const a = spin + (i / BARS) * TAU;
        const base = 0.36 + squash * 0.12;
        const p0 = geom.place(a, base);
        const x0 = p0[0];
        const y0 = p0[1];
        const p1 = geom.place(a, base + v * (0.55 + kick * 0.2));
        const hue = pal.low + (pal.high - pal.low) * (i / (BARS - 1));
        g.strokeStyle = hsl(hue, pal.sat, 0.62, (0.1 + v * 0.35) * w.energy * preset.glow);
        g.lineWidth = Math.max(1.5, (geom.rMin * 0.9 * TAU) / BARS * 0.45);
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(p1[0], p1[1]);
        g.stroke();
      }

      // The core, squashing on the hit. An ellipse whose axes move in opposite
      // directions — wide and flat at the moment of impact, tall on the rebound.
      const r0 = geom.hole ? Math.min(geom.hw, geom.hh) * 0.86 : 0;
      const baseR = r0 + geom.rMin * (0.3 + kick * 0.12);
      const rx = baseR * (1 + squash * 0.55);
      const ry = baseR * (1 - squash * 0.45);
      const ca = (0.12 + bounce * 0.5 + kick * 0.2) * w.energy * preset.glow;
      if (ca > 0.005) {
        g.save();
        g.translate(geom.cx, geom.cy);
        g.scale(1, Math.max(0.05, ry / Math.max(1, rx)));
        const cg = g.createRadialGradient(0, 0, r0 * 0.9, 0, 0, Math.max(r0 + 1, rx));
        cg.addColorStop(0, hsl(pal.low + 14, pal.sat, 0.8, ca));
        cg.addColorStop(0.7, hsl(pal.low, pal.sat, 0.6, ca * 0.3));
        cg.addColorStop(1, hsl(pal.low, pal.sat, 0.5, 0));
        g.fillStyle = cg;
        g.beginPath();
        g.arc(0, 0, Math.max(1, rx), 0, TAU);
        g.fill();
        g.restore();
      }

      // The lead. Zaag is literally "saw": diagonal streaks that lean the way
      // the energy is moving, and only for the styles whose lead is one.
      if (saw > 0.03 && melodic > 0.35) {
        const n = 3 + Math.floor(saw * preset.layers * 1.5);
        g.lineCap = "round";
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          const x = geom.w * (0.05 + t * 0.9);
          const len = geom.h * (0.16 + saw * 0.3);
          const y0 = geom.h * (0.18 + ((i * 0.41) % 0.64));
          const lean = len * 0.5;
          const gr = g.createLinearGradient(x - lean, y0 + len / 2, x + lean, y0 - len / 2);
          const hue = pal.high + i * 6;
          gr.addColorStop(0, hsl(hue, pal.sat, 0.6, 0));
          gr.addColorStop(0.5, hsl(hue, pal.sat, 0.74, saw * 0.35 * w.energy * preset.glow));
          gr.addColorStop(1, hsl(hue + 14, pal.sat, 0.8, 0));
          g.strokeStyle = gr;
          g.lineWidth = Math.max(2, geom.h * 0.008 * (0.5 + saw));
          g.beginPath();
          g.moveTo(x - lean, y0 + len / 2);
          g.lineTo(x + lean, y0 - len / 2);
          g.stroke();
        }
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}
