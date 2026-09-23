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
// Then the optics, which are what make it GLASS rather than a drawing of it.
// The pane is dark tinted glass in front of a stage: a white-hot light at the
// point of impact and a few coloured beams sweeping behind. Every shard
// REFRACTS that stage, shifted along its own throw and turned about its own
// centre (the three colour channels by slightly different amounts — the
// dispersion that fringes real broken glass), and every shard REFLECTS a
// travelling light at its own tilt, so the break reads as a mosaic of facets,
// some catching the light and some black. The cracks are bevels a pixel or two
// wide, lit on one side; and when a main kick throws the pieces apart the
// gaps open onto the raw light behind, which is what makes the hit land.
//
// Every main kick throws the pieces; they heal back before the next. Every bar
// the glass is struck somewhere new (on the artwork's centre when there is one,
// anywhere on a wide frame otherwise), so the fracture is never the same twice.
//
// Parameters:
//   shards  how many cracks (gabber: few long slabs; speedcore: a crushed web)
//   jag     how far the pieces are thrown and how wide the gaps open
//   spin    how far a piece turns        flash  downbeat strobe strength
//   burst   the light behind the glass   leds   how many beams sweep behind it

import { onStamp, hashN } from "./kit.js";

export default {
  id: "shatter",
  uses: ["noise"],
  params: { shards: 1, jag: 1, spin: 1, flash: 0.5, burst: 1, leds: 1 },
  look: { exposure: 1.0, bloom: 1.25, threshold: 0.75, saturation: 1.15 },

  fragment: `
// Where the glass was struck: the artwork's centre in the player, the
// driver's pick across the width otherwise.
vec2 impact() {
  return uHole.z > 0.0 ? uHole.xy : vec2(uS0.x * uFrame.z * 0.6, uS0.y);
}

// The stage behind the glass: dark, a white-hot light at the point of impact,
// and beams fanning up from below the frame, sweeping on the bar.
vec3 behind(vec2 q, float beats, float blow) {
  vec2 O = impact();
  float r = length(q - O);
  vec3 col = uPalBg.rgb * 0.06 + uPalLow.rgb * 0.015;
  col += mix(uPalHigh.rgb, vec3(1.0), 0.6) * glow(r, 0.04) * (0.4 + 2.2 * blow) * P_BURST;
  col += mix(uPalMid.rgb, uPalHigh.rgb, 0.5) * glow(r, 0.3) * (0.03 + 0.12 * blow) * P_BURST;
  float nB = floor(clamp(1.0 + 4.0 * P_LEDS, 0.0, 6.0) + 0.5);
  for (int i = 0; i < 6; i++) {
    if (float(i) >= nB) break;
    float fi = float(i);
    vec2 src = vec2((nB > 1.0 ? fi / (nB - 1.0) * 2.0 - 1.0 : 0.0) * uFrame.z * 0.85, -1.25);
    float ang = 1.5708 + 0.55 * sin(uClock.y * PI * 0.5 + fi * 1.9);
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 v = q - src;
    float along = dot(v, dir);
    float across = abs(v.x * dir.y - v.y * dir.x);
    float beam = exp(-pow(across / (0.015 + along * 0.07), 2.0)) * step(0.0, along) * exp(-along * 0.35);
    col += pal(fract(fi * 0.27 + 0.1)) * beam * (0.1 + 0.25 * uFlow.x + 0.3 * blow);
  }
  // A haze the light hangs in.
  col += mix(uPalLow.rgb, uPalMid.rgb, 0.5) * (fbm(q * 1.3 + vec2(beats * 0.04, 0.0), 3) * 0.5 + 0.5) * 0.035 * (1.0 + 2.0 * blow);
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
  vec2 disp = dir * (0.002 + throwBy * 0.2);
  // Refraction: the stage behind, through this shard, channel by channel.
  vec3 through;
  through.r = behind(q + disp, beats, hit).r;
  through.g = behind(q, beats, hit).g;
  through.b = behind(q - disp, beats, hit).b;
  // The glass is tinted and absorbs; what it lets through is dimmer than what
  // comes through a gap.
  vec3 col = through * 0.4;
  // Reflection: each shard sits at its own tilt, so a travelling light glints
  // off some and leaves others black — the facets are what read as glass.
  float r2 = hash11(rnd * 91.7 + 3.1);
  vec3 n = normalize(vec3((rnd - 0.5) * 0.7, (r2 - 0.5) * 0.7, 1.0) + vec3(dir * hit * 0.25 * P_SPIN, 0.0));
  float la = uClock.y * PI * 0.25;
  vec3 L = normalize(vec3(cos(la) * 0.6, 0.45 + 0.2 * sin(la * 1.3), 1.0));
  vec3 R = reflect(vec3(0.0, 0.0, -1.0), n);
  float spec = pow(max(dot(R, L), 0.0), 34.0);
  // Across the shard the reflection is a band, not a flat fill: a softbox.
  float band = smoothstep(-0.25, 0.25, dot(p - sc, normalize(n.xy + 1e-4)) + (r2 - 0.5) * 0.2);
  // The reflection carries the room's colour, running from the palette's mid
  // tone into a white core where the light sits squarely on the facet.
  vec3 sheen = mix(mix(uPalMid.rgb, uPalHigh.rgb, band), vec3(1.0), 0.25 + 0.5 * spec * band);
  col += sheen * spec * (0.03 + 0.4 * band * band) * (0.6 + 0.8 * hit + 0.3 * uFlow.x);
  // The cracks: a bevel a pixel or two wide, lit on the side facing the light;
  // the gap opened by the throw shows the raw light behind the glass.
  float px = uFrame.w * 1.3;
  float gap = 0.0006 + 0.014 * hit * P_JAG * (0.4 + 0.6 * min(w.z, 1.0));
  float e = w.x;
  float open = 1.0 - smoothstep(gap, gap + px, e);
  col = mix(col, behind(p, beats, hit) * (0.9 + 0.8 * hit), open);
  float lit = 0.35 + 0.65 * max(dot(n.xy, L.xy) * 1.5, 0.0);
  float bevel = exp(-max(e - gap, 0.0) / (uFrame.w * 1.1)) * (1.0 - open);
  vec3 hot = mix(uPalHigh.rgb, vec3(1.0), 0.6);
  col += hot * bevel * lit * (0.18 + 0.7 * hit) * (0.5 + 0.5 * uFlow.x);
  // The crushed point of impact: powder, catching everything.
  vec2 dO = p - O;
  float crush = glow(length(dO), 0.03) * (0.25 + 1.3 * hit);
  col += hot * crush * 0.45;
  col += mix(uPalHigh.rgb, vec3(0.9), P_FLASH) * uHit2.w * 0.15;
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
