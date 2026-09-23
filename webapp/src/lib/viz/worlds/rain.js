// PLUIE — rain on the window, the city out of focus behind it.
//
// Lo-fi, chillhop, bedroom pop, jazz for a rainy afternoon: the picture is
// the window. A pane of glass covered in drops, the lights of the city behind
// it melted into soft discs — and every drop a tiny lens holding its own
// upside-down image of those lights, which is the detail that makes rain on
// glass look like rain on glass.
//
//   THE CITY is out of focus by construction: its lights are drawn as the
//   discs a lens makes of them, never as points, in two layers at two
//   distances, warm and cool, drifting very slowly.
//   THE DROPS are lenses. Each one refracts the city behind it, inverted
//   and shrunk, the way a real drop does; a highlight sits at its top where
//   the room's light catches it and a dark rim at its bottom edge.
//   THE RUNNERS. Now and then a heavy drop gives way and runs down the pane,
//   wobbling, leaving a trail of beads behind it.
//   THE MUSIC. The hats land new drops on the glass; the kick shivers the
//   pane; a breakdown slows the runners; the drop is a gust that sends them
//   all down at once.
//
// Parameters:
//   drops    drop density     runners  running drops (x)
//   city     background lights

import { onStamp } from "./kit.js";

export default {
  id: "rain",
  uses: ["noise"],
  params: { drops: 1, runners: 1, city: 1 },
  look: { exposure: 1.0, bloom: 1.25, threshold: 0.7, saturation: 1.15 },

  fragment: `
// The city behind the glass, out of focus.
vec3 city(vec2 p) {
  vec3 c = mix(uPalLow.rgb * 0.05 + uPalBg.rgb * 0.3, uPalBg.rgb * 0.2, smoothstep(-1.0, 1.0, p.y));
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    float cs = 0.45 - 0.17 * fl;
    vec2 q = p + vec2(uClock.z * 0.02 * (1.0 + fl), 0.0);
    vec2 cell = floor(q / cs);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 id = cell + vec2(float(i), float(j));
        vec3 h = hash32(id + fl * 17.0);
        if (h.z > 0.38) continue;
        vec2 at = (id + 0.2 + 0.6 * h.xy) * cs;
        float R = cs * (0.3 + 0.25 * h.y);
        float d = length(q - at) / R;
        float disc = smoothstep(1.0, 0.7, d) * (0.6 + 0.4 * smoothstep(0.4, 0.9, d));
        vec3 lc = h.x > 0.5 ? mix(vec3(1.0, 0.7, 0.35), uPalHigh.rgb, 0.3) : mix(uPalMid.rgb, uPalAcc.rgb, h.y);
        // Each light breathes with its own slice of the spectrum: the city is
        // listening too, and a signal changing at the tempo is what the eye
        // reads as music through a blurred window.
        float lvl = texture(uSpec, vec2(0.08 + 0.8 * fract(h.y * 3.7 + h.x), 0.25)).r;
        c += lc * disc * (0.08 + 0.1 * h.z) * (0.45 + 1.1 * lvl) * P_CITY * (1.0 - 0.3 * fl) * smoothstep(1.0, 0.2, p.y);
      }
    }
  }
  return c;
}

void main() {
  vec2 p = fragP();
  float amp = 0.6 + 0.4 * uCtl.x;
  float px = uFrame.w;
  // The kick shivers the pane.
  // One thump, not a buzz: an oscillation fast enough to read as a shiver is
  // faster than any frame rate can show, and aliased into jitter.
  vec2 shiver = vec2(0.0006, -0.0025) * envB(uSince.y, 0.25) * amp;
  vec2 q = p + shiver;
  // Seen through the pane, the city is a little fogged; the drops (which
  // are clear) show it sharper and brighter than the glass around them.
  vec3 col = city(p) * 0.75 + mix(uPalLow.rgb, uPalMid.rgb, 0.4) * 0.012;

  // --- the drops sitting on the glass ---
  float cs = 0.13;
  vec2 g = q / cs;
  vec2 cell = floor(g);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 id = cell + vec2(float(i), float(j));
      vec3 h = hash32(id);
      // Drops come and go: each cell's drop lands on its own beat, stays a
      // while, and is renewed — the hats landing more of them.
      // Each drop lives a few bars and is renewed; it LANDS — a quick swell
      // from a bead to its full size — rather than blinking in, so a busy
      // track is a pane filling up, not a flicker.
      float life = 6.0 + 10.0 * h.z;
      float cyc = (uClock.x + h.x * life) / life;
      float born = floor(cyc);
      float ageB = fract(cyc) * life;
      vec3 h2 = hash32(id + born * 7.3);
      if (h2.z > 0.36 * P_DROPS) continue;
      vec2 at = (id + 0.5 + (h2.xy - 0.5) * 0.95) * cs;
      float R = cs * (0.18 + 0.3 * h2.x) * (0.55 + 0.45 * smoothstep(0.0, 0.35, ageB));
      vec2 d = (q - at) / R;
      float r = length(d);
      if (r > 1.0) continue;
      float edge = smoothstep(1.0, 1.0 - px / R * 2.0, r);
      // A lens: a wide slice of the city behind, inverted and shrunk into it —
      // a drop sees far more of the scene than its own footprint.
      vec3 inside = city(at - d * 0.45) * 1.7;
      // Its edge bends the light away: a dark ring that separates it from
      // the glass around it.
      inside *= mix(1.0, 0.35, smoothstep(0.72, 1.0, r));
      // Its highlight, its dark lower rim.
      inside += vec3(1.0) * smoothstep(0.3, 0.0, length(d - vec2(-0.3, 0.45))) * 0.3;
      inside *= 1.0 - 0.7 * smoothstep(0.5, 1.0, r) * smoothstep(-0.1, -0.8, d.y);
      // The meniscus: a thin bright line round the drop.
      inside += mix(uPalHigh.rgb, vec3(1.0), 0.5) * smoothstep(0.8, 0.97, r) * 0.06;
      col = mix(col, inside, edge);
    }
  }

  // --- the runners ---
  float colW = 0.12;
  float ci = floor(q.x / colW);
  vec3 hc = hash32(vec2(ci, 3.0));
  if (hc.z < 0.6 * P_RUNNERS) {
    // A runner crosses the pane in a couple of bars: slow enough to follow,
    // fast enough to be seen going. It used to take thirty to sixty beats.
    float speed = (0.3 + 0.5 * hc.x) * (1.0 - 0.6 * uArc.z) + uS0.x;
    float cyc = uClock.x * speed / 2.6 + hc.y * 7.0;
    float y = 1.2 - fract(cyc) * 2.6;
    float x = (ci + 0.5) * colW + sin(y * 9.0 + hc.x * 6.0) * 0.012 + (hc.y - 0.5) * 0.05;
    vec2 d = (q - vec2(x, y)) / vec2(0.019, 0.027);
    float r = length(d);
    if (r < 1.0) {
      vec3 inside = city(vec2(x, y) - d * 0.06) * 1.5 + vec3(1.0) * smoothstep(0.4, 0.0, length(d - vec2(-0.3, 0.4))) * 0.3;
      col = mix(col, inside, smoothstep(1.0, 0.85, r));
    }
    // The trail: beads left behind it, and a clearer streak of glass.
    if (q.y > y && q.y < y + 0.6) {
      float trailX = abs(q.x - (x + sin(q.y * 9.0 + hc.x * 6.0) * 0.012 - sin(y * 9.0 + hc.x * 6.0) * 0.012));
      float streak = smoothstep(0.011, 0.0, trailX) * exp(-(q.y - y) * 2.5);
      col += city(q - vec2(0.0, 0.03)) * streak * 0.7 + mix(uPalHigh.rgb, vec3(1.0), 0.5) * streak * 0.01;
      float bead = step(0.7, hash12(vec2(ci, floor(q.y * 40.0)))) * smoothstep(0.006, 0.002, length(vec2(trailX, fract(q.y * 40.0) / 40.0 - 0.0125)));
      col += vec3(0.8) * bead * 0.3 * exp(-(q.y - y) * 2.0);
    }
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.15;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    let gust = 0;
    const drop = onStamp((m) => m.stamp.drop, () => {
      gust = 1;
      flash(0.3);
    });
    return {
      step(dt, m) {
        drop(m);
        gust = Math.max(0, gust - dt / m.overBeats(8));
        state[0] = gust * 0.8;
      },
    };
  },
};
