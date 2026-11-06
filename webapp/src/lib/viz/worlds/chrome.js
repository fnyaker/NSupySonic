// CHROME — liquid metal in a dark studio.
//
// Bass music, neurofunk, halftime, trap: music that is heavy, glossy and
// shape-shifting, and the picture is the material. A great drop of mercury
// hangs in a black studio, smaller beads merging into it, and the bass is what
// moves it.
//
//   THE METAL is raymarched, one large drop smoothly joined to the beads that
//   orbit it. It has no colour of its own: everything on it is the STUDIO
//   reflected — two tall softboxes, a hard horizon, a warm low strip, a black
//   floor — with a Fresnel edge and one hard specular. Narrow sources on a
//   sphere stay crisp; that is what separates chrome from a blurred blob.
//   THE MUSIC. The sub swells and ripples the drop; the kick squashes it and
//   runs a ripple round its skin; the DROP throws the beads outward on their
//   orbits and stretches the drop along the fall, then pulls it back over four
//   bars — a change of shape, not of brightness.
//   THE LIGHTS drift on the bar, so the reflections slide over the metal even
//   when the music holds still.
//
// With the artwork in front, the drop sits in the free band UNDER it;
// without, it hangs in the middle of the frame.
//
// Parameters:
//   blobs   how many beads merge into the drop (2..5)
//   spikes  the drop's burst           ripple  surface ripple
//   march   step budget (x tier)

import { onStamp } from "./kit.js";

export default {
  id: "chrome",
  uses: [],
  params: { blobs: 5, spikes: 1, ripple: 1, march: 64 },
  look: { exposure: 1.0, bloom: 1.0, threshold: 0.9, saturation: 1.04 },

  fragment: `
float wrapPi(float a) { return mod(a + PI, TAU) - PI; }

// A rectangle on the studio wall, anti-aliased by the pixel's angular size.
float panel(float az, float el, float az0, float daz, float el0, float el1, float aa) {
  float a = 1.0 - smoothstep(daz - aa, daz + aa, abs(wrapPi(az - az0)));
  float b = smoothstep(el0 - aa, el0 + aa, el) * (1.0 - smoothstep(el1 - aa, el1 + aa, el));
  return a * b;
}

// The studio as a MIRROR sees it: a hard horizon, two tall strip lights, a
// big key, one warm low strip, a dark floor. Sharp sources, sharp highlights.
vec3 room(vec3 r, float aa, float drift) {
  float az = atan(r.x, r.z);
  float el = r.y;
  vec3 c = el > 0.0
    ? mix(vec3(0.075, 0.080, 0.095), vec3(0.20, 0.215, 0.25), smoothstep(0.0, 0.9, el))
    : mix(vec3(0.030, 0.033, 0.040), vec3(0.085, 0.090, 0.110), smoothstep(-0.7, 0.0, el));
  // The cove line, all round the room: the hairline a mirror keeps.
  c += mix(vec3(0.94, 0.97, 1.0), uPalHigh.rgb, 0.12) * exp(-pow(el / 0.036, 2.0)) * 2.0;
  // A big key high and left, and its narrower mate behind it.
  c += vec3(1.0) * panel(az, el, 2.05 + drift * 0.2, 0.28, 0.24, 0.80, aa) * 4.0;
  c += vec3(1.0) * panel(az, el, 2.62 + drift * 0.2, 0.11, 0.32, 0.72, aa) * 3.2;
  // Two tall strips: the vertical highlights that read as chrome.
  c += mix(vec3(0.95, 0.97, 1.0), uPalHigh.rgb, 0.10) * panel(az, el, -0.92 + drift * 0.8, 0.050, -0.05, 0.88, aa) * 5.5;
  c += mix(vec3(0.95, 0.97, 1.0), uPalMid.rgb, 0.12) * panel(az, el, 0.64 - drift * 0.6, 0.040, 0.05, 0.92, aa) * 5.0;
  // Two narrow coloured strips: the palette in the metal, not a tint over it.
  c += mix(uPalAcc.rgb, vec3(1.0), 0.25) * panel(az, el, -0.28 + drift * 1.1, 0.075, 0.04, 0.62, aa) * 3.2;
  c += mix(uPalHigh.rgb, vec3(1.0), 0.30) * panel(az, el, 0.30 - drift * 0.9, 0.060, 0.10, 0.75, aa) * 2.4;
  // The one warm accent, low on the wall.
  c += mix(uPalAcc.rgb, vec3(1.0), 0.32) * panel(az, el, 1.52, 0.26, 0.015, 0.09, aa) * 2.6;
  // A broad fill behind the camera and a ceiling bounce: the body of the
  // metal, never a black hole.
  c += mix(vec3(0.88, 0.92, 1.0), uPalMid.rgb, 0.08) * panel(az, el, 0.0, 1.3, 0.30, 0.95, aa) * 0.65;
  c += vec3(0.8, 0.86, 1.0) * panel(az, el, 1.30, 0.50, 0.05, 0.85, aa) * 0.22;
  c += vec3(0.8, 0.86, 1.0) * panel(az, el, -1.55, 0.45, 0.02, 0.80, aa) * 0.18;
  c += vec3(0.9, 0.94, 1.0) * smoothstep(0.55, 1.0, el) * 0.25;
  c += vec3(0.8, 0.83, 0.9) * smoothstep(-0.7, -0.15, el) * 0.16;
  return c;
}

// The wall seen directly: a dark cyclorama with the two side strips just out
// of focus and a hard floor line. It frames the drop and lights the edges.
vec3 wall(vec3 r, float aa) {
  float az = atan(r.x, r.z);
  float el = r.y;
  vec3 c = mix(vec3(0.008, 0.009, 0.015), vec3(0.036, 0.040, 0.052), smoothstep(-0.1, 0.75, el));
  c += vec3(0.55, 0.60, 0.72) * panel(az, el, -0.92, 0.15, -0.3, 0.85, max(aa, 0.03)) * 0.45;
  c += vec3(0.95, 0.97, 1.0) * panel(az, el, -0.92, 0.045, -0.25, 0.82, max(aa, 0.02)) * 0.55;
  c += vec3(0.6, 0.66, 0.8) * exp(-pow((wrapPi(az + 0.92)) / 0.30, 2.0)) * smoothstep(-0.4, 0.2, el) * 0.05;
  c += vec3(0.5, 0.55, 0.66) * panel(az, el, 0.64, 0.13, -0.25, 0.9, max(aa, 0.03)) * 0.4;
  c += vec3(0.95, 0.97, 1.0) * panel(az, el, 0.64, 0.035, -0.2, 0.86, max(aa, 0.02)) * 0.5;
  c += vec3(0.6, 0.66, 0.8) * exp(-pow((wrapPi(az - 0.64)) / 0.28, 2.0)) * smoothstep(-0.4, 0.2, el) * 0.045;
  c += mix(vec3(0.8, 0.86, 1.0), uPalMid.rgb, 0.12) * exp(-pow((el - 0.32) / 0.30, 2.0)) * 0.012;
  return c;
}

// One bead's place and size: a ring round the drop, thrown outward on the
// drop's burst.
vec4 bead(int i, float t, float crown) {
  float fi = float(i);
  vec3 h = hash31(fi * 7.31 + 2.1);
  int n = int(clamp(P_BLOBS, 2.0, 5.0));
  float a = fi * TAU / float(n) + h.y * TAU + (h.z - 0.5) * 0.7 + t * 0.20;
  float portrait = 1.0 - step(1.0, uFrame.z);
  float orb = 0.72 + 0.12 * h.z + 0.04 * sin(t * 0.8 + fi);
  float spread = 1.0 + crown * P_SPIKES * (0.75 + 0.35 * h.x) * mix(1.0, 0.45, portrait);
  vec3 c = vec3(cos(a) * orb * spread, (h.y - 0.5) * 0.62 + crown * 0.50 * h.z, sin(a) * orb * 0.55 * spread);
  float rad = (0.130 + 0.060 * h.x) * (1.0 + 0.15 * uBandA.x) * (1.0 + 0.30 * crown);
  return vec4(c, rad);
}

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// The liquid: one big drop, its skin rippling with the bass, the beads joined
// to it with a smooth neck, and the whole mass tearing outward on the drop.
float map(vec3 p, float t, float crown, float squash, float pulse, vec4 B[5]) {
  // A phone frame is narrow: the drop shrinks so it fits the free band.
  float fs = uFrame.z < 1.0 ? 0.36 : 1.0;
  vec3 q = p / fs;
  q.y = q.y / (1.0 + 0.16 * crown * P_SPIKES) * squash;
  vec3 d = normalize(q + vec3(0.0, 0.0001, 0.0));
  float rip = (sin(d.x * 7.0 + t * 1.1) + 0.7 * sin(d.y * 9.5 - t * 0.9) + 0.8 * sin(d.z * 8.0 + t * 1.3))
            * 0.024 * (0.5 + 0.9 * uBandA.x) * P_RIPPLE * (1.0 - 0.6 * crown);
  float R = 0.60 * (1.0 + 0.035 * uBandA.x + 0.02 * pulse) + rip;
  float s = length(q) - R;
  // The drop's answer is a BURST: the beads pull away on their orbits and
  // the drop stretches along the fall, so the mass tears apart and comes back.
  // The beads, joined by a neck: a liquid mass, not a pile of marbles.
  int n = int(clamp(P_BLOBS, 2.0, 5.0));
  for (int i = 0; i < 5; i++) {
    if (i >= n) break;
    vec4 b = B[i];
    vec3 e = q - b.xyz;
    // On the drop they stretch along the fall.
    e.y /= 1.0 + crown * 1.8;
    s = smin(s, length(e) - b.w, 0.24 * (1.0 - 0.4 * crown));
  }
  return s * fs;
}

vec3 normalAt(vec3 p, float t, float crown, float squash, float pulse, float e, vec4 B[5]) {
  return normalize(vec3(
    map(p + vec3(e, 0.0, 0.0), t, crown, squash, pulse, B) - map(p - vec3(e, 0.0, 0.0), t, crown, squash, pulse, B),
    map(p + vec3(0.0, e, 0.0), t, crown, squash, pulse, B) - map(p - vec3(0.0, e, 0.0), t, crown, squash, pulse, B),
    map(p + vec3(0.0, 0.0, e), t, crown, squash, pulse, B) - map(p - vec3(0.0, 0.0, e), t, crown, squash, pulse, B)));
}

void main() {
  vec2 p = fragP();
  float px = uFrame.w;
  float beats = uClock.x * uSpeed;
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float crown = uS0.x;
  // The kick's two envelopes, once per pixel instead of once per march step.
  float squash = 1.0 + envB(uSince.y, 0.45) * 0.16 * (0.6 + 0.4 * uCtl.x);
  float pulse = envB(uSince.y, 0.5);
  // The beads' orbits do not change between march steps: build them once.
  vec4 B[5];
  int nb = int(clamp(P_BLOBS, 2.0, 5.0));
  for (int i = 0; i < 5; i++) B[i] = i < nb ? bead(i, beats, crown) : vec4(0.0, 0.0, 0.0, -1.0);

  // The drop sits at the artwork's centre when there is one, and a little
  // above the frame's centre otherwise.
  vec2 ctr = uHole.z > 0.0 ? vec2(uHole.x, uHoleR.z - 0.26) : vec2(0.0, 0.06);
  // The camera breathes around the drop, so the reflections never stop.
  vec3 ro = vec3(0.24 * sin(bars * 0.30), 0.10 + 0.04 * sin(beats * 0.9), -2.55);
  vec3 rd = normalize(vec3(p - ctr, 1.55));
  rd.xz *= rot(0.28 * sin(bars * 0.30));
  ro.xz *= rot(0.30 * sin(bars * 0.30));

  int steps = int(clamp(P_MARCH * uQual.x * 0.7, 24.0, 72.0));
  float t = 0.35;
  bool hit = false;
  float near = 1e3;
  for (int i = 0; i < 72; i++) {
    if (i >= steps) break;
    vec3 pos = ro + rd * t;
    float d = map(pos, beats, crown, squash, pulse, B);
    near = min(near, d / t);
    if (d < 0.0009 * t) { hit = true; break; }
    t += d * (0.55 - 0.10 * crown);
    if (t > 8.0) break;
  }

  // The studio behind it.
  vec3 col = wall(vec3(rd.x, rd.y + 0.06, rd.z), px * 2.0);
  // Floor line and its dark gloss.
  if (p.y < ctr.y - 0.50) {
    float below = ctr.y - 0.50 - p.y;
    col = mix(vec3(0.008, 0.009, 0.014), vec3(0.004, 0.005, 0.009), smoothstep(0.0, 0.35, below));
    col += mix(uPalMid.rgb, vec3(1.0), 0.5) * exp(-pow((p.x - ctr.x) / 0.75, 2.0)) * exp(-below * 5.0) * 0.05;
    col += mix(vec3(0.8, 0.85, 0.95), uPalMid.rgb, 0.1) * exp(-pow(below / (px * 1.4), 2.0)) * 0.10;
  }
  // The glow the metal throws on the air.
  col += mix(uPalMid.rgb, vec3(1.0), 0.5) * exp(-near * 26.0) * 0.03;
  if (hit) {
    vec3 pos = ro + rd * t;
    float e = max(0.0015, px * 0.8 / max(t, 0.6));
    vec3 n = normalAt(pos, beats, crown, squash, pulse, e, B);
    vec3 r = reflect(rd, n);
    float fres = 0.55 + 0.45 * pow(1.0 - max(dot(n, -rd), 0.0), 5.0);
    float aa = 0.010 + px * 2.6 / max(t, 0.5);
    vec3 env = room(r, aa, bars * 0.30);
    // Neutral chrome with a whisper of the palette, and one hard glint.
    col = env * fres * mix(vec3(1.0), vec3(0.94, 0.97, 1.0), 0.55);
    col += vec3(1.0, 0.98, 0.95) * pow(clamp(dot(r, normalize(vec3(0.18, 0.68, -0.71))), 0.0, 1.0), 700.0) * 12.0;
    // A hot rim at the silhouette, and a dark line just inside it: the two
    // things that make a chrome edge read against a dark room.
    vec3 vd = normalize(ro - pos);
    float rim = pow(1.0 - max(dot(n, vd), 0.0), 4.0);
    col += mix(vec3(0.9, 0.95, 1.0), uPalHigh.rgb, 0.12) * rim * (0.05 + 0.12 * uFlow.x);
    // The kick's flash on the metal, from the engine's own envelope.
    col *= 1.0 + 0.5 * uHit.y * amp;
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.10;
  col *= mix(0.30, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    let burst = 0;
    const drop = onStamp((m) => m.stamp.drop, () => {
      burst = 1;
      flash(0.75);
    });
    return {
      step(dt, m) {
        drop(m);
        // The burst sinks back over four bars; big kicks stand it up again
        // while the drop is still ringing.
        burst = Math.max(0, burst - dt / m.overBeats(16));
        if (m.bigKick && m.dropped > 0.3) burst = Math.max(burst, 0.5);
        state[0] = burst * burst;
      },
    };
  },
};
