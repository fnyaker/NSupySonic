// REBOND — the bouncing kick.
//
// Hardtekk, tekk, jumpstyle, hard bass, bouncy: the genres that do not hammer
// so much as BOUNCE, where the kick is round and elastic and the whole track
// leaps from one beat to the next. So the hero is a single glossy orb that
// jumps on every beat and lands on every kick: an arc through the air in the
// beat's own time (it is always exactly on the floor when the kick lands,
// because its height is a function of the beat phase, not a simulation that
// could drift), a squash on impact that springs back through an overshoot, a
// stretch on the way up.
//
// It is lit like an object, not drawn like an icon: a sphere normal from its
// outline, a key light and a soft rim, the room reflected in it (the palette as
// a studio of neon strips), a specular window, a hot core that pulses with the
// bass. Around it, a crown of spikes — the spectrum, one spike per band — and
// under it a black mirror floor with its reflection and a contact shadow that
// tightens as it lands, plus a shock ring on every landing.
//
// On a wide frame two smaller orbs bounce on the OFF-beats either side — the
// alternation these genres are made of — and with the artwork in front, the
// orbs bounce in the free band beneath it.
//
// Parameters:
//   height  jump height        squash  how hard it squashes
//   spikes  spectrum crown     twins   the off-beat pair (0 or 1)
//   gloss   reflection strength

import { onStamp } from "./kit.js";

export default {
  id: "bounce",
  uses: ["noise"],
  params: { height: 1, squash: 1, spikes: 1, twins: 1, gloss: 1 },
  look: { exposure: 1.0, bloom: 1.1, threshold: 0.8, saturation: 1.18 },

  fragment: `
float floorLine() {
  return uHole.z > 0.0 ? clamp(uHoleR.z - 0.05, -0.95, -0.35) : -0.55;
}
float orbSize(float k) {
  float room = uHole.z > 0.0 ? (uHoleR.z + 1.0) : 1.4;
  float r = clamp(room * 0.28, 0.07, 0.3);
  return r * (k > 0.5 ? 0.55 : 1.0);
}

// The room the orb reflects: a dark studio with a few neon strips, in the
// palette's colours. \`d\` is a reflected direction.
vec3 studio(vec3 d) {
  float y = d.y;
  vec3 c = uPalBg.rgb * 0.4 + mix(uPalLow.rgb, uPalMid.rgb, 0.5 + 0.5 * d.x) * 0.08 * (0.6 + 0.4 * y);
  // A softbox overhead and two strips either side.
  c += vec3(1.0) * smoothstep(0.75, 0.95, y) * 1.3;
  c += uPalHigh.rgb * 2.2 * smoothstep(0.08, 0.0, abs(d.x - 0.7)) * smoothstep(-0.2, 0.3, y);
  c += uPalAcc.rgb * 1.6 * smoothstep(0.06, 0.0, abs(d.x + 0.65)) * smoothstep(-0.1, 0.5, y);
  // The floor, dark, in the lower hemisphere.
  c *= mix(0.25, 1.0, smoothstep(-0.2, 0.05, y));
  return c;
}

// One orb: returns its colour and coverage at p. \`lift\` is its height above
// the floor, \`sq\` its squash (>0 flattened), \`R\` its radius.
vec4 orb(vec2 p, vec2 base, float R, float lift, float sq, float core) {
  vec2 C = base + vec2(0.0, R * (1.0 - 0.35 * max(sq, 0.0)) + lift);
  vec2 s = vec2(1.0 + 0.45 * sq, 1.0 - 0.38 * sq);
  vec2 q = (p - C) / (R * s);
  float r2 = dot(q, q);
  float aa = uFrame.w * 1.5 / R;
  float cover = smoothstep(1.0 + aa, 1.0 - aa, r2);
  if (cover <= 0.0) return vec4(0.0);
  vec3 n = vec3(q, sqrt(max(0.0, 1.0 - r2)));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 L = normalize(vec3(-0.4, 0.7, 0.6));
  float diff = max(dot(n, L), 0.0);
  vec3 refl = reflect(-V, n);
  float fres = pow(1.0 - n.z, 3.0);
  vec3 base0 = mix(uPalMid.rgb, uPalHigh.rgb, 0.3);
  vec3 col = base0 * (0.08 + 0.35 * diff);
  col += studio(refl) * (0.25 + 0.75 * fres) * P_GLOSS;
  col += vec3(1.0) * pow(max(dot(refl, L), 0.0), 60.0) * 2.5;
  // The hot core, glowing through the glass with the bass.
  col += mix(uPalLow.rgb, uPalHigh.rgb, 0.4) * core * pow(n.z, 2.0) * 1.4;
  return vec4(col, cover);
}

void main() {
  vec2 p = fragP();
  float beats = uClock.x * uSpeed;
  float amp = 0.55 + 0.45 * uCtl.x;
  float fy = floorLine();
  float drive = uFlow.x;

  vec3 col = uPalBg.rgb * 0.55;
  // A soft glow behind the stage, lit by the whole mix.
  col += mix(uPalLow.rgb, uPalMid.rgb, 0.5) * glow(length((p - vec2(0.0, fy + 0.35)) * vec2(0.5, 1.0)), 0.6) * (0.08 + 0.18 * uMood.y);

  // The jump: a parabola across each beat, on the floor at the beat itself.
  float ph = uPhase.x;
  float H = (0.12 + 0.28 * drive) * P_HEIGHT * amp * (1.0 - 0.7 * uArc.z);
  float lift = 4.0 * ph * (1.0 - ph) * H;
  // The squash is the driver's spring (uS0.x), overshoot and all.
  float sq = uS0.x * P_SQUASH;
  float core = uBandA.x + uBandA.y;

  float R = orbSize(0.0);
  vec2 base = vec2(0.0, fy);

  // --- the crown of spikes: the spectrum around the orb ---
  vec2 C = base + vec2(0.0, R + lift);
  vec2 d = p - C;
  float rr = length(d);
  float a = atan(d.x, d.y); // 0 straight up, mirrored left/right
  float f = abs(a) / PI;
  float spec = texture(uSpec, vec2(0.04 + f * 0.9, 0.25)).r;
  float n = 48.0;
  float cellA = (floor(abs(a) / PI * n) + 0.5) / n * PI;
  float dAng = abs(abs(a) - cellA) * rr;
  float len = R * (0.25 + 1.6 * spec * spec) * P_SPIKES * (0.7 + 0.5 * drive);
  float along = rr - R * 1.12;
  float spike = smoothstep(0.004 + 0.006 * spec, 0.0, dAng) * step(0.0, along) * smoothstep(len, len * 0.3, along);
  col += pal(f) * spike * (0.6 + 1.4 * spec) * (0.6 + 0.8 * uHit.x) * uEnergy;

  // --- the floor: a black mirror, the reflection, the contact shadow ---
  if (p.y < fy) {
    vec2 m = vec2(p.x, 2.0 * fy - p.y);
    vec4 ro = orb(m, base, R, lift, sq, core);
    float fade = exp(-(fy - p.y) * 5.0) * 0.35;
    col += ro.rgb * ro.a * fade;
    float sh = glow(length((p - vec2(0.0, fy)) * vec2(1.0, 6.0)), R * (0.8 + lift * 2.0));
    col += uPalMid.rgb * sh * 0.05 * (1.0 - lift / max(H, 0.01));
  }
  // The floor line, and a shock ring on every landing.
  col += mix(uPalMid.rgb, uPalHigh.rgb, 0.5) * glow(abs(p.y - fy), 0.002) * 0.25;
  float land = uSince.y;
  if (land < 2.0) {
    vec2 q = (p - base) * vec2(1.0, 5.0);
    float Rr = land * 0.7;
    col += mix(uPalHigh.rgb, vec3(1.0), 0.3) * exp(-pow((length(q) - Rr) / (0.02 + land * 0.04), 2.0)) * (1.0 - land / 2.0) * 0.9 * uEnergy;
  }

  // --- the orbs ---
  vec4 o = orb(p, base, R, lift, sq, core);
  // The off-beat pair, either side, on wide frames only.
  if (P_TWINS > 0.5 && uFrame.z > 1.25) {
    float Rt = orbSize(1.0);
    float ph2 = fract(ph + 0.5);
    float lift2 = 4.0 * ph2 * (1.0 - ph2) * H * 0.8;
    float sq2 = uS0.y * P_SQUASH;
    for (int k = 0; k < 2; k++) {
      float sx = k == 0 ? -1.0 : 1.0;
      vec2 b2 = vec2(sx * uFrame.z * 0.55, fy);
      vec4 t = orb(p, b2, Rt, lift2, sq2, uBandA.z);
      o = mix(o, t, t.a * (1.0 - o.a));
      if (p.y < fy) {
        vec4 tr = orb(vec2(p.x, 2.0 * fy - p.y), b2, Rt, lift2, sq2, 0.0);
        col += tr.rgb * tr.a * exp(-(fy - p.y) * 5.0) * 0.3;
      }
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
