// LAVE — the lava lamp, lit from below.
//
// Funk, soul, psych-rock, trip-hop, anything that grooves slowly: wax in a
// lamp, warmed from underneath, rising in blobs, cooling at the top, sinking
// back, and merging and splitting on the way.
//
//   THE WAX is a metaball field — every blob adds a compact bump
//   (1 - d^2/R^2)^3 that is exactly zero beyond its reach, so two blobs only
//   merge when they actually meet (the r^2/d^2 kernel of the textbook reaches
//   everywhere, and nine of them melt into one shapeless mass) — evaluated
//   with its analytic gradient, so the edge is anti-aliased at the true pixel
//   width and the surface has a normal.
//   That normal is what makes it wax and not a flat shape: a highlight from
//   the room, a rim where the surface turns away, and the lamp's glow coming
//   THROUGH the thin edges (subsurface light), strongest low down near the
//   bulb.
//   THE CYCLE. Each blob rises and sinks on its own slow period, a whole
//   number of bars, so the lamp keeps time without ever looking mechanical.
//   Where two meet, the field merges them like wax does.
//   THE MUSIC. The bass swells the blobs; the kick warms the lamp (the bulb
//   brightens and every blob's glow with it); the drop draws the wax toward
//   the middle and lets it drift apart again over two bars.
//
// Parameters:
//   blobs   how many (4..10)    heat   how bright the lamp is
//   speed   cycle speed (x)

import { onStamp } from "./kit.js";

export default {
  id: "plasma",
  uses: [],
  params: { blobs: 9, heat: 1, speed: 1 },
  look: { exposure: 1.0, bloom: 1.2, threshold: 0.7, saturation: 1.2 },

  fragment: `
void main() {
  vec2 p = fragP();
  float bars = uClock.y * uSpeed * P_SPEED;
  float amp = 0.6 + 0.4 * uCtl.x;
  float A = uFrame.z;
  float px = uFrame.w;
  float gather = uS0.x;           // the drop pulling the wax together
  int n = int(clamp(P_BLOBS, 4.0, 10.0));
  float f = 0.0;
  vec2 g = vec2(0.0);
  for (int i = 0; i < 10; i++) {
    if (i >= n) break;
    float fi = float(i);
    vec3 h = hash31(fi * 3.7 + 0.9);
    // Rise and sink over a whole number of bars, each at its own phase.
    float period = 4.0 + floor(h.x * 4.0) * 2.0;
    float ph = fract(bars / period + h.y);
    float y = -0.95 + 1.9 * (0.5 - 0.5 * cos(ph * TAU));
    float x = ((fi + 0.5) / float(n) * 2.0 - 1.0) * (A - 0.3) + 0.12 * sin(bars * 0.3 + fi * 2.0);
    vec2 c = mix(vec2(x, y), vec2(0.0, -0.2), gather * (0.3 + 0.2 * h.z));
    float R = (0.24 + 0.14 * h.z) * (1.0 + 0.2 * uBandA.x + 0.06 * uHit.x * amp);
    vec2 d = p - c;
    float u = 1.0 - dot(d, d) / (R * R);
    if (u <= 0.0) continue;
    f += u * u * u;
    g += 3.0 * u * u * (-2.0 * d / (R * R));
  }
  const float T = 0.25;                   // the surface
  float gl = max(length(g), 1e-3);
  float sd = (f - T) / gl;                // approximate distance to the surface
  float inside = smoothstep(-px, px, sd);

  // The liquid: dark, warm at the bottom where the bulb is.
  float heat = (0.6 + 0.4 * uFlow.x + 0.5 * envB(uSince.y, 0.6) * amp) * P_HEAT;
  vec3 liquid = mix(uPalLow.rgb * 0.12, uPalBg.rgb * 0.4 + uPalMid.rgb * 0.025, smoothstep(-1.0, 0.8, p.y));
  liquid += mix(uPalMid.rgb, vec3(1.0, 0.6, 0.3), 0.3) * exp(-(p.y + 1.0) * 2.5) * 0.12 * heat;
  vec3 col = liquid;

  // The wax.
  // A dome: the normal leans outward at the rim and faces us in the middle.
  float dome = clamp(1.0 - sd * 6.0, 0.0, 1.0);
  vec3 nrm = normalize(vec3(-g / gl * dome * 0.9, 1.0));
  vec3 L = normalize(vec3(-0.4, 0.6, 0.8));
  float diff = max(dot(nrm, L), 0.0);
  float spec = pow(max(dot(reflect(-L, nrm), vec3(0.0, 0.0, 1.0)), 0.0), 30.0);
  float rim = pow(1.0 - nrm.z, 2.0);
  // Thicker wax holds more of the lamp's light inside it.
  float thick = smoothstep(T, 1.2, f);
  vec3 waxC = mix(uPalMid.rgb, uPalHigh.rgb, thick);
  vec3 bulb = mix(vec3(1.0, 0.55, 0.25), uPalHigh.rgb, 0.5) * exp(-(p.y + 1.0) * 1.2) * heat;
  vec3 wax = waxC * (0.18 + 0.35 * diff) + vec3(1.0) * spec * 0.35 + waxC * rim * 0.5 + bulb * (0.35 + 0.8 * (1.0 - thick)) * 0.5;
  col = mix(col, wax, inside);
  // A glow in the liquid round the wax, where the lamp shines through it.
  col += waxC * exp(-max(-sd, 0.0) * 30.0) * (1.0 - inside) * 0.08 * heat;
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    let gather = 0;
    let dropAt = -1;
    const drop = onStamp((m) => m.stamp.drop, () => {
      dropAt = 0;
      flash(0.5);
    });
    return {
      step(dt, m) {
        drop(m);
        // Pulled part of the way together over the drop's first beat, and
        // released over the next two bars.
        if (dropAt >= 0) {
          dropAt += dt / m.beat;
          gather = dropAt < 1 ? dropAt : Math.max(0, 1 - (dropAt - 1) / 8);
          if (dropAt > 9) dropAt = -1;
        }
        state[0] = gather * gather * (3 - 2 * gather);
      },
    };
  },
};
