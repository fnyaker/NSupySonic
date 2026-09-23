// HALO — the spectrum as a crown, and its echoes rippling outward.
//
// R&B, soul, neo-soul, a voice in front of everything: music where the
// artwork and the singer are the centre of the picture. So the picture is a
// frame for the cover — the spectrum drawn as a closed luminous line hugging
// it, and every sixteenth note that line is let go and ripples outward, so
// the last bars expand away from the artwork like rings on water:
//
//   THE CROWN is the live spectrum, mirrored left and right so it is
//   symmetrical about the artwork (the bass at the bottom, the air at the
//   top), smoothed along its length and drawn as a line with its true pixel
//   width, over a soft fill of light between it and the cover.
//   THE ECHOES are the same line from the history, a sixteenth apart, each one
//   further out and fainter — the shape of the last four bars, frozen and
//   expanding. The kicks are the rings with a bulge at the bottom.
//   THE DUST. Motes of light orbit in the halo, thrown outward on the kick
//   and drifting back.
//   THE VOICE. A melody present brightens the crown and warms it toward the
//   palette's high colour; a chord change shifts the echoes' hue.
//
// Parameters:
//   echoes  how many rings (x)     reach   how far a spectrum peak pushes
//   dust    motes strength

const MOTES = 500;

const SHARED = `
float haloR0() {
  return uHole.z > 0.0 ? length(uHole.zw) * 0.78 + 0.03 : 0.3;
}
`;

export default {
  id: "halo",
  uses: [],
  params: { echoes: 1, reach: 1, dust: 1 },
  look: { exposure: 1.0, bloom: 1.3, threshold: 0.7, saturation: 1.2 },

  fragment: `${SHARED}
// The spectrum as a function of angle: mirrored about the vertical, bass at
// the bottom. \`row\` < 0 reads the live spectrum; otherwise a history row.
// Three taps along the spectrum, so a single loud bin becomes a swell and
// not a spike — the crown is a line of light, not a bar chart.
float specAt(float a, float row) {
  // A mirrored angle has a cusp on the axis; rounding it off there keeps the
  // rings smooth at the top and bottom instead of zipped.
  float aa = abs(a);
  aa = sqrt(aa * aa + 0.03) - 0.173;
  aa = PI - (sqrt((PI - aa) * (PI - aa) + 0.03) - 0.173);
  float f = 1.0 - clamp(aa / PI, 0.0, 1.0);  // bass at the bottom, air at the top
  f = pow(clamp(f, 0.0, 1.0), 0.8);
  float e = 0.025;
  if (row < 0.0) {
    return (texture(uSpec, vec2(f - e, 0.25)).r + 2.0 * texture(uSpec, vec2(f, 0.25)).r + texture(uSpec, vec2(f + e, 0.25)).r) * 0.25;
  }
  float y = fract(uHistHead - row / 64.0);
  return (texture(uHist, vec2(f - e, y)).r + 2.0 * texture(uHist, vec2(f, y)).r + texture(uHist, vec2(f + e, y)).r) * 0.25;
}

void main() {
  vec2 p = fragP() - uHole.xy;
  float amp = 0.6 + 0.4 * uCtl.x;
  // An ellipse leaning toward the frame, like every ring in here.
  vec2 lean = vec2(mix(1.0, uFrame.z, 0.35), 1.0);
  vec2 q = p / lean;
  float r = length(q);
  float a = atan(q.x, q.y);        // 0 at the top, +-PI at the bottom
  float R0 = haloR0();
  float px = uFrame.w;
  float voice = uBandB.w;
  // The room the halo hangs in: a haze of the palette, lit from the middle.
  vec3 col = uPalBg.rgb * 0.35 + mix(uPalLow.rgb, uPalMid.rgb, 0.3) * (0.035 + 0.03 * voice) * exp(-r * 0.6);
  vec3 crownC = mix(uPalMid.rgb, uPalHigh.rgb, 0.4 + 0.4 * voice);
  float reach = 0.34 * P_REACH;

  // --- the crown ---
  float s = specAt(a, -1.0);
  float Rc = R0 + 0.02 + reach * pow(s, 1.2);
  float dc = r - Rc;
  col += crownC * exp(-dc * dc / (px * px * 2.0)) * (0.7 + 0.8 * uHit.x * amp);
  col += crownC * glow(dc, 0.02) * 0.12;
  // With no artwork, the centre is a core of light that breathes with the
  // voice and the sub, so the crown has something to be the halo OF.
  if (uHole.z <= 0.0) {
    float core = exp(-r * r / (R0 * R0 * 0.5));
    col += mix(crownC, vec3(1.0), 0.3) * core * (0.25 + 0.35 * voice + 0.3 * uBandA.x + 0.3 * uHit.y * amp);
  }
  // A soft fill between the crown and the cover.
  col += crownC * smoothstep(Rc, R0, r) * step(R0, r) * 0.08 * (0.5 + voice);

  // --- the echoes, expanding ---
  int N = int(clamp(12.0 * P_ECHOES * (0.6 + 0.4 * uQual.x), 6.0, 32.0));
  float scroll = fract(uClock.x * 4.0);
  for (int i = 1; i <= 32; i++) {
    if (i > N) break;
    float fi = float(i) - 1.0 + scroll;
    float grow = fi * 0.075;
    float sh = specAt(a, float(i));
    float Ri = R0 + 0.02 + grow + reach * pow(sh, 1.2) * (1.0 + fi * 0.04);
    float di = r - Ri;
    float fade = exp(-fi * 0.22) * smoothstep(0.0, 0.6, fi + 0.2);
    vec3 ec = pal(fract(0.35 + fi * 0.025 + uS0.x));
    col += ec * exp(-di * di / (px * px * 1.2)) * fade * 0.45;
    col += ec * glow(di, 0.01) * fade * 0.02;
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(fragP(), 0.03));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  particles: {
    count: MOTES,
    vertex: `${SHARED}
void particle(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind) {
  float j = float(id);
  col = vec4(0.0); pos = vec2(0.0); axis = vec2(0.0); width = 0.0; kind = 0.0;
  if (j >= ${MOTES}.0 * P_DUST * uQual.y) return;
  vec3 h = hash31(j * 1.37 + 0.7);
  float R0 = haloR0();
  // An orbit in the halo, slower further out.
  float rr = R0 + 0.05 + pow(h.x, 1.5) * 1.3;
  float a = h.y * TAU + uClock.x * 0.06 / (0.3 + rr) * (h.z > 0.5 ? 1.0 : -1.0);
  // The kick throws them outward; they drift back.
  float push = envB(uSince.y, 0.6) * 0.06 * (0.5 + h.z);
  rr += push;
  vec2 lean = vec2(mix(1.0, uFrame.z, 0.35), 1.0);
  pos = uHole.xy + vec2(sin(a), cos(a)) * rr * lean;
  float tw = 0.5 + 0.5 * sin(uClock.x * (1.5 + 2.0 * h.z) + j);
  width = 0.0025 + 0.003 * h.z;
  axis = vec2(width, 0.0);
  col = vec4(mix(uPalHigh.rgb, vec3(1.0), 0.4) * (0.2 + 0.6 * tw) * exp(-(rr - R0) * 0.9), 1.0);
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  float d = length(q);
  return vec4(c.rgb * exp(-d * d * 4.0), 1.0);
}
`,
  },

  create({ state }) {
    let hue = 0;
    let lastChord = null;
    return {
      step(dt, m) {
        if (lastChord === null) lastChord = m.stamp.chord;
        if (m.stamp.chord !== lastChord) {
          lastChord = m.stamp.chord;
          hue += 0.12;
        }
        state[0] = hue;
      },
    };
  },
};
