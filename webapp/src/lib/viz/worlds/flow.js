// FLUX — colour carried by a current that never repeats.
//
// Psychedelic, deep, anything that drifts and swirls: the picture is dye in a
// moving fluid. Every band of the spectrum has its own emitter, circling the
// middle of the frame and pouring its colour into the current in proportion
// to how loud that band is — so the bass paints in the palette's low colour,
// the top end in its high one, and the mix of the music becomes the mix of
// the colours on screen.
//
//   THE CURRENT is the curl of a slowly turning noise field. A curl has no
//   sources and no sinks, which is exactly the property of real water: dye is
//   stretched into filaments and folded, never piled up or thinned out, and
//   that is what makes marbling look like marbling and not like a blur.
//   THE MEMORY is the previous frame, advected back along the current and
//   faded over two bars (longer in a breakdown, so the swirls hang).
//   Everything is scaled by the frame's own duration, so the picture flows at
//   the same speed at 30 fps and at 144.
//   THE KICK pours a ring of colour out round the middle; a chord change
//   turns the emitters to the next colours; the current quickens with the
//   drive and gusts on a drop.
//
// Parameters:
//   speed   current strength     scale   eddy size
//   fade    memory (beats)        ink     emission strength

import { onStamp } from "./kit.js";

export default {
  id: "flow",
  uses: ["noise"],
  feedback: true,
  params: { speed: 1, scale: 1, fade: 1, ink: 1 },
  look: { exposure: 1.0, bloom: 1.1, threshold: 0.75, saturation: 1.25 },

  fragment: `
// The current: the curl of a noise field that turns over the phrase.
vec2 curl(vec2 q, float t) {
  float e = 0.02;
  float a = gnoise(q + vec2(0.0, e) + t);
  float b = gnoise(q - vec2(0.0, e) + t);
  float c = gnoise(q + vec2(e, 0.0) - t);
  float d = gnoise(q - vec2(e, 0.0) - t);
  return vec2(a - b, -(c - d)) / (2.0 * e);
}

void main() {
  vec2 p = fragP();
  vec2 uv = gl_FragCoord.xy / uRes;
  float A = uFrame.z;
  float dtB = uS0.x;               // this frame's duration, in beats
  float amp = 0.6 + 0.4 * uCtl.x;
  float sc = 1.4 / max(P_SCALE, 0.2);
  float tt = uS0.y;                // the field's own slow time
  vec2 v = curl(p * sc, tt) + 0.45 * curl(p * sc * 2.3 + 5.0, tt * 1.3);
  // A slow swirl round the middle, so the whole frame circulates.
  vec2 rp = p - uHole.xy;
  v += vec2(-rp.y, rp.x) * 0.35 / (0.4 + dot(rp, rp));
  float speed = (0.1 + 0.1 * uFlow.x + 0.2 * envB(uSince.w, 2.0) * step(uSince.w, 8.0)) * P_SPEED;
  vec2 dp = v * speed * dtB;
  // Semi-Lagrangian advection: fetch what the current carried here.
  vec2 back = uv - vec2(dp.x / (2.0 * A), dp.y * 0.5);
  vec3 col = prev(back);
  // Bilinear fetches blur a little every frame, and a few hundred frames of
  // that is a fog. A light unsharp mask on the fetch gives the filaments
  // their edges back. It is applied EVERY frame, so its gain compounds: much
  // above this and the finest detail rings into rainbow zebra stripes.
  vec2 px1 = 1.0 / uRes;
  vec3 avg = (prev(back + vec2(px1.x, 0.0)) + prev(back - vec2(px1.x, 0.0)) + prev(back + vec2(0.0, px1.y)) + prev(back - vec2(0.0, px1.y))) * 0.25;
  col = max(col + (col - avg) * 0.07, vec3(0.0));
  // The memory fades over two bars — longer in a breakdown.
  float tau = (8.0 + 6.0 * uArc.z) * P_FADE;
  col *= exp(-dtB / tau);

  // --- the emitters: one per band, circling, pouring their colour ---
  float bars = uClock.y * uSpeed;
  float rotC = uS0.z;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float lvl = i < 4 ? (i == 0 ? uBandA.x : i == 1 ? uBandA.y : i == 2 ? uBandA.z : uBandA.w) : (i == 4 ? uBandB.x : uBandB.y);
    float ang = fi * TAU / 6.0 + bars * TAU * 0.0625 * (mod(fi, 2.0) < 0.5 ? 1.0 : -1.0);
    float orbit = 0.55 + 0.3 * step(3.0, fi);
    vec2 at = uHole.xy + vec2(cos(ang) * min(A, 1.8) * orbit * 1.25, sin(ang) * orbit);
    at += 0.08 * vec2(sin(bars * 1.3 + fi), cos(bars * 1.1 + fi * 2.0));
    float d2 = dot(p - at, p - at);
    float blob = exp(-d2 / 0.009);
    vec3 c = pal(fract(fi / 5.0 + rotC));
    col += c * blob * (0.3 + lvl) * dtB * 3.5 * P_INK * (0.5 + 0.5 * uMood.y);
  }
  // The kick's ring, poured round the middle in the moment it lands.
  float rim = uHole.z > 0.0 ? min(uHole.z, uHole.w) + 0.06 : 0.12;
  float ringK = step(uSince.y, 0.12) * amp;
  col += mix(uPalHigh.rgb, uPalAcc.rgb, fract(uCount.z * 0.37)) * exp(-pow((length(rp) - rim) / 0.012, 2.0)) * ringK * dtB * 12.0 * P_INK;
  // Keep the dye in range with a soft limit, not a clamp: a clamp flattens
  // the brightest swirls into plateaus, this lets them fade faster instead.
  // Scaled by the frame's duration like everything else here.
  col /= 1.0 + 0.3 * dtB * max(col.r, max(col.g, col.b));
  emit(col);
}
`,

  create({ state, flash }) {
    let t = 0;
    let rotC = 0;
    const chord = onStamp((m) => m.stamp.chord, () => {
      rotC += 0.2;
    });
    const drop = onStamp((m) => m.stamp.drop, () => flash(0.6));
    return {
      step(dt, m) {
        chord(m);
        drop(m);
        const dtB = Math.min(dt / m.beat, 0.5);
        // The field itself turns slowly: about a unit of noise per phrase.
        t += dtB * (0.03 + 0.03 * m.drive);
        state[0] = dtB;
        state[1] = t;
        state[2] = rotC;
      },
    };
  },
};
