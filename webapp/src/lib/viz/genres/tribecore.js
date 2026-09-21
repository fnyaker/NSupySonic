// TRIBECORE — the drum circle, rolling.
//
// Tribe came out of the French and Italian teknival sound systems and the whole
// character of it is ROLLING rather than hammering: a bed of hand percussion
// running continuously under the kick, patterns that turn over every bar or
// two, and a groove that never stops to let anything land. Tribecore is that
// crossed with frenchcore, so the kick is distorted and the tempo is high —
// but the identity is still the roll.
//
// Which is why this is a RING OF MEMBRANES and not a set of events. Twelve
// skins around the frame, each one struck on its own subdivision, and the whole
// ring turning at one revolution per two bars. Nothing here flashes the whole
// picture, because nothing in tribe stops the picture: what you see is which
// part of the circle is being played right now, travelling round it.
//
// The kick is the one thing allowed to interrupt, and it does it by pushing the
// ring OUT rather than by lighting it up — the circle breathes on the four.
//
// Every rate is per bar or per beat, so the roll is the track's roll. At 180
// the ring turns in 2.7 seconds and at 210 in 2.3, and neither number appears.

import { clamp, hsl, lerp } from "../util.js";
import { tracePolar } from "./kit.js";

export const meta = { label: "Tribecore", trail: 0.3 };

const TAU = Math.PI * 2;

export function create(preset, opts) {
  // Twelve is three groups of four: the ring reads as a bar of triplets over a
  // bar of four, which is the polyrhythm the genre is built on.
  const N = 12;
  const skin = new Float32Array(N); // how lit each membrane is
  const strike = new Float32Array(N); // its own decay rate, so they differ
  for (let i = 0; i < N; i++) strike[i] = 0.5 + ((i * 7) % 5) / 5;
  let breathe = 0;
  let lastStep = -1;
  let roll = 0;

  return {
    update(frame, dt, geom, m) {
      // The playing head walks the ring once per two bars. Derived, not timed:
      // it is a position in the bar, so it cannot drift from the music.
      const pos = (m.barPhase * 0.5 + (m.phrasePhase * 2) % 0.5) % 1;
      roll = pos;
      const step = Math.floor(pos * N) % N;
      if (step !== lastStep) {
        lastStep = step;
        // The onset decides how hard this membrane was hit, so a busy bar of
        // percussion lights the whole ring and a sparse one barely marks it.
        skin[step] = clamp(0.35 + m.onset * 0.8 + m.drive * 0.4, 0, 1.4);
        // The offbeat members get a softer ghost note — that is what makes a
        // roll sound continuous rather than like twelve separate hits.
        skin[(step + 6) % N] = Math.max(skin[(step + 6) % N], 0.18 + m.drive * 0.2);
      }
      for (let i = 0; i < N; i++) {
        // Decays measured in beats, each membrane slightly different so the
        // ring never settles into one uniform brightness.
        skin[i] = m.ease(skin[i], 0, 0.5 * strike[i], dt);
      }
      // The four-on-the-floor, pushing the whole ring outward.
      if (m.hit || (m.onBeat && m.kick > 0.25)) breathe = 0.12 + m.kick * 0.2 * m.punch;
      breathe = m.ease(breathe, 0, 0.45, dt);
    },

    draw(g, geom, pal, w, m) {
      g.globalCompositeOperation = "lighter";
      // One turn per two bars at rest, faster as the track pushes. An earlier
      // version reversed the direction every phrase to keep a long track from
      // reading as one endless spin — which looked fine and was wrong: a ring
      // that reverses moves LESS the harder the track drives, and the tempo
      // test caught it scoring 0.27 where it should have scored 2. The roll in
      // this music never turns round; it gets more insistent.
      const spin = m.sweep(0.5 + m.drive * 0.45);
      const rad = 0.46 + breathe + m.weight * 0.12;
      const span = TAU / N;

      for (let i = 0; i < N; i++) {
        const lit = skin[i];
        const a0 = spin + (i / N) * TAU;
        // A membrane is an ARC SEGMENT of the ring, not a dot: a drum head is
        // a surface, and a ring of dots would read as beads (which is what the
        // latin world does, and it must not look like that one).
        const thickness = geom.rMin * (0.05 + lit * 0.1) * (0.7 + m.drive * 0.6);
        const alpha = (0.035 + lit * 0.4) * w.energy * preset.glow;
        if (alpha < 0.005) continue;
        const hue = pal.low + (pal.high - pal.low) * (i / N) + lit * 20;
        g.strokeStyle = hsl(hue, pal.sat, lerp(0.5, 0.82, clamp(lit, 0, 1)), alpha);
        g.lineWidth = Math.max(2, thickness);
        g.lineCap = "butt";
        tracePolar(g, geom, 10, (t) => [a0 + t * span * 0.86, rad + lit * 0.04], 0.5);
        g.stroke();

        // The strike: a short radial spur outward from a membrane that has just
        // been hit. It is what gives the roll a direction round the circle.
        if (lit > 0.45) {
          const mid = a0 + span * 0.43;
          const p0 = geom.place(mid, rad + 0.06, 0.5);
          const x0 = p0[0];
          const y0 = p0[1];
          const p1 = geom.place(mid, rad + 0.06 + (lit - 0.4) * 0.5, 0.5);
          g.strokeStyle = hsl(hue + 18, pal.sat, 0.88, alpha * 0.8);
          g.lineWidth = Math.max(1.5, geom.rMin * 0.008);
          g.lineCap = "round";
          g.beginPath();
          g.moveTo(x0, y0);
          g.lineTo(p1[0], p1[1]);
          g.stroke();
        }
      }

      // The middle: the sound system's own weight, pumping on the kick. It is a
      // body the ring turns around rather than a light — tribe is played around
      // a rig in a field, and the rig does not blink.
      const r0 = geom.hole ? Math.min(geom.hw, geom.hh) * 0.86 : 0;
      const cr = r0 + geom.rMin * (0.2 + breathe * 1.4 + m.weight * 0.16);
      const cg = g.createRadialGradient(geom.cx, geom.cy, r0, geom.cx, geom.cy, Math.max(r0 + 1, cr));
      cg.addColorStop(0, hsl(pal.low + 10, pal.sat, 0.6, (0.06 + breathe * 1.6) * w.energy * preset.glow));
      cg.addColorStop(1, hsl(pal.low, pal.sat, 0.45, 0));
      g.fillStyle = cg;
      g.fillRect(0, 0, geom.w, geom.h);

      // The playing head, as a faint sweep behind the ring: where the roll is
      // now. Wide and dim on purpose — it is the groove, not an event.
      const headA = spin + roll * TAU;
      // Read out before reusing: `place` hands back one shared array.
      const hp = geom.place(headA, rad, 0.5);
      const hx = hp[0];
      const hy = hp[1];
      const hg = g.createRadialGradient(hx, hy, 0, hx, hy, geom.rMin * 0.5);
      hg.addColorStop(0, hsl(pal.mid, pal.sat, 0.7, 0.07 * w.energy * preset.glow));
      hg.addColorStop(1, hsl(pal.mid, pal.sat, 0.5, 0));
      g.fillStyle = hg;
      g.fillRect(0, 0, geom.w, geom.h);
      g.globalCompositeOperation = "source-over";
      void opts;
    },
  };
}
