// WOBBLE — the bass, as a membrane.
//
// Dubstep is one enormous sound at a time: a bass note run through a
// low-frequency oscillator, opened and shut at a subdivision of the beat. So
// this world has one subject, a thick glossy TUBE of light across the frame
// whose shape IS that oscillator — and a grid behind it that the tube pulls
// on, the way a heavy mass bends the space around it, so the wobble moves the
// whole picture and not just a line.
//
//   THE LFO. Its rate is a subdivision of the beat — a quarter, an eighth, a
//   triplet, a sixteenth — stepped by how hard the bass pushes, the way a
//   producer rides that knob. Its SHAPE is the skin's `wave`: 0 a sine (the
//   bend melodic dubstep is made of), 1 a square (riddim's gate: the tube jumps
//   between two positions instead of travelling), 2 a saw (brostep's scream).
//   THE TUBE is shaded as a cylinder — a dark core, a hot rim on top, a
//   specular line along it — and split into three chromatic copies whose
//   separation grows with the wobble's depth, so the heavier the sound the more
//   the picture comes apart.
//   THE WAKE. Four fading echoes of the LFO's last shapes trail behind the
//   tube, so the sound reads as swinging, not as a curve.
//   THE ARCS. Once the bass pushes, two filaments of current crackle along
//   the tube, re-struck every sixteenth: the distortion, drawn.
//   THE GRID behind it is displaced toward the tube, and ripples with each
//   main kick.
//   THE DROP tears it: the tube splits into ragged segments for a beat and
//   the grid snaps.
//
// Parameters:
//   wave   0 sine, 1 square, 2 saw     rate   LFO rate multiplier
//   split  chromatic separation         tear   drop tear strength
//   grid   background grid strength

export default {
  id: "wobble",
  uses: ["noise"],
  params: { wave: 0, rate: 1, split: 1, tear: 1, grid: 1, thick: 1 },
  look: { exposure: 1.0, bloom: 1.2, threshold: 0.75, saturation: 1.2 },

  fragment: `
float osc(float x) {
  float w = floor(P_WAVE + 0.5);
  if (w < 0.5) return sin(x);
  if (w < 1.5) return smoothstep(-0.12, 0.12, sin(x)) * 2.0 - 1.0;
  return 1.0 - 2.0 * fract(x / TAU);
}

// The tube's centre line at x, in p-space.
float lineY(float x, float ph, float depth) {
  float y0 = uHole.z > 0.0 ? clamp(uHoleR.z - 0.18, -0.85, -0.25) : 0.0;
  // Two oscillators: the LFO travelling along the tube, and a slow third
  // bending the whole line — a single sine is a ripple, and this is not.
  return y0 + (osc(ph + x * 2.4) * 0.22 + osc(ph * 0.33 - x * 0.9) * 0.1) * depth;
}

void main() {
  vec2 p = fragP();
  float beats = uClock.x * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float ph = uS0.x;
  float depth = (0.35 + 0.9 * uS0.y) * amp * (1.0 - 0.6 * uArc.z);
  float tear = envB(uSince.w, 2.0) * P_TEAR * step(uSince.w, 6.0);
  vec3 col = uPalBg.rgb * 0.45;

  // --- the grid, bent toward the tube ---
  float ly = lineY(p.x, ph, depth);
  float dy = p.y - ly;
  float pull = exp(-abs(dy) * 2.5) * 0.12 * depth;
  vec2 g = p;
  g.y -= sign(dy) * pull;
  // A ripple out of the tube on each main kick.
  float kr = uSince.y;
  g += normalize(vec2(0.0, dy) + 1e-4) * sin(abs(dy) * 30.0 - kr * 12.0) * exp(-kr * 1.5) * exp(-abs(dy) * 3.0) * 0.012;
  vec2 cell = abs(fract(g * vec2(8.0, 8.0)) - 0.5);
  float px = uFrame.w * 8.0;
  float lines = max(smoothstep(px * 1.2, 0.0, cell.x), smoothstep(px * 1.2, 0.0, cell.y));
  float gridFade = exp(-abs(dy) * 1.2) * 0.8 + 0.2;
  col += mix(uPalLow.rgb, uPalMid.rgb, 0.4) * lines * 0.18 * gridFade * P_GRID * (0.5 + 0.5 * uFlow.x);

  // --- the wobble's wake: the LFO's last shapes, fading behind it ---
  // The oscillator is a MOTION, and a single line only shows where it is;
  // four fading echoes a fraction of a cycle apart show where it has been,
  // which is what makes the sound read as swinging rather than as a curve.
  for (int k = 1; k <= 4; k++) {
    float fk = float(k);
    float yk = lineY(p.x, ph - fk * 0.32, depth);
    float dk = abs(p.y - yk);
    float wk = (0.004 + 0.003 * fk) * P_THICK;
    col += mix(uPalMid.rgb, uPalAcc.rgb, fk * 0.15) * (exp(-dk * dk / (wk * wk)) + 0.15 * glow(dk, wk * 4.0))
         * 0.22 * (1.0 - fk / 5.0) * (0.4 + 0.6 * depth);
  }

  // --- the tube, in three chromatic copies ---
  float thick = (0.03 + 0.05 * uBandA.y + 0.03 * uHit.y) * P_THICK;
  float sep = (0.004 + 0.018 * depth + 0.05 * tear) * P_SPLIT;
  vec3 tube = vec3(0.0);
  for (int c = 0; c < 3; c++) {
    float fc = float(c) - 1.0;
    float x = p.x + fc * sep;
    float y = lineY(x, ph, depth);
    // The drop tears the tube into segments that slip against each other.
    float segId = floor(x * 5.0);
    float slip = (hash11(segId + floor(beats)) - 0.5) * 0.25 * tear;
    float d = p.y - y - slip;
    float gap = step(0.85, fract(x * 5.0)) * tear;
    float body = smoothstep(thick, thick * 0.6, abs(d)) * (1.0 - gap);
    // Cylinder shading: dark core, hot rim on top, a specular line.
    float nrm = clamp(d / thick, -1.0, 1.0);
    float shade = 0.35 + 0.65 * pow(1.0 - nrm * nrm, 0.5);
    float rimL = exp(-pow((nrm - 0.55) / 0.12, 2.0));
    float halo = glow(abs(d), thick * 1.8) * 0.35;
    float v = body * (shade * 0.6 + rimL * 1.4) + halo;
    vec3 chan = c == 0 ? vec3(1.0, 0.0, 0.0) : c == 1 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
    vec3 base = mix(uPalMid.rgb, uPalHigh.rgb, 0.5 + 0.5 * fc);
    tube += chan * base * v * 3.0;
  }
  col += tube * (0.45 + 0.55 * uFlow.x) * (0.7 + 0.6 * uHit.x);

  // --- the arcs: current crackling along the tube when the bass pushes ---
  // Two filaments that follow the tube a little off it, re-struck every
  // sixteenth, as bright as the drive: the sound's distortion, drawn.
  float arcK = smoothstep(0.35, 0.8, uFlow.x) * (0.5 + 0.8 * uHit.y + 1.2 * tear) * (1.0 - uArc.z);
  if (arcK > 0.01) {
    float y = lineY(p.x, ph, depth);
    for (int k = 0; k < 2; k++) {
      float fk = float(k);
      float strike = floor(beats * 4.0) + fk * 7.0;
      if (hash11(strike * 1.3) < 0.35) continue;
      float n = fbm(vec2(p.x * 7.0 + strike * 3.1, fk * 5.0), 4);
      float ya = y + n * thick * 3.0 + (fk - 0.5) * thick * 1.4;
      float da = abs(p.y - ya);
      vec3 ac = mix(uPalHigh.rgb, vec3(0.85, 0.9, 1.0), 0.6);
      col += ac * (exp(-da * da / (uFrame.w * uFrame.w * 1.5)) * 1.4 + glow(da, 0.012) * 0.3) * arcK;
    }
  }
  // The sub under it: weight rising off the bottom of the frame as a haze,
  // not a flat band.
  float haze = fbm(vec2(p.x * 1.5 + beats * 0.05, p.y * 3.0 - beats * 0.2), 3) * 0.5 + 0.5;
  col += uPalLow.rgb * smoothstep(-0.5, -1.0, p.y) * uBandA.x * 0.22 * haze * haze * 1.6;
  col += uPalHigh.rgb * uHit2.w * 0.3;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, params, flash }) {
    // The LFO: its phase advances at a SUBDIVISION of the beat, and the
    // subdivision steps with how hard the bass pushes — a quarter, an eighth, a
    // triplet, a sixteenth. Integrated, so a change of rate never jumps.
    const RATES = [1, 2, 3, 4];
    let ph = 0;
    let depth = 0.3;
    let drop = null;
    return {
      step(dt, m) {
        const push = Math.min(0.999, m.weight * 0.9 + m.drive * 0.5);
        const rate = RATES[Math.floor(push * RATES.length)] * (params.rate || 1);
        ph += (dt / m.beat) * rate * Math.PI * 2 * 0.5;
        // Wrapped at a period both oscillators close on (osc(ph) and
        // osc(ph * 0.33) — 0.33 · 200π is 66π), so the uniform keeps its
        // precision through a whole night instead of stuttering hours in.
        if (ph > 200 * Math.PI) ph -= 200 * Math.PI;
        depth = m.ease(depth, Math.min(1, m.weight * 1.2 + 0.2 * m.drive), 0.5, dt);
        state[0] = ph;
        state[1] = depth;
        if (drop === null) drop = m.stamp.drop;
        if (m.stamp.drop !== drop) {
          drop = m.stamp.drop;
          flash(0.9);
        }
      },
    };
  },
};
