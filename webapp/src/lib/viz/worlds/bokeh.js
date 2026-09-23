// BOKEH — city lights, out of focus.
//
// Pop, house, disco, anything warm and made for a room full of people: the
// picture is what a camera sees when it is focused on someone in front of
// the lights — every light behind them melted into a disc the shape of the
// lens's aperture.
//
//   THE DISCS are drawn the way a lens draws them, not as blurred dots: the
//   aperture's polygon (six or eight blades, turned a little per layer), a
//   rim brighter than the middle — the spherical aberration that makes real
//   bokeh look like soap bubbles — and a hair of colour fringing on the edge.
//   Three layers at three distances, so they drift at three speeds and the
//   nearest ones are huge and faint while the far ones are small and bright.
//   THE MUSIC. Every disc belongs to a slice of the spectrum and breathes with
//   it, so the frame's light is the mix; each beat a scatter of discs swells
//   and flares; the kick pushes the near layer toward the camera; the drop
//   lights everything at once.
//
// Parameters:
//   count   how many discs (x)   blades  aperture blades (0 = round)
//   drift   how fast they float

const DISCS = 150;

export default {
  id: "bokeh",
  uses: [],
  params: { count: 1, blades: 6, drift: 1 },
  look: { exposure: 1.0, bloom: 1.15, threshold: 0.8, saturation: 1.2 },

  fragment: `
void main() {
  vec2 p = fragP();
  // The room behind the lights: dark, warmer where most of the light is.
  vec3 col = uPalBg.rgb * 0.45;
  col += mix(uPalLow.rgb, uPalMid.rgb, 0.4) * exp(-dot(p * vec2(0.6, 1.2), p * vec2(0.6, 1.2))) * 0.05 * (0.6 + 0.4 * uFlow.x);
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  particles: {
    count: DISCS,
    vertex: `
void particle(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind) {
  float j = float(id);
  col = vec4(0.0); pos = vec2(0.0); axis = vec2(0.0); width = 0.0; kind = 0.0;
  if (j >= ${DISCS}.0 * P_COUNT * (0.5 + 0.5 * uQual.y)) return;
  vec3 h = hash31(j * 1.618 + 4.2);
  vec3 h2 = hash31(j * 2.71 + 9.1);
  // Three layers: near (big, faint, fast), middle, far (small, bright, slow).
  float layer = floor(h2.x * 3.0);
  float depth = 1.0 + layer;
  float A = uFrame.z;
  // A slow drift upward and sideways, wrapped around the frame.
  float t = uClock.x * 0.012 * P_DRIFT / depth;
  vec2 at = vec2(h.x * 2.0 - 1.0, h.y * 2.0 - 1.0) * vec2(A + 0.4, 1.4);
  at += vec2(t * (h2.y - 0.5) * 2.0, t);
  at = mod(at + vec2(A + 0.4, 1.4), vec2(A + 0.4, 1.4) * 2.0) - vec2(A + 0.4, 1.4);
  // Its slice of the spectrum, and how it breathes with it.
  float f = h.z;
  float lvl = texture(uSpec, vec2(f, 0.25)).r;
  // Each beat, a different scatter of discs swells.
  float beatN = floor(uClock.x);
  float chosen = step(0.82, hash11(j * 0.37 + beatN * 1.7));
  float flare = chosen * envB(fract(uClock.x), 0.45);
  float R = (0.05 + 0.1 * h2.z) * (layer < 0.5 ? 2.4 : layer < 1.5 ? 1.3 : 0.7);
  R *= 1.0 + 0.25 * flare + (layer < 0.5 ? 0.08 * uHit.y : 0.0);
  pos = at;
  axis = vec2(R, 0.0);
  width = R;
  // Most lights are faint and a few are bright, which is what gives real
  // bokeh its depth; the near layer is huge and barely there.
  float bright = 0.04 + 0.6 * pow(hash11(j * 5.3), 4.0);
  float b = (bright * (0.5 + lvl) + 0.8 * flare + 0.3 * envB(uSince.w, 2.0) * step(uSince.w, 8.0)) * (layer < 0.5 ? 0.35 : 1.0);
  vec3 c = pal(f);
  col = vec4(c * b * (0.6 + 0.4 * uFlow.x), 1.0);
  kind = layer + h2.y * 0.9; // layer, and a turn of the aperture
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  float layer = floor(k);
  float turn = fract(k) * 1.0 + layer * 0.35;
  float n = floor(P_BLADES + 0.5);
  float d;
  if (n < 3.0) {
    d = length(q);
  } else {
    // The aperture: the largest projection onto the blades' normals.
    float a = atan(q.y, q.x) + turn;
    float seg = TAU / n;
    float ap = mod(a, seg) - seg * 0.5;
    d = length(q) * cos(ap) / cos(seg * 0.5);
    d = mix(d, length(q), 0.25);   // blades are curved, a little
  }
  float aa = max(fwidth(d), 1e-3);
  float inside = smoothstep(1.0, 1.0 - aa * 1.5, d);
  // Brighter at the rim, the way real bokeh is.
  float rim = smoothstep(0.7, 0.97, d);
  vec3 body = c.rgb * (0.35 + 0.65 * rim) * inside;
  // A hair of fringing on the edge: warm outside, cool inside.
  body += vec3(0.06, 0.0, -0.03) * c.rgb * smoothstep(0.92, 1.0, d) * inside * 4.0;
  return vec4(body, 1.0);
}
`,
  },
};
