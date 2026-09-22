// LATIN / AFRO / CARIBBEAN — salsa, cumbia, samba, afrobeats, amapiano, reggae,
// reggaeton, dancehall, ska.
//
// What these share is POLYRHYTHM: two or three patterns of different lengths
// running at once, and the pleasure is in where they line up. So the world is a
// set of concentric rings, each with a different number of beads, each turning
// at its own rate — the beads light as their position passes the top, and every
// few bars they all meet. Warm, round, danceable, and structurally unlike
// anything else in the set.
//
// skin.p — rings (how many patterns), dots (how many beads on each),
//          sway (how much the whole thing leans with the groove),
//          bar  (beads drawn as arc segments — a clave block — not as dots),
//          meet (light the spokes when the patterns line up),
//          skip (how many beads the rings step per beat: 1 walks, 2 skips)
//
// `meet` is the one that separates the rosters. A polyrhythm's whole pleasure
// is the moment the patterns coincide, and the genres built around that moment
// (samba, afrobeat, salsa) get it drawn; the ones that simply sit in a groove
// (kizomba, reggae) do not, and stay level all the way through.

import { approach, clamp, envelope, hsl, lerp } from "../util.js";

const TAU = Math.PI * 2;
// Ring lengths that do NOT divide each other: the point of a polyrhythm is that
// the patterns drift apart and re-meet, which equal lengths never do.
const LENGTHS = [4, 3, 6, 8, 5];

export function createCarnivalWorld(preset, opts, skin = {}) {
  const p = skin.p || {};
  const RINGS = Math.max(2, Math.min(5, Math.round((preset.layers - 1) * (p.rings ?? 1))));
  const BAR = clamp(p.bar ?? 0, 0, 1);
  const MEET = clamp(p.meet ?? 0, 0, 1.5);
  const SKIP = Math.max(1, Math.round(p.skip ?? 1));
  const ring = [];
  for (let i = 0; i < RINGS; i++) {
    const n = Math.max(3, Math.round(LENGTHS[i % LENGTHS.length] * (p.dots ?? 1)));
    ring.push({ n, pos: 0, lit: new Float32Array(n), dir: i % 2 === 0 ? 1 : -1 });
  }
  let sway = 0;
  let kick = 0;
  let level = 0;
  let beatIndex = -1;
  let meet = 0;

  return {
    update(frame, dt) {
      const f = frame.features;
      const beat = frame.beat;
      kick = envelope(kick, clamp((f.kick || 0) * 1.15, 0, 1), dt, 0.008, 0.2);
      level = approach(level, f.level || 0, 0.25, dt);
      // The sway is a bar-long lean, not a per-beat pulse — this music moves
      // hips, not heads.
      const barLen = beat.locked ? beat.period * beat.beatsPerBar : 2.2;
      sway += (dt / barLen) * TAU * 0.5;

      // Each ring steps ONE bead per beat, but they have different lengths, so
      // they go in and out of phase exactly as the drums do.
      if (beat.beat && beat.beatIndex !== beatIndex) {
        beatIndex = beat.beatIndex;
        for (const r of ring) {
          r.pos = (r.pos + SKIP) % r.n;
          r.lit[r.pos] = 1;
        }
        // Every pattern back on its first bead at once: the bar they have all
        // been walking toward. Worth drawing, because it is the thing the
        // music is built to arrive at.
        if (MEET > 0.05 && ring.every((r) => r.pos === 0)) meet = MEET;
      }
      meet = approach(meet, 0, 0.5, dt);
      for (const r of ring)
        for (let i = 0; i < r.n; i++) r.lit[i] = approach(r.lit[i], 0, 0.45, dt);
    },

    draw(g, geom, pal, w) {
      g.globalCompositeOperation = "lighter";
      const lean = Math.sin(sway) * (p.sway ?? 1) * 0.1;
      const tilt = Math.cos(sway * 0.5) * (p.sway ?? 1) * 0.06;

      for (let k = 0; k < RINGS; k++) {
        const r = ring[k];
        const t = (k + 1) / (RINGS + 1);
        const rad = 0.22 + t * 0.72;
        const hue = pal.low + (pal.high - pal.low) * t;
        // The ring itself: a faint circle the beads sit on, so the pattern has
        // a track to run around.
        g.strokeStyle = hsl(hue, pal.sat * 0.7, 0.6, 0.05 * w.energy);
        g.lineWidth = Math.max(1, geom.rMin * 0.0035);
        g.beginPath();
        for (let i = 0; i <= 40; i++) {
          const a = (i / 40) * TAU + lean * r.dir;
          const q = geom.place(a, rad + tilt * Math.sin(a), 0.4);
          i === 0 ? g.moveTo(q[0], q[1]) : g.lineTo(q[0], q[1]);
        }
        g.stroke();

        for (let i = 0; i < r.n; i++) {
          const a = (i / r.n) * TAU - Math.PI / 2 + lean * r.dir;
          const q = geom.place(a, rad + tilt * Math.sin(a), 0.4);
          const lit = r.lit[i];
          const size = geom.rMin * (0.012 + lit * 0.045) * (0.7 + level * 0.6);
          const alpha = (0.06 + lit * 0.5) * w.energy * preset.glow;
          if (alpha < 0.004) continue;
          if (BAR > 0.05) {
            // A block ON the ring rather than a bead beside it: the pattern
            // reads as notated — which is how clave-driven music is heard.
            const half = (TAU / r.n) * lerp(0.12, 0.34, BAR);
            // A block covers several times what the dot's bright core did, so
            // the alpha comes down with the area or the ring turns into a solid
            // white band. And the area is per RING: a ring carrying fourteen
            // beads is nearly covered by them, one carrying three is not, so
            // the correction is the bead count rather than a flat number —
            // salsa (the densest roster on this world) clipped five per cent of
            // the frame, reggae (the sparsest) was merely dim.
            const cover = clamp(7 / r.n, 0.4, 1);
            g.strokeStyle = hsl(hue + lit * 24, pal.sat, 0.68, alpha * 0.38 * cover);
            g.lineWidth = Math.max(2, size * lerp(1.2, 2.2, BAR));
            g.lineCap = "butt";
            g.beginPath();
            for (let m = 0; m <= 6; m++) {
              const aa = a - half + (m / 6) * half * 2;
              const qq = geom.place(aa, rad + tilt * Math.sin(aa), 0.4);
              m === 0 ? g.moveTo(qq[0], qq[1]) : g.lineTo(qq[0], qq[1]);
            }
            g.stroke();
            continue;
          }
          const gr = g.createRadialGradient(q[0], q[1], 0, q[0], q[1], Math.max(1, size * 2.6));
          gr.addColorStop(0, hsl(hue + lit * 24, pal.sat, 0.75, alpha));
          gr.addColorStop(1, hsl(hue, pal.sat, 0.55, 0));
          g.fillStyle = gr;
          g.beginPath();
          g.arc(q[0], q[1], size * 2.6, 0, TAU);
          g.fill();
        }
      }

      // The meeting: spokes out through every ring at once, from the middle to
      // the edge of the frame. It happens a few times a minute and it is the
      // only moment this world raises its voice.
      if (meet > 0.02) {
        // Twelve full-radius strokes over a picture that is already the
        // brightest thing this world draws: at the alpha an event normally
        // gets, salsa clipped five per cent of the frame. It is a flash, not a
        // layer — a third of that reads the same and costs nothing.
        g.strokeStyle = hsl(pal.high, pal.sat * 0.8, 0.78, Math.min(0.2, meet * 0.15) * w.energy * preset.glow);
        g.lineWidth = Math.max(1.2, geom.rMin * 0.0035);
        g.beginPath();
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * TAU - Math.PI / 2;
          const q0 = geom.place(a, 0.18, 0.4);
          const x0 = q0[0];
          const y0 = q0[1];
          const q1 = geom.place(a, 1, 0.4);
          g.moveTo(x0, y0);
          g.lineTo(q1[0], q1[1]);
        }
        g.stroke();
      }

      // The middle: a warm body that the rings turn around, pumping on the
      // kick. Around artwork it becomes a halo, as everywhere else.
      const r0 = geom.hole ? Math.min(geom.hw, geom.hh) * 0.85 : 0;
      const cr = r0 + geom.rMin * (0.16 + kick * 0.24 + level * 0.1);
      const cg = g.createRadialGradient(geom.cx, geom.cy, r0, geom.cx, geom.cy, Math.max(r0 + 1, cr));
      cg.addColorStop(0, hsl(pal.mid + 10, pal.sat, 0.68, (0.1 + kick * 0.3) * w.energy * preset.glow));
      cg.addColorStop(1, hsl(pal.low, pal.sat, 0.55, 0));
      g.fillStyle = cg;
      g.fillRect(0, 0, geom.w, geom.h);
      g.globalCompositeOperation = "source-over";
    },
  };
}
