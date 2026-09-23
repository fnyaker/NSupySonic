// BRASIER — the fire, fed by the guitars.
//
// Metal, hard rock, stoner, industrial: music that sounds like something
// burning. The picture is a wall of flame across the bottom of the frame,
// embers rising out of it, and the air above shimmering with the heat.
//
//   THE FLAMES are a noise field advected upward and folded by a second noise
//   (domain warping), which is what turns smooth noise into tongues that lick
//   and split. The field is a temperature, and temperature has a colour: it
//   is mapped through a blackbody ramp — deep red, orange, yellow, a white
//   core — leaned a third of the way toward the palette so a cold palette
//   burns a little blue. Cooler air above fades it out, and the top edge of
//   every tongue is broken by the fine octaves.
//   THE HEAT bends the air above the fire: everything drawn over the flames
//   is refracted by a rising shimmer.
//   THE EMBERS are instanced sparks thrown up out of the fire, drifting on the
//   heat, flickering and dying as they cool.
//   THE MUSIC. The guitars (the mids and the low end) set how high the fire
//   reaches; the kick makes it jump; the drop throws a fireball up out of the
//   middle and an ember storm with it.
//
// Parameters:
//   height  flame height    embers  ember count (x)
//   tint    palette lean (0 = pure fire)

import { eventRing, onStamp } from "./kit.js";

const EMBERS = 420;

const SHARED = `
vec3 blackbody(float t) {
  t = clamp(t, 0.0, 1.5);
  vec3 c = vec3(1.0, 0.14, 0.015) * smoothstep(0.0, 0.35, t);
  c = mix(c, vec3(1.0, 0.42, 0.04), smoothstep(0.3, 0.62, t));
  c = mix(c, vec3(1.0, 0.78, 0.3), smoothstep(0.6, 0.95, t));
  c = mix(c, vec3(1.0, 0.97, 0.9), smoothstep(0.9, 1.3, t));
  return c * (0.1 + 1.9 * t * t);
}
vec3 fireTint(vec3 c) { return mix(c, c * mix(vec3(1.0), uPalHigh.rgb * 1.6, 0.5), 0.2 * P_TINT); }
`;

export default {
  id: "inferno",
  uses: ["noise"],
  params: { height: 1, embers: 1, tint: 1 },
  look: { exposure: 1.0, bloom: 1.3, threshold: 0.7, saturation: 1.3 },

  fragment: `${SHARED}
void main() {
  vec2 p = fragP();
  float t = uClock.x * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  // How high the fire reaches: the guitars, and a jump on the kick.
  float reach = (0.85 + 0.4 * (uBandA.y + uBandA.z) + 0.3 * envB(uSince.x, 0.4) * amp + 0.25 * uS0.x) * P_HEIGHT;
  // Heat shimmer: the air above the flames bends.
  float shimmer = (gnoise(vec2(p.x * 9.0, p.y * 6.0 - t * 1.6)) * 0.006) * smoothstep(-1.0, -0.2, p.y);
  vec2 q = p + vec2(shimmer, 0.0);
  // The fire's coordinates: rising, folded by a second field.
  float h = (q.y + 1.0) / max(reach, 0.1);            // 0 at the bottom, 1 at the flame tips
  vec2 uv = vec2(q.x * 1.6, q.y * 1.2 - t * 0.55);
  vec2 warp = vec2(fbm(uv * 1.3 + vec2(0.0, -t * 0.2), 4), fbm(uv * 1.3 + vec2(5.2, -t * 0.25), 4)) - 0.5;
  float n = fbm(uv * 2.2 + warp * 1.6, 5) * 0.5 + 0.5;
  float fine = gnoise(uv * 9.0 + warp * 3.0) * 0.5 + 0.5;
  // Temperature: hot at the base, cooling upward, broken by the noise.
  // Contrast first: fire is tongues with dark air between them, not a glow.
  float nc = smoothstep(0.28, 0.85, n);
  float temp = nc * 1.35 - h * 0.95 + 0.08 + (fine - 0.5) * 0.3 * h;
  temp = max(temp, 0.0);
  temp *= smoothstep(1.35, 0.6, h);
  vec3 col = uPalBg.rgb * 0.3;
  // The glow the fire throws on the air.
  col += fireTint(vec3(1.0, 0.35, 0.08)) * exp(-max(h - 0.3, 0.0) * 1.6) * 0.06 * (0.6 + 0.4 * uFlow.x);
  col += fireTint(blackbody(temp)) * 0.7;

  // The fireball the drop throws up out of the middle.
  for (int i = 0; i < 8; i++) {
    vec4 ev = uEv[i];
    float age = uClock.x - ev.x;
    if (ev.y <= 0.0 || age < 0.0 || age > 6.0) continue;
    vec2 c = vec2(ev.z, -0.6 + age * 0.35);
    float R = 0.18 + age * 0.12;
    vec2 d = (q - c) / R;
    float ball = fbm(d * 2.0 + vec2(0.0, -age * 1.5) + ev.x, 4) * 0.5 + 0.5;
    float body = smoothstep(1.2, 0.2, length(d) + (ball - 0.5) * 0.8);
    float bt = body * (1.3 - age * 0.22) * ev.y;
    col += fireTint(blackbody(bt)) * 0.8;
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  particles: {
    count: EMBERS,
    vertex: `${SHARED}
void particle(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind) {
  float j = float(id);
  col = vec4(0.0); pos = vec2(0.0); axis = vec2(0.0); width = 0.0; kind = 0.0;
  if (j >= ${EMBERS}.0 * P_EMBERS * (0.4 + 0.6 * uQual.y)) return;
  vec3 h = hash31(j * 1.13 + 7.0);
  // Each ember is re-born on its own cycle: thrown up out of the fire, it
  // rises on the heat, drifts, cools and dies.
  float life = 2.5 + 3.0 * h.x;
  float cyc = uClock.x * uSpeed / life + h.y;
  float age = fract(cyc) * life;
  float gen = floor(cyc);
  vec3 g = hash31(j + gen * 13.1);
  // More of them while the fire is high, and a storm after the drop.
  float rate = 0.35 + 0.5 * uFlow.x + 0.8 * uS0.x;
  if (g.z > rate) return;
  float A = uFrame.z;
  vec2 at = vec2((g.x * 2.0 - 1.0) * A, -0.95 + 0.2 * g.y);
  float rise = 0.12 + 0.18 * h.z;
  float sway = sin(age * (1.5 + h.x) + j) * 0.05 * age;
  pos = at + vec2(sway + age * 0.03 * (h.y - 0.5), age * rise);
  vec2 vel = vec2(cos(age * (1.5 + h.x) + j) * 0.05, rise);
  float cool = 1.0 - age / life;
  // A flicker, so they twinkle as they tumble.
  float flick = 0.6 + 0.4 * sin(age * 22.0 + j * 3.0);
  axis = vel * 0.05 + normalize(vel) * 0.002;
  width = 0.002 + 0.002 * cool;
  col = vec4(fireTint(blackbody(0.35 + 0.7 * cool)) * cool * flick * 0.9, 1.0);
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  float d = length(q);
  return vec4(c.rgb * exp(-d * d * 3.0), 1.0);
}
`,
  },

  create({ ev, state, flash }) {
    const ring = eventRing(ev);
    let storm = 0;
    let n = 0;
    const drop = onStamp((m) => m.stamp.drop, (s) => {
      ring.push(s, 1, ((n++ % 3) - 1) * 0.5, 0);
      storm = 1;
      flash(0.9);
    });
    return {
      step(dt, m) {
        drop(m);
        storm = Math.max(0, storm - dt / m.overBeats(8));
        state[0] = storm;
      },
    };
  },
};
