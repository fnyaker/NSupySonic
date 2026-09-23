// MICRO-ONDES — the inside of a microwave oven, humming on the kick.
//
// Deutscher Krach: a kick so distorted it stops being a drum and becomes a
// BUZZ — the sound a microwave makes, magnetron and transformer humming, a
// fork on the plate crackling. So the picture is the oven, seen close up
// through its own door, and every part of it answers the kick the way the
// real thing answers its power.
//
//   THE DOOR fills the frame: glossy black around a window covered by the
//   perforated screen every microwave has — a hex grid of round holes you see
//   the inside through, faded to its average light wherever the holes would
//   be finer than the screen's pixels (a mesh finer than a pixel is moiré,
//   not texture) — and a glass that catches a softbox across it.
//   THE CAVITY is a real box in perspective, its vanishing point on the
//   artwork (the artwork is the dish being cooked). Enamel walls lit by the
//   lamp behind the perforated patch on the right wall, darker in the
//   corners, the mica waveguide cover on the left. The window is smaller than
//   the cavity, as it is on a real oven, so a phone's narrow window still
//   looks into a wide one.
//   THE TURNTABLE: a glass plate on its roller ring, a ring of embossed dots
//   and the three wheels under it turning at half its rate — the rotation you
//   actually see on a microwave — one turn every four bars.
//   THE HUM. A microwave cooks in HOT SPOTS: the standing wave of its cavity,
//   a 3-D lattice of maxima. They are drawn — glowing knots of heat hanging
//   in the box — and the mode stirrer moves them one step on every main kick,
//   while the kick swells them and makes the lamp surge and buzz.
//   THE ARCS. The dish has a gilt rim, so on the kicks it arcs: jagged
//   discharges from the rim to the walls or the floor, re-struck every
//   eighth of a beat, lighting the cavity blue while they live. A big kick
//   throws two; the drop, three and a flash.
//   THE PANEL: a vacuum-fluorescent display counting the phrase down in
//   beats like a cooking timer, blinking its colon on the beat and reading
//   "End" at the turn of each phrase — the ding; a keypad whose keys light
//   with the twelve pitch classes of what is playing; and the power dial,
//   its pointer on the drive and its ring of LEDs a level meter.
//
// Parameters:
//   hum    how hard the lamp and the hot spots answer the kick
//   arcs   how many arcs, and how bright     mesh   the door screen (0 = none)
//   field  how visible the hot spots are     spin   turntable speed

import { eventRing, onStamp, hashN } from "./kit.js";

export default {
  id: "microwave",
  uses: ["sdf"],
  params: { hum: 1, arcs: 1, mesh: 1, field: 1, spin: 1 },
  look: { exposure: 1.0, bloom: 1.15, threshold: 0.75, saturation: 1.1 },

  fragment: `
#define ZB 3.2

bool wideL() { return uFrame.z >= 0.95; }

// The control panel: centre and half extents. Beside the door on a wide
// frame, a strip under it on a tall one.
vec4 panelBox() {
  float A = uFrame.z;
  if (wideL()) {
    float w = clamp(0.16 * A, 0.17, 0.3);
    return vec4(A - 0.03 - w, 0.0, w, 0.95);
  }
  return vec4(0.0, -0.81, A - 0.03, 0.16);
}

// The door's window: x0, y0, x1, y1.
vec4 windowBox(vec4 P) {
  float A = uFrame.z;
  if (wideL()) return vec4(-A + 0.07, -0.92, P.x - P.z - 0.14, 0.92);
  return vec4(-A + 0.05, P.y + P.w + 0.07, A - 0.05, 0.95);
}

// The cavity, in camera space: the window plane is z = 1 and the back wall
// z = ZB. x0, y0, x1, y1 relative to the vanishing point. Never narrower than
// the frame's height, so a tall window looks into a wide box.
vec4 cavityBox(vec4 W, vec2 vp) {
  return vec4(min(W.x - vp.x, -0.95), W.y - vp.y, max(W.z - vp.x, 0.95), W.w - vp.y);
}

vec2 proj(vec3 v, vec2 vp) { return vp + v.xy / v.z; }

// The standing wave's maxima. The field is a product of sines across the box,
// sin(PI m u + phase) per axis, and its hot spots are where all three peak:
// u = (k + 1/2 - phase / PI) / m. The mode stirrer walks the phases, so the
// whole lattice hops on every main kick. Returned in the box's units.
// A tall window gets the next mode up vertically (three rows, not two), so
// its heat lands above and below the artwork instead of behind it.
vec3 hotSpot(int i, vec4 C, float rows) {
  vec3 mode = vec3(3.0, rows, 3.0);
  int ny = int(rows);
  vec3 k = vec3(float(i % 3), float((i / 3) % ny), float(i / (3 * ny)));
  vec3 ph = uS0.y * vec3(TAU / 5.0, TAU / 7.0, TAU / 9.0);
  vec3 u = mod(k + 0.5 - ph / PI, mode) / mode;
  // Kept off the walls: a spot pressed into one is a spot half inside it.
  u = mix(vec3(0.08), vec3(0.92), u);
  // And never quite still: heat convects. A slow wander, four beats round.
  float w = uClock.x * TAU / 4.0 + float(i) * 2.4;
  u += vec3(0.012 * sin(w), 0.02 * sin(w * 0.7 + 1.0), 0.015 * cos(w));
  return vec3(mix(C.x, C.z, u.x), mix(C.y, C.w, u.y), mix(1.12, ZB - 0.1, u.z));
}

// A 1-D value noise, for the arcs' jags.
float vnoise(float x) {
  float i = floor(x), f = fract(x);
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}

// Seven segments, as a VFD draws them: slanted, rounded, the unlit ones
// faintly there. q is in the digit's box (x -0.5..0.5, y -1..1); returns the
// distance to the nearest LIT segment in x and to any segment in y.
const int SEG7[10] = int[10](63, 6, 91, 79, 102, 109, 125, 7, 127, 111);
vec2 seg7(vec2 q, int mask) {
  q.x -= q.y * 0.12;
  vec2 a0[7] = vec2[7](vec2(-0.34, 0.92), vec2(0.44, 0.82), vec2(0.44, -0.08), vec2(-0.34, -0.92), vec2(-0.44, -0.08), vec2(-0.44, 0.82), vec2(-0.34, 0.0));
  vec2 a1[7] = vec2[7](vec2(0.34, 0.92), vec2(0.44, 0.08), vec2(0.44, -0.82), vec2(0.34, -0.92), vec2(-0.44, -0.82), vec2(-0.44, 0.08), vec2(0.34, 0.0));
  float lit = 1e3, every = 1e3;
  for (int i = 0; i < 7; i++) {
    float d = sdSeg2(q, a0[i], a1[i]);
    every = min(every, d);
    if (((mask >> i) & 1) == 1) lit = min(lit, d);
  }
  return vec2(lit, every);
}

// --- the cavity -----------------------------------------------------------------
// What the camera sees through the window at p: walls, floor, plate, lamp,
// with the lamp's light, the arcs' light and the hot spots in front of it.
vec3 cavity(vec2 p, vec2 vp, vec4 C, vec4 H, float lampI, vec3 lampC, vec3 arcL3, float arcI, vec3 arcC) {
  vec3 d = vec3(p - vp, 1.0);
  float tx = d.x < 0.0 ? C.x / min(d.x, -1e-5) : C.z / max(d.x, 1e-5);
  float ty = d.y < 0.0 ? C.y / min(d.y, -1e-5) : C.w / max(d.y, 1e-5);
  float t = min(min(tx, ty), ZB);
  vec3 h = d * t;
  vec3 n = t == ZB ? vec3(0.0, 0.0, -1.0) : t == tx ? vec3(-sign(d.x), 0.0, 0.0) : vec3(0.0, -sign(d.y), 0.0);
  bool floorHit = t == ty && d.y < 0.0;
  bool rightWall = t == tx && d.x > 0.0;
  bool leftWall = t == tx && d.x < 0.0;

  // Enamel: a dark warm grey leaned a little toward the palette, so the
  // lamp's pool of light, the heat and the arcs have something to stand out
  // against.
  vec3 alb = mix(vec3(0.3, 0.29, 0.28), uPalMid.rgb * 0.3, 0.2);
  vec3 Lp = vec3(C.z - 0.03, C.w * 0.35, 1.0 + (ZB - 1.0) * 0.3);
  vec3 L = Lp - h;
  float dist2 = dot(L, L);
  vec3 Ln = L * inversesqrt(dist2);
  float ndl = max(dot(n, Ln), 0.0);
  vec3 v = -normalize(d);
  float spec = pow(max(dot(n, normalize(Ln + v)), 0.0), 36.0);
  vec3 irr = lampC * lampI * (ndl * 2.2 / (0.2 + dist2 * 1.1) + 0.045);
  // The arcs light the box blue while they live.
  vec3 A3 = arcL3 - h;
  irr += arcC * arcI * max(dot(n, normalize(A3)), 0.15) / (0.15 + dot(A3, A3) * 1.6);
  // Corners: the three walls meeting a point shade it.
  float ex = min(h.x - C.x, C.z - h.x), ey = min(h.y - C.y, C.w - h.y), ez = ZB - h.z;
  float ao = 1.0;
  if (abs(n.x) < 0.5) ao *= 0.5 + 0.5 * smoothstep(0.0, 0.45, ex);
  if (abs(n.y) < 0.5) ao *= 0.5 + 0.5 * smoothstep(0.0, 0.45, ey);
  if (abs(n.z) < 0.5) ao *= 0.5 + 0.5 * smoothstep(0.0, 0.45, ez);
  vec3 col = alb * irr * ao + lampC * lampI * spec * 0.25 * ao;

  // The lamp, behind a perforated patch on the right wall: its holes are
  // the brightest thing in the box.
  if (rightWall) {
    vec2 w = vec2(h.z - Lp.z, h.y - Lp.y);
    vec2 q = w / 0.05;
    vec2 s = vec2(1.0, 1.7320508);
    vec2 a = mod(q, s) - 0.5 * s;
    vec2 b = mod(q - 0.5 * s, s) - 0.5 * s;
    float r = sqrt(min(dot(a, a), dot(b, b)));
    float aa = max(fwidth(r), 1e-3);
    float hole = mix(0.5, smoothstep(0.34 + aa, 0.34 - aa, r), smoothstep(0.6, 0.25, aa));
    float grille = step(abs(w.x), 0.34) * step(abs(w.y), 0.2);
    col = mix(col, lampC * lampI * 2.6 * hole + col * 0.3 * (1.0 - hole), grille);
  }
  // The mica waveguide cover on the left wall.
  if (leftWall) {
    vec2 w = vec2(h.z - (1.0 + (ZB - 1.0) * 0.45), h.y - C.w * 0.3);
    float m = sdRound2(w, vec2(0.36, 0.26), 0.04);
    float aa = max(fwidth(m), 1e-3);
    col = mix(col, col * vec3(0.95, 0.78, 0.55) * 0.8, smoothstep(aa, -aa, m));
    col *= 1.0 - 0.35 * smoothstep(2.0 * aa, 0.0, abs(m));
  }

  // --- the turntable ---
  float yp = C.y + 0.05;
  if (d.y < 0.0) {
    float tp = yp / d.y;
    if (tp >= 1.0 && tp < t + 1e-3) {
      vec3 hp = d * tp;
      float R = min(1.0, min(0.5 * (C.z - C.x) - 0.1, 0.5 * (ZB - 1.0) - 0.05));
      vec2 q = hp.xz - vec2(uHole.z > 0.0 ? uHole.x - vp.x : 0.0, 1.0 + 0.5 * (ZB - 1.0));
      float r = length(q);
      float fw = max(fwidth(r), 1e-4);
      float inside = smoothstep(R + fw, R - fw, r);
      if (inside > 0.0) {
        // Seen through the glass: the floor, a caustic where the plate
        // focuses the lamp, and the roller ring's three wheels turning at
        // half the plate's rate.
        vec3 under = col * vec3(0.9, 0.97, 0.95);
        vec2 qw = rot(uS0.x * 0.5) * q;
        float aw = atan(qw.y, qw.x);
        float rw = length(qw);
        float sect = mod(aw + PI / 3.0, TAU / 3.0) - PI / 3.0;
        float wheel = sdRound2(vec2(rw - 0.55 * R, sect * rw), vec2(0.045, 0.07), 0.025);
        float ring = abs(rw - 0.55 * R) - 0.008;
        float fw2 = max(fwidth(wheel), 1e-4);
        under *= 1.0 - 0.55 * smoothstep(fw2, -fw2, min(wheel, ring));
        under += lampC * lampI * 0.08 * smoothstep(0.5 * R, 0.0, abs(r - 0.35 * R));
        // The glass itself: grazing, so mostly reflection — the lamp's glint
        // and the box above — and a thick edge that carries the light.
        float fres = 0.25 + 0.6 * pow(1.0 - abs(normalize(d).y), 3.0);
        vec3 rd = reflect(normalize(d), vec3(0.0, 1.0, 0.0));
        vec3 Lg = normalize(Lp - hp);
        float glint = pow(max(dot(rd, Lg), 0.0), 90.0);
        vec3 refl = alb * lampC * lampI * 0.22 + lampC * lampI * glint * 3.0;
        // A ring of embossed dots near the rim: the rotation you can see.
        vec2 qr = rot(uS0.x) * q;
        float a = atan(qr.y, qr.x);
        float cell = (fract(a / TAU * 28.0) - 0.5) * TAU / 28.0 * r;
        float dotD = length(vec2(r - 0.86 * R, cell)) - 0.018;
        float fwd = max(fwidth(dotD), 1e-4);
        float dots = smoothstep(fwd, -fwd, dotD);
        vec3 glass = under * (1.0 - fres * 0.5) + refl * fres + lampC * lampI * dots * 0.35;
        // The gilt rim: the thing the arcs start from.
        float rim = smoothstep(0.03 + fw, 0.0, abs(r - R + 0.02));
        glass += mix(vec3(1.0, 0.75, 0.35), uPalHigh.rgb, 0.3) * rim * (0.35 * lampI + 0.8 * arcI);
        col = mix(col, glass, inside);
        t = min(t, tp);
      } else if (floorHit) {
        // The plate's shadow round its edge.
        col *= 1.0 - 0.3 * smoothstep(0.12, 0.0, r - R);
      }
    }
  }

  // --- the hot spots ---
  // Eighteen knots of heat (27 in a tall window) hanging in the box, each drawn where it projects:
  // a wide soft body in the palette, a hot core going to white, nearer ones
  // bigger. They are in the air in front of the walls, so nothing hides them
  // but the artwork. H is the part of the box they span: the part the window
  // shows, so a phone's narrow window still has heat in it.
  float heatAmt = P_FIELD * (0.35 + 0.65 * uFlow.x) * (1.0 - 0.6 * uArc.z) + 0.35 * uArc.y;
  float swell = 1.0 + 0.45 * uHit.x * P_HUM + 0.25 * uArc.y;
  vec3 hotC = mix(uPalHigh.rgb, vec3(1.0, 0.8, 0.5), 0.5);
  // Hero light: what falls under the artwork is light nobody sees.
  heatAmt *= mix(0.2, 1.0, clearOfHole(p, 0.08));
  bool tall = (C.w - C.y) > 1.2 * (H.z - H.x);
  float rows = tall ? 3.0 : 2.0;
  int count = tall ? 27 : 18;
  for (int i = 0; i < 27; i++) {
    if (i >= count) break;
    vec3 B = hotSpot(i, H, rows);
    // A wall nearer than the knot hides it — softly: a glow is scattered
    // light, and cutting its halo at the crease drew the box's edges in it.
    float vis = smoothstep(B.z - 0.7, B.z, t);
    if (vis <= 0.0) continue;
    vec2 bs = vp + B.xy / B.z;
    float hb = hash11(float(i) * 7.13 + 1.0);
    float rb = (0.15 + 0.07 * hb) * swell / B.z;
    float db = length(p - bs);
    if (db > rb * 4.0) continue;
    float x = db / rb;
    float body = exp(-x * x * 1.3);
    float core = exp(-x * x * 7.0);
    vec3 c = mix(uPalLow.rgb, uPalMid.rgb, hb) * (body * 0.55 + glow(x, 0.8) * 0.08) + hotC * core * 1.3;
    col += c * vis * heatAmt * (0.6 + 0.4 * hb) * (0.8 + 0.5 * uHit.x * P_HUM);
  }
  return col;
}

void main() {
  vec2 p = fragP();
  float px = uFrame.w;
  float amp = 0.6 + 0.4 * uCtl.x;
  vec4 P = panelBox();
  vec4 W = windowBox(P);
  vec2 wc = 0.5 * (W.xy + W.zw);
  vec2 wh = 0.5 * (W.zw - W.xy);
  // The vanishing point: on the artwork (the dish being cooked), a little
  // above its middle so the floor shows under it.
  vec2 vp = uHole.z > 0.0 ? uHole.xy + vec2(0.0, 0.1 * uHole.w) : vec2(wc.x, 0.05);
  vp = clamp(vp, W.xy + 0.2, W.zw - 0.2);
  vec4 C = cavityBox(W, vp);
  vec4 H = vec4(W.x - vp.x, C.y, W.z - vp.x, C.w);

  // The lamp: its level follows the drive and falls in a breakdown; the
  // kick makes it surge and BUZZ — a flicker re-struck every eighth of a
  // beat while the kick rings.
  float buzz = 0.6 + 0.4 * hash11(floor(uClock.x * 8.0) + 3.0);
  float lampI = (0.55 + 0.45 * uFlow.x) * (1.0 - 0.45 * uArc.z) * (1.0 + P_HUM * amp * uHit.x * buzz * 0.9)
              + 0.25 * uArc.x + 1.5 * uHit2.w;
  vec3 lampC = mix(vec3(1.0, 0.8, 0.56), uPalHigh.rgb, 0.3);

  // --- the arcs ---
  // Each lives a third of a beat or so and is re-struck (a new jag) every
  // eighth of a beat. Their light on the box is gathered here, their shape
  // drawn below.
  vec3 arcC = mix(vec3(0.55, 0.7, 1.0), uPalAcc.rgb, 0.35);
  vec3 arcL3 = vec3(0.0, C.y, 2.0);
  float arcI = 0.0;
  float arcCore = 0.0;
  float arcHalo = 0.0;
  float R = min(1.0, min(0.5 * (C.z - C.x) - 0.1, 0.5 * (ZB - 1.0) - 0.05));
  vec3 plateC = vec3(uHole.z > 0.0 ? uHole.x - vp.x : 0.0, C.y + 0.05, 1.0 + 0.5 * (ZB - 1.0));
  bool narrow = (W.z - W.x) < 1.2;
  for (int e = 0; e < 8; e++) {
    vec4 ev = uEv[e];
    float s = uClock.x - ev.x;
    float life = 0.28 + 0.2 * min(ev.y, 1.5);
    if (ev.y <= 0.0 || s < 0.0 || s > life) continue;
    float env = exp(-s / (0.1 + 0.06 * ev.y)) * smoothstep(life, life * 0.6, s);
    float strike = floor(s * 8.0);
    env *= 0.65 + 0.35 * hash11(strike * 3.1 + ev.z * 91.0);
    // From the plate's rim, front half, to a wall or the floor — or, in a
    // narrow window, across the gilt from one point of the rim's front to
    // another, which is the arc that stays in view under the artwork.
    float ang = narrow ? 1.5 * PI + (ev.z - 0.5) * 0.9 : PI + PI * (0.12 + 0.76 * ev.z);
    vec3 S3 = plateC + vec3(R * cos(ang), 0.02, R * sin(ang));
    vec3 E3;
    if (narrow) {
      float a2 = ang + (ev.w < 0.5 ? -1.0 : 1.0) * (0.45 + 0.4 * fract(ev.w * 7.3));
      E3 = plateC + vec3(R * cos(a2), 0.02, R * sin(a2));
    } else if (ev.w < 0.35) {
      // Along the floor to the front — the arc that stays in view under the
      // artwork on a phone.
      float side = cos(ang) < 0.0 ? -1.0 : 1.0;
      E3 = vec3(S3.x + side * (0.25 + 0.35 * ev.w), C.y, max(1.08, S3.z - 0.3 - 0.4 * fract(ev.w * 7.3)));
    } else {
      float sx = cos(ang) < 0.0 ? C.x : C.z;
      E3 = vec3(sx, C.y + (C.w - C.y) * (0.2 + 0.5 * fract(ev.w * 3.7)), mix(1.25, ZB - 0.3, fract(ev.w * 7.3)));
    }
    arcL3 = mix(arcL3, 0.5 * (S3 + E3), env / max(arcI + env, 1e-3));
    arcI += env * min(ev.y, 1.5) * P_ARCS;

    vec2 S = proj(S3, vp);
    vec2 E = proj(E3, vp);
    vec2 bmin = min(S, E) - 0.25;
    vec2 bmax = max(S, E) + 0.25;
    if (p.x < bmin.x || p.y < bmin.y || p.x > bmax.x || p.y > bmax.y) continue;
    vec2 dir = E - S;
    float len = length(dir);
    vec2 nrm = vec2(-dir.y, dir.x) / max(len, 1e-4);
    if (nrm.y < 0.0) nrm = -nrm;
    float seed = strike * 17.0 + ev.z * 311.0;
    float dm = 1e3;
    vec2 prevP = S;
    vec2 midA = S;
    vec2 midB = S;
    for (int i = 1; i <= 24; i++) {
      float u = float(i) / 24.0;
      float taper = sin(PI * u);
      float j = (vnoise(u * 5.0 + seed) - 0.5) + 0.5 * (vnoise(u * 13.0 + seed * 1.7) - 0.5)
              + 0.3 * (vnoise(u * 31.0 + seed * 2.9) - 0.5);
      vec2 q = mix(S, E, u) + nrm * len * (taper * (0.1 + 0.2 * j) + 0.012 * (hash11(u * 97.0 + seed) - 0.5));
      dm = min(dm, sdSeg2(p, prevP, q));
      if (i == 8) midA = q;
      if (i == 15) midB = q;
      prevP = q;
    }
    // Two forks, thinning as they go.
    for (int f = 0; f < 2; f++) {
      vec2 from = f == 0 ? midA : midB;
      vec2 fdir = rot((hash11(seed + float(f) * 5.0) - 0.5) * 1.8) * normalize(dir) * len * (0.22 + 0.12 * float(f));
      prevP = from;
      for (int i = 1; i <= 6; i++) {
        float u = float(i) / 6.0;
        vec2 q = from + fdir * u + nrm * len * 0.05 * (vnoise(u * 9.0 + seed * 2.3 + float(f) * 4.0) - 0.5);
        dm = min(dm, sdSeg2(p, prevP, q) + 0.25 * px * float(i));
        prevP = q;
      }
    }
    float w = px * (0.45 + 0.35 * min(ev.y, 1.5));
    float a = env * min(ev.y, 1.5) * P_ARCS;
    arcCore += smoothstep(w + px, w - px * 0.5, dm) * a;
    arcHalo += (glow(dm, 0.006) * 0.5 + glow(dm, 0.035) * 0.14) * a;
    // The root, where the arc touches the gilt.
    arcHalo += glow(length(p - S), 0.018) * a * 0.9;
  }

  // --- the door ---
  float dWin = sdRound2(p - wc, wh, 0.07);
  float dPan = sdRound2(p - P.xy, P.zw, 0.04);
  // Glossy black plastic: a vertical sheen, a softbox across it, and the
  // window's light bleeding onto the bevel round it.
  vec3 black = uPalBg.rgb * 0.35 + vec3(0.012);
  vec3 col = black * (0.75 + 0.5 * (0.5 + 0.5 * p.y));
  float softbox = smoothstep(0.28, 0.0, abs(p.x * 0.55 + p.y - 0.95));
  col += vec3(0.05) * softbox;
  col += lampC * lampI * 0.1 * exp(-max(dWin, 0.0) / 0.035);
  // The window's lip.
  col += lampC * lampI * 0.12 * smoothstep(3.0 * px, 0.0, abs(dWin - 0.006));

  // --- the window ---
  if (dWin < 2.0 * px) {
    vec3 inside = cavity(p, vp, C, H, lampI, lampC, arcL3, arcI, arcC);
    // The screen: a hex grid of round holes. Faded to its average where a
    // hole would be finer than a few pixels.
    // Sized from the window, as a real door's is: about a hundred holes
    // across it.
    float pitch = clamp((W.z - W.x) / 110.0, 0.012, 0.03);
    vec2 q = p / pitch;
    vec2 s = vec2(1.0, 1.7320508);
    vec2 a = mod(q, s) - 0.5 * s;
    vec2 b = mod(q - 0.5 * s, s) - 0.5 * s;
    float r = sqrt(min(dot(a, a), dot(b, b)));
    float aa = px / pitch;
    float rr = 0.41;
    float open = smoothstep(rr + aa, rr - aa, r);
    float avg = PI * rr * rr / 0.8660254;
    float sharp = smoothstep(0.45, 0.2, aa);
    float trans = mix(1.0, mix(avg, open, sharp * 0.6), P_MESH);
    // The metal between the holes catches some of the light behind it: a
    // fine screen over the picture, not a veil across it.
    vec3 metal = black * 0.8 + inside * 0.3;
    vec3 win = inside * trans + metal * (1.0 - trans);
    // The glass over it: the same softbox, fainter, and a sheen line.
    win += vec3(0.045) * softbox + vec3(0.02) * smoothstep(0.02, 0.0, abs(p.x * 0.55 + p.y - 0.62));
    // The arcs are in the box, behind the screen.
    win += (arcC * arcHalo + mix(arcC, vec3(1.0), 0.6) * arcCore * 1.8) * mix(1.0, trans, 0.5 * P_MESH);
    col = mix(col, win, smoothstep(px, -px, dWin));
  }

  // --- the handle (wide frames only) ---
  if (wideL()) {
    float hx = W.z + 0.07;
    float dh = sdRound2(p - vec2(hx, 0.0), vec2(0.018, 0.56), 0.018);
    col *= 1.0 - 0.45 * smoothstep(0.05, 0.0, dh - 0.01) * step(0.0, dh);
    float across = clamp((p.x - hx) / 0.018, -1.0, 1.0);
    vec3 chrome = mix(black * 2.0, vec3(0.22), 0.5 + 0.5 * across) + lampC * 0.18 * pow(1.0 - abs(across + 0.35), 8.0);
    col = mix(col, chrome, smoothstep(px, -px, dh));
  }

  // --- the panel ---
  if (dPan < 2.0 * px) {
    vec3 panel = mix(black * 1.4, vec3(0.03), 0.4) * (0.85 + 0.3 * (0.5 + 0.5 * p.y));
    panel += vec3(0.04) * softbox;
    vec3 vfd = mix(vec3(0.3, 1.0, 0.82), uPalAcc.rgb, 0.3);
    // Where things go: a column on a wide frame, a row on a tall one.
    vec2 dC, dH, kC, kH, gC;
    float gR, cols, rows;
    if (wideL()) {
      dC = vec2(P.x, P.y + P.w - 0.17);
      dH = vec2(P.z - 0.05, 0.1);
      kC = vec2(P.x, P.y + 0.12);
      kH = vec2(P.z - 0.06, 0.34);
      gR = P.z * 0.52;
      gC = vec2(P.x, P.y - P.w + gR + 0.16);
      cols = 3.0; rows = 4.0;
    } else {
      dH = vec2(0.36 * P.z, P.w - 0.045);
      dC = vec2(P.x - P.z + 0.04 + dH.x, P.y);
      gR = min(P.w - 0.05, 0.2 * P.z);
      gC = vec2(P.x + P.z - 0.05 - gR * 1.25, P.y);
      kC = vec2(0.5 * (dC.x + dH.x + gC.x - gR * 1.25), P.y);
      kH = vec2(0.5 * ((gC.x - gR * 1.25) - (dC.x + dH.x)) - 0.03, P.w - 0.05);
      cols = 3.0; rows = 2.0;
    }

    // The display: dark glass, the phrase counted down in beats. At the turn
    // of a phrase it reads "End" for a beat — the ding.
    float dd = sdRound2(p - dC, dH, 0.02);
    if (dd < 2.0 * px) {
      vec3 glassC = vec3(0.004, 0.008, 0.008) + vfd * 0.012;
      float left = 32.0 - floor(fract(uPhase.z) * 32.0);
      bool ding = left > 31.5;
      float dh = dH.y * 0.62;
      float dw = dh * 0.56;
      float gap = dw * 0.55;
      // Four cells, centred: d : d d
      float total = 3.0 * (2.0 * dw) + 2.0 * gap + dw * 0.8;
      float x0 = dC.x - 0.5 * total;
      float lit = 1e3, ghost = 1e3;
      for (int c = 0; c < 3; c++) {
        float cx = x0 + dw + float(c) * (2.0 * dw + gap) + (c > 0 ? dw * 0.8 : 0.0);
        int mask;
        if (ding) mask = c == 0 ? 121 : c == 1 ? 84 : 94;
        else {
          float dig = c == 0 ? 0.0 : c == 1 ? floor(left / 10.0) : mod(left, 10.0);
          mask = SEG7[int(dig)];
        }
        vec2 sq = (p - vec2(cx, dC.y)) / vec2(2.0 * dw, dh);
        if (abs(sq.x) < 0.9 && abs(sq.y) < 1.3) {
          vec2 sd = seg7(sq, mask) * dh;
          lit = min(lit, sd.x);
          ghost = min(ghost, sd.y);
        }
      }
      // The colon, blinking on the beat.
      float colX = x0 + 2.0 * dw + 0.5 * (gap + dw * 0.8);
      float colD = min(length(p - vec2(colX, dC.y + dh * 0.4)), length(p - vec2(colX, dC.y - dh * 0.4))) - dh * 0.08;
      if (!ding && uPhase.x < 0.5) lit = min(lit, colD);
      float sw = dh * 0.075;
      float blink = ding ? 0.55 + 0.45 * step(0.5, fract(uClock.x * 2.0)) : 1.0;
      glassC += vfd * 0.07 * smoothstep(sw + px, sw - px, ghost);
      glassC += vfd * (smoothstep(sw + px, sw - px, lit) * 1.6 + glow(max(lit - sw, 0.0), dh * 0.25) * 0.35) * blink;
      glassC += vec3(0.03) * smoothstep(0.03, 0.0, abs((p.y - dC.y) - 0.6 * dH.y + (p.x - dC.x) * 0.3));
      panel = mix(panel, glassC, smoothstep(px, -px, dd));
      panel *= 1.0 - 0.4 * smoothstep(3.0 * px, 0.0, abs(dd));
    }

    // The keypad: one soft key per pitch class (pairs of them on a strip),
    // lit from behind by what the melody is playing.
    vec2 kq = (p - kC) / kH;
    if (abs(kq.x) < 1.05 && abs(kq.y) < 1.05) {
      vec2 cell = vec2(2.0 / cols, 2.0 / rows);
      vec2 ki = clamp(floor((kq + 1.0) / cell), vec2(0.0), vec2(cols - 1.0, rows - 1.0));
      vec2 kc = -1.0 + (ki + 0.5) * cell;
      vec2 kl = (kq - kc) * kH;
      vec2 khalf = 0.5 * cell * kH - vec2(0.018);
      float kd = sdRound2(kl, khalf, 0.02);
      int idx = int(ki.y * cols + ki.x);
      float ch;
      if (rows > 3.0) ch = uChroma[idx / 4][idx % 4];
      else {
        int a2 = idx * 2, b2 = idx * 2 + 1;
        ch = max(uChroma[a2 / 4][a2 % 4], uChroma[b2 / 4][b2 % 4]);
      }
      float lit = pow(clamp(ch, 0.0, 1.0), 2.0) * (0.3 + 0.7 * uBandB.w);
      vec3 keyC = vec3(0.05, 0.05, 0.055) * (1.0 + 0.6 * smoothstep(-khalf.y, khalf.y, kl.y));
      keyC += pal(float(idx) / (cols * rows)) * lit * 0.6;
      // A printed legend dash, and the bevel catching the light on top.
      float mark = sdSeg2(kl, vec2(-khalf.x * 0.32, 0.0), vec2(khalf.x * 0.32, 0.0)) - 0.0025;
      keyC += vec3(0.12) * smoothstep(px, -px, mark) * (1.0 - 0.7 * lit);
      keyC += vec3(0.06) * smoothstep(3.0 * px, 0.0, abs(kd + 0.004)) * smoothstep(0.0, khalf.y, kl.y);
      panel = mix(panel, keyC, smoothstep(px, -px, kd));
      panel += pal(float(idx) / (cols * rows)) * lit * glow(max(kd, 0.0), 0.012) * 0.25;
    }

    // The power dial: brushed metal, its pointer on the drive, and a ring
    // of sixteen LEDs round it reading the level.
    vec2 gq = p - gC;
    float gr = length(gq);
    float ga = atan(gq.x, gq.y);
    if (gr < gR * 1.45) {
      float leds = 16.0;
      float span = 1.5 * PI;
      float u = (ga + 0.75 * PI) / span;
      float li = floor(u * leds);
      if (u >= 0.0 && u <= 1.0) {
        float lc = (li + 0.5) / leds * span - 0.75 * PI;
        vec2 lp = gC + gR * 1.26 * vec2(sin(lc), cos(lc));
        float ld = length(p - lp) - gR * 0.05;
        float on = step(li / leds, uMood.y * (0.8 + 0.4 * uHit.x));
        vec3 ledC = pal(li / leds);
        panel += ledC * (on * (smoothstep(px, -px, ld) * 1.4 + glow(max(ld, 0.0), gR * 0.12) * 0.3) + 0.05 * smoothstep(px, -px, ld));
      }
      float kd = gr - gR;
      if (kd < 2.0 * px) {
        float brushed = 0.5 + 0.5 * sin(ga * 90.0 + hash11(floor(gr / gR * 30.0)) * 6.0);
        float fwb = fwidth(ga * 90.0);
        brushed = mix(brushed, 0.5, smoothstep(1.0, 3.0, fwb));
        vec3 metalC = vec3(0.1, 0.1, 0.11) * (0.8 + 0.4 * brushed) * (0.8 + 0.5 * (gq.y / gR * 0.5 + 0.5));
        metalC += vec3(0.08) * smoothstep(3.0 * px, 0.0, abs(kd + gR * 0.08));
        float pa = mix(-0.72 * PI, 0.72 * PI, clamp(uFlow.x, 0.0, 1.0));
        vec2 pd = vec2(sin(pa), cos(pa));
        float pl = sdSeg2(gq, pd * gR * 0.35, pd * gR * 0.85) - gR * 0.035;
        metalC = mix(metalC, vfd * (0.8 + 0.8 * uHit.y), smoothstep(px, -px, pl));
        panel = mix(panel, metalC, smoothstep(px, -px, kd));
        panel *= 1.0 - 0.35 * smoothstep(0.03, 0.0, kd) * step(0.0, kd);
      }
    }
    col = mix(col, panel, smoothstep(px, -px, dPan));
    // The seam between the panel and the door.
    col *= 1.0 - 0.5 * smoothstep(2.0 * px, 0.0, abs(dPan));
  }

  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.18;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ ev, state, flash, params }) {
    const ring = eventRing(ev);
    let angle = 0;
    let stir = 0;
    let stirTo = 0;
    let n = 0;
    const arc = (at, power) => ring.push(at, power, hashN(n++), hashN(n * 7 + 3));
    const main = onStamp((m) => m.stamp.main, (s, m) => {
      // The stirrer moves the hot spots one step on every main kick.
      stirTo += 1;
      if (m.breakdown > 0.5 || m.drive < 0.3) return;
      const p = 0.5 + 0.6 * Math.min(1.2, m.mainPower || m.kick || 0.8);
      arc(s, p);
      if (m.bigKick) arc(s, p * 0.8);
    });
    const roll = onStamp((m) => m.stamp.roll, (s) => arc(s, 0.35));
    const drop = onStamp((m) => m.stamp.drop, (s) => {
      arc(s, 1.6);
      arc(s, 1.3);
      arc(s, 1.1);
      stirTo += 2;
      flash(0.9);
    });
    return {
      step(dt, m) {
        main(m);
        roll(m);
        drop(m);
        // One turn every four bars at the default, a little faster when the
        // music drives, slowing in a breakdown. Wrapped at two turns: the dots
        // repeat every 28th of one, the wheels (at half the rate) every third.
        const rate = (Math.PI * 2) / 16 * (params.spin ?? 1) * (0.6 + 0.6 * m.drive) * (1 - 0.6 * m.breakdown);
        angle = (angle + (dt / m.beat) * rate) % (Math.PI * 4);
        // Eased over a quarter of a beat: the hot spots hop, they do not cut.
        // The phases repeat every 315 steps (5 x 7 x 9).
        stir = m.ease(stir, stirTo, 0.25, dt);
        if (stirTo >= 315 && stir >= 315) {
          stirTo -= 315;
          stir -= 315;
        }
        state[0] = angle;
        state[1] = stir;
      },
    };
  },
};
