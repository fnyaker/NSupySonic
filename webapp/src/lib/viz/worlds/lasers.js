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
//
// A breakdown is two emitters sweeping slowly through heavy haze. Rawstyle
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
  uses: ["noise"],
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

void main() {
  vec2 p = fragP();
  float beats = uClock.x * uSpeed;
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float drive = uFlow.x;
  float calm = uMood.x;
  float build = uArc.y;
  float breakdown = uArc.z;
  float floorY = -1.0;

  // --- the haze ---
  vec2 hp = p * vec2(0.7, 1.1) + vec2(bars * 0.06, -bars * 0.04);
  float haze = fbm(hp + fbm(hp * 0.6 + bars * 0.03, 3), 5) + 0.5;
  haze = mix(0.35, 1.0, smoothstep(0.1, 1.0, haze)) * P_HAZE;
  haze *= 0.65 + 0.35 * smoothstep(0.9, -0.6, p.y);
  vec3 col = uPalBg.rgb * (0.6 + 0.5 * haze);

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
    vec2 E = vec2(x0, floorY - 0.02);
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
      beamLight += c * (core * (0.5 + 0.5 * haze) + halo * haze) * reach;
    }
    // The emitter's own hot spot on the stage lip.
    beamLight += c * glow(length(p - E), 0.03) * 0.8;
  }
  float power = (0.35 + 0.65 * drive) * (1.0 + 1.2 * punch) * (0.55 + 0.45 * (1.0 - calm));
  col += beamLight * power * uEnergy * (1.0 - 0.5 * breakdown);

  // --- the fire ---
  for (int i = 0; i < 8; i++) {
    vec4 ev = uEv[i];
    float age = (uClock.x - ev.x) * uSpeed;
    if (ev.y <= 0.0 || age < 0.0 || age > 1.3) continue;
    for (int ei = 0; ei < 7; ei++) {
      float e = float(ei);
      if (e >= nE) break;
      // Alternate projector pairs, the way a desk fires them.
      if (mod(e + ev.z, 2.0) > 0.5 && ev.y < 1.5) continue;
      vec2 base = vec2(emitterX(e, nE), floorY);
      float fh = (0.6 + 0.3 * ev.y) * P_FIRE;
      float f = flame(p - base, age, fh, e * 3.7 + ev.w * 11.0);
      float t = clamp(1.0 - (p.y - base.y) / (fh * 1.2), 0.0, 1.0) * (1.0 - 0.4 * age);
      col += heat(0.35 + 0.6 * t) * f * min(ev.y, 1.6) * 0.8;
      // The flash of the fire on the haze and the stage.
      col += heat(0.7) * glow(length((p - base) * vec2(0.5, 1.0)), 0.35) * (1.0 - age / 1.3) * 0.12 * ev.y * haze;
    }
  }
  col += (uPalHigh.rgb * 0.2 + vec3(0.12)) * uHit2.w;
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
