// OCÉAN — the sea at night, under the moon.
//
// Dub, downtempo, trip-hop, ambient with a pulse: the picture is the open
// sea at night from a boat, the swell rolling under the camera and the moon
// laying a road of light across it.
//
//   THE SEA is a height field, raymarched: six wave trains in different
//   directions, each one an exponentiated sine — sharp crests, broad troughs,
//   the shape real wind waves have and plain sines do not. The march refines
//   the hit, and the normal comes from the field itself, so every wave
//   catches the light at its own angle.
//   THE LIGHT is the sky reflected — by Fresnel, so the water is dark
//   looking down and a mirror toward the horizon — plus the MOON GLADE: the
//   moon's highlight broken by the waves into thousands of glints, the one
//   thing that makes night water look like water. Crests show a little of
//   the water's own colour where light passes through them.
//   THE MUSIC. The bass is the swell (its height and how steep it stands);
//   the drive is the wind (how fast the waves run and how chopped they are);
//   the hats set the glints flickering; the drop brightens the moon glade and
//   lifts the swell, settling back over four bars.
//
// Parameters:
//   swell   wave height      wind   wave speed (x)
//   moon    moonlight

import { onStamp } from "./kit.js";

export default {
  id: "ocean",
  uses: ["noise"],
  params: { swell: 1, wind: 1, moon: 1, march: 56 },
  look: { exposure: 1.0, bloom: 1.25, threshold: 0.7, saturation: 1.1 },

  fragment: `
float wave(vec2 x, float t, float swell, float chop) {
  float h = 0.0;
  float a = 0.28 * swell;
  float k = 0.55;
  float ang = 0.3;
  for (int i = 0; i < 6; i++) {
    vec2 d = vec2(cos(ang), sin(ang));
    float ph = dot(d, x) * k + t * sqrt(k) * 1.6;
    h += a * (exp(sin(ph) - 1.0) * 2.0 - 0.6);
    // The next train: finer, turned, and warped by the one before it (which
    // is what makes crests lean and interfere instead of tiling).
    x += d * a * (exp(sin(ph) - 1.0)) * chop * 0.8;
    a *= 0.5;
    k *= 1.85;
    ang += 2.1;
  }
  return h;
}

vec3 moonDir() { return normalize(vec3(-0.35, 0.28, 1.0)); }

vec3 sky(vec3 rd, float glade) {
  vec3 c = mix(uPalLow.rgb * 0.12 + uPalBg.rgb * 0.2, uPalBg.rgb * 0.3, smoothstep(0.0, 0.5, rd.y));
  vec3 md = moonDir();
  float m = max(dot(rd, md), 0.0);
  vec3 moonC = mix(vec3(0.95, 0.95, 0.88), uPalHigh.rgb, 0.2);
  c += moonC * smoothstep(0.99955, 0.9997, m) * 3.0 * P_MOON;
  c += moonC * pow(m, 60.0) * 0.25 * P_MOON * (1.0 + glade);
  c += moonC * pow(m, 6.0) * 0.04 * P_MOON;
  return c;
}

void main() {
  vec2 p = fragP();
  float t = uS0.x;
  float swell = (0.6 + 0.8 * uBandA.x + 0.35 * uS0.y) * P_SWELL;
  float chop = 0.5 + 0.8 * uFlow.x;
  float glade = uS0.y;
  vec3 ro = vec3(0.0, 1.4, 0.0);
  vec3 rd = normalize(vec3(p.x, p.y - 0.18, 1.6));
  vec3 col;
  if (rd.y > 0.02) {
    col = sky(rd, glade);
    // Stars above the haze.
    vec2 sg = floor(rd.xy / rd.z * 140.0);
    col += vec3(0.8) * step(0.993, hash12(sg)) * smoothstep(0.08, 0.3, rd.y) * 0.3;
  } else {
    // March the height field.
    float tt = 0.0;
    float hitT = -1.0;
    int steps = int(clamp(P_MARCH * uQual.x, 28.0, 96.0));
    float dtm = 0.35;
    for (int i = 0; i < 96; i++) {
      if (i >= steps) break;
      vec3 pos = ro + rd * tt;
      float d = pos.y - wave(pos.xz, t, swell, chop);
      if (d < 0.0) {
        // Refine between the last two samples.
        float a = tt - dtm;
        float b = tt;
        for (int j = 0; j < 5; j++) {
          float m = 0.5 * (a + b);
          vec3 q = ro + rd * m;
          if (q.y - wave(q.xz, t, swell, chop) < 0.0) b = m; else a = m;
        }
        hitT = 0.5 * (a + b);
        break;
      }
      dtm = max(0.05, d * 0.6) * (1.0 + tt * 0.03);
      tt += dtm;
      if (tt > 80.0) break;
    }
    if (hitT < 0.0) hitT = (ro.y) / max(-rd.y, 1e-3);
    vec3 pos = ro + rd * hitT;
    // The normal from the field, with a step that grows with distance.
    float e = 0.01 + hitT * 0.002;
    float h0 = wave(pos.xz, t, swell, chop);
    vec3 n = normalize(vec3(h0 - wave(pos.xz + vec2(e, 0.0), t, swell, chop), e, h0 - wave(pos.xz + vec2(0.0, e), t, swell, chop)));
    // Far away, the waves are smaller than a pixel: flatten toward calm.
    n = normalize(mix(n, vec3(0.0, 1.0, 0.0), smoothstep(20.0, 70.0, hitT)));
    vec3 r = reflect(rd, n);
    r.y = abs(r.y);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, -rd), 0.0), 5.0);
    col = sky(r, glade) * fres;
    // The body of the water: never quite black, a deep tone of the palette
    // that the swell's faces pick up.
    col += mix(uPalLow.rgb, uPalMid.rgb, 0.3) * (0.02 + 0.03 * max(n.z * -rd.z, 0.0));
    // The moon glade: its highlight, broken into glints by the waves.
    vec3 md = moonDir();
    float spec = pow(max(dot(r, md), 0.0), 500.0);
    float glint = spec * (1.0 + 2.0 * uHit2.x * step(0.6, hash12(floor(pos.xz * 8.0) + floor(uClock.x * 4.0))));
    col += mix(vec3(1.0, 0.98, 0.9), uPalHigh.rgb, 0.2) * glint * 8.0 * P_MOON * (1.0 + glade);
    // Light through the crests: a little of the water's own colour.
    float crest = smoothstep(0.05, 0.35, h0);
    col += mix(uPalMid.rgb, uPalLow.rgb, 0.5) * crest * 0.05 * max(dot(md, n), 0.0);
    // Distance haze.
    col = mix(col, sky(vec3(rd.x, 0.02, rd.z), glade) * 0.8, smoothstep(10.0, 80.0, hitT));
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.15;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, params, flash }) {
    let t = 0;
    let glade = 0;
    const drop = onStamp((m) => m.stamp.drop, () => {
      glade = 1;
      flash(0.4);
    });
    return {
      step(dt, m) {
        drop(m);
        // The waves' own clock, in beats — pinned to 1 at 120 BPM, where the
        // swell was tuned — scaled by the wind and the drive, integrated so a
        // change of tempo never jumps. It used to follow only the square root
        // of the tempo ("a sea twice as fast stops reading as water"), and a
        // 140 BPM half-time track then rolled at barely the speed of a 90 BPM
        // one: the sea is here to breathe with the track, not to be physics.
        t += (dt / m.beat) * 0.5 * (0.55 + 0.35 * m.drive) * (params.wind || 1);
        glade = Math.max(0, glade - dt / m.overBeats(16));
        state[0] = t;
        state[1] = glade;
      },
    };
  },
};
