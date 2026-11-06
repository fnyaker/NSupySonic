// ÉCLATS — a pane of glass in front of a hardcore stage, and the kick that
// breaks it.
//
// The old picture was a fracture TAXONOMY: an even Voronoi mosaic, then a
// perfectly centred radial web with rings at every radius. Everything was
// legible and nothing was a picture: a dreamcatcher drawn in grey, with the
// stage somewhere behind the smoke and a bright dot where the impact was.
//
// This is a PLACE first. A dark hall, a line of vertical LED tubes on the back
// wall, a truss with moving heads throwing beams through the haze, a row of
// strobe heads behind the crowd, a stack at each wing and the crowd's
// shoulders along the bottom. That is what the glass has to be worth looking
// through, and it is why the shards read as glass at all: each one carries a DIFFERENT part of the room, shifted and magnified by
// its own tilt, with red and blue split by the amount that piece would
// disperse — no fringe at rest, more as the piece is thrown.
//
// THE BREAK IS STRUCK, NOT GROWN. Radial cracks are few, unevenly spaced and
// gently curved; concentric cracks are short chords that span one sector and
// stop at a radial crack, never rings round the whole picture. The chords are
// present near the impact and sparse far out, so the shards are powder at the
// centre, long splinters in the middle and great slabs at the edge. The impact
// sits at the edge of the artwork (or off-centre on a beamer) and is the one
// point every crack runs from, so there is no symmetric centre to the web.
//
// ON A MAIN KICK the pane jolts and every shard is thrown outward and toward
// the camera: its silhouette MOVES (the shader tests the pixel in the shard's
// own rest frame), the gaps open and the room comes through untinted, and a
// short camera shake moves the room behind. On a drop the whole pane blows
// toward the viewer and settles again inside a bar. The striker moves each
// bar, chosen at the bar — never jittered per frame — and the driver asks the
// engine for the flash; the engine owns the rate limit and the user's policy.
//
// House rules this one is built around: the material is SHAPE (thickness,
// tint, one broad travelling reflection, a lit fracture edge) rather than a
// 2000s glass rim; there is no fringe at rest; every clock is beats; and
// everything is placed in p-space so a 16:9 beamer is filled and the phone's
// cover sits in a free band of the fracture, not on top of it.
//
// Parameters:
//   shards  crack density: few long slabs (gabber) to a crushed star (speedcore)
//   jag     how far the pieces are thrown and how wide the gaps open
//   spin    how far a piece turns on the hit
//   flash   how much of the engine's flash the venue shows
//   burst   the drop's blow-apart
//   leds    how many tubes and moving heads the stage has

import { onStamp, hashN } from "./kit.js";

// The fracture, kept in one place so the geometry is one function:
//   R0  the radius where the powder ends and the first chord can sit
//   G   the growth of the ring lattice; set by the driver from `shards`
const R0 = 0.068;

export default {
  id: "shatter",
  uses: ["noise"],
  params: { shards: 1, jag: 1, spin: 1, flash: 0.5, burst: 1, leds: 1 },
  look: { exposure: 1.10, bloom: 1.32, threshold: 0.78, saturation: 1.12 },

  fragment: `
// A signed angle difference in the range minus PI..PI.
float wrapA(float x) { return mod(x + PI, TAU) - PI; }

// How fast the chord lattice grows. Set from the skin at the top of main;
// G = 1.62 is only the value between a program link and the first frame.
float G = 1.62;
// One radial crack: its angle at radius r. The base angles are unevenly
// spaced (that alone kills the mandala), the crack leans as it runs out, and
// both are fixed for the life of the strike.
float spokeA(float k, float r, float n, float seed) {
  float h = hash11(k * 1.713 + seed * 13.17);
  float h2 = fract(h * 17.13 + 0.317);
  float base = -PI + (k + 0.5) * TAU / n;
  // A kink every half unit, small enough to bend the line without turning it
  // into a staircase; real cracks change direction a handful of times.
  float kink = (fract(r * 2.0 + h * 7.0) - 0.5) * 0.025;
  return base + (h - 0.5) * 0.70 * TAU / n + (h2 - 0.5) * 0.20 * r + kink;
}

// The radius of a chord at level j in the sector between spokes kLo and kHi.
// The jitter is per sector, so no two chords are at the same distance from the
// impact — the thing that turns a ring into a broken polygon.
float ringR(float k, float j, float seed) {
  float h = hash12(vec2(k * 1.37 + seed * 5.1, j * 1.11 + 3.7));
  float jit = mix(0.95, 0.70, smoothstep(0.0, 6.0, j));
  return ${R0.toFixed(3)} * pow(G, j + (h - 0.5) * jit);
}

// A chord is a STRAIGHT piece of glass across one sector, between its two
// radial cracks. Its two ends sit at their own radii, so it is never a circle
// arc; that is the whole difference between a fracture and a spiderweb.
struct Chord {
  vec2 e0;
  vec2 e1;
  vec2 nOut; // unit normal from the impact to the chord's midpoint
  float len;
};
Chord makeChord(vec2 O, float kLo, float kHi, float j, float n, float seed) {
  Chord c;
  float r0 = ringR(kLo, j, seed);
  float r1 = ringR(kHi, j, seed);
  float a0 = spokeA(kLo, r0, n, seed);
  float a1 = spokeA(kHi, r1, n, seed);
  c.e0 = O + vec2(cos(a0), sin(a0)) * r0;
  c.e1 = O + vec2(cos(a1), sin(a1)) * r1;
  c.len = length(c.e1 - c.e0);
  vec2 m = 0.5 * (c.e0 + c.e1) - O;
  c.nOut = length(m) > 1e-4 ? normalize(m) : vec2(0.0);
  return c;
}
float chordT(vec2 p, Chord c) {
  vec2 ax = c.e1 - c.e0;
  return clamp(dot(p - c.e0, ax) / max(dot(ax, ax), 1e-6), 0.0, 1.0);
}

// Not every chord in every sector exists. Most do near the impact; further
// out whole chords are missing, so the shards grow into the long slabs an
// edge of broken glass has. A ring is never complete: each sector's chord is
// its own segment, at its own radius.
float chordOn(float kLo, float kHi, float j, float seed, float n) {
  float h = hash12(vec2(kLo * 3.1 + kHi * 7.7 + seed * 2.3, j * 5.3 + 1.0));
  float p = mix(0.72, 0.020, smoothstep(0.0, 4.0, j));
  return h < p ? 1.0 : 0.0;
}

// A chord is not a ring segment: it stops short of at least one radial crack,
// and the next sector's chord starts somewhere else. Its WORLD length is also
// capped, so a chord in a very wide sector does not become a half-screen arc.
float chordSpan(float t, float len, float kLo, float kHi, float j, float seed) {
  float h = hash12(vec2(kLo * 4.3 + kHi * 1.7 + seed * 3.9, j * 7.1 + 2.0));
  float mid = 0.35 + 0.30 * h;
  float maxDt = clamp(0.45 / max(len, 1e-3), 0.10, 0.85);
  float t0 = clamp(mid - 0.5 * maxDt, 0.01, 0.99);
  float t1 = clamp(mid + 0.5 * maxDt, 0.01, 0.99);
  return smoothstep(t0 - 0.04, t0 + 0.04, t)
       * smoothstep(t1 + 0.04, t1 - 0.04, t);
}

struct Crack {
  float edge;    // distance (p) to the nearest crack that separates shards
  float edgeRad; // ...split into the radial part
  float edgeChord; // ...and the chord part
  float chordVis;  // how much of that chord is actually drawn along its span
  float surface; // distance to the nearest short crack INSIDE a shard
  float kLo;     // the long radial crack clockwise of this pixel
  float kHi;     // ...and the one counter-clockwise
  float jLo;     // the chord inside this shard, -1 when there is none
  float jHi;     // the chord outside it, 99 when there is none
  vec2 eLo0;     // the inner chord's endpoints, in the pane's rest space
  vec2 eLo1;
  vec2 eHi0;
  vec2 eHi1;
  vec2 nLo;      // ...and its outward normals
  vec2 nHi;
  float tLo;     // where p projects onto each chord, for the span mask
  float tHi;
  float midR;    // a point inside the shard, for its throw and turn
  float midA;
  float r;
  float a;
  float t;       // where the pixel sits across its sector, 0..1
};

// Which shard is at p, in the pane's REST state. A shard is bounded by the
// LONG radial cracks — the five to nine that run out to the frame — and by
// straight chord segments. The other spokes are short cracks round the
// impact: they are drawn as surface damage and do not split a shard, which is
// what keeps the picture from turning into a twenty-ray spiderweb while the
// strike is still visibly crushed.
Crack crackAt(vec2 p, vec2 O, float n, float seed) {
  Crack c;
  vec2 d = p - O;
  c.r = max(length(d), 1e-4);
  c.a = atan(d.y, d.x);
  float up = 99.0;
  float dn = -99.0;
  c.kLo = 0.0;
  c.kHi = 0.0;
  c.surface = 99.0;
  for (int i = 0; i < 32; i++) {
    if (float(i) >= n) break;
    float k = float(i);
    float hlong = hash11(k * 3.71 + seed * 9.23);
    float isLong = step(0.54, hlong);
    float reach = mix(0.10, 0.54, hash11(k * 7.13 + seed * 3.31));
    if (isLong < 0.5 && c.r > reach) continue;
    float da = wrapA(c.a - spokeA(k, c.r, n, seed));
    if (isLong > 0.5) {
      if (da >= 0.0) {
        if (da < up) { up = da; c.kLo = k; }
      } else if (da > dn) {
        dn = da; c.kHi = k;
      }
    } else {
      float live = 1.0 - smoothstep(reach * 0.55, reach, c.r);
      c.surface = min(c.surface, abs(da) * c.r + (1.0 - live) * 1.0);
    }
  }
  // The fallbacks matter only if a strike lands exactly on a spoke or a run
  // of short cracks leaves a side with no long one; keeping them here means
  // the loop can never leave a cell with no boundary.
  if (up > 90.0) { up = TAU; c.kHi = c.kLo; }
  if (dn < -90.0) { dn = -TAU; c.kLo = c.kHi; }
  c.edgeRad = min(up, -dn) * c.r;

  float aLo = spokeA(c.kLo, c.r, n, seed);
  float aHi = spokeA(c.kHi, c.r, n, seed);
  // The cell can span more than PI when a run of short cracks leaves two
  // long ones far apart. Wrapping the difference would then flip sign on the
  // far side of the shard and open it as a gap; measure the CCW arc instead.
  float dLo = mod(c.a - aLo + TAU, TAU);
  float dHi = mod(aHi - c.a + TAU, TAU);
  float span = max(dLo + dHi, 1e-4);
  c.t = clamp(dLo / span, 0.0, 1.0);
  c.midA = wrapA(aLo + 0.5 * span);

  c.jLo = -1.0;
  c.jHi = 99.0;
  c.eLo0 = vec2(0.0);
  c.eLo1 = vec2(0.0);
  c.eHi0 = vec2(0.0);
  c.eHi1 = vec2(0.0);
  c.nLo = vec2(0.0);
  c.nHi = vec2(0.0);
  c.tLo = 0.0;
  c.tHi = 0.0;
  float sLo = 1000.0;
  float sHi = 1000.0;
  float j0 = max(0.0, floor(log(c.r / ${R0.toFixed(3)}) / log(G)));
  // The jitter is nearly half a lattice step, so the chord at j0 can be on
  // either side of this pixel: search three levels each way, not one. The
  // test is against the CHORD LINE, not a radius, so a straight chord stays
  // straight all the way to its ends.
  for (int q = 0; q < 3; q++) {
    float j = j0 - float(q);
    if (j < 0.0) break;
    if (chordOn(c.kLo, c.kHi, j, seed, n) < 0.5) continue;
    Chord ch = makeChord(O, c.kLo, c.kHi, j, n, seed);
    float side = dot(p - 0.5 * (ch.e0 + ch.e1), ch.nOut);
    if (side > 0.0) {
      c.jLo = j;
      sLo = side;
      c.eLo0 = ch.e0;
      c.eLo1 = ch.e1;
      c.nLo = ch.nOut;
      c.tLo = chordT(p, ch);
      break;
    }
  }
  for (int q = 0; q < 3; q++) {
    float j = j0 + float(q);
    if (chordOn(c.kLo, c.kHi, j, seed, n) < 0.5) continue;
    Chord ch = makeChord(O, c.kLo, c.kHi, j, n, seed);
    float side = dot(p - 0.5 * (ch.e0 + ch.e1), ch.nOut);
    if (side < 0.0) {
      c.jHi = j;
      sHi = -side;
      c.eHi0 = ch.e0;
      c.eHi1 = ch.e1;
      c.nHi = ch.nOut;
      c.tHi = chordT(p, ch);
      break;
    }
  }
  if (c.jLo < 0.0) sLo = c.r; // no inner chord: the piece reaches the impact
  c.edgeChord = min(sLo, sHi);
  c.edge = min(c.edgeRad, c.edgeChord);
  float visLo = c.jLo >= 0.0 ? chordSpan(c.tLo, length(c.eLo1 - c.eLo0), c.kLo, c.kHi, c.jLo, seed) : 0.0;
  float visHi = c.jHi < 90.0 ? chordSpan(c.tHi, length(c.eHi1 - c.eHi0), c.kLo, c.kHi, c.jHi, seed) : 0.0;
  c.chordVis = (c.jLo >= 0.0 && (c.jHi >= 90.0 || sLo < sHi)) ? visLo : visHi;
  float rIn = c.jLo >= 0.0 ? length(0.5 * (c.eLo0 + c.eLo1) - O) : 0.0;
  float rOut = c.jHi < 90.0 ? length(0.5 * (c.eHi0 + c.eHi1) - O) : min(c.r + 0.32, 2.6);
  c.midR = clamp(0.5 * (rIn + rOut), 0.0, 2.6);
  return c;
}

// The one identity of a shard: stable for the life of the strike, and
// different on both sides of every LONG radial crack. Chords only add a
// little thickness and gloss variation, so a chord that stops short does not
// leave a hard seam across the glass.
float shardId(Crack c, float seed) {
  return hash12(vec2(c.kLo * 1.71 + c.kHi * 0.37 + seed * 11.3, seed * 3.7 + 1.0));
}
float ringHue(Crack c, float seed) {
  return hash12(vec2(c.jLo * 3.1 + c.jHi * 1.7 + seed * 5.0, c.kLo * 0.7 + c.kHi));
}

// Where the pane is struck. On the player it is the edge of the artwork — the
// band under a portrait cover, the flank of a landscape one — so no hero light
// is wasted behind the cover. On a beamer it is the driver's off-centre pick.
vec2 impact() {
  if (uHole.z > 0.0) {
    float side = uS0.x >= 0.0 ? 1.0 : -1.0;
    if (uFrame.z < 0.85) {
      return vec2(uHole.x + side * uHole.z * 0.62,
                  uHole.y - uHole.w - 0.045 + 0.018 * sin(uS0.z));
    }
    return vec2(uHole.x + side * (uHole.z + 0.06), clamp(uS0.y, -0.52, 0.52));
  }
  return vec2(uS0.x * uFrame.z, uS0.y);
}

// A dark hall with the stage in it. Deliberately cheap: it is called twice
// for the dispersion, so the haze is computed once in main and passed.
vec3 venue(vec2 q, float haze, float punch, float drop, float flashL) {
  float A = uFrame.z;
  float beats = uClock.x * uSpeed * mix(1.0, 0.35, uCtl.y);
  float y = q.y;
  vec3 col = uPalBg.rgb * 0.042;
  col += mix(uPalLow.rgb, uPalMid.rgb, 0.5) * haze * 0.038 * (0.55 + punch);
  col += uPalBg.rgb * 0.016 * smoothstep(-1.0, 0.85, y);
  // A little air even in a breakdown: the venue and the fracture edges have
  // to stay legible when the drums stop.
  col += mix(uPalLow.rgb, uPalHigh.rgb, 0.30) * 0.024
       * smoothstep(0.90, -0.20, y) * (0.4 + 0.6 * haze);

  // --- the back wall: vertical LED tubes ---------------------------------
  float nBar = clamp(3.0 + 2.0 * P_LEDS, 3.0, 5.0);
  for (int i = 0; i < 5; i++) {
    if (float(i) >= nBar) break;
    float fi = float(i);
    float xb = ((fi + 0.5) / nBar * 2.0 - 1.0) * (A * 0.78)
             + (hash11(fi * 4.7 + uS0.z) - 0.5) * 0.05;
    float w = 0.006 + 0.012 * hash11(fi * 2.3 + 1.7);
    float flick = 0.70 + 0.30 * sin(beats * PI * 0.5 + fi * 1.9);
    float gain = 0.18 + 0.82 * hash11(fi * 5.3 + 7.0);
    float colMask = smoothstep(-0.55, -0.05, y) * smoothstep(0.92, 0.40, y);
    float bar = exp(-pow((q.x - xb) / w, 2.0)) * colMask;
    float coreBar = exp(-pow((q.x - xb) / (w * 0.45), 2.0)) * colMask;
    vec3 bc = pal(fract(0.10 + fi * 0.17 + 0.07 * sin(beats * 0.07 + fi)));
    bc = mix(bc, uPalAcc.rgb, 0.10 + 0.18 * hash11(fi * 3.1 + 2.0));
    float barLight = (0.30 + 0.36 * uFlow.x + 0.48 * punch) * flick * gain
                   * (1.0 + 0.50 * uArc.z);
    col += bc * (bar * 0.80 + coreBar * 0.55) * barLight;
    // The tube itself is a hairline; the light it throws into the haze is a
    // broad column. Without the column the room read as a flat gradient.
    col += bc * glow(q.x - xb, 0.075) * colMask * barLight * 0.22;
  }

  // --- the strobe row ----------------------------------------------------
  // Discrete heads, not a tube: a line refracted through the shards reads as
  // one more ring, while a row of points scatters into glints across the
  // pieces and still lights the crowd from behind.
  vec2 pc = vec2(0.0, -0.48);
  float nLamp = 5.0;
  vec3 pcol = mix(vec3(0.92, 0.96, 1.0), uPalHigh.rgb, 0.06);
  float pl = (0.22 + 0.78 * punch + 1.05 * uHit.y + 1.05 * flashL) * P_LEDS;
  for (int i = 0; i < 7; i++) {
    if (float(i) >= nLamp) break;
    float fi = float(i);
    float xl = ((fi + 0.5) / nLamp * 2.0 - 1.0) * (A * 0.38);
    vec2 ld = q - vec2(xl, pc.y);
    float lr = length(ld);
    float disc = smoothstep(0.028, 0.020, lr);
    float halo = glow(lr, 0.085);
    float gain = 0.75 + 0.35 * hash11(fi * 3.1 + 2.0);
    col += pcol * (disc + halo * 0.22) * pl * gain;
  }

  // --- the truss ---------------------------------------------------------
  float truss = smoothstep(0.024, 0.0, abs(y - 0.94) - 0.026);
  float lattice = step(0.55, fract(q.x * 18.0 + (y - 0.94) * 22.0));
  col = mix(col, uPalBg.rgb * 0.012 + uPalMid.rgb * 0.016 * lattice, truss * 0.85);

  // --- the moving heads, in the haze ------------------------------------
  float nBeam = clamp(2.0 + 2.0 * P_LEDS, 2.0, 4.0);
  float quiet = smoothstep(0.45, 0.65, uArc.z);
  for (int i = 0; i < 4; i++) {
    if (float(i) >= nBeam) break;
    float fi = float(i);
    vec2 src = vec2(((fi + 0.5) / nBeam * 2.0 - 1.0) * (A * 0.80)
                    + 0.05 * sin(beats * 0.10 + fi), 0.93);
    float ang = mix(-0.52, 0.52, (fi + 0.5) / nBeam)
              + 0.26 * sin(beats * 0.18 + fi * 1.7)
              + 0.07 * (hash11(fi * 8.1 + 4.0) - 0.5);
    vec2 dir = vec2(sin(ang), -cos(ang));
    vec2 d = q - src;
    float along = dot(d, dir);
    if (along < 0.0) continue;
    float across = abs(d.x * dir.y - d.y * dir.x);
    float width = 0.010 + along * 0.075;
    float beam = exp(-pow(across / width, 2.0)) * exp(-along * 0.24);
    float core = exp(-pow(across / (width * 0.38), 2.0)) * exp(-along * 0.18);
    vec3 bc = mix(pal(fract(0.24 + fi * 0.19)), uPalAcc.rgb, 0.15);
    bc = mix(bc, vec3(1.0), 0.25 * hash11(fi * 4.4 + 3.0));
    float on = 0.55 + 0.45 * uFlow.x;
    if (quiet > 0.5) on = i == 0 ? 2.6 : 0.0;
    col += bc * (beam * 0.72 + core * 0.34) * haze * punch * on;
    col += mix(bc, vec3(1.0), 0.6) * core * haze * punch * 0.16;
    col += mix(bc, vec3(1.0), 0.5) * glow(length(q - src), 0.016) * punch * 0.40;
  }

  // --- the strobe: the engine's own envelope -----------------------------
  col += mix(uPalHigh.rgb, vec3(1.0), 0.75) * flashL * 0.07;
  col += mix(uPalHigh.rgb, vec3(1.0), 0.90)
       * glow(length(q - vec2(0.0, 0.90)), 0.18) * flashL * 0.18;
  return col;
}

// The near objects of the venue: the stacks at the wings and the crowd. They
// are called ONCE, not once per colour channel, because a silhouette has no
// dispersion to speak of and this is the most expensive part of the room.
vec3 props(vec2 q, vec3 under, float punch, float drop) {
  float A = uFrame.z;
  float beats = uClock.x * uSpeed * mix(1.0, 0.35, uCtl.y);
  float y = q.y;
  vec3 col = under;

  // --- the stacks at the wings ------------------------------------------
  if (A > 0.90) {
    for (int s = 0; s < 2; s++) {
      float sx = (s == 0 ? -1.0 : 1.0) * (A - 0.22);
      vec2 sq = q - vec2(sx, -0.06);
      vec2 db = abs(sq) - vec2(0.145, 0.36);
      float box = length(max(db, 0.0)) + min(max(db.x, db.y), 0.0);
      float cones = 1e3;
      for (int c = 0; c < 6; c++) {
        float cx = (mod(float(c), 2.0) - 0.5) * 0.090;
        float cy = (floor(float(c) / 2.0) - 1.0) * 0.155;
        cones = min(cones, length(sq - vec2(cx, cy)));
      }
      float insideBox = smoothstep(0.006, -0.006, box);
      col = mix(col, uPalBg.rgb * 0.008, insideBox * 0.96);
      float rimSide = s == 0 ? 1.0 : -1.0;
      float rim = exp(-max(box, 0.0) / 0.008)
                * smoothstep(-0.2, 0.2, sq.x * rimSide);
      col += mix(uPalMid.rgb, uPalHigh.rgb, 0.40) * rim * (0.05 + 0.10 * punch) * insideBox;
      float cone = smoothstep(0.010, 0.0, abs(cones - 0.058));
      col *= 1.0 - 0.50 * cone;
      col += mix(uPalHigh.rgb, vec3(1.0), 0.35) * exp(-max(abs(cones - 0.058), 0.0) / 0.005)
           * 0.08 * punch * smoothstep(-0.05, 0.05, sq.y);
    }
  }

  // --- the crowd ---------------------------------------------------------
  float cTop = -0.59 + 0.017 * sin(q.x * 7.0 + 0.7) + 0.009 * sin(q.x * 17.0 + 2.0);
  float crowd = smoothstep(cTop + 0.014, cTop - 0.014, y);
  float headRim = 0.0;
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float xh = ((fi + 0.5) / 7.0 * 2.0 - 1.0) * (A + 0.12)
             + (hash11(fi * 6.1 + 1.3) - 0.5) * 0.08;
    float rh = 0.058 + 0.020 * hash11(fi * 3.7 + 5.0);
    float yh = cTop + rh * (0.30 + 0.20 * hash11(fi * 2.1));
    vec2 hq = vec2((q.x - xh), (q.y - yh) * 1.10);
    float head = length(hq) - rh;
    crowd = max(crowd, smoothstep(0.009, -0.009, head));
    headRim = max(headRim, exp(-max(head, 0.0) / 0.011) * step(0.0, head)
                  * smoothstep(-rh * 0.4, 0.0, q.y - yh));
  }
  float hands = smoothstep(0.42, 0.90, drop + 0.35 * uArc.y);
  for (int i = 0; i < 2; i++) {
    float fi = float(i) + 2.0;
    float xh = ((fi + 0.5) / 7.0 * 2.0 - 1.0) * (A + 0.12);
    float rh = 0.060 + 0.020 * hash11(fi * 3.7 + 5.0);
    float baseY = cTop + rh * 0.9;
    float sway = 0.014 * sin(beats * PI * 0.5 + fi * 2.0);
    vec2 pa = vec2(xh, baseY);
    vec2 pb = vec2(xh + sway, baseY + 0.20);
    vec2 v = q - pa;
    vec2 w = pb - pa;
    float h = clamp(dot(v, w) / dot(w, w), 0.0, 1.0);
    float arm = length(v - w * h) - 0.0058;
    crowd = max(crowd, smoothstep(0.007, -0.007, arm) * hands);
  }
  vec3 crowdCol = uPalBg.rgb * 0.012;
  col = mix(col, crowdCol, crowd * 0.95);
  vec3 rimC = mix(uPalHigh.rgb, vec3(1.0), 0.48) * (0.42 + 0.90 * punch)
            + uPalMid.rgb * 0.08;
  float edgeRim = exp(-abs(y - cTop) / 0.012) * (0.18 + 0.48 * punch);
  col += rimC * edgeRim * (1.0 - 0.35 * crowd);
  col += rimC * headRim * (0.16 + 0.32 * punch) * crowd;
  // Light from the pit spills over the front row and keeps the bottom edge
  // alive on a beamer; it is in front of the silhouettes, as a wash is.
  col += mix(uPalLow.rgb, uPalHigh.rgb, 0.35)
       * exp(-pow((y + 0.98) / 0.085, 2.0)) * (0.020 + 0.040 * punch);
  return col;
}

void main() {
  vec2 p0 = fragP();
  float px = uFrame.w;
  float amp = 0.55 + 0.45 * uCtl.x;
  float motion = mix(1.0, 0.16, uCtl.y);
  float beats = uClock.x * uSpeed * mix(1.0, 0.35, uCtl.y);
  vec2 O = impact();

  // The engine's flash envelope, scaled by the skin's appetite for it.
  float flashL = uHit2.w * (0.25 + 0.75 * P_FLASH);

  // The hit and the drop. Both are envelopes over BEATS, not decays per
  // frame: the pane breaks the same at 30 and at 144.
  float hit = envB(uSince.y, 0.34) * (0.62 + 0.38 * uLookA.z) * amp;
  hit *= 1.0 + 0.45 * uHit.z;
  float dropAge = max(uSince.w, 0.0);
  float dropEnv = step(0.0, uSince.w) * (1.0 - smoothstep(0.0, 1.8, dropAge))
                * smoothstep(0.0, 0.04, dropAge) * P_BURST;

  float n = floor(clamp(11.0 + 8.0 * P_SHARDS, 12.0, 28.0) + 0.5);
  G = mix(2.05, 1.40, clamp((P_SHARDS - 0.35) / 1.80, 0.0, 1.0));
  float seed = uS0.z;

  // The pane jolts as a whole: the fracture is sampled in a frame that is
  // kicked a few pixels, and the impact travels with it. The stage does not:
  // it is the camera that shakes, by its own smaller amount.
  float jolt = hit * motion + dropEnv * 1.35 * motion;
  vec2 joltOff = vec2(sin(uSince.y * 18.0), cos(uSince.y * 15.0))
               * (0.0032 * hit * motion);
  vec2 p = p0 + joltOff;
  vec2 shake = vec2(sin(uSince.y * 23.0), cos(uSince.y * 19.0))
             * (0.008 * hit * motion + 0.010 * dropEnv * motion);

  Crack c = crackAt(p, O, n, seed);
  float hs = shardId(c, seed);
  float rh = ringHue(c, seed);
  float hs2 = fract(hs * 91.7 + 0.37);
  float hs3 = fract(hs * 43.1 + 0.71);
  vec2 sdir = vec2(cos(c.midA), sin(c.midA));

  // Every shard is a rigid piece: it is thrown along its own radius, turns
  // about its centre and grows as it comes toward the camera. The centre and
  // the crushed shards at the impact are held back, so the pane opens from
  // the strike outward instead of inflating everywhere at once.
  float depth = clamp(c.midR, 0.0, 1.5);
  float near = smoothstep(0.0, 0.24, length(p - O));
  float sizeFade = 1.0 / (0.80 + 0.45 * clamp(c.midR, 0.0, 2.2));
  float fly = jolt * P_JAG * (0.003 + 0.020 * hs2) * (0.30 + 0.70 * depth) * (0.35 + 0.65 * near);
  float turn = jolt * P_SPIN * (hs2 - 0.5) * 0.60;
  float grow = (hit * (0.012 + 0.028 * hs3) + dropEnv * (0.045 + 0.045 * hs3)) * sizeFade;
  vec2 sc = O + sdir * c.midR;
  vec2 q = sc + rot(-turn) * ((p - sc - sdir * fly) / (1.0 + grow));

  // Coverage: is this pixel still covered by ITS shard in the moved state?
  // Re-test the same four boundaries at q, but without walking the crack
  // network again — the cell's identity is already known.
  float rq = max(length(q - O), 1e-4);
  float aq = atan(q.y - O.y, q.x - O.x);
  float aLo = spokeA(c.kLo, rq, n, seed);
  float aHi = spokeA(c.kHi, rq, n, seed);
  float dLo = mod(aq - aLo + TAU, TAU);
  float dHi = mod(aHi - aq + TAU, TAU);
  float insideRad = min(dLo, dHi) * rq;
  // The chord boundaries are straight lines fixed in the pane's rest space:
  // the moved point q is inside when it is still on the impact side of each.
  float sLo = c.jLo >= 0.0
            ? dot(q - 0.5 * (c.eLo0 + c.eLo1), c.nLo) : 1000.0;
  float sHi = c.jHi < 90.0
            ? -dot(q - 0.5 * (c.eHi0 + c.eHi1), c.nHi) : 1000.0;
  float inside = min(insideRad, min(sLo, sHi));
  float wpix = px / (1.0 + grow);
  float edgePx = 0.65 * wpix;
  float cov = smoothstep(-edgePx, edgePx, inside);
  // At REST the pane is intact: a crack is a dark cut and one faint lit
  // bevel, not a lit gap. It is the separation of the pieces on the hit that
  // lets the room through, so the opening arrives with the kick rather than
  // being drawn on all the time.
  float sep = clamp(jolt * 1.65 + dropEnv * 1.10, 0.0, 1.0);
  // Radial cracks stay legible all the way out; a chord far from the strike
  // is a dark hairline rather than a bright gash, so the rings do not turn
  // into a second web over the large edge slabs.
  float chordFade = 1.0 - smoothstep(0.55, 1.80, c.r);
  float edgeVis = c.edgeRad <= c.edgeChord ? 1.0
                : c.chordVis * chordFade * smoothstep(0.04, 0.16, c.r);
  float gapW = (hit * 0.0060 + dropEnv * 0.010) * P_JAG;
  float breath = 1.0 - smoothstep(gapW, gapW + 1.2 * px, c.edge);
  float open = max((1.0 - cov) * sep, breath * sep * 0.8);
  open *= 0.05 + 0.95 * edgeVis;

  // --- the glass ---------------------------------------------------------
  // Each piece is a different window onto the room: its own tone (clear to
  // nearly black), its own magnification and rotation, and its own tilt for
  // the reflection. A pane of shards is a mosaic of DIFFERENT images, which
  // is the one thing a flat transparent overlay can never be.
  float tone = mix(0.02, 1.0, smoothstep(0.02, 0.75, hs)) * (0.94 + 0.12 * rh);
  float clarity = smoothstep(0.05, 0.80, hs3) * (0.95 + 0.10 * rh);
  float gloss = smoothstep(0.18, 0.76, hs2) * (0.20 + 0.80 * fract(hs * 17.3)) * (0.92 + 0.16 * rh);
  vec2 tilt = vec2(hs - 0.5, hs2 - 0.5);
  float lens = 0.045 + 0.130 * abs(hs - 0.5);
  vec2 rel = rot((hs3 - 0.5) * 0.24) * (q - sc);
  vec2 mag = sc + rel * vec2(0.70 + 0.55 * hs3, 0.90 + 0.18 * hs3);
  vec2 base = mag + tilt * vec2(lens, lens * 0.30) * (1.0 + 1.2 * hit);
  // A pane is never optically flat at this size: a slow surface warp makes
  // the reflection wander across a big shard instead of filling it evenly.
  float sn = gnoise(base * 2.4 + vec2(seed * 1.7, seed * 0.9));
  float sm = sn * 0.6 + 0.4 * sin(base.x * 2.3 - base.y * 1.7 + seed);
  vec2 nSurf = vec2(sn, sm);
  // Dispersion, on the impact and on the drop; at rest it is a fifth of a
  // pixel and cannot read as a resting colour fringe.
  vec2 split = (tilt * 1.1 + sdir * 0.22)
             * (0.0004 + 0.0028 * hit + 0.0020 * dropEnv);
  // The haze is low-frequency, so one value for the three channels is exact
  // to the eye and saves two thirds of the fbm cost.
  vec2 stageP = p0 + shake;
  float haze = fbm(stageP * vec2(1.2, 1.6) + vec2(beats * 0.030, -beats * 0.018), 2) * 0.5 + 0.5;
  float punch = 0.48 + 0.45 * uFlow.x + 0.85 * hit + 1.15 * dropEnv + 0.25 * uMood.y;
  // Two samples, not three: red and blue are taken either side of the
  // dispersion and green is their mean. On a shard the size of a hand the
  // difference between that and a true three-channel sample is a fraction of
  // a pixel, and this is the most expensive function in the world.
  vec3 cR = venue(base + split, haze, punch, dropEnv, flashL);
  vec3 cB = venue(base - split, haze, punch, dropEnv, flashL);
  vec3 through = vec3(cR.r, 0.5 * (cR.g + cB.g), cB.b);
  // The crowd and stacks are near silhouettes: their image is refracted by
  // the same shard (so the pane still breaks them) but not dispersed, and
  // they are composited once instead of twice.
  through = props(base, through, punch, dropEnv);

  vec3 tint = mix(vec3(0.40, 0.60, 0.70), uPalLow.rgb, 0.12 + 0.22 * hs3) * mix(0.84, 1.12, hs2);
  vec3 clearBody = through * tint * (0.28 + 0.30 * tone);
  vec3 darkBody = uPalBg.rgb * 0.018 + tint * 0.008;
  vec3 body = mix(darkBody, clearBody, 0.08 + 0.68 * clarity + 0.24 * uArc.z);
  // Even a nearly opaque piece is glass, not a black hole: a little of the
  // room's colour lives in the body itself.
  vec3 bodyGlow = tint * (0.012 + 0.028 * clarity) * (1.0 + 0.8 * uArc.z)
                * (0.5 + 0.5 * uFlow.x);
  body += bodyGlow + tint * 0.015 * uArc.z;  // A shard is a flat facet, but the light it reflects is a softbox with a
  // size: the highlight lies across the piece, brightest on the side facing
  // the lamp, and it walks from shard to shard as the light turns. It is not
  // a uniform fill of the whole polygon — that read as a flat white facet.
  float la = beats * 0.40 + 0.7;
  vec2 Ld = vec2(cos(la), sin(la));
  vec3 N = normalize(vec3(tilt * 1.0 + nSurf * 0.75, 1.0));
  vec3 L = normalize(vec3(Ld * 0.9, 0.85));
  float lobe = pow(max(dot(N, L), 0.0), 5.0);
  float grad = dot(normalize(rel + vec2(1e-4)), Ld) * 0.5 + 0.5;
  vec3 specCol = mix(uPalHigh.rgb, vec3(1.0), 0.18);
  body += specCol * lobe * (0.22 + 0.78 * grad) * gloss
        * (0.14 + 0.14 * hit + 0.06 * flashL) * (0.5 + 0.5 * uFlow.x);
  // A broad softbox on the glass itself: one side of every piece is a little
  // brighter, the other falls into the room. It is the facet's shape the eye
  // reads, not a stripe painted over the pane.
  body += specCol * (0.008 + 0.032 * grad) * (0.25 + 0.75 * gloss)
        * (0.5 + 0.5 * uFlow.x);
  body *= 0.82 + 0.24 * grad;
  // A pane in a venue is not optically clean: a slow smudge in the body and
  // in the reflection is what separates a sheet of glass from a colour wash.
  float smudge = 0.5 + 0.5 * sn;
  body *= 0.90 + 0.20 * smudge;
  body *= 0.94 + 0.12 * (0.5 + 0.5 * sn);
  body += specCol * smudge * 0.012 * (0.4 + 0.6 * gloss);

  // The fracture edge: a dark cut face just inside the crack, and a thin lit
  // bevel on the side the reflection comes from. Some edges catch light, some
  // do not — a broken pane has no continuous rim.
  float eMoved = max(inside, 0.0);
  float cut = exp(-eMoved / max(4.6 * wpix, 0.0055)) * (0.18 + 0.82 * edgeVis);
  // The bright lip of the break sits a pixel or two INSIDE the dark cut, not
  // on the boundary: that small offset is what gives the edge a thickness.
  float lip = exp(-pow((eMoved - 1.7 * wpix) / max(1.25 * wpix, 0.0016), 2.0))
            * (0.16 + 0.84 * edgeVis);
  float facing = clamp(dot(sdir, Ld), 0.0, 1.0);
  float edgeGate = smoothstep(0.15, 0.75, hs2);
  vec3 edgeC = mix(vec3(0.80, 0.90, 0.94), uPalHigh.rgb, 0.35);
  body = mix(body, body * 0.42 + uPalBg.rgb * 0.016, cut * 0.82);
  float chip = 0.78 + 0.22 * sin((c.r + c.t * 0.3) * 18.0 + hs * 37.0);
  body += edgeC * lip * edgeGate * chip * (0.16 + 0.38 * hit + 0.10 * flashL)
        * (0.25 + 0.75 * facing);
  // The short cracks radiating from the strike are surface damage: a dark
  // hairline with one side catching light, inside the shard rather than
  // between two of them.
  float surf = 1.0 - smoothstep(0.0, 1.35 * wpix, c.surface);
  body *= 1.0 - 0.62 * surf;
  body += edgeC * surf * (0.015 + 0.08 * hit) * smoothstep(0.30, 0.85, hs2);

  // --- the gaps: the room, untinted, and the light punching through ---
  // The stage has already been sampled for the glass; the gap is the same
  // room without the tint and without the piece's magnification. Reusing it
  // is what keeps the world in the same cost class as the old shatter.
  vec3 gapCol = through * (1.00 + 0.55 * hit + 0.65 * dropEnv);
  gapCol += edgeC * (0.008 + 0.18 * hit + 0.12 * dropEnv);
  vec3 col = mix(body, gapCol, open);

  // --- the crushed point of impact --------------------------------------
  float rd = length(p - O);
  float crushR = (0.060 + 0.075 * sqrt(clamp(hit, 0.0, 1.6)) + 0.070 * dropEnv)
               * (0.85 + 0.30 * hs2);
  float crush = smoothstep(crushR * 1.30, crushR * 0.15, rd);
  float grain = gnoise(p * 125.0 + vec2(seed * 3.1, seed * 1.7)) * 0.5 + 0.5;
  float mote = smoothstep(0.30, 0.70, grain);
  float sparkle = smoothstep(0.45, 0.82, grain);
  vec3 powder = mix(uPalHigh.rgb, vec3(1.0), 0.62)
              * (0.16 + 1.05 * hit + 0.80 * dropEnv) * (0.30 + 0.95 * sparkle);
  float dust = crush * (0.35 + 0.65 * mote);
  col = mix(col, powder, dust * 0.58);
  col += powder * dust * sparkle * 0.38;
  float core = glow(rd, 0.008 + 0.020 * hit + 0.012 * dropEnv);
  col += mix(uPalHigh.rgb, vec3(1.0), 0.72) * core
       * (0.03 + 0.95 * hit + 0.70 * dropEnv) * (0.55 + 0.45 * uHit.z);

  // The flash itself, after the glass: the engine has already decided how
  // much of it this person may see.
  col += mix(uPalHigh.rgb, vec3(1.0), 0.8) * flashL * 0.12;

  col *= 1.0 + 0.30 * uArc.z;
  col *= mix(0.30, 1.0, clearOfHole(p0, 0.06));
  // A quiet passage dims the room, but it must not extinguish the venue or
  // the fracture edges: the dynamics gate gets a floor.
  emit(col * max(mix(1.0, uEnergy, 0.6), 0.70));
}
`,

  create({ state, flash, params }) {
    // The striker's positions, in fractions of the frame's half-width/height.
    // Deterministic, and always off the centre: the pane is hit near a wing,
    // then across on the next bar, so the picture never settles into a
    // symmetric web.
    const SPOTS = [
      [-0.72, 0.36], [0.66, -0.28], [-0.64, -0.42], [0.74, 0.32],
      [-0.68, 0.06], [0.70, 0.46], [-0.75, -0.24], [0.72, 0.14],
      [-0.66, 0.42], [0.74, -0.38],
    ];
    let bars = 0;
    let spot = 0;
    const strike = (bigger) => {
      bars++;
      // Walk the spots rather than pick at random: a random pick repeats and
      // jumps; a walk moves round the pane a little each bar.
      spot = (spot + 3) % SPOTS.length;
      const s = SPOTS[spot];
      state[0] = s[0];
      state[1] = s[1];
      state[2] = hashN(bars * 7 + 3) * 97;
      if (bigger) state[0] = -state[0];
    };
    strike(false);
    const bar = onStamp((m) => m.stamp.bar, (s, m) => {
      // In a breakdown the pane is left alone: a new break every bar with no
      // drum to hide the jump would read as the pattern morphing.
      if (m.breakdown > 0.55) return;
      strike(false);
      if (m.drive > 0.45) flash(0.30 + 0.70 * (params.flash ?? 0.5));
    });
    const drop = onStamp((m) => m.stamp.drop, () => {
      strike(true);
      flash(1);
    });
    return {
      step(dt, m) {
        bar(m);
        drop(m);
      },
    };
  },
};
