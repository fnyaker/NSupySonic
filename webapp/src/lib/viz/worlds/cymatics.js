// CYMATICS — frenchcore's melody, written in sand by its own kick.
//
// Frenchcore is hardcore that SINGS: a 200 BPM kick driven into a clipper under
// a lead the whole room knows. The piano world drew the tune as a piano roll,
// which is right for a piano and was never right for this — it is a still
// picture of a violent music. This draws the one physical thing that is both:
// a Chladni plate. Sand on a metal plate gathers on the NODAL LINES of the
// standing wave the plate is singing, and which lines depends on the note.
//
//   THE MELODY IS THE PATTERN. The lead's pitch picks the plate's mode: each
//   note of the scale has its own figure, a melody walking up the scale walks
//   the figures, a held note holds one, and a change MORPHS the sand from one
//   figure to the next over half a beat — two modes superposed are exactly
//   what a plate does between two notes. With no lead to follow, the figure
//   turns over once a phrase.
//   THE KICK THROWS THE SAND. Every main kick is a blow in the middle of the
//   plate: a shock front runs out from it, and the sand leaps off its lines as
//   the front passes and falls back onto them — so the pattern breathes at
//   200 BPM without ever losing its shape. Big kicks throw it higher.
//   A ROLL makes the sand chatter, at the roll's own subdivision. A BUILD
//   folds the plate finer (the driver climbs to more complex figures) and the
//   grains tremble; the DROP blows the sand off the plate in a burst and it
//   lands on a new figure. The BREAKDOWN leaves the lead alone with the sand:
//   the drums gone, the lines glow with the tune.
//   THE GENRE CHANNEL shades it: the sung lead brightens the lines, the buzz
//   (a distorted tail, a saw stack) roughens the grain, the sub makes the
//   plate heave.
//
// The plate spans the whole frame — Chladni figures are made of cosines and
// continue past the square they are usually shown on — so a beamer is filled
// to its edges. It is struck where the artwork sits: the figures are
// symmetric about that point, so they radiate round the cover and every kick's
// shock front runs out from under it. A narrow frame draws the figure finer,
// so a phone sees as many lines across as a beamer does.
//
// Parameters:
//   sand    how bright the figure is       grains  how many loose grains fly
//   jump    how high the kick throws        burst   the drop's explosion
//   sheen   the plate's metal

import { onStamp } from "./kit.js";

const GRAINS = 1800;

// The figures, one per scale degree, in rising complexity: (n, m, sign) in
//   u = cos(n a) cos(m b) + sign cos(m a) cos(n b),  a, b = pi (x + 1) / 2.
// Sixteen, so a build can climb past the twelve a melody uses.
const MODES = [
  [1, 2, -1], [1, 3, -1], [2, 3, 1], [1, 4, -1], [2, 5, 1], [3, 4, -1],
  [1, 5, 1], [3, 5, -1], [2, 7, 1], [4, 5, -1], [3, 7, 1], [5, 6, -1],
  [4, 7, 1], [5, 8, -1], [6, 7, 1], [5, 9, -1],
];

const PLATE = `
const vec3 MODES[16] = vec3[16](${MODES.map(([n, m, s]) => `vec3(${n}.0, ${m}.0, ${s}.0)`).join(", ")});

// The standing wave of one mode at q, and its gradient (in p units).
vec3 mode(vec2 q, vec3 md) {
  float a = 1.5707963 * (q.x + 1.0);
  float b = 1.5707963 * (q.y + 1.0);
  float n = md.x, m = md.y, s = md.z;
  float ca = cos(n * a), cb = cos(m * b), sa = sin(n * a), sb = sin(m * b);
  float ca2 = cos(m * a), cb2 = cos(n * b), sa2 = sin(m * a), sb2 = sin(n * b);
  float u = ca * cb + s * ca2 * cb2;
  float dx = 1.5707963 * (-n * sa * cb - s * m * sa2 * cb2);
  float dy = 1.5707963 * (-m * ca * sb - s * n * ca2 * sb2);
  return vec3(u, dx, dy);
}
// Where the plate is struck: the artwork, when there is one — the figures are
// symmetric about the point that excites them, so they radiate round the
// cover instead of drawing a cross through it.
vec2 plateC() { return uHole.z > 0.0 ? uHole.xy : vec2(0.0); }
// A narrow frame (a phone) shows less of the plate across, so the figure is
// drawn finer there: about the same number of lines fit the width.
float plateS() { return mix(1.0, 1.7, clamp((1.2 - uFrame.z) / 0.7, 0.0, 1.0)); }
// The plate: the two figures the driver is morphing between (uS0.xy, eased
// by uS0.z), heaving on the sub. q is relative to the plate's centre.
vec3 plate(vec2 q) {
  float heave = 1.0 + 0.012 * uGenre[0].w * sin(uClock.x * 3.14159);
  q *= plateS() / heave;
  vec3 A = mode(q, MODES[int(clamp(uS0.x, 0.0, 15.0))]);
  vec3 B = mode(q, MODES[int(clamp(uS0.y, 0.0, 15.0))]);
  return mix(A, B, uS0.z);
}
// How the sand leaps as a shock front from the plate's centre reaches it:
// up and back down over a third of a beat, the front running out at three
// p-units a beat.
float leap(float since, float dist) {
  float t = since - dist / 3.0;
  return t < 0.0 || t > 0.34 ? 0.0 : sin(t / 0.34 * 3.14159);
}
`;

export default {
  id: "cymatics",
  uses: ["noise"],
  params: { sand: 1, grains: 1, jump: 1, burst: 1, sheen: 1 },
  look: { exposure: 1.0, bloom: 1.3, threshold: 0.7, saturation: 1.1 },

  fragment: `${PLATE}
void main() {
  vec2 p = fragP();
  float px = uFrame.w;
  float amp = 0.6 + 0.4 * uCtl.x;
  vec2 c = plateC();
  vec2 r0 = p - c;
  float dist = length(r0);

  // THE DROP: the whole figure blown outward over one beat, and back.
  float burst = P_BURST * (uSince.w < 1.2 ? sin(min(1.0, uSince.w / 1.2) * 3.14159) : 0.0) * amp;
  vec2 q = r0 / (1.0 + 0.35 * burst);
  // A ROLL: the sand chatters at the roll's subdivision; a BUILD trembles it.
  float div = max(2.0, uLookB.w * 16.0);
  float chat = uArc.w * 0.004 + uArc.y * 0.002;
  q += chat * vec2(sin(uClock.x * div * 6.2832 + q.y * 40.0), cos(uClock.x * div * 6.2832 + q.x * 37.0));

  vec3 w = plate(q);
  float g = length(w.yz) + 0.35;
  // Distance to the nodal line in p units (the wave was taken in scaled
  // coordinates, so the gradient is too).
  float d = abs(w.x) / g / plateS();

  // THE KICK: the sand leaps off its lines as the front passes.
  float J = leap(uSince.y, dist) * (0.55 + 0.45 * uHit.z) * P_JUMP * amp;

  // --- the plate: brushed steel under a softbox --------------------------------
  vec3 col = uPalBg.rgb * 0.22;
  float brush = gnoise(vec2(p.x * 2.5, p.y * 160.0)) * 0.5 + 0.5;
  // A soft key light lying diagonally across the steel, drifting over a phrase.
  float band = p.x * 0.5 + p.y * 0.86 - 0.3 + 0.25 * sin(uClock.z * 1.5708);
  float key = exp(-band * band / 0.18);
  vec3 steel = mix(uPalMid.rgb, vec3(0.85), 0.35);
  col += steel * key * (0.035 + 0.035 * brush) * P_SHEEN;
  col += uPalMid.rgb * (0.008 + 0.012 * brush) * P_SHEEN;
  // Where the plate moves most (the antinodes) it shimmers with the music.
  float vib = abs(w.x) * 0.5;
  col += uPalMid.rgb * vib * vib * (0.025 + 0.05 * uMood.y + 0.1 * J) * P_SHEEN;
  // The shock front itself: a ring of vibration running out on every kick.
  float front = uSince.y * 3.0;
  float fr = exp(-pow((dist - front) / 0.025, 2.0)) * envB(uSince.y, 0.5) * (0.5 + 0.5 * uHit.z) * amp;
  col += mix(uPalHigh.rgb, uPalAcc.rgb, 0.3) * fr * 0.16 * (1.0 - uArc.z);

  // --- the sand -------------------------------------------------------------------
  // Grains, not a line: every cell of about two and a half pixels holds a
  // grain or does not, with a probability that is the sand's DENSITY there —
  // near one on a nodal line, where it piles up, thinning to a scatter of
  // loose grains between the lines. The kick throws grains off the lines, so
  // the scatter swells on every kick; a roll keeps it stirred.
  float piles = 0.65 + 0.7 * (gnoise(q * 7.0 + 3.1) * 0.5 + 0.5);
  float width = (0.0055 + 0.004 * uGenre[0].y) * piles * (1.0 + 2.0 * J);
  float line = exp(-d * d / (width * width));
  float loose = exp(-d / (0.035 + 0.09 * J)) * (0.05 + 0.3 * J + 0.15 * uArc.w + 0.1 * uGenre[0].y);
  float density = clamp(line * 0.95 + loose, 0.0, 1.0);
  float gs = max(2.5 * px, 0.0017);
  vec2 gq = q / gs;
  vec2 gc = floor(gq);
  vec3 gh = hash32(gc);
  float on = step(1.0 - density, gh.x);
  float disc = smoothstep(0.55, 0.2, length(fract(gq) - 0.5 + (gh.yz - 0.5) * 0.3));
  float lead = max(uGenre[0].x, uBandB.w);
  float bright = (0.55 + 0.8 * lead) * (1.0 + 0.7 * J) * P_SAND;
  vec3 sandC = mix(uPalHigh.rgb, vec3(1.0, 0.95, 0.85), 0.3);
  vec3 hot = mix(uPalAcc.rgb, vec3(1.0), 0.35);
  vec3 sand = mix(sandC, hot, 0.5 * J + 0.3 * burst) * (0.7 + 0.6 * gh.y);
  col += sand * on * disc * bright;
  // Below the pixel's own grain, the line's average light, so a line stays
  // a line where the grains are too fine to resolve.
  col += sandC * line * 0.22 * bright;
  // A soft halo along the lines: the tune glowing, strongest when the lead is
  // alone in a breakdown.
  col += uPalHigh.rgb * glow(d, 0.02) * 0.045 * (0.4 + 1.2 * lead) * (0.6 + 0.8 * uArc.z) * P_SAND;

  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.18;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  particles: {
    count: GRAINS,
    vertex: `${PLATE}
void particle(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind) {
  float j = float(id);
  col = vec4(0.0); pos = vec2(0.0); axis = vec2(0.0); width = 0.0; kind = 0.0;
  if (j >= ${GRAINS}.0 * P_GRAINS * (0.35 + 0.65 * uQual.y)) return;
  float A = uFrame.z;
  vec3 h = hash31(j * 1.618 + 7.1);
  // A grain starts anywhere on the plate and settles onto the nearest line:
  // three Newton steps along the wave's gradient.
  vec2 c = plateC();
  float S = plateS();
  // In the plate's scaled frame, where the wave (and its gradient) lives.
  vec2 q = (vec2((h.x * 2.0 - 1.0) * A, h.y * 2.0 - 1.0) - c) * S;
  for (int k = 0; k < 3; k++) {
    vec3 w = plate(q / S);
    float g2 = dot(w.yz, w.yz) + 0.2;
    q -= clamp(w.x / g2, -0.3, 0.3) * w.yz;
  }
  q /= S;
  vec3 w = plate(q);
  if (abs(w.x) / (length(w.yz) + 0.35) > 0.03) return; // it found no line
  float amp = 0.6 + 0.4 * uCtl.x;
  float dist = length(q);
  // THE KICK throws it up: toward the viewer, so larger and a little outward.
  float J = leap(uSince.y, dist) * (0.4 + 0.9 * h.z) * (0.55 + 0.45 * uHit.z) * P_JUMP * amp;
  // THE DROP blows it off the plate.
  float B = P_BURST * (uSince.w < 1.2 ? sin(min(1.0, uSince.w / 1.2) * 3.14159) : 0.0) * amp;
  vec2 dir = dist > 1e-3 ? q / dist : vec2(1.0, 0.0);
  pos = c + q * (1.0 + 0.35 * B) + dir * (0.035 * J + 0.14 * B * (0.3 + 0.7 * h.z));
  width = (0.004 + 0.004 * h.y) * (1.0 + 1.8 * J);
  axis = vec2(width, 0.0);
  float lead = max(uGenre[0].x, uBandB.w);
  float b = (0.2 + 1.3 * J + 0.8 * B) * (0.5 + 0.6 * lead);
  vec3 cc = mix(mix(uPalHigh.rgb, vec3(1.0), 0.35), mix(uPalAcc.rgb, vec3(1.0), 0.3), 0.6 * J + 0.4 * B);
  col = vec4(cc * b * mix(0.25, 1.0, clearOfHole(pos, 0.02)), 1.0);
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  float r = length(q);
  return vec4(c.rgb * exp(-r * r * 5.0), 1.0);
}
`,
  },

  create({ state, flash, params }) {
    // The figure: which two modes the plate is between and how far it has
    // morphed. A note has to hold for a sixteenth before it moves the plate —
    // a passing grace note does not redraw the sand.
    let a = 0;
    let b = 0;
    let t = 1;
    let lastSemi = -1;
    let held = 0;
    let phraseSeen = -1;
    const target = (idx) => {
      if (idx === b) return;
      a = t >= 0.5 ? b : a;
      b = idx;
      t = 0;
    };
    const onDrop = onStamp((m) => m.stamp.drop, () => {
      flash(0.85 * (params.burst ?? 1));
      // The drop lands on a figure of its own: the most complex of the scale.
      target(8 + (b % 4));
    });
    return {
      step(dt, m, clocks) {
        onDrop(m);
        const beats = dt / Math.max(0.05, m.beat);
        // The lead's pitch, 0..1 over 60 Hz-4 kHz on a log scale, as semitones.
        const semi = Math.round(72.68 * (clocks?.pitch ?? 0.5));
        if (semi === lastSemi) held += beats;
        else {
          lastSemi = semi;
          held = 0;
        }
        // A build climbs to finer figures: the scale is walked from further up.
        const climb = Math.round(4 * Math.min(1, m.build));
        const sings = (clocks?.melody ?? 0) > 0.25 && m.melodic > 0.2;
        if (sings && held >= 0.25) target(Math.min(15, (((semi % 12) + 12) % 12) + climb));
        else if (!sings) {
          // No lead to follow: the figure turns over once a phrase.
          const phrase = Math.floor(m.phrases ?? 0);
          if (phrase !== phraseSeen) {
            phraseSeen = phrase;
            target((b + 5 + climb) % 12);
          }
        }
        t = Math.min(1, t + beats / 0.5);
        state[0] = a;
        state[1] = b;
        state[2] = t * t * (3 - 2 * t);
      },
    };
  },
};
