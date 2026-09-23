// LUCIOLES — a meadow at night, and fireflies that learn the beat.
//
// Folk, acoustic, singer-songwriter, dream pop, the quiet end of anything:
// a meadow under a night sky, grass moving in the wind, a tree line against
// the last light — and fireflies.
//
//   THE FIREFLIES are instanced, each one wandering its own slow path through
//   the air above the grass and blinking on its own rhythm: a quick rise, a
//   slower fade, the cold yellow-green of the real thing leaned toward the
//   palette.
//   THEY SYNCHRONISE. Some species really do this: a whole field of them
//   drifting into step until they flash together. Here it is the
//   arrangement that does it — a build pulls them toward the beat, the drop
//   locks every one of them onto it, and a breakdown lets them fall back out
//   of step, one by one. The melody sets a few of them off on its notes.
//   THE MEADOW. Two layers of grass blades, each blade tapered and bent by a
//   wind that gusts on the bar, black against the sky; a tree line behind;
//   stars and a moon's glow in the corner.
//
// Parameters:
//   flies   how many (x)    wind   grass movement
//   sync    how far the drop locks them (0 = never)

import { onStamp } from "./kit.js";

const FLIES = 160;

export default {
  id: "fireflies",
  uses: ["noise"],
  params: { flies: 1, wind: 1, sync: 1 },
  look: { exposure: 1.0, bloom: 1.4, threshold: 0.6, saturation: 1.15 },

  fragment: `
// Grass: blades in cells of width W, returns coverage.
float grass(vec2 p, float W, float base, float hmax, float wind, float seed) {
  float cov = 0.0;
  float ci = floor(p.x / W);
  for (int i = -2; i <= 2; i++) {
    float c = ci + float(i);
    vec3 h = hash31(c * 1.31 + seed);
    float x0 = (c + h.x) * W;
    float hgt = hmax * (0.35 + 0.65 * h.y);
    float t = clamp((p.y - base) / hgt, 0.0, 1.0);
    if (p.y < base - 0.01 || p.y > base + hgt) continue;
    // Bent by the wind, more at the tip.
    float bend = (wind * (0.6 + 0.8 * h.z) + (h.z - 0.5) * 0.4) * t * t * hgt;
    float x = x0 + bend;
    float w = W * 0.35 * (1.0 - t) + uFrame.w * 0.5;
    cov = max(cov, smoothstep(w + uFrame.w, w - uFrame.w, abs(p.x - x)));
  }
  return cov;
}

void main() {
  vec2 p = fragP();
  float bars = uClock.y * uSpeed;
  float A = uFrame.z;
  // The sky: deep at the top, the last light low down.
  vec3 col = mix(mix(uPalLow.rgb, uPalMid.rgb, 0.2) * 0.07, uPalBg.rgb * 0.3, smoothstep(-0.4, 1.0, p.y));
  // The moon's glow, up in a corner.
  vec2 moon = vec2(A * 0.72, 0.72);
  col += mix(vec3(0.9, 0.95, 1.0), uPalHigh.rgb, 0.2) * (glow(length(p - moon), 0.03) * 0.5 + exp(-length(p - moon) * 2.5) * 0.04);
  vec2 sg = floor(p * 130.0);
  col += vec3(0.8) * step(0.997, hash12(sg)) * smoothstep(0.0, 0.6, p.y) * (0.5 + 0.5 * sin(uClock.x * 0.7 + sg.x)) * 0.35;
  // The tree line.
  float trees = -0.2 + 0.12 * (fbm(vec2(p.x * 2.5, 1.0), 4) * 0.5 + 0.5) + 0.05 * (fbm(vec2(p.x * 9.0, 3.0), 3));
  col = mix(col, uPalBg.rgb * 0.08, smoothstep(trees + uFrame.w, trees - uFrame.w, p.y));
  // The wind: a gust on the bar, a slow sway under it.
  float wind = (0.25 * sin(bars * PI * 0.5 + p.x * 0.8) + 0.15 * sin(uClock.x * 0.9 + p.x * 2.0) + 0.3 * uFlow.x) * P_WIND;
  // The meadow under the moon, a low mist lying over it, and the grass
  // silhouetted against that: a far layer, dimmer, and a near layer, black.
  vec3 meadow = mix(uPalLow.rgb, uPalMid.rgb, 0.3) * 0.05 + vec3(0.02, 0.025, 0.03);
  col = mix(col, meadow, smoothstep(-0.5, -0.6, p.y));
  col += mix(uPalLow.rgb, uPalMid.rgb, 0.5) * exp(-pow((p.y + 0.45) * 4.0, 2.0)) * 0.05 * (0.6 + 0.4 * uMood.y);
  float g1 = grass(p, 0.014, -0.55, 0.22, wind * 0.6, 3.0);
  col = mix(col, meadow * 0.45, g1);
  float g2 = grass(p, 0.022, -1.02, 0.45, wind, 7.0);
  col = mix(col, uPalBg.rgb * 0.02, g2);
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  particles: {
    count: FLIES,
    vertex: `
float pulse(float x) {
  // A quick rise and a slower fade: the firefly's flash.
  return smoothstep(0.0, 0.04, x) * exp(-max(x - 0.04, 0.0) * 7.0);
}
void particle(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind) {
  float j = float(id);
  col = vec4(0.0); pos = vec2(0.0); axis = vec2(0.0); width = 0.0; kind = 0.0;
  if (j >= ${FLIES}.0 * P_FLIES * (0.5 + 0.5 * uQual.y)) return;
  vec3 h = hash31(j * 1.7 + 0.4);
  vec3 h2 = hash31(j * 2.9 + 5.1);
  float A = uFrame.z;
  // A slow wandering path through the air above the grass.
  float t = uClock.x * 0.05;
  vec2 at = vec2((h.x * 2.0 - 1.0) * A, -0.75 + 0.9 * h.y * h.y);
  at += vec2(sin(t * (1.0 + h.z) + j) * 0.12 + sin(t * 2.3 + j * 3.0) * 0.04,
             sin(t * (0.8 + h.x) + j * 1.7) * 0.06);
  pos = at;
  // Its own rhythm, and the beat: blended by how synchronised the field is.
  float own = fract(uClock.x * (0.12 + 0.2 * h2.x) + h2.y);
  float beat = fract(uClock.x);
  float sync = uS0.x * P_SYNC * step(h2.z, 0.85 + 0.15 * uS0.x);
  float b = mix(pulse(own), pulse(beat), sync);
  // The melody sets a few off on its notes: a different handful each half
  // beat, lit by the note's own envelope.
  float noteK = step(0.82, hash11(j * 1.3 + floor(uClock.x * 2.0))) * uHit2.y;
  b = max(b, noteK);
  float depth = 0.5 + 0.5 * h.y;           // higher = further, smaller
  // The quad is the reach of the glow; the insect is a point inside it.
  width = (0.03 + 0.035 * (1.0 - depth)) * (0.6 + 0.4 * b);
  axis = vec2(width, 0.0);
  vec3 c = mix(vec3(0.75, 1.0, 0.35), uPalHigh.rgb, 0.3);
  col = vec4(c * (0.03 + 1.6 * b) * (1.2 - 0.5 * depth), 1.0);
  kind = b;
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  float d = length(q);
  // A hot point in a soft halo: the lantern and the air it lights.
  return vec4(c.rgb * (exp(-d * d * 160.0) * 2.0 + 0.3 * exp(-d * 4.5) * (1.0 - d)), 1.0);
}
`,
  },

  create({ state }) {
    let sync = 0;
    let lastDrop = null;
    let locked = 0;
    return {
      step(dt, m) {
        if (lastDrop === null) lastDrop = m.stamp.drop;
        if (m.stamp.drop !== lastDrop) {
          lastDrop = m.stamp.drop;
          locked = 1;
        }
        // The drop locks them for eight bars; a build draws them toward the
        // beat; a breakdown lets them drift apart.
        locked = Math.max(0, locked - dt / m.overBeats(32));
        if (m.breakdown > 0.5) locked = 0;
        const want = Math.max(locked > 0 ? 1 : 0, 0.7 * m.build);
        sync = m.ease(sync, want, locked > 0 ? 1 : 6, dt);
        state[0] = sync;
      },
    };
  },
};
