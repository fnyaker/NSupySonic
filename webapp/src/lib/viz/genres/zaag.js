// ZAAG — the saw, drawn as a saw.
//
// "Zaag" is Dutch for saw, and it is named after the sound: a kick whose tail
// is a screaming distorted sawtooth, sustained long enough to be a note rather
// than a thump. The whole sub-genre is that one sound, so the picture is that
// one waveform, at size, across the frame — and everything that happens to it
// happens because of what the kick is doing.
//
// A sawtooth is the right motif for a second reason: it is the one waveform
// whose LOOK changes with every parameter you would want to show. Its period
// is the tempo, its amplitude is the drive, its asymmetry is the distortion,
// and the noise on its edges is the grit. All four are measured, so the wave on
// screen is the wave in the track rather than a decoration shaped like one.
//
// The teeth per screen come from the tempo: a bar of the track fills the frame,
// so the waveform is a picture of one bar and it re-times itself when the
// tempo does.

import { clamp, hsl, lerp } from "../util.js";
import { traceLine } from "./kit.js";

export const meta = { label: "Zaag", trail: 0.44 };

export function create(preset, opts) {
  let drag = 0; // how far the wave is pulled sideways by a kick
  let bite = 0; // how sharp the teeth are right now
  let grit = 0.2;

  return {
    update(frame, dt, geom, m) {
      if (m.hit || (m.onBeat && m.kick > 0.25)) {
        // A kick drags the whole wave back and lets it spring forward: the
        // tail of a zaag kick bends in pitch, and this is that bend.
        drag = 0.1 + m.kick * 0.18 * m.punch;
        bite = clamp(0.5 + m.kick * 0.7, 0, 1.3);
      }
      drag = m.ease(drag, 0, 0.7, dt);
      bite = m.ease(bite, 0.15 + m.drive * 0.35, 0.9, dt);
      // The grit: how noisy the top end is. A clean saw and a destroyed one are
      // the difference between hardtekk and zaag, so it is measured, not set.
      grit = m.ease(grit, clamp((frame.features?.flatness || 0) * 1.6, 0, 1), 3, dt);
    },

    draw(g, geom, pal, w, m) {
      const W = geom.w;
      const H = geom.h;
      const cy = geom.hole ? Math.min(H * 0.86, geom.cy + geom.hh + H * 0.14) : H * 0.55;
      g.globalCompositeOperation = "lighter";

      // One bar across the frame, four teeth — one per beat. The phase comes
      // from the bar position, so the wave is locked to the music and a tooth
      // is always a beat wherever the tempo goes.
      const teeth = 4;
      const amp = H * (0.1 + m.drive * 0.2 + bite * 0.12);
      const phase = m.barPhase + drag;
      const steps = Math.max(96, Math.min(400, Math.floor(W / 4)));

      // A sawtooth with an ADJUSTABLE RISE: symmetric is a triangle, zero-rise
      // is a hard saw. The distortion in the track sets it, so a clean lead
      // draws a triangle and a mangled one draws a blade.
      const rise = lerp(0.42, 0.06, clamp(bite, 0, 1));
      const wave = (t) => {
        const u = ((t * teeth - phase * teeth) % 1 + 1) % 1;
        return u < rise ? u / rise : 1 - (u - rise) / (1 - rise);
      };

      // Three passes: a wide soft body, the line itself, and a grit pass that
      // only exists when the track is actually noisy.
      for (const pass of [0, 1, 2]) {
        if (pass === 2 && grit < 0.12) continue;
        const wobble = pass === 2 ? grit : 0;
        g.strokeStyle =
          pass === 0
            ? hsl(pal.low, pal.sat, 0.55, 0.1 * w.energy * preset.glow)
            : pass === 1
              ? hsl(pal.high, pal.sat, 0.85, (0.22 + bite * 0.2) * w.energy * preset.glow)
              : hsl(pal.high + 30, pal.sat * 0.6, 0.9, grit * 0.12 * w.energy * preset.glow);
        g.lineWidth =
          pass === 0
            ? Math.max(4, H * 0.03 * (0.5 + bite))
            : Math.max(1.5, H * 0.005 * (0.6 + bite));
        g.lineJoin = "miter";
        traceLine(g, steps, (t) => {
          const v = wave(t);
          // The grit pass is the same wave with noise on it — the noise is
          // seeded from the position so it is texture, not flicker.
          const n = wobble ? (Math.sin(t * 977 + m.fastSweep(1)) * 0.5) * wobble * 0.25 : 0;
          return [t * W, cy - (v - 0.5) * 2 * amp * (1 + n)];
        });
        g.stroke();
      }

      // The kick itself: a hard vertical at the tooth currently being struck.
      // It is the only straight line in a picture made of slopes.
      if (bite > 0.4) {
        const x = (((phase * teeth) % 1) / teeth + Math.floor(m.beatPhase * 0) ) * W;
        const a = (bite - 0.4) * 0.5 * w.energy * preset.glow;
        const kg = g.createLinearGradient(x - W * 0.01, 0, x + W * 0.01, 0);
        kg.addColorStop(0, hsl(pal.high, pal.sat, 0.9, 0));
        kg.addColorStop(0.5, hsl(pal.high, pal.sat * 0.5, 0.95, a));
        kg.addColorStop(1, hsl(pal.high, pal.sat, 0.9, 0));
        g.fillStyle = kg;
        g.fillRect(x - W * 0.01, cy - amp * 1.3, W * 0.02, amp * 2.6);
      }
      g.globalCompositeOperation = "source-over";
      void opts;
    },
  };
}
