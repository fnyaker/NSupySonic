// LASERS — the main stage, the lasers and the fire.
//
// There is one picture every hardstyle fan carries in their head and it is not
// a metaphor: a mainstage at night, fans of laser beams cutting through thick
// haze, and columns of fire shooting up on the kick. So this world builds that
// stage, and choreographs it to the track the way a lighting desk would.
//
//   THE BEAMS. Emitters along the foot of the frame, each throwing a fan of
//   thin beams. A beam is a line with a hot core and a wide, faint halo, and it
//   is only as visible as the haze it passes through — which is what makes a
//   laser look like a laser rather than like a line on a screen: it flickers
//   and thickens where the smoke rolls through it.
//   THE CHOREOGRAPHY. The fans sweep once per bar; the SHAPE of the show
//   changes every phrase, the way an operator changes cue on the sixteen —
//   fans sweeping together, fans crossing each other, every beam converging on
//   one point above the stage, a curtain of vertical beams. Main kicks punch
//   the beams brighter and snap the fans open; a build pulls them together and
//   speeds them up; the drop opens everything at once.
//   THE FIRE. Big kicks fire the flame projectors: columns of turbulent fire
//   that shoot up in a fraction of a beat and die over one. The heat is the
//   blackbody walk from white at the root to red at the tips.
//   THE HAZE. Rolling smoke, lit from inside by whatever passes through it.
//   THE CROWD. Two rows of silhouettes in front of the stage, which is what
//   turns a light show into a place you are standing in: they jump on the
//   beat once the track drives, raise their hands through the build — all of
//   them on the drop, fists punching on the kick — and the strobe lands
//   BEHIND them, so the drop is a wall of black figures against white light.
//
// A breakdown is two emitters sweeping slowly through heavy haze, under a
// LIQUID SKY: one projector's beam spread into a flat sheet over the crowd,
// seen from beneath as a rippling ceiling of light, with phones held up in
// the crowd. Rawstyle
// (the `raw` switch) runs hotter, darker and angrier: more fire, harder cuts,
// fewer beams; euphoric runs more beams, smoother sweeps and less fire.
//
// Parameters:
//   emitters  how many fans (wide frames)   beams  beams per fan
//   fire      pyro strength                 haze   smoke density
//   raw       0 euphoric .. 1 raw           sweep  sweep speed multiplier

import { eventRing, onStamp, hashN } from "./kit.js";

export default {
  id: "lasers",
  uses: ["noise", "sdf"],
  params: { emitters: 5, beams: 7, fire: 1, haze: 1, raw: 0.4, sweep: 1 },
  look: { exposure: 1.0, bloom: 1.35, threshold: 0.7, saturation: 1.18 },

  fragment: `
float emitterX(float e, float n) {
  float span = uFrame.z * 0.92;
  return n < 1.5 ? 0.0 : -span + 2.0 * span * e / (n - 1.0);
}

// Heat for the fire: white root, yellow body, red tips.
vec3 heat(float t) {
  t = clamp(t, 0.0, 1.0);
  return vec3(1.0, mix(0.08, 0.9, t * t), mix(0.01, 0.75, t * t * t * t)) * (0.2 + 3.4 * t * t);
}

// One column of fire, rising from \`base\`, \`age\` beats after it fired: a
// jet that shoots up in a third of a beat, a body that billows as it climbs,
// and a rounded, rolling head where the fuel runs out.
float flame(vec2 q, float age, float h, float seed) {
  float rise = 1.0 - pow(1.0 - clamp(age * 3.2, 0.0, 1.0), 3.0);
  float fade = 1.0 - smoothstep(0.4, 1.3, age);
  float height = h * rise * (0.8 + 0.3 * fade);
  // Nothing to do far from the column: this is what keeps eight events times
  // seven projectors affordable.
  if (q.y < -0.02 || q.y > height * 1.35 || height < 0.01 || abs(q.x) > 0.3) return 0.0;
  float y = clamp(q.y / height, 0.0, 1.4);
  vec2 tq = vec2(q.x * 5.0 + seed, q.y * 2.6 - uClock.x * 2.2);
  float turb = fbm(tq, 4);
  float turb2 = fbm(tq * 2.3 + 4.0, 3);
  // Narrow at the nozzle, widening as it billows, a round head on top.
  float w = mix(0.03, 0.13, smoothstep(0.0, 0.8, y)) * (1.0 + 0.5 * turb) * (1.0 - smoothstep(0.95, 1.3, y));
  float x = q.x + turb * 0.07 * y + turb2 * 0.03;
  float body = smoothstep(w, w * 0.15, abs(x));
  float head = smoothstep(1.35, 0.8, y + turb * 0.35);
  return body * head * fade * (0.6 + 0.6 * turb2 + 0.3);
}

// One person in the crowd, seen from behind, in units of their head's radius
// with the head's centre at the origin: head, neck, shoulders and a back that
// runs out of the frame, and two arms that rise from hanging (0) to straight
// up (1) through a bent elbow — the way an arm actually goes up, passing out
// to the side, rather than a stick rotating about the shoulder.
vec2 elbowAt(float sg, float r) { return vec2(1.55 * sg, -2.1) + vec2(0.75 * sg, mix(-2.5, 2.3, r)); }
vec2 handAt(float sg, float r, float lean) { return elbowAt(sg, r) + vec2(-0.35 * sg + lean, mix(-2.2, 2.4, r)); }
float personSd(vec2 q, float rL, float rR, float lean) {
  float d = length(q * vec2(1.0, 0.9)) - 1.0;
  d = smin(d, sdBox2(q - vec2(0.0, -1.35), vec2(0.5, 0.5)), 0.3);
  float sh = sdRound2(q - vec2(0.0, -2.6), vec2(2.05, 1.0), 0.9);
  float back = sdBox2(q - vec2(0.0, -9.0), vec2(1.9, 6.0));
  d = smin(d, min(sh, back), 0.35);
  for (int k = 0; k < 2; k++) {
    float sg = k == 0 ? -1.0 : 1.0;
    float r = k == 0 ? rL : rR;
    if (r < 0.02) continue;
    vec2 S = vec2(1.55 * sg, -2.1);
    vec2 E = elbowAt(sg, r);
    vec2 H = handAt(sg, r, lean);
    d = min(d, sdSeg2(q, S, E) - 0.45);
    d = min(d, sdSeg2(q, E, H) - 0.37);
    d = min(d, length(q - H) - 0.52);
  }
  return d;
}

void main() {
  vec2 p = fragP();
  float px = uFrame.w;
  float beats = uClock.x * uSpeed;
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float drive = uFlow.x;
  float calm = uMood.x;
  float build = uArc.y;
  float breakdown = uArc.z;
  // The stage lip, where the emitters and the flame projectors stand, above
  // the heads of the crowd; under the artwork when there is one.
  float stageY = uHole.z > 0.0 ? min(-0.58, uHoleR.z - 0.12) : -0.58;

  // --- the haze ---
  vec2 hp = p * vec2(0.7, 1.1) + vec2(bars * 0.06, -bars * 0.04);
  float haze = fbm(hp + fbm(hp * 0.6 + bars * 0.03, 3), 5) + 0.5;
  haze = mix(0.35, 1.0, smoothstep(0.1, 1.0, haze)) * P_HAZE;
  haze *= 0.65 + 0.35 * smoothstep(0.9, -0.6, p.y);
  vec3 col = uPalBg.rgb * (0.6 + 0.5 * haze);
  // The fine structure a beam picks out of the smoke: wisps, stretched level
  // by the air handling. The beams take their visibility from THIS, squared,
  // which is what makes them flicker and thicken the way a real one does
  // rather than lie evenly on the frame like a line drawn on it.
  vec2 wq = vec2(p.x * 2.2 + bars * 0.21, p.y * 5.5 - bars * 0.08);
  float wisp = fbm(wq + vec2(0.0, fbm(wq * 0.5 + 3.1, 2)), 3) + 0.5;
  float thick = haze * (0.35 + 1.1 * wisp * wisp);

  // --- the liquid sky: one projector's sheet of laser over the crowd ---
  // The one laser effect that is not a beam: a fan spread flat just above the
  // audience, seen from underneath as a ceiling of light that the smoke
  // rolls through, rippling outward from the stage on the beat. It is what a
  // hardstyle breakdown looks like from the floor, and what keeps this
  // world's quiet passage a picture rather than a black frame.
  float skyAmt = (0.9 * breakdown + 0.3 * build) * P_HAZE;
  if (skyAmt > 0.01) {
    // Eye level, and the projector on the stage at depth Zs: under the
    // artwork when there is one, so the sheet's source is never hidden.
    float Zs = 4.2;
    float h0 = stageY - 1.0 / Zs;
    float dy = p.y - h0;
    if (dy > 1.0 / Zs) {
      float Z = 1.0 / dy;
      float X = p.x * Z;
      vec2 fromP = vec2(X, Zs - Z);
      float r = length(fromP);
      float ang = atan(fromP.x, fromP.y);
      float fan = smoothstep(1.3, 1.05, abs(ang)) * smoothstep(0.0, 0.25, Zs - Z);
      // The ceiling's texture shrinks toward the stage; past what a pixel can
      // hold it is replaced by its average instead of left to crawl.
      vec2 sq = vec2(X, Z) * 1.3 + vec2(bars * 0.05, -bars * 0.14);
      float sm = fbm(sq + fbm(sq * 0.5 + bars * 0.02, 3), 4) + 0.5;
      sm = mix(sm, 0.5, smoothstep(1.4, 3.4, Z));
      // Rings running outward from the stage, two beats apart — faded out
      // before they pack tighter than the pixels toward the horizon.
      float ripple = mix(1.0, 0.45 + 0.55 * pow(0.5 + 0.5 * sin(r * 4.0 - beats * PI), 2.0), smoothstep(3.6, 2.4, Z));
      // Seen from below, the sheet brightens toward the stage (the eye runs
      // through more of it at a grazing angle) and the smoke over our heads is
      // where its texture shows: both, rather than one fading into the other.
      float graze = 0.55 + 0.45 * smoothstep(1.5, 4.0, Z);
      // A sheet this thin is a CROSS-SECTION of the smoke, so what it shows is
      // sharp-edged: clouds with a rim, not a soft wash.
      float cut = smoothstep(0.32, 0.82, sm);
      float sheet = fan * (0.12 + 1.5 * cut + 0.6 * cut * (1.0 - cut)) * ripple * graze;
      vec3 sc = mix(uPalAcc.rgb, uPalHigh.rgb, 0.5 + 0.5 * sin(ang * 2.0 + bars * 0.4));
      col += sc * sheet * skyAmt * 0.6;
    }
    // The projector itself, a hot point on the stage with an anamorphic streak.
    vec2 sp = p - vec2(0.0, h0 + 1.0 / Zs);
    col += mix(uPalAcc.rgb, vec3(1.0), 0.5) * skyAmt
         * (glow(length(sp), 0.012) * 0.8 + exp(-abs(sp.y) * 260.0) * glow(sp.x, 0.25) * 0.12);
  }

  // --- the show: which cue we are on, from the phrase ---
  float cue = mod(floor(uClock.z), 4.0);
  float nE = uFrame.z > 1.2 ? clamp(floor(P_EMITTERS + 0.5), 1.0, 7.0) : 3.0;
  // A breakdown keeps two emitters; a build and a drop use all of them.
  float live = mix(nE, min(nE, 2.0), smoothstep(0.3, 0.8, breakdown));
  float nB = clamp(floor(P_BEAMS * (1.0 - 0.3 * P_RAW) + 0.5), 1.0, 11.0);
  float punch = uHit.y * amp;
  float open = 0.4 + 0.5 * drive + 0.35 * punch + 0.6 * uArc.x;
  float swing = sin(bars * TAU * 0.5 * P_SWEEP * (1.0 + build));
  float swing2 = sin(bars * TAU * 0.25 * P_SWEEP + 1.3);
  vec3 beamLight = vec3(0.0);
  for (int ei = 0; ei < 7; ei++) {
    float e = float(ei);
    if (e >= nE) break;
    float x0 = emitterX(e, nE);
    // Emitters outside the live set stay dark, from the outside in.
    float mid = (nE - 1.0) * 0.5;
    float on = step(abs(e - mid), live * 0.5 + 0.01);
    if (on < 0.5) continue;
    vec2 E = vec2(x0, stageY);
    float side = nE > 1.5 ? (e - mid) / max(mid, 1.0) : 0.0;
    float centre;
    float spread;
    if (cue < 0.5) {        // fans sweeping together
      centre = 1.5708 + 0.55 * swing;
      spread = 0.9 * open;
    } else if (cue < 1.5) { // fans crossing
      centre = 1.5708 + 0.6 * swing * (mod(e, 2.0) < 0.5 ? 1.0 : -1.0);
      spread = 0.7 * open;
    } else if (cue < 2.5) { // converging on a point above the stage
      vec2 target = vec2(0.25 * swing2 * uFrame.z, 0.75);
      vec2 d = target - E;
      centre = atan(d.y, d.x);
      spread = 0.12 + 0.25 * open;
    } else {                // a curtain of vertical beams, leaning together
      centre = 1.5708 + 0.25 * swing - 0.25 * side;
      spread = 0.35 * open;
    }
    // A build pulls the fans in and up.
    centre = mix(centre, 1.5708, 0.5 * build);
    spread *= 1.0 - 0.45 * build;
    vec3 c = mix(uPalHigh.rgb, uPalAcc.rgb, 0.5 + 0.5 * side * cos(bars * 0.7));
    c = mix(c, vec3(1.0, 0.12, 0.08) * 0.35, 0.35 * P_RAW);
    for (int bi = 0; bi < 11; bi++) {
      float b = float(bi);
      if (b >= nB) break;
      float t = nB > 1.5 ? b / (nB - 1.0) - 0.5 : 0.0;
      float a = centre + t * spread;
      vec2 dir = vec2(cos(a), sin(a));
      vec2 v = p - E;
      float along = dot(v, dir);
      if (along < 0.0) continue;
      float across = abs(v.x * dir.y - v.y * dir.x);
      float w = 0.0018 + along * 0.0035;
      float core = glow(across, w);
      float halo = glow(across, w * 10.0) * 0.07;
      float reach = exp(-along * 0.35);
      beamLight += c * (core * (0.3 + 0.7 * thick) + halo * thick) * reach;
    }
    // The emitter's own hot spot on the stage lip, with the horizontal streak
    // a camera lens draws from a laser aperture pointed at it.
    vec2 eq = p - E;
    beamLight += c * (glow(length(eq), 0.03) * 0.8 + exp(-abs(eq.y) * 220.0) * glow(eq.x, 0.2) * 0.18);
  }
  float power = (0.35 + 0.65 * drive) * (1.0 + 1.2 * punch) * (0.55 + 0.45 * (1.0 - calm));
  col += beamLight * power * uEnergy * (1.0 - 0.5 * breakdown);

  // --- the fire ---
  float burning = 0.0;
  for (int i = 0; i < 8; i++) {
    vec4 ev = uEv[i];
    float age = (uClock.x - ev.x) * uSpeed;
    if (ev.y <= 0.0 || age < 0.0 || age > 1.3) continue;
    burning += (1.0 - age / 1.3) * min(ev.y, 1.6);
    for (int ei = 0; ei < 7; ei++) {
      float e = float(ei);
      if (e >= nE) break;
      // Alternate projector pairs, the way a desk fires them.
      if (mod(e + ev.z, 2.0) > 0.5 && ev.y < 1.5) continue;
      vec2 base = vec2(emitterX(e, nE), stageY);
      float fh = (0.6 + 0.3 * ev.y) * P_FIRE;
      float f = flame(p - base, age, fh, e * 3.7 + ev.w * 11.0);
      float t = clamp(1.0 - (p.y - base.y) / (fh * 1.2), 0.0, 1.0) * (1.0 - 0.4 * age);
      col += heat(0.35 + 0.6 * t) * f * min(ev.y, 1.6) * 0.8;
      // The flash of the fire on the haze and the stage.
      col += heat(0.7) * glow(length((p - base) * vec2(0.5, 1.0)), 0.35) * (1.0 - age / 1.3) * 0.12 * ev.y * haze;
    }
  }
  // The strobe is the stage's, so it lands BEHIND the crowd: on the drop the
  // audience is a wall of black silhouettes against white light.
  col += (uPalHigh.rgb * 0.2 + vec3(0.12)) * uHit2.w;

  // --- the crowd ---
  // Two rows of silhouettes along the foot of the frame, rim-lit by whatever
  // the stage is throwing at them. They jump on the beat once the track
  // drives, sway through a breakdown, and put their hands up the way a crowd
  // does — a few in the intro, more through the build, all of them on the
  // drop, fists punching on the kick. In the breakdown some hold up a phone.
  vec3 stageCol = mix(uPalHigh.rgb, uPalAcc.rgb, 0.5) * power * (1.0 - 0.5 * breakdown) * 0.7
                + heat(0.7) * burning * 0.18 + mix(uPalAcc.rgb, uPalHigh.rgb, 0.5) * skyAmt * 0.35
                + vec3(1.0) * uHit2.w * 0.4;
  if (p.y < stageY + 0.02) {
    float want = 0.08 + 0.3 * drive + 0.45 * build + 0.8 * uArc.x;
    float jumpAmt = drive * (1.0 - breakdown);
    for (int row = 0; row < 2; row++) {
      float fr = float(row);
      // The back row small and in the haze, the front row close enough that
      // its raised hands cross the stage.
      float R0 = row == 0 ? 0.03 : 0.058;
      float cw = row == 0 ? 0.092 : 0.185;
      float yh = row == 0 ? stageY - 0.15 : -0.95;
      float c0 = floor(p.x / cw + 0.5 * fr);
      for (int j = -1; j <= 1; j++) {
        float ci = c0 + float(j);
        vec3 h = hash32(vec2(ci, fr * 17.0 + 3.0));
        if (row == 0 && h.z < 0.1) continue;
        // Nobody is the same size or stands in a line.
        float R = R0 * (0.86 + 0.28 * fract(h.x * 13.7));
        float x = (ci + 0.5 - 0.5 * fr + (h.x - 0.5) * 0.4) * cw;
        float y = yh + (h.y - 0.5) * 1.1 * R;
        y += jumpAmt * sin(PI * fract(uPhase.x + h.z * 0.2)) * 0.5 * R * (0.6 + 0.4 * h.x);
        float lean = breakdown * sin(bars * PI * 0.5 + h.x * 6.0) * 0.5;
        x += lean * 0.3 * R;
        float pump = 1.0 + 0.12 * uHit.y * drive;
        float rR = smoothstep(h.y, h.y + 0.25, want) * pump;
        float rL = smoothstep(h.z, h.z + 0.25, want * (h.x > 0.45 ? 1.0 : 0.55)) * pump;
        // A phone held up through the breakdown.
        float phone = breakdown * step(h.x, 0.28) * step(0.5, h.y);
        rR = max(rR, phone);
        vec2 q = (p - vec2(x, y)) / R;
        if (abs(q.x) > 7.0 || q.y > 8.0) continue;
        float sd = personSd(q, rL, rR, lean);
        // Rim light on the edges that face up, toward the stage lights.
        float up = personSd(q + vec2(0.0, 0.4), rL, rR, lean);
        // Thin and uneven, strongest on heads and raised arms: a silhouette is
        // defined by the light it blocks, and a bright rim on every shoulder
        // turns a crowd into a row of identical arches.
        float rim = sat((up - sd) / 0.4) * smoothstep(-0.4, 0.0, sd) * smoothstep(-1.7, -0.7, q.y);
        vec3 body = uPalBg.rgb * 0.035 + stageCol * 0.008;
        body += stageCol * rim * (0.08 + 0.2 * fract(h.z * 7.3)) * (1.0 - 0.35 * fr);
        // The back row stands in the haze, so some of the light passes.
        body = mix(body, col, 0.3 * (1.0 - fr));
        col = mix(col, body, smoothstep(px, -px, sd * R));
        if (phone > 0.01) {
          vec2 hp2 = vec2(x, y) + handAt(1.0, rR, lean) * R + vec2(0.0, 0.5 * R);
          float d = length(p - hp2);
          col += vec3(0.9, 0.95, 1.0) * phone * (glow(d, 0.0035) * 1.2 + glow(d, 0.03) * 0.08);
        }
      }
    }
  }
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col);
}
`,

  create({ ev, flash, params }) {
    const ring = eventRing(ev);
    let n = 0;
    // Fire on the big kicks — the first of every bar in the drop — and on
    // every main kick once the track is really driving; never in a breakdown.
    const big = onStamp((m) => m.stamp.big, (s, m) => {
      if (m.breakdown > 0.5) return;
      ring.push(s, 1 + 0.4 * (params.raw || 0), n % 2, hashN(n++));
    });
    const main = onStamp((m) => m.stamp.main, (s, m) => {
      // Deterministic, so the same track fires the same projectors every time.
      if (m.drive < 0.55 || m.breakdown > 0.3 || hashN(m.count.main * 7 + 3) > (params.raw || 0) * 0.6) return;
      ring.push(s, 0.7, n % 2, hashN(n++));
    });
    const drop = onStamp((m) => m.stamp.drop, (s) => {
      ring.push(s, 2, 0, hashN(n++));
      flash(1);
    });
    return {
      step(dt, m) {
        big(m);
        main(m);
        drop(m);
      },
    };
  },
};
