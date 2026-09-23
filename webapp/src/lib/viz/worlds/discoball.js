// BOULE À FACETTES — the mirror ball, and the room it throws itself around.
//
// Disco, nu-disco, funk, French touch: the one object the whole genre is
// named after. A mirror ball turning under two spotlights, and the room
// around it covered in the moving spots of light it throws.
//
//   THE BALL is a sphere of square mirror tiles: every tile is a flat facet
//   with its own normal, so each one either catches a spotlight or does not,
//   and as the ball turns the catches run across it as sparkles — which is
//   what a mirror ball actually looks like, and what a shaded sphere never
//   does. Dark grout between the tiles, a highlight that jumps tile to tile.
//   THE SPOTS. Every facet throws a spot on the room. They are laid out on
//   the ball's own longitude and latitude and projected onto the wall, so as
//   the ball turns they sweep sideways and speed up toward the edges of the
//   frame, stretching as they go — the motion of a real room, not of a
//   pattern sliding across the screen.
//   THE BEAMS. Two spotlights from the corners of the room cut through the
//   haze onto the ball.
//   THE MUSIC. The ball turns once every four bars; the kick flashes the
//   spots; the hats glint on the tiles; a chord change swaps a spotlight's
//   gel; the drop hits the ball with a third, white light.
//
// Parameters:
//   spots   spot density     turn   rotation speed (x)
//   beams   spotlight haze

import { onStamp } from "./kit.js";

export default {
  id: "discoball",
  uses: ["sdf"],
  params: { spots: 1, turn: 1, beams: 1 },
  look: { exposure: 1.0, bloom: 1.35, threshold: 0.65, saturation: 1.15 },

  fragment: `
vec2 ballAt() {
  if (uHole.z > 0.0) return vec2(uHole.x, min(uHole.y + uHole.w + 0.34, 0.7));
  return vec2(0.0, 0.32);
}
float ballR() { return 0.3; }

// What a mirror tile sees in direction r: the spotlights, the drop's white
// light, and the dark room.
vec3 env(vec3 r, vec3 gel1, vec3 gel2, float white) {
  vec3 L1 = normalize(vec3(-0.8, -0.5, 0.35));
  vec3 L2 = normalize(vec3(0.8, -0.5, 0.35));
  vec3 L3 = normalize(vec3(0.0, -0.2, 1.0));
  vec3 c = uPalBg.rgb * 0.4;
  c += gel1 * pow(max(dot(r, L1), 0.0), 60.0) * 6.0;
  c += gel2 * pow(max(dot(r, L2), 0.0), 60.0) * 6.0;
  c += vec3(1.0) * pow(max(dot(r, L3), 0.0), 40.0) * 6.0 * white;
  return c;
}

void main() {
  vec2 p = fragP();
  float amp = 0.6 + 0.4 * uCtl.x;
  float spin = uS0.x;
  vec2 B = ballAt();
  float R = ballR();
  vec3 gel1 = mix(uPalHigh.rgb, uPalAcc.rgb, uS0.y);
  vec3 gel2 = mix(uPalMid.rgb, uPalHigh.rgb, 1.0 - uS0.y);
  float white = envB(uSince.w, 3.0) * step(uSince.w, 12.0);
  vec3 col = uPalBg.rgb * 0.35;

  // --- the beams, through the haze onto the ball ---
  vec2 c1 = vec2(-uFrame.z - 0.1, -1.1);
  vec2 c2 = vec2(uFrame.z + 0.1, -1.1);
  float b1 = sdSeg2(p, c1, B);
  float b2 = sdSeg2(p, c2, B);
  float t1 = clamp(dot(p - c1, B - c1) / dot(B - c1, B - c1), 0.0, 1.0);
  float t2 = clamp(dot(p - c2, B - c2) / dot(B - c2, B - c2), 0.0, 1.0);
  col += gel1 * exp(-pow(b1 / (0.02 + 0.08 * (1.0 - t1)), 2.0)) * 0.06 * P_BEAMS;
  col += gel2 * exp(-pow(b2 / (0.02 + 0.08 * (1.0 - t2)), 2.0)) * 0.06 * P_BEAMS;

  // --- the spots on the room ---
  const float D = 1.1;
  vec2 v = p - B;
  float lon = atan(v.x, D);
  float lat = atan(v.y * cos(lon), D);
  float nLon = 26.0 * P_SPOTS;
  float nLat = 13.0 * P_SPOTS;
  vec2 g = vec2((lon + spin) / TAU * nLon * 4.0, lat / PI * nLat * 2.0);
  vec2 cell = floor(g);
  vec2 jit = hash22(cell) * 0.5 + 0.25;
  vec2 dd = (fract(g) - jit) * vec2(1.0, 1.0);
  // Spots stretch toward the edges, the way light lands on an angled wall.
  float stretch = 1.0 / max(cos(lon), 0.2);
  float spot = exp(-dot(dd * vec2(1.0 / stretch, 1.0), dd * vec2(1.0 / stretch, 1.0)) / 0.012);
  float lit = step(0.55, hash12(cell + 7.1)) * (0.4 + 0.6 * hash12(cell + 1.9));
  vec3 sc = mix(vec3(1.0), hash12(cell + 3.3) > 0.5 ? gel1 : gel2, 0.55);
  float spotK = (0.2 + 0.3 * uFlow.x + 0.9 * uHit.y * amp + 0.6 * white) * lit;
  col += sc * spot * spotK * (1.0 - 0.6 * uArc.z) * smoothstep(R * 1.05, R * 1.6, length(v));

  // Haze in the room, lit by everything the ball throws.
  col += mix(gel1, gel2, 0.5) * exp(-length(v) * 1.4) * (0.05 + 0.05 * uFlow.x + 0.08 * white);
  // --- the ball ---
  float rr = length(v) / R;
  if (rr < 1.0) {
    vec3 n = vec3(v / R, sqrt(max(1.0 - rr * rr, 0.0)));
    // Into the ball's own frame, turned by the spin.
    vec3 nb = n;
    nb.xz = rot(spin) * nb.xz;
    float blon = atan(nb.x, nb.z);
    float blat = asin(clamp(nb.y, -1.0, 1.0));
    float tiles = 30.0;
    float dLat = PI / tiles;
    float iLat = floor(blat / dLat);
    float rowLat = (iLat + 0.5) * dLat;
    float perRow = max(4.0, floor(tiles * 2.0 * cos(rowLat)));
    float dLon = TAU / perRow;
    float iLon = floor(blon / dLon);
    // The tile's own flat normal.
    float tLon = (iLon + 0.5) * dLon;
    vec3 tn = vec3(cos(rowLat) * sin(tLon), sin(rowLat), cos(rowLat) * cos(tLon));
    tn.xz = rot(-spin) * tn.xz;
    vec3 rf = reflect(vec3(0.0, 0.0, -1.0), tn);
    vec3 m = env(rf, gel1, gel2, white);
    // The rest of the room in the mirror: every other light in it, fixed in
    // the WORLD, so tiles flash as they turn through them.
    vec2 wIdx = floor(vec2((blon - spin) / dLon, blat / dLat));
    float roomLight = pow(hash12(wIdx + 17.0), 10.0) * 3.0 + 0.08 * (0.5 + 0.5 * rf.y);
    m += mix(vec3(1.0), hash12(wIdx) > 0.5 ? gel1 : gel2, 0.4) * roomLight * (0.6 + 0.4 * uFlow.x);
    // Grout: dark lines between the tiles.
    float fu = fract(blon / dLon);
    float fv = fract(blat / dLat);
    float grout = smoothstep(0.0, 0.12, min(fu, 1.0 - fu)) * smoothstep(0.0, 0.12, min(fv, 1.0 - fv));
    // Tiles glint on the hats, a random few.
    float glint = step(0.93, hash12(vec2(iLon, iLat) + floor(uClock.x * 4.0))) * uHit2.x * amp;
    vec3 tile = m * (0.7 + 0.3 * hash12(vec2(iLon, iLat))) + vec3(1.0) * glint * 1.5;
    vec3 ballC = tile * grout + vec3(0.01) * (1.0 - grout);
    // The limb darkens; anti-aliased edge.
    ballC *= 0.5 + 0.5 * n.z;
    col = mix(col, ballC, smoothstep(1.0, 1.0 - uFrame.w / R * 1.5, rr));
  }
  // The chain it hangs from.
  float chain = step(abs(p.x - B.x), uFrame.w * 1.2) * step(B.y + R, p.y);
  col += vec3(0.08) * chain;
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, params, flash }) {
    let spin = 0;
    let gel = 0;
    let gelShown = 0;
    const chord = onStamp((m) => m.stamp.chord, () => {
      gel = gel > 0.5 ? 0 : 1;
    });
    const drop = onStamp((m) => m.stamp.drop, () => flash(0.7));
    return {
      step(dt, m) {
        chord(m);
        drop(m);
        // Once every four bars, a little faster when the floor is full.
        spin += (dt / m.bar) * ((Math.PI * 2) / 4) * (params.turn || 1) * (0.8 + 0.4 * m.drive);
        gelShown = m.ease(gelShown, gel, 1, dt);
        state[0] = spin;
        state[1] = gelShown;
      },
    };
  },
};
