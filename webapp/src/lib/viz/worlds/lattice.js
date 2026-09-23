// TREILLIS — flight through an infinite lattice of light.
//
// Minimal techno, dub techno, progressive: music made of a grid and of time
// spent moving through it. So the picture is a space frame — rods along all
// three axes, repeating for ever — that the camera flies through at exactly
// one cell per beat, banking gently on the bar.
//
//   THE RODS are raymarched: one cell of the lattice is three cylinders, and
//   the whole infinite frame is that cell repeated, so its cost does not
//   depend on how much of it is in view. Every step of the march also
//   GATHERS the light of the rods it passes, which is what makes them glow
//   in the air around them rather than sit on it.
//   THE CURRENT. Pulses of light run along the rods that point the way you
//   are flying, each on its own phase, twice as fast as the flight, so the
//   frame is always carrying something past you.
//   THE GATES. A main kick lights the whole cross-section of rods a couple of
//   cells ahead, and the camera flies through it a beat later.
//   THE ARRANGEMENT. A build accelerates the flight and tightens the fog; a
//   drop banks the camera hard and floods the frame; a breakdown slows to a
//   drift and lets the pulses run on alone.
//
// Parameters:
//   rod     rod thickness       pulses  current strength
//   bank    how far the camera rolls        march  step budget (x tier)

import { onStamp } from "./kit.js";

export default {
  id: "lattice",
  uses: [],
  params: { rod: 1, pulses: 1, bank: 1, march: 64, twist: 0 },
  look: { exposure: 1.0, bloom: 1.3, threshold: 0.7, saturation: 1.15 },

  fragment: `
// The cell: rods along x, y and z. \`axis\` names the nearest one.
float cellRods(vec3 p, out float axis) {
  vec3 q = fract(p) - 0.5;
  float r = 0.028 * P_ROD;
  float dx = length(q.yz);
  float dy = length(q.xz);
  float dz = length(q.xy);
  float d = min(dx, min(dy, dz));
  axis = d == dx ? 0.0 : d == dy ? 1.0 : 2.0;
  return d - r;
}

void main() {
  vec2 p = fragP();
  float beats = uClock.x * uSpeed;
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float cam = uS0.x;
  // The camera: between the rods, flying +z, banking on the bar.
  vec3 ro = vec3(0.02 * sin(bars * PI * 0.5), 0.02 * cos(bars * PI * 0.25), cam);
  vec3 rd = normalize(vec3(p, 1.25));
  float roll = uS0.y + 0.08 * sin(bars * PI * 0.25) * P_BANK;
  rd.xy *= rot(roll);
  rd.xz *= rot(0.12 * sin(bars * PI * 0.125) * P_BANK);

  int steps = int(clamp(P_MARCH * uQual.x, 28.0, 96.0));
  float t = 0.02;
  vec3 glowC = vec3(0.0);
  float hitT = -1.0;
  float axis = 0.0;
  vec3 cx = mix(uPalLow.rgb, uPalMid.rgb, 0.6);
  vec3 cy = mix(uPalMid.rgb, uPalHigh.rgb, 0.3);
  vec3 cz = mix(uPalHigh.rgb, uPalAcc.rgb, 0.2);
  float fogK = 0.3 + 0.12 * uArc.y - 0.08 * uArc.z;
  float gateZ = floor(cam) + 3.0;
  float gate = uHit.y * amp;
  for (int i = 0; i < 96; i++) {
    if (i >= steps) break;
    vec3 pos = ro + rd * t;
    float a;
    float d = cellRods(pos, a);
    // The light of the rod we are passing, gathered in the air around it.
    float fog = exp(-t * fogK);
    vec3 c = a < 0.5 ? cx : a < 1.5 ? cy : cz;
    // The cross rods are structure, dim; the flight rods carry the light.
    float e = a > 1.5 ? 0.012 : 0.005;
    if (a > 1.5) {
      // The current along the flight rods.
      vec2 cell = floor(pos.xy);
      float ph = fract(pos.z * 0.25 - beats * 0.5 + hash12(cell) );
      e += exp(-pow((ph - 0.5) * 9.0, 2.0)) * 0.12 * P_PULSES * (0.4 + 0.6 * uFlow.x);
    } else {
      // The gate: the cross-section a few cells ahead, lit by the kick.
      float gz = exp(-pow((pos.z - gateZ) * 3.0, 2.0));
      e += gz * gate * 0.25;
    }
    glowC += c * e * fog / (1.0 + d * d * 900.0) * min(max(d, 0.004) * 12.0 + 0.3, 1.0);
    if (d < 0.001 * t) { hitT = t; axis = a; break; }
    t += max(d * 0.85, 0.004);
    if (t > 22.0) break;
  }
  vec3 col = uPalBg.rgb * 0.35;
  // The distance itself: a faint haze of the palette.
  col += mix(uPalLow.rgb, uPalMid.rgb, 0.4) * 0.03 * (1.0 - exp(-t * 0.08));
  if (hitT > 0.0) {
    // A rod face: dark metal with a sheen, fogged.
    vec3 pos = ro + rd * hitT;
    vec3 q = fract(pos) - 0.5;
    vec3 n = axis < 0.5 ? normalize(vec3(0.0, q.yz)) : axis < 1.5 ? normalize(vec3(q.x, 0.0, q.z)) : normalize(vec3(q.xy, 0.0));
    float sheen = pow(1.0 - abs(dot(n, rd)), 3.0);
    vec3 c = axis < 0.5 ? cx : axis < 1.5 ? cy : cz;
    col = c * (0.015 + 0.22 * sheen) * exp(-hitT * fogK);
  }
  col += glowC * (0.8 + 0.8 * uFlow.x);
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.25;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    let cam = 0;
    let bank = 0;
    let bankTarget = 0;
    const drop = onStamp((m) => m.stamp.drop, () => {
      bankTarget += Math.PI / 2;
      flash(0.8);
    });
    return {
      step(dt, m) {
        drop(m);
        // One cell per beat, faster through a build, a drift in a breakdown.
        const speed = (0.8 + 0.4 * m.drive + 0.9 * m.build) * (1 - 0.6 * m.breakdown);
        cam += (dt / m.beat) * speed;
        // The drop banks the camera a quarter turn, eased over two beats.
        bank = m.ease(bank, bankTarget, 2, dt);
        state[0] = cam;
        state[1] = bank;
      },
    };
  },
};
