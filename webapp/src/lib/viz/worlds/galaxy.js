// GALAXIE — a spiral galaxy, breathing with the bass.
//
// Progressive trance, melodic techno, anything that builds for minutes toward
// one release: the picture is the largest slow thing there is. A spiral
// galaxy seen at an angle, its arms turning once every sixteen bars, its core
// breathing with the bass.
//
//   THE STARS are instanced — two thousand at the high tier — each placed on
//   a logarithmic arm (the shape real spiral arms follow) with a scatter that
//   widens toward the rim, a few in the field between the arms, and a bulge of
//   old yellow stars round the core. The arms are a PATTERN that turns
//   rigidly, the way a density wave does, so they never wind themselves up
//   the way arms drawn from orbiting stars would.
//   THE DISK behind them is the same spiral evaluated per pixel: the diffuse
//   glow of the arms, the dark dust lane along each arm's inner edge (which
//   is what makes a galaxy look like a photograph and not a pinwheel), pink
//   star-forming knots strung along the arms.
//   THE MUSIC. The core swells with the sub; each main kick sends a density
//   wave rippling out through the disk; the knots flare on melody notes; a
//   build speeds the turn and the drop sets off a supernova in an arm.
//
// Parameters:
//   arms    arm count (2 or 4)      tilt   viewing angle (0 face-on .. 1 steep)
//   stars   star density (x)        dust   dust lane strength

import { eventRing, onStamp, hashN } from "./kit.js";

const STARS = 2000;

const SHARED = `
float ARMS() { return max(1.0, floor(P_ARMS + 0.5)); }
float PITCH() { return 0.28; }
float tiltC() { return mix(0.95, 0.42, clamp(P_TILT, 0.0, 1.0)); }
// The disk's scale: its arms reach the sides of the frame.
float diskR() { return 0.95 * max(uFrame.z, 1.0); }
// The arm phase at disk radius r (disk units) and angle a.
float armPhase(float r, float a) {
  return ARMS() * (a - log(max(r, 0.02) / 0.1) / tan(PITCH()) - uS0.x);
}
// Screen <-> disk: the disk is tilted about the x axis, then turned a little.
const float SCREEN_TURN = 0.35;
`;

export default {
  id: "galaxy",
  uses: ["noise"],
  params: { arms: 2, tilt: 0.6, stars: 1, dust: 1 },
  look: { exposure: 1.0, bloom: 1.35, threshold: 0.65, saturation: 1.15 },

  fragment: `${SHARED}
void main() {
  vec2 p = fragP();
  vec2 s = rot(-SCREEN_TURN) * (p - uHole.xy);
  // Deproject onto the disk.
  vec2 d = vec2(s.x, s.y / tiltC()) / diskR();
  float r = length(d);
  float a = atan(d.y, d.x);
  float amp = 0.6 + 0.4 * uCtl.x;
  vec3 col = uPalBg.rgb * 0.35;

  // A background of faint stars, fixed on the sky, and the interstellar
  // clouds of our own galaxy in front of the far one, drifting slowly.
  vec2 sg = floor(p * 90.0);
  float bs = step(0.985, hash12(sg)) * hash12(sg + 1.3);
  col += vec3(0.8, 0.85, 1.0) * bs * 0.15;
  vec2 cp = p * 0.9 + vec2(uClock.z * 0.05, 0.0);
  float cl = fbm(cp * 1.6, 5);
  float cl2 = fbm(cp * 3.1 + 7.0, 4);
  col += mix(uPalLow.rgb, uPalAcc.rgb, cl2) * smoothstep(0.05, 0.6, cl) * 0.05 * (0.6 + 0.4 * uMood.y);

  // --- the disk: exponential light, arms, dust, knots ---
  float disk = exp(-r * 2.6);
  float ph = armPhase(r, a);
  float arm = pow(0.5 + 0.5 * cos(ph), 3.0);
  // The dust lane runs along the INNER edge of each arm.
  float lane = pow(0.5 + 0.5 * cos(ph + 0.9), 8.0);
  float n = gnoise(d * 14.0 + uS0.x) * 0.5 + 0.5;
  float n2 = gnoise(d * 40.0) * 0.5 + 0.5;
  vec3 armC = mix(uPalMid.rgb, vec3(0.75, 0.85, 1.0), 0.4);
  vec3 glowC = armC * disk * (0.25 + 1.4 * arm * (0.6 + 0.4 * n)) * 0.55;
  // The density wave from the last main kick, rippling outward.
  float wr = uSince.y * 0.35;
  float wave = exp(-pow((r - wr) / 0.05, 2.0)) * envB(uSince.y, 1.5) * amp;
  glowC += armC * wave * (0.3 + arm) * 0.35;
  // Dust: darkens the light behind it.
  glowC *= 1.0 - 0.75 * lane * smoothstep(0.05, 0.25, r) * P_DUST * (0.6 + 0.4 * n2);
  col += glowC * (0.7 + 0.3 * uFlow.x);
  // Star-forming knots: pink, strung along the arms, flaring with the melody.
  vec2 kg = d * 18.0;
  vec2 kid = floor(kg);
  vec2 kp = fract(kg) - 0.5;
  float kh = hash12(kid);
  float knot = smoothstep(0.25, 0.0, length(kp - (hash22(kid) - 0.5) * 0.5)) * step(0.8, kh) * arm * smoothstep(0.1, 0.3, r);
  col += mix(uPalAcc.rgb, vec3(1.0, 0.45, 0.65), 0.5) * knot * (0.12 + 0.5 * uHit2.y * amp);

  // --- the bulge: old yellow light, breathing with the sub ---
  float bR = 0.08 + 0.035 * uBandA.x;
  float bulge = exp(-pow(r / bR, 1.2));
  col += mix(vec3(1.0, 0.85, 0.6), uPalHigh.rgb, 0.25) * bulge * (0.35 + 0.5 * uBandA.x + 0.3 * uHit.x * amp);

  // --- the supernova the drop sets off ---
  for (int i = 0; i < 8; i++) {
    vec4 ev = uEv[i];
    float age = uClock.x - ev.x;
    if (ev.y <= 0.0 || age < 0.0 || age > 16.0) continue;
    vec2 at = uHole.xy + rot(SCREEN_TURN) * vec2(ev.z, ev.w);
    float dd = length(p - at);
    float k = exp(-age * 0.35);
    col += mix(vec3(1.0), uPalAcc.rgb, 0.3) * (glow(dd, 0.006 + 0.02 * k) * 2.0 + exp(-dd * 6.0) * 0.2) * k * ev.y;
    // Its shell, expanding.
    col += uPalHigh.rgb * exp(-pow((dd - age * 0.02) / 0.006, 2.0)) * k * 0.4 * ev.y;
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  particles: {
    count: STARS,
    vertex: `${SHARED}
void particle(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind) {
  float j = float(id);
  col = vec4(0.0); pos = vec2(0.0); axis = vec2(0.0); width = 0.0; kind = 0.0;
  if (j >= ${STARS}.0 * P_STARS * uQual.y) return;
  vec3 h = hash31(j * 0.713 + 5.1);
  vec3 h2 = hash31(j * 1.917 + 2.3);
  float r;
  float a;
  vec3 c;
  float bright;
  if (h2.z < 0.18) {
    // The bulge: a round cloud of old yellow stars.
    r = abs(h.x - 0.5) * 0.22 * (0.3 + h.y);
    a = h.z * TAU;
    c = vec3(1.0, 0.85, 0.6);
    bright = 0.5 + 0.8 * h2.x;
  } else {
    // The disk: an exponential falloff, most of it on the arms.
    r = -log(1.0 - h.x * 0.985) * 0.3 + 0.03;
    float armIdx = floor(h.y * ARMS());
    float onArm = step(0.28, h2.x);
    float spread = (h.z - 0.5) * (0.35 + 0.9 * r) * (onArm > 0.5 ? 0.45 : 6.0);
    a = log(max(r, 0.02) / 0.1) / tan(PITCH()) + armIdx * TAU / ARMS() + uS0.x + spread;
    // Young blue stars on the arms, older ones between them.
    c = onArm > 0.5 ? mix(vec3(0.7, 0.8, 1.0), uPalHigh.rgb, 0.35) : mix(vec3(1.0, 0.9, 0.8), uPalMid.rgb, 0.3);
    bright = (0.25 + 0.9 * pow(h2.y, 3.0)) * (onArm > 0.5 ? 1.0 : 0.5);
  }
  // Each star drifts a little along its orbit, so the field is never still.
  a += sin(uClock.x * 0.05 + j) * 0.01;
  vec2 dsk = vec2(cos(a), sin(a)) * r * diskR();
  vec2 scr = vec2(dsk.x, dsk.y * tiltC());
  pos = uHole.xy + rot(SCREEN_TURN) * scr;
  if (abs(pos.x) > uFrame.z + 0.05 || abs(pos.y) > 1.05) return;
  // Twinkle, and a pulse through the disk on the kick.
  float tw = 0.75 + 0.25 * sin(uClock.x * (2.0 + 3.0 * h.x) + j);
  float wave = exp(-pow((r - uSince.y * 0.35) / 0.05, 2.0)) * envB(uSince.y, 1.5);
  axis = vec2(0.0015 + 0.003 * bright, 0.0);
  width = axis.x;
  col = vec4(c * bright * tw * (1.0 + 1.5 * wave) * 1.3, 1.0);
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  float d = length(q);
  return vec4(c.rgb * (exp(-d * d * 5.0) + 0.1 * max(0.0, 1.0 - d)), 1.0);
}
`,
  },

  create({ ev, state, flash }) {
    const ring = eventRing(ev);
    let turn = 0;
    let n = 0;
    const drop = onStamp((m) => m.stamp.drop, (s) => {
      // A supernova somewhere along an arm, clear of the middle.
      const r = 0.35 + 0.35 * hashN(n);
      const a = hashN(n + 11) * Math.PI * 2;
      n++;
      ring.push(s, 1, Math.cos(a) * r, Math.sin(a) * r * 0.55);
      flash(0.7);
    });
    return {
      step(dt, m) {
        drop(m);
        // The pattern turns once every sixteen bars, faster through a build.
        turn += (dt / m.bar) * ((Math.PI * 2) / 16) * (1 + 1.5 * m.build + 0.4 * m.drive);
        state[0] = turn;
      },
    };
  },
};
