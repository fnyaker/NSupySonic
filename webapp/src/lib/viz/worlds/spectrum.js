// SPECTRE — the spectrum, as glass bars.
//
// The most literal picture in the catalogue, and for that reason the one where
// craft shows most: everybody has seen a bar graph, and the difference between
// a cheap one and a good one is entirely in the details. Four of them matter.
//
//   THE LEVELLING. One gain across the whole spectrum parks the bass: the mids
//   and highs carry most of the energy, so they drive the gain down and the low
//   end sits at the bottom whatever it does. The strip is split into three
//   zones, each with its own slow gain, interpolated so there is no seam.
//   THE FALL. Bars rise instantly and fall at a musical speed (the smoothed row
//   of the spectrum texture releases in beats), and the PEAK CAPS are computed
//   from the spectrum history — the highest value in the last two beats, minus
//   a fall that is linear in sixteenth notes — so they hang, then drop, at the
//   tempo of the track, with no per-bar state anywhere.
//   THE MATERIAL. Each bar is glass: a deep body, a brighter top, a thin rim
//   light down both edges, a specular stripe, and a hot cap the bloom turns
//   into light. Anti-aliased in pixels, so a 7 px bar is still a clean shape.
//   THE ROOM. Full screen, the bars stand on a dark floor that reflects them,
//   under a haze lit by the average spectrum. In the player's strip (the
//   `strip` layout) they are mirrored about the middle and the background is
//   transparent, so they sit on the blurred artwork.
//
// Parameters:
//   glass    rim-light and specular strength     reflect  floor reflection
//   width    bar width as a share of its pitch    peaks    peak-cap strength
//   curve    loudness gamma (higher = more contrast between quiet and loud)

export default {
  id: "spectrum",
  uses: ["sdf"],
  params: { glass: 1, reflect: 1, width: 0.64, peaks: 1, curve: 1.55 },
  look: { exposure: 1, bloom: 0.85, threshold: 0.85, saturation: 1.12 },

  fragment: `
// The zone gains (uS0.xyz: bass, mid, high), interpolated between the zone
// centres so the three never show a seam.
float gainAt(float f) {
  if (f <= 1.0 / 6.0) return uS0.x;
  if (f >= 5.0 / 6.0) return uS0.z;
  if (f < 0.5) return mix(uS0.x, uS0.y, (f - 1.0 / 6.0) * 3.0);
  return mix(uS0.y, uS0.z, (f - 0.5) * 3.0);
}

// The level of the band under frequency position f (0..1), from the row given.
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

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uRes;
  bool strip = uCtl.z > 0.5;
  float N = max(8.0, uS0.w);
  float pitchPx = uRes.x / N;
  float x = uv.x * N;
  float bi = floor(x);
  float f = (bi + 0.5) / N;
  // The bar's value: the peak of three taps across its span, so a narrow
  // partial inside a wide bar is still seen (averaging it away is what makes a
  // spectrum look limp).
  float span = 0.5 / N;
  float vS = max(level(f, 0.25), max(level(f - span * 0.6, 0.25), level(f + span * 0.6, 0.25)));
  float v = shape(vS, f);
  // The peak cap: the highest this bar has been in the last two beats, minus a
  // fall of 0.045 per sixteenth. Stateless, and it falls in musical time.
  float cap = v;
  for (int k = 0; k < 8; k++) {
    float fk = float(k);
    cap = max(cap, shape(histAt(f, fk), f) - fk * 0.045);
  }

  // Geometry, in pixels, so the edges are anti-aliased at any bar width.
  float base = strip ? 0.5 * uRes.y : 0.3 * uRes.y;
  float room = strip ? 0.5 * uRes.y - 1.0 : (uRes.y - base) * 0.86;
  // With the artwork in front, the bars FRAME it rather than growing up
  // behind it: one bank standing on the floor under the cover, and its mirror
  // hanging from the top above it. Grown from just under the cover, they
  // spent 30% of their light where nobody could see it. Where the artwork
  // leaves no room above or below (a cover beside the bars rather than in
  // front of them), the floor layout stands and the cover simply dims them.
  float yy;
  bool banked = false;
  if (!strip && uHole.z > 0.0) {
    float below = (0.5 + 0.5 * uHoleR.z) * uRes.y;
    float above = (0.5 + 0.5 * (uHole.y + uHole.w + 0.03)) * uRes.y;
    float floorPx = 0.05 * uRes.y;
    float ceilPx = 0.95 * uRes.y;
    float roomLo = (below - floorPx) * 0.92;
    float roomHi = (ceilPx - above) * 0.92;
    if (min(roomLo, roomHi) > 0.12 * uRes.y) {
      banked = true;
      bool upper = frag.y > 0.5 * (below + above);
      base = upper ? ceilPx : floorPx;
      room = upper ? roomHi : roomLo;
    }
  }
  float hgt = max(v * room, 1.5);
  float halfW = pitchPx * P_WIDTH * 0.5;
  float cx = (bi + 0.5) * pitchPx;
  float dx = frag.x - cx;
  float y = frag.y - base;
  // Mirrored about the middle in the strip; hanging from the ceiling in the
  // upper bank; standing on the floor otherwise.
  yy = strip ? abs(y) : (banked && base > 0.5 * uRes.y ? -y : y);
  float radius = min(halfW, 3.0);
  vec2 q = vec2(dx, yy - hgt * 0.5);
  float sd = sdRound2(q, vec2(halfW, hgt * 0.5), radius);
  float cover = clamp(0.5 - sd, 0.0, 1.0);

  vec3 hue = pal(f);
  float t = clamp(yy / max(hgt, 1.0), 0.0, 1.0);
  // The glass: a deep body, brightening toward the top; a rim light down each
  // edge; a specular stripe a third of the way across.
  float edge = 1.0 - clamp(abs(dx) / max(halfW, 1.0), 0.0, 1.0);
  float rim = pow(1.0 - edge, 6.0);
  float spec = exp(-pow((dx / max(halfW, 1.0) + 0.38) / 0.12, 2.0));
  vec3 body = hue * (0.25 + 1.1 * t * t) * (0.55 + 0.9 * v);
  body += mix(hue, vec3(1.0), 0.5) * (rim * 0.9 + spec * 0.45) * P_GLASS * (0.35 + v);
  // The hot top: a thin cap of light the bloom turns into a glow.
  float top = exp(-pow((yy - hgt) / 2.2, 2.0)) * step(abs(dx), halfW);
  body += mix(hue, vec3(1.0), 0.35) * top * (1.2 + 2.2 * uHit.x) * (0.3 + v);

  // The peak cap: a hairline that hangs above the bar.
  float capY = cap * room;
  float capLine = exp(-pow((yy - capY - 3.0) / 1.2, 2.0)) * step(abs(dx), halfW) * step(hgt + 4.0, capY + 3.0);
  vec3 capCol = mix(hue, vec3(1.0), 0.6) * capLine * 1.4 * P_PEAKS;

  if (strip) {
    // Transparent, over the blurred artwork: the bars and their caps and
    // nothing else. The alpha is the bar's own coverage.
    vec3 c = body * cover + capCol;
    float a = max(cover * 0.92, clamp(capLine * P_PEAKS, 0.0, 1.0));
    emitA(c * uEnergy, a);
    return;
  }

  // --- the room ---------------------------------------------------------------
  vec2 p = fragP();
  float horizon = base / uRes.y;
  // Haze above the floor, lit by the whole spectrum; a darker floor below.
  float lowE = uBandA.x + uBandA.y;
  vec3 col = uPalBg.rgb * (0.9 + 0.4 * uv.y);
  float hz = exp(-abs(uv.y - horizon) * 7.0);
  col += mix(uPalLow.rgb, uPalMid.rgb, uv.x) * hz * (0.05 + 0.1 * uMood.y + 0.12 * uHit.x * lowE);
  col += body * cover + capCol;

  // The reflection: the bars upside down in a dark polished floor, fading and
  // softening with depth.
  if (y < 0.0 && !banked) {
    float ry = -y;
    float rv = shape(vS, f) * room;
    vec2 rq = vec2(dx, ry - rv * 0.5);
    float rsd = sdRound2(rq, vec2(halfW, rv * 0.5), radius);
    float rcov = clamp(0.5 - rsd / (1.0 + ry * 0.03), 0.0, 1.0);
    float fade = exp(-ry / (uRes.y * 0.09)) * 0.3 * P_REFLECT;
    col += hue * (0.3 + 0.8 * v) * rcov * fade;
    // The floor line itself, catching the light on each kick.
    col += mix(uPalMid.rgb, uPalHigh.rgb, 0.5) * exp(-ry / 1.5) * (0.25 + 0.9 * uHit.x) * 0.6;
  }
  col += (uPalHigh.rgb * 0.25) * uHit2.w;
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ preset, state, flash }) {
    // Three slow zone gains: each zone brought to the same working level, so
    // the bass keeps its own life instead of sitting under the mids.
    const zone = [0.2, 0.2, 0.2];
    let drop = -1e9;
    const ceiling = Math.max(24, preset.bars || 64);
    return {
      step(dt, m, c) {
        const s = c.spec;
        if (s) {
          const n = s.length;
          const sums = [0, 0, 0];
          const cnt = [0, 0, 0];
          for (let i = 0; i < n; i++) {
            const z = i < n / 3 ? 0 : i < (2 * n) / 3 ? 1 : 2;
            sums[z] += s[i];
            cnt[z]++;
          }
          for (let z = 0; z < 3; z++) {
            const mean = cnt[z] ? sums[z] / cnt[z] : 0;
            zone[z] = m.ease(zone[z], mean, 2, dt);
            state[z] = 0.62 / Math.max(0.1, zone[z]);
          }
        }
        // As many bars as the frame has room for — one per ~14 px of a 16:9
        // frame's width — under the tier's ceiling.
        const aspect = c.aspect || 16 / 9;
        state[3] = Math.round(Math.min(ceiling, Math.max(24, aspect * 36)));
        if (m.stamp.drop !== drop) {
          drop = m.stamp.drop;
          flash(0.5);
        }
      },
    };
  },
};
