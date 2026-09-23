// The passes that run after a world has drawn: the dissolve between two
// worlds, the bloom, and the grade that turns linear light into a picture.
//
// Why each of them is here rather than inside the worlds:
//
//  - BLOOM is what makes an emissive line read as light instead of as paint.
//    It is the Call of Duty / Jimenez (SIGGRAPH 2014) filter, the one every
//    modern engine converged on: a 13-tap downsample that cannot alias (the
//    reason cheaper chains shimmer when a bright line moves), a Karis average
//    on the first step so a single hot pixel cannot become a flickering disc,
//    and a 3x3 tent on the way back up. Six mips of it cost less than one
//    full-resolution blur and give the long, soft, physically shaped tail that
//    a single Gaussian never does.
//
//  - THE TONE MAP is AgX (the filmic transform Blender adopted in 4.0), in
//    Benjamin Wrensch's minimal polynomial form. The choice is about highlights.
//    A clamp or a Reinhard sends a saturated neon hot spot to a flat cyan or
//    magenta blob; ACES skews it (blue to purple, red to orange). AgX rolls a
//    hot colour toward white THROUGH its own hue, which is what a real light
//    does on a real sensor — and in scenes built out of emissive neon that is
//    the whole difference between "lit" and "clipped".
//
//  - GRAIN AND DITHER. An 8-bit canvas cannot hold a smooth dark gradient: the
//    last project already found that (the countable ring trails). Triangular
//    dither at one code value removes the banding outright; a whisper of
//    luminance-weighted grain on top is what stops a dark, still frame from
//    looking like a flat fill.
//
//  - The CHROMATIC FRINGE is radial and tiny, and it swells for an instant on
//    an impact. Deliberately no vignette: darkening the edges would undo the
//    rule that a scene fills the whole frame of a beamer.

import { VERSION, PRECISION } from "./glsl.js";

const HEAD = VERSION + PRECISION + "in vec2 vUv;\nout vec4 fragColor;\n";

const LUMA = "float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }\n";

// The bright pass, fused with the first downsample. The soft knee means there
// is no visible threshold: light starts contributing gradually from `uKnee`
// below the threshold, so a line fading out does not snap out of its halo.
export const PREFILTER_FS = `${HEAD}${LUMA}
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform vec2 uThresh; // x threshold, y knee
vec3 tap(vec2 o) {
  vec3 c = texture(uSrc, vUv + uTexel * o).rgb;
  // A NaN or an Inf that reached this far would be smeared over the whole
  // bloom chain and the frame would go black in blocks. Comparisons against
  // NaN are false, so this catches both.
  if (!(c.r < 6e4 && c.g < 6e4 && c.b < 6e4 && c.r >= 0.0 && c.g >= 0.0 && c.b >= 0.0)) c = vec3(0.0);
  return c;
}
vec3 knee(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float k = uThresh.y;
  float rq = clamp(br - uThresh.x + k, 0.0, 2.0 * k);
  rq = rq * rq / (4.0 * k + 1e-5);
  return c * (max(rq, br - uThresh.x) / max(br, 1e-5));
}
// Karis: each of the five box groups is weighted by 1/(1+luma), so one
// firefly pixel is averaged down instead of being blurred into a disc that
// pops in and out as the line it belongs to moves by half a texel.
vec3 kgroup(vec3 a, vec3 b, vec3 c, vec3 d, out float w) {
  vec3 m = (a + b + c + d) * 0.25;
  w = 1.0 / (1.0 + luma(m));
  return m * w;
}
void main() {
  vec3 a = tap(vec2(-2.0, 2.0)), b = tap(vec2(0.0, 2.0)), c = tap(vec2(2.0, 2.0));
  vec3 d = tap(vec2(-2.0, 0.0)), e = tap(vec2(0.0)), f = tap(vec2(2.0, 0.0));
  vec3 g = tap(vec2(-2.0, -2.0)), h = tap(vec2(0.0, -2.0)), i = tap(vec2(2.0, -2.0));
  vec3 j = tap(vec2(-1.0, 1.0)), k = tap(vec2(1.0, 1.0));
  vec3 l = tap(vec2(-1.0, -1.0)), m = tap(vec2(1.0, -1.0));
  float w0, w1, w2, w3, w4;
  vec3 s = kgroup(j, k, l, m, w0) * 0.5;
  s += kgroup(a, b, d, e, w1) * 0.125;
  s += kgroup(b, c, e, f, w2) * 0.125;
  s += kgroup(d, e, g, h, w3) * 0.125;
  s += kgroup(e, f, h, i, w4) * 0.125;
  s /= (w0 * 0.5 + (w1 + w2 + w3 + w4) * 0.125);
  fragColor = vec4(knee(s), 1.0);
}
`;

export const DOWN_FS = `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uTexel;
vec3 tap(vec2 o) { return texture(uSrc, vUv + uTexel * o).rgb; }
void main() {
  vec3 a = tap(vec2(-2.0, 2.0)), b = tap(vec2(0.0, 2.0)), c = tap(vec2(2.0, 2.0));
  vec3 d = tap(vec2(-2.0, 0.0)), e = tap(vec2(0.0)), f = tap(vec2(2.0, 0.0));
  vec3 g = tap(vec2(-2.0, -2.0)), h = tap(vec2(0.0, -2.0)), i = tap(vec2(2.0, -2.0));
  vec3 j = tap(vec2(-1.0, 1.0)), k = tap(vec2(1.0, 1.0));
  vec3 l = tap(vec2(-1.0, -1.0)), m = tap(vec2(1.0, -1.0));
  vec3 s = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  fragColor = vec4(s, 1.0);
}
`;

// Added into the level above (the blend is ONE, ONE), so the top mip ends up
// holding every level's contribution: the long tail comes from the small mips,
// the tight core from the large ones.
export const UP_FS = `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uWeight;
void main() {
  vec2 r = uTexel * uRadius;
  vec3 s = texture(uSrc, vUv + vec2(-r.x, r.y)).rgb
    + texture(uSrc, vUv + vec2(0.0, r.y)).rgb * 2.0
    + texture(uSrc, vUv + vec2(r.x, r.y)).rgb
    + texture(uSrc, vUv + vec2(-r.x, 0.0)).rgb * 2.0
    + texture(uSrc, vUv).rgb * 4.0
    + texture(uSrc, vUv + vec2(r.x, 0.0)).rgb * 2.0
    + texture(uSrc, vUv + vec2(-r.x, -r.y)).rgb
    + texture(uSrc, vUv + vec2(0.0, -r.y)).rgb * 2.0
    + texture(uSrc, vUv + vec2(r.x, -r.y)).rgb;
  fragColor = vec4(s * (uWeight / 16.0), 1.0);
}
`;

// THE DISSOLVE between two worlds. A straight cross-fade of two busy pictures
// is a double exposure for a second and reads as a mistake. This one is a
// front: the incoming world opens from the middle outward along a
// noise-broken edge, and the edge itself carries a little of the incoming
// world's own light, so a change of genre looks like the new picture burning
// through the old one rather than like two slides overlapping.
export const DISSOLVE_FS = `${HEAD}
uniform sampler2D uA; // leaving
uniform sampler2D uB; // arriving
uniform float uT;     // 0..1
uniform float uSeed;
uniform float uAspect;
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1.0, 0.0)), f.x), mix(h12(i + vec2(0.0, 1.0)), h12(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec4 a = texture(uA, vUv);
  vec4 b = texture(uB, vUv);
  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
  float n = vn(q * 3.1 + uSeed) * 0.62 + vn(q * 7.3 - uSeed) * 0.38;
  float r = length(q) / (0.5 * length(vec2(uAspect, 1.0)));
  float k = n * 0.55 + r * 0.45;
  float t = uT * 1.34 - 0.17;
  float m = smoothstep(t - 0.09, t + 0.09, k);
  vec4 c = mix(b, a, m);
  float seam = exp(-pow((k - t) / 0.035, 2.0)) * sin(3.14159 * clamp(uT, 0.0, 1.0));
  c.rgb += b.rgb * seam * 1.6;
  fragColor = c;
}
`;

// The grade. Everything up to here is linear light; this is the one place it
// becomes a picture.
export const FINAL_FS = `${HEAD}${LUMA}
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec4 uPost;  // x exposure, y bloom strength, z chromatic fringe, w grain
uniform vec4 uPost2; // x time (s), y transparent output, z exposure lift, w saturation
uniform vec2 uCanvas;

// AgX, after Benjamin Wrensch's minimal fit (mean error^2 3.7e-6 against the
// reference LUT), with a "punchy" look: a touch more contrast and saturation
// than the neutral base, which suits emissive scenes on a dark field.
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 v) {
  const mat3 m = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                      0.0784335999999992, 0.878468636469772, 0.0784336,
                      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const float lo = -12.47393;
  const float hi = 4.026069;
  v = m * v;
  v = clamp(log2(max(v, vec3(1e-10))), lo, hi);
  v = (v - lo) / (hi - lo);
  return agxContrast(v);
}
// The look. AgX's base curve has a high toe — it is built for photographs, where
// the interesting detail lives around middle grey — and on light drawn over
// black that toe is a veil: a background of 0.005 linear came out as a 12% grey
// and every world looked washed out. The reference "punchy" power of 1.35 is
// what puts the blacks back where an emissive scene needs them, without
// touching the highlight roll-off AgX was chosen for.
vec3 agxLook(vec3 v, float satK) {
  float l = luma(v);
  v = pow(max(v, vec3(0.0)), vec3(1.35));
  return l + satK * (v - l);
}
vec3 agxOut(vec3 v) {
  const mat3 mi = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                       -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                       -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  return mi * v;
}
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

void main() {
  vec2 uv = vUv;
  vec4 s = texture(uScene, uv);
  vec3 col = s.rgb;
  if (uPost.z > 0.0) {
    // Radial and proportional to the distance from the centre, like a lens:
    // nothing at all in the middle, a hair at the corners.
    vec2 o = (uv - 0.5) * uPost.z;
    col.r = texture(uScene, uv - o).r;
    col.b = texture(uScene, uv + o).b;
  }
  vec3 bl = texture(uBloom, uv).rgb;
  col += bl * uPost.y;
  col *= uPost.x * (1.0 + uPost2.z);
  if (!(col.r < 6e4 && col.g < 6e4 && col.b < 6e4)) col = vec3(0.0);
  vec3 d = agxOut(agxLook(agx(max(col, vec3(0.0))), uPost2.w));
  d = clamp(d, 0.0, 1.0);
  // Grain: strongest in the mid-tones, where film has it and where a flat
  // fill is most visible; nearly none in the blacks, so they stay black.
  vec2 px = uv * uCanvas;
  float t = floor(uPost2.x * 24.0);
  float gn = h12(px + t * 17.13) - 0.5;
  float lum = luma(d);
  d += gn * uPost.w * (lum * (1.0 - lum) * 3.2 + 0.05);
  // Triangular dither, one code value wide: the banding in a dark gradient
  // is gone rather than hidden.
  float dn = h12(px * 1.03 + 3.7 + t) + h12(px * 0.97 - 9.1 - t) - 1.0;
  d += dn / 255.0;
  d = clamp(d, 0.0, 1.0);
  if (uPost2.y > 0.5) {
    // Transparent output (the spectrum strip, over the blurred cover): the
    // world's own coverage, plus its glow, premultiplied.
    float a = clamp(s.a + luma(bl * uPost.y) * 1.6, 0.0, 1.0);
    fragColor = vec4(d * a, a);
  } else {
    fragColor = vec4(d, 1.0);
  }
}
`;
