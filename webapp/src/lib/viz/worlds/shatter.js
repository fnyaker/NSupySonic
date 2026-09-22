// HARDCORE / FRENCHCORE / UPTEMPO / SPEEDCORE / KRACH / TRIBECORE — the frame
// breaks.
//
// The motif is a disc of radiating SHARDS that fills the picture. Every kick
// throws them outward, rotates the whole disc by one notch, and re-randomises
// the cracks between them; they ease back in before the next one. At 200 BPM
// that is a hit every three tenths of a second, so the scene is never still and
// never smooth — which is the entire point of the genre.
//
// The subgenres separate inside it on `look`: `chaos` widens the cracks and
// pushes the per-shard jitter (speedcore and krach come apart, hardcore does
// not), `punch` sets how far a kick throws them, and `motion` sets how fast the
// disc turns between hits.
//
// And on the skin's own SHAPE switches, which is what tells two genres apart
// when `look` cannot: `even` makes every shard the same length (gabber is seven
// clean slabs, speedcore is twenty splinters of every size), `edge` notches the
// outer rim so a piece ends in a splinter rather than a straight cut, `drift`
// turns the whole disc continuously instead of only snapping on the kick
// (tribe and raggatek roll, hardcore hammers), and `flash` decides whether the
// downbeat strobe is white (gabber) or the track's own colour (frenchcore).

import { approach, clamp, envelope, hsl, lerp, rng } from "../util.js";

const TAU = Math.PI * 2;

export function createShatterWorld(preset, opts, skin = {}) {
  const p = skin.p || {};
  // Gabber is seven big slabs and a strobe; speedcore is twenty splinters.
  const N = Math.max(5, Math.min(28, Math.round((8 + preset.layers * 2) * (p.shards ?? 1))));
  const JAG = p.jag ?? 1;
  const SPIN = p.spin ?? 1;
  const STROBE = p.strobe ?? 1;
  const CORE = p.core ?? 1;
  const EVEN = clamp(p.even ?? 0, 0, 1);
  const EDGE = clamp(p.edge ?? 0, 0, 1);
  const DRIFT = p.drift ?? 0;
  const FLASH = clamp(p.flash ?? 1, 0, 1);
  const SPEED = skin.speed ?? 1;
  const rand = rng(1337);
  // Per shard: its resting angle, its current outward throw, and the jitter it
  // was given by the last hit.
  const shard = [];
  for (let i = 0; i < N; i++)
    // `len` is how far this shard reaches at REST. Uniform lengths made a tidy
    // sunburst — a shape, not a break — and the whole subject here is that the
    // picture is in pieces whether or not a kick has just landed.
    shard.push({
      a: (i / N) * TAU,
      throw: 0,
      jitter: 0,
      // Where it starts as well as where it ends, and a permanent angular
      // offset of its own. Shards that all begin at the middle and span the
      // same angle draw a rising-sun flag; what makes a picture read as BROKEN
      // is that no two pieces line up.
      inner: lerp(0.04 + rand() * 0.3, 0.1, EVEN),
      len: lerp(0.5 + rand() * 0.55, 0.82, EVEN),
      skew: (rand() - 0.5) * 0.5 * (1 - EVEN),
      // Where the outer rim breaks, when the skin asks for a splintered one.
      // Fixed per shard: a rim re-randomised every frame is noise, not a break.
      notch: [rand(), rand(), rand()],
      seed: rand(),
    });
  let rot = 0;
  let rotTarget = 0;
  let punch = 0;
  let strobe = 0;
  let chaos = 0.4;
  let motion = 0.9;
  let hardness = 0.8;
  let lastHit = -1;
  let clock = 0;

  return {
    update(frame, dt) {
      clock += dt;
      const f = frame.features;
      const beat = frame.beat;
      const look = frame.style?.look;
      chaos = approach(chaos, look ? look.chaos : 0.5, 1.2, dt);
      motion = approach(motion, look ? look.motion : 0.9, 1.2, dt);
      hardness = approach(hardness, look ? look.punch : 0.9, 1.2, dt);

      const det = f.kick || 0;
      const hit =
        (frame.style?.kick?.hit || (beat.beat && beat.locked) || det > 0.55) &&
        clock - lastHit > 0.09;
      if (hit) {
        lastHit = clock;
        // One notch of rotation per hit, alternating direction on the downbeat
        // so a bar reads as a bar rather than as a continuous spin.
        rotTarget += (TAU / N) * (beat.downbeat ? -1 : 1) * lerp(0.4, 1.6, motion) * SPIN;
        const force = lerp(0.18, 0.55, hardness) * (0.6 + det * 0.6);
        for (const s of shard) {
          s.throw = force * (0.7 + rand() * 0.6);
          s.jitter = (rand() - 0.5) * chaos * 0.5;
        }
        if (!opts.reducedMotion && beat.downbeat) strobe = 0.5 * opts.intensity * STROBE;
      }
      punch = envelope(punch, clamp(det * 1.2, 0, 1), dt, 0.005, 0.12);
      strobe = approach(strobe, 0, 0.06, dt);
      // A continuous roll under the notched rotation. The genres that dance
      // rather than hammer (tribe, raggatek, hardtek) read as turning; the ones
      // that hammer only ever move when something hits.
      if (DRIFT) {
        const roll = DRIFT * dt * lerp(0.1, 0.5, motion) * SPEED;
        rot += roll;
        rotTarget += roll;
      }
      rot = approach(rot, rotTarget, 0.055 / Math.max(0.2, SPEED), dt);
      for (const s of shard) {
        s.throw = approach(s.throw, 0, 0.16, dt);
        s.jitter = approach(s.jitter, 0, 0.22, dt);
      }
    },

    draw(g, geom, pal, w) {
      g.globalCompositeOperation = "lighter";
      const tint = frameTint(pal);
      // The crack between two shards: a hair at rest, a real gap when the genre
      // is chaotic. It is what stops the disc reading as one solid wheel.
      const gap = lerp(0.1, 0.42, chaos) * JAG * (TAU / N) * 0.5;

      for (let i = 0; i < N; i++) {
        const s = shard[i];
        const span = TAU / N;
        const a0 = rot + s.a + gap + s.jitter + s.skew * span * 0.5;
        const a1 = rot + s.a + span - gap + s.jitter + s.skew * span * 0.5;
        // Thrown outward on the hit: the inner edge leaves the middle and the
        // outer edge runs off the frame, so the picture opens up on every kick.
        const r0 = s.inner + s.throw * 1.1;
        const r1 = s.inner + s.len + s.throw * 0.9 + punch * 0.25;
        const a = (0.13 + s.throw * 0.8 + punch * 0.3) * w.energy * preset.glow * 0.62;
        if (a < 0.005) continue;
        const hue = pal.low + tint + (s.seed - 0.5) * 54;
        const p0 = geom.place(a0, r0);
        const x0 = p0[0];
        const y0 = p0[1];
        const p1 = geom.place(a0, r1);
        const x1 = p1[0];
        const y1 = p1[1];
        const p3 = geom.place(a1, r0);
        const gr = g.createLinearGradient(x0, y0, x1, y1);
        gr.addColorStop(0, hsl(hue, pal.sat, 0.68, a));
        gr.addColorStop(1, hsl(hue + 18, pal.sat, 0.5, 0));
        g.fillStyle = gr;
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        // The outer rim. Flat is a cut piece; stepped is a broken one, and the
        // steps are the shard's own fixed notches so the break stays put.
        if (EDGE > 0.02) {
          for (let k = 0; k < 3; k++) {
            const t = (k + 1) / 4;
            const rr = r1 * (1 - EDGE * 0.45 * s.notch[k]);
            const pk = geom.place(lerp(a0, a1, t), rr);
            g.lineTo(pk[0], pk[1]);
          }
        }
        const p2 = geom.place(a1, r1);
        g.lineTo(p2[0], p2[1]);
        g.lineTo(p3[0], p3[1]);
        g.closePath();
        g.fill();
      }

      // The core: a hot centre that the shards look thrown FROM, lit at all
      // times and not only on the hit — the middle of the frame is where every
      // shard's inner edge points, and leaving it dark made the picture read as
      // a hole rather than as a source.
      const core = (0.16 + punch * (0.5 + hardness * 0.6)) * CORE;
      if (core > 0.02) {
        const r0 = geom.hole ? Math.min(geom.hw, geom.hh) * 0.85 : 0;
        const cr = r0 + geom.rMin * (0.3 + core * 0.7);
        const cg = g.createRadialGradient(geom.cx, geom.cy, r0, geom.cx, geom.cy, cr);
        cg.addColorStop(0, hsl(pal.low + tint + 12, pal.sat, 0.85, core * 0.5 * w.energy * preset.glow));
        cg.addColorStop(1, hsl(pal.low + tint, pal.sat, 0.55, 0));
        g.fillStyle = cg;
        g.fillRect(0, 0, geom.w, geom.h);
      }

      if (strobe > 0.004) {
        // White for the genres whose strobe IS white light, the track's colour
        // for the ones whose flash is part of the picture.
        g.fillStyle = hsl(pal.high, lerp(0.55, 0.12, FLASH), lerp(0.72, 0.92, FLASH), strobe * 0.3 * w.energy);
        g.fillRect(0, 0, geom.w, geom.h);
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}

// A soft kick-shape tint, as in the old hard layer: a clean kick keeps the
// track's colour, a distorted one bleaches it toward the top of the palette.
function frameTint(pal) {
  return pal.spread * 0.12;
}
