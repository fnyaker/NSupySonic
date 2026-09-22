// GERMAN PARTY TEKK — the sing-along.
//
// The party end of the German tekk spectrum: the same hardtekk kick, but the
// track is built around a VOCAL — a hook, a chant, a chopped sample everybody
// in the room already knows. Where hardtekk proper is "minimal melodic content,
// short stabs and alarms used for tension and release", this is the version
// with a chorus, and that is the only thing worth drawing differently.
//
// So the motif is a CROWD: a horizon of raised arms across the bottom of the
// frame, rising and falling with the vocal, lit from a rig above. The kick
// pushes the whole crowd up; the vocal decides how far the arms reach and how
// bright the rig is. It is the only scene in this family pointed at the room
// rather than at the sound, which is what a party genre is about.
//
// `vocalMod` — syllabic-rate modulation of the mid band, which is as close to
// "somebody is singing" as a cheap measurement gets — is what drives it.

import { clamp, hsl, lerp } from "../util.js";

export const meta = { label: "German party", trail: 0.38 };

export function create(preset, opts) {
  const ARMS = 46;
  const height = new Float32Array(ARMS);
  const rate = new Float32Array(ARMS);
  for (let i = 0; i < ARMS; i++) rate[i] = 0.6 + ((i * 23) % 9) / 9;
  let voice = 0;
  let surge = 0;
  let beams = 0;

  return {
    update(frame, dt, geom, m) {
      const f = frame.features || {};
      // The chorus. Smoothed over seconds, because a crowd does not change its
      // mind bar by bar, and gated by the dynamics so a breakdown empties it.
      voice = m.ease(
        voice,
        clamp((f.vocalMod || 0) * 1.3 + m.melodic * 0.4, 0, 1) * (f.dynamics ?? 1),
        2.5,
        dt
      );
      if (m.mainKick || m.hit || (m.onBeat && m.kick > 0.3))
        surge = clamp(0.45 + (m.mainPower || m.kick) * 0.7, 0, 1.3);
      surge = m.ease(surge, 0, 0.5, dt);
      if (m.drop) beams = 1.2;
      beams = m.ease(beams, 0.2 + voice * 0.6, 1.5, dt);

      // Each arm answers on its own beat, so the crowd is a wave and not a
      // rank. A wave is what a crowd looks like from the stage.
      for (let i = 0; i < ARMS; i++) {
        const phase = (m.barPhase + i / ARMS) % 1;
        const want =
          (0.2 + voice * 0.7) * (0.5 + Math.sin(phase * Math.PI * 2) * 0.5) + surge * 0.35;
        height[i] = m.ease(height[i], clamp(want, 0, 1.2), 0.6 * rate[i], dt);
      }
    },

    draw(g, geom, pal, w, m) {
      const W = geom.w;
      const H = geom.h;
      g.globalCompositeOperation = "lighter";

      // The rig: beams sweeping down from above the frame, across its whole
      // width. They are what light the crowd, so they are drawn first.
      const nb = 5;
      for (let i = 0; i < nb; i++) {
        const sweep = Math.sin(m.sweep(0.25) + (i / nb) * Math.PI * 2);
        const x = W * (0.5 + sweep * 0.55);
        const a = (0.03 + beams * 0.12) * w.energy * preset.glow;
        if (a < 0.004) continue;
        const bg = g.createLinearGradient(W * 0.5, -H * 0.1, x, H);
        bg.addColorStop(0, hsl(pal.high, pal.sat * 0.5, 0.9, a));
        bg.addColorStop(1, hsl(pal.mid, pal.sat, 0.55, 0));
        g.fillStyle = bg;
        g.beginPath();
        g.moveTo(W * 0.5 - W * 0.02, -H * 0.1);
        g.lineTo(W * 0.5 + W * 0.02, -H * 0.1);
        g.lineTo(x + W * 0.12, H);
        g.lineTo(x - W * 0.12, H);
        g.closePath();
        g.fill();
      }

      // The crowd. A silhouette line with arms, along the bottom of the frame.
      const base = H * 0.99;
      const aw = W / ARMS;
      for (let i = 0; i < ARMS; i++) {
        const v = height[i];
        const a = (0.05 + v * 0.4) * w.energy * preset.glow;
        if (a < 0.005) continue;
        const h = H * (0.1 + v * 0.3);
        const x = (i + 0.5) * aw;
        const hue = pal.low + (pal.high - pal.low) * (i / ARMS) * 0.7 + v * 16;
        g.strokeStyle = hsl(hue, pal.sat, lerp(0.4, 0.92, clamp(v, 0, 1)), a);
        g.lineWidth = Math.max(1.5, aw * 0.28);
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(x, base);
        // The arm leans with the wave, which is what stops a row of bars from
        // reading as a spectrum analyser.
        g.lineTo(x + Math.sin(m.barPhase * Math.PI * 2 + i * 0.4) * aw * 1.2, base - h);
        g.stroke();
      }

      // The floor the crowd is standing on, pushed by the kick.
      if (surge > 0.03) {
        const fg = g.createLinearGradient(0, H * 0.82, 0, H);
        fg.addColorStop(0, hsl(pal.low, pal.sat, 0.5, 0));
        fg.addColorStop(1, hsl(pal.low + 12, pal.sat, 0.65, surge * 0.28 * w.energy * preset.glow));
        g.fillStyle = fg;
        g.fillRect(0, H * 0.82, W, H * 0.18);
      }
      g.globalCompositeOperation = "source-over";
      void opts;
    },
  };
}
