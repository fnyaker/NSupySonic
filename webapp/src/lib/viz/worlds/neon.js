// NÉON — a wet street under neon signs.
//
// Vaporwave, city pop, synthpop, italo, late-night R&B: the picture is the
// street itself. A brick wall hung with neon signs, the pavement in front of
// it soaked and mirroring every tube, rain falling through the light.
//
//   THE TUBES are drawn the way neon glows: a near-white core where the gas is
//   hottest, the colour in a tight halo around it, and a wide soft spill on
//   the wall behind — three falloffs, not one blurred line. The signs are the
//   ones a street really has, with no words so they read in any language: a
//   heart, a martini, a lightning bolt, a moon and a star, a pair of notes, a
//   palm, a record, a diamond, an eye, the arrow in its frame.
//   THE STREET. Everything above the kerb is drawn a second time below it,
//   mirrored and rippled, because a wet pavement is a mirror; the hats land
//   as raindrop rings in the puddles.
//   THE ELECTRICS. The kick surges the current through every tube; the hats
//   make the worn ones stutter; a chord change re-lights the signs in new
//   colours; the drop switches everything off for a beat and back on.
//
// Parameters:
//   signs   how many signs    rain   rain strength
//   wet     how mirror-like the street is

import { onStamp } from "./kit.js";

export default {
  id: "neon",
  uses: ["noise", "sdf"],
  params: { signs: 8, rain: 1, wet: 1 },
  look: { exposure: 1.0, bloom: 1.4, threshold: 0.6, saturation: 1.25 },

  fragment: `
// The kerb: under the artwork when there is one, so the wall has the frame.
float groundY() { return uHole.z > 0.0 ? min(-0.38, uHoleR.z - 0.02) : -0.38; }

float dot2(vec2 v) { return dot(v, v); }
// Inigo Quilez's heart, unit height, its point at the origin.
float sdHeart(vec2 p) {
  p.x = abs(p.x);
  if (p.y + p.x > 1.0) return sqrt(dot2(p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
  return sqrt(min(dot2(p - vec2(0.0, 1.0)), dot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}
// ...and his five-pointed star.
float sdStar5(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
float sdEllipseA(vec2 q, vec2 r) { return (length(q / r) - 1.0) * min(r.x, r.y); }

// The distance to sign \`t\`'s tube, in the sign's own frame (about ±0.3).
// Ten signs of the kind a street actually has — no words, so they read in
// any language: a heart, a martini, a lightning bolt, a moon and a star, a
// pair of notes, a palm, a record, a diamond, an eye, and the arrow in its
// frame that points into every bar.
float tube(vec2 q, float t) {
  if (t < 1.0) return abs(sdHeart(q / 0.3 + vec2(0.0, 0.55)) * 0.3);
  if (t < 2.0) {
    float d = sdSeg2(q, vec2(-0.16, 0.14), vec2(0.16, 0.14));
    d = min(d, sdSeg2(q, vec2(-0.16, 0.14), vec2(0.0, -0.03)));
    d = min(d, sdSeg2(q, vec2(0.16, 0.14), vec2(0.0, -0.03)));
    d = min(d, sdSeg2(q, vec2(0.0, -0.03), vec2(0.0, -0.17)));
    d = min(d, sdSeg2(q, vec2(-0.08, -0.17), vec2(0.08, -0.17)));
    d = min(d, abs(length(q - vec2(0.045, 0.085)) - 0.022));
    return min(d, sdSeg2(q, vec2(0.06, 0.1), vec2(0.13, 0.23)));
  }
  if (t < 3.0) {
    vec2 v0 = vec2(0.07, 0.24), v1 = vec2(-0.08, 0.01), v2 = vec2(0.0, 0.01);
    vec2 v3 = vec2(-0.07, -0.24), v4 = vec2(0.09, 0.04), v5 = vec2(0.01, 0.04);
    float d = min(sdSeg2(q, v0, v1), sdSeg2(q, v1, v2));
    d = min(d, min(sdSeg2(q, v2, v3), sdSeg2(q, v3, v4)));
    return min(d, min(sdSeg2(q, v4, v5), sdSeg2(q, v5, v0)));
  }
  if (t < 4.0) {
    float moon = max(length(q - vec2(-0.05, 0.0)) - 0.2, -(length(q - vec2(0.03, 0.05)) - 0.17));
    return min(abs(moon), abs(sdStar5(q - vec2(0.17, -0.1), 0.07, 0.45)));
  }
  if (t < 5.0) {
    vec2 h1 = q - vec2(-0.12, -0.13);
    vec2 h2 = q - vec2(0.12, -0.09);
    float d = min(abs(sdEllipseA(rot(0.4) * h1, vec2(0.065, 0.045))), abs(sdEllipseA(rot(0.4) * h2, vec2(0.065, 0.045))));
    d = min(d, sdSeg2(q, vec2(-0.06, -0.11), vec2(-0.06, 0.17)));
    d = min(d, sdSeg2(q, vec2(0.18, -0.07), vec2(0.18, 0.21)));
    d = min(d, sdSeg2(q, vec2(-0.06, 0.17), vec2(0.18, 0.21)));
    return min(d, sdSeg2(q, vec2(-0.06, 0.11), vec2(0.18, 0.15)));
  }
  if (t < 6.0) {
    // A palm on its island.
    float d = 1e3;
    vec2 a = vec2(0.02, -0.18);
    for (int i = 1; i <= 4; i++) {
      float s = float(i) / 4.0;
      vec2 b = vec2(0.02 - 0.08 * s * s, -0.18 + 0.33 * s);
      d = min(d, sdSeg2(q, a, b));
      a = b;
    }
    vec2 c = a;
    for (int k = 0; k < 4; k++) {
      float ang = 0.3 + float(k) * 0.85;
      vec2 m = c + vec2(cos(ang), sin(ang)) * 0.1;
      vec2 e = c + vec2(cos(ang), sin(ang)) * 0.19 + vec2(0.0, -0.06);
      d = min(d, min(sdSeg2(q, c, m), sdSeg2(q, m, e)));
    }
    return min(d, sdSeg2(q, vec2(-0.2, -0.19), vec2(0.22, -0.19)));
  }
  if (t < 7.0) {
    float r = length(q);
    float d = min(abs(r - 0.21), abs(r - 0.075));
    d = min(d, abs(r - 0.012));
    float a = atan(q.y, q.x);
    return min(d, max(abs(r - 0.15), abs(a - 0.9) - 0.5));
  }
  if (t < 8.0) {
    // A cut diamond: a shallow crown over a deep pavilion, and its facets.
    float d = abs(abs(q.x) * 0.8 + (q.y > 0.06 ? (q.y - 0.06) * 1.6 : (0.06 - q.y) * 0.62) - 0.17);
    d = min(d, sdSeg2(q, vec2(-0.21, 0.06), vec2(0.21, 0.06)));
    d = min(d, sdSeg2(q, vec2(-0.07, 0.06), vec2(0.0, -0.21)));
    return min(d, sdSeg2(q, vec2(0.07, 0.06), vec2(0.0, -0.21)));
  }
  if (t < 9.0) {
    // An eye: two arcs meeting at the corners, and the iris.
    float d = abs(max(length(q - vec2(0.0, -0.2)) - 0.3, length(q - vec2(0.0, 0.2)) - 0.3));
    return min(d, abs(length(q) - 0.06));
  }
  // The arrow in its frame.
  float d = abs(sdRound2(q, vec2(0.3, 0.12), 0.05));
  d = min(d, sdSeg2(q, vec2(-0.18, 0.0), vec2(0.16, 0.0)));
  d = min(d, sdSeg2(q, vec2(0.16, 0.0), vec2(0.08, 0.06)));
  return min(d, sdSeg2(q, vec2(0.16, 0.0), vec2(0.08, -0.06)));
}

// All the light of the wall at point p: the signs and their spill, the brick.
vec3 wall(vec2 p, float beats, float hueShift, float power) {
  vec3 col = vec3(0.0);
  vec3 spill = vec3(0.0);
  float px = uFrame.w;
  float A = uFrame.z;
  // The wall is a grid of slots, as many columns as the frame is wide enough
  // for, two rows; a slot the artwork would hide stays empty, and the signs
  // fill the rest in order. Placing a fixed number of signs whatever the
  // frame piled ten of them on top of each other on a phone, a quarter of
  // their light behind the cover.
  // Never fewer than two across a phone: one sign alone over the cover is a
  // logo, not a street.
  float cols = clamp(floor(2.0 * A / 0.62), A > 0.4 ? 2.0 : 1.0, 6.0);
  float cw = 2.0 * (A - 0.08) / cols;
  float rowTop = uHole.z > 0.0 ? max(0.6, (uHole.y + uHole.w + 0.98) * 0.5) : 0.6;
  int n = int(clamp(P_SIGNS, 1.0, 10.0));
  int placed = 0;
  for (int slot = 0; slot < 12; slot++) {
    if (placed >= n || float(slot) >= cols * 2.0) break;
    float fs = float(slot);
    float row = floor(fs / cols);
    float cx = -(A - 0.08) + (mod(fs, cols) + 0.5) * cw;
    float cy0 = row < 0.5 ? rowTop : 0.08;
    if (uHole.z > 0.0 && abs(cx - uHole.x) < uHole.z + 0.18 && abs(cy0 - uHole.y) < uHole.w + 0.12) continue;
    float fi = float(placed);
    placed++;
    vec3 h = hash31(fi * 7.3 + 2.0);
    cx += (h.x - 0.5) * 0.1 * cw;
    float cy = cy0 + (h.y - 0.5) * 0.08;
    float sc = min(0.75 + 0.3 * h.z, cw / 0.66);
    vec2 q = (p - vec2(cx, cy)) / sc;
    // Three types apart, and ten types: no two signs on one wall alike.
    float t = mod(fi * 3.0 + 1.0, 10.0);
    float d = tube(q, t) * sc;
    vec3 c = pal(fract(fi * 0.23 + hueShift));
    c = mix(c, uPalAcc.rgb, step(0.75, h.x) * 0.6);
    // Worn tubes stutter on the hats.
    float stutter = step(0.7, h.y) * uHit2.x * step(0.5, hash11(fi + floor(beats * 4.0))) * 0.7;
    float on = power * (1.0 - stutter) * (0.8 + 0.4 * uHit.y * (0.6 + 0.4 * uCtl.x));
    float w = 0.005;
    float core = exp(-d * d / (w * w * 0.5 + px * px));
    col += mix(c, vec3(1.0), 0.45) * core * on * 1.4;
    col += c * glow(d, 0.018) * on * 0.5;
    spill += c * glow(d, 0.16) * on;
  }
  // Brick: dark, the mortar lines lit only where a sign's spill reaches.
  vec2 b = vec2(p.x * 9.0, p.y * 18.0);
  b.x += step(1.0, mod(floor(b.y), 2.0)) * 0.5;
  vec2 bf = fract(b);
  float mortar = max(smoothstep(0.06, 0.0, bf.y), smoothstep(0.04, 0.0, bf.x));
  float brick = 0.6 + 0.4 * hash12(floor(b));
  vec3 base = uPalBg.rgb * 0.25 * brick + vec3(0.004);
  col += base + spill * (0.07 * brick + 0.05 * mortar);
  return col;
}

void main() {
  vec2 p = fragP();
  float beats = uClock.x * uSpeed;
  float gy = groundY();
  float hueShift = uS0.x;
  float power = uS0.y;
  vec3 col;
  if (p.y > gy) {
    col = wall(p, beats, hueShift, power);
    // The kerb: a thin lit edge where the wall meets the street.
    col += mix(uPalMid.rgb, vec3(1.0), 0.3) * exp(-pow((p.y - gy) / (uFrame.w * 1.5), 2.0)) * 0.08;
  } else {
    // The street is a mirror, rippled by the rain and by raindrop rings.
    float depth = gy - p.y;
    vec2 q = vec2(p.x, gy + depth);
    float rip = gnoise(vec2(p.x * 12.0, depth * 40.0 - uClock.x * 2.0)) * 0.012;
    // Rings: the hats land as drops in the puddles.
    vec2 rg = vec2(p.x * 3.0, depth * 9.0);
    vec2 rid = floor(rg);
    float rh = hash12(rid + floor(uClock.x * 2.0));
    vec2 rc = (rid + 0.5 + (hash22(rid + floor(uClock.x * 2.0)) - 0.5) * 0.6);
    float age = fract(uClock.x * 2.0);
    float ring = exp(-pow((length((rg - rc) * vec2(1.0, 0.22)) - age * 0.6) / 0.03, 2.0)) * (1.0 - age) * step(0.85, rh);
    q.x += rip + ring * 0.02;
    q.y += rip * 0.5;
    vec3 refl = wall(q, beats, hueShift, power);
    // Fresnel of a wet street: the mirror strengthens toward the horizon.
    float fres = mix(0.35, 0.8, exp(-depth * 3.0)) * P_WET;
    col = refl * fres + uPalBg.rgb * 0.05;
    col += mix(uPalMid.rgb, vec3(1.0), 0.5) * ring * 0.08 * (0.5 + uHit2.x);
  }
  // Rain: two layers of streaks, lit by the signs they fall past.
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    vec2 rp = p * vec2(40.0 + fl * 25.0, 3.0 + fl) + vec2(p.y * 6.0, uClock.x * (1.5 + fl) * 2.0);
    vec2 cell = floor(rp);
    float h = hash12(cell + fl * 11.0);
    float drop = step(0.93, h) * smoothstep(0.5, 0.0, abs(fract(rp.x) - 0.5)) * smoothstep(0.0, 0.3, fract(rp.y)) * smoothstep(1.0, 0.7, fract(rp.y));
    col += mix(uPalMid.rgb, vec3(1.0), 0.5) * drop * 0.05 * P_RAIN / (1.0 + fl);
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    let hue = 0;
    let hueShown = 0;
    let outage = -1;
    const chord = onStamp((m) => m.stamp.chord, () => {
      hue += 0.18;
    });
    const drop = onStamp((m) => m.stamp.drop, () => {
      outage = 0;
      flash(0.6);
    });
    return {
      step(dt, m) {
        chord(m);
        drop(m);
        hueShown = m.ease(hueShown, hue, 0.5, dt);
        // The shader only ever reads it through fract(): wrap both together.
        if (hue > 1 && hueShown > 1) {
          hue -= 1;
          hueShown -= 1;
        }
        // The drop's blackout: off for a beat, then the tubes strike back on
        // with ONE catch in the current — a single dip, never a strobe, so it
        // stays inside the flash limits the engine keeps everywhere else.
        let power = 1;
        if (outage >= 0) {
          outage += dt / m.beat;
          const on = Math.min(1, Math.max(0, (outage - 1) / 0.15));
          const dip = 1 - 0.5 * Math.exp(-Math.pow((outage - 1.3) * 10, 2));
          power = outage < 1 ? 0.03 : on * on * (3 - 2 * on) * dip;
          if (outage > 1.6) outage = -1;
        }
        state[0] = hueShown;
        state[1] = power;
      },
    };
  },
};
