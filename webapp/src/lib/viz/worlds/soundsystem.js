// SOUND SYSTEM — the wall of speakers, pumping.
//
// Tribe, hardtek, raggatek, dub: music that is inseparable from the rig it is
// played on, a wall of home-built cabinets stacked higher than the crowd. So
// the picture is the wall itself, filling the frame — subs at the bottom,
// mid cabinets above them, horns on top — every cone moving with ITS part of
// the spectrum:
//
//   THE CONES are shaded as the objects they are, not drawn as circles: a
//   metal basket rim, the rubber surround rolling round the edge, the paper
//   cone falling away toward the centre with its pressed ridges, the dome of
//   the dust cap catching a highlight. Every one of those surfaces has a
//   normal, and the light that sweeps across the wall slides over them, so
//   the rig reads as hardware under a lamp.
//   THE EXCURSION is each band's own level: the subs pump with the sub, the
//   mids with the mids, the horns with the top end. A cone pushed out swells a
//   little, catches more light, and its surround stretches flat.
//   THE PRESSURE. Every main kick sends a ring of displaced air out of each
//   sub, bending the picture as it passes; a big kick shakes the whole stack.
//   THE LIGHTS: two coloured lamps sweep the wall on the bar, a UV line
//   glows along the cabinet seams, and the drop fires a white wash from the
//   front.
//
// Parameters:
//   cols    cabinets across (on a 16:9 frame)    shake   how hard a big kick
//   rings   pressure rings strength                       shakes the stack
//   uv      seam glow

import { onStamp } from "./kit.js";

export default {
  id: "soundsystem",
  uses: ["noise", "crowd"],
  params: { cols: 7, rings: 1, shake: 1, uv: 1 },
  look: { exposure: 1.05, bloom: 1.1, threshold: 0.8, saturation: 1.1 },

  fragment: `
// A cone driver of radius R at c, pushed out by e (0..1). Returns its colour
// under the lights, and writes its face normal for the specular.
vec3 cone(vec2 p, vec2 c, float R, float e, vec3 L1, vec3 L2, vec3 c1, vec3 c2, float px, out float cov) {
  vec2 d = p - c;
  float rr = length(d) / R;
  // A cone pushed out swells a little.
  rr /= 1.0 + 0.045 * e;
  vec2 dir = d / max(length(d), 1e-5);
  cov = smoothstep(1.02, 1.02 - px / R * 1.5, rr);
  vec3 n = vec3(0.0, 0.0, 1.0);
  vec3 alb = vec3(0.02);
  float gloss = 16.0;
  if (rr < 0.26) {
    // The dust cap: a dome.
    float z = sqrt(max(1.0 - pow(rr / 0.26, 2.0), 0.0));
    n = normalize(vec3(dir * rr / 0.26, z * (1.4 - 0.6 * e)));
    alb = vec3(0.03);
    gloss = 40.0;
  } else if (rr < 0.8) {
    // The cone: falling toward the centre, pressed with ridges.
    float slope = 0.55 - 0.35 * e;
    // Ridges only where they are wider than a pixel, or they alias to moiré.
    float fine = smoothstep(0.35, 0.08, px / R * 70.0);
    float ridge = sin(rr * 70.0) * 0.08 * smoothstep(0.26, 0.4, rr) * fine;
    n = normalize(vec3(-dir * (slope + ridge), 1.0));
    alb = vec3(0.018) * (0.9 + 0.1 * sin(rr * 35.0));
    gloss = 8.0;
  } else if (rr < 0.93) {
    // The surround: a half-roll of rubber, flattened as the cone pushes out.
    float u = (rr - 0.8) / 0.13 * 2.0 - 1.0;
    float roll = 1.0 - 0.6 * e;
    n = normalize(vec3(dir * u * roll, sqrt(max(1.0 - u * u, 0.0)) + 0.2));
    alb = vec3(0.012);
    gloss = 22.0;
  } else {
    // The basket rim: brushed metal, with bolts.
    n = vec3(0.0, 0.0, 1.0);
    alb = vec3(0.05);
    gloss = 60.0;
    float bolt = smoothstep(0.035, 0.02, length(vec2(fract(atan(d.y, d.x) / TAU * 8.0) - 0.5, (rr - 0.965) * 6.0)));
    alb += vec3(0.1) * bolt;
  }
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 col = alb * (0.4 + 0.6 * max(dot(n, L1), 0.0)) * c1 + alb * max(dot(n, L2), 0.0) * c2;
  col += c1 * pow(max(dot(reflect(-L1, n), V), 0.0), gloss) * 0.35;
  col += c2 * pow(max(dot(reflect(-L2, n), V), 0.0), gloss) * 0.35;
  return col;
}

// The crowd in front of the rig — the same people as every crowd in the
// catalogue (the shared \`crowd\` chunk): two rows seen from behind, lit from
// behind by the wall, bobbing on the beat, hands going up through the build
// and all at once on the drop. One field for the whole crowd, so the rim
// light runs round its outline and never between two people standing
// together. Returns the silhouette's coverage and writes its rim light.
float crowd(vec2 p, out float rim) {
  float want = 0.05 + 0.3 * uFlow.x + 0.45 * uArc.y + 0.8 * envB(uSince.w, 8.0) * step(uSince.w, 16.0);
  float body = 1e3;
  for (int row = 0; row < 2; row++) {
    float fr = float(row);
    float R0 = row == 0 ? 0.03 : 0.05;
    float cw = row == 0 ? 0.08 : 0.14;
    float yh = row == 0 ? -0.83 : -0.96;
    float c0 = floor(p.x / cw + 0.5 * fr);
    for (int j = -1; j <= 1; j++) {
      float ci = c0 + float(j);
      vec3 h = hash32(vec2(ci, fr * 13.0 + 2.0));
      float R = R0 * (0.86 + 0.28 * fract(h.x * 13.7));
      float x = (ci + 0.5 - 0.5 * fr + (h.x - 0.5) * 0.4) * cw;
      float y = yh + (h.y - 0.5) * 1.1 * R + envB(uSince.x, 0.3) * 0.35 * R * (0.6 + 0.8 * h.z);
      float rR = smoothstep(h.y, h.y + 0.25, want);
      float rL = smoothstep(h.z, h.z + 0.25, want * (h.x > 0.45 ? 1.0 : 0.55));
      vec2 q = (p - vec2(x, y)) / R;
      if (abs(q.x) > 7.0 || q.y > 8.0) continue;
      body = min(body, crowdPerson(q, rL, rR, 0.0) * R);
    }
  }
  rim = exp(-pow(max(body, 0.0) / (uFrame.w * 1.5), 2.0)) * step(0.0, body);
  return smoothstep(uFrame.w, -uFrame.w, body);
}

void main() {
  vec2 p0 = fragP();
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  // The stack shakes on a big kick: a few pixels, decaying in a beat.
  float shake = envB(uSince.y, 0.35) * uHit.z * P_SHAKE * amp;
  vec2 ps = p0 + vec2(sin(uClock.x * 71.0), cos(uClock.x * 53.0)) * 0.006 * shake;
  // Looking UP at the stack: the verticals converge toward the top.
  float lift = 1.0 + 0.16 * (ps.y + 1.0);
  vec2 p = vec2(ps.x * lift, -1.0 + (ps.y + 1.0) * (1.0 + 0.05 * (ps.y + 1.0)));
  vec2 fw = frameHalf();
  float px = uFrame.w * lift;

  // --- the pressure rings out of the subs bend the picture ---
  float cols = max(3.0, floor(P_COLS * fw.x / 1.78 + 0.5));
  float ringAge = uSince.y;
  float ringR = ringAge * 0.9;
  float ringA = exp(-ringAge * 1.2) * P_RINGS * amp * step(ringAge, 3.0);
  vec2 warp = vec2(0.0);
  float ringLight = 0.0;
  {
    float cw0 = 2.0 * fw.x * 1.2 / cols;
    for (int i = 0; i < 3; i++) {
      float cx = (floor(p.x / cw0) + float(i) - 1.0 + 0.5) * cw0;
      vec2 dd = p - vec2(cx, -0.72);
      float dl = length(dd);
      float w = exp(-pow((dl - ringR) / 0.05, 2.0)) * ringA;
      warp += dd / max(dl, 1e-4) * w * 0.02;
      ringLight += w;
    }
  }
  p += warp;

  // --- the rows: two of subs, one of mids, one of horns, each with its own
  // cabinet count so the stack is built, not tiled ---
  float y = p.y + 1.0;
  float kind;
  float y0;
  float hRow;
  float n;
  if (y < 1.1) { kind = 0.0; hRow = 0.55; y0 = floor(y / 0.55) * 0.55; n = cols; }
  else if (y < 1.6) { kind = 1.0; hRow = 0.5; y0 = 1.1; n = cols + 1.0; }
  else { kind = 2.0; hRow = 0.46; y0 = 1.6; n = cols + 2.0; }
  float span = 2.0 * fw.x * 1.2;
  float cw = span / n;
  float xo = kind == 1.0 ? cw * 0.5 : 0.0;
  float gx = (p.x + xo) / cw;
  float cx = floor(gx);
  vec2 f = vec2(fract(gx), (y - y0) / hRow);
  vec2 cc = vec2((cx + 0.5) * cw - xo, y0 + hRow * 0.5 - 1.0);

  // The lamps: two coloured lights sweeping the wall on the bar.
  float sw = sin(bars * PI * 0.5);
  vec3 L1 = normalize(vec3(-p.x + sw * 1.6, 1.6 - p.y, 1.4));
  vec3 L2 = normalize(vec3(-p.x - sw * 1.6, 1.4 - p.y, 1.4));
  vec3 c1 = mix(uPalMid.rgb, uPalHigh.rgb, 0.3) * 1.6 * (0.6 + 0.4 * uFlow.x);
  vec3 c2 = mix(uPalLow.rgb, uPalAcc.rgb, 0.5) * 1.4 * (0.6 + 0.4 * uFlow.x);
  // The drop's wash from the front, and the kick's strobe on the metal.
  vec3 wash = vec3(1.0) * (envB(uSince.w, 1.0) * step(uSince.w, 8.0) * 1.5 + 0.8 * uHit.y * amp);
  c1 += wash * 0.5;
  c2 += wash * 0.5;

  // The cabinet: dark tolex, a bevelled edge, a thin seam of UV light.
  vec2 ed = min(f, 1.0 - f) * vec2(cw, hRow);
  float edge = min(ed.x, ed.y);
  float tolex = 0.012 + 0.006 * gnoise(p * 90.0);
  vec3 col = vec3(tolex) * (0.5 + 0.5 * L1.z) * c1;
  float bevel = smoothstep(0.012, 0.004, edge) - smoothstep(0.004, 0.0, edge);
  col += (c1 + c2) * bevel * 0.04;
  float seam = exp(-pow(edge / (px * 1.2), 2.0));
  col += uPalAcc.rgb * seam * (0.04 + 0.35 * uHit.y * amp) * P_UV;

  float cov = 0.0;
  if (kind < 0.5) {
    float R = min(cw, hRow) * 0.44;
    float e = clamp(uBandA.x * 1.1 + 0.5 * uHit.x, 0.0, 1.0) * amp;
    col = mix(col, cone(p, cc, R, e, L1, L2, c1, c2, px, cov), cov);
  } else if (kind < 1.5) {
    float R = min(cw * 0.5, hRow) * 0.42;
    float e = clamp(uBandA.z * 1.2 + 0.3 * uHit.x, 0.0, 1.0) * amp;
    float side = f.x < 0.5 ? -1.0 : 1.0;
    vec2 c = cc + vec2(side * cw * 0.25, 0.0);
    col = mix(col, cone(p, c, R, e, L1, L2, c1, c2, px, cov), cov);
  } else {
    // A horn: a flared mouth with a compression driver at its throat.
    vec2 q = (p - cc) / vec2(cw * 0.44, hRow * 0.4);
    float mouth = sdBox2(q, vec2(1.0, 1.0));
    float e = clamp(uBandB.x * 1.4, 0.0, 1.0) * amp;
    if (mouth < 0.0) {
      float depth = max(abs(q.x), abs(q.y));
      vec2 dir = abs(q.x) > abs(q.y) ? vec2(sign(q.x), 0.0) : vec2(0.0, sign(q.y));
      vec3 nn = normalize(vec3(-dir * (0.9 - 0.6 * depth), 1.0));
      vec3 hc = vec3(0.025) * (0.3 + max(dot(nn, L1), 0.0)) * c1 + vec3(0.02) * max(dot(nn, L2), 0.0) * c2;
      hc += c1 * pow(max(dot(reflect(-L1, nn), vec3(0.0, 0.0, 1.0)), 0.0), 20.0) * 0.2;
      hc += mix(uPalHigh.rgb, vec3(1.0), 0.3) * exp(-depth * 7.0) * (0.1 + 1.2 * e);
      col = mix(col, hc, smoothstep(0.0, -px * 30.0, mouth));
    }
  }
  // Haze in front of the wall, lit by the lamps from the top corners.
  float beam1 = exp(-pow((p0.x - (-fw.x + 0.2) - (1.0 - p0.y) * (0.6 + 0.5 * sw)) * 2.2, 2.0));
  float beam2 = exp(-pow((p0.x - (fw.x - 0.2) + (1.0 - p0.y) * (0.6 - 0.5 * sw)) * 2.2, 2.0));
  col += (c1 * beam1 + c2 * beam2) * 0.025 * (0.5 + 0.5 * uFlow.x);
  // The air: pressure rings catch a little light.
  col += mix(uPalMid.rgb, uPalHigh.rgb, 0.5) * ringLight * 0.08;
  // The crowd, black against the lit rig.
  float rim;
  float cr = crowd(p0, rim);
  col = mix(col, uPalBg.rgb * 0.1, cr);
  col += mix(c1, c2, 0.5) * rim * 0.1;
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p0, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ flash }) {
    const drop = onStamp((m) => m.stamp.drop, () => flash(0.9));
    return {
      step(dt, m) {
        drop(m);
      },
    };
  },
};
