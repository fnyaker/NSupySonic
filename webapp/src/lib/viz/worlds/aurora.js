// AURORE — curtains of light over still water.
//
// The calm mode. What makes an aurora read as one is its geometry, not its
// colour: a curtain is a thin, sinuous LINE on the ground plan of the sky,
// extruded straight up along the magnetic field and seen in perspective — so
// near curtains are tall and sweep across the frame, far ones sit low on the
// horizon, the lower hem is the sharpest and brightest edge, and the light
// fades out with altitude. That is exactly how this is drawn: the curtains'
// footprint is a ridge of warped noise on the plane, and the view ray is
// intersected with a stack of horizontal slices of the sky, each one lighting
// up where it crosses the footprint. Twenty-odd lookups per pixel, no volume.
//
// The rest of what makes it an aurora:
//
//   RAYS. The footprint's brightness varies along the line and not with
//   altitude, so every bright spot is a vertical streak — the field lines the
//   particles run down. They drift sideways with the bar clock.
//   COLOUR BY ALTITUDE. The palette's own light at the hem, its cooler end
//   higher up: the green-to-violet of oxygen and nitrogen, transposed into
//   whatever colour the track brought.
//   STILL WATER below the horizon, reflecting the same sky through slow
//   ripples, and a mountain line for the reflection to sit under.
//
// The music moves it gently, because this is the calm mode: the level
// brightens it, the bass lifts the curtains, the hi-hats make the rays shimmer,
// a chord change turns the colour a little, and every clock is the bar clock.
// Nothing flashes.
//
// Parameters:
//   slices  how many altitude slices (x the tier's budget)   height  curtain height
//   rays    striation strength                                water   reflection
//   stars   star-field density                                spread  curtain density

export default {
  id: "aurora",
  uses: ["noise"],
  feedback: true,
  params: { slices: 22, height: 1, rays: 1, water: 1, stars: 1, spread: 1 },
  look: { exposure: 1.1, bloom: 1.2, threshold: 0.6, saturation: 1.2 },

  fragment: `
// The curtains' footprint on the plane of the sky: thin sinuous ridges,
// stretched left-to-right so they run across the view, drifting on the bar
// clock. 1 on the curtain line, falling to 0 a short way off it.
// \`far\` widens the ridge with distance: a line thinner than a pixel aliases
// into speckle, so a far curtain is drawn softer instead — the cheap low-pass
// the horizon needs.
float footprint(vec2 q, float bars, float far) {
  vec2 w = vec2(fbm(q * 0.22 + vec2(bars * 0.02, 0.0), 3), fbm(q * 0.22 + vec2(5.2, -bars * 0.018), 3));
  float n = gnoise(q * vec2(0.16, 0.42) * P_SPREAD + w * 1.9 + vec2(0.0, bars * 0.03));
  return max(0.0, 1.0 - abs(n) * 8.5 / (1.0 + far));
}

// The aurora along a view ray (rd.y > 0): the ray is cut by \`steps\` horizontal
// slices from the curtain's hem upward, and each slice adds the light of the
// footprint where the ray crosses it.
vec3 aurora(vec3 rd, float bars, int steps, float jitter) {
  vec3 acc = vec3(0.0);
  float top = 1.3 * P_HEIGHT * (0.85 + 0.35 * uBandA.y);
  vec3 lowC = mix(uPalMid.rgb, uPalHigh.rgb, 0.35);
  vec3 highC = mix(uPalLow.rgb, uPalAcc.rgb, 0.2 + 0.25 * uHit2.z);
  float fs = float(steps);
  for (int i = 0; i < 40; i++) {
    if (i >= steps) break;
    float fi = (float(i) + jitter) / fs;
    float alt = 1.0 + fi * top;
    float t = alt / max(rd.y, 1e-3);
    if (t > 60.0) break;
    vec2 q = rd.xz * t;
    float f = footprint(q, bars, t * 0.06);
    f *= f * f;
    // Rays: brightness along the line, constant with altitude, so each one is
    // a vertical streak; they shimmer on the hats.
    float rn = 0.5 + gnoise(vec2(q.x * 1.6 + bars * 0.25, q.y * 0.3));
    float ray = 0.25 + 1.4 * rn * rn * P_RAYS;
    ray *= 1.0 + 0.4 * uHit2.x;
    // Light is brightest at the hem and fades with altitude, and far curtains
    // fade into the horizon haze.
    float fade = exp(-fi * 2.6) * exp(-t * 0.05);
    acc += mix(lowC, highC, smoothstep(0.0, 0.85, fi)) * f * ray * fade;
  }
  return acc * (7.0 / fs);
}

void main() {
  vec2 p = fragP();
  float bars = uClock.y * uSpeed;
  // The horizon: a third of the way up with nothing in front of the canvas;
  // just under the artwork when there is one, so the sky frames the cover.
  float hz = uHole.z > 0.0 ? clamp(uHoleR.z - 0.04, -0.92, -0.2) : -0.34;
  vec3 rd = normalize(vec3(p.x, p.y - hz, 1.5));
  int n = int(clamp(floor(P_SLICES * uQual.x + 0.5), 8.0, 40.0));
  // Per-pixel jitter of the slice positions, so the stack never shows as
  // bands: the eye integrates the noise, the grain pass hides the rest.
  float jitter = hash12(gl_FragCoord.xy + fract(uClock.x) * 61.0);
  float bright = (0.55 + 0.5 * uMood.y) * uEnergy;
  vec3 col;
  if (rd.y >= 0.0) {
    col = mix(uPalBg.rgb * 1.8, uPalBg.rgb * 0.45, clamp(rd.y * 2.2, 0.0, 1.0));
    // Stars, fading into the glow near the horizon.
    vec2 sp = p * 60.0 * P_STARS;
    vec2 cell = floor(sp);
    vec2 h = hash22(cell);
    float star = step(0.962, h.x);
    float d = length(fract(sp) - 0.5 - (h - 0.5) * 0.6);
    float tw = 0.6 + 0.4 * sin(uClock.x * (0.7 + h.y) * 1.3 + h.x * 40.0);
    col += vec3(0.85, 0.9, 1.0) * star * glow(d, 0.04) * tw * smoothstep(0.02, 0.25, rd.y);
    col += aurora(rd, bars, n, jitter) * bright;
  } else {
    // The water: the same sky mirrored, broken by slow ripples, darker, and
    // gone to black toward the viewer.
    float depth = -rd.y;
    vec3 rr = vec3(rd.x + gnoise(vec2(p.x * 4.0, depth * 40.0 - bars * 0.9)) * 0.02 * (0.3 + depth * 3.0), depth, rd.z);
    col = uPalBg.rgb * 0.3;
    col += aurora(normalize(rr), bars, max(8, n / 2), jitter) * bright * 0.45 * P_WATER * exp(-depth * 3.0);
  }
  // The mountains: a ridge standing on the horizon, black against the sky.
  float ridge = hz + 0.035 + 0.06 * (fbm(vec2(p.x * 1.2, 3.0), 4) + 0.5);
  float onRidge = smoothstep(ridge + 0.004, ridge - 0.004, p.y) * step(hz, p.y);
  col = mix(col, uPalBg.rgb * 0.22, onRidge);
  col *= mix(0.4, 1.0, clearOfHole(p, 0.06));
  // TEMPORAL ACCUMULATION. The slice positions are jittered per pixel and per
  // frame, which removes the banding a fixed stack draws — and replaces it
  // with noise. Averaging this frame into the last few turns that noise into
  // the smooth light it was sampling. An aurora moves slowly enough that the
  // average costs no visible smear; a world that moved on the kick could not
  // afford this.
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 last = prev(uv);
  emit(mix(last, col, 0.28));
}
`,
};
