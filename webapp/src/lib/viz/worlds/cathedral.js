// NEF — light through a rose window, down a dark nave.
//
// Classical, choral, organ, film score, post-rock at its most devotional:
// the picture is the inside of a cathedral in the late afternoon. A rose
// window high at the end of the nave, its coloured light falling in shafts
// through the dust, the columns standing black against it.
//
//   THE WINDOW is drawn as glass and lead, and built as a Gothic rose is —
//   twelve pointed lancets between stone mullions, roundels holding
//   quatrefoils, a rosette at the heart — every pane its own colour off the
//   palette and cut by thin leading into pieces of glass that are each a
//   little different.
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
// The rose window's light at q (0 outside it). Drawn as a Gothic rose is
// built: an outer ring of round-headed LANCETS between stone mullions of a
// real width, a middle ring of ROUNDELS each holding a quatrefoil, a rosette
// at the heart — and every pane cut by thin leading into pieces of glass
// that are each a slightly different colour, which is what makes stained
// glass read as glass and not as a colour wheel.
vec3 rose(vec2 q, float hue) {
  vec2 d = (q - roseC()) / roseR();
  float r = length(d);
  if (r > 1.0) return vec3(0.0);
  float px = uFrame.w / roseR();
  const float N = 12.0;
  float a = atan(d.y, d.x);
  float u = (a / TAU + 0.5) * N;
  float sector = floor(u);
  float fa = fract(u) - 0.5;
  float across = fa * TAU / N * r;            // across the sector, in radii
  float ca = ((sector + 0.5) / N - 0.5) * TAU; // the sector's centre angle
  float glass = 0.0;
  float ring;
  float piece;                                 // which piece of glass
  float lead = 0.0;
  if (r > 0.57) {
    // The lancets: straight sides, then a POINTED head — two arcs meeting,
    // as a Gothic lancet's do (a round head read as an egg).
    ring = 2.0;
    const float rh = 0.68;
    float w = PI / N * rh - 0.022;
    float Rc = 1.6 * w;
    float head = max(length(vec2(across + (Rc - w), r - rh)), length(vec2(across - (Rc - w), r - rh))) - Rc;
    float inside = r < rh ? w - abs(across) : -head;
    glass = smoothstep(-px, px, inside) * smoothstep(0.585 - px, 0.585 + px, r);
    // A lancet is glazed in bands.
    float band = (r - 0.585) * 14.0;
    piece = floor(band) + sector * 17.0;
    // ...faded out once the bands are finer than a few pixels, where they
    // would only be moiré.
    lead = smoothstep(px * 14.0 * 1.3, 0.0, abs(fract(band) - 0.5) * 2.0 - 1.0 + px * 14.0 * 1.3)
         * (1.0 - smoothstep(0.12, 0.3, px * 14.0));
    lead = max(lead, smoothstep(px * 1.2, 0.0, abs(across)) * step(r, rh));
  } else if (r > 0.28) {
    // The roundels, one per sector, each with a quatrefoil in its leading.
    ring = 1.0;
    vec2 cc = vec2(cos(ca), sin(ca)) * 0.425;
    vec2 dl = d - cc;
    float rr = length(dl);
    glass = smoothstep(px, -px, rr - 0.105);
    float la = atan(dl.y, dl.x) - ca;
    float foil = 0.06 + 0.025 * abs(cos(la * 2.0));
    lead = smoothstep(px * 1.5, 0.0, abs(rr - foil));
    piece = sector * 3.0 + step(foil, rr);
  } else {
    // The rosette at the heart: six lobes round a boss.
    ring = 0.0;
    float lobes = 0.55 + 0.35 * abs(cos(a * 3.0));
    glass = smoothstep(0.27 + px, 0.27 - px, r) * smoothstep(0.06 - px, 0.06 + px, r);
    lead = smoothstep(px * 1.5, 0.0, abs(r / 0.27 - lobes) * 0.27);
    piece = step(lobes, r / 0.27) + floor((a / TAU + 0.5) * 6.0) * 2.0;
  }
  if (glass <= 0.0) return vec3(0.0);
  // The pane's colour, a hue off the palette turned by the chord changes; each
  // piece a little lighter, darker or warmer than its neighbours.
  float h = hash12(vec2(sector * step(0.5, ring), ring) + 3.1);
  vec3 c = pal(fract(h * 0.8 + hue + ring * 0.13));
  c = mix(c, hue2rgb(fract(h + hue)), 0.35);
  vec3 ph = hash32(vec2(piece, ring + 7.0));
  c *= 0.7 + 0.5 * ph.x;
  c = mix(c, c.gbr, 0.12 * ph.y);
  // Glass is not flat: it has seeds and ripples in it.
  float grain = 0.8 + 0.2 * gnoise(q * 45.0);
  return c * glass * (1.0 - 0.85 * lead) * grain;
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
      // A column is ROUND: shade it across its width as a fluted cylinder lit
      // from the nave, where the window's light comes down, with a capital
      // under the arch and a plinth at its foot. A flat box of one colour
      // read as a cardboard cut-out.
      float cu = (p.x - x) / w;
      float capital = smoothstep(top - 0.05 / z, top - 0.04 / z, p.y);
      float plinth = smoothstep(bottom + 0.06 / z, bottom + 0.05 / z, p.y);
      float wide = 1.0 + 0.25 * max(capital, plinth);
      float col01 = smoothstep(wide + uFrame.w / w, wide - uFrame.w / w, abs(cu)) * step(bottom, p.y) * step(p.y, top);
      float nz = sqrt(max(1.0 - cu * cu / (wide * wide), 0.0));
      float lambert = max(0.0, -side * cu / wide * 0.75 + 0.35 * nz);
      float flutes = 0.8 + 0.2 * cos(cu * PI * 5.0) * (1.0 - max(capital, plinth));
      // The arch springing from the column toward the next one in: a rib
      // with its own round section, lit on its underside.
      float xn = side * 1.25 / (z + 0.9);
      float ax = (p.x - x) / (xn - x);
      float archY = top + (0.9 / (z + 0.9) - top) * ax + 0.12 / z * sin(clamp(ax, 0.0, 1.0) * PI);
      float rw = 0.035 / z;
      float rv = (p.y - archY) / rw;
      float arch = step(0.0, ax) * step(ax, 1.0) * smoothstep(1.0 + uFrame.w / rw, 1.0 - uFrame.w / rw, abs(rv));
      float archL = max(0.0, -rv * 0.6 + 0.4) * sqrt(max(1.0 - rv * rv, 0.0));
      vec3 light = mix(uPalMid.rgb, uPalHigh.rgb, 0.5) * sun * (1.0 - float(k) * 0.11);
      vec3 albedo = mix(vec3(0.5, 0.46, 0.42), uPalLow.rgb, 0.25);
      vec3 stoneC = albedo * (0.025 + light * 0.28 * lambert) * flutes;
      vec3 archC = albedo * (0.02 + light * 0.22 * archL);
      col = mix(col, archC, arch);
      col = mix(col, stoneC, col01);
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
