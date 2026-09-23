// SCÈNE — the stage from the pit.
//
// Rock, metal, punk, hard rock: the picture is the show. A lighting truss
// across the top of the frame, moving heads throwing beams down through the
// smoke, an LED wall behind the band, and the crowd between you and all of
// it, black against the light.
//
//   THE BEAMS are volumetric: each one is a cone from its fixture, and what
//   you see is the smoke inside it — a drifting noise field — lit brighter
//   near the lamp and fading down the beam, the way a real beam only exists
//   where there is haze to show it. Eight fixtures run a PROGRAMME, changed
//   on the bar the way a lighting desk steps its cues: a fan opening, a
//   crossing X, all parallel, a sweep — eased between cues, never snapped.
//   THE WALL behind is a grid of LED pixels showing the spectrum as big level
//   bars, dim enough to be a backdrop.
//   THE CROWD. A row of heads and shoulders across the bottom, bobbing on the
//   beat; after the drop, hands go up.
//   THE MUSIC. The kick punches the beams; the guitars (the mids) thicken the
//   smoke; a breakdown drops to two white beams from the side; the drop fires
//   every fixture at once.
//
// Parameters:
//   beams   fixtures on the truss   smoke  haze density
//   wall    LED wall brightness

import { onStamp } from "./kit.js";

export default {
  id: "stage",
  uses: ["noise", "sdf"],
  params: { beams: 8, smoke: 1, wall: 1 },
  look: { exposure: 1.0, bloom: 1.3, threshold: 0.65, saturation: 1.15 },

  fragment: `
// The angle fixture i points at under cue c (radians from straight down).
float cueAngle(float c, float fi, float n, float bars) {
  float u = (fi + 0.5) / n * 2.0 - 1.0;   // -1..1 across the truss
  float k = mod(c, 4.0);
  if (k < 1.0) return u * 0.55;                                 // a fan
  if (k < 2.0) return -u * 0.45;                                // an X
  if (k < 3.0) return 0.25 * sin(bars * PI * 0.5);              // parallel, swaying
  return u * 0.3 + 0.35 * sin(bars * PI * 0.5 + fi * 0.8);      // a wave
}

float crowdField(vec2 p, float hands) {
  float W = 0.07;
  float bob = envB(fract(uClock.x), 0.25) * 0.012;
  float body = 1e3;
  for (int i = -1; i <= 1; i++) {
    float c = floor(p.x / W) + float(i);
    vec3 h = hash31(c * 1.91 + 3.3);
    float x0 = (c + 0.5 + (h.x - 0.5) * 0.6) * W;
    float base = -1.0 + 0.1 + 0.06 * h.y - bob * (0.5 + h.z);
    float head = length((p - vec2(x0, base + 0.045)) * vec2(1.0, 0.85)) - 0.025;
    float sh = sdRound2(p - vec2(x0, base - 0.25), vec2(0.045, 0.25), 0.03);
    float b = smin(head, sh, 0.02);
    if (h.z > 0.35 && hands > 0.05) {
      float side = h.x > 0.5 ? 1.0 : -1.0;
      vec2 a0 = vec2(x0 + side * 0.03, base - 0.02);
      vec2 a1 = a0 + vec2(side * 0.02 + 0.015 * sin(uClock.x * PI + c), 0.15 * min(hands, 1.0));
      b = min(b, sdSeg2(p, a0, a1) - 0.007);
    }
    body = min(body, b);
  }
  return body;
}

void main() {
  vec2 p = fragP();
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float A = uFrame.z;
  float px = uFrame.w;
  float cue = uS0.x;               // the cue index, eased (fractional between cues)
  float drop = envB(uSince.w, 4.0) * step(uSince.w, 16.0);
  float calm = uArc.z;

  // --- the LED wall behind the band ---
  vec3 col = uPalBg.rgb * 0.3;
  if (p.y > -0.55 && p.y < 0.62) {
    vec2 cell = floor(vec2(p.x, p.y) / 0.045);
    vec2 f = fract(vec2(p.x, p.y) / 0.045) - 0.5;
    float led = smoothstep(0.45, 0.3, max(abs(f.x), abs(f.y)));
    float col01 = (cell.x * 0.045 / A) * 0.5 + 0.5;
    float band = abs(col01 - 0.5) * 2.0;
    float lvl = texture(uSpec, vec2(1.0 - band, 0.25)).r;
    float bar = step((cell.y * 0.045 + 0.55) / 1.17, lvl);
    vec3 lc = pal(fract(band * 0.6 + bars * 0.02));
    col += lc * led * (0.012 + 0.07 * bar) * P_WALL * (1.0 - 0.6 * calm);
  }

  // --- the smoke and the beams ---
  float smoke = (fbm(p * vec2(1.6, 2.2) + vec2(bars * 0.12, -bars * 0.05), 4) * 0.5 + 0.5);
  smoke = mix(0.35, 1.0, smoke) * (0.6 + 0.6 * uBandA.z) * P_SMOKE;
  int n = int(clamp(P_BEAMS, 2.0, 10.0));
  float c0 = floor(cue);
  float cf = smoothstep(0.0, 1.0, fract(cue));
  for (int i = 0; i < 10; i++) {
    if (i >= n) break;
    float fi = float(i);
    // In a breakdown only the two outer fixtures stay on.
    if (calm > 0.5 && i != 0 && i != n - 1) continue;
    vec2 src = vec2(((fi + 0.5) / float(n) * 2.0 - 1.0) * (A - 0.2), 0.95);
    float ang = mix(cueAngle(c0, fi, float(n), bars), cueAngle(c0 + 1.0, fi, float(n), bars), cf);
    if (calm > 0.5) ang = (i == 0 ? 0.55 : -0.55);
    vec2 dir = vec2(sin(ang), -cos(ang));
    vec2 d = p - src;
    float along = dot(d, dir);
    if (along < 0.0) continue;
    float across = abs(d.x * dir.y - d.y * dir.x);
    float width = 0.012 + along * 0.1;
    float beam = exp(-pow(across / width, 2.0)) * exp(-along * 0.35);
    vec3 gelA = pal(fract(fi * 0.13 + c0 * 0.21));
    vec3 gelB = pal(fract(fi * 0.13 + (c0 + 1.0) * 0.21));
    vec3 bc = calm > 0.5 ? vec3(0.85, 0.9, 1.0) : mix(gelA, gelB, cf);
    float punch = 0.35 + 0.5 * uFlow.x + 0.9 * uHit.y * amp + 1.0 * drop;
    col += bc * beam * smoke * punch * 0.38;
    // The fixture itself: a hot lens on the truss.
    col += mix(bc, vec3(1.0), 0.6) * glow(length(p - src), 0.012) * punch * 0.4;
  }
  // The truss: a dark girder across the top with a glint along it.
  float truss = smoothstep(0.02, 0.0, abs(p.y - 0.97) - 0.03);
  float lattice = step(0.5, fract(p.x * 25.0 + (p.y - 0.97) * 25.0));
  col = mix(col, vec3(0.02) + uPalMid.rgb * 0.02 * lattice, truss * 0.9);

  // --- the crowd ---
  float hands = drop + uArc.y * 0.5;
  float body = crowdField(p, hands);
  float cov = smoothstep(px, -px, body);
  float rim = exp(-pow(max(body, 0.0) / (px * 1.5), 2.0)) * step(0.0, body);
  col = mix(col, uPalBg.rgb * 0.05, cov);
  col += mix(uPalHigh.rgb, vec3(1.0), 0.3) * rim * 0.12 * (0.4 + uFlow.x);
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.25;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    // The lighting desk: one cue per bar in a drive, one every two in a
    // quieter passage, eased over half a beat.
    let cue = 0;
    let shown = 0;
    let bars = 0;
    const bar = onStamp((m) => m.stamp.bar, (s, m) => {
      bars++;
      if (m.drive > 0.5 || bars % 2 === 0) cue += 1;
    });
    const drop = onStamp((m) => m.stamp.drop, () => {
      cue += 1;
      flash(0.9);
    });
    return {
      step(dt, m) {
        bar(m);
        drop(m);
        shown = m.ease(shown, cue, 0.5, dt);
        state[0] = shown;
      },
    };
  },
};
