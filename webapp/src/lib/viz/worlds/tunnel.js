// CORRIDOR — a machine tunnel, one ring of light per beat.
//
// Techno is a machine running at a constant speed, and the picture that has
// always belonged to it is the corridor: strict, symmetrical, receding, lit by
// its own structure. This one is drawn the way a tunnel is on a real renderer —
// every pixel is a point on the wall at a DEPTH (the inverse of its distance
// from the axis, measured in the corridor's own cross-section), so the walls
// carry real perspective: ribs bunch up in the distance, panels foreshorten,
// fog swallows the far end into a single glow.
//
//   THE STRUCTURE. A cross-section of `sides` walls (a four-sided shaft, a
//   hexagon, a round bore at twenty-four), ribs every unit of depth, panel
//   seams, and a neon strip running the length of every corner.
//   THE BEAT. The camera advances a fixed number of ribs per beat, so the
//   corridor IS the tempo: at 128 BPM the ribs pass at 128 a minute. Every beat
//   sends a ring of light racing down the walls away from the viewer; every
//   main kick flashes the whole corridor from the far end.
//   THE ARRANGEMENT. A build accelerates the run and narrows the fog; a drop
//   surges; a breakdown slows to a crawl and dims the strips to embers.
//
// Shape switches (the skins): `twist` turns the rings into a helix, `dir` -1
// sends the corridor away from the viewer (minimal recedes, hardtechno
// charges), `dash` breaks the light rings into strobing segments, `scan` lays a
// crawl of machine noise over it (industrial).
//
// With the artwork in front, the corridor simply runs behind it: the cover
// becomes the far end everything recedes into.

export default {
  id: "tunnel",
  uses: ["noise"],
  params: { sides: 4, twist: 0, dir: 1, dash: 0, scan: 0.15, depth: 1, strips: 1 },
  look: { exposure: 1.0, bloom: 1.2, threshold: 0.75, saturation: 1.15 },

  fragment: `
// The corridor's cross-section, as a distance from the axis in its own metric:
// a rectangle shaped like the frame (four walls), or a regular polygon.
float section(vec2 p, float N, out float u) {
  if (N < 4.5 && N > 3.5) {
    // A rectangle with the frame's proportions and softened corners, so a 16:9
    // beamer looks down a wide corridor and a phone down a tall one.
    vec2 half2 = vec2(clamp(uFrame.z, 0.6, 1.9), 1.0);
    vec2 q = abs(p) / half2;
    float k = 8.0;
    float rp = pow(pow(q.x, k) + pow(q.y, k), 1.0 / k);
    u = atan(p.y * half2.x, p.x) / TAU;
    return rp;
  }
  float seg = TAU / N;
  float a = atan(p.y, p.x);
  float ap = mod(a + seg * 0.5, seg) - seg * 0.5;
  u = a / TAU;
  return length(p) * cos(ap) / cos(seg * 0.5);
}

void main() {
  vec2 p = fragP() - uHole.xy;
  float beats = uClock.x * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float N = max(3.0, floor(P_SIDES + 0.5));
  float u;
  float rp = section(p, N, u);
  const float K = 0.5;           // the corridor's half-height, in depth units
  float cam = uS0.x;
  float dir = sign(P_DIR);
  float z = K / max(rp, 1e-3);   // depth of the wall under this pixel
  float wz = z + cam * dir;      // ...in the corridor's own coordinates
  u += P_TWIST * wz * 0.06;
  float fog = exp(-z * (0.2 + 0.12 * uArc.y));
  // One screen pixel, in the section's metric, at this depth.
  float px = uFrame.w * 1.2;

  // --- the walls: near black, a faint panel grain, a floor that shines ---
  vec3 col = uPalBg.rgb * 0.35;
  float panel = hash12(vec2(floor(u * 24.0), floor(wz * 1.0)));
  col += uPalLow.rgb * (0.015 + 0.02 * panel) * fog;

  // --- the light frames: one every unit of depth, a hairline in PIXELS ---
  // The nearest frame's depth, and how far this pixel is from it on screen.
  float fi = floor(wz + 0.5);
  float zr = (fi - cam * dir) * dir;
  float frameD = 1e3;
  if (zr > 0.02) frameD = abs(rp - K / zr);
  float frameOn = step(0.5, fract(fi * 0.5 + 0.25)) * 0.6 + 0.4; // every other frame brighter
  float frame = glow(frameD, px * 0.9) * frameOn;
  vec3 frameCol = mix(uPalMid.rgb, uPalHigh.rgb, 0.6);
  // The beat pulse: a wave of light racing away down the corridor, one per
  // beat. A frame lights up as the wave passes its depth.
  float pulseZ = uPhase.x * 6.0 + 0.3;
  float pulse = exp(-pow((z - pulseZ) * 1.8, 2.0)) * (0.4 + 0.9 * uFlow.x) * (1.0 - 0.8 * uArc.z);
  col += frameCol * frame * (0.1 + 0.8 * pulse + 0.4 * uHit.y * amp) * fog * 1.2;

  // --- the rails: lines running the length of every wall, a wireframe of the
  // corridor's own structure. Pixel-thin, so they stay crisp at any size.
  float M = 20.0;
  float du = abs(fract(u * M) - 0.5) / M;
  float rScreen = length(p);
  float rail = glow(du * TAU * rScreen, px * 0.8);
  // Every fifth rail is a main rail, brighter.
  float mainRail = step(abs(mod(floor(u * M + 0.5), 5.0)), 0.5);
  float railLvl = (0.06 + 0.18 * mainRail) * (0.4 + 0.6 * uFlow.x);
  // The pulse runs down the rails too, and the LED segments scroll with the run.
  float segs = step(0.3, fract(wz * 2.0 + floor(u * M) * 0.37));
  col += mix(uPalHigh.rgb, uPalAcc.rgb, 0.3 * mainRail) * rail * (railLvl * (0.5 + 0.5 * segs) + 0.9 * pulse * (0.4 + mainRail)) * fog * (1.0 - 0.5 * uArc.z);
  // A sheen on the floor: the lower wall catches the lights above it.
  float floorW = smoothstep(0.0, -0.35, p.y / max(rScreen, 1e-3));
  col += frameCol * floorW * 0.05 * (0.3 + pulse) * fog;
  // A dashed variant for the strobing machines: the frames break into bars.
  if (P_DASH > 0.02) col *= mix(1.0, step(P_DASH, fract(u * 32.0 + wz * 0.5)), 0.6 * frame);

  // The main kick: the corridor lights from the far end.
  float kick = uHit.y * amp;
  col += mix(uPalMid.rgb, uPalHigh.rgb, 0.6) * kick * exp(-z * 0.2) * 0.25 * (0.4 + frame);
  // The far end: the glow the fog dissolves into.
  col += mix(uPalHigh.rgb, uPalMid.rgb, 0.5) * exp(-rp * 9.0) * (0.3 + 0.5 * uMood.y + 0.9 * kick) * clearOfHole(fragP(), 0.1);
  // Haze in the corridor, lit by it.
  col += uPalMid.rgb * (1.0 - fog) * 0.05 * (0.4 + uMood.y);

  // The machine's own noise, crawling down the picture.
  if (P_SCAN > 0.05) {
    float y = gl_FragCoord.y / uRes.y;
    float scan = smoothstep(0.99, 1.0, fract(y * 5.0 - beats * 0.25)) * P_SCAN;
    col += uPalMid.rgb * scan * 0.2 * (0.4 + uFlow.x);
  }
  col += uPalHigh.rgb * uHit2.w * 0.3;
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, params, flash }) {
    // The run: ribs per beat, integrated so a change of speed changes the
    // speed and never jumps the position.
    let cam = 0;
    let drop = null;
    return {
      step(dt, m) {
        const speed = (0.9 + 0.8 * m.drive + 1.2 * m.build) * (1 - 0.6 * m.breakdown) * (params.depth || 1);
        cam += (dt / m.beat) * speed;
        state[0] = cam;
        if (drop === null) drop = m.stamp.drop;
        if (m.stamp.drop !== drop) {
          drop = m.stamp.drop;
          flash(0.7);
        }
      },
    };
  },
};
