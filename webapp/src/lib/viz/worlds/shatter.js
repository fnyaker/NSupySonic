// ÉCLATS — the glass takes the hit.
//
// Hardcore, uptempo, terror, speedcore: music that hits so hard the picture
// should not survive it. So the frame is a pane of glass in front of an LED
// wall, and the kick is what strikes it.
//
// The first version drew the fracture as a uniform Voronoi mosaic and it read
// as exactly that — a filter, cracked mud, stained glass. Glass that has been
// STRUCK does not break into even cells: it breaks into a web around the point
// of impact, long radial cracks running out from it and shorter concentric ones
// joining them, so the pieces are small and crushed at the centre and long and
// thin at the edge. That geometry is what the eye recognises, and it is what
// this draws: radial cracks at jittered, wandering angles, rings at geometric
// radii whose height steps from one crack to the next (so each ring is a chain
// of straight chords, the polygon a real web makes).
//
// Then the optics, which are what make it glass rather than a drawing of it:
// every shard REFRACTS the wall behind it, shifted along its own throw and
// turned about its own centre, and the three colour channels shift by
// different amounts — the dispersion that fringes real broken glass with
// colour. The LED wall behind is a fine grid of points on purpose: nothing
// shows a misalignment like a grid that no longer lines up.
//
// Every main kick throws the pieces; they heal back before the next. Every bar
// the glass is struck somewhere new (on the artwork's centre when there is one,
// anywhere on a wide frame otherwise), so the fracture is never the same twice.
//
// Parameters:
//   shards  how many cracks (gabber: few long slabs; speedcore: a crushed web)
//   jag     how far the pieces are thrown and how wide the gaps open
//   spin    how far a piece turns        flash  downbeat strobe strength
//   burst   the light behind the glass   leds   LED grid density

import { onStamp, hashN } from "./kit.js";

export default {
  id: "shatter",
  uses: ["noise"],
  params: { shards: 1, jag: 1, spin: 1, flash: 0.5, burst: 1, leds: 1 },
  look: { exposure: 1.0, bloom: 0.9, threshold: 1.1, saturation: 1.15 },

  fragment: `
// The LED wall behind the glass: a grid of points running a slow pattern, a
// soft blaze of colour, and rays out of the impact that flare on the blow.
// Where the glass was struck: the artwork's centre in the player, the
// driver's pick across the width otherwise.
vec2 impact() {
  return uHole.z > 0.0 ? uHole.xy : vec2(uS0.x * uFrame.z * 0.6, uS0.y);
}

vec3 wall(vec2 q, float beats, float blow) {
  vec2 O = impact();
  float pitch = 0.034 / clamp(P_LEDS, 0.5, 2.0);
  vec2 g = q / pitch;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  vec2 c = id * pitch;
  // The pattern: a wave out of the impact, a sweep across, a noise shimmer.
  float wave = 0.5 + 0.5 * sin(length(c - O) * 9.0 - beats * TAU * 0.5);
  float sweep = 0.5 + 0.5 * sin(c.x * 2.3 + c.y * 1.1 + uClock.y * TAU * 0.25);
  float shimmer = hash12(id + floor(beats * 4.0));
  float lvl = 0.25 + 0.75 * mix(wave, sweep, 0.5) * (0.7 + 0.3 * shimmer);
  float dot2 = exp(-dot(f, f) * 22.0);
  vec3 led = pal(fract(0.5 + 0.35 * (c.x / uFrame.z) + 0.15 * sin(beats * 0.25)));
  vec3 col = led * dot2 * lvl * (0.3 + 0.7 * uFlow.x) * 0.5;
  // A soft blaze of colour behind the grid.
  vec2 w = q + vec2(fbm(q * 0.9 + beats * 0.03, 3), fbm(q * 0.9 - beats * 0.03 + 5.0, 3)) * 0.5;
  col += mix(uPalLow.rgb, uPalMid.rgb, 0.5 + 0.5 * sin(w.x * 1.7)) * 0.07 * (0.6 + 0.4 * sin(w.y * 2.1 + 1.0));
  // Rays out of the point of impact.
  vec2 d = q - O;
  float r = length(d);
  float a = atan(d.y, d.x);
  float rays = pow(clamp(fbm(vec2(a * 3.5, r * 0.8 - beats * 0.6), 3) + 0.55, 0.0, 1.0), 5.0);
  col += mix(uPalHigh.rgb, vec3(1.0), 0.3) * rays * glow(r, 0.45) * (0.1 + 0.9 * blow) * P_BURST;
  return col;
}

// The fracture web around O. Returns (distance to the nearest crack, the
// shard's mid-angle, its mid-radius, a per-shard hash).
float bound(float k, float r, float seed, float N) {
  // Nearly straight, with the small kinks a real crack has — not a wave.
  float kink = floor(r * 7.0 + hash11(k + seed));
  return k + 0.38 * (hash11(mod(k, N) * 7.31 + seed) - 0.5) + 0.045 * (hash11(kink * 3.1 + k * 1.7 + seed) - 0.5);
}
float ringR(float j, float k, float seed, float N, float r0, float g) {
  return r0 * pow(g, j + 0.6 * (hash12(vec2(mod(k, N), j) + seed) - 0.5));
}
vec4 web(vec2 p, vec2 O, float seed, float N, out vec2 shardCentre) {
  vec2 d = p - O;
  float r = max(length(d), 1e-4);
  float a = atan(d.y, d.x);
  float u = (a + PI) / TAU * N;
  float k = floor(u);
  if (u < bound(k, r, seed, N)) k -= 1.0;
  else if (u >= bound(k + 1.0, r, seed, N)) k += 1.0;
  float lo = bound(k, r, seed, N);
  float hi = bound(k + 1.0, r, seed, N);
  float dRad = min(u - lo, hi - u) * TAU / N * r;
  // The ring this point sits between, stepping chord by chord across the
  // sector: its radius at each crack, interpolated between them.
  float t = clamp((u - lo) / max(hi - lo, 1e-3), 0.0, 1.0);
  float r0 = 0.045;
  float g = 1.55;
  float j = floor(log(r / r0) / log(g));
  float Rj = mix(ringR(j, k, seed, N, r0, g), ringR(j, k + 1.0, seed, N, r0, g), t);
  if (r < Rj) {
    j -= 1.0;
    Rj = mix(ringR(j, k, seed, N, r0, g), ringR(j, k + 1.0, seed, N, r0, g), t);
  }
  float Rj1 = mix(ringR(j + 1.0, k, seed, N, r0, g), ringR(j + 1.0, k + 1.0, seed, N, r0, g), t);
  if (r >= Rj1) {
    j += 1.0;
    Rj = Rj1;
    Rj1 = mix(ringR(j + 1.0, k, seed, N, r0, g), ringR(j + 1.0, k + 1.0, seed, N, r0, g), t);
  }
  // Not every ring segment cracked: a web has gaps in its rings.
  float ringOn = step(0.45, hash12(vec2(k, j) + seed * 3.0));
  float dRing = min(abs(r - Rj), abs(Rj1 - r) + (1.0 - ringOn) * 10.0);
  float midA = ((k + 0.5) / N) * TAU - PI;
  float midR = sqrt(max(Rj, r0 * 0.5) * Rj1);
  shardCentre = O + vec2(cos(midA), sin(midA)) * midR;
  return vec4(min(dRad, dRing), midA, midR, hash12(vec2(k, j) + seed));
}

void main() {
  vec2 p = fragP();
  float beats = uClock.x * uSpeed;
  float amp = 0.55 + 0.45 * uCtl.x;
  float blow = envB(uSince.y, 0.42) * (0.55 + 0.6 * uLookA.z);
  float hit = clamp(blow, 0.0, 1.4) * amp * (1.0 - 0.6 * uArc.z);
  float N = floor(mix(7.0, 24.0, clamp(P_SHARDS * (0.3 + 0.5 * uLookB.z), 0.0, 1.0)) + 0.5);
  float seed = uS0.z;
  vec2 O = impact();
  vec2 sc;
  vec4 w = web(p, O, seed, N, sc);
  float rnd = w.w;
  vec2 dir = vec2(cos(w.y), sin(w.y));
  // Outer shards fly further than the crushed ones at the centre.
  float throwBy = hit * (0.012 + 0.05 * rnd + 0.035 * min(w.z, 1.2)) * P_JAG;
  float turn = (rnd - 0.5) * hit * 0.3 * P_SPIN;
  vec2 q = rot(turn) * (p - sc) + sc - dir * throwBy;
  vec2 disp = dir * (0.004 + throwBy * 0.25);
  vec3 col;
  col.r = wall(q + disp, beats, hit).r;
  col.g = wall(q, beats, hit).g;
  col.b = wall(q - disp, beats, hit).b;
  // Each pane catches the light at its own tilt.
  float tilt = dot(rot(rnd * 6.28) * vec2(1.0, 0.0), normalize(p - sc + 1e-4));
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * pow(max(tilt, 0.0), 8.0) * 0.08 * (0.3 + hit);
  // Gaps where the pieces have pulled apart, and the cracks themselves.
  float px = uFrame.w * 1.3;
  float gap = 0.0006 + 0.012 * hit * P_JAG * (0.4 + 0.6 * min(w.z, 1.0));
  float e = w.x;
  col *= smoothstep(gap, gap + px, e);
  // A crack is a hairline: its width is counted in PIXELS, so it stays one
  // bright line at any resolution instead of a glowing rope.
  float crack = exp(-max(e - gap, 0.0) / (uFrame.w * 0.9));
  vec3 hot = mix(uPalHigh.rgb, vec3(1.0), 0.65);
  col += hot * crack * (0.05 + 0.6 * hit) * (0.45 + 0.55 * uFlow.x);
  // The crushed point of impact.
  float crush = glow(length(p - O), 0.035) * (0.2 + 1.2 * hit);
  col += hot * crush * 0.5;
  col += mix(uPalHigh.rgb, vec3(0.9), P_FLASH) * uHit2.w * 0.35;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.6));
}
`,

  create({ state, flash, params }) {
    // Where the glass is struck, re-chosen every bar: the artwork's centre in
    // the player, anywhere across a wide frame otherwise.
    let bars = 0;
    const strike = () => {
      bars++;
      state[0] = (hashN(bars * 3 + 1) - 0.5) * 1.6;
      state[1] = (hashN(bars * 3 + 2) - 0.5) * 0.8;
      state[2] = hashN(bars * 3 + 3) * 97;
    };
    strike();
    const bar = onStamp((m) => m.stamp.bar, (s, m) => {
      strike();
      if (m.drive > 0.5 && m.breakdown < 0.3) flash(0.35 + 0.65 * (params.flash ?? 0.5));
    });
    const drop = onStamp((m) => m.stamp.drop, () => {
      strike();
      flash(1);
    });
    return {
      step(dt, m) {
        bar(m);
        drop(m);
      },
    };
  },
};
