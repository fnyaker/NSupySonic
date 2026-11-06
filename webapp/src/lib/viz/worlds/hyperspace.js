// HYPERESPACE — the approach, and the jump.
//
// Trance is about arrival: eight bars of rising filter and rolled snares, then
// the release. So the picture is a flight through a star field whose speed IS
// the arrangement — cruising through the breakdown, accelerating through the
// build until the stars stretch into lines, and jumping at the drop.
//
//   THE FLIGHT has a vanishing point, not a flat radial filter. The stars are
//   real points in a volume, projected: each has a depth the flight pulls
//   toward the camera, so near stars are big, fast and heavily streaked, far
//   ones are pin pricks, and three PARALLAX LAYERS (far dust, the main field,
//   near streaks) move at three different depths. The streak is the distance a
//   star travels in a sliver of a beat — exactly what a camera shutter would
//   record — so it lengthens by itself as the flight speeds up. The field is
//   stateless and instanced: every star is computed from its index.
//   THE DESTINATION is a hot white core with a palette halo and one thin photon
//   ring, not a brown blur: the light at the end of the tunnel has to be the
//   brightest thing in the picture. It flares on the drop.
//   THE TUNNEL is two depths of 3D fbm around the flight axis, with dust lanes
//   that darken the far cloud: the parallax of the clouds is what gives the
//   volume its depth. The drop opens it, the breakdown closes it.
//   THE JUMP banks the camera. On the drop the whole field rolls a few degrees
//   one way and eases back over two beats — a ship turning, not a filter. The
//   lens fringe is an IMPACT too: it is the engine's `ca`, which only swells on
//   a big kick or a drop, never at rest.
//
// With the artwork in front, the flight starts behind the cover: the stars
// stream out of it. On a portrait phone the vanishing point moves ABOVE the
// cover — the destination would otherwise be hidden by definition — and the
// stars then fall toward the bottom of the frame, which reads as one continuous
// dive.
//
// Parameters:
//   stars   field density     spiral  a vortex (0 = straight flight)
//   nebula  cloud strength     gates   warp-gate rings

import { eventRing, onStamp, hashN } from "./kit.js";

const STARS = 1000;

const SHARED = `
// Where the flight is: uS0.x is the distance flown (in field depths), y the
// speed and z the camera's bank in radians. The whole scene shares the axis.
vec2 warpCentre() {
  vec2 c = uHole.xy;
  if (uHole.z > 0.0 && uFrame.z < 1.20) {
    c.y = clamp(uHole.y + uHole.w + 0.30, -0.20, 0.76);
  }
  return c;
}
float flown() { return uS0.x; }
float speedNow() { return uS0.y; }
float bankNow() { return uS0.z; }
`;

export default {
  id: "hyperspace",
  uses: ["noise3"],
  params: { stars: 1, spiral: 0.15, nebula: 1, gates: 1 },
  look: { exposure: 1.0, bloom: 1.2, threshold: 0.66, saturation: 1.22, ca: 1 },

  fragment: `${SHARED}
// A sparse dust of far stars in the tunnel, so the frame is never a black sheet
// with a few bright points on it. Two depths, each a fixed hash field, move at
// different rates with the flight.
vec3 deepStars(vec2 q, float travel) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    float layer = float(i);
    float scale = layer < 0.5 ? 34.0 : 61.0;
    // The stars drift outward from the axis; the cell grid is sampled in the
    // flight's own frame so a wrap is not a visible seam.
    vec2 sp = q * scale * (1.0 + 0.10 * travel) + layer * 17.3;
    vec2 cell = floor(sp);
    vec2 h = hash22(cell + layer * 31.7);
    float d = length(fract(sp) - 0.5 - (h - 0.5) * 0.55);
    float on = step(0.958, h.x);
    float tw = 0.55 + 0.45 * sin(uClock.x * (0.35 + 1.8 * h.y) + h.x * 40.0);
    float wide = layer < 0.5 ? 0.055 : 0.038;
    acc += mix(vec3(0.72, 0.80, 1.0), uPalHigh.rgb, 0.25) * on * glow(d, wide) * tw * (layer < 0.5 ? 0.18 : 0.30);
  }
  return acc;
}

void main() {
  vec2 fp = fragP();
  vec2 centre = warpCentre();
  float bank = bankNow();
  vec2 p = rot(bank) * (fp - centre);
  float r = length(p);
  float ang = atan(p.y, p.x);
  float bars = uClock.y * uSpeed;
  float travel = flown();
  float speed = speedNow();
  float drop = uArc.x;
  vec3 col = uPalBg.rgb * (0.30 + 0.10 * uMood.y);

  // --- the tunnel: two depths of cloud around the axis ------------------------
  float depth = 0.55 / max(r, 0.055);
  float turn = bars * 0.045 + P_SPIRAL * depth * 0.40;
  vec2 cs = vec2(cos(ang + turn), sin(ang + turn));
  vec3 np = vec3(cs * 1.55, depth * 0.30 + travel * 0.10);
  float n1 = fbm3(np, 5);
  float n2 = fbm3(np * 2.15 + vec3(2.7, -1.1, travel * 0.055), 4);
  float cloud = smoothstep(0.28, 0.82, n1);
  // The dust lanes: they eat the light between two arms, which is what makes
  // the cloud a volume rather than a glow.
  float dust = smoothstep(0.56, 0.92, n2);
  vec3 neb = mix(uPalLow.rgb, uPalMid.rgb, 0.30 + 0.60 * n2);
  neb = mix(neb, uPalHigh.rgb, smoothstep(0.52, 1.0, n1) * 0.65);
  neb *= cloud * (0.72 + 0.55 * uMood.y + 0.85 * drop);
  col += neb * P_NEBULA * 0.85;
  col *= 1.0 - 0.42 * dust * smoothstep(0.14, 0.62, r) * P_NEBULA;

  // --- the destination ---------------------------------------------------------
  float coreR = 0.042 + 0.016 * uBandA.x;
  float core = exp(-(r * r) / (coreR * coreR));
  float halo = glow(r, 0.095 + 0.030 * uHit.y + 0.030 * drop);
  vec3 hot = mix(vec3(1.0), uPalHigh.rgb, 0.20);
  col += hot * (core * 2.8 + halo * 0.70) * (0.55 + 0.35 * uMood.y + 0.55 * drop);
  // One thin photon ring round it: the lens of the destination, not a badge.
  float ringR = 0.064 + 0.022 * drop + 0.006 * uHit.y;
  float ringW = 0.0045 + 0.005 * drop;
  float ring = exp(-pow((r - ringR) / ringW, 2.0));
  col += mix(vec3(1.0), uPalHigh.rgb, 0.32) * ring * (0.22 + 0.70 * drop) * 0.90;

  // --- the speed: radial filaments, alive only once the flight is fast --------
  float fil = noise3(vec3(cs * 9.0, depth * 0.12 + travel * 1.7));
  fil = pow(clamp(fil * 1.7 - 0.34, 0.0, 1.0), 4.0);
  col += mix(uPalHigh.rgb, vec3(1.0), 0.30) * fil
       * smoothstep(0.55, 2.8, speed) * 0.60 * smoothstep(0.05, 0.42, r);
  col += deepStars(p, travel);

  // --- the warp gates: structures rushing past, not hoops pasted on ----------
  for (int i = 0; i < 8; i++) {
    vec4 ev = uEv[i];
    float age = uClock.x - ev.x;
    if (ev.y <= 0.0 || age < 0.0 || age > 2.2) continue;
    float ga = clamp(age / 1.6, 0.0, 1.0);
    float gz = mix(1.55, 0.055, ga);
    float R = 0.30 / gz;
    float wR = max(0.010 + R * 0.040, uFrame.w * 2.0);
    float dr = r - R;
    // Segments that turn as the gate comes: a structure rather than a hoop.
    float seg = 0.58 + 0.42 * smoothstep(0.26, 0.34, fract((ang + age * 0.55) / TAU * 18.0));
    float gate = exp(-(dr * dr) / (wR * wR)) * seg;
    gate += glow(dr, wR * 3.5) * 0.20;
    vec3 gc = mix(uPalHigh.rgb, vec3(1.0), 0.32);
    gc = mix(gc, uPalAcc.rgb, 0.10);
    float life = 1.0 - age / 2.2;
    col += gc * gate * ev.y * P_GATES * life * life * 1.5
         * smoothstep(0.0, 0.10, age);
  }

  // The engine's flash, and a little of the palette on the impact.
  col += mix(vec3(1.0), uPalAcc.rgb, 0.25) * uHit2.w * 0.45;
  // The artwork is opaque; under it the flight is only ambience.
  col *= mix(0.32, 1.0, clearOfHole(fp, 0.05));
  // A cold edge is not a vignette: the last few per cent are the tunnel wall.
  float edge = min(uFrame.z - abs(fp.x), 1.0 - abs(fp.y));
  col *= mix(0.78, 1.0, smoothstep(0.0, 0.08, edge));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  particles: {
    count: STARS,
    vertex: `${SHARED}
void particle(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind) {
  float j = float(id);
  vec3 h1 = hash31(j * 1.731 + 0.3);
  vec3 h2 = hash31(j * 2.113 + 9.1);
  vec3 h3 = hash31(j * 0.917 + 4.7);
  col = vec4(0.0); pos = vec2(0.0); axis = vec2(0.0); width = 0.0; kind = 0.0;
  if (j >= ${STARS}.0 * P_STARS * uQual.y) return;
  // Three parallax layers. The far one is dust, the near one is the streaks
  // that fill the frame on the drop. Their depth spans differ, so the same
  // distance flown unwinds them at three different apparent speeds.
  float layer = floor(h3.x * 3.0);
  float span = layer < 0.5 ? 10.0 : layer < 1.5 ? 5.5 : 3.0;
  float rmax = layer < 0.5 ? 3.6 : layer < 1.5 ? 2.5 : 1.9;
  float ang = h1.x * TAU;
  float rad = 0.10 + rmax * sqrt(h1.y);
  float z = span - mod(h1.z * span + flown(), span);
  if (z < 0.055) return;
  // A vortex: the nearer the star, the more it turns around the axis.
  ang += P_SPIRAL * mix(1.0, 2.6, clamp(1.0 - z / span, 0.0, 1.0));
  vec2 xy = vec2(cos(ang), sin(ang)) * rad;
  vec2 at = rot(bankNow()) * (xy / z);
  if (abs(at.x) > uFrame.z * 1.35 || abs(at.y) > 1.35) return;
  // The streak: where the star was a sliver of a beat ago. Capped against the
  // star's own depth so a near one does not become a smear across the frame.
  float dz = min(speedNow() * 0.095 + 0.002, z * 0.65);
  vec2 was = rot(bankNow()) * (xy / (z + dz));
  pos = warpCentre() + (at + was) * 0.5;
  axis = (at - was) * 0.5 + normalize(at + 1e-4) * 0.002;
  float near = clamp(1.0 - z / span, 0.0, 1.0);
  float baseW = layer < 0.5 ? 0.0011 : layer < 1.5 ? 0.0020 : 0.0034;
  width = max(baseW + 0.006 * near * near, uFrame.w * 0.55);
  float fade = smoothstep(span, span * 0.74, z) * smoothstep(0.055, 0.24, z);
  vec3 c = layer < 0.5
    ? mix(vec3(0.78, 0.86, 1.0), uPalHigh.rgb, 0.22)
    : layer < 1.5
      ? mix(vec3(0.90, 0.95, 1.0), uPalHigh.rgb, 0.42)
      : mix(vec3(1.0), uPalAcc.rgb, 0.14);
  // A handful of warmer stars: a field where every point is the same white is a
  // screensaver, and real star fields have colour temperature.
  c = mix(c, vec3(1.0, 0.74, 0.48), step(0.955, h2.y) * 0.55);
  float bright = layer < 0.5 ? 0.38 : layer < 1.5 ? 0.86 : 1.55;
  float tw = 0.72 + 0.28 * sin(uClock.x * (0.9 + 2.4 * h2.x) + j);
  col = vec4(c * bright * (0.30 + 0.85 * near * near) * fade * tw, 1.0);
  kind = layer + near * 0.4;
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  float d = length(q);
  float body = exp(-d * d * 4.5) + 0.12 * max(0.0, 1.0 - d);
  // The head of a warp streak is brighter than its tail: the camera sees the
  // star now, and the trail is where it was.
  float head = smoothstep(-0.35, 1.0, q.x);
  return vec4(c.rgb * body * (0.35 + 1.35 * head), 1.0);
}
`,
  },

  create({ ev, state, flash }) {
    const ring = eventRing(ev);
    let flownD = 0;
    let speed = 0.6;
    let jump = 0;
    let bank = 0;
    let bankTo = 0;
    let n = 0;
    const gate = onStamp((m) => m.stamp.bar, (s, m) => {
      if (m.drive > 0.45 && m.breakdown < 0.4) ring.push(s, 0.8, (n++ % 2) * 1.0, 0);
    });
    const drop = onStamp((m) => m.stamp.drop, (s) => {
      jump = 1;
      // The ship banks: alternate the side so two drops are not the same frame.
      bankTo = (hashN(n) > 0.5 ? 1 : -1) * 0.18;
      n++;
      ring.push(s, 1.6, 1, 0);
      flash(1);
    });
    return {
      step(dt, m) {
        gate(m);
        drop(m);
        // Cruise in the breakdown, accelerate through the build, jump at the
        // drop and settle back to the drive.
        const want = 0.40 + 1.35 * m.drive + 2.8 * m.tension - 0.28 * m.breakdown;
        speed = m.ease(speed, Math.max(0.22, want), 1.5, dt);
        jump = Math.max(0, jump - dt / m.overBeats(4));
        bankTo *= Math.exp(-dt / m.overBeats(3.0));
        bank = m.ease(bank, bankTo, 0.30, dt);
        const v = speed + 4 * jump * jump;
        flownD += (dt / m.beat) * v * 0.9;
        state[0] = flownD;
        state[1] = v;
        state[2] = bank;
      },
    };
  },
};
