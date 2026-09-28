// SPECTRE — the spectrum, as a row of light.
//
// The most literal picture in the catalogue, and the one where fashion shows
// most. It used to be glass tubes: a rim light down each edge, a specular
// stripe, a hot top, hairline peak caps hanging above, a mirror-polished floor
// reflecting it all — every one of them a 2005 idea, and together they read as
// a media player from that year. What a spectrum looks like today is LESS:
//
//   THE SHAPE. One capsule per band, fully rounded, a single continuous shape
//   mirrored about its axis — not two rounded bars meeting in the middle, which
//   drew a dark pinch along the axis — and at rest it is a DOT, not a stub. A
//   quiet passage is a row of dots breathing; a drop is a wall of light.
//   THE MATERIAL. Flat, luminous, no edges drawn: the band's colour, a white
//   core that grows with its level, a gentle fade toward the tips. The bloom
//   does the glow; nothing is painted on to fake one.
//   THE LEVEL. The three zone gains keep every register alive (one gain across
//   the spectrum parks the bass: the mids and highs drive it down), but a gain
//   that normalises everything also makes a breakdown as tall as the drop. So
//   the heights are scaled by the track's own DYNAMICS (this moment against its
//   loud level): level is information, and the bars say how loud it is.
//   THE TRAIL. No peak caps. The highest each band has been in the last two
//   beats, falling linearly in sixteenths, is drawn as a faint extension of the
//   capsule — an afterglow that hangs and drops at the tempo of the track,
//   computed from the spectrum history with no per-bar state anywhere.
//
// Full screen the row runs along the middle of the frame, over a light the
// bars themselves cast; with the artwork in front, one row fills the band
// under it and one the band above, so they frame it instead of growing up
// behind it. In the player's strip (the `strip` layout) the background is
// transparent and the row sits on the blurred artwork.
//
// Parameters:
//   width    capsule width as a share of its pitch   glow   the axis light
//   curve    loudness gamma (higher = more contrast)  trail  the afterglow
//   pitch    CSS px per band in the strip (fewer, rounder capsules = larger)

export default {
  id: "spectrum",
  uses: ["sdf"],
  params: { width: 0.5, curve: 1.8, glow: 1, trail: 1, pitch: 7.5 },
  // No lens fringe: on thin light lines it reads as a colour-fringed LCD, and
  // on a 40 px strip it split every capsule into three.
  look: { exposure: 1, bloom: 0.7, threshold: 0.8, saturation: 1.08, ca: 0 },

  fragment: `
// The zone gains (uS0.xyz: bass, mid, high), interpolated between the zone
// centres so the three never show a seam.
float gainAt(float f) {
  if (f <= 1.0 / 6.0) return uS0.x;
  if (f >= 5.0 / 6.0) return uS0.z;
  if (f < 0.5) return mix(uS0.x, uS0.y, (f - 1.0 / 6.0) * 3.0);
  return mix(uS0.y, uS0.z, (f - 0.5) * 3.0);
}

float level(float f, float row) {
  return texture(uSpec, vec2(f, row)).r;
}

float shape(float v, float f) {
  return pow(clamp(v * gainAt(f), 0.0, 1.0), P_CURVE);
}

// A history row \`k\` sixteenths ago.
float histAt(float f, float k) {
  float y = uHistHead - k / 64.0;
  return texture(uHist, vec2(f, fract(y) + 0.5 / 64.0)).r;
}

// A capsule of half width w and half height h (h >= w), centred on the origin.
float capsule(vec2 q, float w, float h) {
  return sdRound2(q, vec2(w, max(h, w)), w);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uRes;
  bool strip = uCtl.z > 0.5;
  float N = max(8.0, uS0.w);
  float pitchPx = uRes.x / N;
  float bi = clamp(floor(frag.x / pitchPx), 0.0, N - 1.0);
  float f = (bi + 0.5) / N;
  // The band's value: the peak of three taps across its span, so a narrow
  // partial inside a wide band is still seen (averaging it away is what makes
  // a spectrum look limp).
  float span = 0.5 / N;
  float vS = max(level(f, 0.25), max(level(f - span * 0.6, 0.25), level(f + span * 0.6, 0.25)));
  // Level is information: a breakdown is a row of small capsules, not the
  // drop's wall renormalised to the same height.
  float dyn = clamp(uMood.z, 0.0, 1.0);
  float loud = mix(0.28, 1.0, smoothstep(0.05, 0.9, dyn));
  float v = shape(vS, f) * loud;
  // The afterglow: the highest this band has been in the last two beats,
  // falling 0.05 per sixteenth. Stateless, and it falls in musical time.
  float cap = v;
  for (int k = 1; k < 8; k++) {
    float fk = float(k);
    cap = max(cap, shape(histAt(f, fk), f) * loud - fk * 0.05);
  }

  // Where the row runs: its axis and how far a capsule may reach from it, in
  // pixels, so the edges are anti-aliased at any size.
  float axis = 0.5 * uRes.y;
  float reach = strip ? 0.5 * uRes.y - 1.5 : 0.36 * uRes.y;
  if (!strip && uHole.z > 0.0) {
    // With the artwork in front: the band under it and the band above it,
    // each with its own row, when both have room for one.
    float below = (0.5 + 0.5 * uHoleR.z) * uRes.y;
    float above = (0.5 + 0.5 * (uHole.y + uHole.w + 0.03)) * uRes.y;
    float lo = below - 0.04 * uRes.y;
    float hi = 0.96 * uRes.y - above;
    if (min(lo, hi) > 0.1 * uRes.y) {
      bool upper = frag.y > 0.5 * (below + above);
      axis = upper ? above + 0.5 * hi : 0.04 * uRes.y + 0.5 * lo;
      reach = 0.46 * (upper ? hi : lo);
    }
  }

  float halfW = max(0.75, pitchPx * P_WIDTH * 0.5);
  float cx = (bi + 0.5) * pitchPx;
  vec2 q = vec2(frag.x - cx, frag.y - axis);
  float h = max(halfW, v * reach);
  float sd = capsule(q, halfW, h);
  float cover = clamp(0.5 - sd, 0.0, 1.0);
  float hg = max(halfW, cap * reach);
  float ghost = clamp(0.5 - capsule(q, halfW, hg), 0.0, 1.0) * (1.0 - cover);

  vec3 hue = pal(f);
  // Flat light: the band's colour, a white core growing with its level, a
  // gentle fade toward the tips. The kick lifts the low end a little.
  float along = clamp(abs(q.y) / max(h, 1.0), 0.0, 1.0);
  float kick = uHit.x * (1.0 - f) * 0.45 + uHit.y * 0.15;
  vec3 core = mix(hue, vec3(1.0), 0.1 + 0.3 * v);
  vec3 c = mix(core, hue, smoothstep(0.1, 1.0, along)) * (0.62 + 0.75 * v + kick);
  c *= 1.0 - 0.3 * smoothstep(0.55, 1.0, along);
  vec3 g = hue * (0.5 + 0.5 * cap);
  float ga = ghost * 0.2 * P_TRAIL;

  if (strip) {
    // Transparent, over the blurred artwork. The colour goes out unmultiplied:
    // the post pass multiplies it by the alpha itself.
    // A quiet band is a little translucent, a loud one solid: the row reads
    // as light over the artwork rather than stickers on it.
    float a = max(cover * (0.62 + 0.38 * smoothstep(0.0, 0.6, v)), ga);
    vec3 col = (c * cover + g * ga) / max(cover + ga, 1e-3);
    emitA(col * uEnergy, a);
    return;
  }

  // --- the room -------------------------------------------------------------
  // A deep field, and the light the row casts along its own axis: tinted band
  // by band, swelling with the low end and on the kick. No floor, no mirror.
  vec3 col = uPalBg.rgb * (0.85 + 0.25 * uv.y);
  float dy = abs(frag.y - axis) / uRes.y;
  float lowE = uBandA.x + uBandA.y;
  float spill = exp(-dy * 9.0) * (0.05 + 0.08 * uMood.y + 0.1 * uHit.x * lowE) * P_GLOW * loud;
  col += pal(uv.x) * spill;
  col += pal(uv.x) * exp(-dy * 40.0) * 0.05 * P_GLOW * loud;
  col = mix(col, g, ga);
  col = mix(col, c, cover);
  col += (uPalHigh.rgb * 0.25) * uHit2.w;
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ preset, state, flash, params, opts }) {
    // Three slow zone gains: each zone brought to the same working level, so
    // the bass keeps its own life instead of sitting under the mids.
    const zone = [0.2, 0.2, 0.2];
    const sums = [0, 0, 0];
    const cnt = [0, 0, 0];
    let drop = -1e9;
    const ceiling = Math.max(24, preset.bars || 64);
    const pitch = Math.max(4, params?.pitch ?? 7.5);
    return {
      step(dt, m, c) {
        const s = c.spec;
        if (s) {
          const n = s.length;
          sums[0] = sums[1] = sums[2] = 0;
          cnt[0] = cnt[1] = cnt[2] = 0;
          for (let i = 0; i < n; i++) {
            const z = i < n / 3 ? 0 : i < (2 * n) / 3 ? 1 : 2;
            sums[z] += s[i];
            cnt[z]++;
          }
          for (let z = 0; z < 3; z++) {
            const mean = cnt[z] ? sums[z] / cnt[z] : 0;
            zone[z] = m.ease(zone[z], mean, 2, dt);
            state[z] = 0.7 / Math.max(0.1, zone[z]);
          }
        }
        // As many bands as the frame has room for: in the strip one per
        // `pitch` CSS px of its width; full screen one per ~14 px of a 16:9
        // frame. Always under the tier's ceiling.
        const aspect = c.aspect || 16 / 9;
        const want = opts?.layout === "strip" && c.height ? (aspect * c.height) / pitch : aspect * 36;
        state[3] = Math.round(Math.min(ceiling, Math.max(24, want)));
        if (m.stamp.drop !== drop) {
          drop = m.stamp.drop;
          flash(0.5);
        }
      },
    };
  },
};
