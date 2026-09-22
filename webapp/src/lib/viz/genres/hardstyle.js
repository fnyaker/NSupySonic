// HARDSTYLE — the see-saw.
//
// One thing defines this genre and it is not the kick. "The kick lands on every
// downbeat, the sub-bass plays on the offbeats in between, and the two are
// sidechained so they never overlap": the reverse bass. A hardstyle track is an
// ALTERNATION, and it is the only genre in this catalogue whose low end is two
// things taking turns rather than one thing repeating.
//
// So the picture is a see-saw. A beam across the frame, pinned in the middle,
// slammed down on one side by the kick and lifted on the other by the bass
// swelling underneath it — and because the two can never sound together, the
// beam is never level except in the instant between them. That alternation is
// the whole feel of the music and nothing built on a pulse can show it.
//
// Euphoric and raw are the same machine with different weather: `m.melodic`
// draws the anthem across the top (euphoric hardstyle is written around a
// sing-along lead) and `m.chaos` roughens the beam and dirties the light.
//
// Every rate is per beat or per bar. The beam's swing is `m.beatPhase`, so it
// takes exactly one beat whatever the tempo, and the recoil decays in beats.

import { clamp, hsl, lerp } from "../util.js";
import { pool, quad, traceLine } from "./kit.js";

export const meta = { label: "Hardstyle", trail: 0.42 };

export function create(preset, opts) {
  // -1 is kick side down, +1 is bass side down. It is a POSITION, driven by
  // where in the beat we are, not an animation with a duration of its own.
  let tilt = 0;
  let slam = 0; // the kick's impact, decaying
  let swell = 0; // the reverse bass rising on the offbeat
  let anthem = 0;
  const sparks = pool(14, () => ({ age: -1, side: 1, spread: 0, power: 0 }));
  const SPARK_LIFE = 1.4; // beats
  let side = 1;

  return {
    update(frame, dt, geom, m) {
      // The kick throws the beam. Which end depends on the beat, so a bar
      // rocks twice rather than hammering the same corner four times.
      if (m.mainKick || m.hit || (m.onBeat && m.kick > 0.3)) {
        side = m.barPhase < 0.5 ? -1 : 1;
        slam = clamp(0.6 + (m.mainPower || m.kick) * 0.8, 0, 1.4);
        const n = 2 + Math.round(m.chaos * 4);
        for (let i = 0; i < n; i++) {
          const s = sparks.take();
          s.age = 0;
          s.side = side;
          s.spread = (i / n - 0.5) * lerp(0.6, 1.8, m.chaos);
          s.power = slam * (0.5 + (i % 3) / 4);
        }
      }
      slam = m.ease(slam, 0, 0.3, dt);
      sparks.age(dt, m.beat, SPARK_LIFE);

      // THE OFFBEAT IS THE POINT. The bass is loudest exactly halfway between
      // kicks, so the swell is read off the beat's own phase rather than from
      // a detector — the sound it is drawing is defined by its position.
      const off = Math.sin(Math.PI * clamp(m.beatPhase, 0, 1));
      swell = m.ease(swell, off * off * (0.35 + m.weight * 0.9), 0.12, dt);

      // The beam: slammed toward the kick's side, lifted by the swell.
      const want = side * (slam * 0.9 - swell * 0.75);
      tilt = m.ease(tilt, clamp(want, -1.2, 1.2), 0.18, dt);
      anthem = m.ease(anthem, m.melodic * (0.3 + m.note * 12), 2, dt);
    },

    draw(g, geom, pal, w, m) {
      const W = geom.w;
      const H = geom.h;
      const cy = geom.hole ? Math.min(H * 0.9, geom.cy + geom.hh + H * 0.12) : H * 0.62;
      g.globalCompositeOperation = "lighter";

      // The beam reaches the frame's own edges, not an inscribed circle: on a
      // 16:9 beamer it is the width of the room.
      const half = W * 0.52;
      const lift = H * 0.3 * tilt;
      const thick = H * (0.018 + slam * 0.03 + m.weight * 0.012);
      const x0 = W / 2 - half;
      const x1 = W / 2 + half;
      const y0 = cy + lift;
      const y1 = cy - lift;

      // The pivot's glow, brightest when the beam is level — which is the
      // instant between the kick and the bass, and the only quiet moment in it.
      const level = 1 - Math.min(1, Math.abs(tilt) * 1.6);
      const pg = g.createRadialGradient(W / 2, cy, 0, W / 2, cy, H * (0.18 + level * 0.22));
      pg.addColorStop(0, hsl(pal.high, pal.sat * 0.6, 0.85, (0.05 + level * 0.18) * w.energy * preset.glow));
      pg.addColorStop(1, hsl(pal.mid, pal.sat, 0.5, 0));
      g.fillStyle = pg;
      g.fillRect(0, 0, W, H);

      // The beam itself. Two quads, so each half can carry its own weight: the
      // end that is down is the end that is loud.
      for (const s of [-1, 1]) {
        const xa = s < 0 ? x0 : W / 2;
        const xb = s < 0 ? W / 2 : x1;
        const ya = s < 0 ? y0 : cy;
        const yb = s < 0 ? cy : y1;
        const down = s * tilt > 0 ? 1 : 0;
        const heat = clamp(0.3 + down * (slam * 0.5 + swell * 0.4), 0, 1);
        const a = (0.1 + heat * 0.42) * w.energy * preset.glow;
        if (a < 0.006) continue;
        const bg = g.createLinearGradient(xa, ya, xb, yb);
        bg.addColorStop(0, hsl(pal.low + heat * 30, pal.sat, lerp(0.45, 0.85, heat), a * 0.6));
        bg.addColorStop(1, hsl(pal.high, pal.sat, lerp(0.5, 0.92, heat), a));
        g.fillStyle = bg;
        const t2 = thick * (0.7 + down * 0.6);
        quad(g, xa, ya - t2, xb, yb - t2, xb, yb + t2, xa, ya + t2);
        g.fill();
      }

      // The swell, drawn UNDER the raised end: a dome of low end lifting it.
      if (swell > 0.03) {
        const sx = W / 2 - side * half * 0.62;
        const sy = cy - lift * 0.9;
        const r = H * (0.12 + swell * 0.5) * (0.8 + m.weight * 0.6);
        const sg = g.createRadialGradient(sx, sy, 0, sx, sy, r);
        sg.addColorStop(0, hsl(pal.low, pal.sat, 0.6, swell * 0.4 * w.energy * preset.glow));
        sg.addColorStop(1, hsl(pal.low, pal.sat, 0.4, 0));
        g.fillStyle = sg;
        g.fillRect(0, 0, W, H);
      }

      // Sparks off the end that just landed. They travel along the beam rather
      // than away from it — this is weight hitting a stop, not an explosion.
      for (const s of sparks.items) {
        if (s.age < 0) continue;
        const t = s.age / SPARK_LIFE;
        const a = (1 - t) * (1 - t) * s.power * 0.4 * w.energy * preset.glow;
        if (a < 0.005) continue;
        const ex = W / 2 + s.side * half * (0.55 + t * 0.5);
        const ey = cy + s.side * lift * 0.9 + s.spread * H * 0.1 * (0.4 + t);
        const len = W * 0.03 * (0.4 + Math.abs(s.spread));
        g.strokeStyle = hsl(pal.high, pal.sat * 0.5, 0.95, a);
        g.lineWidth = Math.max(1, H * 0.0035 * (1 - t));
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(ex - s.side * len, ey);
        g.lineTo(ex, ey);
        g.stroke();
      }

      // The anthem: euphoric hardstyle's sing-along lead, across the top. Drawn
      // only when there is one, so raw stays as dark as it sounds.
      if (anthem > 0.04) {
        g.strokeStyle = hsl(pal.high + 14, pal.sat, 0.88, anthem * 0.5 * w.energy * preset.glow);
        g.lineWidth = Math.max(1.5, H * 0.004 * (1 + m.note * 16));
        g.lineCap = "round";
        const pitch = frameMelody(m);
        traceLine(g, 40, (t) => [
          t * W,
          H * (0.2 - pitch * 0.1) + Math.sin(t * Math.PI * 4 + m.sweep(1)) * H * 0.035 * anthem,
        ]);
        g.stroke();
      }
      g.globalCompositeOperation = "source-over";
      void opts;
    },
  };
}

// The melody's height, clamped so a track with no lead leaves the line flat
// rather than parked at the top of the frame.
function frameMelody(m) {
  return clamp(m.melodic * 0.6 + m.air * 0.4, 0, 1);
}
