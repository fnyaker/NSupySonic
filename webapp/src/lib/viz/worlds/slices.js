// DÉCOUPE — the frame cut into bands that jump on the breaks.
//
// Drum & bass, breakbeat, UK garage: music built by cutting a loop into
// slices and re-ordering them. The picture is cut the same way — the frame is
// sliced into diagonal bands, each filled with its own graphic material, and
// the breaks re-arrange them:
//
//   THE BANDS run at an angle across the frame, each one a different piece of
//   a motion-design vocabulary: fine stripes, a dot screen, a gradient, a
//   solid block, a scrolling grid, a halftone wave, and bands of negative
//   space with a single line of light in them. Each scrolls along its own
//   length at its own speed.
//   THE BREAK. Every snare jumps each band along by a step — cleanly, over a
//   sixteenth, with an overshoot, the way an editor would cut it — and
//   alternate bands jump in opposite directions, so the frame shears.
//   THE KICK re-cuts the widths: the cut lines slide to new positions on
//   every main kick, so the layout itself breathes with the beat.
//   THE ARRANGEMENT. A roll subdivides the jumps; a breakdown slows the
//   scroll to a drift; a drop swaps every band's material at once.
//
// Everything is drawn with analytic anti-aliasing at the pixel scale — stripes
// and dots included — so the bands stay crisp at 4K and do not shimmer.
//
// Parameters:
//   angle   band angle (degrees)   bands  how many across the frame
//   jump    how far a snare throws a band   axis  1 = vertical columns

import { onStamp } from "./kit.js";

export default {
  id: "slices",
  uses: ["noise"],
  params: { angle: 18, bands: 9, jump: 1, axis: 0 },
  look: { exposure: 1.0, bloom: 1.0, threshold: 0.85, saturation: 1.2 },

  fragment: `
// Stripes of period \`per\` and duty \`duty\`, anti-aliased over a pixel.
float stripes(float x, float per, float duty, float px) {
  float f = fract(x / per);
  float w = px / per;
  return smoothstep(duty + w, duty - w, f) * smoothstep(-w, w, f);
}

// A band's material, at band coordinates (u along, v across 0..1).
vec3 material(float kind, vec2 uv, float bandW, float px, float seed, vec3 cA, vec3 cB) {
  float u = uv.x;
  float v = uv.y;
  if (kind < 1.0) {
    // Fine stripes across the band.
    return mix(cA * 0.06, cA, stripes(u, 0.07, 0.3, px));
  } else if (kind < 2.0) {
    // A dot screen.
    vec2 g = vec2(u, v * bandW) / 0.09;
    float r = length(fract(g) - 0.5) * 0.09;
    return mix(cB * 0.04, cB, smoothstep(0.022 + px, 0.022 - px, r));
  } else if (kind < 3.0) {
    // A gradient along the band.
    return mix(cA, cB, fract(u * 0.35)) * (0.35 + 0.65 * fract(u * 0.35));
  } else if (kind < 4.0) {
    // A solid block, edged.
    float e = min(v, 1.0 - v) * bandW;
    return cB * (0.55 + 0.45 * smoothstep(px * 2.0, px * 4.0, e));
  } else if (kind < 5.0) {
    // A scrolling grid.
    float gx = stripes(u, 0.14, 0.06, px);
    float gy = stripes(v * bandW, 0.14, 0.06, px);
    return cA * 0.04 + cA * max(gx, gy) * 0.8;
  } else if (kind < 6.0) {
    // A halftone wave: dots sized by a sine along the band.
    vec2 g = vec2(u, v * bandW) / 0.06;
    float sz = (0.5 + 0.5 * sin(u * 4.0 + seed * 3.0)) * 0.027;
    float r = length(fract(g) - 0.5) * 0.06;
    return mix(cA * 0.03, mix(cA, cB, 0.5), smoothstep(sz + px, sz - px, r));
  }
  // Negative space: a dark band with one line of light down its middle.
  float mid = abs(v - 0.5) * bandW;
  return cB * 0.02 + cB * exp(-pow(mid / (px * 1.2), 2.0)) * 0.9;
}

void main() {
  vec2 p = fragP();
  float amp = 0.6 + 0.4 * uCtl.x;
  float px = uFrame.w;
  // Band space: rotate so the bands run along x.
  float ang = radians(P_AXIS > 0.5 ? 90.0 - P_ANGLE * 0.3 : P_ANGLE);
  vec2 q = rot(-ang) * p;
  float span = length(frameHalf()) * 2.0;
  float nB = max(3.0, floor(P_BANDS + 0.5));
  // The cut lines: evenly spaced, each nudged by the last main kick's re-cut.
  float y01 = (q.y / span) + 0.5;
  float fb = y01 * nB;
  float bi = floor(fb);
  float cutJ = uS0.z;
  float lo = bi + (hash11(bi + cutJ) - 0.5) * 0.35;
  float hi = bi + 1.0 + (hash11(bi + 1.0 + cutJ) - 0.5) * 0.35;
  if (fb < lo) { bi -= 1.0; hi = lo; lo = bi + (hash11(bi + cutJ) - 0.5) * 0.35; }
  else if (fb > hi) { bi += 1.0; lo = hi; hi = bi + 1.0 + (hash11(bi + 1.0 + cutJ) - 0.5) * 0.35; }
  float v = (fb - lo) / max(hi - lo, 1e-3);
  float bandW = (hi - lo) / nB * span;
  // Along the band: its own scroll, plus the snare's jumps.
  float dir = mod(bi, 2.0) < 0.5 ? 1.0 : -1.0;
  float speed = (0.15 + 0.25 * hash11(bi * 7.1)) * (1.0 - 0.7 * uArc.z);
  float u = q.x + dir * (uClock.x * uSpeed * speed * 0.25 + uS0.x * 0.22 * P_JUMP);
  // Which material, in which colours: re-dealt on every drop.
  float deal = uS0.y;
  float kind = floor(hash11(bi * 3.3 + deal * 17.0) * 7.0);
  vec3 cA = pal(hash11(bi + deal * 5.0));
  vec3 cB = mix(pal(fract(hash11(bi + deal * 5.0) + 0.45)), uPalAcc.rgb, step(0.6, hash11(bi * 1.9 + deal)));
  vec3 col = material(kind, vec2(u, v), bandW, px, bi, cA, cB);
  // Levels: the band pulses with its own part of the spectrum.
  float f = fract(bi * 0.137 + 0.3);
  float lvl = texture(uSpec, vec2(f, 0.25)).r;
  col *= 0.35 + 0.5 * lvl + 0.3 * uFlow.x;
  // The cut lines themselves: a hairline of light, brighter on the kick.
  float dEdge = min(v, 1.0 - v) * bandW;
  col = mix(col, uPalBg.rgb * 0.2, smoothstep(px * 2.5, px * 1.0, dEdge));
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * exp(-pow(dEdge / px, 2.0)) * (0.15 + 0.8 * uHit.y * amp);
  col *= 0.55;
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    // The jump position is a step count, eased: a snare adds one (two in a
    // roll), and the shown position chases it over a sixteenth with a little
    // overshoot — a cut, not a slide.
    let target = 0;
    let shown = 0;
    let vel = 0;
    let deal = 0;
    let cut = 0;
    const snare = onStamp((m) => m.stamp.snare, (_s, m) => {
      target += m.roll > 0.3 ? 2 : 1;
    });
    const main = onStamp((m) => m.stamp.main, () => {
      cut += 1;
    });
    const drop = onStamp((m) => m.stamp.drop, () => {
      deal += 1;
      target += 4;
      flash(0.8);
    });
    return {
      step(dt, m) {
        snare(m);
        main(m);
        drop(m);
        // A stiff spring, critically under-damped: tempo-scaled, so a jump
        // takes the same fraction of a beat at any BPM.
        const w = (2 * Math.PI) / m.overBeats(0.35);
        const k = w * w;
        const c = 2 * 0.55 * w;
        // Integrated in substeps a fraction of the spring's own period: at
        // 250 BPM the period is 84 ms, and a fixed 1/60 s step (w·h = 1.25)
        // is past where semi-implicit Euler stays stable — the jump
        // position ran off to infinity within seven seconds.
        const span = Math.min(dt, 0.25);
        const n = Math.min(64, Math.max(1, Math.ceil((span * w) / 0.3)));
        const h = span / n;
        for (let i = 0; i < n; i++) {
          const a = k * (target - shown) - c * vel;
          vel += a * h;
          shown += vel * h;
        }
        state[0] = shown;
        state[1] = deal;
        state[2] = cut;
      },
    };
  },
};
