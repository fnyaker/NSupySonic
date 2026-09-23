// SOIE — ribbons of silk, carried by the voice.
//
// Pop ballads, soul, R&B, anything sung: the picture is fabric in slow
// motion. A few long ribbons of silk across the frame, folding and twisting,
// the light running along their sheen.
//
//   THE TWIST is what makes a ribbon read as silk and not as a line: each one
//   turns about its own length, so where it twists edge-on it narrows to a
//   thread and then widens again showing its OTHER face, in another colour.
//   Its sheen follows the twist — a band of light slides across the ribbon as
//   the surface turns toward the lamp and away — which is how a satin weave
//   actually catches light.
//   THE MOTION. The ribbons are long, slow waves whose phase is the bar
//   clock and whose amplitude is the voice: a melody lifts and spreads them,
//   a breakdown lets them lie almost flat. The kick sends a ripple running
//   along every ribbon; the drop unfurls them wide.
//   THE LAYERING. Drawn back to front, each translucent, so where two cross
//   their colours mix the way layered chiffon does.
//
// Parameters:
//   ribbons  how many (1..5)     width  ribbon width
//   twist    turns along a ribbon

export default {
  id: "silk",
  uses: [],
  params: { ribbons: 5, width: 1, twist: 1 },
  look: { exposure: 1.0, bloom: 1.2, threshold: 0.75, saturation: 1.2 },

  fragment: `
void main() {
  vec2 p = fragP();
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float voice = uBandB.w;
  float px = uFrame.w;
  // The room: a soft gradient, darker at the edges of the fabric's light.
  vec3 col = mix(uPalBg.rgb * 0.5, uPalLow.rgb * 0.06, smoothstep(-1.0, 1.0, p.y));
  // The light the fabric throws on the room, strongest along its path.
  col += mix(uPalLow.rgb, uPalMid.rgb, 0.5) * 0.035 * (0.6 + 0.4 * uS0.x) * exp(-p.y * p.y * 1.2);
  int n = int(clamp(P_RIBBONS, 1.0, 5.0));
  float lift = 0.35 + 0.65 * uS0.x;          // the voice, eased
  float unfurl = uS0.y;                       // the drop, eased
  for (int i = 4; i >= 0; i--) {
    if (i >= n) continue;
    float fi = float(i);
    vec3 h = hash31(fi * 5.1 + 1.3);
    // The ribbon's centre line: two slow waves, phase on the bar clock.
    float x = p.x;
    float ph = bars * (0.12 + 0.06 * h.x) + h.y * TAU;
    float base = mix(-0.74, 0.7, (fi + 0.5) / float(n)) + (h.z - 0.5) * 0.2;
    float y = base + (sin(x * (0.9 + 0.5 * h.x) + ph) * 0.22 + sin(x * (2.1 + 0.7 * h.y) - ph * 1.3) * 0.08) * lift;
    float dy = (cos(x * (0.9 + 0.5 * h.x) + ph) * 0.22 * (0.9 + 0.5 * h.x) + cos(x * (2.1 + 0.7 * h.y) - ph * 1.3) * 0.08 * (2.1 + 0.7 * h.y)) * lift;
    // The kick's ripple running along it.
    float kr = uSince.x;
    float kfront = -uFrame.z + kr * 1.8;
    float bump = exp(-pow((x - kfront) * 4.0, 2.0)) * envB(kr, 1.0) * 0.06 * amp;
    y += bump;
    // The twist: the ribbon turns about its length.
    float th = x * (0.7 + 0.4 * h.z) * P_TWIST + bars * 0.2 + fi * 1.7;
    float c = cos(th);
    float hw = (0.07 + 0.04 * h.x) * P_WIDTH * (1.0 + 0.8 * unfurl) * (0.12 + 0.88 * abs(c));
    // Distance across it, corrected for the slope so the width is true.
    float slope = sqrt(1.0 + dy * dy);
    float d = (p.y - y) / slope;
    float inside = smoothstep(hw + px, hw - px, abs(d));
    if (inside <= 0.0) continue;
    float s = d / max(hw, 1e-4);              // -1..1 across the ribbon
    // Which face is toward us, and its colour.
    vec3 faceA = pal(fract(0.15 + fi * 0.21 + x * 0.05));
    vec3 faceB = mix(uPalAcc.rgb, pal(fract(0.6 + fi * 0.21)), 0.4) * 0.7;
    vec3 face = c > 0.0 ? faceA : faceB;
    // The sheen: a band of light that slides across as the surface turns.
    float turn = th + s * 0.9;
    float sheen = pow(abs(sin(turn)), 14.0);
    float body = 0.25 + 0.35 * (1.0 - s * s);
    vec3 fabric = face * body * (0.5 + 0.5 * voice + 0.3 * uFlow.x) + mix(face, vec3(1.0), 0.5) * sheen * (0.5 + 0.8 * voice);
    // A thin bright hem along both edges.
    fabric += mix(face, vec3(1.0), 0.4) * exp(-pow((abs(d) - hw) / (px * 1.2), 2.0)) * 0.35;
    // Translucent, like chiffon: what is behind shows through a little.
    col = mix(col, fabric, inside * 0.82);
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state }) {
    let lift = 0.5;
    let unfurl = 0;
    let lastDrop = null;
    return {
      step(dt, m, clocks) {
        if (lastDrop === null) lastDrop = m.stamp.drop;
        if (m.stamp.drop !== lastDrop) {
          lastDrop = m.stamp.drop;
          unfurl = 1;
        }
        const voice = clocks?.melody ?? 0;
        lift = m.ease(lift, Math.min(1, 0.25 + 0.9 * voice + 0.3 * m.drive - 0.3 * m.breakdown), 2, dt);
        unfurl = Math.max(0, unfurl - dt / m.overBeats(16));
        state[0] = lift;
        state[1] = unfurl * unfurl;
      },
    };
  },
};
