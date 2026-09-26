// THE OSCILLOSCOPE, drawn by the GPU.
//
// Everything the scope has to be — triggered so the wave stands still, a
// trigger low-passed so it locks to the music rather than the cymbals, one
// timebase for both channels, per-column MIN/MAX so nothing between two points
// is invented, an auto-range that compresses rather than normalises — is the
// Rust core's (webapp/rhythm/src/viz_scope.rs), exactly as scenes/scope.js
// reasons it through. This file is how it gets on screen, and that is the part
// that cost: drawn as canvas strokes, a high-tier trace is six paths of ~3,700
// points with round joins, composited additively, and with the canvas
// rasterised in software — a phone, a WebView without GPU raster — that
// measured 47 ms a frame, twenty frames a second at best, for a picture whose
// whole point is to be steady. Here the trace goes up as a texture (straight
// from the WebAssembly module's memory, no copy) and each piece of it is one
// instanced quad the GPU shades: the same frame costs the CPU next to nothing.
//
//   THE TRACE is one quad per piece of the canvas version's polyline: a
//   column's own extent (its MAX to its MIN), then the step to the next
//   column (this MIN to the next MAX). The pieces take the MAX of each other
//   rather than adding, so a joint is exactly as bright as the line — a
//   canvas stroke never lights its own pixels twice either — while the two
//   channels and the layers of one beam still combine.
//   THE BEAM is the canvas version's three strokes in one profile: a white-hot
//   core (the same brightness at every tier: the tier changes how PRECISE
//   the trace is, never whether you can see it), a body, and a halo scaled
//   by the tier's glow; wider as the columns get coarser, for the reason
//   scope.js gives.
//   THE PHOSPHOR is a time constant (70 ms), applied to this world's own last
//   frame: the trail lasts as long at a 30 fps cap as at 144.
//   THE FACE — graticule, zero line, the trigger marker fading with the lock,
//   "G" and "D" on the lanes — is drawn at a steady brightness under it.
//
// The lanes go where scope.js puts them: two bands stacked, or two columns side
// by side, in the free strips around the artwork.
//
// An INSTRUMENT, not a world of the catalogue: the smart engine never picks it
// (worlds/index.js keeps it apart), and it is shown only by the scope mode.

import { ScopeCore } from "../core.js";

// Must equal viz_scope.rs MAX_COLS: the texture is MAX_COLS pairs wide, one row
// per channel, which is the core's own layout of the trace.
const MAX_COLS = 4096;
const PERSIST = 0.07;
const DEFLECT = 0.88;
const FALLBACK = { buffer: 4096, search: 40, points: 512, exact: false, fine: false, interp: false, divisions: 6, passes: 2 };
const TINTS = { duo: 0, mono: 1, sweep: 2 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const FACE = `
// Where p is along a lane (x, 0..1) and across it (y, -1..1).
vec2 laneUV(vec2 p, vec4 L0, vec4 L1) {
  vec2 d = p - L0.xy;
  return vec2(dot(d, L0.zw) / max(1e-8, dot(L0.zw, L0.zw)), dot(d, L1.xy) / max(1e-8, dot(L1.xy, L1.xy)));
}
// A line one render pixel wide, antialiased against its distance in p units.
float hair(float dist, float px) { return 1.0 - smoothstep(0.3 * px, 1.2 * px, dist); }
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(1e-8, dot(ba, ba)), 0.0, 1.0);
  return length(pa - ba * h);
}
// An arc of a circle from angle a0 to a1 (radians, counter-clockwise).
float sdArc(vec2 p, vec2 c, float r, float a0, float a1) {
  vec2 d = p - c;
  float a = atan(d.y, d.x);
  if (a < a0) a += TAU;
  if (a >= a0 && a <= a1) return abs(length(d) - r);
  vec2 e0 = c + r * vec2(cos(a0), sin(a0));
  vec2 e1 = c + r * vec2(cos(a1), sin(a1));
  return min(length(p - e0), length(p - e1));
}
// "G" (ch 0, the left channel) and "D" (ch 1), in a unit box, as strokes.
float glyph(vec2 g, int ch) {
  if (ch == 0) {
    float d = sdArc(g, vec2(0.5), 0.4, radians(40.0), radians(320.0));
    d = min(d, sdSeg(g, vec2(0.56, 0.44), vec2(0.88, 0.44)));
    return min(d, sdSeg(g, vec2(0.88, 0.44), vec2(0.88, 0.22)));
  }
  float d = sdSeg(g, vec2(0.2, 0.1), vec2(0.2, 0.9));
  d = min(d, sdSeg(g, vec2(0.2, 0.9), vec2(0.42, 0.9)));
  d = min(d, sdSeg(g, vec2(0.2, 0.1), vec2(0.42, 0.1)));
  return min(d, sdArc(g, vec2(0.42, 0.5), 0.4, radians(-90.0), radians(90.0)));
}
vec3 face(vec2 p, int ch) {
  vec4 L0 = uEv[ch * 2];
  vec4 L1 = uEv[ch * 2 + 1];
  if (L1.z < 2.0 || L1.w < 1.0) return vec3(0.0);
  vec2 tv = laneUV(p, L0, L1);
  float la = length(L0.zw);
  float lv = length(L1.xy);
  float px = uFrame.w;
  float inT = step(-0.002, tv.x) * step(tv.x, 1.002);
  float inV = step(abs(tv.y), 1.002);
  // The frame, the halves and the divisions: three weights, so it reads as a
  // scale rather than as graph paper — then the zero line, the brightest.
  float fr = max(hair(min(abs(tv.x), abs(tv.x - 1.0)) * la, px) * inV, hair(abs(abs(tv.y) - 1.0) * lv, px) * inT);
  float nd = max(1.0, uS1.z);
  float dv = abs(fract(tv.x * nd + 0.5) - 0.5) / nd * la;
  float grid = max(hair(abs(abs(tv.y) - 0.5) * lv, px) * inT, hair(dv, px) * inV * inT);
  float zero = hair(abs(tv.y) * lv, px * 1.3) * inT;
  vec3 ink = mix(uPalMid.rgb, vec3(0.7), 0.5);
  vec3 c = ink * (0.14 * fr + 0.07 * grid) + mix(uPalMid.rgb, vec3(0.9), 0.55) * 0.2 * zero;
  // The trigger marker, in the lane's own margin, fading with the lock.
  vec2 a = normalize(L0.zw);
  vec2 v = normalize(L1.xy);
  float s = uEv[4].y;
  vec2 q = vec2(dot(p - L0.xy, a), dot(p - L0.xy, v));
  float tri = max(max(q.x, -q.x - 1.4 * s), abs(q.y) - (-q.x) / 1.4);
  c += mix(uPalHigh.rgb, vec3(1.0), 0.6) * 0.5 * uS0.z * (1.0 - smoothstep(-0.5 * px, 0.8 * px, tri));
  // Which trace is which.
  float size = uEv[4].z;
  vec2 anchor = uEv[4].x > 0.5 ? L0.xy + L0.zw * 0.012 + L1.xy * 0.9 : L0.xy - L1.xy * 0.88 + L0.zw * 0.012;
  vec2 g = vec2(p.x - anchor.x, p.y - (anchor.y - size)) / size;
  if (g.x > -0.2 && g.x < 1.2 && g.y > -0.2 && g.y < 1.2) {
    float d = glyph(g, ch) * size;
    c += mix(uPalMid.rgb, vec3(0.85), 0.6) * 0.3 * (1.0 - smoothstep(0.07 * size, 0.07 * size + 1.2 * px, d));
  }
  return c;
}
`;

export default {
  id: "scope",
  uses: [],
  feedback: true,
  data: { width: MAX_COLS, height: 2 },
  params: {},
  look: { exposure: 1.0, bloom: 0.9, threshold: 0.75, saturation: 1.05 },

  fragment: `${FACE}
void main() {
  vec2 p = fragP();
  vec2 uv = gl_FragCoord.xy / uRes;
  // The phosphor: last frame's light, decayed by this frame's share of the
  // 70 ms time constant; the face and the dark of the tube at their own
  // steady level under it.
  vec3 trail = prev(uv) * uS0.w;
  vec3 steady = uPalBg.rgb * 0.6 + face(p, 0) + face(p, 1);
  emit(max(trail, steady));
}
`,

  particles: {
    count: 2 * 2 * MAX_COLS,
    exact: true,
    blendMax: true,
    vertex: `
void particle(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind) {
  col = vec4(0.0); pos = vec2(0.0); axis = vec2(0.0); width = 0.0; kind = 1.0;
  int cols = int(uS0.x);
  int per = ${MAX_COLS} * 2;
  int ch = id / per;
  int s = id - ch * per;
  int c = s >> 1;
  bool hop = (s & 1) == 1;
  if (cols < 2 || c >= cols - (hop ? 1 : 0)) return;
  vec4 L0 = uEv[ch * 2];
  vec4 L1 = uEv[ch * 2 + 1];
  if (L1.z < 2.0 || L1.w < 1.0) return;
  float n = float(cols - 1);
  float scale = uS0.y;
  vec2 lh0 = texelFetch(uData, ivec2(c, ch), 0).xy;
  vec2 base0 = L0.xy + L0.zw * (float(c) / n);
  vec2 A;
  vec2 B;
  if (!hop) {
    // The column's own extent, MAX to MIN.
    A = base0 + L1.xy * clamp(lh0.y * scale, -1.0, 1.0);
    B = base0 + L1.xy * clamp(lh0.x * scale, -1.0, 1.0);
  } else {
    // The step to the next column: this MIN to the next MAX.
    vec2 lh1 = texelFetch(uData, ivec2(c + 1, ch), 0).xy;
    A = base0 + L1.xy * clamp(lh0.x * scale, -1.0, 1.0);
    B = L0.xy + L0.zw * (float(c + 1) / n) + L1.xy * clamp(lh1.y * scale, -1.0, 1.0);
  }
  float w = uS1.y;
  vec2 d = B - A;
  float half_ = 0.5 * length(d);
  pos = 0.5 * (A + B);
  axis = (half_ > 1e-7 ? d / (2.0 * half_) : vec2(1.0, 0.0)) * (half_ + w);
  width = w;
  kind = (half_ + w) / w;
  // The colour: the palette's two ends for the two channels, one hue for both,
  // or the hue walking along the trace exactly as it walks across the bars.
  float t = float(c) / n;
  int tint = int(uS1.x + 0.5);
  vec3 hue = tint == 1 ? uPalMid.rgb : tint == 2 ? pal(t) : (ch == 0 ? uPalLow.rgb : uPalHigh.rgb);
  col = vec4(hue, 1.0);
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  // Distance to the segment, in halo half-widths: the quad is (k) of them
  // long each way and one across.
  float x = max(abs(q.x) * k - (k - 1.0), 0.0);
  float d = length(vec2(x, q.y));
  float pw = uFrame.w / max(1e-6, uS1.y);
  float rc = 1.0 / 5.5;
  float rb = 2.3 / 5.5;
  float core = 1.0 - smoothstep(rc - 0.6 * pw, rc + 0.6 * pw, d);
  float body = (1.0 - smoothstep(rb * 0.5, rb, d)) * uEv[4].w;
  float halo = exp(-d * d * 3.5) * (1.0 - smoothstep(0.8, 1.0, d));
  float glowK = uS1.w;
  vec3 hot = mix(c.rgb, vec3(1.0), 0.72);
  vec3 light = hot * core * 1.25 + c.rgb * (body * 0.5 + halo * 0.24) * glowK;
  return vec4(light, 1.0);
}
`,
  },

  create({ opts, preset, data, state, ev, core }) {
    const sc = preset?.scope || FALLBACK;
    const rs = new ScopeCore(core);
    rs.config(sc);
    // The halo is the tier's; the core is not (see the header).
    const glow = clamp(preset?.glow ?? 1, 0.7, 1.4);
    let cols = 0;
    let gain = 1;
    let locked = 0;
    return {
      // Every analysis frame: the samples of this frame, through the core.
      hear(frame, dt) {
        if (!cols) return;
        const wv = frame.wave;
        if (!wv || !wv.size || !wv.left) rs.idle(dt);
        else rs.update(wv, dt);
        const st = rs.state();
        gain = st.gain;
        locked = st.locked;
        data.src = rs.trace();
        data.dirty = true;
      },
      // Every picture: where the lanes are, and the beam for this frame.
      step(dt, m, clocks) {
        const W = clocks.width;
        const H = clocks.height;
        if (!(W > 0 && H > 0)) return;
        const k = 2 / H; // CSS px -> p units
        const [hx, hy, ahw, ahh] = clocks.hole;
        const hole = ahw > 0 && ahh > 0;
        const cx = W / 2 + hx / k;
        const cy = H / 2 - hy / k;
        const hw = ahw / k;
        const hh = ahh / k;
        const horiz = (opts.orientation || "horizontal") === "horizontal";
        let ra;
        let rb;
        if (horiz) {
          const top = hole ? Math.max(0, cy - hh) : H / 2;
          const bot = hole ? Math.min(H, cy + hh) : H / 2;
          ra = { x: 0, y: 0, w: W, h: top };
          rb = { x: 0, y: bot, w: W, h: H - bot };
        } else {
          const left = hole ? Math.max(0, cx - hw) : W / 2;
          const right = hole ? Math.min(W, cx + hw) : W / 2;
          ra = { x: 0, y: 0, w: left, h: H };
          rb = { x: right, y: 0, w: W - right, h: H };
        }
        let len = 0;
        let span = Infinity;
        const lanes = [ra, rb].map((r) => {
          const short = Math.min(r.w, r.h);
          const pad = Math.min(clamp(short * 0.09, 4, 26), short * 0.35);
          const inX = r.w - 2 * pad;
          const inY = r.h - 2 * pad;
          const l = horiz
            ? { ox: r.x + pad, oy: r.y + r.h / 2, ax: inX, ay: 0, vx: 0, vy: -inY / 2, len: inX, span: inY / 2 }
            : { ox: r.x + r.w / 2, oy: r.y + pad, ax: 0, ay: inY, vx: inX / 2, vy: 0, len: inY, span: inX / 2 };
          len = Math.max(len, l.len);
          span = Math.min(span, l.span);
          return l;
        });
        const want = clamp(Math.round(len), 32, Math.min(sc.points, rs.maxCols));
        if (want !== cols) {
          cols = want;
          rs.cols(cols);
        }
        const coarse = clamp(Math.sqrt(len / Math.max(1, want)), 1, 2.2);
        const coreW = clamp(span * 0.02, 1, 2.6) * coarse;
        // Into p-space (y up, one unit = half the height) for the shaders.
        lanes.forEach((l, i) => {
          const o = i * 8;
          ev[o] = (l.ox - W / 2) * k;
          ev[o + 1] = -(l.oy - H / 2) * k;
          ev[o + 2] = l.ax * k;
          ev[o + 3] = -l.ay * k;
          ev[o + 4] = l.vx * k;
          ev[o + 5] = -l.vy * k;
          ev[o + 6] = l.len;
          ev[o + 7] = l.span;
        });
        ev[16] = horiz ? 1 : 0;
        ev[17] = clamp(span * 0.07, 3.5, 9) * k;
        ev[18] = clamp(Math.min(span, len) * 0.16, 9, 15) * k;
        ev[19] = sc.passes > 2 ? 1 : 0;
        const intensity = clamp(opts.intensity ?? 0.7, 0, 1);
        state[0] = cols;
        state[1] = gain * DEFLECT * (0.55 + intensity * 0.45);
        state[2] = locked;
        state[3] = Math.exp(-dt / PERSIST);
        state[4] = TINTS[opts.colour] ?? 0;
        state[5] = ((coreW * 5.5) / 2) * k;
        state[6] = sc.divisions || 6;
        state[7] = glow;
      },
      dispose() {
        rs.free();
      },
    };
  },
};
