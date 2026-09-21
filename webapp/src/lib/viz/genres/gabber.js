// GABBER — the strobe and the crowd.
//
// Rotterdam, early nineties, 180-200 BPM: a clipped and overdriven 909 kick,
// almost no melody, and a room full of people doing the hakke under a strobe.
// The thing to get right is that gabber is NOT ornate. Every other hard genre
// in here has some decoration; this one has a light that is either on or off
// and a floor full of silhouettes. Drawing it prettily would be drawing
// something else.
//
// So: the frame FLASHES on the kick — a hard, near-white, full-frame flash with
// no falloff curve to speak of — and what the flash reveals is a jagged crowd
// line along the bottom that jumps with it. Between flashes there is almost
// nothing. That two-state, high-contrast reading is the entire look, and it is
// why this file has less in it than its neighbours rather than more.
//
// The one colour decision: the flash bleaches toward white as the kick gets
// harder, so a distorted peak-time kick strobes white and a softer one keeps
// the track's colour. That is the difference between early and late gabber and
// it comes out of the audio rather than out of a setting.

import { clamp, hsl, lerp } from "../util.js";
import { traceLine } from "./kit.js";

export const meta = { label: "Gabber", trail: 0.62 };

export function create(preset, opts) {
  // The crowd: a fixed silhouette profile, so it reads as the same room every
  // bar rather than as noise that happens to be at the bottom.
  const N = 46;
  const head = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // Heads of different heights, packed. A regular comb would read as a chart.
    head[i] = 0.45 + ((i * 2654435761) % 1000) / 1000 * 0.55;
  }
  const jump = new Float32Array(N);
  let flash = 0;
  let bleach = 0;

  return {
    update(frame, dt, geom, m) {
      if (m.hit || (m.onBeat && m.kick > 0.3)) {
        flash = clamp(0.55 + m.kick * 0.6, 0, 1.2);
        // How clipped the kick is, which is what "harder" means here. The
        // crest factor is low on a squashed kick, so a low crest bleaches.
        const crest = frame.features?.crest ?? 3;
        bleach = clamp(1 - (crest - 2) / 5, 0, 1);
        // The crowd jumps: not all at once, because a room does not.
        for (let i = 0; i < N; i++) {
          jump[i] = Math.max(jump[i], 0.4 + ((i * 7919) % 13) / 13 * 0.8);
        }
      }
      // A strobe has no decay to speak of. A fifth of a beat, so at 190 BPM it
      // is dark again well before the next one — which is what makes it strobe
      // rather than pulse.
      flash = m.ease(flash, 0, 0.18, dt);
      for (let i = 0; i < N; i++) jump[i] = m.ease(jump[i], 0, 0.55, dt);
    },

    draw(g, geom, pal, w, m) {
      const W = geom.w;
      const H = geom.h;
      const floor = geom.hole ? Math.min(H * 0.98, geom.cy + geom.hh + H * 0.12) : H * 0.92;

      // THE FLASH. Full frame, flat, no gradient: a strobe does not have a
      // falloff, and giving it one turns it into a glow from somewhere.
      if (flash > 0.01) {
        g.globalCompositeOperation = "lighter";
        g.fillStyle = hsl(
          pal.high,
          lerp(pal.sat * 0.8, 0.05, bleach),
          lerp(0.62, 0.95, bleach),
          Math.min(0.5, flash * 0.42) * w.energy * preset.glow
        );
        g.fillRect(0, 0, W, H);
      }

      // The room behind the crowd: a single bar of light at head height, so the
      // silhouette has something to be a silhouette against. It sits low and it
      // does not move, because the rig in a hall does not.
      g.globalCompositeOperation = "lighter";
      const rg = g.createLinearGradient(0, floor - H * 0.5, 0, floor);
      rg.addColorStop(0, hsl(pal.mid, pal.sat, 0.55, 0));
      rg.addColorStop(1, hsl(pal.mid, pal.sat, 0.6, (0.05 + m.drive * 0.12 + flash * 0.2) * w.energy * preset.glow));
      g.fillStyle = rg;
      g.fillRect(0, floor - H * 0.5, W, H * 0.5);

      // THE CROWD, opaque, drawn over the light. Hard edges, no smoothing: it
      // is the one place in the whole set where a jagged outline is the point.
      g.globalCompositeOperation = "source-over";
      const rise = H * (0.1 + m.drive * 0.06);
      traceLine(g, N, (t) => {
        const i = Math.min(N - 1, Math.floor(t * N));
        return [t * W, floor - (head[i] + jump[i] * 0.5) * rise];
      });
      g.lineTo(W, H);
      g.lineTo(0, H);
      g.closePath();
      g.fillStyle = hsl(pal.low, pal.sat * 0.3, 0.04, 0.97 * w.fade);
      g.fill();
      void opts;
    },
  };
}
