// SYNTHWAVE / LOFI — the sun over the grid.
//
// There is exactly one image for this music and everybody already knows it: a
// banded sun sitting on a horizon with a perspective floor running away
// underneath. So the world draws that, honestly, and hangs the music on it —
// the grid scrolls at the tempo, the sun breathes on the bass, the bands across
// it lift with the mids, and the sky carries the palette.
//
// It is the one world that paints an OPAQUE background (`trail: 1` in the
// registry): a sky is not a trail, and a horizon smeared over its own previous
// frame is a smudge rather than a place.

import { approach, clamp, envelope, hsl, lerp, rng } from "../util.js";

const TAU = Math.PI * 2;
const STARS = 40;

export function createHorizonWorld(preset, opts) {
  const rand = rng(1984);
  const star = new Float32Array(STARS * 3); // x, y, twinkle seed
  for (let i = 0; i < STARS; i++) {
    star[i * 3] = rand();
    star[i * 3 + 1] = rand();
    star[i * 3 + 2] = rand() * TAU;
  }
  let scroll = 0;
  let bass = 0;
  let mid = 0;
  let clock = 0;
  let chaos = 0.2;

  return {
    update(frame, dt) {
      clock += dt;
      const f = frame.features;
      const e = frame.energy;
      const beat = frame.beat;
      const look = frame.style?.look;
      chaos = approach(chaos, look ? look.chaos : 0.2, 1.2, dt);
      const total = e.sub + e.bass + e.lowMid + e.mid + e.high + e.air + 1e-12;
      bass = envelope(bass, clamp(((e.sub + e.bass) / total) * 2.6, 0, 1), dt, 0.03, 0.26);
      mid = envelope(mid, clamp(((e.lowMid + e.mid) / total) * 2.6, 0, 1), dt, 0.03, 0.22);
      // The floor runs at one grid line per beat, so the drive is the tempo.
      const period = beat.locked ? beat.period : 0.6;
      scroll = (scroll + dt / period) % 1;
      void f;
    },

    draw(g, geom, pal, w) {
      const W = geom.w;
      const H = geom.h;
      // With artwork in the way the horizon goes BELOW it, so the cover stands
      // on the grid like an object on the plain, and the sun moves up into the
      // sky above it. Leaving the horizon in the middle put the one motif this
      // world exists for directly behind the album art.
      const hz = geom.hole
        ? clamp(geom.cy + geom.hh + H * 0.03, H * 0.45, H * 0.86)
        : H * 0.52;

      // --- the sky, opaque -------------------------------------------------
      g.globalCompositeOperation = "source-over";
      const sky = g.createLinearGradient(0, 0, 0, hz);
      sky.addColorStop(0, hsl(pal.high + 20, pal.sat * 0.8, 0.1, w.fade));
      sky.addColorStop(0.62, hsl(pal.mid, pal.sat * 0.85, 0.2, w.fade));
      sky.addColorStop(1, hsl(pal.low, pal.sat, 0.34, w.fade));
      g.fillStyle = sky;
      g.fillRect(0, 0, W, hz);
      const ground = g.createLinearGradient(0, hz, 0, H);
      ground.addColorStop(0, hsl(pal.low + 10, pal.sat * 0.7, 0.12, w.fade));
      ground.addColorStop(1, hsl(pal.low - 20, pal.sat * 0.5, 0.03, w.fade));
      g.fillStyle = ground;
      g.fillRect(0, hz, W, H - hz);

      g.globalCompositeOperation = "lighter";

      // --- stars -----------------------------------------------------------
      for (let i = 0; i < STARS; i++) {
        const j = i * 3;
        const y = star[j + 1] * hz * 0.75;
        const tw = 0.4 + 0.6 * Math.abs(Math.sin(clock * 0.9 + star[j + 2]));
        g.fillStyle = hsl(pal.high, 0.2, 0.95, 0.35 * tw * w.energy);
        g.fillRect(star[j] * W, y, 1.6, 1.6);
      }

      // --- the sun ---------------------------------------------------------
      const sunR = Math.min(W, H) * (0.19 + bass * 0.04) * (geom.hole ? 0.55 : 1);
      const sunY = geom.hole
        ? clamp(geom.cy - geom.hh - sunR * 1.05, sunR * 0.7, hz - sunR * 0.28)
        : hz - sunR * 0.28;
      const sg = g.createRadialGradient(geom.cx, sunY, sunR * 0.1, geom.cx, sunY, sunR);
      sg.addColorStop(0, hsl(pal.high, pal.sat, 0.72, 0.62 * w.energy * preset.glow));
      sg.addColorStop(0.55, hsl(pal.mid, pal.sat, 0.6, 0.4 * w.energy * preset.glow));
      sg.addColorStop(1, hsl(pal.low, pal.sat, 0.5, 0));
      g.fillStyle = sg;
      g.beginPath();
      g.arc(geom.cx, sunY, sunR, 0, TAU);
      g.fill();

      // The bands across it, widening downward — what makes it a synthwave sun
      // and not a circle. They are painted in the colour of whatever is BEHIND
      // the sun at that height, not cut out of the canvas: `destination-out`
      // punched through the sky as well and left bars of pure black hanging
      // over the horizon.
      g.globalCompositeOperation = "source-over";
      const bands = 7;
      for (let i = 0; i < bands; i++) {
        const t = i / bands;
        const y = sunY + sunR * (0.05 + t * 0.95);
        const thick = Math.max(1, sunR * (0.03 + t * 0.09) * (1 - mid * 0.45));
        const x = geom.cx - sunR * 1.05;
        const bw = sunR * 2.1;
        // Above the horizon it is sky, below it is ground; a band straddling
        // the line gets both halves.
        if (y < hz) {
          g.fillStyle = hsl(pal.low, pal.sat, 0.32, 0.96 * w.fade);
          g.fillRect(x, y, bw, Math.min(thick, hz - y));
        }
        if (y + thick > hz) {
          const y2 = Math.max(y, hz);
          g.fillStyle = hsl(pal.low + 10, pal.sat * 0.7, 0.11, 0.96 * w.fade);
          g.fillRect(x, y2, bw, y + thick - y2);
        }
      }
      g.globalCompositeOperation = "lighter";

      // --- the floor grid --------------------------------------------------
      const glow = (0.16 + mid * 0.3) * w.energy * preset.glow;
      g.strokeStyle = hsl(pal.high, pal.sat, 0.68, glow);
      g.lineWidth = Math.max(1, H * 0.0016);
      g.beginPath();
      // Verticals, converging on the vanishing point.
      const VANISH = geom.cx;
      const cols = 15;
      for (let i = 0; i <= cols; i++) {
        const t = i / cols - 0.5;
        g.moveTo(VANISH + t * W * 0.12, hz);
        g.lineTo(VANISH + t * W * 3.2, H);
      }
      g.stroke();
      // Horizontals, spaced by perspective and scrolling toward the viewer. The
      // squared step is what makes the floor recede instead of being a ladder.
      const rows = 13;
      for (let i = 0; i < rows; i++) {
        const t = (i + scroll) / rows;
        const y = hz + (H - hz) * t * t;
        const a = glow * (0.25 + t * 1.1);
        g.strokeStyle = hsl(pal.high, pal.sat, 0.7, Math.min(0.5, a));
        g.lineWidth = Math.max(1, H * 0.0015 * (0.4 + t * 2));
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(W, y);
        g.stroke();
      }

      // --- the tape ---------------------------------------------------------
      // Lofi is a worn medium, so it gets scan lines; synthwave, which is a
      // clean one, does not. `chaos` is the axis that separates them.
      if (chaos > 0.12 && preset.layers >= 3) {
        g.fillStyle = hsl(pal.high, 0.1, 0.9, 0.025 * chaos * w.energy);
        for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
      }
      g.globalCompositeOperation = "source-over";
      void lerp;
    },
  };
}
