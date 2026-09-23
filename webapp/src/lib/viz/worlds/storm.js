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
//   THE CLOUDS are a deck of domain-warped noise lit from BELOW by a band of
//   pale light low on the horizon — where the storm has not reached yet —
//   and from within by every strike; a billow is lit where its density falls
//   away toward that light, which is what makes it a volume and not a stain.
//   They roll on the bar clock.
//   THE LAKE under the far shore mirrors all of it, lightning included, broken
//   by the rain; the hills stand black against the band of light and catch a
//   rim of every strike.
//   THE RAIN falls in three layers of long slanted streaks, each drop on its
//   own line (a grid of columns reads as a dotted screen), lit by the flashes.
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

// The storm's horizon: under the middle, or just under the artwork.
float stormHorizon() { return uHole.z > 0.0 ? clamp(uHoleR.z - 0.03, -0.62, -0.3) : -0.38; }

// The cloud deck's density at q: domain-warped fbm, rolling on the bar clock.
float cloudD(vec2 q, float bars) {
  vec2 w = vec2(fbm(q * 0.7 + vec2(bars * 0.05, 0.0), 3), fbm(q * 0.7 + vec2(4.1, -bars * 0.04), 3));
  // Billows, not streaks: a low base frequency, and the finer octaves only
  // carving its edges.
  float base = fbm(q * 0.9 + w * 0.9 + vec2(bars * 0.06, 0.0), 3);
  float edge = fbm(q * 3.2 + w * 1.6 + vec2(bars * 0.12, 0.0), 3);
  return (base * 0.8 + edge * 0.28) * 0.5 + 0.5;
}

// Everything above the water: sky, cloud deck, the light under it, the
// lightning. Called twice below the horizon, once for the reflection.
vec3 skyAt(vec2 p, float bars, float hy, float amp, float px) {
  float A = uFrame.z;
  vec3 boltC = mix(vec3(0.85, 0.8, 1.0), uPalHigh.rgb, 0.3);
  vec3 warm = mix(vec3(1.0, 0.62, 0.38), uPalMid.rgb, 0.35);
  // The sky behind the deck: dark overhead, and a band of pale light low down
  // where the storm has not reached yet — it is what the hills stand against
  // and what lights the underside of the cloud.
  float alt = p.y - hy;
  vec3 col = mix(uPalLow.rgb * 0.05 + uPalBg.rgb * 0.3, uPalBg.rgb * 0.18, smoothstep(0.0, 1.2, alt));
  float band = exp(-max(alt, 0.0) * 5.5);
  col += warm * band * 0.16 + mix(uPalMid.rgb, uPalHigh.rgb, 0.3) * band * 0.05;

  // The deck: thick overhead, breaking up toward the band of light.
  vec2 q = vec2(p.x * 0.9, (p.y - hy) * 1.25);
  float d0 = cloudD(q, bars);
  float d1 = cloudD(q + vec2(0.015, -0.06), bars);
  float thick = smoothstep(0.1, 0.7, alt);
  float cover = smoothstep(0.4, 0.62, d0 * (0.6 + 0.6 * thick)) * smoothstep(0.08, 0.3, alt);
  // Lit from below: where the density falls away toward the light, the billow
  // faces it — that is what turns a noise into a volume.
  float face = clamp((d0 - d1) * 9.0 + 0.3, 0.0, 1.0);
  // The bass rumbles the base of the deck.
  face *= 1.0 + 0.25 * uBandA.x * (0.5 + 0.5 * sin(p.x * 5.0 + uClock.x * 1.5));
  vec3 under = warm * 0.3 * exp(-max(alt - 0.12, 0.0) * 1.6);
  // Dense cores are darker than thin edges: the deck is heavy with rain.
  float dense = smoothstep(0.55, 0.85, d0);
  vec3 cloudC = (uPalBg.rgb * 0.16 + uPalLow.rgb * 0.035) * (1.0 - 0.5 * dense) + under * face * face * (1.0 - 0.4 * dense) + vec3(0.004);
  col = mix(col, cloudC, cover);

  // Sheet lightning: every main kick lights a patch of the deck from inside.
  vec2 kAt = vec2((hash11(uCount.z * 1.7) * 2.0 - 1.0) * (A - 0.2), hy + 0.7 + 0.3 * hash11(uCount.z * 2.9));
  float sheet = exp(-length((p - kAt) * vec2(0.7, 1.3)) * 2.2) * envB(uSince.y, 0.3) * amp;
  col += mix(vec3(0.8, 0.8, 1.0), uPalHigh.rgb, 0.4) * sheet * (0.1 + cover * (0.4 + face)) * 0.9;

  // The strikes: a white-hot core in a violet glow, and the deck lit from
  // inside where each one leaves it.
  float top = hy + 0.62;
  for (int i = 0; i < 8; i++) {
    vec4 ev = uEv[i];
    float age = uClock.x - ev.x;
    if (ev.y <= 0.0 || age < 0.0 || age > 1.5) continue;
    float x0 = ev.z;
    float life = exp(-age * 5.0) + 0.6 * exp(-pow((age - 0.18) * 25.0, 2.0));
    float linger = life + 0.35 * exp(-age * 1.5);
    // The channel stays faintly lit after the flash, the way the eye keeps it.
    float after = 0.12 * exp(-age * 2.2);
    float lit = exp(-length((p - vec2(x0, top + 0.1)) * vec2(0.55, 1.1)) * 2.0);
    col += boltC * lit * (0.1 + cover * (0.6 + face)) * linger * 1.2 * ev.y;
    if (p.y > top + 0.05 || p.y < hy - 0.02) continue;
    float bh;
    float d = bolt(p, ev.w, x0, top, hy + 0.02, bh);
    float core = exp(-d * d / (px * px * 4.0 + 1e-7));
    col += vec3(1.0) * core * (life * 3.5 + after * 2.0) * ev.y * (1.0 - 0.4 * bh);
    col += boltC * glow(d, 0.025) * (life * 0.9 + after) * ev.y;
    col += boltC * glow(d, 0.12) * life * 0.15 * ev.y;
  }
  return col;
}

// How much light the strikes throw at this moment (for the hills' rims and
// the rain).
float strikeLight() {
  float s = 0.0;
  for (int i = 0; i < 8; i++) {
    vec4 ev = uEv[i];
    float age = uClock.x - ev.x;
    if (ev.y <= 0.0 || age < 0.0 || age > 1.5) continue;
    s += (exp(-age * 5.0) + 0.6 * exp(-pow((age - 0.18) * 25.0, 2.0))) * ev.y;
  }
  return s;
}

void main() {
  vec2 p = fragP();
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float px = uFrame.w;
  float hy = stormHorizon();
  float flashL = strikeLight() + 0.6 * envB(uSince.y, 0.3) * amp;
  vec3 boltC = mix(vec3(0.85, 0.8, 1.0), uPalHigh.rgb, 0.3);
  vec3 col;

  if (p.y >= hy) {
    col = skyAt(p, bars, hy, amp, px);
  } else {
    // --- the lake: the sky mirrored, broken by the rain on its surface ---
    float depth = hy - p.y;
    float persp = 1.0 / (0.08 + depth * 2.0);
    vec2 rip = vec2(gnoise(vec2(p.x * 7.0 * persp, uClock.x * 1.6)), gnoise(vec2(p.x * 3.0, depth * 60.0 - uClock.x * 2.0))) - 0.5;
    vec2 pr = vec2(p.x + rip.x * 0.01, hy + depth + rip.y * 0.012 * (0.3 + depth * 2.0));
    vec3 refl = skyAt(pr, bars, hy, amp, px);
    float fres = mix(0.6, 0.18, smoothstep(0.0, 0.5, depth));
    // Rain on the water: a scatter of rings, foreshortened, each one opening
    // and fading within a beat.
    vec2 rg = vec2(p.x * 26.0, log(depth + 0.02) * 22.0);
    vec2 rc = floor(rg);
    vec3 rh = hash32(vec2(rc.x + 3.0, rc.y + floor(uClock.x * 2.0 + hash12(rc) * 2.0)));
    float ringAge = fract(uClock.x * 2.0 + hash12(rc) * 2.0);
    float ringR = length((fract(rg) - 0.3 - 0.4 * rh.xy) * vec2(1.0, 2.6));
    float ring = smoothstep(0.06, 0.0, abs(ringR - ringAge * 0.4)) * (1.0 - ringAge) * step(0.55, rh.z) * smoothstep(0.0, 0.15, depth);
    col = uPalBg.rgb * 0.04 + refl * fres * (1.0 + ring * 1.5) + mix(uPalMid.rgb, vec3(0.8), 0.5) * ring * 0.012 * P_RAIN;
    // The line where the water meets the land, catching the light.
    col += mix(uPalMid.rgb, vec3(1.0, 0.7, 0.45), 0.4) * exp(-depth / (px * 1.5)) * 0.08;
  }

  // --- the hills: a silhouette against the band of light, rim-lit by the
  // strikes, standing on the far shore ---
  // Ridged noise: peaks, not a swell — a mountain line has crests.
  float ridge = 1.0 - abs(fbm(vec2(p.x * 0.9, 3.0), 5));
  float hill = hy + (0.02 + 0.16 * pow(ridge, 3.0) + 0.03 * sin(p.x * 0.6 + 1.0)) * P_HILLS;
  if (p.y > hy - px && p.y < hill + px) {
    float inside = smoothstep(hill + px, hill - px, p.y) * step(hy - px, p.y);
    vec3 land = uPalBg.rgb * 0.035;
    land += boltC * exp(-(hill - p.y) / (px * 2.0)) * flashL * 0.25;
    col = mix(col, land, inside);
  }

  // --- the rain: long slanted streaks, each drop on its own line ---
  float rain = (0.45 + 0.55 * uFlow.x) * P_RAIN;
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float slant = 0.22;
    vec2 rq = vec2(p.x + p.y * slant, p.y);
    float cw = 0.018 + 0.014 * fl;           // column pitch
    float len = 0.09 + 0.06 * fl;            // streak length
    float spd = 3.2 + 1.4 * fl;              // falls this many units a beat
    float ci = floor(rq.x / cw);
    vec3 h = hash31(ci * 1.91 + fl * 37.0);
    float x = (ci + 0.2 + 0.6 * h.x) * cw;
    float y = rq.y + uClock.x * spd + h.y * 13.0;
    float cellH = len * (2.5 + 2.0 * h.z);
    float cy = floor(y / cellH);
    float h2 = hash11(cy * 3.7 + ci * 0.61 + fl * 11.0);
    if (h2 > 0.16 + 0.14 * rain) continue;
    float fy = fract(y / cellH) * cellH;       // position along the cell
    float along = smoothstep(0.0, len * 0.2, fy) * smoothstep(len, len * 0.3, fy);
    float wdt = px * (0.6 + 0.5 * fl);
    float across = smoothstep(wdt + px, wdt - px * 0.5, abs(rq.x - x) * 0.98);
    float bright = (0.02 + 0.012 * fl) * (1.0 + 1.6 * min(flashL, 1.5));
    col += mix(uPalMid.rgb, vec3(0.8, 0.85, 1.0), 0.6) * along * across * bright * rain;
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
      const hx = clocksNow?.hole?.[0] || 0;
      const hw = clocksNow?.hole?.[2] || 0;
      let x = (hashN(n * 3 + 1) * 2 - 1) * (A - 0.3);
      // Clear of the artwork, round its real centre.
      if (hw > 0 && Math.abs(x - hx) < hw + 0.15) x = hx + Math.sign(x - hx || 1) * (hw + 0.15 + 0.3 * hashN(n + 5));
      x = Math.max(-A + 0.15, Math.min(A - 0.15, x));
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
