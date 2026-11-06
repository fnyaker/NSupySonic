// PLASMA — the inside of a plasma globe.
//
// Pop, funk, soul, psych-rock, trip-hop: music that glows. A real plasma lamp
// is a glass sphere with an electrode at its heart, filaments of ionised gas
// striking from the electrode to the glass and a violet halo in the gas — a
// high-end science object, not a lava lamp.
//
//   THE GLASS is a sphere in a dark room: a hard rim, a tall softbox and a
//   small hot lamp reflected on it, a metal stem and base, and a glossy table
//   below carrying the lamp's glow and a shallow reflection of its rim.
//   Everything is laid out round the artwork (or the frame's centre), and the
//   phone puts the lamp in the free band UNDER the cover.
//   THE FILAMENTS are thin arcs of light, not blobs: each one wanders as it
//   runs out from the electrode (a travelling sine, so the bends move along
//   the arc), each has its own reach and brightness, and the core is
//   white-hot while the halo keeps the palette. Every filament is re-struck on the
//   sixteenth, and a knot of charge runs out along it to the glass.
//   THE MUSIC. The bass swells the electrode, its corona and the filaments'
//   wander; the kick sends a bright front out along every filament and a thin
//   pressure ring through the gas; the drop SPIRALS the field — the arcs bend
//   into a vortex for a beat and unwind over eight — which is a change of
//   structure, not of brightness.
//
// Parameters:
//   blobs   how many filaments (4..10)   heat   how bright the plasma is
//   speed   the field's rate (x)

import { onStamp } from "./kit.js";

export default {
  id: "plasma",
  uses: [],
  params: { blobs: 9, heat: 1, speed: 1 },
  look: { exposure: 1.0, bloom: 0.85, threshold: 0.95, saturation: 1.15 },

  fragment: `
float wrapA(float a) { return mod(a + PI, TAU) - PI; }
// The plasma's own cast: the palette's hue with the blue-violet an ionised gas
// actually has. A lean, not a replacement: the skin still decides the colour.
vec3 elec(vec3 c) { return mix(c, vec3(0.30, 0.38, 1.0), 0.42); }
// A rounded box, so the lamp's base has a machined edge and no extra chunk.
float rbox2(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

float standH() { return 0.052; }
// The electrode: centred, or in the free band under the artwork on a phone.
vec2 lampCore() {
  if (uHole.z > 0.0) {
    float room = max(0.24, -1.0 - uHoleR.z);
    float R = clamp(room * 0.36, 0.12, 0.42);
    return vec2(0.0, uHoleR.z - R - room * 0.06);
  }
  return vec2(0.0, 0.18);
}
float lampR() {
  if (uHole.z > 0.0) return clamp((-1.0 - uHoleR.z) * 0.36, 0.12, 0.42);
  return 0.79;
}

// The room, as the glass reflects it: a tall softbox on the left, a small hot
// lamp upper right, the cove line at the back. Sharp edges, because a
// reflection with soft edges reads as fog.
vec3 glassRoom(vec3 r, float aa) {
  float az = atan(r.x, max(r.z, 1e-3));
  // The far wall: near-black, a touch of sky at the top, so the glass has a
  // dark room to reflect and not a void.
  vec3 c = mix(vec3(0.010, 0.012, 0.022), vec3(0.055, 0.062, 0.095), smoothstep(-0.6, 0.95, r.y));
  // A tall strip light near the left limb: a lit diffuser with two soft
  // shoulders and a hot middle. Its reflection lands on the glass's flank,
  // where the sphere's own curvature bends it.
  float aw = abs(az + 1.34 + 0.35 * (r.y - 0.1));
  float ends = smoothstep(0.46, 0.36, abs(r.y - 0.02));
  float frame = smoothstep(0.125, 0.070, aw) * ends;
  float hot = smoothstep(0.045, 0.018, aw) * ends;
  c += mix(vec3(0.80, 0.86, 1.0), uPalHigh.rgb, 0.14) * frame * 3.0;
  c += mix(vec3(0.97, 0.98, 1.0), uPalHigh.rgb, 0.05) * hot * 2.5;
  // A small, hard lamp upper right: the second light of the shot.
  float dotb = smoothstep(0.05, 0.028, length(vec2(az - 0.62, r.y - 0.46)));
  c += mix(vec3(1.0), uPalAcc.rgb, 0.12) * dotb * 7.0;
  // The ceiling, and a dim floor line: the rim light that makes the sphere
  // read as a ball and not as a disc.
  c += mix(vec3(0.8, 0.85, 1.0), uPalHigh.rgb, 0.15) * smoothstep(0.4, 0.95, r.y) * 0.05;
  c += mix(uPalLow.rgb, uPalMid.rgb, 0.5) * exp(-pow((r.y + 0.35) / 0.08, 2.0)) * 0.06;
  return c;
}

// One filament's angular path at radius u (0 at the electrode, 1 at the
// glass), and its derivative, so the line's distance is measured perpendicular
// to the curve rather than along the circle it crosses. Each filament has its
// own direction, frequencies and phase: nine copies of one curve read as a
// turbine, not as plasma.
vec2 filament(float fi, float u, float beats, float wob, float vortex, vec3 h) {
  float a0 = fi * TAU / 9.0 + (h.x - 0.5) * 0.95 + beats * 0.018;
  float dir = h.z > 0.5 ? 1.0 : -1.0;
  float k1 = 1.9 + 1.3 * h.y;
  float k2 = 5.1 + 2.6 * h.z;
  float p1 = h.z * TAU;
  float p2 = h.x * TAU + 1.7;
  float arg1 = u * k1 - beats * (0.6 + 0.5 * h.y) + p1;
  float arg2 = u * k2 + beats * (1.0 + 0.6 * h.z) + p2;
  float w = sin(arg1) + 0.42 * sin(arg2);
  float wood = (0.28 + u);
  float a = a0 + dir * wob * wood * w
          + vortex * (2.6 * u + 0.35 * sin(u * 2.7 - beats * 1.3 + p1));
  float du = dir * wob * (wood * (k1 * cos(arg1) + 0.42 * k2 * cos(arg2)) + w)
           + vortex * (2.6 + 0.945 * cos(u * 2.7 - beats * 1.3 + p1));
  return vec2(a, du);
}

// The plasma glow of one arc, in the units the picture is drawn in. The
// brightness is the filament's own share of the field; the front and the drop's ring are
// the same radius for every arc, so they are computed once outside the loop.
vec3 arc(vec2 q, float ang, float rr, float R, float u, float px, float beats,
         float wob, float vortex, float heat, float bright,
         float waveAll, float dropAll, vec3 h, float fi) {
  vec2 ad = filament(fi, u, beats, wob, vortex, h);
  float diff = wrapA(ang - ad.x);
  float den = sqrt(1.0 + (u * ad.y) * (u * ad.y));
  // Perpendicular distance to the curve, in p units.
  float d = abs(diff) * rr / den;
  vec3 fc = mix(elec(mix(uPalHigh.rgb, uPalAcc.rgb, h.z * 0.4)), vec3(0.9, 0.93, 1.0), 0.72);
  // The arc is not a smooth tube: it chatters along its length, the way an
  // arc re-strikes through the gas.
  float chat = 0.82 + 0.18 * sin(u * 61.0 + beats * 6.5 + h.x * TAU) * sin(u * 23.0 - beats * 4.0 + h.y * TAU);
  float w = ((0.0026 + 0.0014 * h.y) * (1.0 + 0.5 * u) + px * 0.75) * (0.9 + 0.22 * chat);
  float xl = d / w;
  float line = exp(-xl * xl);
  float xh = d / (w * 0.42);
  float hot = exp(-xh * xh);
  float halo = glow(d, w * 4.2);
  // Re-struck on the sixteenths; the hats make it sparkle.
  float strike = 0.55 + 0.75 * hash11(floor(beats * 4.0) + fi * 7.0);
  strike *= 1.0 + 0.3 * uHit2.x;
  // A knot of charge travelling out to the glass; the kick's front and the
  // drop's ring are the same radius for every filament, computed once.
  float xk = (u - fract(beats * 0.36 + h.x)) / 0.06;
  float knot = exp(-xk * xk);
  float wave = waveAll;
  float dwave = dropAll;
  float b = bright * (0.6 + 0.6 * uFlow.x + 0.7 * uBandA.x) * strike;
  vec3 outC = fc * (line * 0.55 + hot * 0.9) * chat * (1.3 + 3.0 * knot + 2.3 * wave + 2.0 * dwave) * b * (1.1 - 0.32 * u);
  outC += elec(mix(uPalHigh.rgb, uPalMid.rgb, 0.55)) * halo * (0.26 + 0.44 * knot + 0.34 * wave) * b;
  // The contact point on the glass: a hot bead, brightest on the kick.
  float tr = rr - R * 0.962;
  float tipOn = bright > 0.4 ? 1.0 : 0.25;
  float tip = exp(-(d * d + tr * tr) / ((0.012 + px) * (0.012 + px)));
  outC += mix(fc, vec3(1.0), 0.6) * (tip * 1.6 + glow(d, 0.018) * 0.20 * exp(-pow(tr / 0.04, 2.0)))
        * (1.8 + 2.2 * uHit.y) * heat * bright * tipOn;
  return outC;
}

void main() {
  vec2 p = fragP();
  float px = uFrame.w;
  float beats = uClock.x * uSpeed * P_SPEED;
  float amp = 0.6 + 0.4 * uCtl.x;

  vec2 c = lampCore();
  float R = lampR();
  vec2 q = p - c;
  float rr = length(q);
  float ang = atan(q.y, q.x);
  float u = rr / R;
  float inGlass = smoothstep(R + px, R - px, rr);
  float bass = clamp(0.55 * uBandA.x + 0.65 * uPump.x, 0.0, 1.0);
  float vortex = uS0.x;
  float heat = (0.75 + 0.5 * uFlow.x + 0.6 * bass) * P_HEAT;
  float ty = c.y - R - standH();

  // --- the room ------------------------------------------------------------
  // A near-black studio wall, a little lighter at the bottom where the lamp
  // and the table throw their light.
  vec3 col = mix(uPalBg.rgb * 0.13, vec3(0.010, 0.011, 0.019), smoothstep(-0.9, 0.95, p.y));
  col += mix(uPalLow.rgb, uPalMid.rgb, 0.5) * smoothstep(-0.3, 1.0, p.y) * 0.008;
  // A tight halo round the glass: the lamp lights the air it sits in.
  col += mix(uPalLow.rgb, uPalMid.rgb, 0.5) * exp(-max(rr - R, 0.0) * 4.2) * 0.018 * heat;

  // --- the glass ----------------------------------------------------------
  if (inGlass > 0.001) {
    float rn = clamp(rr / R, 0.0, 1.0);
    float nz = sqrt(max(0.0, 1.0 - rn * rn));
    vec2 nxy = q / R;
    vec3 n = vec3(nxy, nz);
    vec3 rv = reflect(normalize(vec3(nxy * 0.55, -1.0)), n);
    float aa = max(0.006, px / R * 1.1);
    float fres = 0.12 + 0.55 * pow(1.0 - nz, 2.5);
    // The room BEHIND the glass, dimmed by the gas, plus the glass's own
    // reflection of the studio.
    vec3 gas = col * 0.14 + vec3(0.003, 0.003, 0.008);
    gas += elec(mix(uPalLow.rgb, uPalMid.rgb, 0.4)) * exp(-rr / (R * 0.6)) * 0.010 * heat;
    gas += glassRoom(rv, aa) * (0.16 + fres * 1.45);
    // The edge: a hairline of thickness, then a rim that is bright only on the
    // side reflecting the strip. Elsewhere the glass simply stops.
    float rimL = luma(glassRoom(rv, aa));
    gas += mix(uPalHigh.rgb, vec3(1.0), 0.75) * exp(-pow((rr - R) / (px * 0.8), 2.0))
         * (0.008 + 0.075 * rimL + 0.05 * bass + 0.14 * uHit.y * amp);
    col = mix(col, gas, inGlass);
  }

  // --- the electrode -------------------------------------------------------
  float coreR = R * (0.072 + 0.010 * bass + 0.020 * uHit.y * amp);
  float cr = rr;
  // The corona, its ring and the flare live outside the ball's branch: a
  // clipped glow shows its clip as a circle.
  col += mix(uPalHigh.rgb, vec3(1.0), 0.75) * exp(-max(cr - coreR, 0.0) / (coreR * 0.48)) * 0.34 * heat;
  // A short flare off the hot point: the eye's own bloom, sharp and local.
  float flare = exp(-pow(abs(q.y) / (coreR * 0.075), 2.0)) * exp(-abs(q.x) / (coreR * 0.8));
  col += vec3(1.0, 0.97, 1.0) * flare * 0.40 * (0.45 + uHit.y);
  {
    // The stem down to the base: a dark line with one lit edge, behind the
    // plasma so the arcs cross it.
    float stem = smoothstep(0.005 + px, 0.005 - px, abs(q.x)) * smoothstep(coreR * 0.2, coreR * 0.7, cr)
               * step(ty + standH() - 0.01, p.y) * smoothstep(c.y, c.y - coreR * 0.3, p.y);
    vec3 stemC = vec3(0.008, 0.008, 0.014) + uPalLow.rgb * 0.02;
    col = mix(col, stemC, stem * 0.92);
    col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * exp(-pow((q.x - 0.005) / (0.002 + px), 2.0)) * stem * 0.12;
  }

  // --- the filaments -------------------------------------------------------
  // Fewer arcs on a weak device: the field thins, it does not change kind.
  int n = int(clamp(P_BLOBS * mix(0.55, 1.0, uQual.x), 4.0, 10.0));
  float wob = (0.055 + 0.06 * bass + 0.05 * uHit.y * amp) * (1.0 + 0.7 * vortex);
  float front = uSince.y * (2.4 + 1.0 * uFlow.x);
  float frontE = envB(uSince.y, 0.85) * amp;
  float ring = uSince.w * 2.4;
  float ringE = envB(uSince.w, 1.6) * step(uSince.w, 6.0) * 0.55;
  float spanIn = smoothstep(coreR * 0.7, coreR * 1.4, rr);
  float spanOut = smoothstep(R * 1.0, R * 0.93, rr);
  float span = spanIn * spanOut;
  float xw = (rr - front) / 0.06;
  float waveAll = exp(-xw * xw) * frontE;
  float xd = (rr - ring) / 0.06;
  float dropAll = exp(-xd * xd) * ringE;
  if (span > 0.0) {
    for (int i = 0; i < 10; i++) {
      if (i >= n) break;
      float fi = float(i);
      vec3 h = hash31(fi * 17.3 + 3.1);
      // Some filaments stop short of the glass, some are dimmer: a field,
      // not a fan.
      float len = 0.90 + 0.10 * h.z;
      float reach = smoothstep(len, len - 0.05, u);
      col += arc(q, ang, rr, R, u, px, beats, wob, vortex, heat,
                 0.75 + 0.5 * h.y, waveAll, dropAll, h, fi) * span * reach;
    }
  }

  // --- the electrode's ball, over the arcs' roots ---------------------------
  {
    float inside = smoothstep(coreR + px, coreR - px, cr);
    float bn = sqrt(max(0.0, 1.0 - min(1.0, (cr / coreR) * (cr / coreR))));
    vec3 n = normalize(vec3(q / max(coreR, 1e-4), bn));
    // A small white-hot ball with a hard edge and one specular: the source the
    // filaments leave. The corona round it does the atmosphere.
    vec3 ball = mix(vec3(1.0, 0.985, 1.0), elec(uPalHigh.rgb), 0.22) * (2.4 + 1.8 * bn);
    ball += mix(uPalHigh.rgb, vec3(1.0), 0.85) * pow(1.0 - bn, 2.5) * 1.2;
    float spec = pow(clamp(dot(n, normalize(vec3(-0.42, 0.68, 0.60))), 0.0, 1.0), 40.0);
    ball += vec3(1.0, 0.98, 1.0) * spec * 1.2;
    col = mix(col, ball, inside);
    // A one-pixel dark rim: the ball is a solid object inside the discharge.
    float outl = exp(-pow((cr - coreR - px * 1.2) / (px * 0.9), 2.0));
    col *= mix(1.0, 0.45, outl * (1.0 - inside));
  }

  // The pressure ring through the gas: one thin line, not a fog bank.
  col += elec(uPalHigh.rgb) * exp(-pow((rr - uSince.y * 3.0) / (px * 1.6), 2.0))
       * envB(uSince.y, 1.1) * amp * 0.12 * inGlass;

  // --- the base and the table ---------------------------------------------
  float baseTop = c.y - R + 0.024;
  float baseY = ty;
  if (p.y < baseTop + 0.01 && p.y > baseY - 0.02) {
    float bw = R * 0.40 * (0.92 + 0.08 * smoothstep(baseTop, baseY, p.y));
    float dbase = rbox2(vec2(p.x - c.x, p.y - (baseTop + (baseY - baseTop) * 0.5)),
                        vec2(bw, (baseTop - baseY) * 0.5), 0.006);
    if (dbase < 0.0) {
      vec3 base = vec3(0.007, 0.008, 0.012) + uPalBg.rgb * 0.04;
      base += mix(uPalHigh.rgb, vec3(1.0), 0.5) * exp(-pow((p.x - c.x + bw) / (0.008 + px), 2.0)) * 0.16;
      base += mix(uPalHigh.rgb, vec3(1.0), 0.5) * exp(-pow((p.y - baseTop) / (0.004 + px), 2.0))
            * (0.16 + 0.30 * bass + 0.4 * uHit.y);
      col = mix(col, base, smoothstep(px, -px, dbase));
    }
  }
  if (p.y < baseY) {
    float below = baseY - p.y;
    // A black glass table: the lamp's pool of light and the soft smear of its
    // glass just under the surface. No rim line — a drawn circle is not a
    // reflection.
    col = mix(uPalBg.rgb * 0.035, vec3(0.003, 0.004, 0.008), smoothstep(0.0, 0.5, below));
    col += mix(uPalMid.rgb, vec3(1.0), 0.55) * exp(-pow((p.x - c.x) / (R * 1.4), 2.0)) * exp(-below * 6.0) * 0.055 * heat;
    // The lamp's vertical smear on the black glass, not a drawn circle.
    col += elec(uPalMid.rgb) * exp(-pow((p.x - c.x) / (R * 0.55), 2.0)) * exp(-below * 4.0) * 0.025 * heat;
    // The lit collar's reflection, a short bright bar under the stand.
    col += mix(uPalHigh.rgb, vec3(1.0), 0.6) * exp(-pow((p.x - c.x) / (R * 0.5), 2.0))
         * exp(-below / (0.010 + px)) * 0.10 * (0.6 + 0.4 * bass);
    // The table's back edge, where the surface turns away.
    col += mix(uPalLow.rgb, uPalMid.rgb, 0.5) * exp(-pow(below / (0.003 + px), 2.0)) * 0.045;
  }

  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.10;
  col *= mix(0.14, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    let vortex = 0;
    let dropAt = -1;
    const drop = onStamp((m) => m.stamp.drop, () => {
      dropAt = 0;
      flash(0.5);
    });
    return {
      step(dt, m) {
        drop(m);
        // The field screws into a vortex over one beat, then unwinds over
        // eight — a structure the eye can follow, not a flash.
        if (dropAt >= 0) {
          dropAt += dt / m.beat;
          vortex = dropAt < 1 ? dropAt : Math.max(0, 1 - (dropAt - 1) / 8);
          if (dropAt > 9) dropAt = -1;
        }
        state[0] = vortex * vortex * (3 - 2 * vortex);
      },
    };
  },
};
