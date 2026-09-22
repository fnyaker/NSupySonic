// HARD PING-PONG — the name is the rhythm.
//
// This one is named after what it does: the accent bounces between two places,
// left and right, on the offbeat, over a tekk kick. It is a German party-tekk
// idiom rather than a documented genre with a literature, so this file is built
// from the NAME and from the bed it sits on (hardtekk: "shorter, heavily
// saturated kicks that lock into muscular, stomping patterns, shuffled hats and
// claps that create a forward-leaning swing") rather than from research that
// does not exist. Said plainly here so nobody mistakes it for more than it is.
//
// The motif is therefore a rally. A ball crosses the frame between two paddles,
// struck on every offbeat, and the kick is the floor it bounces over. The rally
// SPEEDS UP as the track drives — more strokes per bar — which is what the
// idiom actually does, and slows into a breakdown rather than stopping.
//
// Every stroke is half a beat, so the rally is the music's own rhythm and not
// an animation with a speed.

import { clamp, hsl, lerp } from "../util.js";
import { pool } from "./kit.js";

export const meta = { label: "Hard ping-pong", trail: 0.36 };

export function create(preset, opts) {
  const trail = pool(18, () => ({ age: -1, x: 0, lane: 0, power: 0 }));
  const TRAIL_LIFE = 1.6; // beats
  let side = 1;
  let lastStroke = -1;
  let paddleL = 0;
  let paddleR = 0;
  let floor = 0;

  return {
    update(frame, dt, geom, m) {
      // Strokes per beat: two at rest, four when the track is driving. Read
      // off `m.drive`, so a build genuinely quickens the rally.
      const per = m.drive > 0.6 ? 4 : 2;
      const stroke = Math.floor(m.beatPhase * per) + Math.round(m.beatPhase * 0) ;
      const key = Math.floor((m.barPhase * 4 * per));
      if (key !== lastStroke) {
        lastStroke = key;
        side = -side;
        const power = clamp(0.35 + m.onset * 0.6 + m.drive * 0.4, 0, 1.2);
        if (side > 0) paddleR = power;
        else paddleL = power;
        const t = trail.take();
        t.age = 0;
        t.x = side > 0 ? 0.88 : 0.12;
        // The LANE the rally is played in, -1 (high) to +1 (low), resolved to
        // pixels at draw time because where the lanes are depends on where the
        // artwork is. Storing a fraction of the frame here was how nearly a
        // third of this scene ended up behind the album cover: the rally is a
        // horizontal motif and the cover sits exactly across the middle of a
        // phone, so every stroke crossed it.
        t.lane = clamp(Math.sin(key * 1.7) * (0.4 + m.air) * 1.4, -1, 1);
        t.power = power;
      }
      void stroke;
      paddleL = m.ease(paddleL, 0, 0.5, dt);
      paddleR = m.ease(paddleR, 0, 0.5, dt);
      if (m.mainKick || m.hit || (m.onBeat && m.kick > 0.3))
        floor = clamp(0.4 + (m.mainPower || m.kick) * 0.6, 0, 1.2);
      floor = m.ease(floor, 0, 0.4, dt);
      trail.age(dt, m.beat, TRAIL_LIFE);
    },

    draw(g, geom, pal, w, m) {
      const W = geom.w;
      const H = geom.h;
      g.globalCompositeOperation = "lighter";

      // The paddles: full-height bars at the frame's own edges, so the rally
      // is as wide as the screen.
      for (const [v, x] of [[paddleL, W * 0.03], [paddleR, W * 0.97]]) {
        const a = (0.06 + v * 0.45) * w.energy * preset.glow;
        if (a < 0.006) continue;
        const h = H * (0.18 + v * 0.3);
        const pg = g.createLinearGradient(0, H / 2 - h, 0, H / 2 + h);
        pg.addColorStop(0, hsl(pal.low, pal.sat, 0.5, 0));
        pg.addColorStop(0.5, hsl(pal.high, pal.sat, lerp(0.55, 0.95, v), a));
        pg.addColorStop(1, hsl(pal.low, pal.sat, 0.5, 0));
        g.fillStyle = pg;
        g.fillRect(x - W * 0.016, H / 2 - h, W * 0.032, h * 2);
      }

      // The ball and its wake. Drawn as a run of dots between the last strokes
      // rather than as one moving dot: the wake is what makes a rally read as
      // a rally, and it is also the only way to see how fast it has become.
      for (const t of trail.items) {
        if (t.age < 0) continue;
        const u = t.age / TRAIL_LIFE;
        const a = (1 - u) * (1 - u) * t.power * 0.5 * w.energy * preset.glow;
        if (a < 0.005) continue;
        // The ball travels FROM the paddle it left toward the other one.
        const x = (t.x + (t.x > 0.5 ? -1 : 1) * u * 0.76) * W;
        // ...along a lane that goes ABOVE or BELOW the artwork, and arcs away
        // from it rather than into it.
        const away = t.lane < 0 ? -1 : 1;
        const y0 = geom.hole
          ? t.lane < 0
            ? (geom.cy - geom.hh) * (0.7 + t.lane * 0.45)
            : geom.cy + geom.hh + geom.floorH * (0.3 + t.lane * 0.45)
          : H * (0.5 + t.lane * 0.22);
        const y = y0 + Math.sin(u * Math.PI) * away * H * 0.06 * t.power;
        const r = geom.rMin * (0.02 + t.power * 0.03) * (1 - u * 0.4);
        const bg = g.createRadialGradient(x, y, 0, x, y, r * 3);
        bg.addColorStop(0, hsl(pal.high, pal.sat * 0.4, 0.98, a));
        bg.addColorStop(1, hsl(pal.mid, pal.sat, 0.6, 0));
        g.fillStyle = bg;
        g.fillRect(x - r * 3, y - r * 3, r * 6, r * 6);
      }

      // The floor: the kick, as a band across the bottom of the frame that the
      // rally happens above.
      if (floor > 0.03) {
        const y = H * 0.94;
        const fg = g.createLinearGradient(0, y - H * 0.08, 0, y + H * 0.04);
        fg.addColorStop(0, hsl(pal.low, pal.sat, 0.5, 0));
        fg.addColorStop(1, hsl(pal.low + 18, pal.sat, 0.7, floor * 0.35 * w.energy * preset.glow));
        g.fillStyle = fg;
        g.fillRect(0, y - H * 0.08, W, H * 0.12);
      }
      g.globalCompositeOperation = "source-over";
      void opts;
    },
  };
}
