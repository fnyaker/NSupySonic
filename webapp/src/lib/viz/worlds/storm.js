// ORAGE — the storm, and the lightning on the hits.
//
// Doom, sludge, post-metal, dark ambient with drums, epic trailer music: the
// picture is weather. A ceiling of storm cloud rolling over dark hills, rain
// slanting through it, and lightning.
//
//   THE LIGHTNING is a real branching bolt, not a zig-zag: its path is built
//   by midpoint displacement down from the cloud base — each segment offset
//   sideways by a hash of the strike, less at each finer level — with two
//   side branches forking off it and dying out. It is drawn as a white-hot
//   core in a violet glow, and it LIGHTS THE CLOUDS from inside around the
//   point where it leaves them, which is what makes a flash read as a storm.
//   THE CLOUDS are layered noise lit from below by the ground's faint glow
//   and from within by every strike; they roll on the bar clock.
//   THE RAIN slants in two layers of streaks, heavier when the track drives.
//   THE MUSIC. Snares and big kicks call the strikes — never more than one a
//   beat, never more than three a second, whatever the drums do, because a
//   storm that strobes is a hazard, not a picture. The drop splits the sky
//   with a double strike; the bass rumbles the cloud base.
//
// Parameters:
//   rain    rain strength    bolts   strike rate (x)
//   hills   the horizon

import { eventRing, onStamp, hashN } from "./kit.js";

export default {
  id: "storm",
  uses: ["noise", "sdf"],
  params: { rain: 1, bolts: 1, hills: 1 },
  look: { exposure: 1.0, bloom: 1.35, threshold: 0.65, saturation: 1.1 },

  fragment: `
// The distance to strike \`seed\`'s bolt: a trunk of 16 segments from (x0, top)
// to the ground, displaced at three scales, plus two branches.
float bolt(vec2 p, float seed, float x0, float top, float bottom, out float branchHit) {
  float d = 1e3;
  branchHit = 0.0;
  vec2 a = vec2(x0, top);
  for (int i = 1; i <= 16; i++) {
    float u = float(i) / 16.0;
    float y = mix(top, bottom, u);
    float off = (hash11(seed * 7.1 + float(i)) - 0.5) * 0.16
              + (hash11(seed * 3.7 + floor(float(i) * 0.5)) - 0.5) * 0.24
              + (hash11(seed * 1.3 + floor(float(i) * 0.25)) - 0.5) * 0.3;
    vec2 b = vec2(x0 + off * u * 1.4, y);
    d = min(d, sdSeg2(p, a, b));
    // Two branches, forking off at chosen segments and tapering away.
    if (i == 5 || i == 9) {
      vec2 c = b;
      float dir = hash11(seed + float(i)) > 0.5 ? 1.0 : -1.0;
      for (int k = 1; k <= 5; k++) {
        float v = float(k) / 5.0;
        vec2 e = b + vec2(dir * v * 0.28 + (hash11(seed * 5.3 + float(i * 7 + k)) - 0.5) * 0.06, -v * 0.3);
        float db = sdSeg2(p, c, e) + v * 0.004;
        if (db < d) { branchHit = 1.0; }
        d = min(d, db);
        c = e;
      }
    }
    a = b;
  }
  return d;
}

void main() {
  vec2 p = fragP();
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float A = uFrame.z;
  float px = uFrame.w;
  float cloudBase = 0.2;
  // --- the sky: storm cloud rolling over, lit from inside by the strikes ---
  vec2 cp = vec2(p.x * 0.9 + bars * 0.06, p.y * 1.6);
  float c1 = fbm(cp * 1.4, 5) * 0.5 + 0.5;
  float c2 = fbm(cp * 3.2 + vec2(bars * 0.1, 0.0), 4) * 0.5 + 0.5;
  float cloud = smoothstep(0.35, 0.75, c1 * 0.7 + c2 * 0.4) * smoothstep(cloudBase - 0.35, cloudBase + 0.25, p.y);
  // The bass rumbles the base of the cloud.
  cloud *= 1.0 + 0.1 * uBandA.x * sin(p.x * 6.0 + uClock.x * 2.0);
  vec3 sky = mix(uPalBg.rgb * 0.5, uPalLow.rgb * 0.06, smoothstep(-0.2, 1.0, p.y));
  // Relief: the billows lit from below — a cloud is brighter on the side
  // that faces the light, which is what makes it a volume and not a stain.
  float c3 = fbm((cp + vec2(0.0, 0.05)) * 1.4, 5) * 0.5 + 0.5;
  float relief = clamp((c1 - c3) * 6.0 + 0.5, 0.0, 1.0);
  vec3 cloudC = mix(uPalBg.rgb * 0.35, mix(uPalLow.rgb, uPalMid.rgb, 0.4) * 0.3, relief * relief) + vec3(0.006);
  vec3 col = mix(sky, cloudC, cloud);
  // Sheet lightning: every main kick lights a patch of cloud from inside,
  // somewhere across the sky — the storm is alive between the strikes.
  float kAge = uSince.y;
  vec2 kAt = vec2((hash11(uCount.z * 1.7) * 2.0 - 1.0) * (A - 0.2), 0.55 + 0.25 * hash11(uCount.z * 2.9));
  float sheet = exp(-length((p - kAt) * vec2(0.8, 1.4)) * 2.5) * envB(kAge, 0.3) * amp;
  col += mix(vec3(0.8, 0.8, 1.0), uPalHigh.rgb, 0.4) * sheet * (0.2 + cloud) * 0.8;

  // --- the strikes ---
  vec3 boltC = mix(vec3(0.85, 0.8, 1.0), uPalHigh.rgb, 0.3);
  float groundY = -0.72;
  for (int i = 0; i < 8; i++) {
    vec4 ev = uEv[i];
    float age = uClock.x - ev.x;
    if (ev.y <= 0.0 || age < 0.0 || age > 1.5) continue;
    float x0 = ev.z;
    // A strike flickers: bright, a dip, a second return stroke, then gone.
    float life = exp(-age * 5.0) + 0.6 * exp(-pow((age - 0.18) * 25.0, 2.0));
    float bh;
    float d = bolt(p, ev.w, x0, cloudBase + 0.25, groundY + 0.02, bh);
    float core = exp(-d * d / (px * px * 4.0 + 1e-7));
    col += vec3(1.0) * core * life * 3.5 * ev.y * (1.0 - 0.4 * bh);
    col += boltC * glow(d, 0.025) * life * 0.9 * ev.y;
    col += boltC * glow(d, 0.12) * life * 0.15 * ev.y;
    // The cloud lit from inside around where the bolt leaves it.
    float lit = exp(-length((p - vec2(x0, cloudBase + 0.3)) * vec2(0.6, 1.2)) * 2.2);
    float linger = life + 0.35 * exp(-age * 1.5);
    col += boltC * lit * (0.3 + cloud) * linger * 1.4 * ev.y;
    col += boltC * lit * 0.06 * linger * ev.y;
  }

  // --- the hills, and the wet ground ---
  float hill = groundY + 0.06 + 0.07 * (fbm(vec2(p.x * 1.3, 3.0), 3) * 0.5 + 0.5) + 0.05 * sin(p.x * 0.8 + 1.0);
  // A far-off glow on the horizon, so the hills stand against something.
  col += mix(uPalMid.rgb, vec3(1.0, 0.6, 0.35), 0.4) * exp(-max(p.y - hill, 0.0) * 9.0) * 0.05 * step(hill, p.y);
  if (p.y < hill) {
    col = mix(col, uPalBg.rgb * 0.05, smoothstep(hill + px, hill - px, p.y) * P_HILLS);
  }

  // --- the rain ---
  float rain = (0.4 + 0.6 * uFlow.x) * P_RAIN;
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    vec2 rp = vec2(p.x + p.y * 0.25, p.y) * vec2(70.0 + fl * 40.0, 1.6 + fl * 0.6);
    // Each column falls on its own phase, or the drops line up in a grid.
    rp.y += uClock.x * (2.5 + fl * 1.5) + hash11(floor(rp.x) + fl * 31.0) * 17.0;
    vec2 cell = floor(rp);
    float h = hash12(cell + fl * 17.0);
    float streak = step(0.9, h) * smoothstep(0.45, 0.0, abs(fract(rp.x) - 0.5)) * smoothstep(0.0, 0.7, fract(rp.y)) * smoothstep(1.0, 0.9, fract(rp.y));
    col += mix(uPalMid.rgb, vec3(0.8, 0.85, 1.0), 0.6) * streak * 0.05 * rain / (1.0 + fl);
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ ev, params, flash }) {
    const ring = eventRing(ev);
    // Never more than one strike a beat, never more than three a second.
    let lastAt = -1e9;
    let lastSec = -1e9;
    let n = 0;
    let clocksNow = null;
    let wall = 0;
    const strike = (s, power) => {
      if (s - lastAt < 1 / (params.bolts || 1) || wall - lastSec < 1 / 3) return;
      lastAt = s;
      lastSec = wall;
      const A = clocksNow?.aspect || 16 / 9;
      const hw = clocksNow?.hole?.[2] || 0;
      let x = (hashN(n * 3 + 1) * 2 - 1) * (A - 0.3);
      if (hw > 0 && Math.abs(x) < hw + 0.15) x = Math.sign(x || 1) * (hw + 0.15 + 0.3 * hashN(n + 5));
      ring.push(s, power, x, n * 1.37 + 0.5);
      n++;
    };
    const snare = onStamp((m) => m.stamp.snare, (s, m) => {
      if (m.drive > 0.4) strike(s, 0.7);
    });
    const big = onStamp((m) => m.stamp.big, (s) => strike(s, 1));
    // The drop splits the sky with a double strike: the one exception to the
    // one-a-beat rule, and still two in a second, not a strobe.
    const drop = onStamp((m) => m.stamp.drop, (s) => {
      lastAt = -1e9;
      lastSec = -1e9;
      strike(s, 1);
      lastAt = -1e9;
      lastSec = -1e9;
      strike(s + 0.25, 0.9);
      flash(0.9);
    });
    return {
      step(dt, m, clocks) {
        clocksNow = clocks;
        wall += dt;
        snare(m);
        big(m);
        drop(m);
      },
    };
  },
};
