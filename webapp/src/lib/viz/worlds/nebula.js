// NÉBULEUSE — a stellar nursery, and nothing sudden in it.
//
// Ambient, drone, space music, the long intro of anything: the one world
// with no events in it at all. A nebula in the way the deep-field photographs
// show them — glowing gas, dark dust, young stars — drifting almost too
// slowly to see, and breathing with the level of the music.
//
//   THE GAS is two layers of domain-warped noise at two depths: a broad
//   glow, and on top of it ridged filaments (the absolute value of noise,
//   inverted, which is what draws the sharp walls of gas a stellar wind
//   carves). Each layer is its own colour from the palette, the way a
//   narrow-band photograph maps each element to a channel.
//   THE DUST is a third layer that does not glow but OBSCURES: dark lanes and
//   pillars in front of the light, with a thin bright rim where the stars
//   behind them catch their edges.
//   THE STARS. A fine field, and a few bright ones with diffraction spikes
//   — the four-pointed cross a telescope's struts put on anything bright.
//   The brightest one lights the gas around it.
//   THE MUSIC moves nothing suddenly. The level breathes the glow, the
//   melody warms the filaments, the drift runs on the phrase clock so a
//   faster track drifts a little faster. That is all, on purpose.
//
// Parameters:
//   glow    gas brightness     dust   dust density
//   stars   star density

export default {
  id: "nebula",
  uses: ["noise"],
  params: { glow: 1, dust: 1, stars: 1 },
  look: { exposure: 1.0, bloom: 1.3, threshold: 0.65, saturation: 1.25 },

  fragment: `
float ridged(vec2 q) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    float n = 1.0 - abs(gnoise(q));
    s += a * n * n;
    q = q * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return s;
}

void main() {
  vec2 p = fragP();
  float drift = uS0.x;                // phrase-clock drift
  float breath = 0.7 + 0.3 * uMood.y;
  float warm = uS0.y;                 // the melody, eased
  // Parallax: the far glow drifts slowest, the dust fastest.
  vec2 q0 = p * 0.7 + vec2(drift * 0.02, drift * 0.008);
  vec2 q1 = p * 1.1 + vec2(drift * 0.035, -drift * 0.01);
  vec2 q2 = p * 1.5 + vec2(drift * 0.055, drift * 0.012);
  vec2 w = vec2(fbm(q0 + 3.1, 4), fbm(q0 + 7.7, 4)) - 0.5;

  // The broad glow.
  float g0 = fbm(q0 + w * 1.2, 5) * 0.5 + 0.5;
  g0 = smoothstep(0.35, 0.95, g0);
  vec3 col = uPalBg.rgb * 0.3;
  col += mix(uPalLow.rgb, uPalMid.rgb, g0) * g0 * 0.22 * P_GLOW * breath;
  // The filaments: sharp walls of gas.
  float f1 = ridged(q1 * 1.3 + w * 0.8);
  f1 = pow(smoothstep(0.45, 1.0, f1), 2.0) * smoothstep(0.2, 0.7, g0 + 0.2);
  col += mix(uPalHigh.rgb, uPalAcc.rgb, 0.3 + 0.3 * warm) * f1 * 0.35 * P_GLOW * breath * (0.8 + 0.4 * warm);

  // The bright star, and the light it throws into the gas.
  vec2 star = uHole.z > 0.0 ? vec2(uHole.x + uHole.z + 0.35, uHole.y + 0.25) : vec2(0.35, 0.18);
  star.x = min(star.x, uFrame.z - 0.25);
  float ds = length(p - star);
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * exp(-ds * 2.2) * (g0 + f1) * 0.25 * breath;

  // The dust: dark lanes in front, rimmed where the star catches them.
  float d2 = fbm(q2 + w * 0.6 + 11.0, 5) * 0.5 + 0.5;
  float dust = smoothstep(0.52, 0.72, d2) * P_DUST;
  float rimD = fbm(q2 + w * 0.6 + 11.0 - normalize(p - star) * 0.02, 5) * 0.5 + 0.5;
  float rim = clamp((smoothstep(0.52, 0.72, rimD) - dust) * 4.0, 0.0, 1.0) * exp(-ds * 1.2);
  col *= 1.0 - 0.85 * dust;
  col += mix(uPalHigh.rgb, vec3(1.0), 0.4) * rim * 0.25 * breath;

  // Stars: a fine field, dimmed behind the dust, and a few with spikes.
  vec2 sg = p * 120.0;
  vec2 cell = floor(sg);
  float sh = hash12(cell);
  float fine = step(1.0 - 0.012 * P_STARS, sh) * smoothstep(0.35, 0.0, length(fract(sg) - 0.5));
  col += vec3(0.85, 0.9, 1.0) * fine * (0.3 + 0.7 * hash12(cell + 1.3)) * 0.5 * (1.0 - 0.8 * dust);
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 at = i == 0 ? star : (hash21(fi * 7.3 + 1.0) * 2.0 - 1.0) * vec2(uFrame.z - 0.1, 0.9);
    vec2 d = p - at;
    float b = i == 0 ? 1.0 : 0.35 + 0.3 * hash11(fi);
    float core = glow(length(d), 0.004 * b + uFrame.w);
    float spikes = (glow(abs(d.x), uFrame.w * 1.2) * exp(-abs(d.y) * 14.0) + glow(abs(d.y), uFrame.w * 1.2) * exp(-abs(d.x) * 14.0)) * 0.5;
    col += mix(vec3(1.0), uPalHigh.rgb, 0.3) * (core * 1.5 + spikes * 0.6) * b * breath * (1.0 - 0.6 * dust);
  }
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state }) {
    let drift = 0;
    let warm = 0;
    return {
      step(dt, m, clocks) {
        // A unit of drift per phrase, never a jump.
        drift += (dt / m.phrase) * 4;
        warm = m.ease(warm, clocks?.melody ?? 0, 8, dt);
        state[0] = drift;
        state[1] = warm;
      },
    };
  },
};
