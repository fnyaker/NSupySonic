// HIP-HOP / RAP / TRAP / PHONK / REGGAETON / DANCEHALL — a record turning.
//
// These genres are built on a loop off a record, and the boom-bap is a pair of
// events, not one: the kick lands in the middle of the disc and the snare
// throws a line across it. So the motif is a turntable — concentric grooves
// turning at the tempo, a slab of bass along the bottom, and a slash on the
// backbeat. Drawn as a RING when there is artwork, so the cover becomes the
// label in the middle of the record.

import { approach, clamp, envelope, hsl, lerp, rng } from "../util.js";

const TAU = Math.PI * 2;
const SLASH = 4;

export function createVinylWorld(preset, opts) {
  const GROOVES = Math.max(9, Math.min(26, 8 + preset.layers * 4));
  const BARS = 14;
  const bar = new Float32Array(BARS);
  const slashes = [];
  for (let i = 0; i < SLASH; i++) slashes.push({ age: -1, a: 0, p: 0 });
  const rand = rng(7331);
  let slashNext = 0;
  let spin = 0;
  let boom = 0;
  let prevMid = 0;
  let warm = 0.6;

  return {
    update(frame, dt) {
      const f = frame.features;
      const beat = frame.beat;
      const look = frame.style?.look;
      warm = approach(warm, look ? look.warm : 0.6, 1.2, dt);
      boom = envelope(boom, clamp((f.kick || 0) * 1.2, 0, 1), dt, 0.006, 0.2);

      // One turn every four bars. A record at 33rpm is two seconds a turn and
      // would be a blur; what matters is that it turns WITH the loop.
      const barLen = beat.locked ? beat.period * beat.beatsPerBar : 2.4;
      spin += (dt / (barLen * 4)) * TAU;

      const mid = f.midFlux || 0;
      if (mid > prevMid * 2 && mid > 0.006) {
        const s = slashes[(slashNext = (slashNext + 1) % SLASH)];
        s.age = 0;
        s.a = rand() * TAU;
        s.p = clamp(mid * 60, 0.35, 1);
      }
      prevMid = approach(prevMid, mid, 0.08, dt);
      for (const s of slashes) {
        if (s.age < 0) continue;
        s.age += dt;
        if (s.age > 0.34) s.age = -1;
      }

      const b = frame.bands;
      const per = (b.length * 0.45) / BARS; // the bottom half: this is bass music
      for (let i = 0; i < BARS; i++) {
        let m = 0;
        const a = Math.floor(i * per);
        const e = Math.floor((i + 1) * per);
        for (let j = a; j < e && j < b.length; j++) if (b[j] > m) m = b[j];
        bar[i] = envelope(bar[i], m, dt, 0.02, 0.22);
      }
    },

    draw(g, geom, pal, w) {
      g.globalCompositeOperation = "lighter";
      const r0 = geom.hole ? Math.min(geom.hw, geom.hh) * 0.9 : geom.rMin * 0.07;
      const outer = 0.86 + boom * 0.08;

      // The grooves. Each is a ring at its own radius with a gap in it, and the
      // gaps line up into the spiral that says "record" rather than "target".
      for (let i = 0; i < GROOVES; i++) {
        const t = (i + 1) / GROOVES;
        const rad = t * outer;
        const gapAt = spin + t * 2.6;
        const alpha = (0.05 + (1 - t) * 0.1 + boom * 0.12 * t) * w.energy * preset.glow;
        if (alpha < 0.004) continue;
        g.strokeStyle = hsl(pal.low + (pal.high - pal.low) * t * 0.5, pal.sat * 0.7, 0.6, alpha);
        g.lineWidth = Math.max(1, geom.rMin * 0.006 * (0.5 + boom));
        g.beginPath();
        const steps = 30;
        let started = false;
        for (let k = 0; k <= steps; k++) {
          const a = (k / steps) * TAU;
          // The gap: a sixteenth of the turn, moving outward ring by ring.
          if (Math.abs(((a - gapAt) % TAU + TAU + Math.PI) % TAU - Math.PI) < 0.19) {
            started = false;
            continue;
          }
          const p = geom.place(a, rad, 0.35);
          if (!started) {
            g.moveTo(p[0], p[1]);
            started = true;
          } else g.lineTo(p[0], p[1]);
        }
        g.stroke();
      }

      // The boom: the middle of the record pushing out.
      if (boom > 0.02) {
        const cr = r0 + geom.rMin * (0.18 + boom * 0.45);
        const cg = g.createRadialGradient(geom.cx, geom.cy, r0, geom.cx, geom.cy, cr);
        cg.addColorStop(0, hsl(pal.low + 8, pal.sat, 0.68, boom * 0.4 * w.energy * preset.glow));
        cg.addColorStop(1, hsl(pal.low, pal.sat, 0.5, 0));
        g.fillStyle = cg;
        g.fillRect(0, 0, geom.w, geom.h);
      }

      // The snare, thrown across the disc.
      for (const s of slashes) {
        if (s.age < 0) continue;
        const t = s.age / 0.34;
        const alpha = (1 - t) * s.p * 0.4 * w.energy * preset.glow;
        if (alpha < 0.005) continue;
        const a = s.a + spin;
        const p0 = geom.place(a, 0.15 + t * 0.2, 0.35);
        const x0 = p0[0];
        const y0 = p0[1];
        const p1 = geom.place(a, 0.95 + t * 0.3, 0.35);
        g.strokeStyle = hsl(pal.high, lerp(0.25, 0.6, warm), 0.88, alpha);
        g.lineWidth = Math.max(2, geom.rMin * 0.014 * (1 - t * 0.5));
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(p1[0], p1[1]);
        g.stroke();
      }

      // The bass, as a low slab of blocks along the bottom edge. Wide and flat,
      // because that is where the weight of this music sits.
      const bw = geom.w / BARS;
      for (let i = 0; i < BARS; i++) {
        const v = bar[i];
        if (v < 0.03) continue;
        const bh = geom.h * (0.03 + v * 0.14);
        g.fillStyle = hsl(
          pal.low + (pal.mid - pal.low) * (i / (BARS - 1)),
          pal.sat,
          0.55,
          (0.03 + v * 0.08) * w.energy * preset.glow
        );
        g.fillRect(i * bw + bw * 0.12, geom.h - bh, bw * 0.76, bh);
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}
