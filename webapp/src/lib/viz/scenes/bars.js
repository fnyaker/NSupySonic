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
// and a slow-falling peak per band, drawn as a faint afterglow of the capsule
// rather than the hairline cap of a 2005 media player.
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
    // The same row of light the GL world draws (worlds/spectrum.js): one fully
    // rounded capsule per band, mirrored about its axis as ONE shape, a dot at
    // rest, and a faint afterglow where the band was a moment ago instead of a
    // hairline cap hanging over it.
    const bw = w / bars;
    const body = Math.max(1.5, bw * 0.5);
    const pad = (bw - body) / 2;
    const r = body / 2;
    const full = layout === "full";
    const axis = h / 2;
    const reach = full ? h * 0.36 : h / 2 - 1;
    const smooth = rb.smooth;
    const peaks = rb.peaks;

    for (let i = 0; i < bars; i++) {
      const t = i / (bars - 1 || 1);
      const v = smooth[i];
      const half = Math.max(r, v * reach);
      const x = i * bw + pad;
      // Hue walks the palette's spread across the row, so the low end and the
      // top end are visibly different registers rather than one flat colour.
      const hue = pal.low + (pal.high - pal.low) * t;
      const ph = Math.max(r, peaks[i] * reach);
      if (ph > half + 2) {
        g.fillStyle = hsl(hue, pal.sat, pal.light, 0.16);
        roundRect(g, x, axis - ph, body, ph * 2, r);
        g.fill();
      }
      g.fillStyle = hsl(hue, pal.sat * 0.8, Math.min(0.9, pal.light + 0.08 + 0.2 * v), 0.62 + 0.38 * Math.min(1, v / 0.6));
      roundRect(g, x, axis - half, body, half * 2, r);
      g.fill();
    }
  }

  function dispose() {
    rb.free();
  }

  return { resize, update, draw, dispose, get bars() { return bars; }, get level() { return rb.level; } };
}
