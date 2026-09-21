// ROCK / METAL / PUNK / HARD ROCK / BRUTAL — a stage.
//
// A band is people on a stage under lights, so the motif is exactly that: cones
// of light sweeping from above, a jagged silhouette along the bottom cut from
// the mid band (the guitars), and a white slash on the snare. It is the only
// world lit from the TOP rather than from the middle, which is what makes it
// read as a room rather than as an effect.

import { approach, clamp, envelope, hsl, lerp, rng } from "../util.js";

const SLASH = 5;

export function createStagelightsWorld(preset, opts) {
  const BEAMS = Math.max(3, Math.min(6, preset.layers + 1));
  const WALL = 72;
  const wall = new Float32Array(WALL);
  const rand = rng(5150);
  const beam = [];
  for (let i = 0; i < BEAMS; i++)
    beam.push({ x: (i + 0.5) / BEAMS, phase: rand() * 6.28, speed: 0.18 + rand() * 0.22, lit: 0 });
  const slashes = [];
  for (let i = 0; i < SLASH; i++) slashes.push({ age: -1, x: 0, dir: 1, p: 0 });
  let slashNext = 0;
  let clock = 0;
  let strobe = 0;
  let chaos = 0.35;
  let prevMid = 0;

  return {
    update(frame, dt) {
      clock += dt;
      const f = frame.features;
      const b = frame.bands;
      const beat = frame.beat;
      const look = frame.style?.look;
      chaos = approach(chaos, look ? look.chaos : 0.35, 1.2, dt);

      // The wall: the mid band only. Guitars, not the whole spectrum — drawing
      // everything would just be a second spectrum analyser.
      const from = Math.floor(b.length * 0.2);
      const to = Math.floor(b.length * 0.82);
      const per = (to - from) / WALL;
      for (let i = 0; i < WALL; i++) {
        let m = 0;
        const a = from + Math.floor(i * per);
        const e = from + Math.floor((i + 1) * per);
        for (let j = a; j < e && j < b.length; j++) if (b[j] > m) m = b[j];
        wall[i] = envelope(wall[i], m, dt, 0.02, 0.12);
      }

      const lvl = f.level || 0;
      for (const bm of beam) {
        bm.phase += dt * bm.speed * lerp(0.6, 1.8, chaos);
        bm.lit = envelope(bm.lit, clamp(lvl * 1.2, 0, 1), dt, 0.05, 0.35);
      }

      const mid = f.midFlux || 0;
      if (mid > prevMid * 2 && mid > 0.006) {
        const s = slashes[(slashNext = (slashNext + 1) % SLASH)];
        s.age = 0;
        s.x = 0.1 + rand() * 0.8;
        s.dir = rand() < 0.5 ? 1 : -1;
        s.p = clamp(mid * 60, 0.35, 1);
      }
      prevMid = approach(prevMid, mid, 0.08, dt);
      for (const s of slashes) {
        if (s.age < 0) continue;
        s.age += dt;
        if (s.age > 0.3) s.age = -1;
      }

      if (!opts.reducedMotion && beat.downbeat && chaos > 0.45)
        strobe = 0.4 * opts.intensity;
      strobe = approach(strobe, 0, 0.05, dt);
    },

    draw(g, geom, pal, w) {
      const h = geom.h;
      const wdt = geom.w;
      // The stage floor: where the silhouette stands. Below the artwork when
      // there is artwork, so the band is not playing behind the album cover.
      const floor = geom.hole ? Math.min(h * 0.97, geom.cy + geom.hh + h * 0.1) : h * 0.86;
      g.globalCompositeOperation = "lighter";

      // The beams. Each is a cone from a point above the top edge down to the
      // floor, swinging; a trapezoid, which is all a spotlight ever is.
      for (const bm of beam) {
        const a = bm.lit;
        if (a < 0.02) continue;
        const originX = bm.x * wdt;
        const originY = -h * 0.06;
        const swing = Math.sin(bm.phase) * wdt * 0.28;
        const halfTop = wdt * 0.006;
        const halfBottom = wdt * (0.035 + a * 0.035);
        const landX = originX + swing;
        const gr = g.createLinearGradient(originX, originY, landX, floor);
        gr.addColorStop(0, hsl(pal.high, pal.sat * 0.5, 0.9, 0.1 * a * w.energy * preset.glow));
        gr.addColorStop(1, hsl(pal.mid, pal.sat * 0.7, 0.6, 0));
        g.fillStyle = gr;
        g.beginPath();
        g.moveTo(originX - halfTop, originY);
        g.lineTo(originX + halfTop, originY);
        g.lineTo(landX + halfBottom, floor);
        g.lineTo(landX - halfBottom, floor);
        g.closePath();
        g.fill();
        // The pool of light where it lands.
        const pg = g.createRadialGradient(landX, floor, 0, landX, floor, halfBottom * 2.2);
        pg.addColorStop(0, hsl(pal.high, pal.sat * 0.4, 0.86, 0.1 * a * w.energy * preset.glow));
        pg.addColorStop(1, hsl(pal.high, pal.sat * 0.4, 0.7, 0));
        g.fillStyle = pg;
        g.fillRect(landX - halfBottom * 2.2, floor - halfBottom * 2.2, halfBottom * 4.4, halfBottom * 4.4);
      }

      // The slashes: a cymbal or a snare, thrown across the stage.
      for (const s of slashes) {
        if (s.age < 0) continue;
        const t = s.age / 0.3;
        const alpha = (1 - t) * s.p * 0.45 * w.energy * preset.glow;
        if (alpha < 0.005) continue;
        g.strokeStyle = hsl(pal.high, 0.35, 0.92, alpha);
        g.lineWidth = Math.max(2, h * 0.007 * (1 - t) * 2);
        g.lineCap = "round";
        const x = s.x * wdt;
        const len = h * 0.42 * (0.6 + s.p);
        g.beginPath();
        g.moveTo(x - (len / 2) * s.dir, floor - len * 0.75);
        g.lineTo(x + (len / 2) * s.dir, floor - len * 0.1);
        g.stroke();
      }

      if (strobe > 0.004) {
        g.fillStyle = hsl(pal.high, 0.08, 0.95, strobe * 0.25 * w.energy);
        g.fillRect(0, 0, wdt, h);
      }

      // The wall, drawn LAST and OPAQUE: it is a silhouette, so it has to cut
      // the beams off rather than glow through them. This is the one place in
      // the whole set where something is drawn over the light instead of into
      // it, and it is what turns a light show into a stage.
      g.globalCompositeOperation = "source-over";
      g.beginPath();
      g.moveTo(0, h);
      for (let i = 0; i < WALL; i++) {
        const x = (i / (WALL - 1)) * wdt;
        // A band silhouette, not a dune: every other point is pulled down so
        // the outline has teeth at the resolution of the spectrum rather than
        // being smoothed into hills.
        const jag = i % 2 === 0 ? 1 : 0.55;
        g.lineTo(x, floor - wall[i] * (h - floor) * 1.7 * jag - h * 0.015);
      }
      g.lineTo(wdt, h);
      g.closePath();
      const wg = g.createLinearGradient(0, floor - h * 0.2, 0, h);
      wg.addColorStop(0, hsl(pal.low, pal.sat * 0.5, 0.1, 0.92 * w.fade));
      wg.addColorStop(1, hsl(pal.low, pal.sat * 0.4, 0.03, 0.98 * w.fade));
      g.fillStyle = wg;
      g.fill();
    },
  };
}
