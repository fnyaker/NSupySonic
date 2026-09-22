// TRANCE — a star field with a build in it.
//
// Trance is about the approach: eight bars of rising filter and rolled snares,
// then the release. So the motif is stars streaming out of the middle whose
// SPEED tracks how loud the track is against itself (`dynamics`) — a build
// accelerates the whole field, the drop throws it — plus long arcs thrown on
// the chord changes, which is where the melody of a trance track lives.

import { approach, clamp, envelope, hsl, lerp, rng } from "../util.js";

const TAU = Math.PI * 2;
const ARCS = 5;

export function createStarfieldWorld(preset, opts, skin = {}) {
  const p = skin.p || {};
  const SPEED = skin.speed ?? 1;
  const ARCS_K = p.arcs ?? 1;
  // `spiral` bends every star's path as it travels, so the field becomes a
  // vortex instead of a rush — uplifting trance turns, progressive does not.
  // `dot` drops the streak and leaves the point: a still sky, which is what a
  // slow melodic track should be looking at.
  const SPIRAL = p.spiral ?? 0;
  const DOT = clamp(p.dot ?? 0, 0, 1);
  const N = Math.max(40, Math.min(420, Math.round(preset.particles * 1.6 * (p.stars ?? 1))));
  const st = new Float32Array(N * 3); // angle, radial, speed factor
  const rand = rng(90210);
  for (let i = 0; i < N; i++) {
    st[i * 3] = rand() * TAU;
    st[i * 3 + 1] = rand();
    st[i * 3 + 2] = 0.55 + rand() * 0.9;
  }
  const arcs = [];
  for (let i = 0; i < ARCS; i++) arcs.push({ age: -1, a: 0, span: 0, rad: 0 });
  let arcNext = 0;
  let rush = 0.35;
  let glow = 0;
  let prevChord = 0;

  return {
    update(frame, dt) {
      const f = frame.features;
      const beat = frame.beat;
      // The build: how loud this moment is against the track's own loud
      // reference, eased slowly so the acceleration is felt over bars.
      const dyn = f.dynamics ?? 1;
      rush = approach(rush, (0.22 + dyn * dyn * 1.05) * SPEED, 0.55, dt);
      glow = envelope(glow, clamp((f.kick || 0) * 0.8 + (f.level || 0) * 0.5, 0, 1), dt, 0.02, 0.4);

      for (let i = 0; i < N; i++) {
        const j = i * 3;
        st[j + 1] += dt * rush * st[j + 2] * 0.55;
        // The curl is strongest near the middle and eases off outward, which is
        // what makes it read as a vortex rather than as the whole field turning.
        if (SPIRAL) st[j] += dt * SPIRAL * 0.9 * st[j + 2] / (0.25 + st[j + 1]);
        if (st[j + 1] > 1.25) {
          st[j + 1] = 0.02;
          st[j] = rand() * TAU;
          st[j + 2] = 0.55 + rand() * 0.9;
        }
      }

      // An arc per harmony change — the one event in trance worth drawing big.
      const chord = f.chordChange || 0;
      if (ARCS_K > 0.05 && chord > 0.25 / ARCS_K && chord > prevChord * 1.4) {
        const a = arcs[(arcNext = (arcNext + 1) % ARCS)];
        a.age = 0;
        a.a = rand() * TAU;
        a.span = TAU * (0.16 + rand() * 0.22);
        a.rad = 0.45 + rand() * 0.45;
      }
      prevChord = approach(prevChord, chord, 0.35, dt);
      for (const a of arcs) {
        if (a.age < 0) continue;
        a.age += dt;
        a.rad += dt * 0.12;
        if (a.age > 1.6) a.age = -1;
      }
      void beat;
    },

    draw(g, geom, pal, w) {
      g.globalCompositeOperation = "lighter";

      // The stars. Each is a streak from where it was to where it is, so the
      // field reads as speed rather than as dots.
      const lw = Math.max(0.8, geom.rMin * 0.004);
      for (let i = 0; i < N; i++) {
        const j = i * 3;
        const r = st[j + 1];
        if (r <= 0.02) continue;
        const a = st[j];
        const tail = Math.min(r - 0.01, (0.03 + r * 0.16 * rush) * lerp(1, 0.12, DOT));
        const p0 = geom.place(a, r - tail);
        const x0 = p0[0];
        const y0 = p0[1];
        const p1 = geom.place(a, r);
        const fade = clamp(r * 3, 0, 1) * clamp((1.25 - r) * 4, 0, 1);
        const alpha = (0.05 + r * 0.2) * fade * w.energy * preset.glow;
        if (alpha < 0.004) continue;
        const gr = g.createLinearGradient(x0, y0, p1[0], p1[1]);
        gr.addColorStop(0, hsl(pal.mid, pal.sat * 0.8, 0.7, 0));
        gr.addColorStop(1, hsl(pal.high, pal.sat, 0.85, alpha));
        g.strokeStyle = gr;
        g.lineWidth = lw * (0.6 + st[j + 2] * 1.5) * (0.5 + r);
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(p1[0], p1[1]);
        g.stroke();
      }

      // The chord arcs.
      for (const a of arcs) {
        if (a.age < 0) continue;
        const t = a.age / 1.6;
        const alpha = Math.sin(Math.PI * t) * 0.2 * ARCS_K * w.energy * preset.glow;
        if (alpha < 0.005) continue;
        g.strokeStyle = hsl(pal.low + 20, pal.sat, 0.74, alpha);
        g.lineWidth = Math.max(2, geom.rMin * 0.02 * (1 - t));
        g.lineCap = "round";
        g.beginPath();
        const steps = 12;
        for (let k = 0; k <= steps; k++) {
          const ang = a.a + (a.span * k) / steps;
          const p = geom.place(ang, Math.min(1.1, a.rad));
          k === 0 ? g.moveTo(p[0], p[1]) : g.lineTo(p[0], p[1]);
        }
        g.stroke();
      }

      // The glow the field is streaming out of.
      const r0 = geom.hole ? Math.min(geom.hw, geom.hh) * 0.85 : 0;
      const cr = r0 + geom.rMin * (0.35 + glow * 0.5);
      const cg = g.createRadialGradient(geom.cx, geom.cy, r0, geom.cx, geom.cy, Math.max(r0 + 1, cr));
      cg.addColorStop(0, hsl(pal.high, pal.sat * 0.9, 0.78, (0.03 + glow * 0.09) * w.energy * preset.glow));
      cg.addColorStop(1, hsl(pal.mid, pal.sat * 0.7, 0.5, 0));
      g.fillStyle = cg;
      g.fillRect(0, 0, geom.w, geom.h);
      g.globalCompositeOperation = "source-over";
    },
  };
}
