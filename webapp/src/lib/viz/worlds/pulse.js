// PULSATIONS — a mesh gradient under liquid glass.
//
// The mode that shows "colours on the beat" to everyone who never opens
// Réglages, so it has to be the most finished picture in the catalogue rather
// than the safest one. It used to be a pool: caustic folds lit by six lobes,
// rings travelling out on every beat. On screen the caustics won — a purple web
// over the whole frame — and the replacement, six broad soft fields, turned into
// a blurred blob: a wash with a faint circle on it.
//
// What it is now is a MESH GRADIENT under a sheet of glass:
//
//   THE FIELDS. Six colour fields, one per energy band — sub, bass, low mids,
//   mids, highs, air — at UNEVEN angles and radii on the frame's own polar
//   mapping, so the frame carries several independent colour regions instead of
//   one central donut. Each field is a compact, wavy patch with a real edge and
//   a g³ weight: two fields meeting hand over over a readable distance without
//   dissolving into fog. Hue and value are blended separately — the fields'
//   palette colours by weight, then a value ramp (the palette's low end deep,
//   its high end light) by the same weights — because folding the ramp into the
//   colour let the brightest field eat the dark ones. A slow domain warp,
//   counted in bars, folds the mesh like dye. The floor is only the deep
//   palette between the fields, never a sheet of paint under them: a broad
//   constant floor is exactly what turns a mesh into a wash.
//   THE GLASS. The fields are also a HEIGHT. Each is a dome, not a plateau, and
//   their summed height plus three slow standing waves gives a normal per
//   pixel. One key light from above-left shades the sheet; the domes are what a
//   person reads as folds in a thick material, and the broad light/dark bands
//   across the frame are the standing waves. One softbox reflection at
//   upper-left is the only specular in the picture — no rim, no specular stripe
//   down an edge. On a main kick the reflection swells and slides, which is the
//   clean highlight answering the beat.
//   THE RIPPLE. Every beat, every main kick and the drop send a ring out from
//   the artwork's rim at a speed counted in beats. The ring is not an outline
//   and it does not displace the colour: both drew their seam as a glass rim.
//   It is a broad, lobed crest — a band with a soft peak and a long tail,
//   broken into arcs by two slow angular terms so it never closes into a hoop —
//   that brightens the mesh where it passes and is tinted by the fields, never
//   white. A main kick's crest is stronger and faster than a beat's, and on a
//   beat that is also a main kick only the kick's crest is pushed.
//   THE EDGE. A shallow darkening in the outer few percent of the frame gives
//   the sheet an edge without becoming the vignette the post pass refuses; the
//   picture still runs to all four sides of a beamer.
//
// No chromatic fringe: `ca: 0`. Thin light with a permanent red/cyan split is
// the cheapest effect there is, and this world's colour is entirely in its
// fields.
//
// Parameters (the skin may override any of them):
//   lobes   brightness of the colour fields       ripple   wave strength
//   crest   the glass highlight and the wave      caustic  the folded surface
//   spin    field orbit, turns per 8 bars (signed)

export default {
  id: "pulse",
  uses: ["noise"],
  params: { lobes: 1, ripple: 1, crest: 1, caustic: 1, spin: 1 },
  look: { exposure: 1.02, bloom: 0.60, threshold: 0.88, saturation: 1.18, ca: 0 },

  fragment: `
// The ripple's life, in beats, by kind: 0 beat, 1 main kick, 2 downbeat, 3 drop.
float lifeOf(float k) { return k < 0.5 ? 2.0 : k < 1.5 ? 1.35 : k < 2.5 ? 2.6 : 3.2; }
float speedOf(float k) { return k < 0.5 ? 0.46 : k < 1.5 ? 0.90 : k < 2.5 ? 0.36 : 0.42; }
float widthOf(float k) { return k < 0.5 ? 0.060 : k < 1.5 ? 0.045 : k < 2.5 ? 0.070 : 0.080; }
float weightOf(float k) { return k < 0.5 ? 0.55 : k < 1.5 ? 1.00 : k < 2.5 ? 0.90 : 1.60; }

// Place a point on the frame's polar mapping (radial01's inverse): angle a,
// radial r (0 = the artwork's rim, 1 = the frame's edge).
vec2 place(float a, float r) {
  vec2 dir = vec2(cos(a), sin(a));
  float lo = holeEdge(dir);
  float hi = frameEdge(dir);
  return dir * (lo + (hi - lo) * r);
}

void main() {
  vec2 p = fragP();
  vec2 away = p - uHole.xy;
  float bars = uClock.y * uSpeed;
  float amp = 0.55 + 0.45 * uCtl.x;

  // --- the wave: a broad, tinted swell, with no outline -----------------------
  float rc = ringCoord(p);
  float ang = atan(away.y, away.x);
  float wave = 0.0;
  for (int i = 0; i < 8; i++) {
    vec4 e = uEv[i];
    float age = uClock.x - e.x;
    float kind = e.z;
    float life = lifeOf(kind);
    if (e.y <= 0.0 || age < 0.0 || age > life) continue;
    float R = age * speedOf(kind);
    // The crest is not a perfect circle: a sheet of glass is never a pond, and
    // an exact ring reads as a drawn outline. Two slow angular terms make the
    // wave organic and let it pass through the colour fields instead of
    // circling the artwork.
    float wob = 0.030 * sin(ang * 3.0 + bars * 0.8 + kind)
              + 0.018 * sin(ang * 5.0 - bars * 0.55 + kind * 2.0);
    // A ring travelling out spreads in the frame's own units, so its width is
    // kept in those units too and widened with the radius by a hair: a crest
    // converging at the rim must not become a sub-pixel line.
    float w = widthOf(kind) + age * 0.008;
    w = max(w, uFrame.w * 3.0);
    float d = rc - (R + wob * (0.4 + 0.6 * smoothstep(0.0, 0.6, R)));
    // A broad, soft crest with a long tail on both sides. The flat-top band
    // read as a drawn hoop; the narrow Gaussian read as a faint halo. This is
    // the middle: one band of light with a visible peak and no hard edge.
    float band = exp(-pow(abs(d) / w, 1.35));
    // The crest is not equally bright all the way round: a wave passing
    // through six colour fields is stronger where it crosses one. Two slow
    // angular lobes break the closed hoop without drawing a ring.
    float lobes = 0.45 + 0.30 * sin(ang * 2.0 + bars * 0.35)
                       + 0.25 * sin(ang * 3.0 - bars * 0.50 + kind);
    float fade = 1.0 - age / life;
    fade *= fade * e.y * weightOf(kind);
    wave += band * lobes * fade * P_RIPPLE * amp;
  }
  // The colour sits behind the glass and is not displaced: a radial shift of
  // the field boundaries draws their edge as a ring, which is the glass rim
  // this world must not have. The kick is carried by the wave and the specular.
  vec2 q = p;

  // --- the fields: a mesh gradient, one field per band -------------------------
  vec2 wq = q * 0.72;
  vec2 warp = vec2(
    fbm(wq + vec2(bars * 0.055, 1.7), 3),
    fbm(wq + vec2(-3.1, -bars * 0.043), 3)
  );
  // The warp is the fold in the sheet: it moves the fields' domain far enough
  // to see the bands bending, and its own value is a fine marbling in the
  // light, so the surface has texture without a second noise field.
  vec2 r = q + warp * 0.26;
  float marbling = warp.x * 0.62 + warp.y * 0.38;

  float bands[6];
  bands[0] = uBandA.x; bands[1] = uBandA.y; bands[2] = uBandA.z;
  bands[3] = uBandA.w; bands[4] = uBandB.x; bands[5] = uBandB.y;
  float spin = bars * TAU / 8.0 * P_SPIN;
  // The drop opens the sheet: the fields swell and the mesh takes the frame.
  float swell = 1.0 + 0.45 * uHit.y * amp + 0.38 * smoothstep(0.0, 0.45, uArc.x);
  // The floor is only the colour between the fields, not a sheet of paint
  // under them. A broad constant floor is what turns a mesh into a wash: the
  // fields own their regions, and the floor is the deep palette showing in the
  // creases between them.
  vec3 floorC = mix(uPalLow.rgb, uPalHigh.rgb, 0.42) * 0.85;
  vec3 acc = vec3(0.0);
  float valAcc = 0.0;
  float wsum = 0.0;
  float hsum = 0.0;
  vec2 gradH = vec2(0.0);
  // Six fields at deliberately UNEVEN angles and radii: an even ring of six is
  // a donut, and a donut at 45 % render scale collapses to one blurred mass.
  // Uneven positions give the frame several independent colour regions to lose
  // before it becomes a wash.
  float baseA[6];
  baseA[0] = 0.10; baseA[1] = 1.15; baseA[2] = 2.25;
  baseA[3] = 3.35; baseA[4] = 4.45; baseA[5] = 5.55;
  float baseR[6];
  baseR[0] = 0.18; baseR[1] = 0.55; baseR[2] = 0.30;
  baseR[3] = 0.65; baseR[4] = 0.22; baseR[5] = 0.48;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float b = bands[i];
    float a = spin + baseA[i] + 0.22 * sin(bars * 0.43 + fi * 1.7);
    float rr = baseR[i] + 0.06 * sin(bars * 0.31 + fi * 2.3) + b * 0.06;
    vec2 c = place(a, rr);
    vec2 da = vec2(cos(a), sin(a));
    float room = frameEdge(da) - holeEdge(da);
    float size = (0.28 + 0.20 * b) * max(room, 0.80) * swell;
    vec2 dd = (r - c) / size;
    // A compact, wavy field: it has a real EDGE, so at the 45 % scale the
    // governor picks under SwiftShader two fields meeting are still two
    // colours. A Gaussian this wide has no edge at all, and that is precisely
    // what reads as a blurred blob.
    dd = rot(0.55 * sin(bars * 0.27 + fi * 1.8)) * dd;
    float dist = length(dd);
    float ed = atan(dd.y, dd.x);
    dist *= 1.0 + 0.14 * sin(ed * 3.0 + bars * 0.50 + fi * 1.7)
                + 0.08 * sin(ed * 5.0 - bars * 0.40 + fi * 2.1);
    float g = smoothstep(1.0, 0.42, dist);
    // Squared: the field owns its centre and hands over over a short distance.
    // The band only leans the weight — every field must stay visible, or the
    // mesh loses a region and reads as a blur with holes.
    float wgt = g * g * g * (0.75 + 0.85 * b);
    // Hue and value are blended SEPARATELY. Folding the value ramp into the
    // colour let the brightest field win the normalised mix and eat the dark
    // ones; split, the palette colour keeps its weight and the value ramp
    // survives as its own field. The ramp is deliberately wide: a mesh whose
    // fields all sit at the same lightness is a blur, whatever their hues.
    acc += pal(fi / 5.0) * wgt;
    valAcc += (0.18 + 1.55 * fi / 5.0) * wgt;
    wsum += wgt;
    // The height is a DOME, not a plateau: each field is a thick lens whose
    // middle stands proud of its rim. The colour weight g has a flat core; the
    // height does not, so the key light gives the field a volume instead of a
    // flat patch with a hard edge.
    float dome = max(0.0, 1.0 - dist * dist);
    hsum += dome * (0.85 + 0.40 * b);
    gradH += (-2.0 * dd / size) * dome * (0.85 + 0.40 * b);
  }
  // The floor weight is small on purpose: the fields own the picture.
  float floorW = 0.09 + 0.04 * (1.0 - smoothstep(0.0, 0.9, hsum));
  float coreH = 1.0 - exp(-hsum * 1.35);
  acc += floorC * floorW;
  valAcc += 0.62 * floorW;
  wsum += floorW;
  hsum += floorW * 0.8;
  vec3 mesh = acc / max(wsum, 1e-4);
  float meshVal = valAcc / max(wsum, 1e-4);
  float height = 1.0 - exp(-hsum * 1.35);

  // The colour is the mesh, not a wash over it. The whole sheet swells on a
  // main kick before the wave is added: that is the kick seen as light, not as
  // a ring.
  vec3 col = mesh * meshVal * (0.90 + 0.20 * uMood.y + 0.25 * uHit.y) * P_LOBES;
  col *= 0.82 + 0.18 * coreH;
  col += mix(uPalBg.rgb, uPalLow.rgb, 0.5) * 0.05;
  // The marbling is the visible grain of the sheet, not a texture on top of it.
  col *= 0.90 + 0.20 * marbling * P_CAUSTIC;

  // --- the glass, lit -----------------------------------------------------------
  // The glass has its own slow standing waves, independent of the beat: three
  // sines at different angles, drifting on the bar clock. Their slopes are the
  // visible structure of the material — the broad light and dark bands that say
  // the colour is UNDER something — and they cost three cosines.
  float wa = q.x * 5.6 + q.y * 2.4 + bars * 0.50;
  float wb = q.x * -1.9 + q.y * 6.8 - bars * 0.36;
  float wc = (q.x + q.y) * 4.2 + bars * 0.20;
  float waveH = sin(wa) * 0.55 + sin(wb) * 0.40 + sin(wc) * 0.30;
  vec2 waveG = 0.55 * cos(wa) * vec2(5.6, 2.4)
             + 0.40 * cos(wb) * vec2(-1.9, 6.8)
             + 0.30 * cos(wc) * vec2(4.2, 4.2);
  col *= 0.86 + 0.20 * waveH * P_CAUSTIC;
  // The normal comes from the fields' summed slope and the glass's own waves.
  // Ignoring the warp's derivative is deliberate: the warp is a slow fold and
  // its high-frequency slope would make the highlight crawl. What the eye reads
  // as a surface is the fields' hills under the standing waves.
  vec2 slant = gradH / max(hsum, 1e-3) * 0.52 + waveG * 0.090 * P_CAUSTIC;
  vec3 nrm = normalize(vec3(-slant * P_CREST * 1.6, 1.0));
  vec3 key = normalize(vec3(-0.42, 0.78, 0.62));
  float shade = clamp(dot(nrm, key), 0.0, 1.0);
  col *= 0.50 + 0.74 * shade;

  // ONE highlight: the reflection of a broad softbox on the glass, at upper
  // left. It is a single soft ellipse, not a streak down every edge, and its
  // brightness and size are the only thing the music does to it. Flat rather
  // than exponential, so it reads as a sheet of light on a curved pane and not
  // as a glowing dot.
  // The reflection slides a little on a main kick: the light source does not
  // move, the glass does. That is the clearest kick cue a single specular can
  // give without drawing a rim around the wave.
  vec2 hp = p - vec2(-0.62 * min(uFrame.z, 1.30) + 0.16 * uHit.y * amp,
                     0.54 - 0.10 * uHit.y * amp);
  hp = rot(-0.18) * hp;
  hp /= vec2(0.50 + 0.08 * uMood.y, 0.20 + 0.05 * uMood.y) * (1.0 + 0.24 * uHit.y * amp);
  float softbox = exp(-dot(hp, hp) * 3.4);
  float hot = softbox * softbox * softbox * softbox;
  float glint = (softbox * 0.42 + hot * 0.68) * (0.90 + 0.45 * uHit.y) * P_CREST;
  col += vec3(0.92, 0.96, 1.0) * glint * (0.30 + 0.70 * height);

  // A broad wave through the colour, tinted by it: the beat as a swell, not
  // as a ring drawn on top.
  col += (mesh * 0.55 + uPalHigh.rgb * 0.45) * wave * 0.95 * P_CREST;

  // A drop, and the flash the engine allowed.
  col += (uPalAcc.rgb * 0.22 + uPalHigh.rgb * 0.18) * uHit2.w;

  // The sheet's edge: a shallow darkening in the last two per cent of the
  // frame. It is not a vignette — the colour runs to the border and beyond —
  // it is the thickness of the glass catching the edge of the light.
  float edge = min(uFrame.z - abs(p.x), 1.0 - abs(p.y));
  col *= mix(0.55, 1.0, smoothstep(0.0, 0.10, edge));

  // The artwork is opaque: what is under it is ambience at most.
  col *= mix(0.30, 1.0, clearOfHole(p, 0.02));
  emit(col);
}
`,

  create({ ev, flash }) {
    let head = 0;
    let beat = -1e9;
    let main = -1e9;
    let drop = -1e9;
    function push(at, power, kind) {
      const i = head * 4;
      ev[i] = at;
      ev[i + 1] = power;
      ev[i + 2] = kind;
      ev[i + 3] = 0;
      head = (head + 1) % 8;
    }
    return {
      step(dt, m) {
        const s = m.stamp;
        // The kick is the ripple. On a beat that is also a main kick — every
        // beat of a drop — pushing a second ring as well drew a pond: two
        // crests of different speeds from one hit. The beat keeps its own
        // ripple only where the kick is silent (a breakdown, a build).
        if (s.main !== main) {
          main = s.main;
          push(s.main, 0.72 + 0.70 * Math.min(1, m.mainPower || m.kick), 1);
        }
        if (s.beat !== beat) {
          beat = s.beat;
          if (s.beat !== main) {
            push(s.beat, (s.bar === s.beat ? 0.9 : 0.38) + 0.30 * m.drive, s.bar === s.beat ? 2 : 0);
          }
        }
        if (s.drop !== drop) {
          drop = s.drop;
          push(s.drop, 1.25, 3);
          flash(0.85);
        }
      },
    };
  },
};
