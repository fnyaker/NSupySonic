// SCÈNE — the stage from the pit.
//
// Rock, metal, punk, hard rock: the picture is the show, seen from the crowd.
// It used to be beams over a VU meter — an LED wall of level bars — with a
// row of heads; a rock show is a BAND, backlit, and that was the thing
// missing. So, back to front:
//
//   THE WALL. A fine-pitch LED screen behind the band, showing the record's
//   own artwork (a palette wash when there is none), breathing with the kick
//   and flooding on the drop. Its LEDs are drawn as LEDs only while they are
//   big enough on screen to be seen as dots; below that they are their light.
//   THE BAND. Silhouettes against that wall: a drum kit on its riser with the
//   drummer behind it and cymbals that jump on the kick, two guitarists who
//   headbang on the beat once the track drives, amp stacks at the wings. All
//   of it black, outlined by the light behind it — the way a band looks from
//   the pit.
//   THE BEAMS are volumetric: each one is a cone from its fixture on the
//   truss, and what you see is the smoke inside it, lit brighter near the
//   lamp. Eight fixtures run a PROGRAMME, stepped on the bar the way a
//   lighting desk steps its cues — a fan, an X, all parallel, a wave — eased
//   between cues, never snapped. A breakdown keeps two white beams on the
//   guitarists.
//   THE CROWD. Three rows of people between you and the stage (the shared
//   \`crowd\` chunk), whose hands go up through the build and all at once on
//   the drop.
//
// Parameters:
//   beams   fixtures on the truss   smoke  haze density
//   wall    LED wall brightness      band   the band's presence

import { onStamp } from "./kit.js";

export default {
  id: "stage",
  uses: ["noise", "crowd"],
  params: { beams: 8, smoke: 1, wall: 1, band: 1 },
  look: { exposure: 1.0, bloom: 1.3, threshold: 0.7, saturation: 1.12 },

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

// An ellipse, approximately, as a distance: good enough for a silhouette.
float sdEll(vec2 q, vec2 r) { return (length(q / r) - 1.0) * min(r.x, r.y); }

// The backline, in stage units (x across, y up from the deck).
float ampStack(vec2 q) {
  float a = sdRound2(q - vec2(0.0, 0.095), vec2(0.1, 0.095), 0.008);
  float b = sdRound2(q - vec2(0.0, 0.29), vec2(0.1, 0.095), 0.008);
  float h = sdRound2(q - vec2(0.0, 0.415), vec2(0.1, 0.03), 0.008);
  return min(min(a, b), h);
}

// The kit on its riser, the drummer behind it; the cymbals jump on the kick
// and the drummer's head goes with the beat.
float drumKit(vec2 q, float hit, float nod) {
  float riser = sdBox2(q - vec2(0.0, 0.03), vec2(0.36, 0.03));
  float kick = length(q - vec2(0.0, 0.17)) - 0.11;
  float tom1 = sdEll(q - vec2(-0.075, 0.3), vec2(0.045, 0.035));
  float tom2 = sdEll(q - vec2(0.075, 0.3), vec2(0.045, 0.035));
  float ftom = sdRound2(q - vec2(0.21, 0.14), vec2(0.055, 0.075), 0.02);
  float snare = sdRound2(q - vec2(-0.19, 0.22), vec2(0.06, 0.018), 0.01);
  float cym1 = sdRound2(rot(0.22 + 0.12 * hit) * (q - vec2(-0.29, 0.4 + 0.012 * hit)), vec2(0.085, 0.004), 0.004);
  float cym2 = sdRound2(rot(-0.28 - 0.1 * hit) * (q - vec2(0.3, 0.44 + 0.01 * hit)), vec2(0.095, 0.004), 0.004);
  float hat = sdRound2(q - vec2(-0.25, 0.3), vec2(0.055, 0.005), 0.004);
  float stands = min(min(sdSeg2(q, vec2(-0.29, 0.06), vec2(-0.29, 0.4)), sdSeg2(q, vec2(0.3, 0.06), vec2(0.3, 0.44))),
                     sdSeg2(q, vec2(-0.25, 0.06), vec2(-0.25, 0.3))) - 0.004;
  float drummer = min(length(q - vec2(0.0, 0.44 - 0.015 * nod)) - 0.04, sdRound2(q - vec2(0.0, 0.33), vec2(0.075, 0.07), 0.04));
  return min(min(min(riser, kick), min(tom1, tom2)), min(min(ftom, snare), min(min(cym1, cym2), min(min(hat, stands), drummer))));
}

// A guitarist standing at the lip, guitar slung low, headbanging by \`bang\`.
// \`side\` mirrors them, so the two face in toward the kit.
float guitarist(vec2 q, float bang, float side) {
  q.x *= side;
  float head = length(q - vec2(0.03 * bang, 0.565 - 0.035 * bang)) - 0.037;
  float hair = sdEll(q - vec2(0.02 + 0.04 * bang, 0.53 - 0.03 * bang), vec2(0.03, 0.05 + 0.02 * bang));
  float torso = sdRound2(q - vec2(0.0, 0.41), vec2(0.066, 0.105), 0.04);
  float legs = min(sdSeg2(q, vec2(-0.028, 0.31), vec2(-0.08, 0.0)), sdSeg2(q, vec2(0.028, 0.31), vec2(0.08, 0.0))) - 0.026;
  float body = sdEll(rot(0.45) * (q - vec2(0.03, 0.33)), vec2(0.075, 0.05));
  float neck = sdSeg2(q, vec2(0.0, 0.35), vec2(-0.21, 0.47)) - 0.008;
  float arms = min(sdSeg2(q, vec2(0.05, 0.47), vec2(0.06, 0.33)), sdSeg2(q, vec2(-0.05, 0.47), vec2(-0.14, 0.43))) - 0.017;
  return min(min(min(head, hair), min(torso, legs)), min(min(body, neck), arms));
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
  float drive = uFlow.x;
  float hit = uHit.y * amp;

  // The deck the band stands on: under the artwork when there is one.
  float deck = uHole.z > 0.0 ? min(-0.42, uHoleR.z - 0.04) : -0.42;
  float S = clamp(A / 1.6, 0.5, 1.0);

  vec3 col = uPalBg.rgb * 0.25;

  // --- the LED wall ---
  float wallK = (0.2 + 0.4 * drive + 0.6 * hit + 0.6 * drop) * (1.0 - 0.6 * calm) * P_WALL;
  vec3 wallLight = mix(uPalMid.rgb, uPalHigh.rgb, 0.5) * wallK;
  vec2 wlo = vec2(-(A - 0.2), deck + 0.03);
  vec2 whi = vec2(A - 0.2, 0.8);
  if (p.x > wlo.x && p.x < whi.x && p.y > wlo.y && p.y < whi.y) {
    float pitch = 0.016;
    vec2 cell = floor(p / pitch);
    vec2 cc = (cell + 0.5) * pitch;
    vec2 f = fract(p / pitch) - 0.5;
    float dots = smoothstep(2.5, 4.0, pitch / px);
    float led = mix(0.55, smoothstep(0.46, 0.22, length(f)), dots);
    vec2 uvw = (mix(p, cc, dots) - wlo) / (whi - wlo);
    vec3 content;
    if (uCoverOK > 0.5) {
      // The artwork, fitted to the wall's width: its middle band, drifting
      // slowly so the screen is never a still.
      float wa = (whi.x - wlo.x) / (whi.y - wlo.y);
      vec2 uv = vec2(uvw.x, 0.5 + (uvw.y - 0.5) / wa + 0.08 * sin(bars * 0.2));
      content = textureLod(uCover, vec2(uv.x, 1.0 - uv.y), 1.5).rgb;
      content *= content;
    } else {
      content = pal(fract(uvw.x * 0.6 + bars * 0.05 + 0.15 * sin(uvw.y * 4.0 + bars * 0.5)));
    }
    float edge = smoothstep(0.0, 0.02, min(min(uvw.x, 1.0 - uvw.x), min(uvw.y, 1.0 - uvw.y)));
    col += content * led * wallK * 0.8 * edge;
  }
  // The light the wall throws into the haze in front of it.
  float haze = fbm(p * vec2(1.6, 2.2) + vec2(bars * 0.12, -bars * 0.05), 4) * 0.5 + 0.5;
  haze = mix(0.35, 1.0, haze) * (0.6 + 0.6 * uBandA.z) * P_SMOKE;
  col += wallLight * haze * 0.05 * smoothstep(wlo.y - 0.2, wlo.y + 0.3, p.y);

  // --- the band, black against the wall and outlined by it ---
  if (P_BAND > 0.01) {
    float bang = envB(uSince.x, 0.3) * smoothstep(0.35, 0.7, drive) * (1.0 - calm);
    float gx = max(A * 0.36, 0.2 + 0.3 * S);
    float ax = max(A * 0.7, gx + 0.18 * S);
    vec2 q = (p - vec2(0.0, deck)) / S;
    float sd = drumKit(q, envB(uSince.x, 0.5) * amp, bang);
    sd = min(sd, guitarist(q - vec2(gx / S, 0.0), bang, -1.0));
    sd = min(sd, guitarist(q + vec2(gx / S, 0.0), envB(uSince.x - 0.08, 0.3) * smoothstep(0.35, 0.7, drive) * (1.0 - calm), 1.0));
    sd = min(sd, ampStack(q - vec2(ax / S, 0.0)));
    sd = min(sd, ampStack(q + vec2(ax / S, 0.0)));
    sd *= S;
    float cover = smoothstep(px, -px, sd) * P_BAND;
    col = mix(col, uPalBg.rgb * 0.04, cover);
    // Backlight wraps round the outside of every edge: a hairline of the
    // wall's light, never an outline drawn inside the shape.
    col += wallLight * exp(-max(sd, 0.0) / (1.2 * px)) * step(0.0, sd) * 0.22 * P_BAND;
  }

  // --- the stage front: the deck's edge and its footlights ---
  if (p.y < deck) {
    float face = smoothstep(deck - 0.1, deck - 0.02, p.y);
    col = mix(col, uPalBg.rgb * 0.06, face * 0.9);
    float fx = fract(p.x / 0.24) - 0.5;
    vec2 fq = vec2(fx * 0.24, p.y - (deck - 0.02));
    col += mix(vec3(1.0, 0.75, 0.45), uPalHigh.rgb, 0.4) * glow(length(fq), 0.008) * 0.5 * (0.4 + 0.6 * drive);
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.4) * exp(-abs(p.y - deck) / (1.5 * px)) * 0.12 * (0.3 + 0.7 * wallK);

  // --- the beams ---
  int n = int(clamp(P_BEAMS, 2.0, 12.0));
  float c0 = floor(cue);
  float cf = smoothstep(0.0, 1.0, fract(cue));
  float punch = 0.35 + 0.5 * drive + 0.9 * hit + 1.0 * drop;
  for (int i = 0; i < 12; i++) {
    if (i >= n) break;
    float fi = float(i);
    // In a breakdown only the two outer fixtures stay on, white, on the
    // guitarists.
    if (calm > 0.5 && i != 0 && i != n - 1) continue;
    vec2 src = vec2(((fi + 0.5) / float(n) * 2.0 - 1.0) * (A - 0.2), 0.95);
    float ang = mix(cueAngle(c0, fi, float(n), bars), cueAngle(c0 + 1.0, fi, float(n), bars), cf);
    if (calm > 0.5) ang = (i == 0 ? 0.35 : -0.35);
    vec2 dir = vec2(sin(ang), -cos(ang));
    vec2 d = p - src;
    float along = dot(d, dir);
    if (along < 0.0) continue;
    float across = abs(d.x * dir.y - d.y * dir.x);
    float width = 0.012 + along * 0.09;
    float beam = exp(-pow(across / width, 2.0)) * exp(-along * 0.35);
    vec3 gelA = pal(fract(fi * 0.13 + c0 * 0.21));
    vec3 gelB = pal(fract(fi * 0.13 + (c0 + 1.0) * 0.21));
    vec3 bc = calm > 0.5 ? vec3(0.85, 0.9, 1.0) : mix(gelA, gelB, cf);
    col += bc * beam * haze * punch * 0.36;
    col += mix(bc, vec3(1.0), 0.6) * glow(length(p - src), 0.012) * punch * 0.4;
  }
  // The truss: a dark girder across the top with a glint along it.
  float truss = smoothstep(0.02, 0.0, abs(p.y - 0.97) - 0.03);
  float lattice = step(0.5, fract(p.x * 25.0 + (p.y - 0.97) * 25.0));
  col = mix(col, vec3(0.02) + uPalMid.rgb * 0.02 * lattice, truss * 0.9);
  // The strobe is the stage's: it lands behind the crowd.
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.25;

  // --- the crowd ---
  vec3 rimC = wallLight * 0.8 + mix(uPalHigh.rgb, vec3(1.0), 0.3) * punch * 0.08;
  if (p.y < deck + 0.05) {
    float want = 0.08 + 0.3 * drive + 0.45 * uArc.y + 0.8 * drop;
    // Three rows, packed tighter the further back they stand: two rows left
    // the back row's shoulders showing as a fence of columns between them.
    for (int row = 0; row < 3; row++) {
      float fr = float(row) * 0.5;
      float R0 = row == 0 ? 0.026 : row == 1 ? 0.039 : 0.057;
      float cw = row == 0 ? 0.068 : row == 1 ? 0.105 : 0.17;
      float yh = row == 0 ? deck - 0.13 : row == 1 ? mix(deck - 0.13, -0.96, 0.5) : -0.96;
      float c0r = floor(p.x / cw + fr);
      for (int j = -1; j <= 1; j++) {
        float ci = c0r + float(j);
        vec3 h = hash32(vec2(ci, float(row) * 17.0 + 5.0));
        if (row == 0 && h.z < 0.1) continue;
        float R = R0 * (0.86 + 0.28 * fract(h.x * 13.7));
        float x = (ci + 0.5 - fr + (h.x - 0.5) * 0.4) * cw;
        float y = yh + (h.y - 0.5) * 1.1 * R;
        y += drive * (1.0 - calm) * sin(PI * fract(uPhase.x + h.z * 0.2)) * 0.45 * R;
        float lean = calm * sin(bars * PI * 0.5 + h.x * 6.0) * 0.5;
        float pump = 1.0 + 0.12 * hit;
        float rR = smoothstep(h.y, h.y + 0.25, want) * pump;
        float rL = smoothstep(h.z, h.z + 0.25, want * (h.x > 0.45 ? 1.0 : 0.55)) * pump;
        vec2 q = (p - vec2(x, y)) / R;
        if (abs(q.x) > 7.0 || q.y > 8.0) continue;
        float sd = crowdPerson(q, rL, rR, lean);
        float up = crowdPerson(q + vec2(0.0, 0.4), rL, rR, lean);
        float rim = sat((up - sd) / 0.4) * smoothstep(-0.4, 0.0, sd) * smoothstep(-1.7, -0.7, q.y);
        vec3 body = uPalBg.rgb * 0.035 + rimC * 0.01;
        body += rimC * rim * (0.1 + 0.2 * fract(h.z * 7.3)) * (1.0 - 0.35 * fr);
        body = mix(body, col, 0.3 * (1.0 - fr));
        col = mix(col, body, smoothstep(px, -px, sd * R));
      }
    }
  }
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    // The lighting desk: one cue per bar in a drive, one every two in a
    // quieter passage, eased over half a beat. It wraps at 400 cues, a
    // multiple of the four figures and of the gels' 100-cue cycle.
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
        if (cue >= 400 && shown >= 400) {
          cue -= 400;
          shown -= 400;
        }
        state[0] = shown;
      },
    };
  },
};
