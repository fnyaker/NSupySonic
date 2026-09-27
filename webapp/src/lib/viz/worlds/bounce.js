// REBOND — the bouncing kick.
//
// Hardtekk, tekk, jumpstyle, hard bass, bouncy: the genres that do not hammer
// so much as BOUNCE, where the kick is round and elastic and the whole track
// leaps from one beat to the next. So the hero is a single orb that jumps on
// every beat and lands on every kick: an arc through the air in the beat's own
// time (it is always exactly on the floor when the kick lands, because its
// height is a function of the beat phase, not a simulation that could drift),
// a squash on impact that springs back through an overshoot, a stretch on the
// way up.
//
// It is lit the way a product is shot today, not the way an icon was drawn in
// 2006. The old orb was chrome: a studio of neon strips reflected in it, a
// pin-point specular, a black mirror floor under it and a sunburst of hairline
// spikes around it — every one of them the vocabulary of a glossy desktop
// theme. Now it is SOFT 3D: a matte sphere under one big soft key light,
// coloured through the palette from its shadow to its lit side, a broad
// highlight and a thin rim from behind, sitting on a seamless studio cove with
// a soft contact shadow that tightens as it lands and its own colour bleeding
// onto the floor. The spectrum around it is a ring of rounded capsules — the
// same vocabulary as the bars — and every landing sends a soft wave across
// the floor.
//
// On a wide frame two smaller orbs bounce on the OFF-beats either side — the
// alternation these genres are made of — and with the artwork in front, the
// orbs bounce in the free band beneath it.
//
// Parameters:
//   height  jump height        squash  how hard it squashes
//   spikes  the spectrum ring  twins   the off-beat pair (0 or 1)
//   gloss   highlight and rim strength

import { onStamp } from "./kit.js";

export default {
  id: "bounce",
  uses: ["noise"],
  params: { height: 1, squash: 1, spikes: 1, twins: 1, gloss: 1 },
  look: { exposure: 1.0, bloom: 0.7, threshold: 0.85, saturation: 1.12, ca: 0 },

  fragment: `
// With the artwork in front, the stage is the band under it: the floor low in
// that band and the orb sized to jump inside it. The floor used to sit right
// under the cover, and the orb spent every jump behind it.
float floorLine() {
  return uHole.z > 0.0 ? clamp(-1.0 + (uHoleR.z + 1.0) * 0.3, -0.95, -0.35) : -0.55;
}
float orbSize(float k) {
  float room = uHole.z > 0.0 ? (uHoleR.z + 1.0) : 1.4;
  float r = clamp(room * (uHole.z > 0.0 ? 0.2 : 0.28), 0.07, 0.3);
  return r * (k > 0.5 ? 0.55 : 1.0);
}
// Where an orb's centre is, and its squash-and-stretch scale.
vec2 orbCentre(vec2 base, float R, float lift, float sq) {
  return base + vec2(0.0, R * (1.0 - 0.35 * max(sq, 0.0)) + lift);
}

// One orb: returns its colour and coverage at p. \`lift\` is its height above
// the floor, \`sq\` its squash (>0 flattened), \`R\` its radius, \`tint\` 0..1
// where it sits in the palette.
vec4 orb(vec2 p, vec2 base, float R, float lift, float sq, float core, float tint) {
  vec2 C = orbCentre(base, R, lift, sq);
  vec2 s = vec2(1.0 + 0.45 * sq, 1.0 - 0.38 * sq);
  vec2 q = (p - C) / (R * s);
  float r2 = dot(q, q);
  float aa = uFrame.w * 1.5 / R;
  float cover = smoothstep(1.0 + aa, 1.0 - aa, r2);
  if (cover <= 0.0) return vec4(0.0);
  vec3 n = vec3(q, sqrt(max(0.0, 1.0 - r2)));
  vec3 L = normalize(vec3(-0.5, 0.8, 0.6));
  // A wrapped diffuse: the terminator is soft, as under a big softbox.
  float wrap = clamp((dot(n, L) + 0.4) / 1.4, 0.0, 1.0);
  vec3 lit = pal(0.35 + 0.5 * tint) * 1.15;
  vec3 shadow = mix(uPalBg.rgb, pal(tint * 0.5), 0.35) * 0.3;
  vec3 col = mix(shadow, lit, smoothstep(0.0, 1.0, wrap));
  // The colour turns a little through the palette toward the edge, the way a
  // soft-touch finish does.
  col = mix(col, pal(1.0 - tint) * 0.8, pow(1.0 - n.z, 3.0) * 0.35);
  // A broad highlight, not a pin-point: the softbox itself, blurred.
  vec3 refl = reflect(vec3(0.0, 0.0, -1.0), n);
  col += mix(lit, vec3(1.0), 0.65) * pow(max(dot(refl, L), 0.0), 7.0) * 0.45 * P_GLOSS;
  // A thin rim from behind and to the right.
  float rim = pow(1.0 - n.z, 2.6) * smoothstep(-0.3, 0.7, dot(normalize(n.xy + 1e-4), normalize(vec2(0.85, -0.2))));
  col += mix(uPalAcc.rgb, vec3(1.0), 0.3) * rim * 0.7 * P_GLOSS;
  // The bass, glowing through it.
  col += lit * core * pow(n.z, 1.6) * 0.35;
  return vec4(col, cover);
}

void main() {
  vec2 p = fragP();
  float amp = 0.55 + 0.45 * uCtl.x;
  float fy = floorLine();
  float drive = uFlow.x;

  // --- the cove: floor and wall in one seamless sweep -------------------------
  float h = p.y - fy;
  vec3 col = uPalBg.rgb * (0.5 + 0.5 * exp(-abs(h) * 2.2));
  col += pal(0.5 + 0.25 * p.x / uFrame.z) * exp(-abs(h) * 3.0) * (0.05 + 0.1 * uMood.y);
  // A key light's pool on the wall behind the stage.
  col += mix(uPalLow.rgb, uPalMid.rgb, 0.5) * glow(length((p - vec2(0.0, fy + 0.45)) * vec2(0.45, 1.0)), 0.55) * (0.06 + 0.16 * uMood.y);

  // The jump: a parabola across each beat, on the floor at the beat itself.
  float ph = uPhase.x;
  float H = (0.12 + 0.28 * drive) * P_HEIGHT * amp * (1.0 - 0.7 * uArc.z);
  if (uHole.z > 0.0) H = min(H, max(0.03, uHoleR.z - fy - 2.1 * orbSize(0.0)));
  float lift = 4.0 * ph * (1.0 - ph) * H;
  // The squash is the driver's spring (uS0.x), overshoot and all.
  float sq = uS0.x * P_SQUASH;
  float core = uBandA.x + uBandA.y;
  float R = orbSize(0.0);
  vec2 base = vec2(0.0, fy);
  vec2 C = orbCentre(base, R, lift, sq);
  vec3 hero = pal(0.6);

  // --- the floor: contact shadow, colour bleed, the landing wave --------------
  if (h < 0.0) {
    float air = clamp(lift / max(H, 0.01), 0.0, 1.0);
    vec2 sd = (p - vec2(C.x, fy)) / vec2(R * (1.1 + 0.8 * air), R * (0.22 + 0.2 * air));
    float shadow = exp(-dot(sd, sd));
    col *= 1.0 - 0.7 * shadow * (1.0 - 0.6 * air);
    vec2 bl = (p - vec2(C.x, fy)) / vec2(R * 2.2, R * 0.6);
    col += hero * exp(-dot(bl, bl)) * 0.12 * (1.0 - 0.5 * air);
  }
  float land = uSince.y;
  if (land < 2.0) {
    vec2 q = (p - base) * vec2(1.0, 5.0);
    float Rr = land * 0.75;
    float wave = exp(-pow((length(q) - Rr) / (0.035 + land * 0.05), 2.0)) * (1.0 - land / 2.0);
    col += mix(hero, vec3(1.0), 0.25) * wave * 0.35 * uEnergy * step(h, 0.02);
  }

  // --- the spectrum: a ring of rounded capsules around the orb -----------------
  {
    vec2 d = p - C;
    float rr = length(d);
    float a = atan(d.x, d.y); // 0 straight up, mirrored left/right
    float n = 22.0;
    float cell = clamp(floor(abs(a) / PI * n), 0.0, n - 1.0);
    float ac = (cell + 0.5) / n * PI * sign(a + 1e-6);
    vec2 axis = vec2(sin(ac), cos(ac));
    float f = (cell + 0.5) / n;
    float spec = texture(uSpec, vec2(0.04 + f * 0.9, 0.25)).r;
    float len = R * 0.8 * pow(spec, 1.6) * P_SPIKES * (0.7 + 0.5 * drive);
    float r0 = R * 1.24;
    float along = dot(d, axis) - r0;
    float across = dot(d, vec2(axis.y, -axis.x));
    float w = R * 0.05;
    float sdc = length(vec2(across, along - clamp(along, 0.0, len))) - w;
    float cap = clamp(0.5 - sdc / uFrame.w, 0.0, 1.0);
    col = mix(col, pal(f) * (0.55 + 1.1 * spec) * (0.7 + 0.5 * uHit.x), cap * uEnergy);
  }

  // --- the orbs ---
  vec4 o = orb(p, base, R, lift, sq, core, 0.6);
  // The off-beat pair, either side, on wide frames only.
  if (P_TWINS > 0.5 && uFrame.z > 1.25) {
    float Rt = orbSize(1.0);
    float ph2 = fract(ph + 0.5);
    float lift2 = 4.0 * ph2 * (1.0 - ph2) * H * 0.8;
    float sq2 = uS0.y * P_SQUASH;
    for (int k = 0; k < 2; k++) {
      float sx = k == 0 ? -1.0 : 1.0;
      vec2 b2 = vec2(sx * uFrame.z * 0.55, fy);
      if (h < 0.0) {
        float air2 = clamp(lift2 / max(H * 0.8, 0.01), 0.0, 1.0);
        vec2 s2 = (p - b2) / vec2(Rt * (1.1 + 0.8 * air2), Rt * (0.22 + 0.2 * air2));
        col *= 1.0 - 0.6 * exp(-dot(s2, s2)) * (1.0 - 0.6 * air2);
      }
      vec4 t = orb(p, b2, Rt, lift2, sq2, uBandA.z, k == 0 ? 0.2 : 0.95);
      o = mix(o, t, t.a * (1.0 - o.a));
    }
  }
  col = mix(col, o.rgb, o.a);
  col += uPalHigh.rgb * uHit2.w * 0.25;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    // A damped spring for the squash: the kick hits it, it rings back through
    // an overshoot (the stretch) and settles — in beats, so it rings at the
    // same musical rate at 150 and at 180 BPM.
    let x = 0;
    let v = 0;
    let x2 = 0;
    let v2 = 0;
    // Impulses are queued and applied in `step` scaled by the spring's own
    // frequency, so the squash is as DEEP at 180 BPM as at 150 — only faster.
    let kickIn = 0;
    let offIn = 0;
    const main = onStamp((m) => m.stamp.main, (s, m) => {
      kickIn += 0.6 + 0.5 * Math.min(1.2, m.mainPower || m.kick || 0.8);
    });
    const off = onStamp((m) => m.stamp.beat, () => {
      offIn += 0.35;
    });
    const drop = onStamp((m) => m.stamp.drop, () => flash(0.8));
    return {
      step(dt, m) {
        main(m);
        off(m);
        drop(m);
        const w = (2 * Math.PI * 1.6) / m.beat; // rings 1.6 times a beat
        const z = 0.32;
        v += kickIn * w * 0.45;
        v2 += offIn * w * 0.45;
        kickIn = offIn = 0;
        const n = Math.max(1, Math.ceil(dt / 0.004));
        const h = dt / n;
        for (let i = 0; i < n; i++) {
          v += (-w * w * x - 2 * z * w * v) * h;
          x += v * h;
          v2 += (-w * w * x2 - 2 * z * w * v2) * h;
          x2 += v2 * h;
        }
        state[0] = Math.max(-0.6, Math.min(1, x));
        state[1] = Math.max(-0.6, Math.min(1, x2 * 0.6));
      },
    };
  },
};
