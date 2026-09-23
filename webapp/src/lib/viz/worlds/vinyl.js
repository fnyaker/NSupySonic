// VINYLE — the record on the deck, carrying what it just played.
//
// Hip-hop, boom bap, house, disco, dub: music that lives on a turntable. The
// picture is the deck seen from above under a lamp — and it is faithful to the
// object in the one detail that makes it more than a drawing:
//
//   THE GROOVES REMEMBER. On a real record a loud passage is cut wide and
//   reads matte, a quiet one is cut narrow and reads glossy, so a record shows
//   its own dynamics as rings. Here the rings OUTSIDE the stylus are the music
//   that has just played — the spectrum history, a sixteenth per band,
//   laid along the spiral — so the drops you just heard are the matte bands
//   drifting outward and the breakdown is a mirror-bright one.
//   THE SHEEN is anisotropic, the way grooves reflect: two bright wedges on
//   the axis toward the lamp, with the faint rainbow edge the grooves diffract.
//   THE DECK turns one revolution every two beats (at 128 BPM that is almost
//   exactly 33 1/3), so the dust and the groove pattern turn at the tempo.
//   The platter's strobe dots, lit by the red strobe lamp, drift the way they
//   do when the pitch is off. The tonearm rides the groove and trembles on
//   the kick.
//   THE DROP is a scratch: the record is dragged back and thrown forward.
//
// The artwork, when there is one, is the record's label.
//
// Parameters:
//   gloss   sheen strength    arm   the tonearm (0 hides it)
//   rpm     revolutions per beat (x 0.5)

import { onStamp } from "./kit.js";

export default {
  id: "vinyl",
  uses: ["noise", "sdf"],
  params: { gloss: 1, arm: 1, rpm: 1 },
  look: { exposure: 1.0, bloom: 1.1, threshold: 0.8, saturation: 1.1 },

  fragment: `
// The level a sixteenth \`k\` ago, read in the mids and the top: the bottom of
// a loud master sits pinned near full scale and would cut every groove the
// same width.
float histLevel(float k) {
  float y = fract(uHistHead - k / 64.0);
  return (texture(uHist, vec2(0.45, y)).r + texture(uHist, vec2(0.7, y)).r) * 0.5;
}

// Where the stylus rides: past the middle of the record and creeping inward
// over eight phrases, so there is always a stretch of played grooves outside
// it to carry the history.
float stylusR(float label, float R) {
  return mix(R * 0.64, max(R * 0.5, label * 1.2), fract(uClock.z * 0.125));
}

void main() {
  vec2 p = fragP();
  float amp = 0.6 + 0.4 * uCtl.x;
  vec2 C = uHole.xy;
  float R = 0.93;
  vec2 d = p - C;
  float r = length(d);
  float spin = uS0.x;
  float th = atan(d.y, d.x);
  float thR = th - spin;           // the record's own angle
  float px = uFrame.w;
  vec2 L2 = normalize(vec2(-0.6, 0.8)); // the lamp, up and to the left

  // --- the plinth: brushed dark aluminium ---
  float brush = gnoise(vec2(p.x * 3.0, p.y * 260.0)) * 0.5 + 0.5;
  vec3 col = mix(uPalBg.rgb * 0.8, vec3(0.03), 0.5) * (0.8 + 0.25 * brush);
  col += vec3(0.05) * pow(max(dot(normalize(p + vec2(0.0, 2.0)), L2), 0.0), 8.0) * 0.3;

  // --- the platter's rim with its strobe dots ---
  float rimIn = R + 0.015;
  float rimOut = R + 0.07;
  if (r > rimIn && r < rimOut + px) {
    float band = (r - rimIn) / (rimOut - rimIn);
    vec3 metal = vec3(0.08) + vec3(0.25) * pow(abs(sin(th * 1.0 + 0.8)), 6.0);
    // Four rows of dots, each row a different count — the strobe's scales.
    float row = floor(band * 4.0);
    float cnt = 180.0 + row * 3.0;
    float drift = uS0.y * (row - 1.5) * 0.4;
    float a01 = fract((th + drift) / TAU * cnt);
    float dot2 = smoothstep(0.35, 0.2, abs(a01 - 0.5)) * smoothstep(0.35, 0.15, abs(fract(band * 4.0) - 0.5));
    vec3 strobe = mix(vec3(1.0, 0.15, 0.08), uPalAcc.rgb, 0.3);
    float lampL = exp(-length(p - (C + vec2(R * 0.85, -R * 0.75))) * 2.0);
    col = metal * 0.5 + strobe * dot2 * (0.25 + 1.4 * lampL) * (0.7 + 0.3 * uHit.x);
    col *= smoothstep(rimOut + px, rimOut - px, r);
  }
  // The strobe lamp itself, a red glow at the corner of the platter.
  col += mix(vec3(1.0, 0.15, 0.08), uPalAcc.rgb, 0.3) * glow(length(p - (C + vec2(R * 1.02, -R * 0.86))), 0.02) * 0.6;

  // --- the record ---
  float label = uHole.z > 0.0 ? length(uHole.zw) * 0.8 : 0.3;
  if (r < R) {
    // Groove bands: the stylus sits at rs; outside it, what has played.
    float rs = stylusR(label, R);
    // A sixteenth per band — the last six beats between the stylus and the
    // rim — each band judged against the loudest of its own beat, so a kick
    // cuts a matte band and the gaps between kicks stay mirror-bright even
    // when the whole passage is loud.
    float pitch = (R - rs) / 24.0;
    float k = floor(max(0.0, (r - rs) / pitch + thR / TAU));
    float played = step(rs, r);
    float kb = floor(k / 4.0) * 4.0;
    float beatMax = max(max(histLevel(kb), histLevel(kb + 1.0)), max(histLevel(kb + 2.0), histLevel(kb + 3.0)));
    float lv = played > 0.5 ? histLevel(k) / max(beatMax, 0.08) : 0.5 + 0.2 * gnoise(vec2(r * 60.0, 1.0));
    // Loud grooves are cut wide: matte. Quiet grooves: a mirror. And every
    // other band is a groove wall catching the lamp at another angle, which
    // is what gives a record its fine ringed sheen.
    float wall = step(0.5, fract(k * 0.5 + 0.25));
    float glossy = mix(0.3, 1.0, wall) * (1.0 - 0.7 * smoothstep(0.4, 1.0, lv) * played);
    // Track gaps: a few mirror-bright bands where no groove is cut.
    float gap = smoothstep(0.488, 0.496, abs(fract((r - label) / (R - label) * 5.0 + 0.07) - 0.5));
    glossy = max(glossy, gap);
    // The anisotropic sheen: bright along the axis toward the lamp.
    vec2 rd = d / max(r, 1e-4);
    float ax = abs(dot(rd, L2));
    float wedge = pow(ax, 30.0 + 140.0 * glossy) * (0.12 + 1.25 * glossy);
    // Fine ring texture — only where the rings are wider than the pixels.
    float fine = gnoise(vec2(r * 140.0, 0.5)) * smoothstep(1.2, 0.3, px * 140.0);
    wedge *= 0.85 + 0.3 * fine;
    float wide = pow(ax, 6.0) * 0.08;
    // Diffraction: the wedge's edge splits into the faintest rainbow.
    vec3 rainbow = hue2rgb(fract(ax * 4.0 + r * 1.5));
    vec3 vinylC = vec3(0.012) + uPalLow.rgb * 0.01;
    vec3 sheen = mix(vec3(1.0), rainbow, 0.35) * wedge + mix(uPalMid.rgb, vec3(1.0), 0.5) * wide * glossy;
    col = vinylC + sheen * 0.55 * P_GLOSS * (0.7 + 0.3 * uMood.y);
    // Dust: specks that turn with the record.
    vec2 rp = vec2(cos(thR), sin(thR)) * r * 70.0;
    float dust = step(0.997, hash12(floor(rp))) * smoothstep(0.5, 0.1, length(fract(rp) - 0.5));
    col += vec3(0.5) * dust * 0.4;
    // The rim of the record catches the lamp.
    col += vec3(0.4) * exp(-pow((r - R + 0.004) / (px * 1.5), 2.0)) * (0.3 + 0.7 * pow(max(dot(rd, L2), 0.0), 2.0));
    // The label: the artwork sits here; without it, a disc in the palette.
    if (r < label) {
      vec3 lab = mix(uPalMid.rgb, uPalHigh.rgb, 0.3) * 0.25;
      float ring = exp(-pow((r - label * 0.72) / 0.004, 2.0));
      vec2 lp = vec2(cos(thR), sin(thR)) * r;
      lab += uPalHigh.rgb * ring * 0.3 + uPalAcc.rgb * smoothstep(0.03, 0.02, length(lp - vec2(label * 0.45, 0.0))) * 0.3;
      lab = mix(lab, vec3(0.6), smoothstep(0.012, 0.009, r));
      col = lab;
    }
  }
  // The drop's scratch lights the record for a moment.
  col += mix(uPalHigh.rgb, vec3(1.0), 0.4) * uS0.z * 0.1 * step(r, R);

  // --- the tonearm, over everything ---
  if (P_ARM > 0.02) {
    vec2 pivot = C + vec2(R * 1.12, R * 0.78);
    float rs = stylusR(label, R);
    // The stylus sits on the groove, on the lamp side of the record.
    vec2 needle = C + normalize(vec2(0.35, 0.55)) * rs;
    needle += vec2(0.0, 0.002) * uHit.y * amp * sin(uClock.x * 90.0);
    vec2 elbow = mix(pivot, needle, 0.72) + vec2(0.05, -0.02);
    float armD = min(sdSeg2(p, pivot, elbow), sdSeg2(p, elbow, needle)) - 0.011;
    // Its shadow on the record first, cast down and to the right.
    float sh = min(sdSeg2(p - vec2(0.03, -0.035), pivot, elbow), sdSeg2(p - vec2(0.03, -0.035), elbow, needle)) - 0.018;
    col *= mix(1.0, 0.35, smoothstep(0.03, -0.01, sh) * P_ARM);
    // The headshell: a small block at the needle end.
    vec2 hd = needle - elbow;
    float ha = atan(hd.y, hd.x);
    vec2 hp = rot(-ha) * (p - needle);
    float head = sdBox2(hp - vec2(-0.02, 0.0), vec2(0.035, 0.018));
    float cw = length(p - (pivot + normalize(pivot - elbow) * 0.08)) - 0.045;
    float base = length(p - pivot) - 0.06;
    float solid = min(min(armD, head), min(cw, base));
    float cov = smoothstep(px, -px, solid);
    // Brushed steel: a highlight running along the tube.
    vec3 steel = vec3(0.35) * (0.5 + 0.5 * smoothstep(0.012, -0.004, armD)) + vec3(0.6) * exp(-pow(armD + 0.006, 2.0) / 0.00002);
    steel = mix(steel, vec3(0.05), smoothstep(0.0, -0.01, base) * 0.6);
    steel += uPalHigh.rgb * exp(-length(p - needle) * 60.0) * (0.3 + uHit.y);
    col = mix(col, steel * (0.5 + 0.5 * uMood.y), cov * P_ARM);
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, params, flash }) {
    let spin = 0;
    let drift = 0;
    let scratch = 0;
    let scratchAt = -1;
    const drop = onStamp((m) => m.stamp.drop, () => {
      scratchAt = 0;
      scratch = 1;
      flash(0.6);
    });
    return {
      step(dt, m) {
        drop(m);
        // One revolution every two beats, integrated so tempo changes never
        // jump the record.
        spin += (dt / m.beat) * Math.PI * (params.rpm || 1);
        // The scratch: back over a quarter beat, forward over the next,
        // on top of the steady turn.
        let off = 0;
        if (scratchAt >= 0) {
          scratchAt += dt / m.beat;
          const u = scratchAt;
          off = u < 0.5 ? -Math.sin(u * Math.PI) * 1.2 : u < 1 ? -Math.sin(u * Math.PI) * 1.2 * (1 - (u - 0.5) * 2) : 0;
          if (u > 1) scratchAt = -1;
        }
        scratch = Math.max(0, scratch - dt / m.overBeats(1));
        // The strobe dots drift with how far the tempo sits from 128.
        drift += dt * ((60 / m.beat - 128) / 128) * 2;
        state[0] = spin + off;
        state[1] = drift;
        state[2] = scratch;
      },
    };
  },
};
