// SCIE — zaag is Dutch for saw.
//
// And the sound is one: a kick and a lead with a serrated, ripping edge. So the
// hero is a circular saw blade, lit like steel, spinning at the tempo and
// jolted a notch forward by every main kick, throwing a continuous stream of
// sparks off the point where it cuts — and, behind it, the lead drawn as what
// it is, sawtooth waves of laser light scrolling across the frame.
//
// With the artwork in front, the blade is a RING around it and the cover is
// its hub; with none, it has its own hub, bolts and all. Either way the teeth
// are real teeth — a saw profile with a hook and a gullet, not a zig-zag — and
// the steel has the concentric brushed grain a machined disc has, catching a
// highlight that turns with the blade.
//
// Parameters:
//   teeth   tooth count         sparks  spark-stream strength
//   waves   sawtooth laser rows  hot     how hot the cutting edge glows

import { onStamp } from "./kit.js";

const STREAM = 360;

const SHARED = `
float bladeIn() {
  return uHole.z > 0.0 ? length(uHole.zw) * 1.02 : 0.13;
}
float bladeOut() {
  float room = min(frameHalf().x, 1.0) * 0.92;
  return uHole.z > 0.0 ? min(bladeIn() + 0.24, room) : min(0.78, room);
}
vec3 heat(float t) {
  t = clamp(t, 0.0, 1.0);
  return vec3(1.0, mix(0.1, 0.92, t * t), mix(0.02, 0.8, t * t * t * t)) * (0.25 + 3.0 * t * t);
}
`;

export default {
  id: "saw",
  uses: ["noise"],
  params: { teeth: 36, sparks: 1, waves: 1, hot: 1 },
  look: { exposure: 1.0, bloom: 1.2, threshold: 0.8, saturation: 1.15 },

  fragment: `${SHARED}
void main() {
  vec2 p = fragP();
  float beats = uClock.x * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  vec3 col = uPalBg.rgb * 0.55;

  // --- the sawtooth lasers, behind everything ---
  float rows = floor(5.0 * P_WAVES + 0.5);
  for (int k = 0; k < 6; k++) {
    float fk = float(k);
    if (fk >= rows) break;
    float y0 = mix(-0.92, 0.92, (fk + 0.5) / max(rows, 1.0));
    float period = 0.32 + 0.12 * mod(fk, 3.0);
    float x = p.x / period + beats * (fk < rows * 0.5 ? 0.5 : -0.5) * (1.0 + 0.3 * fk);
    float saw = fract(x);
    // A ramp and a vertical drop: the waveform, literally.
    float h = 0.05 + 0.04 * uLookB.y + 0.05 * uHit2.y;
    float yRamp = y0 + (saw - 0.5) * 2.0 * h;
    float dRamp = abs(p.y - yRamp) * inversesqrt(1.0 + pow(2.0 * h / period, 2.0));
    float dDrop = abs(saw - 0.0) * period;
    dDrop = min(dDrop, abs(saw - 1.0) * period);
    float onDrop = step(abs(p.y - y0), h);
    float d = min(dRamp, mix(1e3, dDrop, onDrop));
    vec3 c = pal(fk / max(rows - 1.0, 1.0));
    float bright = (0.25 + 0.75 * uBandB.w) * (0.4 + 0.6 * uFlow.x);
    col += c * (glow(d, 0.0035) + 0.1 * glow(d, 0.03)) * bright * uEnergy;
  }

  // --- the blade ---
  vec2 d = p - uHole.xy;
  float r = length(d);
  float ang = atan(d.y, d.x) - uS0.x;
  float Rin = bladeIn();
  float Rout = bladeOut();
  float N = floor(P_TEETH);
  float u = fract(ang / TAU * N);
  // A tooth: a steep face, a sloping back and a rounded gullet.
  float tooth = u < 0.12 ? u / 0.12 : 1.0 - smoothstep(0.12, 1.0, u);
  float depth = (Rout - Rin) * 0.16;
  float edgeR = Rout - depth + depth * tooth;
  float aa = uFrame.w * 1.5;
  float disc = smoothstep(edgeR + aa, edgeR - aa, r) * smoothstep(Rin - aa, Rin + aa, r);
  if (disc > 0.0) {
    // Brushed steel: fine concentric grain, a broad highlight that turns with
    // the blade, darker toward the hub.
    // The grain's ring spacing is held above two pixels: finer than that it
    // aliases into moire rings instead of reading as brushed metal.
    float gf = min(900.0, 0.45 / max(uFrame.w, 1e-4));
    float grain = 0.5 + 0.5 * sin(r * gf + fbm(vec2(r * 60.0, ang * 2.0), 2) * 6.0);
    float hl = pow(0.5 + 0.5 * cos(ang * 2.0 + 1.1), 6.0);
    float hl2 = pow(0.5 + 0.5 * cos(ang * 2.0 - 2.0), 12.0);
    vec3 steel = mix(uPalBg.rgb * 0.8 + vec3(0.03), vec3(0.55), hl * 0.6 + hl2 * 0.3);
    steel *= 0.75 + 0.25 * grain;
    steel += uPalMid.rgb * 0.08 * hl;
    // Expansion slots, the way a real blade has them.
    for (int k = 0; k < 4; k++) {
      float sa = float(k) * 1.5708;
      float da = abs(mod(ang - sa + PI, TAU) - PI);
      float slot = step(da * r, 0.004) * step(Rin + (Rout - Rin) * 0.35, r) * step(r, Rout - depth * 1.6);
      steel *= 1.0 - 0.8 * slot;
    }
    col = mix(col, steel, disc);
    // The cutting edge, hot where it cuts (the bottom) and on the kick.
    float edge = exp(-(edgeR - r) / (0.004 + aa));
    float cut = smoothstep(0.2, -1.0, d.y / max(r, 1e-4));
    float hot = (0.25 + 0.75 * cut) * (0.25 + 1.2 * uHit.y) * P_HOT;
    col += heat(0.4 + 0.5 * cut) * edge * hot * disc;
  }
  // The hub, when there is no artwork to be one.
  if (uHole.z <= 0.0) {
    float hub = smoothstep(Rin + aa, Rin - aa, r);
    vec3 hc = uPalBg.rgb * 0.3 + vec3(0.12) * (0.5 + 0.5 * cos(ang + 0.6));
    for (int k = 0; k < 5; k++) {
      vec2 b = vec2(cos(float(k) * 1.2566 + uS0.x), sin(float(k) * 1.2566 + uS0.x)) * Rin * 0.6;
      hc *= mix(0.3, 1.0, smoothstep(0.0, Rin * 0.1, length(d - b) - Rin * 0.12));
    }
    col = mix(col, hc, hub);
  }
  // A thin rim of light around the blade: the laser haze catching it.
  col += mix(uPalHigh.rgb, uPalAcc.rgb, 0.4) * glow(abs(r - Rout), 0.01) * 0.12 * (0.5 + uFlow.x);
  col += heat(0.9) * uHit2.w * 0.2;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.04));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  particles: {
    count: STREAM,
    vertex: `${SHARED}
void particle(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind) {
  float j = float(id);
  vec3 h = hash31(j * 3.17 + 1.0);
  col = vec4(0.0); pos = vec2(0.0); axis = vec2(0.0); width = 0.0; kind = 0.0;
  // A continuous stream: each spark is re-born on its own cycle, so the stream
  // never stops while the blade turns, and thickens on the kick.
  float life = 0.9 + 0.8 * h.x;
  float cyc = uClock.x * uSpeed / life + h.y;
  float age = fract(cyc) * life;
  float gen = floor(cyc);
  float rate = 0.35 + 0.65 * uFlow.x + 0.6 * uHit.y;
  if (hash12(vec2(j, gen)) > rate * P_SPARKS) return;
  float Rout = bladeOut();
  // Thrown off the bottom of the blade, tangentially (the blade turns
  // counter-clockwise, so the bottom edge moves to the right).
  float a0 = -1.5708 + (h.z - 0.5) * 0.5;
  vec2 at0 = uHole.xy + vec2(cos(a0), sin(a0)) * Rout;
  vec2 tang = vec2(-sin(a0), cos(a0));
  vec2 v0 = (tang * (1.4 + 1.8 * h.x) + vec2(0.0, -0.3 - 0.5 * h.y)) * Rout;
  float k = 1.2;
  float dr = (1.0 - exp(-k * age)) / k;
  pos = at0 + v0 * dr + vec2(0.0, -0.8 * age * age);
  vec2 vel = v0 * exp(-k * age) + vec2(0.0, -1.6 * age);
  float t = 1.0 - age / life;
  axis = vel * 0.05 + normalize(vel + 1e-5) * 0.004;
  width = 0.0035 + 0.003 * t;
  col = vec4(heat(0.3 + 0.7 * t) * (0.6 + 0.6 * h.z), 1.0);
  kind = t;
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  float r = 1.0 - smoothstep(0.0, 1.0, length(q));
  float head = smoothstep(-0.2, 1.0, q.x);
  return vec4(c.rgb * r * (0.3 + 1.3 * head * head), 1.0);
}
`,
  },

  create({ state, flash }) {
    // The blade's angle: a steady turn at the tempo, plus a notch forward on
    // every main kick, eased so the jolt reads as a torque, not a teleport.
    let spin = 0;
    let target = 0;
    const main = onStamp((m) => m.stamp.main, (s, m) => {
      target += 0.35 * (0.6 + 0.6 * Math.min(1.2, m.mainPower || 0.8));
    });
    const drop = onStamp((m) => m.stamp.drop, () => flash(0.8));
    return {
      step(dt, m) {
        main(m);
        drop(m);
        const turn = (dt / m.beat) * 0.25 * (0.5 + m.drive);
        target += turn;
        spin = m.ease(spin, target, 0.12, dt);
        state[0] = spin;
      },
    };
  },
};
