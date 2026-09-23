// HYPERESPACE — the approach, and the jump.
//
// Trance is about arrival: eight bars of rising filter and rolled snares, then
// the release. So the picture is a flight through a star field whose speed IS
// the arrangement — cruising through the breakdown, accelerating through the
// build until the stars stretch into lines, and jumping at the drop: a flash,
// a burst of speed, a warp gate ringing past.
//
//   THE STARS are real points in a volume, projected: each one has a fixed
//   position in the tunnel of space and a depth that the flight pulls toward
//   the viewer, so near stars are big, fast and streaked, far ones are pin
//   pricks. Their streak is the distance they travel in a sliver of a beat —
//   exactly what a camera shutter would record — so the streaks lengthen by
//   themselves as the flight speeds up. Eight hundred of them at the high tier,
//   drawn as instanced sprites with no CPU work at all.
//   THE NEBULA behind them turns slowly, lit in the palette, brighter where the
//   melody sits.
//   THE GATES. Every downbeat in a drop sends a ring of light rushing past the
//   camera; a chord change tints the whole field.
//
// With the artwork in front, the flight starts behind the cover: the stars
// stream out of it.
//
// Parameters:
//   stars   field density     spiral  a vortex (0 = straight flight)
//   nebula  cloud strength     gates   warp-gate rings

import { eventRing, onStamp } from "./kit.js";

const STARS = 820;

const SHARED = `
// Where the flight is: uS0.x is the distance flown (in field depths).
float flown() { return uS0.x; }
float speedNow() { return uS0.y; }
`;

export default {
  id: "hyperspace",
  uses: ["noise3"],
  params: { stars: 1, spiral: 0.15, nebula: 1, gates: 1 },
  look: { exposure: 1.0, bloom: 1.3, threshold: 0.7, saturation: 1.2 },

  fragment: `${SHARED}
void main() {
  vec2 p = fragP() - uHole.xy;
  float beats = uClock.x * uSpeed;
  float bars = uClock.y * uSpeed;
  float r = length(p);
  float a = atan(p.y, p.x);
  vec3 col = uPalBg.rgb * 0.5;
  // The nebula: a tunnel of cloud around the flight, turning slowly, pulled
  // toward the viewer with the flight itself. Sampled on the CIRCLE (cos, sin)
  // of a 3D noise rather than on the angle, which has a seam where atan wraps.
  float depth = 0.6 / max(r, 0.05);
  float turn = bars * 0.05 + P_SPIRAL * depth * 0.4;
  vec2 cs = vec2(cos(a + turn), sin(a + turn));
  vec3 np = vec3(cs * 1.7, depth * 0.35 + flown() * 0.12);
  float n = fbm3(np, 5);
  float n2 = fbm3(np * 2.1 + vec3(3.0, 1.0, 0.0), 4);
  float cloud = smoothstep(0.3, 0.8, n) * exp(-depth * 0.25);
  vec3 neb = mix(uPalLow.rgb, uPalMid.rgb, n2) * cloud * (0.12 + 0.2 * uMood.y + 0.3 * uBandB.w);
  neb += mix(uPalHigh.rgb, uPalAcc.rgb, 0.3 + 0.4 * uHit2.z) * pow(cloud, 3.0) * 0.25;
  col += neb * P_NEBULA;
  // The core: the light at the end of the flight.
  col += mix(uPalHigh.rgb, vec3(1.0), 0.3) * glow(r, 0.04 + 0.05 * speedNow()) * (0.2 + 0.35 * uMood.y);
  // Speed lines: a radial streak field that appears only at speed.
  float sl = pow(clamp(noise3(vec3(cs * 14.0, depth * 0.2 + flown() * 2.0)) * 1.3 - 0.15, 0.0, 1.0), 5.0);
  col += uPalHigh.rgb * sl * smoothstep(1.2, 3.0, speedNow()) * 0.35 * smoothstep(0.1, 0.5, r);
  // Warp gates: rings of light that rush past.
  for (int i = 0; i < 8; i++) {
    vec4 ev = uEv[i];
    float age = uClock.x - ev.x;
    if (ev.y <= 0.0 || age < 0.0 || age > 2.0) continue;
    // A gate comes from far away (small ring) and passes the camera (huge).
    float gz = mix(3.0, 0.05, age / 2.0);
    float R = 0.35 / gz;
    float ring = exp(-pow((r - R) / (0.01 + R * 0.04), 2.0));
    col += mix(uPalHigh.rgb, uPalAcc.rgb, ev.z) * ring * ev.y * P_GATES * (1.0 - age / 2.0) * 1.2;
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.4;
  col *= mix(0.35, 1.0, clearOfHole(fragP(), 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  particles: {
    count: STARS,
    vertex: `${SHARED}
void particle(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind) {
  float j = float(id);
  vec3 h = hash31(j * 1.731 + 0.3);
  col = vec4(0.0); pos = vec2(0.0); axis = vec2(0.0); width = 0.0; kind = 0.0;
  if (j >= ${STARS}.0 * P_STARS * uQual.y) return;
  // A fixed place in the tube of space, a depth that the flight pulls in.
  float ang = h.x * TAU;
  float rad = 0.15 + 2.2 * sqrt(h.y);
  float span = 6.0;
  float z = span - mod(h.z * span + flown(), span);
  if (z < 0.05) return;
  // A vortex: the stars turn around the axis the nearer they get.
  ang += P_SPIRAL * 2.5 / (0.3 + z);
  vec2 xy = vec2(cos(ang), sin(ang)) * rad;
  vec2 at = xy / z;
  if (abs(at.x) > uFrame.z * 1.3 || abs(at.y) > 1.3) return;
  // The streak: where the star was a sliver of a beat ago.
  float dz = speedNow() * 0.08 + 0.002;
  vec2 was = xy / (z + dz);
  pos = uHole.xy + (at + was) * 0.5;
  axis = (at - was) * 0.5 + normalize(at + 1e-4) * 0.002;
  float near = clamp(1.0 - z / span, 0.0, 1.0);
  width = 0.0015 + 0.004 * near * near;
  float fade = smoothstep(span, span * 0.7, z) * smoothstep(0.05, 0.3, z);
  vec3 c = mix(vec3(0.85, 0.9, 1.0), pal(h.x), 0.35);
  col = vec4(c * (0.4 + 1.8 * near * near) * fade, 1.0);
  kind = near;
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  float r = 1.0 - smoothstep(0.0, 1.0, length(q));
  float head = smoothstep(-0.3, 1.0, q.x);
  return vec4(c.rgb * r * (0.4 + 1.2 * head), 1.0);
}
`,
  },

  create({ ev, state, flash }) {
    const ring = eventRing(ev);
    let flownD = 0;
    let speed = 0.6;
    let jump = 0;
    let n = 0;
    const gate = onStamp((m) => m.stamp.bar, (s, m) => {
      if (m.drive > 0.45 && m.breakdown < 0.4) ring.push(s, 0.8, (n++ % 2) * 1.0, 0);
    });
    const drop = onStamp((m) => m.stamp.drop, (s) => {
      jump = 1;
      ring.push(s, 1.6, 1, 0);
      flash(1);
    });
    return {
      step(dt, m) {
        gate(m);
        drop(m);
        // Cruise in the breakdown, accelerate through the build, jump at the
        // drop and settle back to the drive.
        const want = 0.35 + 1.1 * m.drive + 2.6 * m.tension - 0.25 * m.breakdown;
        speed = m.ease(speed, Math.max(0.2, want), 1.5, dt);
        jump = Math.max(0, jump - dt / m.overBeats(4));
        const v = speed + 4 * jump * jump;
        flownD += (dt / m.beat) * v * 0.9;
        state[0] = flownD;
        state[1] = v;
      },
    };
  },
};
