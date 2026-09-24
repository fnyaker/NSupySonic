// The GLSL every world is written against.
//
// One uniform BLOCK carries the whole musical state, the palette and the
// frame, and it is uploaded ONCE per frame (a single bufferSubData) however
// many programs read it — the outgoing world, the incoming one, their
// particles. Everything a world may know about the music is in here, and
// nothing that would let it cheat: there is deliberately NO wall-clock time in
// the block. A world's clocks are beats, bars and phrases, so the rule the old
// canvas scenes had to be policed into by a stopwatch test ("no constant that
// should be musical") is now a property of the interface. The one shader that
// needs seconds — the film grain — lives in the post pass, not in a world.
//
// THE LAYOUT IS DECLARED ONCE, HERE. `MUSIC_SLOTS` generates both the GLSL
// declaration and the float offsets the JS side packs into, so the two cannot
// drift apart — a std140 block whose writer and reader disagree by one vec4
// does not fail, it silently feeds every world the wrong numbers.
//
// Every slot is a vec4 (std140 pads anything smaller to one anyway), and each
// component is documented where it is declared.

export const MUSIC_SLOTS = [
  // x beats elapsed (continuous, extrapolated at draw time), y bars, z phrases,
  // w the beat's length in seconds (for the rare world that must convert).
  ["uClock", 1],
  // x beat phase 0..1, y bar phase, z phrase phase, w bpm / 100 (0 = no lock).
  ["uPhase", 1],
  // Envelopes, 1 on the event and decaying in BEATS — computed from the event's
  // time stamp at draw time, so they are smooth at any frame rate:
  // x any kick, y a MAIN kick (on the grid, not a roll note), z a big kick,
  // w a snare / clap on the backbeat.
  ["uHit", 1],
  // x hi-hat, y a melodic note attack, z a chord change, w FLASH — the one
  // envelope a world may turn into full-frame light, owned by the engine and
  // rate-limited for photosensitive safety (see renderer.js#flash).
  ["uHit2", 1],
  // x drive (how hard it pushes), y weight (low-end share), z air (brightness),
  // w tension (a build).
  ["uFlow", 1],
  // x calm, y level, z dynamics (this moment against the track's loud level),
  // w attack (a fast flash envelope on any onset).
  ["uMood", 1],
  // x dropped (1 at the drop, falling away), y build, z breakdown, w roll.
  ["uArc", 1],
  // The look vector (lib/audio/style.js LOOK_KEYS): motion, density, punch, smooth...
  ["uLookA", 1],
  // ...warm, melodic, chaos; w the roll's subdivision / 16.
  ["uLookB", 1],
  // Energy bands, each 0..1 as a SHARE of the total (re-scaled so a balanced mix
  // reads about 0.5): sub, bass, lowMid, mid...
  ["uBandA", 1],
  // ...high, air; z melody pitch 0..1, w melody strength.
  ["uBandB", 1],
  // The twelve pitch classes, 0..1.
  ["uChroma", 3],
  // Integer counters, as floats — a world hashes them for per-event variety that
  // is stable for the life of the event: x beat index, y bar index, z kick
  // count, w drop count.
  ["uCount", 1],
  // BEATS SINCE: x the last kick, y main kick, z snare, w drop. The raw form of
  // the envelopes above, for worlds that build their own shapes in time — a
  // shock front's radius is (since × speed), exact at any frame rate.
  ["uSince", 1],
  // THE GENRE CHANNEL (rhythm/src/genre.rs), 0..1 each: what only some genres
  // are made of, so a world can draw what its genre is about rather than what
  // every genre has. [0] x the sung LEAD, y the BUZZ (a saw stack, a kick so
  // distorted it is a tone — zaag, krach), z a SCREECH attack, w the SUB's
  // share of the power. [1] x the OFFBEAT's share of the groove, y onsets per
  // beat (DENSITY, a full reading at sixteenths), z how long the kick rings
  // (TAIL), w how noisy it is (GRIT).
  ["uGenre", 2],
  // The palette, in LINEAR light and luminance-normalised (so a pale sleeve and
  // a dark one expose the same). w carries the raw numbers: saturation,
  // lightness, hue / 360, spread / 360.
  ["uPalLow", 1],
  ["uPalMid", 1],
  ["uPalHigh", 1],
  // The complement of the base hue, for the one accent a composition needs.
  ["uPalAcc", 1],
  // A deep, desaturated shade of the base hue: what "black" is in this world.
  ["uPalBg", 1],
  // x width px, y height px, z aspect (w/h), w pixel size in p-space units.
  ["uFrame", 1],
  // The artwork in p-space (y up, the frame's short... see `fragP`): xy centre,
  // zw half extents. All zero when nothing is in front of the canvas.
  ["uHole", 1],
  // x corner radius (p), y how much of the frame the artwork takes (0..1),
  // z the top of the free band UNDER the artwork (p-space y), w unused.
  ["uHoleR", 1],
  // x intensity setting (amplitude of motion), y reduced motion (0/1),
  // z the transparent (strip) layout flag, w unused.
  ["uCtl", 1],
  // x steps factor (raymarch / octave budget of the tier), y particle factor,
  // z tier index 0..3, w render scale.
  ["uQual", 1],
];

/** Float offset of each slot in the packed block, and the block's size. */
export const MUSIC_OFFSET = {};
export let MUSIC_FLOATS = 0;
for (const [name, count] of MUSIC_SLOTS) {
  MUSIC_OFFSET[name] = MUSIC_FLOATS;
  MUSIC_FLOATS += 4 * count;
}

const BLOCK =
  "layout(std140) uniform Music {\n" +
  MUSIC_SLOTS.map(([n, c]) => `  vec4 ${n}${c > 1 ? `[${c}]` : ""};`).join("\n") +
  "\n};\n";

export const VERSION = "#version 300 es\n";
export const PRECISION =
  "precision highp float;\nprecision highp int;\nprecision highp sampler2D;\n";

// What every world program declares. Samplers are on FIXED units (see
// `SAMPLER_UNITS`), bound once per program at link time rather than looked up
// per frame.
export const WORLD_UNIFORMS = `${BLOCK}
uniform vec2 uRes;       // the target's size in pixels
uniform float uFade;     // this world's share of the crossfade, 0..1
uniform float uEnergy;   // skin energy x the track's dynamics gate
uniform float uSpeed;    // the skin's speed: a multiplier on the world's clocks
uniform vec4 uP0;        // the world's own parameters, packed by its module
uniform vec4 uP1;
uniform vec4 uP2;
uniform vec4 uP3;
uniform vec4 uEv[8];     // an event pool, packed by the world's driver
uniform vec4 uS0;        // driver state (springs, stepped rotations...)
uniform vec4 uS1;
uniform sampler2D uPrev;  // feedback: this world's previous frame
uniform sampler2D uSpec;  // row 0 smoothed bands, row 1 fast bands (128 wide)
uniform sampler2D uHist;  // spectrum history, one row per sixteenth note
uniform sampler2D uNoise; // 256x256 value noise, G = R offset for 3D lookups
uniform sampler2D uCover; // the artwork, when there is one
uniform float uHistHead;  // the newest history row, 0..1
uniform float uCoverOK;   // 1 once the artwork has been uploaded
uniform float uHeadroom;  // 1, or 1/4 on a device with no float targets
`;

export const SAMPLER_UNITS = { uPrev: 0, uSpec: 1, uHist: 2, uNoise: 3, uCover: 4 };

// --- the library -------------------------------------------------------------
//
// Chunks with explicit dependencies, pulled in per world. Not a size concern at
// run time (an unused function costs nothing once compiled) but a COMPILE-time
// one: on a phone the driver's front end is the slow part of a first switch to
// a new world, and handing it three hundred lines of noise it will never call
// is a measurable part of that stall.

const CHUNKS = {
  core: {
    deps: [],
    src: `
#define PI 3.14159265359
#define TAU 6.28318530718
float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 sat(vec3 x) { return clamp(x, 0.0, 1.0); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// The frame's half extents in p-space.
vec2 frameHalf() { return vec2(uFrame.z, 1.0); }
// Soft light falloff: 1 at d = 0, 1/2 at d = w. The shape every neon line and
// every point light in here is built from — it has the long tail real glow
// has, which exp() does not.
float glow(float d, float w) { return w * w / (w * w + d * d); }
// Hue (0..1 turns) to linear RGB at full saturation, for worlds that walk a
// rainbow rather than the palette.
vec3 hue2rgb(float h) {
  vec3 c = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return c * c * (3.0 - 2.0 * c);
}
// The palette, walked low -> mid -> high.
vec3 pal(float t) {
  t = clamp(t, 0.0, 1.0);
  return t < 0.5 ? mix(uPalLow.rgb, uPalMid.rgb, t * 2.0) : mix(uPalMid.rgb, uPalHigh.rgb, t * 2.0 - 1.0);
}
// An envelope in beats: 1 when the event lands, e^-1 after \`decay\` beats.
float envB(float since, float decay) { return since < 0.0 ? 0.0 : exp(-since / max(1e-3, decay)); }
`,
  },

  // Fragment stage only: gl_FragCoord does not exist in a vertex shader.
  fragpos: {
    deps: [],
    src: `
// Where this fragment is, in p-space: y runs -1..1 bottom to top, x runs
// -aspect..aspect, whatever the target's resolution. Everything a world places
// is placed in these units, so it lands in the same spot at every render scale.
vec2 fragP() { return (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * uRes.y); }
// Every world writes its colour through \`emit\`. Two reasons. A NaN or an Inf
// from one bad division would otherwise be kept FOR EVER by a feedback world
// (it reads its own last frame) and smeared across the frame by the bloom;
// comparisons against NaN are false, so the test below replaces it. And on a
// device with no float render targets the scene is stored divided by the
// headroom, so light above 1.0 survives the 8-bit target.
vec3 finite(vec3 c) { return (c.r < 6e4 && c.g < 6e4 && c.b < 6e4) ? max(c, vec3(0.0)) : vec3(0.0); }
void emit(vec3 c) { fragColor = vec4(finite(c) * uHeadroom, 1.0); }
void emitA(vec3 c, float a) { fragColor = vec4(finite(c) * uHeadroom, clamp(a, 0.0, 1.0)); }
// A feedback world's previous frame, in the same units it was written in.
vec3 prev(vec2 uv) { return texture(uPrev, uv).rgb / uHeadroom; }
vec4 prevA(vec2 uv) { vec4 c = texture(uPrev, uv); return vec4(c.rgb / uHeadroom, c.a); }
`,
  },

  frame: {
    deps: ["core"],
    src: `
// Signed distance to the artwork (a rounded rectangle), in p-space. Hugely
// positive when there is no artwork, so "far from the cover" is simply true.
float holeSd(vec2 p) {
  if (uHole.z <= 0.0) return 1e3;
  vec2 d = abs(p - uHole.xy) - uHole.zw + uHoleR.x;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - uHoleR.x;
}
// Distance from the centre to the frame's edge along the unit direction \`dir\`.
float frameEdge(vec2 dir) {
  vec2 t = frameHalf() / max(abs(dir), vec2(1e-5));
  return min(t.x, t.y);
}
// ...and to the artwork's rim, 0 when there is none.
float holeEdge(vec2 dir) {
  if (uHole.z <= 0.0) return 0.0;
  vec2 t = uHole.zw / max(abs(dir), vec2(1e-5));
  return min(t.x, t.y);
}
// The frame's own polar mapping (the GLSL twin of geometry.js#place): 0 on the
// artwork's rim (or the centre), 1 on the frame's edge ALONG THIS ANGLE. So a
// ring at radial 1 traces the screen rather than a circle inscribed in it, and
// radial 0 hugs the cover — which is how a world fills a 16:9 beamer and
// frames the artwork on a phone with the same code.
float radial01(vec2 p) {
  float r = length(p);
  vec2 dir = p / max(r, 1e-5);
  float a = holeEdge(dir);
  float b = frameEdge(dir);
  return (r - a) / max(b - a, 1e-4);
}
// A RING coordinate, for anything that expands: 0 on the artwork's rim (or the
// centre), 1 through the frame's corners, along ELLIPSES that lean part of the
// way toward the frame's aspect. Fully frame-shaped (radial01) a ring is a
// rectangle, which reads as a box rather than as a wave; fully circular it
// never reaches the sides of a 16:9 screen while it is still bright. 0.45 of
// the aspect is the old canvas engine's measured answer (geometry.js
// RING_ANISO), kept because it is right.
float ringCoord(vec2 p) {
  vec2 s = vec2(mix(1.0, uFrame.z, 0.45), 1.0);
  float e = length((p - uHole.xy) / s);
  float corner = length(frameHalf() / s);
  float rim = uHole.z > 0.0 ? length(uHole.zw / s) * 0.86 : 0.0;
  return (e - rim) / max(corner - rim, 1e-3);
}
// How visible this point is: 0 inside the artwork, 1 clear of it. A world
// multiplies its HERO material by this so its best light never sits where
// nobody can see it; ambience is allowed to run under the cover.
float clearOfHole(vec2 p, float soft) { return smoothstep(0.0, soft, holeSd(p)); }
`,
  },

  hash: {
    deps: [],
    src: `
// Dave Hoskins' "hash without sine": the same answer on every GPU, which the
// classic fract(sin(x) * 43758.5) is not — on some mobile parts its precision
// collapses and a star field becomes stripes.
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash21(float p) { vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash31(float p) { vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
vec3 hash32(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
`,
  },

  noise: {
    deps: ["hash"],
    src: `
// Gradient noise with a quintic fade (no grid artefacts in the derivative,
// which is what shows as creases once it is lit). Range about -0.7..0.7.
float gnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 ga = hash22(i) * 2.0 - 1.0;
  vec2 gb = hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0;
  vec2 gc = hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0;
  vec2 gd = hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0;
  float a = dot(ga, f);
  float b = dot(gb, f - vec2(1.0, 0.0));
  float c = dot(gc, f - vec2(0.0, 1.0));
  float d = dot(gd, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Fractal sum, each octave rotated so the lattice never lines up with itself.
float fbm(vec2 p, int oct) {
  float s = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * gnoise(p);
    p = m * p;
    a *= 0.5;
  }
  return s;
}
`,
  },

  noise3: {
    deps: [],
    src: `
// 3D value noise from ONE texture fetch: the noise texture's G channel is its
// R channel offset by (37, 17), so a z-slice step is a 2D offset (the
// technique from Inigo Quilez's volumetric work). Eight hash evaluations per
// sample would make a volumetric world unaffordable on a phone; this is one
// bilinear lookup. Range 0..1.
float noise3(vec3 x) {
  vec3 p = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec2 uv = (p.xy + vec2(37.0, 17.0) * p.z) + f.xy;
  vec2 rg = textureLod(uNoise, (uv + 0.5) / 256.0, 0.0).yx;
  return mix(rg.x, rg.y, f.z);
}
float fbm3(vec3 p, int oct) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    s += a * noise3(p);
    p = p * 2.02 + vec3(0.13, -0.27, 0.41);
    a *= 0.5;
  }
  return s;
}
// 2D value noise from the same texture: cheap enough to call per step.
float noiseT(vec2 x) { return textureLod(uNoise, (x + 0.5) / 256.0, 0.0).x; }
`,
  },

  simplex: {
    deps: [],
    src: `
// Simplex noise (Ashima Arts / Stefan Gustavson, MIT). The 3D form is the
// isotropic one the flow and curl fields need; value noise has a visible grid
// once it is advected.
vec3 _m289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _m289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _perm(vec4 x) { return _m289(((x * 34.0) + 10.0) * x); }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = _m289(i);
  vec4 p = _perm(_perm(_perm(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = 1.79284291400159 - 0.85373472095314 * vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`,
  },

  voronoi: {
    deps: ["hash"],
    src: `
// Voronoi with the TRUE distance to the cell border (two passes, after Inigo
// Quilez), which is what a crack or a leaded edge has to be drawn from — the
// usual F2 - F1 bulges at the corners and the cracks come out lumpy.
// Returns x: distance to the border, y: the cell's id hash, z: distance to its
// centre; \`o\` gets the cell's integer coordinate.
vec3 voronoi(vec2 x, float jitter, out vec2 cell) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  vec2 mg = vec2(0.0);
  vec2 mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(n + g) * jitter + 0.5 * (1.0 - jitter);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; }
    }
  md = 8.0;
  for (int j = -2; j <= 2; j++)
    for (int i = -2; i <= 2; i++) {
      vec2 g = mg + vec2(float(i), float(j));
      vec2 o = hash22(n + g) * jitter + 0.5 * (1.0 - jitter);
      vec2 r = g + o - f;
      if (dot(mr - r, mr - r) > 1e-5) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
    }
  cell = n + mg;
  return vec3(md, hash12(n + mg), length(mr));
}
`,
  },

  caustic: {
    deps: ["noise"],
    src: `
// Animated cellular noise: the distances to the nearest and second-nearest of
// cells whose feature points orbit their centres. F2 - F1 is small exactly on
// the borders between cells, which is the network every caustic is made of.
vec2 cellF12(vec2 x, float t) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 h = hash22(n + g);
      vec2 o = 0.5 + 0.42 * sin(t * (0.6 + 0.8 * h) + TAU * h);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
  return sqrt(vec2(f1, f2));
}
// Light focused by a moving surface onto a floor: two nets of cell borders at
// different scales, warped so their straight edges become the curved
// filaments real caustics are, and brightest where the two nets cross.
float caustics(vec2 uv, float t) {
  uv += 0.16 * vec2(gnoise(uv * 1.3 + t * 0.2), gnoise(uv * 1.3 - t * 0.2 + 7.1));
  vec2 a = cellF12(uv * 2.0, t);
  vec2 b = cellF12(uv * 3.3 + 3.7, t * 1.3);
  float la = exp(-(a.y - a.x) * 9.0);
  float lb = exp(-(b.y - b.x) * 11.0);
  return la * 0.6 + lb * 0.4 + la * lb * 1.4;
}
`,
  },

  sdf: {
    deps: ["core"],
    src: `
float sdBox(vec3 p, vec3 b) { vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0); }
float sdBox2(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdRound2(vec2 p, vec2 b, float r) { return sdBox2(p, b - r) - r; }
float sdSeg2(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float sdSeg(vec3 p, vec3 a, vec3 b) { vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float sdTorus(vec3 p, vec2 t) { vec2 q = vec2(length(p.xz) - t.x, p.y); return length(q) - t.y; }
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
// Polar fold: map p into one of \`n\` sectors, mirrored, so anything drawn in
// the first sector is drawn in all of them. The kaleidoscope primitive.
vec2 foldSector(vec2 p, float n) {
  float a = atan(p.y, p.x);
  float s = TAU / n;
  a = mod(a + s * 0.5, s) - s * 0.5;
  a = abs(a);
  return vec2(cos(a), sin(a)) * length(p);
}
`,
  },

  // A person in a crowd, seen from behind, for the worlds that put you in one
  // (lasers, stage). In units of the head's radius with the head's centre at
  // the origin: head, neck, shoulders and a back that runs out of the frame,
  // and two arms that rise from hanging (0) to straight up (1) through a bent
  // elbow — the way an arm actually goes up, passing out to the side, rather
  // than a stick rotating about the shoulder.
  crowd: {
    deps: ["sdf"],
    src: `
vec2 crowdElbow(float sg, float r) { return vec2(1.55 * sg, -2.1) + vec2(0.75 * sg, mix(-2.5, 2.3, r)); }
vec2 crowdHand(float sg, float r, float lean) { return crowdElbow(sg, r) + vec2(-0.35 * sg + lean, mix(-2.2, 2.4, r)); }
float crowdPerson(vec2 q, float rL, float rR, float lean) {
  float d = length(q * vec2(1.0, 0.9)) - 1.0;
  d = smin(d, sdBox2(q - vec2(0.0, -1.35), vec2(0.5, 0.5)), 0.3);
  float sh = sdRound2(q - vec2(0.0, -2.6), vec2(2.05, 1.0), 0.9);
  float back = sdBox2(q - vec2(0.0, -9.0), vec2(1.9, 6.0));
  d = smin(d, min(sh, back), 0.35);
  for (int k = 0; k < 2; k++) {
    float sg = k == 0 ? -1.0 : 1.0;
    float r = k == 0 ? rL : rR;
    if (r < 0.02) continue;
    vec2 S = vec2(1.55 * sg, -2.1);
    vec2 E = crowdElbow(sg, r);
    vec2 H = crowdHand(sg, r, lean);
    d = min(d, sdSeg2(q, S, E) - 0.45);
    d = min(d, sdSeg2(q, E, H) - 0.37);
    d = min(d, length(q - H) - 0.52);
  }
  return d;
}
`,
  },
};

function collect(names, out, seen) {
  for (const n of names) {
    if (seen.has(n)) continue;
    const c = CHUNKS[n];
    if (!c) throw new Error(`unknown GLSL chunk "${n}"`);
    seen.add(n);
    collect(c.deps, out, seen);
    out.push(c.src);
  }
}

/**
 * The library chunks a world asked for, with their dependencies, in order.
 * `stage` is "fs" or "vs": the fragment stage also gets `fragP`, which reads
 * gl_FragCoord and would not compile in a vertex shader.
 */
export function library(names = [], stage = "fs") {
  const out = [];
  const base = stage === "fs" ? ["core", "fragpos", "frame", "hash"] : ["core", "frame", "hash"];
  collect([...base, ...names], out, new Set());
  return out.join("\n");
}

/**
 * A complete fragment shader for a world: header, library, the world's
 * parameter names (`defines`), then its body — numbered from line 1, so a
 * compile error points at the world's own source.
 */
export function worldFragment(body, uses = [], defines = "") {
  return (
    VERSION +
    PRECISION +
    WORLD_UNIFORMS +
    "in vec2 vUv;\nout vec4 fragColor;\n" +
    library(uses) +
    defines +
    "\n#line 1\n" +
    body
  );
}

// The full-screen triangle: three vertices, no attribute buffer at all. Every
// world and every post pass is drawn with it.
export const FULLSCREEN_VS = `${VERSION}
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Instanced sprites for the worlds that want particles. The world supplies
// \`void particle(int id, out vec2 pos, out vec2 axis, out float width,
// out vec4 col, out float kind)\` — a STATELESS function of its index and the
// music, so thousands of them cost nothing on the CPU and nothing to upload —
// and \`vec4 sprite(vec2 q, vec4 col, float kind)\` for the shape. \`axis\` is the
// quad's long half-axis in p-space (a streak points along it), \`width\` its
// half-width; a particle with col.a <= 0 is culled to a degenerate quad.
export function particleVertex(body, uses = [], defines = "") {
  return (
    VERSION +
    PRECISION +
    WORLD_UNIFORMS +
    "out vec2 vQ;\nout vec4 vC;\nout float vK;\n" +
    library(uses, "vs") +
    defines +
    "\n#line 1\n" +
    body +
    `
void main() {
  vec2 corners[6] = vec2[6](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
                            vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0));
  vec2 q = corners[gl_VertexID % 6];
  vec2 pos;
  vec2 axis;
  float width;
  vec4 col;
  float kind;
  particle(gl_InstanceID, pos, axis, width, col, kind);
  vQ = q;
  vC = col;
  vK = kind;
  if (col.a <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 along = axis;
  float len = length(along);
  vec2 dir = len > 1e-6 ? along / len : vec2(1.0, 0.0);
  vec2 side = vec2(-dir.y, dir.x) * width;
  vec2 at = pos + dir * len * q.x + side * q.y;
  gl_Position = vec4(at.x / uFrame.z, at.y, 0.0, 1.0);
}
`
  );
}

export function particleFragment(body, uses = [], defines = "") {
  return (
    VERSION +
    PRECISION +
    WORLD_UNIFORMS +
    "in vec2 vQ;\nin vec4 vC;\nin float vK;\nout vec4 fragColor;\n" +
    library(uses) +
    defines +
    "\n#line 1\n" +
    body +
    `
void main() {
  vec4 c = sprite(vQ, vC, vK);
  vec3 o = (c.r < 6e4 && c.g < 6e4 && c.b < 6e4) ? max(c.rgb, vec3(0.0)) : vec3(0.0);
  fragColor = vec4(o * uHeadroom, 0.0);
}
`
  );
}
