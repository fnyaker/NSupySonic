// PIXELS — a cathode-ray screen, a level scrolling past, and a runner.
//
// Chiptune, 8-bit, IDM, breakcore, hyperpop, glitch, grime: music made of or
// about the machines that drew in pixels. So the picture IS a machine's
// picture — a low-resolution raster on a tube — and everything in it is
// rasterised honestly: every shape is evaluated once, at the centre of its
// virtual pixel, so the edges are the stair-steps pixel art is made of, and
// the colours come off a limited ramp with an ordered (Bayer) dither between
// its steps, the way a sixteen-bit sunset was.
//
//   THE RUNNER is a figure built from limbs and rasterised at that grid —
//   not a flip-book of frames — so its stride is continuous, a step per half
//   beat, and it changes gait with the music: a run while it drives, a walk
//   through a breakdown, a hop on every other snare, and a somersault on the
//   drop. A scarf streams behind it; the ground puffs dust where it lands.
//   THE LEVEL scrolls under it at the tempo, in parallax: a planet with a
//   ring in the sky, a skyline with lit windows and an antenna beacon that
//   blinks on the beat, stars that twinkle with the hats, speed lines through
//   a build. Coins hang in the runner's way in the rows that drive.
//   THE PIXELS JUMP. The spectrum stands behind the runner as columns of
//   bricks, each column capped by a block that falls back under gravity — a
//   peak hold computed from the history texture, max(h_k − g·k²), so it needs
//   no state of its own. And every main kick sends a ripple along the ground
//   from the runner's feet that lifts the tiles it passes, a tile at a time.
//   THE SIGNAL. Snares tear rows of the raster sideways for a sixteenth; the
//   drop tears the whole screen for a beat.
//   THE TUBE. Scanlines and an aperture grille, faded in only when a virtual
//   pixel is big enough on screen to carry them (a mask smaller than the
//   screen's own pixels is moiré, not texture), and a refresh band rolling
//   down once a bar.
//
// Parameters:
//   cell     virtual pixel size (1 = a hundred rows)    steps  colour levels
//   glitch   row tearing                                 scroll speed
//   coins    coin rows (0 hides them)                    eq     the brick equaliser

import { eventRing, onStamp } from "./kit.js";

export default {
  id: "pixels",
  uses: [],
  params: { cell: 1, steps: 8, glitch: 1, scroll: 1, coins: 1, eq: 1 },
  look: { exposure: 1.0, bloom: 1.2, threshold: 0.7, saturation: 1.2 },

  fragment: `
float bayer4(vec2 c) {
  const float B[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0,
                                3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  ivec2 i = ivec2(mod(c, 4.0));
  return (B[i.x + i.y * 4] + 0.5) / 16.0;
}

float capsule(vec2 q, vec2 a, vec2 b, float r) {
  vec2 pa = q - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// A leg from the hip, on the gait of a real run: the thigh swings on the
// stride (forward is +x); the knee is all but straight through the support
// phase and folds hardest just after toe-off, which is what puts the foot up
// under the body on the recovery. Returns the distance; the foot comes back
// through 'foot'.
float leg(vec2 q, vec2 hip, float a, float stride, float fold, float air, out vec2 foot) {
  float th = stride * sin(a) + 0.1;
  float kb = 0.15 + fold * max(cos(a + 0.3), 0.0);
  th = mix(th, 0.55 - 0.9 * step(0.0, cos(a)), air);
  kb = mix(kb, 1.5, air);
  vec2 knee = hip + 4.2 * vec2(sin(th), -cos(th));
  foot = knee + 4.2 * vec2(sin(th - kb), -cos(th - kb));
  float d = min(capsule(q, hip, knee, 1.05), capsule(q, knee, foot, 0.9));
  // The shoe: a short stub forward.
  return min(d, capsule(q, foot, foot + vec2(1.4, 0.0), 0.8));
}

float arm(vec2 q, vec2 sh, float a, float swing, float air) {
  float up = -swing * sin(a);
  up = mix(up, -2.4, air);
  vec2 el = sh + 3.4 * vec2(sin(up), -cos(up));
  float fo = up + 1.5;
  vec2 ha = el + 3.0 * vec2(sin(fo), -cos(fo));
  return min(capsule(q, sh, el, 0.75), capsule(q, el, ha, 0.7));
}

// The runner in its own frame (feet at y = 0, facing +x). part: 0 near body,
// 1 far limbs, 2 skin, 3 scarf, 4 eye.
float runner(vec2 q, float ph, float walk, float air, out float part) {
  float stride = mix(0.72, 0.4, walk);
  float fold = mix(2.0, 0.6, walk);
  float swing = mix(1.0, 0.45, walk);
  float bob = (1.0 - air) * mix(0.9, 0.35, walk) * abs(cos(ph));
  float lean = mix(0.22, 0.05, walk);
  vec2 hip = vec2(0.0, 8.2 + bob);
  vec2 neck = hip + 6.0 * vec2(sin(lean), cos(lean));
  vec2 head = neck + vec2(0.9, 3.5);
  vec2 f0, f1;
  float dFarLeg = leg(q, hip, ph + PI, stride, fold, air, f1);
  float dFarArm = arm(q, neck - vec2(0.0, 0.9), ph + PI, swing, air);
  float dNearLeg = leg(q, hip, ph, stride, fold, air, f0);
  float dNearArm = arm(q, neck - vec2(0.0, 0.9), ph, swing, air);
  float dTorso = capsule(q, hip, neck, 1.75);
  float dHead = length(q - head) - 3.5;
  // The scarf: tied at the neck, streaming back in a wave that runs down it.
  float dScarf = 1e3;
  vec2 s0 = neck + vec2(0.2, 0.4);
  for (int k = 1; k <= 6; k++) {
    float fk = float(k);
    vec2 s1 = neck + vec2(-1.35 * fk, 0.6 + 0.12 * fk + sin(fk * 0.95 - uClock.x * 7.0) * 0.2 * fk * (1.0 - 0.5 * walk));
    dScarf = min(dScarf, capsule(q, s0, s1, 0.62 - 0.05 * fk));
    s0 = s1;
  }
  float near = min(min(dNearLeg, dNearArm), dTorso);
  float d = min(min(near, dHead), min(min(dFarLeg, dFarArm), dScarf));
  part = 1.0;
  float best = min(dFarLeg, dFarArm);
  if (dScarf < best) { best = dScarf; part = 3.0; }
  if (near <= best) { best = near; part = 0.0; }
  if (dHead <= best) { part = 2.0; }
  if (length(q - (head + vec2(1.7, 0.6))) < 0.75) part = 4.0;
  return d;
}

void main() {
  vec2 p = fragP();
  float amp = 0.6 + 0.4 * uCtl.x;
  // A hundred rows on a landscape frame; on a portrait one the grid is
  // finer, or a phone would get fifty columns and a runner a quarter as wide.
  float R = floor(100.0 / max(P_CELL, 0.3));
  float cell = 2.0 / R * sqrt(min(uFrame.z, 1.0));
  float halfW = uFrame.z / cell;
  float halfH = 1.0 / cell;
  float cam = uS0.x;
  float ph = uS0.y;
  float jumpY = uS0.z;
  float flip = uS0.w;
  float walk = uS1.x;
  float stepPx = uS1.y;
  float air = clamp(jumpY / 3.0, 0.0, 1.0);

  // --- the signal: snares tear rows sideways, the drop tears everything ---
  vec2 V = p / cell;
  float six = floor(uClock.x * 4.0);
  float drop = (uSince.w >= 0.0 && uSince.w < 1.0) ? 1.0 - uSince.w : 0.0;
  float tear = clamp((envB(uSince.z, 0.3) * 0.8 + drop) * P_GLITCH * amp, 0.0, 1.5);
  float bandH = 2.0 + floor(5.0 * hash11(six * 1.7 + 0.3));
  vec2 hb = hash22(vec2(floor(V.y / bandH), six));
  float torn = step(hb.x, 0.3 * tear + 0.6 * drop);
  V.x += torn * floor((hb.y - 0.5) * 30.0 * tear);
  vec2 c = floor(V) + 0.5;
  vec2 f = fract(V);

  // --- where things stand, in virtual pixels ---
  float holeBot = uHole.y - uHole.w;
  float gP = uHole.z > 0.0 ? clamp(holeBot - 21.0 * cell - 0.02, -0.86, -0.45) : -0.55;
  float G = floor(gP / cell);
  float RX = max(floor(-0.5 * halfW), -halfW + 10.0);
  float top = halfH;
  float t = clamp((c.y - G) / (top - G), 0.0, 1.0);

  // --- the sky ---
  vec3 horizonC = mix(uPalMid.rgb, uPalAcc.rgb, 0.35) * 0.42;
  vec3 midC = mix(uPalLow.rgb, uPalMid.rgb, 0.25) * 0.22;
  vec3 topC = uPalBg.rgb * 0.35 + uPalLow.rgb * 0.03;
  // The sky in flat bands, the way a limited palette draws a gradient: the
  // dither only lives in a narrow seam between two bands, never across them.
  float nb = max(P_STEPS, 2.0);
  float tb = clamp(floor(t * nb + 0.5 + (bayer4(c) - 0.5) * 0.55) / nb, 0.0, 1.0);
  vec3 col = mix(horizonC, midC, smoothstep(0.0, 0.45, tb));
  col = mix(col, topC, smoothstep(0.4, 1.0, tb));
  // Stars, a little parallax, twinkling with the hats.
  vec2 sc = c + vec2(uS1.w, 0.0);
  float sh = hash12(sc + 17.0);
  if (t > 0.3 && sh > 0.986) {
    float tw = 0.35 + 0.65 * step(0.5, hash12(sc + 3.0)) * uHit2.x + 0.3 * step(0.994, sh);
    col += mix(vec3(0.9), uPalHigh.rgb, 0.3) * tw * smoothstep(0.3, 0.6, t) * 0.7;
  }
  // Speed lines through a build.
  float build = uArc.y;
  if (build > 0.05 && t > 0.15) {
    float lr = hash11(c.y * 1.37 + 5.0);
    if (lr > 0.86) {
      float seg = fract((c.x + cam * 2.5 + lr * 300.0) / 46.0);
      col += mix(uPalHigh.rgb, vec3(1.0), 0.4) * step(seg, 0.35) * build * 0.25;
    }
  }

  // --- the planet, and its ring ---
  vec2 PC = vec2(floor(0.52 * halfW), floor(0.56 * halfH));
  float PR = 9.0;
  vec2 pd = c - PC;
  float pr = length(pd);
  vec2 rd = mat2(0.94, -0.34, 0.34, 0.94) * pd;
  float re = length(rd / vec2(PR * 1.9, PR * 0.42));
  float ring = step(abs(re - 1.0), 0.07) * step(0.88, re) + step(abs(re - 1.18), 0.045);
  vec3 ringC = mix(uPalHigh.rgb, vec3(1.0, 0.9, 0.7), 0.3) * 0.55;
  if (rd.y > 0.0 && ring > 0.0) col = mix(col, ringC * 0.7, 0.9);
  if (pr < PR) {
    vec3 n = vec3(pd / PR, sqrt(max(1.0 - pr * pr / (PR * PR), 0.0)));
    float lit = max(dot(n, normalize(vec3(-0.6, 0.5, 0.6))), 0.0);
    float stripe = step(0.5, fract(pd.y * 0.28 + 0.15 * sin(pd.x * 0.5)));
    vec3 pc = mix(uPalAcc.rgb, uPalMid.rgb, stripe * 0.6);
    col = pc * (0.05 + 0.75 * lit);
  }
  if (rd.y <= 0.0 && ring > 0.0) col = mix(col, ringC, 0.95);

  // --- the skyline ---
  float sx = c.x + uS1.z;
  float bi = floor(sx / 7.0);
  float bx = sx - bi * 7.0;
  vec3 bh3 = hash31(bi * 3.1 + 1.0);
  float bh = 5.0 + floor(bh3.x * bh3.x * 26.0);
  float yy = c.y - G;
  if (yy >= 0.0 && yy < bh && bx < 6.0) {
    col = mix(col, uPalBg.rgb * 0.1 + uPalLow.rgb * 0.06, 0.92);
    // Windows: a grid of single pixels, some lit, a few blinking with the hats.
    if (mod(bx, 2.0) >= 1.0 && mod(yy, 3.0) >= 1.0 && yy < bh - 1.0) {
      float wh = hash12(vec2(bi, floor(yy / 3.0) * 7.0 + floor(bx / 2.0)));
      float on = step(0.62, wh) + step(0.97, wh) * uHit2.x;
      col += mix(vec3(1.0, 0.8, 0.45), uPalHigh.rgb, 0.35) * on * 0.3;
    }
  }
  // The tallest carry an antenna, and a beacon on it that blinks on the beat.
  if (bh3.x > 0.72 && abs(bx - 3.5) < 0.1 && yy >= bh && yy < bh + 4.0) {
    col = uPalBg.rgb * 0.15;
  }
  if (bh3.x > 0.72 && abs(bx - 3.5) < 0.1 && yy >= bh + 4.0 && yy < bh + 5.0) {
    col = vec3(1.0, 0.2, 0.15) * (0.3 + 1.4 * uHit.x);
  }

  // --- the pixels that jump: the spectrum in bricks, caps falling back ---
  if (P_EQ > 0.01) {
    float colW = 8.0;
    float ncol = floor(2.0 * halfW / colW);
    float ci = floor((c.x + halfW) / colW);
    float ex = c.x + halfW - ci * colW;
    float maxH = min(floor(0.5 * (top - G)), 48.0) * P_EQ;
    if (ex < 7.0 && yy >= 0.0 && ci < ncol) {
      float fq = 0.02 + 0.93 * (ci + 0.5) / ncol;
      float lv = pow(texture(uSpec, vec2(fq, 0.75)).r, 1.15);
      float nbk = floor(lv * maxH / 3.0);
      float bj = floor(yy / 3.0);
      float by = yy - bj * 3.0;
      // The cap: the highest of every recent level, each fallen back by
      // gravity for as long ago as it was.
      float cap = lv * maxH;
      for (int k = 1; k <= 14; k++) {
        float fk = float(k);
        float hk = pow(texture(uHist, vec2(fq, fract(uHistHead - fk / 64.0) + 0.5 / 64.0)).r, 1.15) * maxH;
        cap = max(cap, hk - 0.45 * fk * fk);
      }
      float capJ = max(floor(cap / 3.0), nbk);
      vec3 bc = pal(clamp(bj * 3.0 / max(maxH, 1.0), 0.0, 1.0));
      // A brick: lit on its top edge, shadowed on its right.
      if (bj < nbk && by < 2.0) {
        col = bc * (by >= 1.0 ? 0.6 : 0.4) * (ex >= 6.0 ? 0.6 : 1.0);
      } else if (bj == capJ && by < 1.0) {
        col = mix(bc, vec3(1.0), 0.55) * 0.9;
      }
    }
  }

  // --- coins in the runner's way, collected as it passes ---
  if (P_COINS > 0.01) {
    float wx = c.x + floor(cam);
    float seg = floor(wx / 64.0);
    if (hash11(seg * 5.3 + 2.0) < (0.25 + 0.55 * uFlow.x) * P_COINS) {
      float lx = wx - seg * 64.0;
      float k = floor((lx - 8.0) / 9.0);
      if (k >= 0.0 && k < 5.0) {
        float cx = seg * 64.0 + 8.0 + k * 9.0 + 4.0 - floor(cam);   // screen x of the coin
        float cy = G + 11.0 + floor(3.0 * sin(k * 0.9));
        vec2 cd = c - vec2(cx, cy);
        if (cx > RX + 2.0) {
          // A coin turning: an ellipse whose width follows the spin, with a
          // dark rim and a shine down its face.
          float w = 0.6 + 2.9 * abs(cos(uClock.x * PI * 0.5 + k));
          float e = length(cd / vec2(w + 0.5, 4.0));
          if (e < 1.0) {
            vec3 gold = mix(vec3(1.0, 0.76, 0.18), uPalHigh.rgb, 0.15);
            float rim = step(length(cd / vec2(max(w - 0.5, 0.3), 3.0)), 1.0);
            col = mix(gold * 0.35, gold * (cd.x < -0.4 * w ? 1.25 : 0.85), rim);
          }
        } else {
          // Just collected: a sparkle, a cross opening and fading.
          float gone = RX + 2.0 - cx;
          if (gone < 12.0) {
            float arm = 1.0 + gone * 0.5;
            float on = step(min(abs(cd.x), abs(cd.y)), 0.1) * step(max(abs(cd.x), abs(cd.y)), arm) * step(arm - 2.0, max(abs(cd.x), abs(cd.y)));
            col += mix(vec3(1.0, 0.9, 0.5), vec3(1.0), 0.5) * on * (1.0 - gone / 12.0);
          }
        }
      }
    }
  }

  // --- the ground: tiles lifted by the ripple of every main kick ---
  float wx = c.x + floor(cam);
  float tile = floor(wx / 8.0);
  float tx = tile * 8.0 + 4.0 - floor(cam);
  float lift = 0.0;
  for (int i = 0; i < 8; i++) {
    vec4 e = uEv[i];
    float age = uClock.x - e.x;
    if (e.y <= 0.0 || age < 0.0 || age > 1.5) continue;
    float d = abs(abs(tx - RX) - age * 52.0);
    lift += e.y * exp(-d * d / 60.0) * (1.0 - age / 1.5) * 3.0;
  }
  float L = min(floor(lift * amp + 0.35), 3.0);
  float surf = G + L;
  if (c.y < surf) {
    float gy = surf - c.y;
    vec3 neon = mix(uPalAcc.rgb, uPalHigh.rgb, 0.3);
    if (gy < 1.0) col = neon * (0.9 + 0.8 * envB(uSince.y, 0.4) * amp + 0.3 * step(0.5, L));
    else if (gy < 2.0) col = neon * 0.35;
    else {
      float br = floor((gy - 2.0) / 4.0);
      float bx2 = mod(wx + br * 4.0, 8.0);
      float by2 = mod(gy - 2.0, 4.0);
      vec3 brick = mix(uPalLow.rgb, uPalBg.rgb, 0.4) * 0.3 * exp(-(gy - 2.0) * 0.035);
      brick *= by2 < 1.0 ? 1.3 : 1.0;
      if (bx2 < 1.0 || by2 >= 3.0) brick *= 0.35;
      col = brick;
    }
    // The runner's shadow, shrinking as it leaves the ground.
    float sw = 5.0 - jumpY * 0.3;
    if (gy < 2.0 && abs(c.x - (RX + 0.5)) < sw && L < 0.5) col *= 0.45;
  }
  // Dust where each foot lands, left behind as the ground runs on.
  if (air < 0.5 && walk < 0.7 && c.y >= G) {
    float steps = ph / PI;
    float age = fract(steps);
    float n = floor(steps);
    for (int k = 0; k < 3; k++) {
      vec3 h = hash31(n * 3.0 + float(k));
      vec2 at = vec2(RX + 1.0 - age * stepPx - 1.0 - floor(h.x * 3.0), G + 0.5 + floor(age * (1.0 + 2.0 * h.y)));
      if (all(lessThan(abs(c - at), vec2(0.6)))) col = mix(col, mix(uPalHigh.rgb, vec3(0.9), 0.5) * 0.6, 1.0 - age);
    }
  }

  // --- the runner ---
  {
    vec2 q = c - vec2(RX, G + jumpY);
    // The somersault turns about the body's middle.
    if (flip != 0.0) {
      vec2 o = vec2(0.0, 10.0);
      float cs = cos(flip), sn = sin(flip);
      q = mat2(cs, -sn, sn, cs) * (q - o) + o;
    }
    if (abs(q.x) < 14.0 && q.y > -3.0 && q.y < 24.0) {
      float part;
      float d = runner(q, ph, walk, air, part);
      // A hero that reads on any palette: a pale suit, a warm face, a red
      // scarf, all leaning only a little toward the palette, and a black
      // outline round the whole silhouette.
      vec3 body = mix(vec3(0.85, 0.9, 1.0), uPalHigh.rgb, 0.2) * 0.95;
      vec3 skin = mix(vec3(1.0, 0.82, 0.66), uPalHigh.rgb, 0.1);
      vec3 scarf = mix(vec3(1.0, 0.16, 0.2), uPalAcc.rgb, 0.2) * 1.15;
      vec3 ink = uPalBg.rgb * 0.05;
      if (d < 0.0) {
        col = part == 0.0 ? body : part == 1.0 ? body * 0.5 : part == 2.0 ? skin : part == 3.0 ? scarf : ink;
        // Shade the lower-right of each part: a light from the upper left.
        // Pixel-art shading: a pixel whose lower-right neighbour is outside
        // the figure is on the side away from the light, and one step darker.
        if (part < 2.5) {
          float pn;
          float dn = runner(q + vec2(1.0, -1.0), ph, walk, air, pn);
          if (dn >= 0.0) col *= 0.7;
        }
      } else if (d < 1.0) {
        col = ink;
      }
    }
  }

  // --- the palette: a limited ramp, dithered between its steps ---
  float lv = 3.0 * max(P_STEPS, 2.0);
  vec3 g = sqrt(max(col, 0.0));
  g = floor(g * lv + bayer4(c)) / lv;
  col = g * g;

  // --- the tube ---
  float ppv = cell / uFrame.w;
  float scanS = smoothstep(2.5, 5.0, ppv) * 0.4;
  float prof = exp(-pow((f.y - 0.5) / 0.4, 2.0));
  col *= mix(1.0, prof * 1.45, scanS);
  float maskS = smoothstep(6.0, 12.0, ppv) * 0.4;
  vec3 m = vec3(
    smoothstep(0.34, 0.08, abs(f.x - 1.0 / 6.0)),
    smoothstep(0.34, 0.08, abs(f.x - 0.5)),
    smoothstep(0.34, 0.08, abs(f.x - 5.0 / 6.0)));
  m += smoothstep(0.34, 0.08, abs(f.x - 7.0 / 6.0)) * vec3(1.0, 0.0, 0.0) + smoothstep(0.34, 0.08, abs(f.x + 1.0 / 6.0)) * vec3(0.0, 0.0, 1.0);
  col *= mix(vec3(1.0), m * 2.1, maskS);
  // The refresh band, rolling down once a bar.
  float roll = fract(uClock.y);
  col *= 1.0 + 0.06 * exp(-pow((p.y - (1.1 - roll * 2.2)) / 0.08, 2.0));
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.15;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, params, ev, flash }) {
    const ring = eventRing(ev);
    let cam = 0;
    let ph = 0;
    let walk = 0;
    let jumpT = -1;
    let jumpDur = 1;
    let jumpH = 8;
    let flip = 0;
    let flipping = false;
    let speed = 10;
    let snares = 0;
    const main = onStamp((m) => m.stamp.main, (s, m) => ring.push(s, 0.6 + 0.4 * (m.bigKick || 0)));
    const snare = onStamp((m) => m.stamp.snare, (s, m) => {
      snares++;
      // A hop on every other snare, when the runner is running and grounded.
      if (jumpT < 0 && snares % 2 === 1 && m.breakdown < 0.5 && m.drive > 0.3) {
        jumpT = 0;
        jumpDur = 1;
        jumpH = 7 + 3 * m.drive;
        flipping = false;
      }
    });
    const drop = onStamp((m) => m.stamp.drop, () => {
      jumpT = 0;
      jumpDur = 2;
      jumpH = 18;
      flipping = true;
      flash(0.5);
    });
    return {
      step(dt, m) {
        main(m);
        snare(m);
        drop(m);
        const beats = dt / m.beat;
        walk = m.ease(walk, m.breakdown > 0.5 || m.drive < 0.2 ? 1 : 0, 2, dt);
        // A stride (two steps) per beat running, a step per beat walking, and
        // the ground runs under at the speed the stride implies.
        const want = (8 + 4 * m.drive + 6 * m.build) * (1 - 0.55 * walk) * (params.scroll ?? 1);
        speed = m.ease(speed, want, 1, dt);
        cam += speed * beats;
        const stepsPerBeat = 2 - walk;
        ph += Math.PI * stepsPerBeat * beats;
        if (ph > 1e4) ph -= 2 * Math.PI * 1000;
        let y = 0;
        if (jumpT >= 0) {
          jumpT += beats;
          const u = jumpT / jumpDur;
          if (u >= 1) {
            jumpT = -1;
            flip = 0;
            flipping = false;
          } else {
            y = 4 * jumpH * u * (1 - u);
            if (flipping) flip = -2 * Math.PI * Math.min(1, Math.max(0, (u - 0.15) / 0.7));
          }
        }
        // The ground repeats every tile (8) and every coin segment (64), so it
        // gets the scroll wrapped at a multiple of both; the skyline and the
        // stars scroll at their own parallax and get their own, already
        // floored and wrapped at a multiple of a building's width. Float32
        // uniforms, and a runner that may run all night.
        state[0] = cam % 4096;
        state[6] = Math.floor(cam * 0.22) % (7 * 1024);
        state[7] = Math.floor(cam * 0.04) % 4096;
        state[1] = ph;
        state[2] = y;
        state[3] = flip;
        state[4] = walk;
        state[5] = speed / stepsPerBeat;
      },
    };
  },
};
