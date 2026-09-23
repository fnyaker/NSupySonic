// TREILLIS — flight through an infinite lattice of light.
//
// Minimal techno, dub techno, progressive: music made of a grid and of time
// spent moving through it. So the picture is a space frame — rods along all
// three axes, repeating for ever — that the camera flies through at exactly
// one cell per beat, banking gently on the bar.
//
//   THE RODS are cone-marched: one cell of the lattice is three cylinders,
//   and the whole infinite frame is that cell repeated, so its cost does not
//   depend on how much of it is in view. Each step asks how much of the
//   PIXEL a rod covers and composites that much, so a rod thinner than a
//   pixel is a hairline of the right brightness rather than a row of dots.
//   They are polished chrome with the current inside: the metal mirrors the
//   glow at the far end and a band of lights round the horizon, and fog
//   takes the frame into the dark within a few cells, so only the current
//   carries further. Only the current and the gates give off light — a
//   lattice where every rod glows a little is a pink fog with nothing in it.
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
  float r = 0.026 * P_ROD;
  float dx = length(q.yz);
  float dy = length(q.xz);
  float dz = length(q.xy);
  float d = min(dx, min(dy, dz));
  axis = d == dx ? 0.0 : d == dy ? 1.0 : 2.0;
  return d - r;
}

// How much light a rod gives off here. Only a third of the flight rods carry
// a current, and only the current and the gates are bright: a frame where
// every rod glows a little is a fog of light with nothing in it, which is
// what this world used to be.
float rodEmit(vec3 pos, float a, float beats, float gate, float gateZ) {
  if (a > 1.5) {
    float h = hash12(mod(floor(pos.xy), 64.0) + 0.5);
    float live = step(0.62, h);
    float ph = fract(pos.z * 0.25 - beats * 0.5 + h * 7.0);
    float pulse = exp(-pow((ph - 0.5) * 11.0, 2.0)) + 0.35 * exp(-pow((ph - 0.42) * 30.0, 2.0));
    return live * (0.05 + pulse * 3.2 * P_PULSES * (0.35 + 0.65 * uFlow.x));
  }
  float gz = exp(-pow((pos.z - gateZ) * 4.0, 2.0));
  return gz * gate * 3.0;
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
  vec3 cx = mix(uPalLow.rgb, uPalMid.rgb, 0.6);
  vec3 cy = mix(uPalMid.rgb, uPalHigh.rgb, 0.3);
  vec3 cz = mix(uPalHigh.rgb, vec3(1.0), 0.15);
  // Dense fog, on purpose: every ray through a lattice hits a rod within a few
  // cells, and a thin fog turns those thousands of distant rods into a mush of
  // light. With it, the frame falls away into the dark within a few cells and
  // only the current carries further.
  float fogK = 0.42 + 0.12 * uArc.y - 0.1 * uArc.z;
  float gateZ = floor(cam) + 3.0;
  float gate = uHit.y * amp;
  // The void: near black, and a glow at the vanishing point where the
  // lattice runs out of sight — the depth the whole picture falls into.
  vec3 deep = mix(uPalMid.rgb, uPalHigh.rgb, 0.4);
  vec3 bg = uPalBg.rgb * 0.2 + deep * (0.02 + 0.14 * exp(-length(p) * 2.6)) * (0.5 + uMood.y);

  // CONE-MARCHED, not ray-marched. A rod a few cells off is thinner than a
  // pixel, and a ray either hits it or misses it — which drew every distant
  // rod as a row of dots. Each step here asks how much of the PIXEL's cone the
  // rod covers, composites that much of it, and marches on through, so a
  // hairline rod is drawn as the fraction of light it really is.
  float pixA = uFrame.w / 1.25;
  float t = 0.02;
  vec3 glowC = vec3(0.0);
  vec3 acc = vec3(0.0);
  float A = 0.0;
  for (int i = 0; i < 96; i++) {
    if (i >= steps || A > 0.97) break;
    vec3 pos = ro + rd * t;
    float a;
    float d = cellRods(pos, a);
    float e = rodEmit(pos, a, beats, gate, gateZ);
    vec3 c = a < 0.5 ? cx : a < 1.5 ? cy : cz;
    float fp = t * pixA;
    float stp = max(d * 0.8, max(fp, 0.0015));
    // The halo, integrated along the ray: each step adds the light it passes
    // in proportion to its LENGTH, so the glow does not depend on how many
    // steps the tier can afford. A Gaussian, not the usual 1/d² glow: that
    // tail, summed over the hundreds of rods a ray passes, was a pink haze
    // over the whole frame.
    glowC += c * e * exp(-t * fogK * 0.6) * stp * (exp(-d * d * 600.0) * 0.9 + exp(-d * d * 60.0) * 0.08) * (1.0 - A);
    if (d < fp) {
      float cov = clamp((fp - d) / (2.0 * fp), 0.0, 1.0);
      // Polished chrome with the current inside it. The metal shows nothing
      // of its own: it mirrors the space it hangs in — the glow at the far
      // end, the palette's sky above and floor below, a band of lights round
      // the horizon — so every rod catches a coloured highlight that slides
      // along it as the camera flies and banks.
      vec3 q = fract(pos) - 0.5;
      vec3 n = a < 0.5 ? normalize(vec3(0.0, q.yz)) : a < 1.5 ? normalize(vec3(q.x, 0.0, q.z)) : normalize(vec3(q.xy, 0.0));
      float facing = abs(dot(n, rd));
      float fog = exp(-t * fogK);
      vec3 r = reflect(rd, n);
      r.xy *= rot(-roll);
      float ahead = max(r.z, 0.0);
      vec3 env = deep * (pow(ahead, 12.0) * 2.2 + pow(ahead, 3.0) * 0.12)
               + mix(uPalLow.rgb, uPalHigh.rgb, 0.5 + 0.5 * r.y) * 0.05
               + mix(uPalHigh.rgb, vec3(1.0), 0.5) * pow(0.5 + 0.5 * sin(atan(r.y, r.x) * 2.0 + bars * 0.5), 6.0)
                 * smoothstep(0.1, 0.6, 1.0 - abs(r.z)) * 0.3 * (0.5 + 0.8 * uFlow.x + 0.8 * gate);
      float fres = 0.35 + 0.65 * pow(1.0 - facing, 3.0);
      vec3 tube = env * fres + c * e * (0.25 + 1.1 * pow(facing, 3.0));
      vec3 sampleC = mix(bg, tube, fog);
      // The current is light, and light carries further through haze than
      // the metal it runs along does.
      sampleC += c * e * pow(facing, 3.0) * 0.8 * (exp(-t * fogK * 0.6) - fog);
      acc += (1.0 - A) * cov * sampleC;
      A += (1.0 - A) * cov;
    }
    t += stp;
    if (t > 24.0) break;
  }
  vec3 col = acc + (1.0 - A) * bg;
  col += glowC * (0.8 + 0.6 * uFlow.x);
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
        // Wrapped at 256 cells: the lattice repeats every cell, the current
        // every four, the rods' hashes every 64 — all divide it.
        cam = (cam + (dt / m.beat) * speed) % 256;
        // The drop banks the camera a quarter turn, eased over two beats; a
        // full turn is no turn, so both wrap together.
        bank = m.ease(bank, bankTarget, 2, dt);
        if (bankTarget > Math.PI * 2 && bank > Math.PI * 2) {
          bankTarget -= Math.PI * 2;
          bank -= Math.PI * 2;
        }
        state[0] = cam;
        state[1] = bank;
      },
    };
  },
};
