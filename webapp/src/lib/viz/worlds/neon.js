// NÉON — a wet street under neon signs.
//
// Vaporwave, city pop, synthpop, italo, late-night R&B: the picture is the
// street itself. A brick wall hung with neon signs, the pavement in front of
// it soaked and mirroring every tube, rain falling through the light.
//
//   THE TUBES are drawn the way neon glows: a near-white core where the gas is
//   hottest, the colour in a tight halo around it, and a wide soft spill on
//   the wall behind — three falloffs, not one blurred line. The signs are
//   shapes rather than words (a ring, an arrow, a zigzag, a rising sun, a
//   frame, a wave), so they read in any language.
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
float groundY() { return -0.38; }

// The distance to sign \`t\`'s tube, in the sign's own frame.
float tube(vec2 q, float t) {
  if (t < 1.0) return abs(length(q) - 0.17);
  if (t < 2.0) {
    // An arrow.
    float d = sdSeg2(q, vec2(-0.25, 0.0), vec2(0.22, 0.0));
    d = min(d, sdSeg2(q, vec2(0.22, 0.0), vec2(0.12, 0.09)));
    return min(d, sdSeg2(q, vec2(0.22, 0.0), vec2(0.12, -0.09)));
  }
  if (t < 3.0) {
    // A zigzag.
    float x = clamp(q.x, -0.28, 0.28);
    float y = (abs(fract(x * 5.0) - 0.5) - 0.25) * 0.36;
    return length(vec2(q.x - x, q.y - y)) * 0.7;
  }
  if (t < 4.0) {
    // A rising sun: a half ring and its rays.
    float d = abs(length(q) - 0.13);
    d = q.y < 0.0 ? length(vec2(abs(q.x) - clamp(abs(q.x), 0.13, 0.13), q.y)) : d;
    float a = atan(q.y, q.x);
    float ra = (floor(a / 0.4) + 0.5) * 0.4;
    vec2 dir = vec2(cos(ra), sin(ra));
    if (q.y > 0.0) d = min(d, sdSeg2(q, dir * 0.18, dir * 0.26));
    return min(d, abs(q.y + 0.005) + step(0.3, abs(q.x)) * 9.0);
  }
  if (t < 5.0) return abs(sdRound2(q, vec2(0.3, 0.11), 0.05));
  // A wave.
  float x = clamp(q.x, -0.3, 0.3);
  return length(vec2(q.x - x, q.y - 0.05 * sin(x * 22.0))) * 0.8;
}

// All the light of the wall at point p: the signs and their spill, the brick.
vec3 wall(vec2 p, float beats, float hueShift, float power) {
  vec3 col = vec3(0.0);
  vec3 spill = vec3(0.0);
  float px = uFrame.w;
  float A = uFrame.z;
  int n = int(clamp(P_SIGNS, 1.0, 8.0));
  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    float fi = float(i);
    vec3 h = hash31(fi * 7.3 + 2.0);
    // Placed across the wall, two rows, never on top of each other.
    float cols = ceil(float(n) / 2.0);
    float cx = ((mod(fi, cols) + 0.5) / cols * 2.0 - 1.0) * (A - 0.12) + (h.x - 0.5) * 0.15;
    float cy = (fi < cols ? 0.55 : 0.12) + (h.y - 0.5) * 0.12;
    float sc = 0.8 + 0.5 * h.z;
    vec2 q = (p - vec2(cx, cy)) / sc;
    float t = floor(hash11(fi * 3.1 + 0.4) * 6.0);
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
