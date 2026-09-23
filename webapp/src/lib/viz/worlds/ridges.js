// CRÊTES — the spectrum's recent past, as a range of ridgelines.
//
// The most famous picture of a signal ever printed is a stack of pulsar
// traces, each one a line with everything behind it hidden, so the whole
// reads as a landscape. This is that picture made of the music: every
// sixteenth note the spectrum becomes a new ridge at the front of the range,
// and the older ones recede toward a horizon — so the last four bars are laid
// out in front of you, the kicks as a row of peaks, a breakdown as a flat
// plain, a build as a slope rising toward the viewer.
//
//   THE LINES are drawn with their true pixel width at every depth, bright
//   where the spectrum is loud, and every ridge is FILLED below its line, so
//   a nearer ridge hides what is behind it. That occlusion is the whole
//   effect: without it the lines are a scribble; with it they are terrain.
//   THE SPECTRUM is mirrored about the centre — the bass in the middle, the
//   top end out to both sides — which puts the peaks where the classic plot
//   has them and lets a 16:9 frame be filled edge to edge.
//   THE PLANE recedes in true perspective, and scrolls continuously between
//   history rows (the rows land on the sixteenth grid, and so does the
//   scroll), so the range flows back rather than stepping.
//   THE KICK lights the newest ridge; the DROP floods the whole range.
//
// Parameters:
//   lines   ridges drawn (x the tier's budget)    height   peak height
//   mirror  1 mirrored about the centre, 0 bass on the left

export default {
  id: "ridges",
  uses: ["noise"],
  params: { lines: 1, height: 1, mirror: 1 },
  look: { exposure: 1.0, bloom: 1.15, threshold: 0.75, saturation: 1.1 },

  fragment: `
float histRow(float f, float k) {
  return texture(uHist, vec2(f, fract(uHistHead - k / 64.0))).r;
}

void main() {
  vec2 p = fragP();
  float W = uFrame.z;
  float amp = 0.6 + 0.4 * uCtl.x;
  int N = int(clamp(40.0 * P_LINES * (0.6 + 0.4 * uQual.x), 16.0, 60.0));
  // The scroll: how far into the current sixteenth we are.
  float scroll = fract(uClock.x * 4.0);
  const float HORIZON = 1.65;
  const float FRONT = -0.9;
  float px = uFrame.w;
  vec3 col = uPalBg.rgb * 0.3;
  // A haze glowing at the horizon, behind the range.
  col += mix(uPalLow.rgb, uPalMid.rgb, 0.5) * exp(-(1.0 - p.y) * 2.2) * 0.05 * (0.5 + uMood.y);
  vec3 lineSum = vec3(0.0);
  float drop = envB(uSince.w, 2.0) * step(uSince.w, 8.0);
  for (int i = 0; i < 60; i++) {
    if (i >= N) break;
    float fi = float(i) + scroll;
    // Depth of this ridge on the receding plane.
    float z = 1.0 + fi * 0.055;
    float base = HORIZON - (HORIZON - FRONT) / z;
    float xs = p.x * z;
    // The spectrum across it: mirrored, bass in the middle.
    float u = P_MIRROR > 0.5 ? abs(xs) / (W * 0.95) : (xs / (W * 0.95)) * 0.5 + 0.5;
    float window = P_MIRROR > 0.5 ? smoothstep(1.0, 0.55, u) : smoothstep(0.0, 0.08, u) * smoothstep(1.0, 0.9, u);
    float f = clamp(pow(clamp(u, 0.0, 1.0), 0.75), 0.0, 1.0);
    float v = histRow(f, float(i));
    // A little texture in the flats, the way a real trace is never flat.
    float jit = (gnoise(vec2(xs * 18.0, float(i) * 3.1 - floor(uClock.x * 4.0) * 3.1)) * 0.5 + 0.5) * 0.08;
    float h = (pow(v, 1.4) * 0.55 + jit * (0.3 + v)) * window * P_HEIGHT / z;
    float y = base + h;
    float d = p.y - y;
    // The line, a hairline in pixels, brighter where the spectrum is loud;
    // the newest one carries the kick.
    // Toward the horizon the ridges pack closer than the pixels can hold
    // them apart; there they fade, or the far range is a smear.
    float spacing = (HORIZON - FRONT) * 0.055 / (z * z);
    float depthFade = exp(-fi * 0.045) * smoothstep(1.5, 4.5, spacing / px);
    float fadeIn = i == 0 ? smoothstep(0.0, 0.35, scroll) : 1.0;
    float w = px * (1.1 + 0.6 * step(float(i), 0.5));
    float line = exp(-d * d / (w * w)) * fadeIn;
    vec3 c = mix(uPalMid.rgb, uPalHigh.rgb, clamp(v * 1.3, 0.0, 1.0));
    c = mix(c, vec3(1.0), 0.35 * v);
    float lvl = (0.35 + 0.9 * v + 0.6 * drop) * depthFade * (1.0 + 1.8 * uHit.x * amp * exp(-fi * 0.7));
    lineSum += c * line * lvl;
    if (d < 0.0) {
      // Inside this ridge: everything behind it is hidden. The fill is not
      // pure black, it carries the faintest light of its own peak.
      col = uPalBg.rgb * 0.2 + c * 0.02 * v * depthFade;
      break;
    }
  }
  col += lineSum;
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,
};
