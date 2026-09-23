// FEU D'ARTIFICE — shells that burst on the beat.
//
// The anthem moment of every festival set, drawn literally: rockets climbing
// out of a skyline and bursting ON the beat, not near it. The grid is known
// in advance — the beat tracker predicts it — so a shell is launched on one
// beat aimed at the NEXT one, and its trail climbs for exactly a beat before
// the burst lands where the kick does.
//
//   THE SHELLS. A peony (a sphere of sparks — projected from three
//   dimensions, so it is dense at the rim the way a real one is), a ring, a
//   willow (gold, slow, drooping into long trails) and a crackle (a peony
//   whose sparks break into glitter as they die). Which one fires is the
//   music's call: the drop fires peonies on every beat, a big kick a double,
//   a breakdown a single slow willow per bar, a chord change a ring.
//   THE SPARKS are one instanced pass, a hundred and twenty per shell, eight
//   shells alive at once. Each is a closed-form trajectory — launch speed,
//   drag, gravity — evaluated at its age, so there is no simulation state
//   anywhere and a spark is exactly where physics says at any frame rate.
//   Their streak is their own path over the last sliver of time.
//   THE COLOURS are a real show's — red, green, blue, gold and silver, the
//   salts shells are made of — turned to the palette's own hue, so the bursts
//   contrast with each other and still belong to the record.
//   THE SKY. Each burst lights the smoke it leaves; a far skyline in the haze
//   and a near one of towers, spires and blinking masts stand along the
//   bottom, their rooflines catching every burst in its colour, and the
//   water in front throws a column of each one's light toward us.
//
// Parameters:
//   shells  how often (x)       size   burst size
//   smoke   smoke glow          city   the skyline

import { eventRing, onStamp, hashN } from "./kit.js";

const PER = 120;
const SHELLS = 8;

const SHARED = `
// Shell i: birth (beats), power, x, and y+type packed as (y + 1) + 10 * type.
void shell(int i, out float birth, out float power, out vec2 at, out float type) {
  vec4 e = uEv[i];
  birth = e.x;
  power = e.y;
  type = floor(e.w / 10.0);
  at = vec2(e.z, mod(e.w, 10.0) - 1.0);
}
float waterY() { return -0.78; }
// A shell's colour. Real shells are the salts that make them — strontium red,
// barium green, copper blue, sodium gold, magnesium silver — so a show has
// contrast between its bursts that a single palette does not. The set is
// turned to the palette's own hue, so it still belongs to the record, and one
// shell in four is gold or silver, as a real show's are.
vec3 shellHue(float birth) {
  float h = hash11(birth * 3.7);
  if (h < 0.14) return vec3(1.0, 0.72, 0.32);            // gold
  if (h < 0.25) return vec3(0.85, 0.9, 1.0);             // silver
  float k = floor(fract(h * 7.3) * 4.0);
  float hue = fract(uPalHigh.w + k * 0.25 + 0.04 * fract(h * 31.0));
  return mix(hue2rgb(hue), vec3(1.0), 0.12);
}
`;

export default {
  id: "fireworks",
  uses: ["noise"],
  params: { shells: 1, size: 1, smoke: 1, city: 1 },
  look: { exposure: 1.0, bloom: 1.4, threshold: 0.6, saturation: 1.25 },

  fragment: `${SHARED}
void main() {
  vec2 p = fragP();
  float tb = uClock.x;
  // The night: deep at the top, a little glow of city light at the horizon.
  vec3 col = mix(uPalBg.rgb * 0.6, uPalLow.rgb * 0.08, smoothstep(0.6, -0.8, p.y));
  float wy = waterY();
  // Reflections are drawn by folding the point back up over the waterline.
  bool water = p.y < wy;
  vec2 q = water ? vec2(p.x + 0.01 * sin(p.y * 90.0 + tb * 3.0), 2.0 * wy - p.y) : p;

  // A few stars, above the haze of the city.
  {
    vec2 sc = floor(p * 90.0);
    float sh = hash12(sc + 7.0);
    if (!water && sh > 0.985) {
      vec2 sp = fract(p * 90.0) - 0.5;
      col += vec3(0.8, 0.85, 1.0) * exp(-dot(sp, sp) * 30.0) * 0.12 * smoothstep(-0.4, 0.4, p.y)
           * (0.6 + 0.4 * sin(tb * 0.7 + sh * 90.0));
    }
  }

  // --- the smoke each burst leaves, lit by it ---
  vec3 smoke = vec3(0.0);
  vec3 burstL = vec3(0.0);
  vec3 burstW = vec3(0.0);
  for (int i = 0; i < ${SHELLS}; i++) {
    float birth, power, type;
    vec2 at;
    shell(i, birth, power, at, type);
    float age = tb - birth;
    if (power <= 0.0 || age < 0.0 || age > 12.0) continue;
    vec3 hue = shellHue(birth);
    float R = (0.25 + 0.3 * P_SIZE * power) * (0.4 + 0.6 * (1.0 - exp(-age * 1.5)));
    vec2 sp = q - at - vec2(0.0, -0.03 * age);
    float cloud = gnoise(sp * 5.0 + birth) * 0.5 + 0.5;
    float body = exp(-dot(sp, sp) / (R * R)) * cloud;
    // Lit hard at the burst, then only by what is still burning.
    float lit = exp(-age * 1.2) * 1.2 + 0.08 * exp(-age * 0.25);
    smoke += mix(hue, vec3(1.0), 0.3) * body * lit * power;
    // The flash of the burst itself lights the whole sky a little.
    col += hue * exp(-age * 5.0) * 0.08 * power * exp(-length(q - at) * 1.5);
    // ...and the city under it, and the water: how much of this burst
    // reaches this column of the frame.
    float fl = (exp(-age * 3.0) + 0.15 * exp(-age * 0.7)) * power;
    burstL += hue * fl / (1.0 + abs(p.x - at.x) * 2.5);
    if (water) {
      float dx = p.x - at.x;
      float w = 0.03 + 0.06 * power;
      burstW += hue * fl * exp(-dx * dx / (w * w)) * exp(-(wy - p.y) * 3.0);
    }
  }
  col += smoke * 0.18 * P_SMOKE;

  // --- the skyline: a far layer in the haze, a near one with its windows ---
  if (P_CITY > 0.02 && !water) {
    // Far: lower, bluer, softened by the air between.
    float bw2 = 0.045;
    float h2 = hash11(floor(p.x / bw2) * 2.3 + 11.0);
    float top2 = wy + 0.03 + 0.13 * h2 * h2;
    if (p.y < top2 + 0.003) {
      vec3 far = mix(uPalBg.rgb * 0.35, uPalLow.rgb * 0.12, 0.5) + burstL * 0.03;
      col = mix(col, far, P_CITY * smoothstep(top2 + 0.002, top2 - 0.002, p.y));
    }
    float bw = 0.07;
    float bi = floor(p.x / bw);
    float fx = fract(p.x / bw);
    float bh = hash11(bi * 1.7 + 3.0);
    float kind = hash11(bi * 5.1 + 0.7);
    float top = wy + 0.04 + 0.22 * bh * bh;
    // Some towers end in a spire, some carry a mast with a warning light.
    // A spire is a needle on a tower, not a gable: narrow, tall and rare, or
    // the skyline reads as a row of houses.
    float spire = kind > 0.9 && bh > 0.45 ? 0.1 * max(0.0, 1.0 - abs(fx - 0.5) * 7.0) : 0.0;
    float mast = kind > 0.68 && kind <= 0.84 && abs(fx - 0.5) < 0.035 ? 0.06 : 0.0;
    float edge = top + spire + mast;
    if (p.y < edge + 0.004) {
      float inB = smoothstep(edge + 0.0025, edge - 0.0025, p.y) * step(0.06, fx) * step(fx, 0.94);
      vec3 bld = uPalBg.rgb * 0.12 + burstL * 0.025;
      vec2 w = vec2(fract(fx * 5.0), fract((p.y - wy) * 45.0));
      float win = step(0.3, w.x) * step(w.x, 0.7) * step(0.35, w.y) * step(w.y, 0.75) * step(p.y, top - 0.01);
      float wh = hash12(vec2(floor(p.x / bw * 5.0), floor((p.y - wy) * 45.0)));
      vec3 wc = wh > 0.9 ? vec3(0.6, 0.8, 1.0) : vec3(1.0, 0.72, 0.38);
      bld += wc * win * step(0.62, wh) * 0.08;
      // The bursts catch the roofline: a rim of the show's own colours.
      bld += burstL * smoothstep(edge - 0.012, edge, p.y) * 0.35;
      col = mix(col, bld, inB * P_CITY);
      // The mast's light, blinking on the bar.
      if (mast > 0.0) {
        vec2 lq = vec2((fx - 0.5) * bw, p.y - edge);
        col += vec3(1.0, 0.1, 0.05) * exp(-dot(lq, lq) * 4e4) * step(0.5, fract(uClock.y + bh)) * 0.8 * P_CITY;
      }
    }
  }
  if (water) {
    // The water: the sky above, reflected darker, rippled — and under every
    // burst a column of its light, stretched down toward us by the swell.
    float rip = 0.75 + 0.25 * sin(p.y * 160.0 + tb * 2.0 + sin(p.x * 30.0) * 2.0);
    col = col * 0.45 + uPalMid.rgb * 0.01 + burstW * 0.35 * rip;
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  particles: {
    // Twice over: every spark is drawn again, mirrored, as its reflection.
    count: PER * SHELLS * 2,
    vertex: `${SHARED}
void particle(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind) {
  col = vec4(0.0); pos = vec2(0.0); axis = vec2(0.0); width = 0.0; kind = 0.0;
  bool mirror = id >= ${PER * SHELLS};
  if (mirror) id -= ${PER * SHELLS};
  int si = id / ${PER};
  float j = float(id - si * ${PER});
  float birth, power, type;
  vec2 at;
  shell(si, birth, power, at, type);
  if (power <= 0.0) return;
  float tb = uClock.x;
  float age = tb - birth;
  vec3 h = hash31(j * 1.618 + birth * 0.37);
  vec3 hue = shellHue(birth);
  // --- the climb: a beat of rocket trail before the burst ---
  if (age < 0.0) {
    if (age < -1.0 || j > 5.0) return;
    float u = 1.0 + age;               // 0 at launch, 1 at the burst
    float y0 = waterY() + 0.1;
    // Decelerating as it climbs, like a shell losing its lift.
    // Five sparks: the head, and four falling off it.
    float lag = j * 0.035;
    vec2 b = vec2(at.x - 0.05 * (1.0 - u + lag), mix(y0, at.y, max(0.0, 1.0 - (1.0 - u + lag) * (1.0 - u + lag))));
    pos = b + vec2(0.0, -j * 0.006);
    axis = vec2(0.0, 0.02 + 0.03 * (1.0 - u));
    width = 0.004 - j * 0.0005;
    col = vec4(mix(vec3(1.0, 0.8, 0.5), hue, 0.3) * (1.4 - j * 0.22), 1.0);
    kind = 1.0;
  } else {
    float life = type > 1.5 && type < 2.5 ? 5.0 : 3.0;
    if (age > life) return;
    // --- the burst ---
    float speed = (0.95 + 0.5 * power) * P_SIZE;
    vec2 dir;
    if (type > 0.5 && type < 1.5) {
      // A ring: every spark on one circle, tilted.
      float a = j / ${PER}.0 * TAU;
      dir = vec2(cos(a), sin(a) * 0.45) * (0.95 + 0.05 * h.x);
      dir = rot(birth) * dir;
    } else {
      // A sphere, projected: uniform on the sphere, so dense at the rim.
      float z = h.x * 2.0 - 1.0;
      float a = h.y * TAU;
      dir = vec2(cos(a), sin(a)) * sqrt(1.0 - z * z) * (0.9 + 0.1 * h.z);
    }
    float kd = type > 1.5 && type < 2.5 ? 1.8 : 1.35;  // drag
    float g = type > 1.5 && type < 2.5 ? 0.32 : 0.13;   // gravity
    vec2 v0 = dir * speed;
    // The streak joins where the spark IS to where it WAS a sliver of time
    // ago — long for a willow, whose trails are the point of it — so it
    // follows the real path, and is exact at any frame rate.
    float lag = type > 1.5 && type < 2.5 ? 2.2 : 0.35;
    float a0 = max(age - lag, 0.0);
    float e = exp(-kd * age);
    float e0 = exp(-kd * a0);
    pos = at + v0 * (1.0 - e) / kd + vec2(0.0, -g) * (age / kd - (1.0 - e) / (kd * kd));
    vec2 was = at + v0 * (1.0 - e0) / kd + vec2(0.0, -g) * (a0 / kd - (1.0 - e0) / (kd * kd));
    float t = age / life;
    vec2 seg = pos - was;
    pos = (pos + was) * 0.5;
    axis = seg * 0.5 + normalize(seg + 1e-5) * 0.003;
    width = 0.0055 * (1.0 - 0.45 * t);
    // White-hot at the burst, the shell's colour, then embers.
    vec3 c = mix(vec3(1.0), hue, smoothstep(0.0, 0.12, t));
    if (type > 1.5 && type < 2.5) c = mix(vec3(1.0, 0.85, 0.5), vec3(1.0, 0.5, 0.15), t);
    float fade = (1.0 - t) * (1.0 - t);
    // The crackle: sparks that break into glitter as they die.
    if (type > 2.5) fade *= t > 0.5 ? step(0.5, hash11(j + floor(age * 24.0))) * 2.0 : 1.0;
    // Every spark twinkles a little as it burns down, a burning fleck
    // tumbling, not a dot fading out.
    else fade *= 1.0 - 0.5 * smoothstep(0.4, 0.9, t) * step(0.5, hash11(j * 3.1 + floor(age * 12.0)));
    col = vec4(c * fade * (3.0 + 1.5 * power), 1.0);
    kind = 0.0;
  }
  // Nothing burns under the water; its reflection is dimmer and rippled.
  float wy = waterY();
  if (pos.y < wy) { col = vec4(0.0); return; }
  if (mirror) {
    pos.y = 2.0 * wy - pos.y;
    axis.y = -axis.y * 1.8;
    pos.x += 0.01 * sin(pos.y * 90.0 + uClock.x * 3.0);
    col.rgb *= 0.35 * exp(-(wy - pos.y) * 3.0);
  }
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  float r = 1.0 - smoothstep(0.0, 1.0, length(q));
  float head = smoothstep(-0.6, 1.0, q.x);
  return vec4(c.rgb * r * r * (0.2 + 1.2 * head), 1.0);
}
`,
  },

  create({ ev, params, flash }) {
    const ring = eventRing(ev);
    let n = 0;
    let lastBar = -1;
    // Where a shell may burst: high in the sky, and clear of the artwork.
    const place = (seed, clocks) => {
      const A = clocks?.aspect || 16 / 9;
      let x = (hashN(seed * 3 + 1) * 2 - 1) * (A - 0.35);
      const y = 0.15 + 0.55 * hashN(seed * 7 + 2);
      const hw = clocks?.hole?.[2] || 0;
      if (hw > 0 && Math.abs(x) < hw + 0.25) x = Math.sign(x || 1) * (hw + 0.25 + 0.3 * hashN(seed + 9));
      return [Math.max(-A + 0.2, Math.min(A - 0.2, x)), y];
    };
    const fire = (at, power, type, clocks) => {
      const [x, y] = place(n++, clocks);
      ring.push(at, power, x, y + 1 + 10 * type);
    };
    let clocksNow = null;
    // Every beat launches a shell aimed at the NEXT beat, when the music calls
    // for one.
    const beat = onStamp((m) => m.stamp.beat, (s, m) => {
      const rate = params.shells || 1;
      const beatIdx = Math.round(s);
      const hard = m.drive > 0.55 && m.breakdown < 0.4;
      if (hard && (m.dropped > 0.3 || hashN(beatIdx) < 0.5 * rate)) {
        fire(s + 1, 0.7 + 0.3 * m.drive, hashN(beatIdx + 3) < 0.25 ? 3 : 0, clocksNow);
      } else if (m.build > 0.4 && beatIdx % 2 === 0) {
        fire(s + 1, 0.5, 0, clocksNow);
      }
      const bar = Math.floor(s / 4);
      if (bar !== lastBar && beatIdx % 4 === 0) {
        lastBar = bar;
        if (m.breakdown > 0.4 || m.drive < 0.35) fire(s + 1, 0.8, 2, clocksNow);
      }
    });
    const big = onStamp((m) => m.stamp.big, (s) => fire(s + 0.5, 1, 0, clocksNow));
    const chord = onStamp((m) => m.stamp.chord, (s, m) => {
      if (m.breakdown < 0.6) fire(s + 1, 0.7, 1, clocksNow);
    });
    const drop = onStamp((m) => m.stamp.drop, (s) => {
      fire(s, 1, 0, clocksNow);
      fire(s + 0.25, 1, 3, clocksNow);
      flash(0.9);
    });
    return {
      step(dt, m, clocks) {
        clocksNow = clocks;
        beat(m);
        big(m);
        chord(m);
        drop(m);
      },
    };
  },
};
