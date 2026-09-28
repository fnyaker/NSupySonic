// BOKEH — city lights, out of focus.
//
// Pop, house, disco, anything warm and made for a room full of people: the
// picture is what a camera sees when it is focused on someone in front of
// the lights — every light behind them melted into a disc the shape of the
// lens's aperture.
//
//   THE DISCS are drawn the way a lens draws them, not as blurred dots — the
//   way a MODERN fast lens draws them: round (a wide-open aperture has no
//   corners; the hexagons of a cheap kit lens are what dated the old picture
//   to 2008, and remain a skin's choice via `blades`), evenly lit with only a
//   gentle rim, and an edge whose softness is the disc's distance from the
//   focal plane — the nearest layer huge, faint and melting, the far one small
//   and nearly crisp. No colour fringe: that was a lens flaw worn as a filter.
//   Three layers at three distances, drifting at three speeds.
//   THE ROOM is not black: it is the glow of everything out of focus, three
//   soft pools of the palette drifting on the bar.
//   THE GLITTER is the one thing in focus: pinpoints of light hanging in
//   front of the lens, twinkling with the hi-hats — the sharp contrast that
//   makes the discs read as melted. Points, not four-rayed star glints: the
//   star filter is the other thing that dated it.
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
  params: { count: 1, blades: 0, drift: 1 },
  look: { exposure: 1.0, bloom: 0.9, threshold: 0.82, saturation: 1.12, ca: 0 },

  fragment: `
void main() {
  vec2 p = fragP();
  float bars = uClock.y * uSpeed;
  float A = uFrame.z;
  // The room behind the lights is not black: it is the glow of everything out
  // of focus, three soft pools of the palette drifting on the bar — the
  // luminous gradient a pop record lives in — breathing with the mix.
  vec2 b1 = vec2(-0.6 * A + 0.3 * sin(bars * 0.21), 0.35 + 0.25 * cos(bars * 0.17));
  vec2 b2 = vec2(0.55 * A + 0.3 * cos(bars * 0.19), -0.3 + 0.25 * sin(bars * 0.23));
  vec2 b3 = vec2(0.2 * A * sin(bars * 0.13), 0.1 * cos(bars * 0.29));
  float w1 = exp(-dot(p - b1, p - b1) / 0.9);
  float w2 = exp(-dot(p - b2, p - b2) / 0.9);
  float w3 = exp(-dot(p - b3, p - b3) / 0.5);
  vec3 col = uPalBg.rgb * 0.4;
  col += (uPalLow.rgb * w1 + uPalHigh.rgb * w2 + uPalMid.rgb * w3) * 0.1 * (0.6 + 0.4 * uFlow.x + 0.2 * uMood.y);

  // --- glitter: the one thing in focus ---
  // Points of light hanging in front of the lens, sharp where everything
  // behind them is soft: four-rayed glints that twinkle with the hi-hats and
  // catch the beat. The contrast between them and the discs is what makes
  // the discs read as out of focus.
  vec2 gq = p / 0.12 + vec2(0.0, bars * 0.35);
  vec2 gc = floor(gq);
  vec3 gh = hash32(gc + 17.0);
  if (gh.x > 0.9) {
    vec2 at = gc + 0.3 + 0.4 * gh.yz;
    vec2 dq = (gq - at) * 0.12;
    float tw = pow(0.5 + 0.5 * sin(uClock.x * (1.3 + gh.z) * PI + gh.y * 40.0), 6.0);
    float hit = 0.4 + tw + 1.2 * uHit2.x + 0.8 * envB(fract(uClock.x + gh.z), 0.2) * step(0.6, gh.z);
    // A pinpoint and its own small halo, sized in pixels so it stays a point.
    float r2 = dot(dq, dq) / (uFrame.w * uFrame.w);
    float star = exp(-r2 * 0.35) + 0.12 * exp(-r2 * 0.03);
    col += mix(pal(gh.z), vec3(1.0), 0.6) * star * hit * 0.45 * clearOfHole(p, 0.03);
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
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
  // A light behind the artwork is a light nobody sees.
  col = vec4(c * b * (0.6 + 0.4 * uFlow.x) * mix(0.2, 1.0, clearOfHole(at, R * 0.6)), 1.0);
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
  // The edge's softness is the distance from the focal plane: the near layer
  // melts over a quarter of its radius, the far one is nearly crisp.
  float soft = layer < 0.5 ? 0.3 : layer < 1.5 ? 0.12 : 0.05;
  float inside = smoothstep(1.0, 1.0 - max(soft, aa * 1.5), d);
  // Evenly lit, with only a gentle rim: the soap-bubble ring of a strongly
  // aberrated lens is a period look.
  float rim = smoothstep(0.62, 0.98, d);
  vec3 body = c.rgb * (0.72 + 0.28 * rim) * inside;
  return vec4(body, 1.0);
}
`,
  },
};
