// ROUTE DE NUIT — the motorway after midnight.
//
// Chillwave, city pop, deep house, lo-fi, drill at 3 a.m.: the picture is the
// drive home. A wet motorway in perspective, lamps passing overhead one per
// beat, the dashes of the lane line counting sixteenths under the car, red
// tail-lights ahead, a city glowing on the horizon.
//
//   THE ROAD is a true ground plane: every pixel below the horizon is a point
//   on the asphalt at a depth, so the dashes foreshorten and the pools of
//   lamplight lie ON the road. It is wet, so every light above it is also a
//   streak of reflection below it — the one detail that makes a night road
//   look like a night road.
//   THE LAMPS stand on both verges, one pair per beat of travel, so the car's
//   speed IS the tempo. Each is drawn as a streak along its own motion away
//   from the vanishing point, longer the faster the car goes.
//   THE TRAFFIC. Tail-lights ahead drifting in their lanes, and now and then
//   a pair of headlights rushing past on the other carriageway.
//   THE ARRANGEMENT. The drive quickens through a build and surges on the
//   drop (the lamps smear into lines); a breakdown slows to a cruise and dims
//   the city; the kick pulses the lamps.
//
// Parameters:
//   lamps   lamp brightness     city   skyline and its glow
//   rain    wetness of the road  traffic  how many cars

import { onStamp } from "./kit.js";

export default {
  id: "nightdrive",
  uses: ["noise", "sdf"],
  params: { lamps: 1, city: 1, rain: 1, traffic: 1 },
  look: { exposure: 1.0, bloom: 1.35, threshold: 0.65, saturation: 1.15 },

  fragment: `
const float CAMH = 1.0;     // camera height over the road
const float CAMX = 1.75;    // ...and the car is in the right-hand lane
const float LAMPH = 3.2;    // lamp height
const float LAMPX = 4.2;    // lamps' distance from the road's centre
const float SPACING = 9.0;  // road units between lamps (one beat of travel)

float horizonY() { return 0.12; }

// A world point to the screen.
vec2 toScreen(vec3 w) { return vec2((w.x - CAMX) / w.z, horizonY() + (w.y - CAMH) / w.z); }

void main() {
  vec2 p = fragP();
  float travel = uS0.x;          // road units
  float speed = uS0.y;           // road units per beat
  float amp = 0.6 + 0.4 * uCtl.x;
  float hy = horizonY();
  float px = uFrame.w;
  vec3 sodium = mix(vec3(1.0, 0.62, 0.25), uPalHigh.rgb, 0.25);
  vec3 col;

  // --- the sky and the city ---
  vec3 sky = mix(uPalLow.rgb * 0.12 + uPalBg.rgb * 0.3, uPalBg.rgb * 0.25, smoothstep(hy, 1.0, p.y));
  float cityGlow = exp(-max(p.y - hy, 0.0) * 6.0) * (0.12 + 0.06 * uFlow.x) * P_CITY * (1.0 - 0.5 * uArc.z);
  sky += mix(uPalMid.rgb, sodium, 0.4) * cityGlow;
  // Stars, few.
  vec2 sg = floor(p * 110.0);
  sky += vec3(0.8) * step(0.994, hash12(sg)) * smoothstep(hy + 0.2, 0.9, p.y) * 0.25;
  col = sky;
  // The skyline: towers with lit windows, standing on the horizon.
  if (P_CITY > 0.02 && p.y > hy && p.y < hy + 0.3) {
    float bw = 0.045;
    float bi = floor(p.x / bw);
    float h = hash11(bi * 1.3 + 7.0);
    float top = hy + 0.01 + 0.05 * h + 0.14 * pow(hash11(bi + 0.7), 5.0);
    if (p.y < top) {
      vec3 b = uPalBg.rgb * 0.2;
      vec2 wv = vec2(fract(p.x / bw * 4.0), fract((p.y - hy) * 120.0));
      float win = step(0.35, wv.x) * step(wv.x, 0.75) * step(0.4, wv.y) * step(wv.y, 0.8);
      float on = step(0.7, hash12(vec2(floor(p.x / bw * 4.0), floor((p.y - hy) * 120.0))));
      b += mix(sodium, uPalHigh.rgb, 0.4) * win * on * 0.2 * (0.6 + 0.4 * uFlow.x);
      col = mix(col, b, P_CITY);
    }
  }

  // --- the road ---
  if (p.y < hy) {
    float z = CAMH / max(hy - p.y, 1e-3);
    float X = p.x * z + CAMX;
    float wz = z + travel;
    float fog = exp(-z * 0.025);
    // Asphalt: near black, a little grain, wetter in the ruts.
    float grain = gnoise(vec2(X * 3.0, wz * 3.0)) * 0.5 + 0.5;
    vec3 road = vec3(0.004 + 0.004 * grain);
    float edge = step(abs(X), 7.0);
    // The lane lines: a dashed centre line, solid edges.
    float pxz = px * z;                           // one pixel in road units, across
    float pzz = px * z * z / CAMH;                // ... and along
    float dash = step(fract(wz / (SPACING * 0.25)), 0.45);
    float lineW = 0.09;
    float cl = smoothstep(lineW + pxz, lineW - pxz, abs(X - 0.0)) * dash;
    float lanes = smoothstep(lineW + pxz, lineW - pxz, abs(abs(X) - 3.5)) * dash;
    float edges = smoothstep(lineW + pxz, lineW - pxz, abs(abs(X) - 6.9));
    float paint = max(max(cl, lanes), edges) * smoothstep(0.6, 0.1, pzz);
    road += vec3(0.14) * paint * fog;
    // Pools of lamplight on the road, and the headlights' own throw.
    for (int k = 0; k < 10; k++) {
      float lz = (floor(travel / SPACING) + float(k) + 1.0) * SPACING - travel;
      for (int s = 0; s < 2; s++) {
        float lx = s == 0 ? -LAMPX : LAMPX;
        vec2 d = vec2(X - lx * 0.7, (z - lz) * 0.5);
        road += sodium * exp(-dot(d, d) * 0.5) * 0.045 * P_LAMPS * (0.7 + 0.5 * uHit.y * amp);
      }
    }
    road += vec3(0.9, 0.95, 1.0) * exp(-pow(X - CAMX, 2.0) * 0.12) * exp(-z * 0.3) * 0.03;
    col = mix(sky * 0.4, road * edge + uPalBg.rgb * 0.1 * (1.0 - edge), fog);
  }

  // --- the lamps: streaks along their own motion, and their reflections ---
  float streak = clamp(speed * 0.02, 0.0, 0.25);
  for (int k = 0; k < 10; k++) {
    float lz = (floor(travel / SPACING) + float(k) + 1.0) * SPACING - travel;
    if (lz < 0.6) continue;
    for (int s = 0; s < 2; s++) {
      float lx = s == 0 ? -LAMPX : LAMPX;
      vec2 a = toScreen(vec3(lx, LAMPH, lz));
      vec2 b = toScreen(vec3(lx, LAMPH, lz + streak * lz));
      float d = sdSeg2(p, a, b);
      float size = 0.02 / lz + px;
      float lamp = glow(d, size) + 0.2 * glow(d, size * 5.0);
      col += sodium * lamp * 0.5 * P_LAMPS * (0.6 + 0.6 * uHit.y * amp) * exp(-lz * 0.02);
      // The pole, a dark line down to the verge.
      vec2 base = toScreen(vec3(lx, 0.0, lz));
      float pole = sdSeg2(p, a, base);
      col = mix(col, uPalBg.rgb * 0.05, smoothstep(0.004 / lz + px, 0.0, pole) * 0.8);
      // The reflection on the wet road: a streak straight down from the base.
      if (p.y < base.y) {
        float rx = abs(p.x - a.x);
        float rw = 0.012 / lz + px * 2.0;
        float rv = exp(-rx * rx / (rw * rw)) * exp(-(base.y - p.y) * 3.5 * lz * 0.3);
        col += sodium * rv * 0.25 * P_RAIN * P_LAMPS * exp(-lz * 0.03);
      }
    }
  }

  // --- the traffic: tail-lights ahead, headlights on the other side ---
  for (int c = 0; c < 5; c++) {
    float fc = float(c);
    if (fc >= 5.0 * P_TRAFFIC) break;
    vec3 h = hash31(fc * 3.1 + 1.7);
    // Cars ahead drift slowly relative to us.
    float cz = 12.0 + 40.0 * fract(h.x + uClock.x * 0.01 * (h.y - 0.4));
    float cx = (h.z > 0.5 ? 1.75 : 5.25) * (h.y > 0.3 ? 1.0 : -1.0);
    if (cx < 0.0) continue;
    for (int s = 0; s < 2; s++) {
      vec2 at = toScreen(vec3(cx + (s == 0 ? -0.6 : 0.6), 0.7, cz));
      float d = length(p - at);
      float r = 0.02 / cz + px;
      col += vec3(1.0, 0.08, 0.05) * (glow(d, r) + 0.15 * glow(d, r * 4.0)) * 0.6;
      vec2 base = toScreen(vec3(cx + (s == 0 ? -0.6 : 0.6), 0.0, cz));
      if (p.y < base.y) {
        float rx = abs(p.x - at.x);
        col += vec3(1.0, 0.1, 0.05) * exp(-rx * rx / pow(0.01 / cz + px * 2.0, 2.0)) * exp(-(base.y - p.y) * 6.0 * cz * 0.2) * 0.25 * P_RAIN;
      }
    }
  }
  // Oncoming: a pair of headlights on the far carriageway, now and then.
  {
    float cyc = uClock.x * 0.25;
    float id = floor(cyc);
    float u = fract(cyc);
    if (hash11(id * 2.3) < 0.6 * P_TRAFFIC) {
      float cz = mix(60.0, 1.5, u * u);
      for (int s = 0; s < 2; s++) {
        vec2 at = toScreen(vec3(-3.5 + (s == 0 ? -0.6 : 0.6), 0.7, cz));
        float d = length(p - at);
        col += vec3(0.9, 0.95, 1.0) * glow(d, 0.03 / cz + px) * 0.9;
      }
    }
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    let travel = 0;
    let speed = 9;
    let surge = 0;
    const drop = onStamp((m) => m.stamp.drop, () => {
      surge = 1;
      flash(0.5);
    });
    return {
      step(dt, m) {
        drop(m);
        // One lamp spacing per beat: the car's speed is the tempo.
        surge = Math.max(0, surge - dt / m.overBeats(8));
        const want = 9 * (0.75 + 0.25 * m.drive + 0.5 * m.build + 0.6 * surge) * (1 - 0.35 * m.breakdown);
        speed = m.ease(speed, want, 2, dt);
        travel += (dt / m.beat) * speed;
        state[0] = travel;
        state[1] = speed;
      },
    };
  },
};
