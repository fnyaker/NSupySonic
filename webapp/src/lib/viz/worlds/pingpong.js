// PING-PONG — a ball of light, wall to wall, on the beat.
//
// Hardpingpong is named after its kick pattern — two kicks answering each
// other like a rally — and the picture is exactly that: a ball of white-hot
// light crossing the frame and striking a wall ON every beat, alternating
// sides, dragging a comet tail of its own recent path behind it.
//
//   THE BALL'S PATH is not simulated, it is a function of the beat clock: its
//   x is a triangle wave that touches a wall at every whole beat, its y a
//   bouncing arc whose height is the bar's shape (a lob on the downbeat, a
//   smash on the off-beats). Because it is a function, the tail is simply the
//   same function sampled at the last half beat — exact, at any frame rate,
//   with no history kept anywhere.
//   THE WALLS are two blades of light at the frame's edges. Each strike leaves
//   a ripple travelling along the wall from the point of impact and a spray of
//   sparks thrown back into the court.
//   THE COURT is a dark floor in perspective with the ball's reflection
//   sliding across it, a net of light down the middle.
//   THE DROP puts three balls in play, each a third of a beat apart.
//
// Parameters:
//   balls   how many balls outside a drop   tail   comet length (beats)
//   arc     how high the ball lobs          net    the net line

import { onStamp } from "./kit.js";

const SPARKS = 420;

const SHARED = `
// The court's half-width and the ball's radius, in p-space.
float courtX() { return frameHalf().x - 0.06; }
float ballR() { return 0.028 + 0.012 * uHit.y; }

// Where ball \`b\` is at beat-clock time \`tb\`. A wall strike on every beat.
vec2 ballAt(float tb, float b) {
  float x = tb - b / 3.0;
  // Triangle wave: -1 at even beats, +1 at odd ones.
  float tri = abs(fract(x * 0.5) * 2.0 - 1.0) * 2.0 - 1.0;
  float X = -tri * courtX() * 0.94;
  // One bounce off the floor between the walls: a parabola whose height
  // follows the bar — a lob on the downbeat, flatter smashes after it.
  float f = fract(x);
  float bar = floor(mod(x, 4.0));
  float h = mix(0.95, 0.55, min(bar, 1.0)) * P_ARC * (0.75 + 0.25 * uFlow.x);
  float floorY = -0.62;
  float Y = floorY + h * 4.0 * f * (1.0 - f) * (1.0 - 0.3 * b);
  return vec2(X, Y + 0.2);
}
`;

export default {
  id: "pingpong",
  uses: [],
  params: { balls: 1, tail: 0.6, arc: 1, net: 1 },
  look: { exposure: 1.0, bloom: 1.35, threshold: 0.65, saturation: 1.2 },

  fragment: `${SHARED}
void main() {
  vec2 p = fragP();
  float tb = uClock.x * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  float cx = courtX();
  vec3 col = uPalBg.rgb * 0.4;

  // --- the court: a floor in perspective below the play, lines of light ---
  float floorY = -0.42;
  if (p.y < floorY) {
    float depth = 0.25 / max(floorY - p.y, 0.01);
    float fx = p.x * depth;
    // One screen pixel, in floor units across and in depth.
    float pxX = uFrame.w * depth;
    float pxZ = uFrame.w * depth / max(floorY - p.y, 0.01);
    // Lengthwise lines, and cross lines receding.
    float lx = abs(fract(fx * 1.2) - 0.5) / 1.2;
    float lzz = abs(fract(depth * 1.5) - 0.5) / 1.5;
    float grid = exp(-pow(lx / (pxX * 1.2), 2.0)) * smoothstep(0.3, 0.05, pxX * 1.2)
               + exp(-pow(lzz / (pxZ * 1.2), 2.0)) * smoothstep(0.3, 0.05, pxZ * 1.5);
    float fade = exp(-depth * 0.45);
    col += mix(uPalLow.rgb, uPalMid.rgb, 0.4) * grid * fade * 0.12 * (0.5 + 0.5 * uFlow.x);
  }
  // The net: a veil of light down the middle, its tape a hairline on top.
  float netH = floorY + 0.3;
  float inNet = smoothstep(floorY - 0.01, floorY + 0.01, p.y) * smoothstep(netH + 0.004, netH - 0.004, p.y);
  float veil = exp(-pow(p.x / 0.012, 2.0)) * inNet;
  float tape = exp(-pow(p.x / 0.03, 2.0)) * exp(-pow((p.y - netH) / (uFrame.w * 1.2), 2.0));
  col += mix(uPalMid.rgb, uPalHigh.rgb, 0.4) * (veil * 0.12 + tape * 0.8) * P_NET * (0.5 + 0.5 * uFlow.x);
  // A cone of light from above onto the court, the room's only lamp.
  float cone = smoothstep(0.9, 0.2, abs(p.x) / (0.4 + 0.5 * (1.0 - p.y))) * smoothstep(-0.9, 0.9, p.y);
  col += mix(uPalLow.rgb, uPalMid.rgb, 0.5) * cone * 0.035 * (0.6 + 0.4 * uMood.y);

  // --- the walls: blades of light at both edges, rippling from each strike ---
  for (int side = 0; side < 2; side++) {
    float sx = side == 0 ? -1.0 : 1.0;
    float d = abs(p.x - sx * cx);
    // The last strike on this wall: odd beats hit the right, even the left.
    float lastB = floor(tb);
    if (mod(lastB, 2.0) < 0.5 != (side == 0)) lastB -= 1.0;
    float age = tb - lastB;
    vec2 hitAt = ballAt(lastB + 1e-3, 0.0);
    float along = abs(p.y - hitAt.y);
    // A ripple running up and down the wall from the impact.
    float front = age * 1.6;
    float ripple = exp(-pow((along - front) / 0.05, 2.0)) * exp(-age * 1.6);
    float flare = exp(-along * 5.0) * exp(-age * 5.0);
    float blade = exp(-pow(d / (uFrame.w * 1.4), 2.0)) + 0.12 * glow(d, 0.02);
    vec3 wc = mix(uPalMid.rgb, uPalHigh.rgb, 0.6);
    col += wc * blade * (0.18 + 0.35 * uFlow.x + 2.2 * ripple + 3.0 * flare);
    col += wc * glow(d, 0.08) * flare * 0.8;
  }

  // --- the balls: a comet each, the tail being their own path ---
  int nb = uS0.x > 0.5 ? 3 : int(clamp(P_BALLS, 1.0, 3.0));
  for (int b = 0; b < 3; b++) {
    if (b >= nb) break;
    float fb = float(b);
    vec2 bp = ballAt(tb, fb);
    float R = ballR();
    float db = length(p - bp);
    // The core: white-hot, a halo in the palette.
    vec3 hot = mix(uPalHigh.rgb, vec3(1.0), 0.6);
    col += hot * smoothstep(R, R * 0.4, db) * 3.0;
    col += mix(uPalHigh.rgb, uPalAcc.rgb, fb * 0.4) * glow(db, R * 1.4) * 0.7;
    // The tail: the same path, sampled back over the last fraction of a beat.
    // Each segment is judged on its own light, and the brightest one wins: a
    // tail that folds back on itself at a wall has two segments over the same
    // pixels, and picking the NEAREST one flickered between them.
    float tl = P_TAIL;
    float tail = 0.0;
    float tailT = 0.0;
    vec2 a0 = bp;
    for (int i = 1; i <= 16; i++) {
      float s1 = float(i) / 16.0;
      vec2 a1 = ballAt(tb - s1 * tl, fb);
      vec2 pa = p - a0;
      vec2 ba = a1 - a0;
      float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
      float d = length(pa - ba * h);
      float st = (float(i) - 1.0 + h) / 16.0;
      float w = R * (1.0 - st) * 0.9 + uFrame.w * 2.0;
      float v = exp(-pow(d / w, 2.0)) * pow(1.0 - st, 2.2);
      if (v > tail) { tail = v; tailT = st; }
      a0 = a1;
    }
    col += mix(hot, mix(uPalMid.rgb, uPalAcc.rgb, fb * 0.5), tailT) * tail * 1.4;
    // Its reflection on the floor, sliding under it.
    vec2 rp = vec2(bp.x, 2.0 * floorY - bp.y);
    if (p.y < floorY) {
      col += hot * glow(length((p - rp) * vec2(1.0, 2.5)), R * 1.2) * 0.25 * exp(-(floorY - p.y) * 4.0);
      // The pool of light the ball throws on the floor under it.
      float hgt = max(bp.y - floorY, 0.02);
      vec2 dpool = (p - vec2(bp.x, floorY - 0.05)) * vec2(1.0, 3.0);
      col += mix(uPalHigh.rgb, uPalMid.rgb, 0.5) * exp(-dot(dpool, dpool) / (0.02 + hgt * 0.15)) * 0.12 / (1.0 + hgt * 4.0);
    }
  }
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.25;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  particles: {
    count: SPARKS,
    vertex: `${SHARED}
void particle(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind) {
  float j = float(id);
  col = vec4(0.0); pos = vec2(0.0); axis = vec2(0.0); width = 0.0; kind = 0.0;
  // Thirty sparks per strike, for the last fourteen strikes; each strike is a
  // whole beat, so its sparks are born and die on the beat clock.
  float per = 30.0;
  float slot = floor(j / per);
  float tb = uClock.x * uSpeed;
  float strike = floor(tb) - slot;
  float age = tb - strike;
  if (age > 1.6 || age < 0.0) return;
  vec3 h = hash31(j * 1.13 + strike * 7.7);
  if (h.z > 0.45 + 0.55 * uFlow.x + 0.3 * uHit.y) return;
  vec2 at = ballAt(strike + 1e-3, 0.0);
  float sx = sign(at.x);
  // Thrown back into the court, fanned.
  float ang = (h.x - 0.5) * 2.4;
  vec2 dir = vec2(-sx * cos(ang), sin(ang));
  float v = 0.7 + 1.3 * h.y;
  float k = 3.0;
  float dr = (1.0 - exp(-k * age)) / k;
  pos = at + dir * v * dr + vec2(0.0, -0.35 * age * age);
  vec2 vel = dir * v * exp(-k * age) + vec2(0.0, -0.7 * age);
  float life = 1.0 - age / 1.6;
  axis = vel * 0.04 + normalize(vel + 1e-5) * 0.003;
  width = 0.0028;
  col = vec4(mix(mix(uPalHigh.rgb, vec3(1.0), 0.5), uPalMid.rgb, 1.0 - life) * life * 1.4, 1.0);
  kind = life;
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  float r = 1.0 - smoothstep(0.0, 1.0, length(q));
  return vec4(c.rgb * r * (0.4 + 0.9 * smoothstep(-0.3, 1.0, q.x)), 1.0);
}
`,
  },

  create({ state, flash }) {
    let multi = 0;
    const drop = onStamp((m) => m.stamp.drop, () => {
      multi = 1;
      flash(0.8);
    });
    return {
      step(dt, m) {
        drop(m);
        // Three balls in play for eight bars after a drop.
        multi = Math.max(0, multi - dt / m.overBeats(32));
        if (m.breakdown > 0.5) multi = 0;
        state[0] = multi > 0 ? 1 : 0;
      },
    };
  },
};
