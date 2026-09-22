// SPEEDCORE — the shredder.
//
// Past about 300 BPM the ear stops hearing individual kicks and starts hearing
// a TONE: the kick drum becomes a pitch, and the music becomes a texture with
// events cut into it. That is the fact to draw. A scene that tries to put one
// mark on screen per kick at 400 BPM is drawing six flashes a second, which the
// eye integrates into a grey rectangle — the picture has to work the way the
// hearing does and show the texture, not the pulse.
//
// So: the frame is SHREDDED into horizontal slices that race sideways at a rate
// taken from the tempo itself, and the events are TEARS — whole bands of slices
// thrown out of alignment. The faster the track, the finer the slices and the
// faster they run, so 250 BPM looks coarse and mean and 500 BPM looks like a
// solid moving surface with things ripping through it.
//
// Slice count and speed both come from `m.bpm` directly, which is the one place
// in this directory where the tempo NUMBER is used rather than the beat length:
// the point here is precisely that the character changes with absolute speed.

import { clamp, hsl, lerp } from "../util.js";
import { pool } from "./kit.js";

export const meta = { label: "Speedcore", trail: 0.66 };

export function create(preset, opts) {
  const MAX = 64;
  const offset = new Float32Array(MAX);
  const speed = new Float32Array(MAX);
  const amp = new Float32Array(MAX);
  for (let i = 0; i < MAX; i++) speed[i] = (i % 2 ? -1 : 1) * (0.5 + ((i * 37) % 11) / 11);
  const tears = pool(5, () => ({ age: -1, row: 0, rows: 1, shift: 0 }));
  const TEAR_LIFE = 0.5; // beats: at 400 BPM that is 75 ms, which is correct
  let rows = 24;

  return {
    update(frame, dt, geom, m) {
      // Finer at higher tempo. A 250 BPM track gets big coarse bands; a 450 BPM
      // one gets something close to scan lines.
      const fast = clamp(((m.bpm || 250) - 200) / 300, 0, 1);
      rows = Math.round(lerp(16, MAX, fast) * (0.7 + preset.layers * 0.08));
      rows = Math.max(8, Math.min(MAX, rows));

      const b = frame.bands;
      const per = b.length / rows;
      for (let i = 0; i < rows; i++) {
        let peak = 0;
        const a0 = Math.floor(i * per);
        const e0 = Math.floor((i + 1) * per);
        for (let j = a0; j < e0 && j < b.length; j++) if (b[j] > peak) peak = b[j];
        amp[i] = m.ease(amp[i], peak, 0.3, dt);
        // Eight screen-widths per bar: fast, and tempo-locked, so the texture
        // speeds up with the track instead of sitting at one rate.
        offset[i] = (offset[i] + dt * m.perBar(8) * speed[i] * (0.4 + m.drive) + 1) % 1;
      }

      // A tear on any real onset — and at this tempo there are a lot of them,
      // which is why the life is under a beat.
      if (m.onset > 0.4 || m.hit) {
        const t = tears.take();
        t.age = 0;
        t.row = Math.floor(((m.beatPhase * 7919) % 1) * rows);
        t.rows = 1 + Math.floor(m.chaos * 5);
        t.shift = (m.beatPhase - 0.5) * lerp(0.2, 0.9, m.chaos);
      }
      tears.age(dt, m.beat, TEAR_LIFE);
    },

    draw(g, geom, pal, w, m) {
      const W = geom.w;
      const H = geom.h;
      g.globalCompositeOperation = "lighter";
      const rh = H / rows;
      for (let i = 0; i < rows; i++) {
        const v = amp[i];
        if (v < 0.03) continue;
        let shift = 0;
        for (const t of tears.items)
          if (t.age >= 0 && i >= t.row && i < t.row + t.rows) shift += t.shift;
        const x = (((offset[i] + shift) % 1) + 1) % 1;
        const hue = pal.low + (pal.high - pal.low) * (1 - i / rows);
        const a = (0.03 + v * 0.22) * w.energy * preset.glow;
        g.fillStyle = hsl(hue, pal.sat, lerp(0.45, 0.78, v), a);
        // Two copies a screen apart so a slice leaving one edge is already
        // arriving at the other: at this speed a seam would strobe.
        const len = W * (0.25 + v * 0.55);
        g.fillRect(x * W, i * rh, len, rh * 0.86);
        g.fillRect(x * W - W, i * rh, len, rh * 0.86);
      }

      // The tone: past 300 BPM the kick is a pitch, so the low end is drawn as
      // a standing band rather than as a series of hits. It brightens with the
      // tempo, which is the one honest way to show "faster" once the individual
      // events have stopped being visible.
      const fast = clamp(((m.bpm || 250) - 260) / 240, 0, 1);
      if (fast > 0.02) {
        const cy = H * 0.5;
        const th = H * (0.04 + m.weight * 0.1);
        const tg = g.createLinearGradient(0, cy - th, 0, cy + th);
        tg.addColorStop(0, hsl(pal.low, pal.sat, 0.5, 0));
        tg.addColorStop(0.5, hsl(pal.low + 10, pal.sat * 0.9, 0.7, fast * 0.16 * w.energy * preset.glow));
        tg.addColorStop(1, hsl(pal.low, pal.sat, 0.5, 0));
        g.fillStyle = tg;
        g.fillRect(0, cy - th, W, th * 2);
      }
      g.globalCompositeOperation = "source-over";
      void opts;
    },
  };
}
