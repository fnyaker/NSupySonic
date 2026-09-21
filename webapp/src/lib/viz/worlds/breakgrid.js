// DRUM & BASS / BREAKBEAT / GARAGE — the picture gets chopped.
//
// A break is a drum loop cut into pieces and re-ordered, so the visual is the
// frame cut into horizontal strips that scroll at their own speeds and JUMP on
// the onsets. Nothing radial, nothing centred: the whole design is lateral,
// which is exactly how these genres differ from everything else in the set at a
// glance.
//
// The strips are driven band by band, so the low strips move slowly and heavily
// and the top ones flicker — the same "different time constants per register"
// idea that makes the ribbons read as separate, applied to a hard edge instead
// of a soft one.

import { approach, clamp, envelope, hsl, lerp, rng } from "../util.js";

export function createBreakgridWorld(preset, opts) {
  const ROWS = Math.max(7, Math.min(16, 6 + preset.layers * 2));
  const rand = rng(4242);
  const row = [];
  for (let i = 0; i < ROWS; i++) {
    // Each strip carries a FIXED, irregular pattern of segments with gaps in
    // it. Evenly spaced blocks of one width drew a brick wall — regular,
    // opaque and about as far from a chopped break as a picture can get.
    const seg = [];
    let o = 0;
    while (o < 1) {
      const wdt = 0.03 + rand() * 0.12;
      if (rand() > 0.28) seg.push({ o, wdt, hgt: 0.35 + rand() * 0.65 });
      o += wdt + 0.015 + rand() * 0.05;
    }
    row.push({
      x: rand(),
      v: (rand() < 0.5 ? -1 : 1) * (0.05 + rand() * 0.2),
      amp: 0,
      jolt: 0,
      seg,
    });
  }
  let snare = 0;
  let sweep = -1;
  let chaos = 0.35;
  let motion = 0.85;
  let prevMid = 0;
  let clock = 0;
  let lastChop = -1;

  return {
    update(frame, dt) {
      clock += dt;
      const f = frame.features;
      const b = frame.bands;
      const look = frame.style?.look;
      chaos = approach(chaos, look ? look.chaos : 0.35, 1.2, dt);
      motion = approach(motion, look ? look.motion : 0.85, 1.2, dt);

      const per = b.length / ROWS;
      for (let i = 0; i < ROWS; i++) {
        let m = 0;
        const a0 = Math.floor(i * per);
        const e = Math.floor((i + 1) * per);
        for (let j = a0; j < e && j < b.length; j++) if (b[j] > m) m = b[j];
        const r = row[i];
        r.amp = envelope(r.amp, m, dt, 0.02, 0.14);
        r.x = (r.x + dt * r.v * lerp(0.4, 1.5, motion) * (0.3 + r.amp) + 1) % 1;
        r.jolt = approach(r.jolt, 0, 0.14, dt);
      }

      // A chop: one strip is thrown sideways. On the onsets, at a rate the
      // genre's chaos sets — a break is a cut, not a continuous slide.
      const onset = frame.beat.onset;
      if (onset > 0.45 && clock - lastChop > lerp(0.3, 0.08, chaos)) {
        lastChop = clock;
        const r = row[(rand() * ROWS) | 0];
        r.jolt = (rand() - 0.5) * lerp(0.1, 0.45, chaos);
      }

      // The snare: a bright column sweeping across, which is the one vertical
      // thing in a lateral design and therefore reads as an accent.
      const mid = f.midFlux || 0;
      if (mid > prevMid * 2 && mid > 0.006) {
        snare = clamp(mid * 60, 0.35, 1);
        sweep = 0;
      }
      prevMid = approach(prevMid, mid, 0.08, dt);
      if (sweep >= 0) {
        sweep += dt * 3.4;
        if (sweep > 1) sweep = -1;
      }
      snare = approach(snare, 0, 0.12, dt);
    },

    draw(g, geom, pal, w) {
      const h = geom.h;
      const rowH = h / ROWS;
      g.globalCompositeOperation = "lighter";

      for (let i = 0; i < ROWS; i++) {
        const r = row[i];
        if (r.amp < 0.02) continue;
        const y = i * rowH;
        const t = i / (ROWS - 1 || 1);
        const hue = pal.low + (pal.high - pal.low) * (1 - t);
        const off = (r.x + r.jolt) % 1;
        const alpha = (0.02 + r.amp * 0.16) * w.energy * preset.glow;
        g.fillStyle = hsl(hue, pal.sat, 0.62, alpha);
        for (const sg of r.seg) {
          // Drawn twice, a screen apart, so a segment leaving one edge is
          // already arriving at the other and the strip never shows a seam.
          for (const wrap of [0, -1]) {
            const x = (((sg.o + off) % 1) + wrap) * geom.w;
            if (x > geom.w || x + sg.wdt * geom.w < 0) continue;
            const bh = rowH * sg.hgt * (0.3 + r.amp * 0.7);
            g.fillRect(x, y + (rowH - bh) / 2, sg.wdt * geom.w, bh);
          }
        }
      }

      if (sweep >= 0 && snare > 0.02) {
        const x = sweep * geom.w;
        const gw = Math.max(3, geom.w * 0.02);
        const gr = g.createLinearGradient(x - gw, 0, x + gw, 0);
        gr.addColorStop(0, hsl(pal.high, 0.4, 0.9, 0));
        gr.addColorStop(0.5, hsl(pal.high, 0.35, 0.95, snare * 0.2 * w.energy * preset.glow));
        gr.addColorStop(1, hsl(pal.high, 0.4, 0.9, 0));
        g.fillStyle = gr;
        g.fillRect(x - gw, 0, gw * 2, h);
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}
