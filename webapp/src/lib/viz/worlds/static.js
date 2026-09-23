// PARASITES — the signal, torn apart on the beat.
//
// Krach, noise, industrial hardcore, glitch: music that treats the signal as
// something to break. So the picture is a SIGNAL — the album's own artwork on
// a broken screen (or, with no artwork, a test card in the palette's colours)
// — and the music breaks it:
//
//   THE TEAR. The frame is cut into horizontal bands, re-drawn every
//   sixteenth, and each band is thrown sideways by the kick and the snare;
//   the harder the track drives, the finer the bands and the further they go.
//   THE SORT. Some torn bands are pixel-sorted: the brightest of the picture
//   behind each pixel along the band drags into a long clean streak — the
//   signature of glitch art, and what makes the damage look made rather than
//   random.
//   THE BLOCKS. A main kick corrupts a scatter of macroblocks the way a
//   damaged video stream does: a block shows a piece of the picture from
//   elsewhere, or smears its top row down, or decodes its channels in the
//   wrong order, and holds for a beat.
//   THE CHANNELS. The red, green and blue planes are separated by the kick —
//   a picture that comes apart into its colours and snaps back.
//   THE CARRIER. Under all of it the analogue layer: scanlines, a snow of
//   noise that thickens with the top end, and the vertical-hold bar rolling
//   once a bar.
//   THE DROP. For a beat the whole signal goes to posterised colour-noise, and
//   comes back.
//
// The artwork is gradient-mapped onto the palette part of the way, so the
// torn picture stays in the same colours as everything else on the screen.
//
// Parameters:
//   tear    band displacement    blocks  macroblock corruption
//   split   channel separation   snow    analogue noise

import { onStamp } from "./kit.js";

export default {
  id: "static",
  uses: ["noise"],
  params: { tear: 1, blocks: 1, split: 1, snow: 1 },
  look: { exposure: 1.0, bloom: 1.0, threshold: 0.85, saturation: 1.1 },

  fragment: `
// The signal at p-space point q: the artwork filling the frame, or a test card.
vec3 signal(vec2 q, float lod) {
  float A = uFrame.z;
  vec3 c;
  if (uCoverOK > 0.5) {
    float s = max(A, 1.0);
    // Cover-fit, drifting slowly so the picture is never still.
    vec2 d = vec2(sin(uClock.z * TAU * 0.5), cos(uClock.z * TAU * 0.25)) * 0.03;
    vec2 uv = vec2(q.x / (2.0 * s), -q.y / (2.0 * s)) * 0.94 + 0.5 + d;
    c = textureLod(uCover, uv, lod).rgb;
    c *= c; // the texture is sRGB-ish: into linear, roughly
  } else {
    // A test card: seven bars in the palette, a strip of blocks under them.
    float x = (q.x / (2.0 * A) + 0.5) * 7.0;
    float bar = floor(x);
    c = q.y > -0.4 ? pal(bar / 6.0) * (0.5 + 0.5 * step(0.5, mod(bar, 2.0))) : vec3(step(0.5, fract(x * 0.5)) * 0.8);
    if (q.y > -0.55 && q.y < -0.4) c = pal(1.0 - bar / 6.0) * 0.3;
  }
  // Part of the way onto the palette: a gradient map by luminance.
  float l = luma(c);
  vec3 mapped = pal(clamp(l * 1.3, 0.0, 1.0)) * (0.3 + 0.9 * l);
  return mix(c, mapped, 0.55);
}

void main() {
  vec2 p = fragP();
  float beats = uClock.x * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float drive = uFlow.x;
  float kick = uHit.x * amp;
  float snare = uHit.w * amp;
  vec2 uvS = gl_FragCoord.xy / uRes;

  // --- the tear: bands re-drawn every sixteenth (every eighth when calm) ---
  float rate = drive > 0.5 ? 4.0 : 2.0;
  float seed = floor(beats * rate);
  float nb = mix(6.0, 26.0, drive);
  float band = floor((p.y * 0.5 + 0.5) * nb + hash11(seed) * 3.0);
  float h = hash12(vec2(band, seed));
  float torn = step(0.55 - 0.3 * drive, h);
  float shove = (hash12(vec2(band, seed + 7.0)) - 0.5) * 2.0;
  float tear = torn * shove * (0.02 + 0.25 * kick + 0.18 * snare + 0.05 * drive) * P_TEAR;
  vec2 q = p + vec2(tear, 0.0);

  // --- the blocks: a main kick corrupts a scatter of macroblocks ---
  vec2 bs = vec2(0.16, 0.12);
  vec2 bid = floor(q / bs);
  float corrupt = envB(uSince.y, 1.2) * step(uSince.y, 1.0);
  float bh = hash12(bid + uCount.z * 3.1);
  float mode = 0.0;
  // A handful, not a carpet: a scatter reads as a stream breaking, a field
  // of them as a picture that was never there.
  if (bh < (0.05 + 0.1 * drive) * corrupt * P_BLOCKS * 2.0) {
    mode = 1.0 + floor(hash12(bid + 9.7 + uCount.z) * 3.0);
    if (mode < 1.5) {
      // A piece of the picture from elsewhere.
      q += (hash22(bid + uCount.z) - 0.5) * 0.8;
    } else if (mode < 2.5) {
      // The block's top row smeared down its height.
      q.y = (bid.y + 1.0) * bs.y - 0.002;
    }
  }

  // --- the channels, separated by the kick ---
  float sep = (0.004 + 0.035 * kick + 0.02 * snare) * P_SPLIT;
  float lod = 0.5 + 1.5 * (1.0 - drive);
  vec3 col;
  col.r = signal(q + vec2(sep, 0.0), lod).r;
  col.g = signal(q, lod).g;
  col.b = signal(q - vec2(sep, 0.0), lod).b;
  // A chroma error: the block's channels decoded in the wrong order, which
  // is what a broken stream actually shows (an inverted block reads as mud).
  if (mode > 2.5) col = col.brg * 1.2;
  // --- the sort: in a torn band, bright pixels run into streaks ---
  // Pixel sorting, the signature of glitch art: every pixel in the band takes
  // the brightest of the picture behind it along the band's direction, so
  // light drags into long, clean smears that end where the dark begins. The
  // run length is the band's own, re-drawn with the tear, and grows with the
  // kick.
  float sortOn = torn * step(0.45, hash12(vec2(band, seed + 3.0))) * P_TEAR;
  if (sortOn > 0.5) {
    float runL = (0.04 + 0.3 * hash12(vec2(band, seed + 5.0))) * (0.5 + 0.8 * drive + 0.8 * kick);
    float dirS = hash12(vec2(band, seed + 11.0)) < 0.5 ? -1.0 : 1.0;
    vec3 best = col;
    float bestL = luma(col);
    for (int i = 1; i <= 7; i++) {
      vec3 c = signal(q - vec2(dirS * runL * float(i) / 7.0, 0.0), lod + 1.0);
      float l = luma(c);
      // Only light sorts: the streak stops at the first dark it would cross.
      if (l > bestL && l > 0.12) { best = c; bestL = l; }
    }
    col = mix(col, best, 0.85);
  }
  // The picture is a backdrop: dimmed, and brighter where it is torn.
  col *= 0.32 + 0.25 * torn * (kick + snare) + 0.12 * step(0.5, mode);

  // --- the drop: a beat of posterised colour noise ---
  float dropK = envB(uSince.w, 0.6) * step(uSince.w, 2.0);
  if (dropK > 0.01) {
    vec2 cell = floor(gl_FragCoord.xy / 6.0);
    vec3 nz = hash32(cell + floor(beats * 8.0));
    vec3 post = floor(nz * 3.0) / 2.0;
    col = mix(col, pal(post.x) * (0.3 + 0.9 * post.y), dropK * 0.8);
  }

  // --- the carrier: scanlines, snow, the vertical-hold bar ---
  float scan = 0.82 + 0.18 * sin(gl_FragCoord.y * PI * 0.5);
  col *= scan;
  float snow = hash12(gl_FragCoord.xy + fract(beats * 13.7) * 91.0);
  col += vec3(pow(snow, 12.0)) * (0.2 + 0.8 * uBandB.x + 0.5 * snare) * 0.25 * P_SNOW;
  col += (snow - 0.5) * 0.02 * P_SNOW;
  float hold = fract(uvS.y + uClock.y * uSpeed);
  col *= 1.0 - 0.35 * smoothstep(0.0, 0.03, hold) * smoothstep(0.1, 0.06, hold);
  col += pal(0.9) * exp(-pow((hold - 0.02) / 0.004, 2.0)) * 0.12;
  // Torn band edges catch a line of light.
  float bandY = fract((p.y * 0.5 + 0.5) * nb + hash11(seed) * 3.0);
  col += mix(uPalHigh.rgb, vec3(1.0), 0.4) * torn * smoothstep(0.08, 0.0, min(bandY, 1.0 - bandY)) * 0.15 * (kick + snare);

  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ flash }) {
    const drop = onStamp((m) => m.stamp.drop, () => flash(0.9));
    return {
      step(dt, m) {
        drop(m);
      },
    };
  },
};
