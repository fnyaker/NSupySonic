// CHROME — liquid metal, moved by the bass.
//
// Bass music, neurofunk, halftime: sounds that are heavy, glossy and
// shape-shifting, and the picture is exactly that material. Drops of liquid
// chrome — a cluster of metaballs melting into each other — hang in a dark
// studio lit by coloured softboxes, and the bass is what moves them:
//
//   THE METAL is raymarched: five spheres joined with a smooth union, so where
//   two drops meet they neck and merge like mercury. It has no colour of its
//   own; everything you see on it is the STUDIO reflected — three softboxes in
//   the palette's colours, a floor, a horizon line — which is what chrome is,
//   and why it reads as metal and not as grey plastic.
//   THE BASS. The sub swells the drops and pulls them together; the wobble in
//   the mids ripples their surface; the kick squashes the cluster for a beat.
//   THE DROP turns it into ferrofluid: a field of spikes stands up out of the
//   surface and sinks back over four bars, standing up again on big kicks.
//   THE LIGHTS orbit slowly on the bar, so highlights slide over the metal
//   even when the music holds still.
//
// With the artwork in front the drops orbit AROUND it; without, they gather
// in the middle.
//
// Parameters:
//   blobs   how many drops (2..5)    spikes  ferrofluid strength
//   ripple  surface ripple           march   step budget (x tier)

import { onStamp } from "./kit.js";

export default {
  id: "chrome",
  uses: [],
  params: { blobs: 5, spikes: 1, ripple: 1, march: 64 },
  look: { exposure: 1.0, bloom: 1.2, threshold: 0.75, saturation: 1.15 },

  fragment: `
float smin3(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }

// Where drop i is.
vec3 blobAt(int i, float bars, float orbitR) {
  float fi = float(i);
  float a = fi * TAU / 5.0 + bars * TAU * 0.0625 * (1.0 + 0.2 * fi);
  float r = orbitR * (0.8 + 0.25 * sin(bars * 0.7 + fi * 1.9));
  // The sub pulls them in.
  r *= 1.0 - 0.25 * uBandA.x;
  return vec3(cos(a) * r * 1.9, sin(a * 1.3 + fi) * 0.45 * orbitR, sin(a) * r * 0.9);
}

float map(vec3 p, float bars, float orbitR) {
  int n = int(clamp(P_BLOBS, 2.0, 5.0));
  // The kick squashes the cluster, a beat's worth.
  float sq = envB(uSince.y, 0.4) * 0.18 * (0.6 + 0.4 * uCtl.x);
  p.y *= 1.0 + sq;
  float d = 1e3;
  for (int i = 0; i < 5; i++) {
    if (i >= n) break;
    vec3 c = blobAt(i, bars, orbitR);
    float rad = (0.5 + 0.1 * float(i % 2)) * (0.85 + 0.35 * uBandA.x);
    d = smin3(d, length(p - c) - rad, 0.5);
  }
  // Ripples: the mids moving the skin.
  float rip = sin(p.x * 6.0 + uClock.x * 3.0) * sin(p.y * 7.0 - uClock.x * 2.0) * sin(p.z * 6.5);
  d += rip * 0.022 * (0.3 + uBandA.z + uBandA.w) * P_RIPPLE;
  // The drop's ferrofluid: spikes standing out of the surface.
  float sp = uS0.x * P_SPIKES;
  if (sp > 0.01) {
    vec3 q = p * 4.0;
    float spike = pow(max(0.0, sin(q.x) * sin(q.y) * sin(q.z)), 4.0);
    d -= spike * 0.32 * sp;
  }
  return d;
}

vec3 normalAt(vec3 p, float bars, float orbitR) {
  vec2 e = vec2(0.002, 0.0);
  return normalize(vec3(
    map(p + e.xyy, bars, orbitR) - map(p - e.xyy, bars, orbitR),
    map(p + e.yxy, bars, orbitR) - map(p - e.yxy, bars, orbitR),
    map(p + e.yyx, bars, orbitR) - map(p - e.yyx, bars, orbitR)));
}

// The studio, as seen in a mirror: a sky that brightens toward a hard white
// horizon, a dark floor below it, and three softboxes. Chrome IS its
// environment — a mirror of a dark room is a black blob — so this is lit
// like a product shot: one bright line that every curve of the metal bends.
vec3 studio(vec3 rd, float bars) {
  vec3 c = mix(mix(uPalMid.rgb, vec3(1.0), 0.2) * 0.45, uPalLow.rgb * 0.12, smoothstep(0.0, 0.8, rd.y));
  c += vec3(1.0) * exp(-pow(rd.y * 12.0, 2.0)) * 1.1;
  if (rd.y < 0.0) {
    // The floor: dark, with the faint reflection of the horizon on it.
    c = uPalBg.rgb * 0.4 + mix(uPalMid.rgb, vec3(1.0), 0.3) * exp(rd.y * 5.0) * 0.2;
    // A bounce card under the metal, so its underside is not a black hole.
    c += mix(uPalLow.rgb, uPalMid.rgb, 0.5) * exp(-pow((rd.y + 0.6) * 4.0, 2.0)) * 0.5;
  }
  float t = bars * TAU * 0.0625;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float a = t + fi * TAU / 3.0;
    vec3 dir = normalize(vec3(cos(a), 0.45 + 0.25 * fi, sin(a)));
    vec3 x = normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
    vec3 y = cross(x, dir);
    float u = dot(rd, x);
    float v = dot(rd, y);
    float on = step(0.0, dot(rd, dir));
    float box = smoothstep(0.3, 0.24, abs(u)) * smoothstep(0.5, 0.42, abs(v)) * on;
    vec3 bc = i == 0 ? uPalHigh.rgb : i == 1 ? uPalMid.rgb : uPalAcc.rgb;
    c += mix(bc, vec3(1.0), 0.3) * box * 3.0;
  }
  return c;
}

void main() {
  vec2 p = fragP();
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  // The cluster sits round the artwork when there is one.
  float orbitR = uHole.z > 0.0 ? max(uHole.z, uHole.w) * 2.6 + 0.6 : 1.0;
  // Looking at the cluster from slightly above; it lands on the artwork's
  // centre on screen (or the frame's).
  vec3 ro = vec3(0.0, 0.25, -2.6);
  vec3 rd = normalize(vec3(p - uHole.xy - vec2(0.0, 0.1), 1.0));
  rd.yz *= rot(0.1);
  ro.xz *= rot(0.15 * sin(bars * 0.2));
  rd.xz *= rot(0.15 * sin(bars * 0.2));

  int steps = int(clamp(P_MARCH * uQual.x, 32.0, 96.0));
  float t = 0.5;
  bool hit = false;
  float near = 1e3;
  for (int i = 0; i < 96; i++) {
    if (i >= steps) break;
    vec3 pos = ro + rd * t;
    float d = map(pos, bars, orbitR);
    near = min(near, d / t);
    if (d < 0.0008 * t) { hit = true; break; }
    t += d * (0.65 - 0.25 * uS0.x);
    if (t > 9.0) break;
  }
  // The void the metal hangs in: a soft gradient, the softboxes only as the
  // glow they throw on the haze (seen directly they would be rectangles
  // hanging in the dark, which is a photo studio, not a picture).
  vec3 col = mix(uPalBg.rgb * 0.5, uPalLow.rgb * 0.07, smoothstep(-0.8, 0.9, p.y));
  col += mix(uPalMid.rgb, uPalHigh.rgb, 0.5) * exp(-dot(p - uHole.xy, p - uHole.xy) * 0.8) * 0.05 * (0.6 + 0.4 * uFlow.x);
  // The glow of the metal on the air round it: a halo where rays grazed it.
  col += mix(uPalMid.rgb, uPalHigh.rgb, 0.5) * exp(-near * 30.0) * 0.05 * (0.5 + uFlow.x);
  if (hit) {
    vec3 pos = ro + rd * t;
    vec3 n = normalAt(pos, bars, orbitR);
    vec3 r = reflect(rd, n);
    float fres = 0.65 + 0.35 * pow(1.0 - max(dot(n, -rd), 0.0), 5.0);
    vec3 refl = studio(r, bars);
    // Chrome is a mirror, tinted the faintest bit toward the palette.
    col = refl * fres * mix(vec3(1.0), uPalHigh.rgb, 0.15);
    // The kick flashes the softboxes, which the metal catches.
    col *= 1.0 + 0.8 * uHit.y * amp;

  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    let spikes = 0;
    const drop = onStamp((m) => m.stamp.drop, () => {
      spikes = 1;
      flash(0.8);
    });
    return {
      step(dt, m) {
        drop(m);
        // The spikes sink back over four bars — and stand up again on every
        // big kick while the drop is still going.
        spikes = Math.max(0, spikes - dt / m.overBeats(16));
        if (m.bigKick && m.dropped > 0.3) spikes = Math.max(spikes, 0.7);
        state[0] = spikes * spikes;
      },
    };
  },
};
