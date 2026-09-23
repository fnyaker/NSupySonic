// TROPIQUES — sunset, palms, the sea on fire with light.
//
// Tropical house, reggae, dancehall, bossa, balearic, afro-house: the hour
// the whole beach turns to watch. The sun low over the sea, palms black
// against the sky, the water carrying a road of glitter toward you, the air
// over the horizon trembling with heat.
//
//   THE SKY is a real sunset gradient — deep at the zenith, burning at the
//   horizon — leaned onto the palette, with long bands of cloud lit from
//   underneath where the sun still reaches them.
//   THE SEA is a plane in perspective: dark water, swell lines foreshortened
//   toward the horizon, and the GLITTER — the sun's reflection broken by the
//   waves into a path of sparks, widest near you, flickering with the hats.
//   THE PALMS frame the picture from both sides: curved trunks and drooping
//   fronds built as distance fields, their leaflets cut into the frond's
//   edge, swaying on the bar in a wind that gusts with the drive.
//   THE MUSIC. The bass swells the sea; the kick breathes the sun's glow; the
//   drop flares the sun and throws the glitter wide.
//
// Parameters:
//   palms   palm silhouettes (0 hides them)    glitter  sun path strength
//   sway    how much the palms move

import { onStamp } from "./kit.js";

export default {
  id: "tropics",
  uses: ["noise", "sdf"],
  params: { palms: 1, glitter: 1, sway: 1 },
  look: { exposure: 1.0, bloom: 1.3, threshold: 0.65, saturation: 1.2 },

  fragment: `
float horizonY() { return -0.18; }

// A frond: a drooping arc from the crown, its edge cut into leaflets.
float frond(vec2 p, vec2 crown, float ang, float len, float droop) {
  float best = 1e3;
  float bestT = 0.0;
  vec2 a = crown;
  for (int i = 1; i <= 8; i++) {
    float t = float(i) / 8.0;
    vec2 b = crown + vec2(cos(ang), sin(ang)) * len * t + vec2(0.0, -droop * t * t);
    float d = sdSeg2(p, a, b);
    if (d < best) { best = d; bestT = t; }
    a = b;
  }
  // The frond is widest a third of the way out and tapers to a point; the
  // leaflets are a saw cut into its width along its length.
  float w = 0.034 * sin(PI * pow(bestT, 0.6)) * (1.0 - 0.35 * bestT);
  float saw = fract(bestT * 30.0);
  w *= 0.25 + 0.75 * smoothstep(0.0, 0.7, saw);
  return best - w;
}

float palm(vec2 p, vec2 base, float h, float lean, float sway) {
  // The trunk: a curve, thicker at the foot.
  float d = 1e3;
  vec2 a = base;
  vec2 crown = base;
  for (int i = 1; i <= 8; i++) {
    float t = float(i) / 8.0;
    vec2 b = base + vec2(lean * t * t * h + sway * t * t * t * 0.05, h * t);
    float w = mix(0.022, 0.011, t);
    d = min(d, sdSeg2(p, a, b) - w);
    a = b;
    crown = b;
  }
  // The fronds, fanned round the crown, moving with the wind.
  // Long fronds arching out and drooping past the horizontal, the way a
  // coconut palm's crown hangs.
  for (int k = 0; k < 9; k++) {
    float fk = float(k);
    float ang = mix(0.05, PI - 0.05, fk / 8.0) + sway * 0.07 * (1.0 + 0.3 * sin(fk * 2.1));
    float len = 0.42 + 0.12 * sin(fk * 1.7 + h * 3.0);
    d = min(d, frond(p, crown, ang, len, 0.28 + 0.08 * cos(fk * 1.3)));
  }
  return d;
}

void main() {
  vec2 p = fragP();
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float A = uFrame.z;
  float px = uFrame.w;
  float hy = horizonY();
  // The sun sits low over the sea — or, with the artwork in the middle,
  // just above it, where it can be seen.
  vec2 sun = uHole.z > 0.0 ? vec2(uHole.x, min(uHole.y + uHole.w + 0.14, 0.72)) : vec2(0.0, hy + 0.2);
  float flare = uS0.x;
  // Heat shimmer: the air just over the horizon trembles.
  vec2 q = p;
  q.x += gnoise(vec2(p.y * 40.0, uClock.x * 2.0)) * 0.004 * exp(-abs(p.y - hy) * 12.0);

  // --- the sky ---
  float sy = clamp((q.y - hy) / (1.0 - hy), 0.0, 1.0);
  vec3 zenith = mix(uPalLow.rgb * 0.15, uPalBg.rgb * 0.5, 0.5);
  vec3 mid = mix(vec3(0.9, 0.25, 0.35), uPalMid.rgb, 0.4) * 0.35;
  vec3 burn = mix(vec3(1.0, 0.55, 0.2), uPalHigh.rgb, 0.3) * 0.7;
  vec3 sky = mix(burn, mid, smoothstep(0.0, 0.35, sy));
  sky = mix(sky, zenith, smoothstep(0.3, 1.0, sy));
  // Cloud bands lit from beneath.
  float band = fbm(vec2(q.x * 0.9 + bars * 0.01, q.y * 7.0), 4) * 0.5 + 0.5;
  float cloud = smoothstep(0.55, 0.8, band) * smoothstep(hy + 0.05, hy + 0.3, q.y) * smoothstep(0.9, 0.4, q.y);
  sky = mix(sky, mix(burn * 1.3, mid, sy * 1.5) * 0.9, cloud * 0.8);
  // The sun: a disc, a glow that breathes with the kick, and the drop's flare.
  float ds = length(q - sun);
  vec3 sunC = mix(vec3(1.0, 0.85, 0.55), uPalHigh.rgb, 0.2);
  sky += sunC * smoothstep(0.1, 0.095, ds) * 1.4;
  sky += sunC * exp(-ds * 3.0) * (0.25 + 0.15 * envB(uSince.y, 0.5) * amp + 0.6 * flare);
  vec3 col = sky;

  // --- the sea ---
  if (p.y < hy) {
    float depth = 0.3 / max(hy - p.y, 0.003);
    float wz = depth;
    // Swell lines, foreshortened; the bass lifts them.
    float swell = sin(wz * 3.0 - uClock.x * 1.2 + gnoise(vec2(p.x * depth * 0.3, wz * 0.5)) * 2.0);
    vec3 water = mix(zenith * 0.6, burn * 0.25, exp(-(hy - p.y) * 6.0));
    water *= 0.75 + 0.25 * swell * (0.5 + uBandA.x);
    // The glitter: the sun's road, sparks broken off by the waves.
    float road = exp(-pow((p.x - sun.x) / (0.04 + (hy - p.y) * (0.35 + 0.8 * flare)), 2.0));
    // Sparks on a grid that is even in PERSPECTIVE (log of the depth), so
    // they stay points near the viewer instead of swelling into blobs.
    vec2 gg = vec2(p.x * 70.0, log(depth) * 40.0);
    // Each spark sits somewhere of its own in its cell (a grid of them reads
    // as an LED panel) and is stretched sideways, the shape a glint on a
    // wave has.
    vec2 gc = floor(gg);
    float tick = floor(uClock.x * 6.0);
    vec2 off = hash22(gc + tick) * 0.7 + 0.15;
    float spark = step(0.8 - 0.1 * uHit2.x, hash12(gc + tick)) * smoothstep(0.3, 0.05, length((fract(gg) - off) * vec2(0.45, 1.6)));
    water += sunC * road * (0.15 + spark * 1.8) * P_GLITTER;
    col = water;
    // The horizon line itself, a thin brightness.
    col += burn * exp(-pow((p.y - hy) / (px * 2.0), 2.0)) * 0.5;
  }

  // --- the palms, framing both sides ---
  if (P_PALMS > 0.02) {
    float sway = sin(bars * PI * 0.5) * (0.5 + 0.5 * uFlow.x) * P_SWAY;
    float d = min(
      palm(p, vec2(-A + 0.25, -1.05), 1.35, 0.25, sway),
      palm(p, vec2(A - 0.2, -1.05), 1.2, -0.3, -sway * 0.8));
    d = min(d, palm(p, vec2(-A + 0.62, -1.05), 0.95, 0.12, sway * 1.2));
    float cov = smoothstep(px, -px, d) * P_PALMS;
    col = mix(col, uPalBg.rgb * 0.04, cov);
    // A rim of sunlight on the edges that face the sun.
    col += burn * exp(-pow(max(d, 0.0) / (px * 1.5), 2.0)) * step(0.0, d) * 0.12 * P_PALMS;
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.15;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    let flare = 0;
    const drop = onStamp((m) => m.stamp.drop, () => {
      flare = 1;
      flash(0.5);
    });
    return {
      step(dt, m) {
        drop(m);
        flare = Math.max(0, flare - dt / m.overBeats(8));
        state[0] = flare * flare;
      },
    };
  },
};
