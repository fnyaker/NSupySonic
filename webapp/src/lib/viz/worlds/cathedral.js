// NEF — light through a rose window, down a dark nave.
//
// Classical, choral, organ, film score, post-rock at its most devotional:
// the picture is the inside of a cathedral in the late afternoon. A rose
// window high at the end of the nave, its coloured light falling in shafts
// through the dust, the columns standing black against it.
//
//   THE WINDOW is drawn as glass and lead: twelve petals round a centre
//   rose, two rings of panes, every pane its own colour off the palette and
//   every one framed by the dark leading and the stone tracery.
//   THE SHAFTS are the window's own light carried down the nave: for every
//   pixel the window is sampled along the line back toward it, so each pane
//   throws its own coloured beam and the tracery throws its shadow into
//   them. Dust drifts through them and they fall as coloured pools on the
//   floor.
//   THE NAVE is two rows of columns receding into the dark, pointed arches
//   between them, in silhouette.
//   THE MUSIC. The melody brightens the shafts (the sun comes out); a chord
//   change re-leads the window's colours, turning them to the next ones; the
//   drop floods the nave with light; a breakdown lets it dim to embers.
//
// Parameters:
//   shafts  god-ray strength    window  window brightness
//   dust    motes in the light

const MOTES = 260;

const SHARED = `
vec2 roseC() { return vec2(0.0, 0.5); }
float roseR() { return 0.34; }
`;

export default {
  id: "cathedral",
  uses: ["noise"],
  params: { shafts: 1, window: 1, dust: 1 },
  look: { exposure: 1.0, bloom: 1.3, threshold: 0.65, saturation: 1.2 },

  fragment: `${SHARED}
// The rose window's light at q (0 outside it), and how much of it is glass.
vec3 rose(vec2 q, float hue) {
  vec2 d = q - roseC();
  float r = length(d) / roseR();
  if (r > 1.0) return vec3(0.0);
  float a = atan(d.y, d.x);
  float petals = 12.0;
  float sector = floor((a / TAU + 0.5) * petals);
  float fa = fract((a / TAU + 0.5) * petals);
  float ring = r < 0.32 ? 0.0 : r < 0.66 ? 1.0 : 2.0;
  // The pane's colour: a hue off the palette, turned by the chord changes.
  float h = hash12(vec2(sector * (ring > 0.5 ? 1.0 : 0.0), ring) + 3.1);
  vec3 c = pal(fract(h * 0.8 + hue + ring * 0.13));
  c = mix(c, hue2rgb(fract(h + hue)), 0.35);
  // The leading and the stone: radial spokes, the ring boundaries, the rim.
  float px = uFrame.w / roseR();
  float spoke = abs(fa - 0.5) * 2.0;            // 1 at the spokes
  float lead = smoothstep(0.86, 0.94, spoke) * step(0.32, r);
  lead = max(lead, smoothstep(0.03 + px, 0.03 - px * 0.0, abs(r - 0.32)));
  lead = max(lead, smoothstep(0.025 + px, 0.0, abs(r - 0.66)));
  lead = max(lead, smoothstep(0.93, 0.97, r));
  // The centre rose: a small six-lobed flower.
  if (r < 0.32) {
    float lobes = abs(cos(a * 3.0));
    lead = max(lead, smoothstep(0.03, 0.0, abs(r / 0.32 - (0.55 + 0.35 * lobes))));
  }
  // Glass is not flat: a little variation in each pane.
  float grain = 0.75 + 0.25 * gnoise(q * 40.0);
  return c * (1.0 - lead) * grain;
}

void main() {
  vec2 p = fragP();
  float hue = uS0.x;
  float sun = (0.45 + 0.35 * uS0.y + 0.6 * uS0.z) * (1.0 - 0.5 * uArc.z);
  vec3 col = uPalBg.rgb * 0.2;
  // The vault: darker toward the top, a hint of stone.
  col += uPalLow.rgb * 0.015 * smoothstep(1.0, -0.2, p.y);

  // --- the shafts: the window sampled back along the line to it ---
  vec2 c = roseC();
  vec3 shafts = vec3(0.0);
  float jit = hash12(gl_FragCoord.xy + fract(uClock.x) * 13.0);
  const int N = 28;
  for (int i = 0; i < N; i++) {
    float s = (float(i) + jit) / float(N);
    vec2 q = mix(p, c, s * 0.92);
    shafts += rose(q, hue);
  }
  shafts /= float(N);
  float dist = length(p - c);
  float dust = 0.5 + 0.8 * (fbm(p * 2.5 + vec2(uClock.y * 0.05, uClock.y * 0.02), 3) * 0.5 + 0.5);
  // The sun is high: the light falls DOWN the nave in a cone from the window,
  // not out in every direction from it.
  vec2 dv = (p - c) / max(dist, 1e-3);
  float cone = smoothstep(1.3, 0.2, abs(dv.x) / max(-dv.y + 0.15, 0.05)) * smoothstep(c.y + 0.05, c.y - 0.25, p.y);
  // Keep the panes' colours in the beams: an average of stained glass is
  // grey, and grey shafts are a searchlight, not a window.
  shafts = max(mix(vec3(luma(shafts)), shafts, 1.8), vec3(0.0));
  col += shafts * dust * cone * 2.2 * P_SHAFTS * sun * exp(-dist * 1.0);
  // What the shafts light, lights the nave a little in turn.
  col += mix(uPalLow.rgb, uPalMid.rgb, 0.4) * 0.03 * sun * exp(-dist * 0.8);

  // --- the floor: the window's light lying on it in coloured pools ---
  float floorY = -0.55;
  if (p.y < floorY) {
    float depth = 0.45 / max(floorY - p.y, 0.02);
    vec2 fp = vec2(p.x * depth * 0.5, depth * 0.08);
    // The pool: the window's colours, stretched long across the flagstones
    // and blurred by the distance they fell.
    vec3 pool = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      vec2 o = vec2(float(i) - 1.5, 0.0) * 0.08;
      pool += rose(roseC() + vec2(fp.x * 0.7, (fp.y - 0.12) * 1.1) + o, hue);
    }
    col += pool * 0.03 * sun * exp(-depth * 0.2) * P_SHAFTS * smoothstep(0.8, 0.2, abs(p.x) / (floorY - p.y + 0.3));
    col += uPalLow.rgb * 0.01;
  }

  // --- the nave: columns receding on both sides, pointed arches between ---
  for (int k = 0; k < 7; k++) {
    float z = 1.0 + float(k) * 0.9;
    for (int sd = 0; sd < 2; sd++) {
      float side = sd == 0 ? -1.0 : 1.0;
      float x = side * 1.25 / z;
      float w = 0.13 / z;
      float top = 0.9 / z;
      float bottom = floorY / (0.6 + 0.4 * z) - 0.05;
      float col01 = smoothstep(w + uFrame.w, w - uFrame.w, abs(p.x - x)) * step(bottom, p.y) * step(p.y, top);
      // The arch springing from the column toward the next one in.
      float xn = side * 1.25 / (z + 0.9);
      float ax = (p.x - x) / (xn - x);
      float archY = top + (0.9 / (z + 0.9) - top) * ax + 0.12 / z * sin(clamp(ax, 0.0, 1.0) * PI);
      float arch = step(0.0, ax) * step(ax, 1.0) * smoothstep(0.035 / z, 0.0, abs(p.y - archY));
      float solid = max(col01, arch);
      // Their faces toward the window catch its light a little.
      vec3 stone = uPalBg.rgb * 0.08 + mix(uPalMid.rgb, uPalHigh.rgb, 0.5) * 0.02 * sun * (1.0 - float(k) * 0.12);
      col = mix(col, stone, solid);
    }
  }

  // --- the window itself, over everything ---
  vec3 glass = rose(p, hue);
  float inWin = step(length(p - c), roseR());
  col = mix(col, glass * (0.9 + 0.6 * sun) * P_WINDOW + uPalBg.rgb * 0.05, inWin);
  // The stone round the window.
  col += uPalMid.rgb * 0.015 * smoothstep(roseR() + 0.05, roseR(), length(p - c)) * (1.0 - inWin);
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
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
  vec3 h = hash31(j * 0.77 + 2.0);
  // Drifting slowly in the shafts: they only show where the light is.
  float t = uClock.y * 0.08;
  vec2 at = vec2((h.x * 2.0 - 1.0) * 1.0, -0.6 + 1.1 * h.y);
  at += vec2(sin(t * (1.0 + h.z) + j), cos(t * (0.7 + h.x) + j * 1.3)) * 0.06;
  // In a shaft: close to the line from the window down through the frame.
  vec2 d = at - roseC();
  float inShaft = smoothstep(0.7, 0.2, abs(d.x) / max(0.2, -d.y + 0.3));
  float tw = 0.5 + 0.5 * sin(uClock.x * (1.0 + h.z) + j * 2.0);
  pos = at;
  width = 0.0025 + 0.002 * h.z;
  axis = vec2(width, 0.0);
  col = vec4(mix(uPalHigh.rgb, vec3(1.0), 0.6) * inShaft * tw * 0.5 * (0.5 + uS0.y), 1.0);
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  float d = length(q);
  return vec4(c.rgb * exp(-d * d * 4.0), 1.0);
}
`,
  },

  create({ state, flash }) {
    let hue = 0;
    let hueShown = 0;
    let sun = 0;
    let flood = 0;
    let lastChord = null;
    let lastDrop = null;
    return {
      step(dt, m, clocks) {
        if (lastChord === null) lastChord = m.stamp.chord;
        if (lastDrop === null) lastDrop = m.stamp.drop;
        if (m.stamp.chord !== lastChord) {
          lastChord = m.stamp.chord;
          hue += 0.07;
        }
        if (m.stamp.drop !== lastDrop) {
          lastDrop = m.stamp.drop;
          flood = 1;
          flash(0.4);
        }
        hueShown = m.ease(hueShown, hue, 2, dt);
        sun = m.ease(sun, clocks?.melody ?? 0, 4, dt);
        flood = Math.max(0, flood - dt / m.overBeats(16));
        state[0] = hueShown;
        state[1] = sun;
        state[2] = flood;
      },
    };
  },
};
