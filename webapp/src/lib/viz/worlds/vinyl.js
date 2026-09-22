// HIP-HOP / RAP / TRAP / PHONK / REGGAETON / DANCEHALL — a record turning.
//
// These genres are built on a loop off a record, and the boom-bap is a pair of
// events, not one: the kick lands in the middle of the disc and the snare
// throws a line across it. So the motif is a turntable — concentric grooves
// turning at the tempo, a slab of bass along the bottom, and a slash on the
// backbeat. Drawn as a RING when there is artwork, so the cover becomes the
// label in the middle of the record.
//
// The skin decides what KIND of record it is: `arm` puts the tonearm across it
// (boom-bap and Motown are played off a deck; trap is not), `warp` gives the
// disc a bent, wandering wobble — which is the whole visual language of phonk
// and chopped-and-screwed — and `label` sets how much of the middle is taken by
// the label the grooves stop at.

import { approach, clamp, envelope, hsl, lerp, rng } from "../util.js";

const TAU = Math.PI * 2;
// How many snare slashes can be alive at once. Distinct from the skin's own
// `slash`, which is how BRIGHT each one is — one is a pool size and must stay a
// whole number, and letting a skin's 1.3 land in here indexed the pool at 0.3.
const SLASH_POOL = 4;

export function createVinylWorld(preset, opts, skin = {}) {
  const p = skin.p || {};
  const GROOVES = Math.max(5, Math.min(40, Math.round((8 + preset.layers * 4) * (p.grooves ?? 1))));
  const BASS = p.bass ?? 1;
  const SLASH = p.slash ?? 1;
  const ARM = clamp(p.arm ?? 0, 0, 1);
  const WARP = clamp(p.warp ?? 0, 0, 1.5);
  const LABEL = clamp(p.label ?? 1, 0.3, 2.2);
  const HATS = clamp(p.hats ?? 0, 0, 1.5);
  const SPEED = skin.speed ?? 1;
  const BARS = 14;
  const bar = new Float32Array(BARS);
  const slashes = [];
  for (let i = 0; i < SLASH_POOL; i++) slashes.push({ age: -1, a: 0, p: 0 });
  const rand = rng(7331);
  let slashNext = 0;
  let spin = 0;
  let boom = 0;
  let prevMid = 0;
  let warm = 0.6;
  let wobble = 0;
  let hats = 0;

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
      spin += ((dt * SPEED) / (barLen * 4)) * TAU;
      // A bent record does not turn true. Slower than the spin on purpose, so
      // it reads as the disc being warped rather than as the tempo drifting.
      if (WARP > 0.02) wobble += dt * 0.55;
      if (HATS > 0.02) {
        const e = frame.energy;
        const total = e.sub + e.bass + e.lowMid + e.mid + e.high + e.air + 1e-12;
        hats = envelope(hats, clamp(((e.high + e.air) / total) * 3.2, 0, 1), dt, 0.01, 0.1);
      }

      const mid = f.midFlux || 0;
      if (mid > prevMid * 2 && mid > 0.006) {
        const s = slashes[(slashNext = (slashNext + 1) % SLASH_POOL)];
        s.age = 0;
        s.a = rand() * TAU;
        s.p = clamp(mid * 60, 0.35, 1) * SLASH;
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
      const r0 = (geom.hole ? Math.min(geom.hw, geom.hh) * 0.9 : geom.rMin * 0.07) * LABEL;
      const outer = 0.86 + boom * 0.08;
      // The warp, sampled once per frame and applied to every groove: the whole
      // disc leans together, which is what a bent record does. Per groove it
      // would be a ripple, and a ripple is a different (and wrong) object.
      const warpA = WARP > 0.02 ? Math.sin(wobble) * WARP * 0.06 : 0;
      const warpB = WARP > 0.02 ? Math.cos(wobble * 0.73) * WARP * 0.045 : 0;

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
          const p = geom.place(a, rad * (1 + warpA * Math.sin(a + spin) + warpB * Math.cos(a * 2)), 0.35);
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

      // The hi-hats: a ring of short ticks outside the grooves, lit by the top
      // of the spectrum and turning with the record. Sixteen of them, on the
      // grid — the sound is a machine subdividing the bar, and scattering them
      // would say the opposite.
      if (HATS > 0.05 && hats > 0.03) {
        // Sixteen ticks on the grid, in the ring the disc does NOT occupy —
        // out to the frame's own edge, where nothing else in this world goes.
        // Drawn against the grooves rather than on them: the hats are the one
        // part of a trap beat that is not the loop.
        const n = 16;
        g.strokeStyle = hsl(pal.high, pal.sat * 0.5, 0.82, (0.03 + hats * 0.14) * HATS * w.energy * preset.glow);
        g.lineWidth = Math.max(1.2, geom.rMin * 0.006);
        g.lineCap = "butt";
        g.beginPath();
        for (let i = 0; i < n; i++) {
          const a = spin * 2 + (i / n) * TAU;
          // The offbeat ticks follow the top of the spectrum; the downbeats are
          // always there, so the ring reads as a grid being subdivided.
          const lit = i % 4 === 0 ? 1 : 0.35 + hats * 0.65;
          // In the GROOVES' own polar space (0.35), not the frame's: at full
          // anisotropy radial 0.9 is out at the frame's corners and the ticks
          // stopped being a ring around the record at all.
          // RADIAL, across the grooves rather than along them: sixteen spokes
          // over a set of concentric rings is unmistakably a second object,
          // and a tick lying on a groove is just a brighter groove. The
          // downbeats reach the rim and the offbeats are stubs, so the ring
          // reads as a bar being subdivided.
          const q0 = geom.place(a, 0.34, 0.35);
          const x0 = q0[0];
          const y0 = q0[1];
          const q1 = geom.place(a, 0.34 + (outer * 0.74 - 0.34) * lit * Math.min(1, HATS), 0.35);
          g.moveTo(x0, y0);
          g.lineTo(q1[0], q1[1]);
        }
        g.stroke();
      }

      // The tonearm: one straight line from outside the disc down onto the
      // grooves, tracking slowly inward. It is the single detail that makes the
      // picture read as a DECK rather than as a set of rings, and only the
      // genres that are actually cut and played off one ask for it.
      if (ARM > 0.05) {
        const track = 0.94 - 0.5 * (0.5 + 0.5 * Math.sin(spin * 0.12));
        const pivot = geom.place(-0.62, 1.22, 0.35);
        const px = pivot[0];
        const py = pivot[1];
        const head = geom.place(-0.62 + 0.5, track, 0.35);
        g.strokeStyle = hsl(pal.high, pal.sat * 0.35, 0.8, 0.16 * ARM * w.energy * preset.glow);
        g.lineWidth = Math.max(1.5, geom.rMin * 0.01);
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(head[0], head[1]);
        g.stroke();
        const hg = g.createRadialGradient(head[0], head[1], 0, head[0], head[1], geom.rMin * 0.06);
        hg.addColorStop(0, hsl(pal.high, pal.sat * 0.5, 0.85, 0.2 * ARM * w.energy));
        hg.addColorStop(1, hsl(pal.high, pal.sat * 0.5, 0.7, 0));
        g.fillStyle = hg;
        g.beginPath();
        g.arc(head[0], head[1], geom.rMin * 0.06, 0, TAU);
        g.fill();
      }

      // The bass, as a low slab of blocks along the bottom edge. Wide and flat,
      // because that is where the weight of this music sits.
      const bw = geom.w / BARS;
      for (let i = 0; i < BARS; i++) {
        const v = bar[i];
        if (v < 0.03) continue;
        const bh = geom.h * (0.03 + v * 0.14) * BASS;
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
