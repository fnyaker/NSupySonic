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
//
// `axis` turns the whole design ninety degrees — columns falling instead of
// strips scrolling — which is the biggest single difference a skin can make
// anywhere in the set, and it is what keeps 2-step (a lateral shuffle) from
// looking like drumfunk. `stutter` re-fires one strip several times in a row
// on the same onset, which is the ratchet these genres are made of, and `tear`
// sends a chopped strip the other way instead of nudging it.

import { approach, clamp, envelope, hsl, lerp, rng } from "../util.js";

export function createBreakgridWorld(preset, opts, skin = {}) {
  const p = skin.p || {};
  // Liquid is a handful of wide strips; drumfunk is twenty narrow ones.
  const ROWS = Math.max(4, Math.min(26, Math.round((6 + preset.layers * 2) * (p.rows ?? 1))));
  const CHOP = p.chop ?? 1;
  const SNARE = p.snare ?? 1;
  const VERTICAL = (p.axis ?? 0) > 0.5;
  const STUTTER = clamp(p.stutter ?? 0, 0, 1);
  const TEAR = clamp(p.tear ?? 0, 0, 1);
  const SPEED = skin.speed ?? 1;
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
  let ratchet = 0;
  let ratchetRow = 0;
  let ratchetAt = 0;

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
        r.x = (r.x + dt * SPEED * r.v * lerp(0.4, 1.5, motion) * (0.3 + r.amp) + 1) % 1;
        r.jolt = approach(r.jolt, 0, 0.14, dt);
      }

      // A chop: one strip is thrown sideways. On the onsets, at a rate the
      // genre's chaos sets — a break is a cut, not a continuous slide.
      const onset = frame.beat.onset;
      if (CHOP > 0.05 && onset > 0.45 && clock - lastChop > lerp(0.3, 0.08, chaos) / CHOP) {
        lastChop = clock;
        const idx = (rand() * ROWS) | 0;
        const r = row[idx];
        const throwBy = lerp(0.1, 0.45, chaos) * CHOP;
        // A tear sends the strip the OTHER way rather than nudging it, so the
        // cut reads as a reversed bar instead of a slip.
        r.jolt = TEAR > 0.05 ? -Math.sign(r.v) * throwBy * (1 + TEAR) : (rand() - 0.5) * throwBy;
        if (STUTTER > 0.05) {
          ratchet = 2 + Math.round(STUTTER * 4);
          ratchetRow = idx;
          ratchetAt = clock;
        }
      }

      // The ratchet: the same strip re-thrown on a fixed short grid, a few
      // times. A break is built out of exactly this, and spreading the repeats
      // randomly would just be more chop.
      if (ratchet > 0 && clock - ratchetAt > 0.055) {
        ratchetAt = clock;
        ratchet -= 1;
        const r = row[ratchetRow];
        r.jolt = -r.jolt * 0.85;
      }

      // The snare: a bright column sweeping across, which is the one vertical
      // thing in a lateral design and therefore reads as an accent.
      const mid = f.midFlux || 0;
      if (mid > prevMid * 2 && mid > 0.006) {
        snare = clamp(mid * 60, 0.35, 1) * SNARE;
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
      g.globalCompositeOperation = "lighter";
      // `along` is the direction a strip scrolls, `across` the one it is thick
      // in. Everything below is written in those two, so turning the design on
      // its side is one flag rather than a second copy of the drawing code.
      const along = VERTICAL ? geom.h : geom.w;
      const across = VERTICAL ? geom.w : geom.h;
      const rowH = across / ROWS;

      for (let i = 0; i < ROWS; i++) {
        const r = row[i];
        if (r.amp < 0.02) continue;
        const v = i * rowH;
        const t = i / (ROWS - 1 || 1);
        const hue = pal.low + (pal.high - pal.low) * (1 - t);
        const off = (r.x + r.jolt) % 1;
        const alpha = (0.02 + r.amp * 0.16) * w.energy * preset.glow;
        g.fillStyle = hsl(hue, pal.sat, 0.62, alpha);
        for (const sg of r.seg) {
          // Drawn twice, a screen apart, so a segment leaving one edge is
          // already arriving at the other and the strip never shows a seam.
          for (const wrap of [0, -1]) {
            const u = (((sg.o + off) % 1) + wrap) * along;
            if (u > along || u + sg.wdt * along < 0) continue;
            const bh = rowH * sg.hgt * (0.3 + r.amp * 0.7);
            const thick = v + (rowH - bh) / 2;
            if (VERTICAL) g.fillRect(thick, u, bh, sg.wdt * along);
            else g.fillRect(u, thick, sg.wdt * along, bh);
          }
        }
      }

      // The snare sweep runs ACROSS the strips whichever way they lie, so it
      // stays the one thing cutting the grain rather than joining it.
      if (sweep >= 0 && snare > 0.02) {
        const u = sweep * along;
        const gw = Math.max(3, along * 0.02);
        const gr = VERTICAL
          ? g.createLinearGradient(0, u - gw, 0, u + gw)
          : g.createLinearGradient(u - gw, 0, u + gw, 0);
        gr.addColorStop(0, hsl(pal.high, 0.4, 0.9, 0));
        gr.addColorStop(0.5, hsl(pal.high, 0.35, 0.95, snare * 0.2 * w.energy * preset.glow));
        gr.addColorStop(1, hsl(pal.high, 0.4, 0.9, 0));
        g.fillStyle = gr;
        if (VERTICAL) g.fillRect(0, u - gw, across, gw * 2);
        else g.fillRect(u - gw, 0, gw * 2, across);
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}
