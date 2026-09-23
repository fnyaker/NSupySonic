// CORRIDOR — a machine tunnel, lit by its own rings.
//
// Techno is a machine running at a constant speed, and the picture that has
// always belonged to it is the corridor: strict, symmetrical, receding. The
// first version drew it as glowing lines on black — a wireframe, which is what
// a corridor looks like in a 1998 screensaver. This one is ARCHITECTURE: every
// pixel is a point on a wall at a real depth (the inverse of its distance from
// the axis, in the corridor's own cross-section), the walls are panelled, and
// the only light in the place comes from the fixtures in it.
//
//   THE RINGS. A light fixture runs round the section every unit of depth. It
//   lights the panels either side of it and falls off along the walls, so the
//   corridor reads as lit surfaces with light pooling between dark stretches,
//   not as lines. Every other ring burns brighter; a main kick fires them all.
//   THE BEAT. A ring of light runs away down the corridor once per beat (once
//   per bar in a breakdown), lighting the walls as it passes and making each
//   fixture flare as it goes by — the tempo, travelling.
//   THE FLOOR. Polished: it mirrors the ceiling's rings (a ring on the ceiling
//   at depth 3z shows in the floor at depth z, exactly, for a flat floor and
//   ceiling) and carries a streak of the far end's light.
//   THE STRIPS. LED strips along every corner, segmented, washing the walls
//   either side of them.
//   THE AIR. Haze, which swallows the far end into one glow and throws faint
//   shafts from it.
//
// The camera advances at a rate set in beats, so the corridor IS the tempo; a
// build accelerates the run and thickens the haze, a drop surges, a breakdown
// slows to a crawl and dims the rings to embers.
//
// Shape switches (the skins): `sides` (a four-sided shaft shaped like the
// frame, a triangle, a hexagon, a round bore at twenty-four), `twist` winds
// the rings into a helix, `dir` -1 runs the camera backwards (minimal
// recedes, hardtechno charges), `dash` breaks the rings into strobing
// segments, `scan` lays a crawl of machine noise over it (industrial).
//
// With the artwork in front, the corridor runs behind it: the cover becomes
// the far end everything recedes into.

export default {
  id: "tunnel",
  uses: ["noise"],
  params: { sides: 4, twist: 0, dir: 1, dash: 0, scan: 0.15, depth: 1, strips: 1 },
  look: { exposure: 1.0, bloom: 1.2, threshold: 0.8, saturation: 1.12 },

  fragment: `
const float K = 0.5;   // the section's apothem, in depth units

// The corridor's cross-section at screen point p. Returns its distance metric
// rp (the wall under p lies at depth K / rp) and fills in
//   n   the wall's inward normal, in the section plane
//   s   the position across the wall, in world units
//   u   the angle round the axis, 0..1
//   cd  the screen distance to the nearest corner, where two walls meet.
float section(vec2 p, float N, out vec2 n, out float s, out float u, out float cd) {
  u = atan(p.y, p.x) / TAU;
  if (N > 3.5 && N < 4.5) {
    // A rectangle with the frame's proportions and softened corners, so a
    // 16:9 beamer looks down a wide corridor and a phone down a tall one.
    vec2 h = vec2(clamp(uFrame.z, 0.6, 1.9), 1.0);
    vec2 q = max(abs(p) / h, vec2(1e-5));
    vec2 qk = pow(q, vec2(8.0));
    float rp = pow(qk.x + qk.y, 0.125);
    n = -normalize(sign(p) * qk / q / h + 1e-9);
    s = (qk.x > qk.y ? p.y : p.x) * K / max(rp, 1e-4);
    cd = abs(abs(p.x) * h.y - abs(p.y) * h.x) / length(h);
    return rp;
  }
  // A regular polygon with a face at the bottom, so there is always a floor.
  float seg = TAU / N;
  float a = atan(p.y, p.x);
  float off = mod(-0.5 * PI, seg);
  float ac = off + floor((a - off) / seg + 0.5) * seg;
  vec2 c = vec2(cos(ac), sin(ac));
  n = -c;
  float rp = dot(p, c);
  s = dot(p, vec2(-c.y, c.x)) * K / max(rp, 1e-4);
  cd = length(p) * sin(max(seg * 0.5 - abs(a - ac), 0.0));
  return rp;
}

// How bright ring k burns: every other one brighter, all of them on the kick,
// and the one the beat's light is passing flares.
float ringLevel(float k, float cam, float dir, float zp, float pulseI, float kick, float calm) {
  float zk = (k - cam * dir) * dir;
  float base = mix(0.35, 1.0, step(0.5, fract(k * 0.5))) * mix(1.0, 0.22, calm);
  // A ring right at the lens flaring would fill the frame's border with
  // bloom on every beat; the pulse takes a metre to come into its own.
  float flare = exp(-pow((zk - zp) * 1.4, 2.0)) * pulseI * 2.4 * smoothstep(0.35, 1.1, zk);
  return base * (0.5 + 0.5 * uFlow.x) + flare + kick * 0.8;
}

// How much of a ring's light reaches a wall dd depth units away from it: a
// hot pool right beside the fixture and a long, soft tail.
float ringReach(float dd) {
  return 0.75 / (1.0 + dd * dd * 70.0) + 0.25 / (1.0 + dd * dd * 5.0);
}

void main() {
  vec2 p = fragP() - uHole.xy;
  float px = uFrame.w;
  float beats = uClock.x * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float N = max(3.0, floor(P_SIDES + 0.5));
  vec2 n;
  float s, u, cd;
  float rp = max(section(p, N, n, s, u, cd), 1e-3);
  float cam = uS0.x;
  float dir = P_DIR < 0.0 ? -1.0 : 1.0;
  float z = K / rp;                 // the wall's depth under this pixel
  float wz = z + cam * dir;          // ...in the corridor's own coordinates
  float calm = smoothstep(0.2, 0.8, uArc.z);
  float kick = uHit.y * amp * (1.0 - 0.7 * calm);
  float fog = exp(-z * (0.15 + 0.1 * uArc.y));

  vec3 ringCol = mix(uPalMid.rgb, uPalHigh.rgb, 0.6);
  vec3 stripCol = mix(mix(uPalHigh.rgb, uPalAcc.rgb, 0.25), vec3(1.0), 0.3);
  vec3 hazeCol = mix(uPalMid.rgb, uPalHigh.rgb, 0.4);

  // --- the beat's light, running away down the corridor ---
  float ph = mix(uPhase.x, uPhase.y, calm);
  float zp = 0.3 + ph * 7.0;
  float pulseI = (0.55 + 1.0 * uFlow.x) * (1.0 - 0.55 * calm) * (1.0 - 0.45 * ph);

  // --- which rings are near: \`twist\` winds them into a helix ---
  // A whole number of rings per turn, or the helix could not close: it would
  // break where the angle wraps, on the left of the frame.
  float turns = abs(P_TWIST) > 0.05 ? sign(P_TWIST) * max(1.0, floor(abs(P_TWIST) * 2.5 + 0.5)) : 0.0;
  float fwu = fwidth(u);
  float rz = wz + turns * u;
  float fwz = fwidth(wz) + abs(turns) * (fwu > 0.25 ? 0.0 : fwu);
  float k0 = floor(rz);

  // --- the light on the walls ---
  vec3 light = vec3(0.0);
  for (int j = -1; j <= 2; j++) {
    float k = k0 + float(j);
    light += ringCol * ringLevel(k, cam, dir, zp, pulseI, kick, calm) * ringReach(rz - k);
  }
  // The beat's light itself, a moving source.
  light += mix(ringCol, vec3(1.0), 0.3) * pulseI * 1.4 * ringReach((z - zp) * 0.8);
  // The strips wash the walls either side of the corners they run along.
  float stripI = P_STRIPS * (0.3 + 0.7 * uFlow.x) * (1.0 - 0.5 * calm) / sqrt(max(N, 4.0) / 4.0);
  light += stripCol * stripI * 0.35 * exp(-cd * z * 7.0);

  // --- the panels: dark brushed metal, seams as grooves ---
  vec2 tile = vec2(s / 0.2, wz / 0.5);
  vec2 ti = floor(tile);
  vec2 tf = abs(fract(tile) - 0.5);
  vec2 fwt = fwidth(tile);
  float seam = 1.0 - smoothstep(0.0, 0.02 + fwt.x, 0.5 - tf.x) * smoothstep(0.0, 0.02 + fwt.y, 0.5 - tf.y);
  seam *= 1.0 - smoothstep(0.12, 0.35, max(fwt.x, fwt.y));
  float var = hash12(mod(ti, 256.0) + 0.5);
  vec3 albedo = mix(vec3(0.55, 0.58, 0.62), uPalLow.rgb, 0.3) * (0.07 + 0.05 * var);
  vec3 col = albedo * light * (1.0 - 0.75 * seam);

  // --- the fixtures themselves ---
  // Each ring is a strip of real width; past what a pixel can hold it is drawn
  // a pixel wide at the brightness its true width would give, never thicker.
  float kn = floor(rz + 0.5);
  float dd = abs(rz - kn);
  float wR = max(0.007, fwz * 0.7);
  float fixture = exp(-pow(dd / wR, 2.0)) * min(1.0, 0.007 / wR);
  // \`dash\` breaks the rings into segments that swap every beat: a strobe
  // made of the architecture. 0 is whole rings, 1 is every other segment out.
  if (P_DASH > 0.02) {
    float dash = step(0.5, fract(s * 2.5 + kn * 0.5 + floor(beats) * 0.5));
    fixture *= mix(1.0, dash, clamp(P_DASH, 0.0, 1.0));
  }
  float lvN = ringLevel(kn, cam, dir, zp, pulseI, kick, calm);
  col += mix(ringCol, vec3(1.0), 0.25) * fixture * lvN * 2.6;
  // The travelling light has a body too: a thin bright band on the walls.
  float wP = max(0.012, fwidth(z) * 0.7);
  col += mix(ringCol, vec3(1.0), 0.4) * exp(-pow((z - zp) / wP, 2.0)) * min(1.0, 0.012 / wP) * pulseI * 3.0
       * smoothstep(0.35, 1.1, zp);

  // --- the corner strips: LED segments, one pixel minimum ---
  if (P_STRIPS > 0.01) {
    float halfW = 0.012 / z;
    float wS = max(halfW, px * 0.6);
    float fwS = fwidth(wz * 2.0);
    float leds = mix(step(0.3, fract(wz * 2.0)), 0.7, smoothstep(0.25, 0.6, fwS));
    float chase = 0.6 + 0.4 * pow(0.5 + 0.5 * sin((wz * 0.5 - beats) * TAU), 6.0);
    col += stripCol * exp(-pow(cd / wS, 2.0)) * min(1.0, halfW / wS) * leds * chase * stripI * 2.2;
  }

  // --- the floor: polished, mirroring the ceiling ---
  float isFloor = smoothstep(0.7, 0.95, n.y);
  if (isFloor > 0.0) {
    float refl = 0.0;
    if (mod(N, 2.0) < 0.5) {
      // A ring on the ceiling at depth 3z shows in the floor at depth z, and
      // the gloss blurs it more the further the light has to travel.
      float r3 = 3.0 * z + cam * dir;
      float k3 = floor(r3 + 0.5);
      float w3 = 0.04 + 0.06 * z + fwidth(r3) * 0.7;
      refl += ringLevel(k3, cam, dir, zp, pulseI, kick, calm) * exp(-pow((r3 - k3) / w3, 2.0))
            * min(1.0, 0.05 / w3) * exp(-3.0 * z * 0.15);
      // ...and the beat's light, mirrored the same way.
      refl += pulseI * exp(-pow((3.0 * z - zp) / (0.15 + 0.1 * z), 2.0)) * 0.8;
    }
    // A streak of the far end's glow, running down the middle of the floor.
    float streak = exp(-abs(p.x) / (0.015 + 0.2 * abs(p.y))) * exp(-abs(p.y) * 2.0);
    float portal = 0.35 + 0.5 * uMood.y + 0.9 * kick;
    col += (ringCol * refl * 0.55 + mix(uPalHigh.rgb, vec3(1.0), 0.3) * streak * portal * 0.18) * isFloor;
  }

  // --- the air ---
  col = col * fog + hazeCol * (1.0 - fog) * 0.05 * (0.35 + uMood.y + kick);
  // The far end: the glow the haze dissolves into, and faint shafts from it.
  float farR = exp(-rp * 9.0);
  float shafts = 0.5 + 0.25 * sin(u * TAU * 7.0 + beats * 0.13) + 0.25 * sin(u * TAU * 11.0 - beats * 0.09 + 1.7);
  float portal = 0.3 + 0.5 * uMood.y + 0.9 * kick;
  col += mix(uPalHigh.rgb, uPalMid.rgb, 0.5) * (farR + exp(-rp * 2.5) * shafts * shafts * 0.12)
       * portal * clearOfHole(fragP(), 0.1);

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
    // The run: depth units per beat, integrated so a change of speed changes
    // the speed and never jumps the position. It wraps at 128, a period every
    // pattern on the walls repeats in exactly (rings every 1 with every other
    // one brighter, panels and LED segments every 0.5, panel shades hashed on
    // their index modulo 256).
    let cam = 0;
    let drop = null;
    return {
      step(dt, m) {
        const speed = (0.9 + 0.8 * m.drive + 1.2 * m.build) * (1 - 0.6 * m.breakdown) * (params.depth || 1);
        cam = (cam + (dt / m.beat) * speed) % 128;
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
