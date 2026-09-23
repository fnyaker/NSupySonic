// HORIZON — the sun going down over a grid that never ends.
//
// Synthwave, outrun, retrowave, lo-fi house: the one image the genre is made
// of, done properly. A banded sun sinking into a violet sky, ranges of
// mountains edged in neon, and a floor of light-lines running to the horizon
// and rushing toward you, one line per beat.
//
//   THE SUN is a disc graded from gold to the palette's pink, cut by
//   horizontal slits that thicken toward its base and slide slowly down it —
//   the signature — and it breathes with the bass.
//   THE MOUNTAINS are two ranges, far and near, each a silhouette with a
//   neon line tracing its ridge, the far one hazed by distance.
//   THE GRID is a true ground plane: lines along the road and lines across
//   it, both anti-aliased at their real pixel width at every depth and faded
//   where they pack too tight to be lines. The cross lines ARE the beat: one
//   passes under the camera on every beat, and each main kick lights them.
//   The sun lies on the floor as a long reflection.
//   THE DROP races the grid and sweeps a line of light across the sky.
//
// Parameters:
//   grid    grid brightness    sun   sun size
//   peaks   mountain height

import { onStamp } from "./kit.js";

export default {
  id: "horizon",
  uses: ["noise"],
  params: { grid: 1, sun: 1, peaks: 1 },
  look: { exposure: 1.0, bloom: 1.35, threshold: 0.6, saturation: 1.3 },

  fragment: `
float horizonY() { return -0.08; }

void main() {
  vec2 p = fragP();
  float amp = 0.6 + 0.4 * uCtl.x;
  float A = uFrame.z;
  float px = uFrame.w;
  float hy = horizonY();
  float travel = uS0.x;
  float sweep = uS0.y;
  vec3 pink = mix(vec3(1.0, 0.25, 0.6), uPalHigh.rgb, 0.35);
  vec3 gold = mix(vec3(1.0, 0.78, 0.25), uPalHigh.rgb, 0.1);
  vec3 violet = mix(vec3(0.25, 0.05, 0.45), uPalLow.rgb, 0.4);
  vec3 col;

  // --- the sky ---
  float sy = clamp((p.y - hy) / (1.0 - hy), 0.0, 1.0);
  col = mix(pink * 0.35, violet * 0.3, smoothstep(0.0, 0.5, sy));
  col = mix(col, uPalBg.rgb * 0.3, smoothstep(0.4, 1.0, sy));
  vec2 sg = floor(p * 120.0);
  col += vec3(0.9) * step(0.995, hash12(sg)) * smoothstep(0.3, 0.8, sy) * (0.4 + 0.6 * uHit2.x) * 0.3;
  // The drop's sweep: a line of light running up the sky.
  col += pink * exp(-pow((sy - sweep) / 0.01, 2.0)) * step(0.001, sweep) * 0.6;

  // --- the sun: slits sliding down it, breathing with the bass ---
  vec2 sc = vec2(uHole.z > 0.0 ? uHole.x : 0.0, hy + 0.4);
  float R = 0.36 * P_SUN * (1.0 + 0.04 * uBandA.x);
  vec2 sd = p - sc;
  float r = length(sd);
  if (sd.y > -R && p.y > hy) {
    float v = (sd.y + R) / (2.0 * R);                   // 0 at the base, 1 at the top
    // The slits: thick at the base, gone by the top, sliding downward.
    float slit = fract(v * 9.0 + uClock.y * 0.25);
    float gap = mix(0.45, 0.0, smoothstep(0.0, 0.6, v));
    float cut = step(gap, slit);
    vec3 sunC = mix(pink, gold, smoothstep(0.1, 0.9, v));
    float disc = smoothstep(R + px, R - px, r) * cut;
    col = mix(col, sunC * 1.5, disc);
  }
  col += pink * exp(-max(r - R, 0.0) * 4.0) * 0.18 * (0.8 + 0.3 * uBandA.x) * step(hy, p.y);

  // --- the mountains: far, hazed; near, edged in neon ---
  if (p.y > hy) {
    float far = hy + (0.1 + 0.18 * (fbm(vec2(p.x * 1.8 + 10.0, 0.5), 5) * 0.5 + 0.5)) * P_PEAKS;
    float nearH = hy + (0.04 + 0.22 * pow(fbm(vec2(p.x * 1.1 - 3.0, 1.5), 5) * 0.5 + 0.5, 1.6)) * P_PEAKS * smoothstep(0.1, 0.9, abs(p.x) / A + 0.2);
    if (p.y < far) col = mix(col, violet * 0.25 + pink * 0.05, 0.85);
    col += mix(pink, violet, 0.3) * exp(-pow((p.y - far) / (px * 1.5), 2.0)) * 0.25;
    if (p.y < nearH) {
      col = uPalBg.rgb * 0.15 + violet * 0.06;
      // A faint wireframe down the slopes.
      float ribs = exp(-pow(abs(fract(p.x * 12.0) - 0.5) / 0.04, 2.0)) * smoothstep(hy, nearH, p.y);
      col += pink * ribs * 0.04;
    }
    col += pink * exp(-pow((p.y - nearH) / (px * 1.3), 2.0)) * (0.6 + 0.4 * uHit.y * amp);
  }

  // --- the floor ---
  if (p.y < hy) {
    float z = 0.35 / max(hy - p.y, 1e-3);
    float x = p.x * z;
    // A line's footprint on screen is the whole gradient of its coordinate,
    // not one axis of it: out at the sides the road lines run almost flat
    // toward the horizon, and there it is the VERTICAL change in x that
    // decides how many of them a pixel covers.
    float dzdy = z * z / 0.35;
    float pxX = px * length(vec2(z, p.x * dzdy));
    float pxZ = px * dzdy;
    // Lines along the road...
    float lx = abs(fract(x * 2.2 + 0.5) - 0.5) / 2.2;
    float along = exp(-pow(lx / (pxX * 1.1 + 0.0012 * z), 2.0)) * smoothstep(0.35, 0.1, pxX * 2.2);
    // ...and across it, one passing under the camera per beat.
    float wz = z + travel;
    float lz = abs(fract(wz + 0.5) - 0.5);
    float across = exp(-pow(lz / (pxZ * 1.1 + 0.003), 2.0)) * smoothstep(0.35, 0.1, pxZ);
    // Where both have gone, the floor keeps their average light, so the grid
    // melts into a glow at the horizon instead of ending at a seam.
    float melt = (1.0 - smoothstep(0.35, 0.1, pxX * 2.2)) * 0.12 + (1.0 - smoothstep(0.35, 0.1, pxZ)) * 0.08;
    float fade = exp(-z * 0.04);
    float kick = 1.0 + 1.5 * uHit.y * amp * exp(-z * 0.2);
    vec3 floorC = uPalBg.rgb * 0.08 + violet * 0.04 * fade;
    floorC += pink * (along + across + melt) * fade * 0.55 * P_GRID * kick;
    // The sun on the floor: a long, soft reflection.
    floorC += mix(pink, gold, 0.4) * exp(-pow((p.x - sc.x) / (0.12 + 0.2 * (hy - p.y)), 2.0)) * exp(-(hy - p.y) * 2.5) * 0.25;
    col = floorC;
    // The haze where floor meets sky.
    col += pink * exp(-(hy - p.y) * 30.0) * 0.2;
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    let travel = 0;
    let speed = 1;
    let sweep = 0;
    let sweeping = false;
    const drop = onStamp((m) => m.stamp.drop, () => {
      sweep = 0.001;
      sweeping = true;
      flash(0.6);
    });
    return {
      step(dt, m) {
        drop(m);
        // Cross lines are one unit apart; one per beat is a unit a beat,
        // faster through a build and a drop.
        const want = (0.8 + 0.3 * m.drive + 0.6 * m.build + (sweeping ? 0.8 : 0)) * (1 - 0.4 * m.breakdown);
        speed = m.ease(speed, want, 1, dt);
        travel += (dt / m.beat) * speed;
        if (travel > 4096) travel -= 4096; // the cross lines are one unit apart
        if (sweeping) {
          sweep += dt / m.overBeats(2);
          if (sweep > 1) {
            sweep = 0;
            sweeping = false;
          }
        }
        state[0] = travel;
        state[1] = sweep;
      },
    };
  },
};
