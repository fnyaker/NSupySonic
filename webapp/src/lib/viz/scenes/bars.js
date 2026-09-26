// The spectrum bars, rebuilt on the precise band data.
//
// The levelling is the part worth reading. One global auto-gain across the whole
// spectrum does not work on music: the mids and highs carry most of the energy,
// so they drive the gain down and the bass ends up parked at the bottom of the
// display whatever it is doing. Instead the strip is split into three zones —
// bass, mid, high — each with its own slow gain envelope, and the per-bar gain
// is interpolated between the zone centres so there is no seam where they meet.
// Every register then keeps its own life.
//
// On top of that: a gamma curve for quiet/loud contrast, a fast-attack /
// slow-release envelope so bars are lively rather than parked in the middle,
// and peak caps that fall slowly — which is what makes a spectrum readable
// rather than just busy.
//
// THE LEVELLING IS RUST (webapp/rhythm/src/viz_bars.rs, through
// lib/viz/core.js): the grouping, the three zone gains, the gamma, the
// envelopes and the caps. This file draws what it computed.

import { clamp, hsl, roundRect } from "../util.js";
import { BarsCore, vizCore } from "../core.js";

export function createBarsScene(opts = {}) {
  const layout = opts.layout || "strip"; // "strip" (centred) | "full" (grounded)
  const core = opts.core || vizCore();
  if (!core) throw new Error("bars: the animation core is not loaded");
  const rb = new BarsCore(core);
  let bars = 0;
  let width = 0;

  function setCount(n) {
    if (n === bars) return;
    bars = Math.min(n, rb.max);
    rb.count(bars);
  }

  function resize(w, h, preset) {
    width = w;
    // One bar per ~7 CSS px, inside the tier's ceiling: denser than that and
    // the gaps disappear at any sane bar width.
    const want = clamp(Math.floor(w / (layout === "full" ? 9 : 7)), 20, preset.bars);
    setCount(want);
    void h;
  }

  function update(frame, dt) {
    if (!bars || !frame.bands) return;
    rb.update(frame.bands, frame.features?.level || 0, dt);
  }

  function draw(g, w, h, pal) {
    if (!bars || !w || !h) return;
    // Bars draw no background of their own — in the player they sit over the
    // blurred cover — so the canvas has to be cleared rather than washed. The
    // other scenes keep their trails by painting a translucent wash instead;
    // this one has nothing to wash WITH, and every frame it drew would
    // otherwise still be on screen.
    g.clearRect(0, 0, w, h);
    const bw = w / bars;
    const body = bw * 0.66;
    const pad = (bw - body) / 2;
    const radius = Math.min(body / 2, 3);
    const full = layout === "full";
    const maxH = full ? h * 0.92 : h;
    const smooth = rb.smooth;
    const peaks = rb.peaks;

    for (let i = 0; i < bars; i++) {
      const t = i / (bars - 1 || 1);
      const v = smooth[i];
      const bh = Math.max(2, v * maxH);
      const x = i * bw + pad;
      const y = full ? h - bh : (h - bh) / 2;
      // Hue walks the palette's spread across the strip, so the low end and the
      // top end are visibly different registers rather than one flat colour.
      const hue = pal.low + (pal.high - pal.low) * t;
      const a = 0.22 + 0.72 * v;
      if (full && bh > 6) {
        const grad = g.createLinearGradient(0, h, 0, h - bh);
        grad.addColorStop(0, hsl(hue, pal.sat, pal.light * 0.55, a * 0.85));
        grad.addColorStop(1, hsl(hue + 14, pal.sat, Math.min(0.82, pal.light + 0.18), a));
        g.fillStyle = grad;
      } else {
        g.fillStyle = hsl(hue, pal.sat * 0.35 + 0.2, Math.min(0.95, pal.light + 0.3), a);
      }
      roundRect(g, x, y, body, bh, radius);
      g.fill();

      // Peak cap — only once it has separated from the bar, otherwise it just
      // thickens the top and reads as noise.
      const ph = peaks[i] * maxH;
      if (ph > bh + 3) {
        const py = full ? h - ph : (h - ph) / 2;
        g.fillStyle = hsl(hue + 20, 0.2, 0.96, 0.35 + 0.35 * peaks[i]);
        roundRect(g, x, py, body, 2, 1);
        g.fill();
        if (!full) {
          roundRect(g, x, h - py - 2, body, 2, 1);
          g.fill();
        }
      }
    }
  }

  function dispose() {
    rb.free();
  }

  return { resize, update, draw, dispose, get bars() { return bars; }, get level() { return rb.level; } };
}
