// THE ORACLE. lib/viz/scenes/bars.js as it was in JavaScript, before its
// levelling moved to Rust (webapp/rhythm/src/viz_bars.rs); test/vizcore.test.mjs
// holds the Rust core to the same heights and caps. Not imported by the app.

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

import { approach, clamp, groupBands, hsl, roundRect } from "../../src/lib/viz/util.js";

const CENTRES = [1 / 6, 0.5, 5 / 6];

export function createBarsScene(opts = {}) {
  const layout = opts.layout || "strip"; // "strip" (centred) | "full" (grounded)
  let bars = 0;
  let grouped = null;
  let smooth = null;
  let peaks = null;
  const agc = [0.15, 0.15, 0.15];
  let width = 0;
  let level = 0;

  function gainAt(gain, t) {
    if (t <= CENTRES[0]) return gain[0];
    if (t >= CENTRES[2]) return gain[2];
    const z = t < CENTRES[1] ? 0 : 1;
    const f = (t - CENTRES[z]) / (CENTRES[z + 1] - CENTRES[z]);
    return gain[z] * (1 - f) + gain[z + 1] * f;
  }

  function setCount(n) {
    if (n === bars) return;
    bars = n;
    grouped = new Float32Array(n);
    smooth = new Float32Array(n);
    peaks = new Float32Array(n);
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
    if (!bars) return;
    groupBands(frame.bands, grouped);
    level = approach(level, frame.features?.level || 0, 0.15, dt);

    // Per-zone slow level → per-zone gain.
    const zoneSum = [0, 0, 0];
    const zoneN = [0, 0, 0];
    for (let i = 0; i < bars; i++) {
      const z = i < bars / 3 ? 0 : i < (2 * bars) / 3 ? 1 : 2;
      zoneSum[z] += grouped[i];
      zoneN[z] += 1;
    }
    const gain = [0, 0, 0];
    for (let z = 0; z < 3; z++) {
      const mean = zoneN[z] ? zoneSum[z] / zoneN[z] : 0;
      agc[z] = approach(agc[z], mean, 0.9, dt);
      gain[z] = 0.62 / Math.max(0.1, agc[z]);
    }

    for (let i = 0; i < bars; i++) {
      const t = i / bars;
      let v = Math.min(1, grouped[i] * gainAt(gain, t));
      v = Math.pow(v, 1.7); // gamma → quiet/loud contrast
      smooth[i] =
        v > smooth[i] ? approach(smooth[i], v, 0.035, dt) : approach(smooth[i], v, 0.16, dt);
      // Peak caps: instant up, then a slow, accelerating fall.
      if (smooth[i] > peaks[i]) peaks[i] = smooth[i];
      else peaks[i] = Math.max(smooth[i], peaks[i] - dt * (0.22 + peaks[i] * 0.35));
    }
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

  return { resize, update, draw, get bars() { return bars; }, get level() { return level; } };
}
