// PULSATIONS — colour that breathes, under a sheet of liquid glass.
//
// The mode that shows "colours on the beat". It used to be a pool: caustic
// folds lit by six lobes, rings travelling out on every beat. On screen the
// caustics won — a purple web over the whole frame, rings with a coloured
// fringe on top — and it read as a media-player plug-in from twenty years ago.
// What colour-on-the-beat looks like now is a MESH GRADIENT: a few large,
// soft fields of colour that drift into one another, and a surface over them
// that the music bends.
//
//   THE FIELDS. Six of them, one per energy band — sub, bass, low mids, mids,
//   highs, air — each a broad Gaussian of its palette colour, orbiting the
//   artwork (or the centre) on the frame's own polar mapping, so they sit
//   around the cover in the player and spread across a beamer. They BLEND by
//   weight (the colour where two meet is between theirs, as in a mesh
//   gradient) instead of adding up to white; a band's level is how much light
//   its field gives, and the domain they live in is warped slowly, counted in
//   bars, so the edges drift like dye in water.
//   THE GLASS. One ripple per beat, a wider one on the downbeat, a sharper,
//   faster one on each MAIN kick and a slow tide at the drop, starting at the
//   artwork's rim and travelling at a speed counted in beats. A ripple is not
//   a ring drawn on top: it REFRACTS the colour under it, shades like a lens
//   (lighter on its inner slope, darker on its outer one) and catches one
//   highlight on the side facing the light — which is what makes it read as
//   glass rather than as paint.
//   THE SHEEN. The warped surface's own gentle highlight, a slow satin that
//   says the fields are under something.
//
// Parameters (the skin may override any of them):
//   lobes   brightness of the colour fields       ripple   refraction strength
//   crest   the glass highlight and lens shading  caustic  the sheen
//   spin    field orbit, turns per 8 bars (signed)

export default {
  id: "pulse",
  uses: ["noise"],
  params: { lobes: 1, ripple: 1, crest: 1, caustic: 1, spin: 1 },
  // No lens fringe: the glass is the surface, and a coloured split along every
  // edge is the one thing that made the old pool look cheap.
  look: { exposure: 1.02, bloom: 0.75, threshold: 0.85, saturation: 1.1, ca: 0 },

  fragment: `
// The ripple's life, in beats, by kind: 0 beat, 1 main kick, 2 downbeat, 3 drop.
float lifeOf(float k) { return k < 0.5 ? 2.4 : k < 1.5 ? 1.6 : k < 2.5 ? 3.2 : 7.0; }
float speedOf(float k) { return k < 0.5 ? 0.36 : k < 1.5 ? 0.7 : k < 2.5 ? 0.3 : 0.2; }

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
  float bars = uClock.y * uSpeed;
  float amp = 0.55 + 0.45 * uCtl.x;

  // --- the glass: a displacement field, and the lens's shading ----------------
  float rc = ringCoord(p);
  vec2 dir = (p - uHole.xy) / max(length(p - uHole.xy), 1e-4);
  vec2 disp = vec2(0.0);
  float shade = 0.0;
  float glint = 0.0;
  // The light comes from above and a little to the left.
  float facing = 0.5 + 0.5 * dot(dir, normalize(vec2(-0.45, 1.0)));
  for (int i = 0; i < 8; i++) {
    vec4 e = uEv[i];
    float age = uClock.x - e.x;
    float kind = e.z;
    float life = lifeOf(kind);
    if (e.y <= 0.0 || age < 0.0 || age > life) continue;
    float R = age * speedOf(kind);
    float w = (kind > 0.5 && kind < 1.5 ? 0.028 : 0.05) + age * 0.018;
    float d = rc - R;
    float prof = exp(-d * d / (w * w));
    float fade = 1.0 - age / life;
    fade *= fade * e.y;
    // The derivative of the ring's profile is what bends the light: the
    // surface slopes up on the inside of the crest and down on the outside.
    float slope = (-2.0 * d / (w * w)) * prof * w;
    disp += dir * slope * fade * 0.16 * P_RIPPLE * amp;
    // A lens is lighter where it faces the light and darker where it turns
    // away: the slope, signed, is exactly that.
    shade += slope * fade * (kind < 0.5 ? 0.35 : 0.8);
    glint += pow(prof, 6.0) * fade * facing * facing * (kind < 0.5 ? 0.3 : 1.0);
  }
  vec2 q = p + disp;

  // --- the fields: a mesh gradient, one field per band --------------------------
  vec2 wq = q * 0.55;
  vec2 warp = vec2(fbm(wq + vec2(bars * 0.05, 1.7), 3), fbm(wq + vec2(-3.1, -bars * 0.04), 3));
  vec2 r = q + warp * 0.6;
  float bands[6];
  bands[0] = uBandA.x; bands[1] = uBandA.y; bands[2] = uBandA.z;
  bands[3] = uBandA.w; bands[4] = uBandB.x; bands[5] = uBandB.y;
  float spin = bars * TAU / 8.0 * P_SPIN;
  float swell = 1.0 + 0.18 * uHit.y * amp;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  float light = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float b = bands[i];
    float a = spin + fi * TAU / 6.0 + 0.35 * sin(bars * 0.5 + fi * 1.7);
    float rr = 0.32 + 0.2 * sin(bars * 0.37 + fi * 2.3) + b * 0.12;
    vec2 c = place(a, rr);
    vec2 da = vec2(cos(a), sin(a));
    float room = frameEdge(da) - holeEdge(da);
    float size = (0.17 + 0.26 * b) * max(room, 0.5) * swell;
    vec2 dd = (r - c) / size;
    float g = exp(-dot(dd, dd));
    float wgt = g * (0.2 + b);
    acc += pal(fi / 5.0) * wgt;
    wsum += wgt;
    light += g * b * (0.35 + b);
  }
  vec3 mesh = acc / max(wsum, 1e-4);
  float lit = 1.0 - exp(-light * 1.8);

  // Deep water under it all: the palette's own black, never quite flat.
  vec3 col = uPalBg.rgb * (0.55 + 0.45 * smoothstep(-0.5, 0.5, warp.x));
  vec3 bright = mesh * (0.4 + 0.7 * uMood.y + 0.3 * uHit.y) * P_LOBES;
  col = mix(col, bright, lit * uEnergy);
  // The sheen: a slow satin across the warped surface, where the fields are.
  float sat = smoothstep(0.18, 0.55, warp.x - warp.y * 0.6);
  col += mix(mesh, vec3(1.0), 0.4) * sat * lit * 0.12 * P_CAUSTIC;

  // --- the glass, lit ------------------------------------------------------------
  col *= 1.0 + clamp(shade, -1.0, 1.0) * 0.45 * P_CREST;
  col += mix(mesh, vec3(1.0), 0.6) * glint * (0.35 + 0.35 * uFlow.x) * P_CREST * uEnergy;

  // A drop, and the flash the engine allowed.
  col += (uPalAcc.rgb * 0.3 + uPalHigh.rgb * 0.2) * uHit2.w;
  // The artwork is opaque: what is under it is ambience at most.
  col *= mix(0.3, 1.0, clearOfHole(p, 0.08));
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
        if (s.beat !== beat) {
          beat = s.beat;
          push(s.beat, 0.55 + 0.45 * m.drive, s.bar === s.beat ? 2 : 0);
        }
        if (s.main !== main) {
          main = s.main;
          push(s.main, 0.45 + 0.75 * Math.min(1, m.mainPower || m.kick), 1);
        }
        if (s.drop !== drop) {
          drop = s.drop;
          push(s.drop, 1.5, 3);
          flash(0.85);
        }
      },
    };
  },
};
