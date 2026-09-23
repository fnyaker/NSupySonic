// PULSATIONS — a basin of light.
//
// The mode that shows "colours on the beat", rebuilt as one physical idea
// instead of four overlaid ones: a dark pool of liquid light. Every beat drops
// a ripple into it; the ripple REFRACTS what is underneath — the slow currents
// of the pool, the lobes of light — so a beat is seen as the whole picture
// bending rather than as a ring drawn on top of it. That bending is what the
// old canvas version could never do (a canvas stroke is paint, not a lens), and
// it is most of why this reads as water rather than as a diagram.
//
// What is in the pool:
//
//   THE CURRENTS. A domain-warped field, lit from above, drifting at a pace
//   counted in bars. Its thin bright folds are the caustics a real pool throws
//   on its floor.
//   THE LOBES. Six soft bodies of light, one per energy band — sub, bass, low
//   mids, mids, highs, air — orbiting the artwork (or the centre) on the
//   frame's own polar mapping, so they sit around the cover in the player and
//   spread across a beamer. Each one's size and heat is its band; they merge
//   like metaballs where they meet.
//   THE RIPPLES. One per beat, a wider one on the downbeat, a sharper, faster
//   shock on each MAIN kick, and a slow tidal ring at the drop. They start at
//   the artwork's rim and travel at a speed counted in beats.
//
// Parameters (the skin may override any of them):
//   lobes   brightness of the band lobes          ripple  refraction strength
//   crest   brightness of the ripple crests       caustic caustic-line strength
//   spin    lobe orbit, turns per 8 bars (signed)

export default {
  id: "pulse",
  uses: ["noise", "caustic"],
  params: { lobes: 1, ripple: 1, crest: 1, caustic: 1, spin: 1 },
  look: { exposure: 1.05, bloom: 1.1, threshold: 0.75, saturation: 1.15 },

  fragment: `
// The ring's life, in beats, by kind: 0 beat, 1 main kick, 2 downbeat, 3 drop.
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

  // --- the ripples: a displacement field and a crest --------------------------
  float rc = ringCoord(p);
  vec2 dir = (p - uHole.xy) / max(length(p - uHole.xy), 1e-4);
  vec2 disp = vec2(0.0);
  float crest = 0.0;
  float crestHot = 0.0;
  for (int i = 0; i < 8; i++) {
    vec4 e = uEv[i];
    float age = uClock.x - e.x;
    float kind = e.z;
    float life = lifeOf(kind);
    if (e.y <= 0.0 || age < 0.0 || age > life) continue;
    float R = age * speedOf(kind);
    float w = (kind > 0.5 && kind < 1.5 ? 0.016 : 0.03) + age * 0.01;
    float d = rc - R;
    float prof = exp(-d * d / (w * w));
    float fade = 1.0 - age / life;
    fade *= fade * e.y;
    // The derivative of the ring's profile is what bends the light: the
    // surface slopes up on the inside of the crest and down on the outside.
    disp += dir * (-2.0 * d / (w * w)) * prof * fade * w * 0.13 * P_RIPPLE * amp;
    // The crest itself is a GLINT — the sharp top of the profile, where the
    // surface catches the light — not the whole swell, which is already
    // visible through what it bends.
    float glint = prof * prof * prof * prof;
    // Beat ripples are seen through what they bend; only the kick's shock
    // and the downbeat's wave carry a visible glint.
    crest += glint * fade * (kind < 0.5 ? 0.25 : 1.0);
    crestHot += glint * fade * step(0.5, kind) * step(kind, 1.5);
  }
  vec2 q = p + disp;

  // --- the lobes: six lights hovering over the pool, one per band -------------
  float bands[6];
  bands[0] = uBandA.x; bands[1] = uBandA.y; bands[2] = uBandA.z;
  bands[3] = uBandA.w; bands[4] = uBandB.x; bands[5] = uBandB.y;
  float spin = bars * TAU / 8.0 * P_SPIN;
  float swell = 1.0 + 0.35 * uHit.y * amp;
  vec3 tintSum = vec3(0.0);
  vec3 wideSum = vec3(0.0);
  float field = 0.0;
  float wideField = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float b = bands[i];
    float a = spin + fi * TAU / 6.0 + 0.3 * sin(bars * 0.5 + fi * 1.7);
    float rr = 0.3 + 0.14 * sin(bars * 0.37 + fi * 2.3) + b * 0.16;
    vec2 c = place(a, rr);
    vec2 da = vec2(cos(a), sin(a));
    float room = frameEdge(da) - holeEdge(da);
    float size = (0.05 + 0.13 * b) * max(room, 0.4) * swell;
    float dist = length(q - c);
    float k = b * (0.4 + 0.6 * b);
    vec3 hue = pal(fi / 5.0);
    float g = glow(dist, size);
    float gw = glow(dist, size * 2.4);
    field += g * g * k;
    tintSum += hue * g * g * k;
    wideField += gw * k;
    wideSum += hue * gw * k;
  }
  vec3 tint = tintSum / max(field, 1e-4);
  vec3 wideTint = wideSum / max(wideField, 1e-4);

  // --- the pool ---------------------------------------------------------------
  // Deep water: the palette's own black, with currents so slow and so low in
  // contrast that they are felt more than seen.
  float n = fbm(q * 0.7 + vec2(bars * 0.02, -bars * 0.013), 3);
  vec3 col = uPalBg.rgb * (0.65 + 0.7 * smoothstep(-0.45, 0.45, n));
  // The floor, lit by the lobes through the rippled surface. The caustics are
  // multiplied by that light: they exist only where a lobe shines, which is
  // exactly where a real pool has them.
  float ca = caustics(q * 0.9 + vec2(0.0, bars * 0.02), bars * 1.4);
  float illum = wideField * wideField * (0.5 + 0.5 * uMood.y);
  col += wideTint * illum * (0.06 + 1.1 * ca * P_CAUSTIC) * uEnergy;
  // The lobes themselves: a body and a hot core, merged like metaballs where
  // two meet.
  float body = smoothstep(0.02, 0.9, field);
  col += tint * body * (0.35 + 0.6 * uMood.y) * P_LOBES * uEnergy;
  col += mix(tint, vec3(1.0), 0.25) * pow(body, 4.0) * (0.9 + 1.6 * uHit.y) * P_LOBES * uEnergy;

  // --- the crests ------------------------------------------------------------------
  vec3 cc = mix(uPalMid.rgb, uPalHigh.rgb, 0.7);
  col += cc * crest * (0.22 + 0.3 * uFlow.x) * P_CREST * uEnergy;
  col += mix(uPalHigh.rgb, vec3(1.0), 0.3) * crestHot * 0.6 * P_CREST * uEnergy;

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
