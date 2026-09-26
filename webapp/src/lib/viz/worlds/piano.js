// PIANO — a keyboard of light, with the melody rising above it.
//
// Piano music, drawn the way piano performances are shown everywhere: a
// keyboard across the bottom of the frame and the notes as bars of light over
// the keys that play them — here rising away from the keys, a piano roll of
// what has just been played. (It was written for frenchcore's piano leads and
// keeps a kick response for whatever drums a piano record has; frenchcore
// itself now has the Chladni plate, cymatics.js, which moves the way a
// 200 BPM kick does.)
//
//   THE NOTES are read from the music, not invented. The spectrum is 120
//   log-spaced bands over 22 Hz-18 kHz — about one per semitone — so every
//   key has a band, and a key is SOUNDING when its band is a peak: the
//   local maximum a semitone either side, and clearly above the bands two
//   and a half semitones out — a tonal peak, not a level. A drum is broadband and stands above nothing; a held lead is a
//   peak and lights its key, with its octave and fifth faintly as its
//   partials do. The roll is the same test run on the spectrum HISTORY (one
//   row per sixteenth note, four bars of it), scrolled by the fraction of the
//   sixteenth so it glides rather than steps.
//   THE KEYBOARD fills the width — four octaves on a wide frame, two on a
//   phone — ivory and lacquer, each pressed key sunk and lit from inside in
//   its note's colour, the felt line above the keys carrying light, and the
//   piano's black lacquer under them mirroring it all.
//   THE KICK makes the whole instrument pound: the keyboard drops a hair on
//   every main kick, a pulse runs out along the felt from the middle, the
//   haze over the keys swells and the bars flare. A drop is a glissando —
//   a wave of light up the whole keyboard in one beat — and a flash.
//   THE BREAKDOWN is where frenchcore goes back to the piano: the drums out,
//   the haze settles and the melody is the only light left.
//
// On a phone the keyboard sits under the artwork, the notes rise behind it
// and come out above it — the roll is continuous, the cover just stands in
// front of part of it.
//
// Parameters:
//   roll     how bright the rising notes are      haze   the glow over the keys
//   sparkle  sparks off the pressed keys          gliss  the drop's glissando
//   octaves  0 = from the frame's width, else that many

const SPARKS = 180;

export default {
  id: "piano",
  uses: ["sdf", "noise"],
  params: { roll: 1, haze: 1, sparkle: 1, gliss: 1, octaves: 0 },
  look: { exposure: 1.0, bloom: 1.25, threshold: 0.72, saturation: 1.15 },

  fragment: `
const float WHITE[7] = float[7](0.0, 2.0, 4.0, 5.0, 7.0, 9.0, 11.0);
// One semitone, in the spectrum texture's u.
#define SEMI 0.008625

bool wideL() { return uFrame.z >= 0.95; }
float octaves() {
  if (P_OCTAVES > 0.5) return floor(P_OCTAVES + 0.5);
  return clamp(floor(2.0 * uFrame.z / 0.84 + 0.5), 2.0, 5.0);
}
float startNote(float oct) { return 60.0 - 12.0 * floor((oct - 1.0) / 2.0); }
// The keyboard: top of the keys, bottom of the keys (above the lacquer).
vec2 keyBand() {
  return wideL() ? vec2(-0.47, -0.82) : vec2(-0.7, -0.93);
}

// Where a MIDI note lives in the 128-texel spectrum texture: 120 log bands
// over 22 Hz..18 kHz, resampled onto 128 texels by the engine.
float noteU(float midi) {
  float f = 440.0 * exp2((midi - 69.0) / 12.0);
  float b = 120.0 * log2(f / 22.0) / log2(18000.0 / 22.0) - 0.5;
  return (b * 127.0 / 119.0 + 0.5) / 128.0;
}
float histAt(float u, float row) {
  return texture(uHist, vec2(u, fract(uHistHead - clamp(row, 0.0, 62.5) / 64.0))).r;
}
// Is this note sounding: its band a PEAK, not merely loud. Two tests, both
// needed. It must stand clearly above the bands two and a half semitones out
// (a drum is broadband and stands above nothing), and it must be the local
// maximum against its neighbours a semitone either side, within a hair —
// the analyser's main lobe spreads a partial a semitone or more either way,
// so without that second test one peak lit the key AND its neighbour, and
// the neighbour's half-lit flicker striped the bar beside it.
float peakAct(float v, float l1, float r1, float l2, float r2) {
  float top = smoothstep(-0.012, 0.01, v - max(l1, r1));
  float prom = smoothstep(0.01, 0.06, v - 0.5 * (l2 + r2));
  return top * prom * smoothstep(0.1, 0.3, v);
}
float noteAct(float midi, float row) {
  float u = noteU(midi);
  return peakAct(histAt(u, row), histAt(u - SEMI, row), histAt(u + SEMI, row),
                 histAt(u - 2.5 * SEMI, row), histAt(u + 2.5 * SEMI, row));
}
// ...and right now, from the live spectrum.
float specAt(float u) { return texture(uSpec, vec2(u, 0.25)).r; }
float noteNow(float midi) {
  float u = noteU(midi);
  return peakAct(specAt(u), specAt(u - SEMI), specAt(u + SEMI), specAt(u - 2.5 * SEMI), specAt(u + 2.5 * SEMI));
}
// A note's colour: the palette walked round the octave, so a scale is a
// gradient and a leap is a change of colour.
vec3 noteCol(float midi) {
  float pc = mod(midi, 12.0) / 12.0;
  return pal(0.5 + 0.5 * sin(pc * TAU + 0.4));
}

// One bar of the roll: a column over a key, lit where that note sounded.
vec3 rollBar(vec2 p, float cx, float hw, float midi, float row, float rowH, float px, inout float cover) {
  float dx = abs(p.x - cx);
  if (dx > hw * 2.5) return vec3(0.0);
  // The texture's own filtering carries a note across the rows it spans,
  // so a sixteenth is still a pill.
  float a = noteAct(midi, row);
  float on = smoothstep(0.2, 0.45, a);
  // The ends taper as the note fades in and out across its rows, so a bar
  // reads as a rounded pill rather than a cut rectangle.
  float hwE = hw * (0.45 + 0.55 * sqrt(on));
  float body = smoothstep(0.0, 0.2, on) * smoothstep(hwE + px, hwE - px, dx);
  // A lighter rim inside the bar's edges, like a lit tube.
  float rim = on * smoothstep(hwE - 3.0 * px, hwE - px, dx) * step(dx, hwE);
  vec3 c = noteCol(midi);
  float age = clamp(row / 63.0, 0.0, 1.0);
  float lv = mix(1.0, 0.38, age);
  // Freshly struck is hot: the young end of a bar runs toward white.
  float young = exp(-row / 3.0);
  vec3 col = mix(c, vec3(1.0), 0.35 * young) * body * (1.1 + 0.8 * young) * lv + mix(c, vec3(1.0), 0.55) * rim * 0.7 * lv;
  col += c * on * glow(max(dx - hw, 0.0), hw * 0.9) * 0.35 * lv;
  cover = max(cover, body);
  return col;
}

void main() {
  vec2 p = fragP();
  float A = uFrame.z;
  float px = uFrame.w;
  float amp = 0.6 + 0.4 * uCtl.x;
  float oct = octaves();
  float n0 = startNote(oct);
  float nWhite = 7.0 * oct;
  float wW = 2.0 * A / nWhite;
  vec2 kb = keyBand();
  // Every main kick drops the keyboard a hair, and it comes back.
  float bounce = 0.01 * uHit.y * amp;
  float kt = kb.x - bounce;
  float kbot = kb.y - bounce;
  float mainK = uHit.y * amp;
  float pump = 1.0 + 0.4 * mainK;

  // --- the room: a dark hall, a wash of stage light from above, and haze ---
  float h = p.y - kt;
  float barT = uClock.y * uSpeed;
  float smoke = fbm(vec2(p.x * 0.9 + barT * 0.05, p.y * 1.4 - barT * 0.11), 4);
  vec3 col = uPalBg.rgb * (0.4 + 0.3 * smoothstep(-1.0, 1.0, p.y));
  col += mix(uPalMid.rgb, uPalHigh.rgb, 0.5) * smoothstep(0.2, 1.2, p.y) * (0.035 + 0.02 * smoke) * P_HAZE;
  float rowH = (1.0 - kt) / 60.0;
  if (h > 0.0) {
    // THE HARMONY: the twelve pitch classes of what is playing now, as soft
    // columns of light over every key of the chord, in every octave. A chord
    // is a pattern across the keyboard and a change of chord redraws it — so
    // the room is lit by the harmony even where the melody is sparse. The
    // melody's own keys throw a brighter column. Summed over the nearest
    // keys, white and black alike, so nothing switches at a key's edge.
    float xi = (p.x + A) / wW;
    float fall = exp(-h / (0.7 + 0.4 * uArc.z));
    // Where the melody sits (the sustained energy's centre, log 60 Hz-4 kHz),
    // as a note: the harmony blooms around it rather than repeating the
    // chord as stripes across every octave.
    float melMidi = 69.0 + 12.0 * log2(60.0 * pow(4000.0 / 60.0, uBandB.z) / 440.0);
    vec3 lanes = vec3(0.0);
    vec3 beams = vec3(0.0);
    for (int k = -1; k <= 1; k++) {
      float wi = floor(xi) + float(k);
      if (wi < 0.0 || wi >= nWhite) continue;
      float mw = n0 + 12.0 * floor(wi / 7.0) + WHITE[int(mod(wi, 7.0))];
      float dw = xi - (wi + 0.5);
      float gw = exp(-dw * dw * 5.0);
      int pcw = int(mod(mw, 12.0));
      vec3 cw = noteCol(mw);
      float regW = 0.2 + 0.8 * exp(-pow((mw - melMidi) / 11.0, 2.0));
      lanes += cw * smoothstep(0.35, 0.9, clamp(uChroma[pcw / 4][pcw % 4], 0.0, 1.0)) * gw * regW;
      beams += cw * noteNow(mw) * gw;
      // The black key on this white key's right, if it has one.
      float lft = mod(wi, 7.0);
      if (lft != 2.0 && lft != 6.0 && wi < nWhite - 1.0) {
        float mb = mw + 1.0;
        float db = (xi - (wi + 1.0)) * 1.6;
        float gb = exp(-db * db * 5.0);
        int pcb = int(mod(mb, 12.0));
        vec3 cb = noteCol(mb);
        lanes += cb * smoothstep(0.35, 0.9, clamp(uChroma[pcb / 4][pcb % 4], 0.0, 1.0)) * gb * regW;
        beams += cb * noteNow(mb) * gb;
      }
    }
    // Carried by the smoke, so it reads as light in the air, not a pattern.
    col += lanes * (0.04 + 0.07 * fall) * (0.2 + 1.3 * smoke * smoke) * P_HAZE * pump;
    col += beams * fall * (0.14 + 0.1 * smoke) * P_HAZE * pump * (0.6 + 0.4 * uBandB.w);
    // The roll's grid: a faint line at every bar, rising with the notes.
    float barsUp = h / (16.0 * rowH) - fract(uPhase.y);
    float bard = abs(fract(barsUp + 0.5) - 0.5) * 16.0 * rowH;
    vec3 grid = mix(uPalMid.rgb, vec3(1.0), 0.3);
    col += grid * smoothstep(1.5 * px, 0.0, bard) * 0.045 * (1.0 - 0.6 * smoothstep(0.0, 1.4, h));
    col += mix(uPalLow.rgb, uPalMid.rgb, 0.5) * exp(-h / 0.3) * (0.05 + 0.03 * smoke) * pump * P_HAZE;
    // THE KICK: a band of pressure rising off the keyboard on every main
    // kick, across the whole width — the pound of a 200 BPM kick made
    // visible, going the same way the notes go.
    float wy = uSince.y * (0.75 + 0.35 * uFlow.x);
    float wd = h - wy;
    col += mix(uPalHigh.rgb, uPalAcc.rgb, 0.3) * exp(-wd * wd / 0.004) * envB(uSince.y, 0.7)
         * (0.06 + 0.06 * smoke) * amp * (1.0 - 0.8 * uArc.z);
  }

  // --- the roll ---
  if (h > 0.0) {
    float row = h / rowH - fract(uClock.x * 4.0);
    float xi = (p.x + A) / wW;
    float wi = floor(xi);
    float o = floor(wi / 7.0);
    float wmidi = n0 + 12.0 * o + WHITE[int(mod(wi, 7.0))];
    float cover = 0.0;
    vec3 bars = rollBar(p, -A + (wi + 0.5) * wW, 0.4 * wW, wmidi, row, rowH, px, cover);
    // The black key whose column is nearest, drawn over the white.
    float bIdx = floor(xi + 0.5);
    float left = mod(bIdx - 1.0, 7.0);
    if (left != 2.0 && left != 6.0 && bIdx > 0.5 && bIdx < nWhite - 0.5) {
      float lo = floor((bIdx - 1.0) / 7.0);
      float bmidi = n0 + 12.0 * lo + WHITE[int(left)] + 1.0;
      float c2 = 0.0;
      vec3 bb = rollBar(p, -A + bIdx * wW, 0.26 * wW, bmidi, row, rowH, px, c2);
      bars = bars * (1.0 - c2) + bb;
    }
    float melodyLift = 0.55 + 0.45 * smoothstep(0.1, 0.6, uBandB.w) + 0.25 * uArc.z;
    col += bars * P_ROLL * pump * melodyLift * clearOfHole(p, 0.04);
  }

  // --- the felt, and the pulse the kick sends along it ---
  float cx = uHole.z > 0.0 ? uHole.x : 0.0;
  float feltD = abs(p.y - (kt + 0.006));
  float run = abs(p.x - cx) - uSince.y * 2.2 * A;
  float pulse = exp(-run * run / 0.02) * envB(uSince.y, 0.6) * amp;
  vec3 felt = mix(uPalAcc.rgb, uPalHigh.rgb, 0.4);
  col += felt * smoothstep(0.006 + px, 0.006 - px, feltD) * (0.25 + 1.6 * pulse + 0.3 * uHit2.w);
  col += felt * glow(feltD, 0.02) * (0.05 + 0.5 * pulse);

  // --- the keys ---
  if (p.y < kt && p.y > kbot) {
    float kh = kt - kbot;
    float ky = (kt - p.y) / kh;      // 0 at the top of the keys, 1 at the front
    float xi = (p.x + A) / wW;
    float wi = floor(xi);
    float fx = fract(xi);
    float o = floor(wi / 7.0);
    float wmidi = n0 + 12.0 * o + WHITE[int(mod(wi, 7.0))];
    // The glissando: a wave up the keyboard over the beat after a drop.
    float gl = P_GLISS * step(uSince.w, 1.5) * exp(-pow((uSince.w * 1.1 - xi / nWhite) * 9.0, 2.0));
    float press = max(smoothstep(0.15, 0.45, noteNow(wmidi)), gl);
    int wpc = int(mod(wmidi, 12.0));
    float chordK = smoothstep(0.35, 0.9, clamp(uChroma[wpc / 4][wpc % 4], 0.0, 1.0));
    // Ivory: warm, shaded under the felt, a darker front lip, a hairline gap.
    vec3 ivory = mix(vec3(0.92, 0.9, 0.84), uPalHigh.rgb, 0.1);
    float shade = 0.72 + 0.28 * smoothstep(0.0, 0.25, ky);
    vec3 kc = ivory * shade * (1.0 - 0.12 * press);
    kc *= 1.0 - 0.35 * smoothstep(0.9, 0.93, ky + 0.03 * press);
    kc += noteCol(wmidi) * press * (0.9 + 0.5 * mainK) * smoothstep(1.0, 0.2, ky);
    kc += noteCol(wmidi) * chordK * 0.12 * smoothstep(0.6, 0.0, ky);
    float gap = min(fx, 1.0 - fx) * wW;
    kc *= smoothstep(0.4 * px, 1.4 * px, gap);
    col = kc * (0.8 + 0.2 * uMood.y);
    // The black keys: lacquer with a lit bevel, sunk and lit when pressed.
    float bIdx = floor(xi + 0.5);
    float left = mod(bIdx - 1.0, 7.0);
    if (left != 2.0 && left != 6.0 && bIdx > 0.5 && bIdx < nWhite - 0.5 && ky < 0.62) {
      float lo = floor((bIdx - 1.0) / 7.0);
      float bmidi = n0 + 12.0 * lo + WHITE[int(left)] + 1.0;
      float bx = p.x - (-A + bIdx * wW);
      float bw = 0.29 * wW;
      float d = sdRound2(vec2(bx, ky - 0.31), vec2(bw, 0.31), 0.02) ;
      float inK = smoothstep(px, -px, d * kh);
      float bpress = max(smoothstep(0.15, 0.45, noteNow(bmidi)), gl);
      vec3 blk = vec3(0.025, 0.024, 0.03);
      blk += vec3(0.12) * smoothstep(0.7 * bw, bw, abs(bx)) * (1.0 - ky);
      blk += vec3(0.25) * smoothstep(0.05, 0.0, abs(ky - 0.56)) * (1.0 - smoothstep(0.6 * bw, bw, abs(bx)));
      blk += noteCol(bmidi) * bpress * (0.8 + 0.5 * mainK) * smoothstep(0.62, 0.1, ky);
      // Its shadow on the ivory beside it.
      col *= 1.0 - 0.35 * smoothstep(bw * 1.35, bw, abs(bx)) * step(ky, 0.66);
      col = mix(col, blk, inK);
    }
  }

  // --- the lacquer: the piano's body under the keys, mirroring them ---
  if (p.y <= kbot) {
    float dn = kbot - p.y;
    vec3 lac = uPalBg.rgb * 0.25 + vec3(0.006);
    float xi = (p.x + A) / wW;
    float wi = floor(xi);
    float o = floor(wi / 7.0);
    float wmidi = n0 + 12.0 * o + WHITE[int(mod(wi, 7.0))];
    lac += noteCol(wmidi) * smoothstep(0.15, 0.45, noteNow(wmidi)) * exp(-dn / 0.05) * 0.35;
    lac += vec3(0.8, 0.78, 0.72) * 0.05 * exp(-dn / 0.02);
    lac += felt * pulse * exp(-dn / 0.08) * 0.3;
    lac += vec3(0.12) * smoothstep(1.5 * px, 0.0, abs(dn - 0.012));
    col = lac;
  }

  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  particles: {
    count: SPARKS,
    vertex: `
const float WHITE_P[7] = float[7](0.0, 2.0, 4.0, 5.0, 7.0, 9.0, 11.0);
float noteUP(float midi) {
  float f = 440.0 * exp2((midi - 69.0) / 12.0);
  float b = 120.0 * log2(f / 22.0) / log2(18000.0 / 22.0) - 0.5;
  return (b * 127.0 / 119.0 + 0.5) / 128.0;
}
void particle(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind) {
  float j = float(id);
  col = vec4(0.0); pos = vec2(0.0); axis = vec2(0.0); width = 0.0; kind = 0.0;
  if (j >= ${SPARKS}.0 * P_SPARKLE * (0.4 + 0.6 * uQual.y)) return;
  float A = uFrame.z;
  float oct = P_OCTAVES > 0.5 ? floor(P_OCTAVES + 0.5) : clamp(floor(2.0 * A / 0.84 + 0.5), 2.0, 5.0);
  float n0 = 60.0 - 12.0 * floor((oct - 1.0) / 2.0);
  float nWhite = 7.0 * oct;
  float wW = 2.0 * A / nWhite;
  float kt = (A >= 0.95 ? -0.47 : -0.7) - 0.01 * uHit.y;
  vec3 h = hash31(j * 1.618 + 2.3);
  // Each spark belongs to a white key and rises off it over two beats while
  // that key sounds.
  float wi = floor(h.x * nWhite);
  float midi = n0 + 12.0 * floor(wi / 7.0) + WHITE_P[int(mod(wi, 7.0))];
  float u = noteUP(midi);
  float S = 0.008625;
  float v = texture(uSpec, vec2(u, 0.25)).r;
  float n1 = max(texture(uSpec, vec2(u - S, 0.25)).r, texture(uSpec, vec2(u + S, 0.25)).r);
  float n2 = 0.5 * (texture(uSpec, vec2(u - 2.5 * S, 0.25)).r + texture(uSpec, vec2(u + 2.5 * S, 0.25)).r);
  float act = smoothstep(-0.012, 0.01, v - n1) * smoothstep(0.01, 0.06, v - n2) * smoothstep(0.1, 0.3, v);
  float life = fract(uClock.x * 0.5 + h.y);
  float rise = life * (0.35 + 0.35 * h.z);
  pos = vec2(-A + (wi + 0.2 + 0.6 * h.z) * wW + 0.03 * sin(life * 6.0 + h.y * 20.0), kt + 0.01 + rise);
  width = 0.006 + 0.008 * h.y;
  axis = vec2(width, 0.0);
  float b = act * pow(1.0 - life, 2.0) * (0.7 + 0.6 * uHit2.y + 0.4 * uHit.y);
  float pc = mod(midi, 12.0) / 12.0;
  vec3 c = mix(pal(0.5 + 0.5 * sin(pc * TAU + 0.4)), vec3(1.0), 0.5);
  col = vec4(c * b * 1.4 * mix(0.2, 1.0, clearOfHole(pos, 0.02)), 1.0);
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  float r = length(q);
  float core = exp(-r * r * 6.0);
  vec2 a = abs(q);
  float rays = exp(-a.x * 14.0 - a.y * 1.6) + exp(-a.y * 14.0 - a.x * 1.6);
  return vec4(c.rgb * (core + 0.35 * rays), 1.0);
}
`,
  },

  create({ flash }) {
    // Everything here is read from the music block at draw time; the driver
    // only turns the drop into the flash that goes with the glissando.
    let seen = null;
    return {
      step(dt, m) {
        const s = m.stamp.drop;
        if (seen === null) seen = s;
        else if (s !== seen) {
          seen = s;
          flash(0.8);
        }
      },
    };
  },
};
