// THE ORACLE. lib/viz/scenes/bars.js as it was in JavaScript, before its
// levelling moved to Rust (webapp/rhythm/src/viz_bars.rs); test/vizcore.test.mjs
// holds the Rust core to the same heights and caps. Not imported by the app.
// What it pins is the LEVELLING: `draw` follows the app's drawing (the row of
// capsules that replaced the glass bars), so the comparison stays about the
// arithmetic and not about a picture the app no longer draws.

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

  return { resize, update, draw, get bars() { return bars; }, get level() { return level; } };
}
