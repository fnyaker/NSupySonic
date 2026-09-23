// CARNAVAL — polyrhythm you can see.
//
// Samba, salsa, afrobeat, amapiano, soca, reggaeton: music built from
// patterns of different lengths turning against each other, meeting on the
// one. So the picture is a set of concentric rings of beads, each ring turning
// at its own subdivision of the bar — two, three, four, five, six, eight
// beads past the top every bar — and a bead LIGHTS as it crosses the top of
// its ring. Each ring is one pattern; where they coincide the top of the frame
// flares, which is the downbeat made visible, and the rest of the bar is the
// patterns sliding past one another.
//
//   THE BEADS are glossy spheres: a warm key light from above, a highlight,
//   a rim, their own colour — and the ones that have just struck glow.
//   THE RINGS lean toward the frame's shape like every ring in this set, so a
//   16:9 screen is filled to the sides.
//   THE MUSIC. The rings' speeds are subdivisions of the bar, so they ARE the
//   tempo; the kick flares the strike line; the drop throws confetti from the
//   top of the frame, and it keeps falling through the drop.
//
// Parameters:
//   rings   how many rings (2..6)    confetti  how much confetti
//   size    bead size

import { onStamp } from "./kit.js";

const CONFETTI = 360;

const SHARED = `
float ringR0() { return uHole.z > 0.0 ? max(uHole.z, uHole.w) * 1.02 + 0.08 : 0.15; }
vec2 ringLean() { return vec2(mix(1.0, uFrame.z, 0.6), 1.0); }
`;

export default {
  id: "carnival",
  uses: [],
  params: { rings: 6, confetti: 1, size: 1 },
  look: { exposure: 1.0, bloom: 1.3, threshold: 0.65, saturation: 1.25 },

  fragment: `${SHARED}
void main() {
  vec2 p = fragP();
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  vec2 lean = ringLean();
  vec2 q = (p - uHole.xy) / lean;
  float r = length(q);
  float R0 = ringR0();
  // Spaced so the outer ring stays inside the frame.
  float dr = min(0.14, (0.9 - R0) / max(P_RINGS - 1.0, 1.0));
  int nr = int(clamp(P_RINGS, 2.0, 6.0));
  // The room: warm and dark, a glow round the rings.
  vec3 col = uPalBg.rgb * 0.4 + mix(uPalLow.rgb, uPalMid.rgb, 0.4) * exp(-r * 1.2) * 0.04;
  // The strike line: straight up from the centre, flaring on the kick.
  float strike = exp(-pow(q.x / 0.03, 2.0)) * step(0.0, q.y) * exp(-q.y * 0.6);
  col += mix(uPalHigh.rgb, vec3(1.0), 0.4) * strike * (0.04 + 0.2 * uHit.y * amp);

  float kf = (r - R0) / dr;
  for (int o = -1; o <= 1; o++) {
    float k = floor(kf + 0.5) + float(o);
    if (k < 0.0 || k >= float(nr)) continue;
    float Rk = R0 + k * dr;
    // Ring k: a subdivision of the bar, and enough beads to show it.
    float pulses = k < 0.5 ? 2.0 : k < 1.5 ? 3.0 : k < 2.5 ? 4.0 : k < 3.5 ? 5.0 : k < 4.5 ? 6.0 : 8.0;
    float n = floor(TAU * Rk / 0.085);
    float spacing = TAU / n;
    // Turned so a bead crosses the top on every pulse, alternate rings the
    // other way round.
    float dir = mod(k, 2.0) < 0.5 ? 1.0 : -1.0;
    float turn = bars * pulses * spacing * dir;
    float a = atan(q.y, q.x) - turn;
    float bi = floor(a / spacing + 0.5);
    float ba = bi * spacing + turn;               // the bead's angle, on screen
    vec2 bc = uHole.xy + vec2(cos(ba), sin(ba)) * Rk * lean;
    float br = (0.022 + 0.004 * k) * P_SIZE;
    vec2 d = (p - bc) / br;
    float dd = length(d);
    // How recently this bead crossed the top: it lights, then cools.
    float fromTop = mod(PI * 0.5 - ba + PI, TAU) - PI;          // signed angle to the top
    float since = (-fromTop * dir) / (pulses * spacing);           // bars since it struck
    float lit = since >= 0.0 ? exp(-since * 10.0) : 0.0;
    vec3 base = pal(fract(k * 0.17 + 0.1));
    if (dd < 1.0) {
      // A glossy sphere under a warm key light.
      vec3 nrm = vec3(d, sqrt(max(1.0 - dd * dd, 0.0)));
      vec3 L = normalize(vec3(-0.4, 0.7, 0.6));
      float diff = max(dot(nrm, L), 0.0);
      float spec = pow(max(dot(reflect(-L, nrm), vec3(0.0, 0.0, 1.0)), 0.0), 40.0);
      vec3 bead = base * (0.12 + 0.5 * diff) + vec3(1.0) * spec * 0.6 + base * pow(1.0 - nrm.z, 3.0) * 0.3;
      bead += mix(base, vec3(1.0), 0.5) * lit * 1.8;
      col = mix(col, bead, smoothstep(1.0, 1.0 - uFrame.w / br * 1.5, dd));
    } else {
      col += base * glow(dd - 1.0, 0.6) * lit * 0.35;
    }
    // The track the beads run on: a hairline.
    float track = exp(-pow((r - Rk) / (uFrame.w * 1.2), 2.0));
    col += base * track * 0.05;
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.04));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  particles: {
    count: CONFETTI,
    vertex: `${SHARED}
void particle(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind) {
  float j = float(id);
  col = vec4(0.0); pos = vec2(0.0); axis = vec2(0.0); width = 0.0; kind = 0.0;
  float amount = uS0.x * P_CONFETTI;
  if (j >= ${CONFETTI}.0 * amount * (0.5 + 0.5 * uQual.y)) return;
  vec3 h = hash31(j * 1.9 + 0.3);
  // Falling through the frame on its own cycle, fluttering as it goes.
  float fall = 0.12 + 0.1 * h.z;
  float cyc = uClock.x * fall * 0.5 + h.y;
  float y = 1.15 - fract(cyc) * 2.3;
  float A = uFrame.z;
  float x = (h.x * 2.0 - 1.0) * (A + 0.1) + sin(uClock.x * (1.0 + h.z) + j) * 0.05;
  pos = vec2(x, y);
  // A paper square turning: its width shrinks as it turns edge-on.
  float spin = uClock.x * (2.0 + 3.0 * h.z) + j;
  float face = abs(cos(spin));
  axis = vec2(cos(spin * 0.7), sin(spin * 0.7)) * 0.016;
  width = 0.011 * (0.15 + 0.85 * face);
  vec3 c = pal(fract(h.x * 0.9 + h.y * 0.3));
  col = vec4(c * (0.35 + 0.65 * face) * 0.9, 1.0);
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  float edge = smoothstep(1.0, 0.8, max(abs(q.x), abs(q.y)));
  return vec4(c.rgb * edge, 1.0);
}
`,
  },

  create({ state, flash }) {
    let confetti = 0;
    const drop = onStamp((m) => m.stamp.drop, () => {
      confetti = 1;
      flash(0.6);
    });
    return {
      step(dt, m) {
        drop(m);
        // Confetti through the drop, thinning out over eight bars; a trickle
        // while the music drives hard.
        confetti = Math.max(0, confetti - dt / m.overBeats(32));
        if (m.breakdown > 0.5) confetti = Math.max(0, confetti - dt / m.overBeats(2));
        state[0] = Math.max(confetti, m.drive > 0.6 ? 0.08 : 0);
      },
    };
  },
};
