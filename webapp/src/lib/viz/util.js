// Small, allocation-free helpers the scenes share.

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);
// Frame-rate independent exponential approach. `tau` is the time constant in
// seconds: after `tau` the value has covered ~63% of the distance, whatever the
// frame rate. Plain `v = v * 0.9 + x * 0.1` does not have that property, and on
// a 120 Hz display every scene tuned on a 60 Hz one moves at half speed.
export const approach = (v, target, tau, dt) =>
  v + (target - v) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));

// An envelope that jumps up and eases down — what almost every audio-reactive
// element wants, because a hit should be instant and its decay should not be.
export function envelope(v, target, dt, attack = 0.02, release = 0.25) {
  return target > v ? approach(v, target, attack, dt) : approach(v, target, release, dt);
}

// The same approach, on a circle. Hue targets are built by adding a drift that
// wraps at 360, so a plain approach would unwind the long way round the wheel
// every time the drift wrapped — a visible reverse sweep of the whole scene.
export function approachAngle(v, target, tau, dt) {
  let d = ((target - v) % 360 + 540) % 360 - 180;
  return v + d * (1 - Math.exp(-dt / Math.max(1e-4, tau)));
}

// Move `amount` of the way from one hue to another, the short way round. Used
// to lean a chosen palette toward a genre's own temperature without replacing
// it: at 0 the hue is untouched, at 1 it is the target.
export function mixAngle(a, b, amount) {
  const d = (((b - a) % 360) + 540) % 360 - 180;
  return a + d * Math.max(0, Math.min(1, amount));
}

// --- colour -----------------------------------------------------------------
export function hsl(h, s, l, a = 1) {
  return `hsla(${((h % 360) + 360) % 360},${(s * 100).toFixed(1)}%,${(l * 100).toFixed(1)}%,${a})`;
}

// RGB → HSL, for turning a cover's dominant colour into something a scene can
// rotate and re-saturate.
export function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return [h, s, l];
}

// --- cheap noise ------------------------------------------------------------
// Two summed sines per axis. Not Perlin, but it is continuous, seamless in time,
// costs four trig calls, and nothing on screen is measuring its spectrum.
export function wave(x, t, seed = 0) {
  return (
    Math.sin(x * 1.7 + t * 0.9 + seed) * 0.6 + Math.sin(x * 0.63 - t * 1.37 + seed * 2.1) * 0.4
  );
}

// --- offscreen buffer -------------------------------------------------------
// Glow layers are drawn at a fraction of the canvas resolution and scaled up.
// That is the difference between a full-screen bloom costing 2 ms and costing
// 20: the eye cannot see the missing resolution through a gradient, and the
// fill cost drops with the square of the scale.
export function createBuffer() {
  let canvas = null;
  let g = null;
  let w = 0;
  let h = 0;
  return {
    get(width, height) {
      const iw = Math.max(1, Math.round(width));
      const ih = Math.max(1, Math.round(height));
      if (!canvas) {
        canvas = document.createElement("canvas");
        g = canvas.getContext("2d");
      }
      if (w !== iw || h !== ih) {
        w = canvas.width = iw;
        h = canvas.height = ih;
      }
      return { canvas, g, w, h };
    },
    dispose() {
      canvas = null;
      g = null;
      w = h = 0;
    },
  };
}

// Group the engine's 120 log bands down to `n` bars by taking the peak of each
// group. Peak rather than mean: a single loud partial inside a group is
// something you want to SEE, and averaging it away is what makes a spectrum
// look limp.
export function groupBands(src, out) {
  const n = out.length;
  const per = src.length / n;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * per);
    const b = Math.min(src.length, Math.max(a + 1, Math.floor((i + 1) * per)));
    let m = 0;
    for (let j = a; j < b; j++) if (src[j] > m) m = src[j];
    out[i] = m;
  }
  return out;
}

// A rounded rectangle without relying on roundRect (Safari only got it in 16).
export function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}
