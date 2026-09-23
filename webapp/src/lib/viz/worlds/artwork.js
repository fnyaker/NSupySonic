// POCHETTE VIVANTE — the artwork's own colours, alive.
//
// For any record whose sleeve IS the picture: the frame is filled with the
// cover's colours, melted into a gradient that never stops moving, the way a
// good player's "now playing" background breathes behind the art.
//
//   THE MESH. Five blobs of colour, each one picked FROM the artwork (a region
//   of it read at a heavily blurred level of its mipmap, so it is that
//   region's average, not a stray pixel), orbiting slowly and blended by
//   distance into one continuous gradient. Under them the artwork itself,
//   read even blurrier and pushed around by a slow warp, carries the colours
//   the blobs miss.
//   THE MUSIC. The orbit runs on the bar clock and quickens with the drive;
//   the kick breathes the whole mesh in (a small zoom, a lift in light); the
//   voice saturates it; the drop blooms it bright and lets it settle over
//   two bars. Everything is slow on purpose: this is a background for the
//   artwork, and it must never compete with it.
//   WITHOUT ARTWORK it draws the same mesh from the palette.
//
// Parameters:
//   blobs   how many (3..5)    swirl   warp strength
//   sat     saturation lift

import { onStamp } from "./kit.js";

export default {
  id: "artwork",
  uses: ["noise"],
  params: { blobs: 5, swirl: 1, sat: 1 },
  look: { exposure: 1.0, bloom: 0.9, threshold: 0.9, saturation: 1.1 },

  fragment: `
// The artwork's colour around uv, averaged over a region the size of lod.
vec3 art(vec2 uv, float lod) {
  vec3 c = textureLod(uCover, uv, lod).rgb;
  return c * c; // into linear, roughly
}

void main() {
  vec2 p = fragP();
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float A = uFrame.z;
  float orbit = uS0.x;
  // The kick breathes the mesh in.
  float breath = 1.0 - 0.035 * envB(uSince.x, 0.5) * amp;
  vec2 q = p * breath;
  bool hasArt = uCoverOK > 0.5;

  // --- the warped under-layer ---
  vec2 w = vec2(fbm(q * 0.8 + vec2(orbit * 0.3, 0.0), 3), fbm(q * 0.8 + vec2(3.1, orbit * 0.25), 3)) - 0.5;
  vec2 uv = q / vec2(2.0 * max(A, 1.0)) * 0.9 + 0.5 + w * 0.35 * P_SWIRL;
  uv.y = 1.0 - uv.y;
  vec3 under = hasArt ? art(uv, 5.0) : pal(fract(uv.x * 0.6 + uv.y * 0.3 + orbit * 0.05));

  // --- the mesh of colour blobs ---
  int n = int(clamp(P_BLOBS, 3.0, 5.0));
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= n) break;
    float fi = float(i);
    // Where on the artwork this blob's colour comes from.
    vec2 src = fi < 4.0 ? vec2(mod(fi, 2.0) * 0.6 + 0.2, floor(fi / 2.0) * 0.6 + 0.2) : vec2(0.5);
    vec3 c = hasArt ? art(src, 4.0) : pal(fi / 4.0);
    // Its orbit round the frame.
    float a = fi * TAU / float(n) + orbit * (0.6 + 0.15 * fi) * (mod(fi, 2.0) < 0.5 ? 1.0 : -1.0);
    vec2 at = vec2(cos(a) * A * 0.6, sin(a * 1.3) * 0.6);
    float d2 = dot(q - at, q - at);
    float wgt = exp(-d2 / 0.35);
    acc += c * wgt;
    wsum += wgt;
  }
  vec3 mesh = acc / max(wsum, 1e-3);
  vec3 col = mix(under, mesh, 0.65);
  // Saturation: lift it with the voice (and the knob), a colourist's move —
  // around the luminance, never away from the artwork's own hues.
  float l = luma(col);
  float satK = (1.15 + 0.35 * uBandB.w) * P_SAT;
  col = max(vec3(0.0), mix(vec3(l), col, satK));
  // A background, not a light source: held well under the artwork.
  float lift = 0.42 + 0.12 * uFlow.x + 0.18 * envB(uSince.x, 0.5) * amp + 0.35 * uS0.y;
  col *= lift;
  // A soft vignette of LIGHT (never a darkening at the edges): the middle glows.
  col += mesh * exp(-dot(p, p) * 0.8) * 0.06;
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.15;
  // The real artwork is in front of the middle of this one: under it, nothing
  // is seen, and a glow spent there is a glow taken from the frame around it.
  col *= mix(0.35, 1.0, clearOfHole(p, 0.06));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    let orbit = 0;
    let bloom = 0;
    const drop = onStamp((m) => m.stamp.drop, () => {
      bloom = 1;
      flash(0.4);
    });
    return {
      step(dt, m) {
        drop(m);
        // A slow turn: a sixteenth of a revolution per bar, quicker with drive.
        orbit += (dt / m.bar) * (Math.PI / 8) * (0.6 + 0.6 * m.drive);
        bloom = Math.max(0, bloom - dt / m.overBeats(8));
        state[0] = orbit;
        state[1] = bloom * bloom;
      },
    };
  },
};
