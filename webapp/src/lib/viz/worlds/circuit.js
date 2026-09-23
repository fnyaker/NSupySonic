// CIRCUIT — a printed circuit board, carrying the music.
//
// Electro, EBM, techno with a machine's precision: the picture is the machine
// itself — a circuit board seen at an angle under a lamp, its copper traces
// running in buses that jog at forty-five degrees the way a router lays them,
// chips sitting across them, vias punched through — and the music is the
// data on it.
//
//   THE TRACES are built lane by lane: each lane is a bus of parallel traces
//   that steps up or down at forty-five degrees at chosen points, so every
//   trace is continuous and the jogs are true diagonals (a staircase of
//   right angles is what makes a generated board look generated).
//   THE DATA. Packets of light run along every trace, each bus in its own
//   direction, at a rate locked to the beat; the hats add short bursts.
//   THE KICK is a wave of current spreading outward along every trace from
//   the middle of the board; the DROP powers the whole board up at once.
//   THE BOARD is dark solder mask with a sheen that moves with the lamp,
//   copper that catches it, chips with their pins, silkscreen marks — and it
//   is seen in perspective, drifting under the camera a lane per bar.
//
// Parameters:
//   lanes   bus density           packets  data rate (x)
//   chips   how many chips        tilt     the board's angle

import { onStamp } from "./kit.js";

export default {
  id: "circuit",
  uses: ["noise", "sdf"],
  params: { lanes: 1, packets: 1, chips: 1, tilt: 1 },
  look: { exposure: 1.0, bloom: 1.25, threshold: 0.7, saturation: 1.15 },

  fragment: `
const float LANE = 0.36;   // lane height on the board
const float PITCH = 0.034; // trace spacing
const float SEG = 0.9;     // where a lane may jog
const float JOG = 0.11;    // how far a jog moves

// A lane's vertical offset at x: plateaus joined by 45-degree ramps.
float laneOff(float lane, float x) {
  float s = floor(x / SEG);
  float hPrev = step(0.5, hash12(vec2(lane, s - 1.0))) * JOG;
  float hCur = step(0.5, hash12(vec2(lane, s))) * JOG;
  float u = clamp((x - s * SEG - 0.3) / JOG, 0.0, 1.0);
  return mix(hPrev, hCur, u);
}
float laneRamp(float lane, float x) {
  float s = floor(x / SEG);
  float a = step(0.5, hash12(vec2(lane, s - 1.0)));
  float b = step(0.5, hash12(vec2(lane, s)));
  float u = (x - s * SEG - 0.3) / JOG;
  return (a != b && u > 0.0 && u < 1.0) ? 1.0 : 0.0;
}

void main() {
  vec2 p0 = fragP();
  float beats = uClock.x * uSpeed;
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  // The board, in perspective: the top of the frame is further away.
  float k = 0.28 * P_TILT;
  float w = 1.0 / (1.0 + k * (p0.y + 1.0) * 0.5);
  vec2 b = vec2(p0.x / w, ((p0.y + 1.0) / w * 0.5 - 1.0) * 1.4);
  // The camera drifts over it, a lane per bar.
  b.y += uS0.x;
  b.x += 0.15 * sin(bars * PI * 0.125);
  float px = uFrame.w / w * 1.2;

  // --- the board ---
  vec3 L = normalize(vec3(0.3 * sin(bars * PI * 0.25), 0.6, 1.0));
  float grain = gnoise(b * 40.0) * 0.5 + 0.5;
  vec3 mask = mix(uPalBg.rgb * 0.5, uPalLow.rgb * 0.06, 0.6) * (0.8 + 0.2 * grain);
  // The lamp's sheen across the solder mask.
  float sheen = exp(-pow(length(p0 - vec2(0.8 * sin(bars * PI * 0.25), 0.55)) * 1.2, 2.0));
  vec3 col = mask + uPalMid.rgb * sheen * 0.02;

  float lane = floor(b.y / LANE);
  float ly = b.y - lane * LANE;
  float nTr = floor(4.0 + 4.0 * hash11(lane * 3.7) * P_LANES);
  float dir = mod(lane, 2.0) < 0.5 ? 1.0 : -1.0;
  float off = laneOff(lane, b.x);
  float ramp = laneRamp(lane, b.x);
  float yy = ly - 0.06 - off;
  float ti = floor(yy / PITCH + 0.5);
  vec3 copper = mix(vec3(0.9, 0.55, 0.25), uPalMid.rgb, 0.4);
  // The kick's wave, spreading outward from the middle of the board.
  float wave = exp(-pow((abs(p0.x) - uSince.y * 1.4) * 5.0, 2.0)) * envB(uSince.y, 1.2) * amp;
  float power = envB(uSince.w, 3.0) * step(uSince.w, 12.0);
  if (ti >= 0.0 && ti < nTr) {
    float dy = (yy - ti * PITCH) * (ramp > 0.5 ? 0.7071 : 1.0);
    float tw = 0.006;
    float trace = smoothstep(tw + px, tw - px, abs(dy));
    // Copper: catches the lamp along its length.
    col = mix(col, copper * (0.05 + 0.12 * sheen), trace);
    // The data: packets of light along the trace.
    float id = lane * 17.0 + ti;
    float ph = fract(b.x * 0.35 * dir - beats * 0.5 * P_PACKETS + hash11(id));
    float pkt = exp(-pow((ph - 0.5) * 22.0, 2.0)) * step(0.35, hash11(id + 3.0));
    // A burst on the hats: a short packet train.
    float burst = step(0.96, fract(b.x * 1.5 * dir - beats * 2.0 + hash11(id + 7.0))) * step(0.6, hash11(id + 9.0)) * uHit2.x * amp;
    vec3 lit = mix(uPalHigh.rgb, uPalAcc.rgb, hash11(id + 1.0) * 0.5);
    float e = pkt * (0.4 + 0.6 * uFlow.x) + burst * 0.5 + wave * 0.9 + power * 0.5;
    col += lit * e * (trace + 0.5 * glow(abs(dy), 0.01)) * 1.4;
  }
  // Vias: rings punched through the board, on their own sparse grid so they
  // are never all in a line.
  vec2 vg = b / 0.2;
  vec2 vid = floor(vg);
  if (hash12(vid + 5.3) > 0.93) {
    vec2 vp = (fract(vg) - 0.5) * 0.2;
    float vr = length(vp);
    float ring = smoothstep(0.012 + px, 0.012, vr) - smoothstep(0.006, 0.006 - px, vr);
    col = mix(col, copper * (0.1 + 0.3 * sheen), ring * 0.8);
    col += uPalHigh.rgb * ring * (wave + power) * 0.6;
  }
  // --- the chips: black packages across the buses, pins down both sides ---
  vec2 cg = b / vec2(0.9, 0.72);
  vec2 cid = floor(cg);
  if (hash12(cid + 1.7) < 0.28 * P_CHIPS) {
    vec2 cp = (fract(cg) - 0.5) * vec2(0.9, 0.72);
    vec2 size = vec2(0.18 + 0.12 * hash12(cid + 2.1), 0.14 + 0.08 * hash12(cid + 3.3));
    float body = sdBox2(cp, size);
    // Pins: a comb along the long sides.
    float pinX = abs(fract(cp.x / 0.035) - 0.5) * 0.035;
    float pins = step(pinX, 0.009) * step(abs(abs(cp.y) - size.y - 0.018), 0.018) * step(abs(cp.x), size.x - 0.01);
    col = mix(col, copper * (0.12 + 0.3 * sheen), pins);
    float inside = smoothstep(px, -px, body);
    vec3 pkg = vec3(0.012) + uPalMid.rgb * 0.01 * sheen;
    // Its own glint and a pin-one dot.
    pkg += vec3(1.0) * 0.03 * pow(max(1.0 - length(cp / size - vec2(-0.3, 0.4)), 0.0), 3.0);
    pkg += uPalHigh.rgb * smoothstep(0.012, 0.008, length(cp - vec2(-size.x + 0.03, size.y - 0.03))) * (0.15 + 0.6 * uHit.y);
    col = mix(col, pkg, inside);
    // The chip is busy on the beat: its edge glows.
    col += uPalHigh.rgb * glow(abs(body), px * 2.0) * 0.08 * (0.3 + uHit.x);
  }
  col += mix(uPalHigh.rgb, uPalAcc.rgb, 0.5) * uHit2.w * 0.2;
  // Far away, the board fades into the dark.
  col *= mix(0.35, 1.0, smoothstep(1.0, 0.2, p0.y) * 0.6 + 0.4);
  col *= mix(0.35, 1.0, clearOfHole(p0, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state, flash }) {
    let drift = 0;
    const drop = onStamp((m) => m.stamp.drop, () => flash(0.8));
    return {
      step(dt, m) {
        drop(m);
        // A lane per bar, slower in a breakdown.
        drift += (dt / m.bar) * 0.36 * (1 - 0.6 * m.breakdown);
        state[0] = drift;
      },
    };
  },
};
