// KALÉIDOSCOPE — a crystal of light, folded into a mandala.
//
// Psytrance is relentless, symmetrical and hypnotic, and the picture that has
// always belonged to it is the mandala: a pattern mirrored around a centre,
// turning, endlessly detailed. What makes one look DESIGNED rather than noisy
// is line work on darkness, so this is drawn as line art — not as a coloured
// fractal fill, which is what an inversion fold gives you and what reads as
// television static at any distance.
//
//   THE CRYSTAL is a kaleidoscopic IFS: space is folded into mirrored sectors,
//   then — seven times over — folded across both axes and the diagonal,
//   rotated, scaled up and pushed out. At every step a straight segment is
//   drawn in the folded space, so it appears at every scale the fold visits:
//   a lattice of struts that branches into finer struts, each generation a
//   step further along the palette and a little dimmer. The distance to each
//   strut is carried back to the screen by the fold's accumulated scale, so a
//   strut is a hairline in PIXELS at every depth — crisp on a phone, crisp on
//   a 4K beamer, and never the aliased mush a coloured orbit trap turns into.
//   THE DEPTH. A second crystal, larger, blurred and dim, turns the other way
//   behind the first: the parallax is what makes it a space, not a pattern.
//   JEWELS sit on the fold's vertices and glint with the hats.
//
// The music drives the FOLD, which is what makes it psychedelic rather than
// merely decorative: the fold's angle drifts over the phrase and leans with
// the bass, so the whole structure grows and re-forms; the mandala ratchets a
// fraction of a sector on every bar like a hand turning a real kaleidoscope;
// the kick pumps the zoom and lights the struts from the centre outward. A
// build tightens and speeds it, a breakdown leaves the struts glowing dimly,
// the drop throws a ring of light out through it.
//
// Shape switches (skins): `sectors` (how many mirrors), `mirror` 0 turns the
// kaleidoscope into a pinwheel (goa), `web` draws the circle traps as well
// (forest, dark psy: a web, not a crystal), `iter` is how deep the fold goes,
// `twist` how far each bar turns it.

import { eventRing, onStamp } from "./kit.js";

export default {
  id: "kaleido",
  uses: ["sdf"],
  params: { sectors: 8, mirror: 1, twist: 1, web: 0, iter: 7, zoom: 1 },
  look: { exposure: 1.0, bloom: 1.25, threshold: 0.7, saturation: 1.2 },

  fragment: `
// Seven folds of the crystal. Returns the light of its struts at this point,
// already coloured, in linear units. \`px\` is one screen pixel in z's units.
vec3 crystal(vec2 z, float ang, vec2 off, float sc, int iter, float px, float hue, float lit, out float jewel) {
  vec3 acc = vec3(0.0);
  float s = 1.0;
  jewel = 0.0;
  for (int i = 0; i < 9; i++) {
    if (i >= iter) break;
    z = abs(z);
    if (z.x < z.y) z = z.yx;
    z *= rot(ang);
    z = z * sc - off * (sc - 1.0);
    s *= sc;
    float fi = float(i);
    // The strut, and how far it is from here in SCREEN units.
    float d = sdSeg2(z, vec2(-0.6, 0.0), vec2(0.9, 0.0)) / s;
    float w = pow(0.66, fi);
    // A hairline core and a soft halo; each generation one step round the
    // palette and a little dimmer, so the eye reads the structure first.
    vec3 c = pal(fract(hue + fi * 0.13));
    // A gaussian core, not the long glow tail: a thousand struts' tails would
    // sum into a milky fill and the line work would drown in it.
    float line = exp(-d * d / (px * px * 1.3)) + 0.035 * glow(d, px * 5.0);
    // The kick travels OUT through the generations: the first folds light
    // first, the finest last.
    float wave = exp(-pow((fi / 7.0 - lit) * 3.5, 2.0));
    acc += c * line * w * (0.35 + 1.3 * wave);
    if (P_WEB > 0.02) {
      float dc = abs(length(z) - 0.55) / s;
      acc += c * glow(dc, px * 0.8) * w * P_WEB * 0.6;
    }
    jewel += glow(length(z - vec2(0.9, 0.0)) / s, px * 2.2) * w;
  }
  return acc;
}

void main() {
  vec2 p = fragP() - uHole.xy;
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float rim = uHole.z > 0.0 ? min(uHole.z, uHole.w) : 0.0;
  // The mandala leans toward the frame's shape (the ring metric every
  // expanding thing here uses), so on a 16:9 beamer it reaches the sides
  // instead of sitting in a circle in the middle of them.
  vec2 lean = vec2(mix(1.0, uFrame.z, 0.3), 1.0);
  float r = length(p / lean);
  float corner = length(frameHalf() / lean);

  // The ratchet: a fraction of a sector per bar, eased over its first beat, so
  // the mandala CLICKS round with the music rather than drifting.
  float n = max(2.0, floor(P_SECTORS + 0.5));
  float sector = TAU / n;
  float ratchet = floor(bars) + smoothstep(0.0, 0.3, fract(bars));
  float turn = ratchet * sector * 0.5 * P_TWIST * (1.0 - 0.7 * uMood.x) + uS0.x;

  // The fold's own geometry: drifting over the phrase, leaning with the bass.
  float ang = 0.42 + 0.16 * sin(uClock.z * TAU * 0.5 + 0.7) + 0.05 * uBandA.y + uS0.y;
  vec2 off = vec2(1.0, 0.36 + 0.08 * cos(uClock.z * TAU * 0.25) + 0.06 * uBandA.w);
  float sc = 1.72 + 0.12 * uArc.y;
  int iter = int(clamp(P_ITER * (0.75 + 0.25 * uQual.x), 4.0, 9.0));

  // The zoom breathes over the phrase and pumps on the kick.
  // Scaled so the frame's corner lands on the crystal's outer edge.
  float zoom = (1.05 + 0.12 * sin(uClock.z * TAU)) / corner * (1.0 - 0.06 * uHit.y * amp) / max(P_ZOOM, 0.2);
  float lit = uS0.z;
  float hue = uS0.w;

  // Mirror space: n sectors, mirrored (or a pinwheel without the mirror).
  float a = atan(p.y / lean.y, p.x / lean.x) + turn;
  float sa = mod(a, sector);
  if (P_MIRROR > 0.5) sa = abs(sa - sector * 0.5);
  else sa += r * 0.6;
  vec2 q = vec2(cos(sa), sin(sa)) * max(r - rim * 0.8, 0.0);

  vec3 col = uPalBg.rgb * 0.35;
  // The depth: a larger crystal behind, turning the other way, soft and dim.
  float aB = atan(p.y / lean.y, p.x / lean.x) - turn * 0.6;
  float saB = mod(aB, sector);
  saB = abs(saB - sector * 0.5);
  vec2 qB = vec2(cos(saB), sin(saB)) * r;
  float jB;
  float zB = zoom * 0.6;
  vec3 back = crystal(qB * zB, ang * 0.8 + 0.3, off * vec2(1.0, 1.2), sc, max(iter - 2, 3), uFrame.w * zB * 2.5, hue + 0.5, lit, jB);
  col += back * 0.2 * (0.5 + 0.5 * uMood.y);

  // The crystal.
  float jewel;
  vec3 front = crystal(q * zoom, ang, off, sc, iter, uFrame.w * zoom, hue, lit, jewel);
  // A breakdown keeps the struts alive, breathing over two bars, rather than
  // letting the whole thing go out.
  float breath = 0.5 + 0.5 * sin(uClock.y * PI * 0.5);
  float bright = (0.45 + 0.45 * uFlow.x + 0.35 * uHit.x) * (1.0 - 0.3 * uArc.z) + uArc.z * (0.35 + 0.45 * breath);
  col += front * bright * 0.7;
  // The jewels glint with the hats.
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * jewel * (0.12 + 0.9 * uHit2.x * amp) * 0.5;

  // The eye: a ring of light on the rim, pumping on the kick.
  float eye = glow(r - rim - 0.02, 0.012 + 0.02 * uHit.y);
  col += mix(uPalHigh.rgb, vec3(1.0), 0.3) * eye * (0.2 + 0.9 * uHit.y * amp);
  // A soft glow from the centre that the whole thing radiates from.
  col += uPalMid.rgb * exp(-max(r - rim, 0.0) * 3.0) * 0.06 * (0.4 + uMood.y);

  // The drop throws a ring of light out through the crystal.
  for (int i = 0; i < 8; i++) {
    vec4 ev = uEv[i];
    float age = uClock.x - ev.x;
    if (ev.y <= 0.0 || age < 0.0 || age > 4.0) continue;
    float rc = ringCoord(fragP());
    float front2 = age / 4.0 * 1.1;
    float band = exp(-pow((rc - front2) / 0.035, 2.0));
    col += mix(uPalHigh.rgb, uPalAcc.rgb, ev.z) * band * ev.y * (1.0 - age / 4.0) * 0.8;
    col += front * band * ev.y * 1.5;
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.25;
  // The mandala is centred on the artwork, so its brightest ring hugs the
  // cover: dim what is under it properly, not by the house third.
  col *= mix(0.15, 1.0, clearOfHole(fragP(), 0.08));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ ev, state, flash }) {
    const ring = eventRing(ev);
    let spin = 0;
    let lean = 0;
    let lit = 1;
    let hue = 0;
    let n = 0;
    const drop = onStamp((m) => m.stamp.drop, (s) => {
      ring.push(s, 1, 1, 0);
      flash(0.8);
    });
    const main = onStamp((m) => m.stamp.main, () => {
      lit = 0;
    });
    const bar = onStamp((m) => m.stamp.bar, (s, m) => {
      if (m.drive > 0.55 && m.breakdown < 0.3 && ++n % 4 === 0) ring.push(s, 0.35, 0, 0);
    });
    const chord = onStamp((m) => m.stamp.chord, () => {
      hue += 0.08;
    });
    return {
      step(dt, m) {
        drop(m);
        main(m);
        bar(m);
        chord(m);
        // A slow continuous turn under the ratchet, faster through a build.
        spin += m.perBeat(0.004 + 0.012 * m.build) * dt * Math.PI * 2;
        // The fold leans with the melody, eased so it never jumps.
        lean = m.ease(lean, 0.08 * m.melodic - 0.04, 4, dt);
        // The kick's wave travels out through the generations over half a beat.
        lit = Math.min(1.4, lit + dt / m.overBeats(0.5));
        state[0] = spin;
        state[1] = lean;
        state[2] = lit;
        state[3] = hue;
      },
    };
  },
};
