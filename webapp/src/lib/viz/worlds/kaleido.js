// PSYTRANCE — a kaleidoscope.
//
// Psytrance is relentless, symmetrical and hypnotic, and the visual that has
// always belonged to it is the mandala: a handful of sectors mirrored around
// the middle, turning against each other, morphing with the sound. Nothing else
// in the set is symmetrical, so it is unmistakable at a glance.
//
// `mirror` 0 drops the reflected half, lags each sector behind the last AND
// lets the arms climb outward as they lag, so the figure is a PINWHEEL rather
// than a kaleidoscope — a serpentine line unwinding, which is what goa is made
// of. Dropping the reflection alone only halved the strokes and left them at
// the same radii: rotationally symmetric, so a viewer could not tell and nor
// could a test. A spiral has to travel to read as one. `aniso` is how much of the frame's shape
// the mandala takes: nearly none keeps it a true circle (arabic, psych rock),
// more lets it spread across a beamer (hitech). `web` joins the sectors with
// chords, which is forest and dark psy's tangle and nothing else's.
//
// The mirroring is done in COORDINATES, not with a canvas transform: one
// element is drawn at K rotations and at each of their reflections, which is a
// few more strokes rather than a save/restore per sector and keeps every point
// inside the frame's own polar mapping (so the mandala fills a wide screen
// instead of being inscribed in a circle in the middle of it).

import { approach, clamp, envelope, hsl, lerp } from "../util.js";

const TAU = Math.PI * 2;
const PETALS = 9; // elements inside one sector

export function createKaleidoWorld(preset, opts, skin = {}) {
  const p = skin.p || {};
  const SECTORS = p.sectors ?? 1;
  const PETAL_K = p.petals ?? 1;
  const BEADS = p.beads ?? 1;
  const TWIST = p.twist ?? 1;
  const MIRROR = (p.mirror ?? 1) > 0.5;
  const ANISO = clamp(p.aniso ?? 0.3, 0, 1);
  const WEB = clamp(p.web ?? 0, 0, 1);
  const SPEED = skin.speed ?? 1;
  const band = new Float32Array(PETALS);
  let spin = 0;
  let counter = 0; // the inner ring turns the other way
  let kick = 0;
  let density = 0.8;
  let chaos = 0.3;

  return {
    update(frame, dt) {
      const f = frame.features;
      const beat = frame.beat;
      const look = frame.style?.look;
      density = approach(density, look ? look.density : 0.8, 1.2, dt);
      chaos = approach(chaos, look ? look.chaos : 0.3, 1.2, dt);
      kick = envelope(kick, clamp((f.kick || 0) * 1.15, 0, 1), dt, 0.006, 0.14);

      const b = frame.bands;
      const per = b.length / PETALS;
      for (let i = 0; i < PETALS; i++) {
        let m = 0;
        const a = Math.floor(i * per);
        const e = Math.floor((i + 1) * per);
        for (let j = a; j < e && j < b.length; j++) if (b[j] > m) m = b[j];
        band[i] = envelope(band[i], m, dt, 0.03, 0.22);
      }
      // Both rotations are locked to the bar, so the pattern lands on the music
      // instead of drifting across it.
      const barLen = beat.locked ? beat.period * beat.beatsPerBar : 2.4;
      spin += ((dt * SPEED) / (barLen * 4)) * TAU;
      counter -= ((dt * SPEED * TWIST) / (barLen * 2.6)) * TAU;
    },

    draw(g, geom, pal, w) {
      g.globalCompositeOperation = "lighter";
      // More sectors when the genre is dense; always even, so every element has
      // a true mirror.
      const K = 2 * Math.max(2, Math.round(lerp(3, 6, density) * SECTORS));
      const step = TAU / K;
      const lw = Math.max(1.2, geom.rMin * 0.008);

      const shown = Math.max(3, Math.min(PETALS, Math.round(PETALS * PETAL_K)));
      for (let p = 0; p < shown; p++) {
        const v = band[p];
        if (v < 0.03) continue;
        const t = (p + 0.5) / shown;
        // Where this element sits inside its sector, and how far out. The
        // wobble is what makes the mandala breathe rather than spin rigidly.
        const local = step * (0.18 + 0.64 * t) + Math.sin(spin * 2 + p) * step * 0.08 * chaos;
        const rad = 0.06 + t * 0.86 + v * 0.14 + kick * 0.06;
        const hue = pal.low + (pal.high - pal.low) * t;
        const alpha = (0.04 + v * 0.16) * w.energy * preset.glow;
        g.strokeStyle = hsl(hue, pal.sat, 0.68, alpha);
        g.lineWidth = lw * (0.6 + v * 2);
        g.lineCap = "round";
        const phase = p % 2 === 0 ? spin : counter;

        for (let k = 0; k < K; k++) {
          // Without a mirror the sectors are free to lag, and a lag of a third
          // of a sector per step is what turns a star into a vortex.
          const lag = MIRROR ? 0 : k / K;
          const base = phase + k * step + lag * step * (0.7 + t * 0.9);
          // The element and its reflection inside the sector: that pair is what
          // a kaleidoscope is.
          for (const sign of MIRROR ? [1, -1] : [1]) {
            const a0 = base + sign * local;
            const a1 = base + sign * (local + step * 0.3);
            // Nearly circular (see geometry.place): a mandala that takes the
            // frame's shape stops being a mandala and becomes a patterned
            // border, which is what it was doing.
            // The arm climbs as it lags: sector by sector it reaches further
            // out, which is the difference between a star and a spiral.
            const rr = rad * (1 + lag * 0.5);
            const q0 = geom.place(a0, rr, ANISO);
            const x0 = q0[0];
            const y0 = q0[1];
            const q1 = geom.place(a1, rr * (0.82 + v * 0.2), ANISO);
            g.beginPath();
            g.moveTo(x0, y0);
            g.lineTo(q1[0], q1[1]);
            g.stroke();
            // A bead at the outer end: the pattern needs points as well as
            // lines or it reads as a wire diagram.
            if (v * BEADS > 0.5) {
              g.fillStyle = hsl(hue + 20, pal.sat, 0.8, alpha * 1.1);
              g.beginPath();
              g.arc(x0, y0, lw * (0.9 + v * 2.2), 0, TAU);
              g.fill();
            }
          }
        }
      }

      // The web: a chord from each sector to the one two along, at the radius
      // the pattern currently reaches. It turns the mandala into a tangle,
      // which is the whole look of forest and dark psy and would be wrong
      // anywhere else on this world.
      if (WEB > 0.05) {
        const rad = 0.5 + kick * 0.2;
        g.strokeStyle = hsl(pal.mid, pal.sat * 0.8, 0.6, 0.05 * WEB * w.energy * preset.glow);
        g.lineWidth = lw * 0.8;
        g.beginPath();
        for (let k = 0; k < K; k++) {
          const q0 = geom.place(spin + k * step, rad, ANISO);
          const x0 = q0[0];
          const y0 = q0[1];
          const q1 = geom.place(spin + (k + 2) * step, rad, ANISO);
          g.moveTo(x0, y0);
          g.lineTo(q1[0], q1[1]);
        }
        g.stroke();
      }

      // The eye of the mandala, pumping on the kick.
      const r0 = geom.hole ? Math.min(geom.hw, geom.hh) * 0.85 : 0;
      const cr = r0 + geom.rMin * (0.1 + kick * 0.22);
      const cg = g.createRadialGradient(geom.cx, geom.cy, r0, geom.cx, geom.cy, Math.max(r0 + 1, cr));
      cg.addColorStop(0, hsl(pal.high, pal.sat, 0.82, (0.05 + kick * 0.18) * w.energy * preset.glow));
      cg.addColorStop(1, hsl(pal.mid, pal.sat, 0.6, 0));
      g.fillStyle = cg;
      g.fillRect(0, 0, geom.w, geom.h);
      g.globalCompositeOperation = "source-over";
    },
  };
}
