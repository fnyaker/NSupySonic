// PIEEP — the alarm.
//
// Hardtekk's melodic content is "short stabs, alarms, or vox chops used for
// tension and release", and "pieep" is the scene's own name for the loudest of
// them: a high, square, unapologetically synthetic beep playing a two- or
// three-note figure over the kick. It is a genre named after one sound, and
// that sound is a SIGNAL — a klaxon, a reversing lorry, a station announcement
// — not a melody in any ordinary sense.
//
// So the picture is a SIGNAL BOARD: a row of lamps across the frame that light
// in a repeating figure, with the whole board flashing on the kick. Everything
// is square-edged and everything snaps — no curves, no fades, no bloom of its
// own, because the sound has no attack envelope worth the name either.
//
// The figure's length comes from the bar and its step from the beat, so at 160
// BPM the lamps step every 375 ms and at 180 every 333, and neither number is
// written anywhere.

import { clamp, hsl, lerp } from "../util.js";

export const meta = { label: "Pieep", trail: 0.34 };

export function create(preset, opts) {
  const LAMPS = 16;
  const lit = new Float32Array(LAMPS);
  // The figure: which lamp is on at each step of the bar. Two and three note
  // patterns, because that is what the sound plays.
  const FIGURES = [
    [0, 4, 8, 4],
    [2, 6, 2, 11],
    [0, 7, 14, 7],
    [3, 3, 9, 12],
  ];
  let figure = 0;
  let lastStep = -1;
  let flash = 0;
  let bar = 0;

  return {
    update(frame, dt, geom, m) {
      // Sixteen steps to the bar, which is where the figure's timing comes
      // from — the lamps are a sequencer, so they step on the grid.
      const step = Math.floor(m.barPhase * 16) % 16;
      if (step !== lastStep) {
        if (step < lastStep) {
          bar++;
          // The figure turns over every four bars, which is a phrase.
          if (bar % 4 === 0) figure = (figure + 1) % FIGURES.length;
        }
        lastStep = step;
        const f = FIGURES[figure];
        const idx = f[step % f.length];
        // Only on the steps the figure actually plays: a lamp board where
        // everything lights at once is not a signal, it is a wall.
        if (step % 2 === 0 || m.air > 0.55) {
          const spread = 1 + Math.round(m.density * 2);
          for (let d = 0; d < spread; d++) {
            const j = (idx + d * 5) % LAMPS;
            lit[j] = clamp(0.6 + m.note * 10 + m.air * 0.4, 0, 1.4);
          }
        }
      }
      // A lamp holds for a fraction of a beat then goes out hard. Squareness
      // is the point: a slow fade would be a different instrument.
      const drop = dt / Math.max(1e-4, m.overBeats(0.35));
      for (let i = 0; i < LAMPS; i++) lit[i] = Math.max(0, lit[i] - drop);

      if (m.mainKick || m.hit || (m.onBeat && m.kick > 0.3))
        flash = clamp(0.4 + (m.mainPower || m.kick) * 0.6, 0, 1.2);
      flash = m.ease(flash, 0, 0.22, dt);
    },

    draw(g, geom, pal, w, m) {
      const W = geom.w;
      const H = geom.h;
      g.globalCompositeOperation = "lighter";

      // The board fills the width and clears the artwork by sitting in two
      // rows, above and below it, rather than one row through the middle.
      const rows = geom.hole ? 2 : 1;
      const cellW = W / LAMPS;
      const padX = cellW * 0.14;
      const h = H * (rows === 2 ? 0.16 : 0.26) * (0.7 + m.density * 0.5);
      const ys =
        rows === 2
          ? [geom.cy - geom.hh - h * 1.2, geom.cy + geom.hh + h * 0.2]
          : [H * 0.5 - h / 2];

      for (const y0 of ys) {
        if (y0 < -h || y0 > H) continue;
        for (let i = 0; i < LAMPS; i++) {
          const v = clamp(lit[i] + flash * 0.35, 0, 1.4);
          const a = (0.03 + v * 0.5) * w.energy * preset.glow;
          if (a < 0.005) continue;
          const hue = pal.low + (pal.high - pal.low) * (i / LAMPS) + v * 24;
          g.fillStyle = hsl(hue, pal.sat, lerp(0.42, 0.95, clamp(v, 0, 1)), a);
          // A lit lamp is TALLER, not just brighter: the board has to read
          // from across a room, where brightness alone does not.
          const grow = h * v * 0.3;
          g.fillRect(i * cellW + padX, y0 - grow * 0.5, cellW - padX * 2, h + grow);
        }
      }

      // The kick flashes the whole board's backing plate.
      if (flash > 0.03) {
        g.fillStyle = hsl(pal.mid, pal.sat * 0.7, 0.6, flash * 0.12 * w.energy * preset.glow);
        for (const y0 of ys) g.fillRect(0, y0 - h * 0.2, W, h * 1.4);
      }

      // Two rails, top and bottom of the frame, carrying the beat across the
      // screen. They are what stops the board being an island in the middle.
      const railY = [H * 0.035, H * 0.965];
      const travel = (m.barPhase + m.beatPhase * 0.02) % 1;
      for (let r = 0; r < 2; r++) {
        const x = (r === 0 ? travel : 1 - travel) * W;
        const len = W * (0.06 + m.drive * 0.1);
        const rg = g.createLinearGradient(x - len, 0, x + len, 0);
        rg.addColorStop(0, hsl(pal.high, pal.sat, 0.8, 0));
        rg.addColorStop(0.5, hsl(pal.high, pal.sat, 0.9, (0.1 + flash * 0.3) * w.energy * preset.glow));
        rg.addColorStop(1, hsl(pal.high, pal.sat, 0.8, 0));
        g.fillStyle = rg;
        g.fillRect(x - len, railY[r] - H * 0.012, len * 2, H * 0.024);
      }
      g.globalCompositeOperation = "source-over";
      void opts;
    },
  };
}
