// HARDTECHNO / SCHRANZ — the loop, and nothing else.
//
// "Schranz kicks are pure distortion with no melodic content underneath: just
// the kick, the rattle, the factory noise and the loop." The genre is built on
// refusing to develop — a bar repeats, and what changes is the PRESSURE around
// it: "the drive is not simply more distortion, it is the repeated midrange and
// percussive pressure that sits around the kick and keeps the groove moving".
//
// So the picture is a LOOP, literally: a closed band that goes round the frame
// once per bar, carrying a fixed pattern of teeth, with the playhead travelling
// along it. Nothing is born and nothing dies — the same teeth come round again,
// harder or softer depending on the drive. It is the only scene in here with no
// events in it at all, which is the point: a schranz track has no events in it
// either, it has a loop and a filter.
//
// The band's own rotation is one turn per bar, so the picture IS the bar. At
// 145 BPM that is 1.66 s a revolution and at 160 it is 1.5, and both fall out
// of the tempo rather than out of a number.

import { clamp, hsl, lerp } from "../util.js";
import { tracePolar } from "./kit.js";

export const meta = { label: "Hardtechno", trail: 0.46 };

export function create(preset, opts) {
  // Sixteen teeth: one per sixteenth of the bar, which is the grid this music
  // is written on and the grid its percussion sits on.
  const N = 16;
  const tooth = new Float32Array(N);
  const bite = new Float32Array(N);
  for (let i = 0; i < N; i++) bite[i] = i % 4 === 0 ? 1 : i % 2 === 0 ? 0.55 : 0.3;
  let press = 0; // the midrange drive: how hard the loop is being pushed
  let grit = 0.2;
  let head = 0;

  return {
    update(frame, dt, geom, m) {
      head = m.barPhase;
      // Every tooth is lit by how much energy its slot is carrying RIGHT NOW,
      // read as the head passes it. The loop does not remember: it re-reads.
      const slot = Math.floor(head * N) % N;
      tooth[slot] = clamp(
        bite[slot] * (0.4 + m.drive * 0.8) + m.onset * 0.5 + (m.mainKick ? 0.4 : 0),
        0,
        1.4
      );
      const fade = dt / Math.max(1e-4, m.overBeats(1.2));
      for (let i = 0; i < N; i++) tooth[i] = Math.max(bite[i] * 0.12, tooth[i] - fade);
      // The pressure: level times percussivity, which is exactly "the repeated
      // midrange sitting around the kick" and not the kick itself.
      press = m.ease(press, clamp(m.drive * 0.7 + (frame.features?.midFlux || 0) * 9, 0, 1), 1.5, dt);
      grit = m.ease(grit, clamp((frame.features?.flatness || 0) * 1.5, 0, 1), 3, dt);
    },

    draw(g, geom, pal, w, m) {
      g.globalCompositeOperation = "lighter";
      // The band sits at the frame's own edge, not on an inscribed circle, so
      // on a wide screen it goes round the room.
      const rad = 0.78 + press * 0.12;
      const aniso = 0.85;
      const spin = m.sweep(1);
      const span = (Math.PI * 2) / N;

      for (let i = 0; i < N; i++) {
        const v = tooth[i];
        const a = (0.03 + v * 0.34) * w.energy * preset.glow;
        if (a < 0.005) continue;
        const a0 = spin + (i / N) * Math.PI * 2;
        const hue = pal.low + (pal.high - pal.low) * bite[i] + v * 18;
        g.strokeStyle = hsl(hue, pal.sat * (0.7 + grit * 0.3), lerp(0.4, 0.88, clamp(v, 0, 1)), a);
        g.lineWidth = Math.max(2, geom.rMin * (0.02 + v * 0.06) * (0.6 + press * 0.8));
        g.lineCap = "butt";
        // A tooth is a radial BAR, not an arc: this is machinery, and the
        // teeth on a gear point inward.
        tracePolar(g, geom, 6, (t) => [a0 + t * span * 0.5, rad - t * (0.1 + v * 0.22)], aniso);
        g.stroke();
      }

      // The playhead: a hard wedge sweeping the band. It is the only thing in
      // the picture that moves in a direction, which is what makes a loop read
      // as a loop rather than as a ring of lights.
      const hp = geom.place(spin + head * Math.PI * 2, rad, aniso);
      const hx = hp[0];
      const hy = hp[1];
      const hg = g.createRadialGradient(hx, hy, 0, hx, hy, geom.rMin * (0.2 + press * 0.25));
      hg.addColorStop(0, hsl(pal.high, pal.sat * 0.6, 0.9, (0.1 + press * 0.3) * w.energy * preset.glow));
      hg.addColorStop(1, hsl(pal.high, pal.sat, 0.6, 0));
      g.fillStyle = hg;
      g.fillRect(0, 0, geom.w, geom.h);

      // The factory floor: horizontal bands of pressure across the whole
      // frame, breathing with the drive. No detail, no events — extraction.
      const rows = 5;
      for (let r = 0; r < rows; r++) {
        const y = geom.h * ((r + 0.5) / rows);
        const amp = press * (0.5 + ((r * 7) % 5) / 8);
        const a = 0.05 * amp * w.energy * preset.glow;
        if (a < 0.004) continue;
        const bg = g.createLinearGradient(0, y - geom.h * 0.06, 0, y + geom.h * 0.06);
        bg.addColorStop(0, hsl(pal.mid, pal.sat * 0.5, 0.5, 0));
        bg.addColorStop(0.5, hsl(pal.mid, pal.sat * (0.4 + grit * 0.5), 0.6, a));
        bg.addColorStop(1, hsl(pal.mid, pal.sat * 0.5, 0.5, 0));
        g.fillStyle = bg;
        g.fillRect(0, y - geom.h * 0.06, geom.w, geom.h * 0.12);
      }
      g.globalCompositeOperation = "source-over";
      void opts;
    },
  };
}
