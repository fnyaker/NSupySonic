// HALO — the spectrum as a crown, and its echoes rippling outward.
//
// R&B, soul, neo-soul, a voice in front of everything: music where the
// artwork and the singer are the centre of the picture. So the picture is a
// frame for the cover — the spectrum drawn as a closed luminous line hugging
// it, and every sixteenth note that line is let go and ripples outward, so
// the last bars expand away from the artwork like rings on water:
//
//   THE CROWN is the live spectrum as a SHAPE, built from smooth harmonics of
//   the circle — the bass breathes the whole ring, the mids stretch it into an
//   ellipse, the highs ripple its edge — and drawn as a band of light with a hot
//   core, brightest on its inner edge, over a soft fill between it and the
//   cover.
//   THE ECHOES are the same line from the history, a sixteenth apart, each one
//   further out and fainter — the shape of the last four bars, frozen and
//   expanding. The kicks are the rings that swell.
//   THE HAZE. Heavy smoke, lit by the halo and dark out in the room; the
//   echoes are light going out THROUGH it, so they widen as they go and are
//   only seen where the smoke catches them. Every main kick sends the 808's
//   shockwave out through it — a ring of displacement that pushes the smoke
//   aside and lets it roll back.
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
  uses: ["noise"],
  params: { echoes: 1, reach: 1, dust: 1 },
  look: { exposure: 1.0, bloom: 1.3, threshold: 0.7, saturation: 1.2 },

  fragment: `${SHARED}
// The spectrum's level in [f0, f1]: live when \`row\` < 0, else a history row.
float bandAt(float f0, float f1, float row) {
  float y = row < 0.0 ? 0.25 : fract(uHistHead - row / 64.0);
  float s = 0.0;
  for (int i = 0; i < 3; i++) {
    float f = mix(f0, f1, (float(i) + 0.5) / 3.0);
    s += row < 0.0 ? texture(uSpec, vec2(f, y)).r : texture(uHist, vec2(f, y)).r;
  }
  return s / 3.0;
}

// How far the crown reaches at angle \`a\` (0 at the top). Not the spectrum
// laid round the circle bin by bin — that put the loudest bin, the sub, at one
// point, and every ring came out a teardrop with a spike at the bottom — but
// the spectrum as a SHAPE, built from smooth harmonics of the circle: the bass
// breathes the whole ring, the mids stretch it into an ellipse, the highs
// ripple its edge. No cusp is possible, and the shape still reads the music.
float shapeAt(float a, float row, float t) {
  float lo = bandAt(0.0, 0.12, row);
  float mi = bandAt(0.18, 0.45, row);
  float hi = bandAt(0.5, 0.9, row);
  return 0.5 * lo
       + 0.3 * mi * (0.5 + 0.5 * cos(2.0 * a))
       + 0.14 * hi * (0.5 + 0.5 * cos(6.0 * a + t))
       + 0.06 * hi * (0.5 + 0.5 * cos(11.0 * a - 1.7 * t));
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
  vec3 crownC = mix(uPalMid.rgb, uPalHigh.rgb, 0.4 + 0.4 * voice);
  float reach = 0.34 * P_REACH;
  float bars = uClock.y * uSpeed;

  // --- the haze the halo hangs in ---
  // Slow, heavy smoke, and the 808's shockwave running out through it on
  // every main kick: a ring of displacement, not a line — the smoke is pushed
  // aside and rolls back.
  float since = uSince.y;
  float waveR = R0 + since * 0.9;
  float wave = since < 3.0 ? exp(-pow((r - waveR) / 0.06, 2.0)) * exp(-since * 0.9) * amp : 0.0;
  vec2 sq = q * 1.3 + (q / max(r, 1e-3)) * wave * 0.08;
  vec2 w = vec2(fbm(sq * 0.8 + vec2(bars * 0.05, 0.0), 3), fbm(sq * 0.8 + vec2(3.1, -bars * 0.04), 3));
  float smoke = fbm(sq + 1.6 * w + vec2(0.0, -bars * 0.06), 5) * 0.5 + 0.5;
  smoke = smoothstep(0.25, 0.95, smoke);
  // Lit by the halo: brightest where the crown is, fading out into the room.
  float lit = exp(-max(r - R0, 0.0) * 1.3);
  vec3 col = uPalBg.rgb * 0.3 + mix(uPalLow.rgb, uPalMid.rgb, 0.35) * smoke * (0.025 + 0.12 * lit) * (0.6 + 0.6 * voice);
  col += crownC * wave * smoke * 0.35;

  // --- the crown ---
  float tw = uClock.y * uSpeed * 0.5;
  float s = shapeAt(a, -1.0, tw);
  float Rc = R0 + 0.02 + reach * s;
  float dc = r - Rc;
  // A band of light with a hot core, not a hairline: the core is a pixel or
  // two, the body a few hundredths wide and brightest on its inner edge,
  // where it faces the artwork.
  float body = exp(-dc * dc / (0.014 * 0.014)) * (1.0 + 0.6 * smoothstep(0.02, -0.02, dc));
  col += crownC * body * (0.25 + 0.3 * uHit.x * amp);
  col += mix(crownC, vec3(1.0), 0.5) * exp(-dc * dc / (px * px * 2.0)) * (0.8 + 0.8 * uHit.x * amp);
  col += crownC * glow(dc, 0.03) * 0.1;
  // With no artwork, the centre is a core of light that breathes with the
  // voice and the sub, so the crown has something to be the halo OF.
  if (uHole.z <= 0.0) {
    float core = exp(-r * r / (R0 * R0 * 0.5));
    col += mix(crownC, vec3(1.0), 0.3) * core * (0.25 + 0.35 * voice + 0.3 * uBandA.x + 0.3 * uHit.y * amp);
  }
  // A soft fill between the crown and the cover.
  col += crownC * smoothstep(Rc, R0, r) * step(R0, r) * 0.08 * (0.5 + voice);

  // --- the echoes, expanding ---
  int N = int(clamp(10.0 * P_ECHOES * (0.6 + 0.4 * uQual.x), 5.0, 24.0));
  float scroll = fract(uClock.x * 4.0);
  for (int i = 1; i <= 32; i++) {
    if (i > N) break;
    float fi = float(i) - 1.0 + scroll;
    float grow = fi * 0.075;
    float sh = shapeAt(a, float(i), tw - float(i) * 0.03);
    float Ri = R0 + 0.02 + grow + reach * sh * (1.0 + fi * 0.04);
    float di = r - Ri;
    float fade = exp(-fi * 0.22) * smoothstep(0.0, 0.6, fi + 0.2);
    vec3 ec = pal(fract(0.35 + fi * 0.025 + uS0.x));
    // An echo is light going out through the smoke: it widens as it goes,
    // and it is only seen where there is smoke to catch it.
    float wd = px * 1.1 + fi * 0.0015;
    col += ec * exp(-di * di / (wd * wd)) * fade * (0.12 + 0.55 * smoke) * min(1.0, px * 1.1 / wd);
    col += ec * glow(di, 0.012 + fi * 0.004) * fade * 0.03 * smoke;
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
          // Read only through fract(): wrapped, so it never grows.
          hue = (hue + 0.12) % 1;
        }
        state[0] = hue;
      },
    };
  },
};
