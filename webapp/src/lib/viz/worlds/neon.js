// VAPORWAVE / CITY POP / SYNTHPOP / FUTURE FUNK / ITALO — a neon sign.
//
// Close cousin of `horizon` and deliberately not the same picture: the sun over
// the grid is a LANDSCAPE, and this is a STREET. Strokes of neon tubing hanging
// in the dark, buzzing and flickering, over a wet reflection of themselves,
// through a VHS tracking error.
//
// The reflection is what makes it: every sign is drawn again below the floor
// line, flipped and blurred by being drawn wider and dimmer, which reads as wet
// tarmac and costs one extra fill.
//
// skin.p — signs (how many tubes), vhs (tracking noise and chroma bleed),
//          flicker (how unreliable the tubes are)

import { approach, clamp, envelope, hsl, lerp, rng } from "../util.js";

// `bend` turns each tube into an L — neon is bent glass, and a corner is what
// makes a run of it read as lettering rather than as a rule. `wet` ripples the
// reflection below the street; city pop is a dry night and vaporwave is not.
export function createNeonWorld(preset, opts, skin = {}) {
  const p = skin.p || {};
  const rand = rng(1986);
  const BEND = clamp(p.bend ?? 0, 0, 1);
  const WET = clamp(p.wet ?? 0, 0, 1);
  const N = Math.max(3, Math.round((preset.layers + 2) * (p.signs ?? 1)));
  const sign = [];
  for (let i = 0; i < N; i++) {
    // A tube is a short run of segments — a couple of strokes at right angles,
    // like lettering seen edge-on. Straight lines only: neon bends, but a
    // straight run is what reads as a sign at a glance.
    const horiz = rand() < 0.55;
    sign.push({
      x: 0.08 + rand() * 0.84,
      y: 0.12 + rand() * 0.52,
      len: 0.08 + rand() * 0.24,
      horiz,
      band: (rand() * 6) | 0,
      lit: 0,
      k: rand(),
      buzz: rand() * 6.28,
    });
  }
  let level = 0;
  let clock = 0;
  let track = 0; // the VHS tracking error, crawling down the frame
  let kick = 0;

  return {
    update(frame, dt) {
      clock += dt;
      const f = frame.features;
      const b = frame.bands;
      level = approach(level, f.level || 0, 0.25, dt);
      kick = envelope(kick, clamp((f.kick || 0) * 1.1, 0, 1), dt, 0.01, 0.22);
      for (const s of sign) {
        const bi = Math.min(b.length - 1, Math.floor(((s.band + 0.5) / 6) * b.length));
        // A tube lights with its band and FLICKERS: neon is never quite steady,
        // and a sign that fades smoothly reads as a gradient rather than a tube.
        const flick = 1 - (p.flicker ?? 0.5) * 0.35 * (0.5 + 0.5 * Math.sin(clock * 11 + s.buzz));
        s.lit = approach(s.lit, clamp(b[bi] * 1.25, 0, 1) * flick, 0.09, dt);
      }
      track = (track + dt * lerp(0.05, 0.3, p.vhs ?? 0.5)) % 1.4;
    },

    draw(g, geom, pal, w) {
      const W = geom.w;
      const H = geom.h;
      const floor = geom.hole ? Math.min(H * 0.96, geom.cy + geom.hh + H * 0.05) : H * 0.72;
      const vhs = p.vhs ?? 0.5;
      g.globalCompositeOperation = "lighter";

      const drawTube = (s, y, scale, alpha, blur) => {
        const x0 = s.x * W;
        const len = s.len * (s.horiz ? W : H) * scale;
        const down = scale < 0 ? -1 : 1;
        const x1 = s.horiz ? x0 + len : x0;
        const y1 = s.horiz ? y : y + len * down;
        // The bend: a second run leaving the end of the first at a right angle.
        // A ripple on the reflection, if the street is wet — the same tube seen
        // through moving water, not a different object.
        const wob = WET > 0.05 && scale < 0 ? Math.sin(clock * 2.4 + s.buzz) * W * 0.006 * WET : 0;
        const bx = s.horiz ? x1 : x1 + s.len * W * BEND * (s.k < 0.5 ? -1 : 1);
        const by = s.horiz ? y1 + s.len * H * BEND * down : y1;
        const hue = pal.low + ((pal.high - pal.low) * s.band) / 5;
        g.lineCap = "round";
        const run = () => {
          g.beginPath();
          g.moveTo(x0 + wob, y);
          g.lineTo(x1 + wob, y1);
          if (BEND > 0.05) g.lineTo(bx + wob, by);
          g.stroke();
        };
        // The glow around the tube, then the tube itself: two strokes, which is
        // how every neon sign is drawn and why it does not look like a line.
        g.strokeStyle = hsl(hue, pal.sat, 0.6, alpha * 0.35);
        g.lineWidth = Math.max(2, geom.rMin * 0.03 * blur);
        run();
        g.strokeStyle = hsl(hue + 10, pal.sat * 0.6, 0.9, alpha);
        g.lineWidth = Math.max(1, geom.rMin * 0.007 * blur);
        run();
      };

      for (const s of sign) {
        if (s.lit < 0.03) continue;
        const y = s.y * H;
        const a = (0.12 + s.lit * 0.5) * w.energy * preset.glow;
        // The chroma bleed: the same tube drawn twice more, a hair to each side
        // and in the two ends of the palette. Cheap, and it is the single most
        // recognisable thing about a tape-dubbed picture.
        if (vhs > 0.15) {
          const d = W * 0.0025 * vhs * (1 + kick * 2);
          g.save();
          g.translate(-d, 0);
          drawTube(s, y, 1, a * 0.4, 1);
          g.restore();
          g.save();
          g.translate(d, 0);
          drawTube(s, y, 1, a * 0.4, 1);
          g.restore();
        }
        drawTube(s, y, 1, a, 1);
        // ...and again, upside down under the floor: wet tarmac.
        const refl = floor + (floor - y) * 0.55;
        if (refl < H) drawTube(s, refl, -0.8, a * 0.22, 2.4);
      }

      // The street: a dark band under the signs that the reflections sit in.
      const fg = g.createLinearGradient(0, floor - H * 0.02, 0, H);
      fg.addColorStop(0, hsl(pal.mid, pal.sat, 0.55, 0.07 * w.energy * preset.glow));
      fg.addColorStop(1, hsl(pal.low, pal.sat * 0.8, 0.35, 0));
      g.fillStyle = fg;
      g.fillRect(0, floor - H * 0.02, W, H - floor + H * 0.02);

      // The tracking error: one bright, displaced scan band crawling down.
      if (vhs > 0.2) {
        const y = (track / 1.4) * (H + 60) - 30;
        const th = H * 0.02 * (0.5 + vhs);
        g.fillStyle = hsl(pal.high, 0.15, 0.95, 0.05 * vhs * w.energy);
        g.fillRect(0, y, W, th);
        g.fillStyle = hsl(pal.low, pal.sat, 0.5, 0.04 * vhs * w.energy);
        g.fillRect(0, y + th, W, th * 0.6);
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}
