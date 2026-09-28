// ARPÈGE — a floating spiral staircase, climbed one note at a time.
//
// Hardtekk, pieep and every genre built on a running lead share one gesture:
// the arpeggio, a melody that walks up and down a chord a step at a time. So
// the picture is a staircase — slabs of stone floating in a helix round a
// column of light that lights them, rising out of the fog below and vanishing
// into the fog above — and the tune climbs it:
//
//   EVERY NOTE lights a step. A note higher than the last climbs, a lower one
//   descends, a repeat stays put, so the light traces the melody's own contour
//   up and down the helix. The last eight notes stay lit, each in its own
//   colour (its pitch, walked along the palette), fading behind the climber.
//   THE CAMERA follows the climber round and up the tower, easing, so the lit
//   step is always in view: the staircase turns past as the tune climbs, and
//   sinks when it falls.
//   THE KICK pulses the column, and with it the light on every slab; the DROP
//   sends a run of light racing thirty-two steps up the stairs.
//
// It is raymarched, because what sells a staircase is its faces: a lit tread
// on top, a riser in shadow, the underside of the step above, and fog eating
// the turns above and below. Each slab is a box turned onto its angle of the
// helix; for any point only the three slabs of its own angular sector, on the
// nearest turn, can be the closest, so the field costs three boxes however
// many steps are in view.
//
// Parameters:
//   steps   steps per turn     rise   height of one step
//   trail   how long the lit steps stay lit

import { eventRing, onStamp } from "./kit.js";

const SHARED = `
float K() { return max(8.0, floor(P_STEPS + 0.5)); }
float dA() { return TAU / K(); }
`;

export default {
  id: "stairs",
  uses: ["sdf"],
  params: { steps: 16, rise: 0.13, trail: 1, march: 72 },
  look: { exposure: 1.05, bloom: 0.9, threshold: 0.78, saturation: 1.12, ca: 0.4 },

  fragment: `${SHARED}
const float RMID = 1.02;
const vec3 HALF = vec3(0.7, 0.03, 0.17);

// The slab \`k\` (a global index along the helix), in its own frame.
vec3 slabLocal(vec3 p, float k) {
  vec3 q = p;
  q.y -= k * P_RISE;
  q.xz = rot(-k * dA()) * q.xz;
  q.x -= RMID;
  return q;
}

// The staircase and the column. \`kHit\` is the nearest slab's global index.
float scene(vec3 p, out float kHit) {
  float kf = atan(p.z, p.x) / dA();
  float k0 = floor(kf + 0.5);
  float turnH = K() * P_RISE;
  float d = 1e3;
  kHit = 0.0;
  for (int j = -1; j <= 1; j++) {
    float kj = k0 + float(j);
    float n = floor((p.y - kj * P_RISE) / turnH + 0.5);
    float kg = kj + n * K();
    float ds = sdBox(slabLocal(p, kg), HALF) - 0.008;
    if (ds < d) { d = ds; kHit = kg; }
  }
  return d;
}

float column(vec3 p) { return length(p.xz) - 0.09; }

// How lit slab \`k\` is by the notes, and in what colour.
vec3 noteLight(float k) {
  vec3 c = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    vec4 ev = uEv[i];
    if (ev.y <= 0.0) continue;
    float age = uClock.x - ev.x;
    if (age < 0.0 || abs(k - ev.z) > 0.5) continue;
    c += pal(ev.w) * ev.y * exp(-age / (3.0 * P_TRAIL));
  }
  if (uS1.y > 0.0) {
    float dk = uS1.x - k;
    c += mix(uPalHigh.rgb, vec3(1.0), 0.3) * uS1.y * step(0.0, dk) * step(dk, 32.0) * exp(-dk * 0.12);
  }
  return c;
}

void main() {
  vec2 p = fragP();
  float amp = 0.6 + 0.4 * uCtl.x;
  // The camera: orbiting the tower at the climber's height, a little above it.
  float c = uS0.x;
  float phi = c * dA() + 1.05 + uS0.y;
  float yc = c * P_RISE;
  vec3 ro = vec3(cos(phi) * 2.7, yc + 1.0, sin(phi) * 2.7);
  vec3 ta = vec3(0.0, yc + 0.05, 0.0);
  vec3 fw = normalize(ta - ro);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  vec3 rd = normalize(p.x * rt + p.y * up + 1.45 * fw);

  int steps = int(clamp(P_MARCH * uQual.x, 32.0, 110.0));
  float t = 0.0;
  float kHit = 0.0;
  bool hit = false;
  float colGlow = 0.0;
  // The closest the ray came to a slab, in pixels: a ray that just misses an
  // edge still owes it some light, which is what keeps the silhouettes from
  // stair-stepping.
  float near = 1e3;
  float kNear = 0.0;
  float pxA = uFrame.w / 1.45;
  for (int i = 0; i < 110; i++) {
    if (i >= steps) break;
    vec3 pos = ro + rd * t;
    float dc = column(pos);
    colGlow += exp(-max(dc, 0.0) * 14.0) * 0.035;
    float d = scene(pos, kHit);
    if (d < 0.0008 * t) { hit = true; break; }
    float np = d / max(t * pxA, 1e-4);
    if (np < near) { near = np; kNear = kHit; }
    t += min(d, dc > 0.02 ? dc : 0.02) * 0.9;
    if (t > 16.0) break;
  }

  // The void: dark, a little lighter toward the fog of the turns below.
  vec3 fogC = mix(uPalLow.rgb, uPalMid.rgb, 0.3) * (0.05 + 0.04 * uMood.y);
  vec3 col = mix(uPalBg.rgb * 0.5, fogC, 0.5 + 0.5 * rd.y * -1.0);
  // Dust in the air, lit by the column: bokeh motes that drift with the orbit,
  // so the empty space round the tower reads as a place.
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float sc = 5.0 + fl * 4.0;
    vec2 mp = p * sc + vec2(phi * (2.0 - fl * 0.5), -yc * (3.0 - fl) + fl * 7.0);
    vec2 cell = floor(mp);
    vec2 h = hash22(cell + fl * 31.0);
    vec2 dm = fract(mp) - 0.2 - 0.6 * h;
    float mote = smoothstep(0.12 - fl * 0.02, 0.0, length(dm)) * step(0.72, hash12(cell + 3.1 + fl));
    col += mix(uPalMid.rgb, uPalHigh.rgb, h.x) * mote * (0.05 + 0.04 * uFlow.x) / (1.0 + fl);
  }
  // The column is the light: how bright it burns now (the kick pulses it).
  vec3 colC = mix(uPalHigh.rgb, vec3(1.0), 0.25);
  float colPow = 0.55 + 0.35 * uFlow.x + 1.1 * uHit.y * amp;
  if (!hit && near < 2.0) {
    // A ray that just missed a slab still owes its silhouette a little light
    // (anti-aliasing, not an outline): the slab's own lit colour, faint.
    vec3 rimC = fogC * 1.5 + noteLight(kNear) * 0.8;
    col += rimC * exp(-near * near * 1.5) * 0.35;
  }
  if (hit) {
    vec3 pos = ro + rd * t;
    vec3 q = slabLocal(pos, kHit);
    // The box's own normal, turned back onto the helix.
    vec3 e = abs(q) - HALF;
    vec3 nl = e.x > e.y && e.x > e.z ? vec3(sign(q.x), 0.0, 0.0) : e.y > e.z ? vec3(0.0, sign(q.y), 0.0) : vec3(0.0, 0.0, sign(q.z));
    vec3 n = vec3(0.0, nl.y, 0.0);
    n.xz = rot(kHit * dA()) * nl.xz;
    // The distance to the nearest EDGE of the face we are on, in pixels.
    vec3 ae = -e;
    float edgeD = nl.x != 0.0 ? min(ae.y, ae.z) : nl.y != 0.0 ? min(ae.x, ae.z) : min(ae.x, ae.y);
    float px = t * uFrame.w / 1.7;
    // A bevel: the slab's edge catches a hairline of light. It used to be the
    // whole look — every slab a neon wireframe round a black void, flashed on
    // every kick — which is a 2000s screensaver; now it is a detail.
    float bevel = exp(-pow(edgeD / (px * 1.6), 2.0));
    // Matte stone, LIT by the column: diffuse falling off with the distance
    // from it, a sky from above and the fog from below, and a soft sheen where
    // the column's light glances off a tread.
    vec3 toCol = normalize(vec3(-pos.x, 0.0, -pos.z));
    float dist2 = dot(pos.xz, pos.xz);
    float diff = max(dot(n, toCol), 0.0) / (1.0 + dist2 * 0.9);
    float hemi = 0.5 + 0.5 * n.y;
    vec3 albedo = mix(uPalBg.rgb * 2.2 + 0.02, uPalLow.rgb * 0.35, 0.25);
    vec3 h = normalize(toCol - rd);
    float sheen = pow(max(dot(n, h), 0.0), 36.0) / (1.0 + dist2 * 0.6);
    vec3 stone = albedo * (colC * diff * colPow * 1.6 + mix(fogC * 1.4, fogC * 3.2, hemi));
    stone += colC * sheen * 0.22 * colPow;
    // The note sounding lights its tread from inside, and bleeds down the
    // riser; the steps it left fade in their own colours behind it.
    vec3 lit = noteLight(kHit);
    float top = step(0.5, nl.y);
    stone += lit * (top * 1.2 + 0.28);
    col = stone + (fogC * 1.2 + colC * 0.08 * colPow + lit * 0.6) * bevel * 0.5;
    // Fog: the turns above and below fade into it.
    float fog = 1.0 - exp(-max(t - 2.0, 0.0) * 0.16 - abs(pos.y - yc) * 0.22);
    col = mix(col, fogC, clamp(fog, 0.0, 1.0));
  }
  // The column of light the stairs turn round, pulsing with the kick.
  col += colC * colGlow * colPow * 0.75 * (hit ? 0.5 : 1.0);
  col += mix(uPalHigh.rgb, vec3(1.0), 0.5) * uHit2.w * 0.25;
  // Centred on the artwork, and its brightest thing — the tread the tune is on
  // — sits mid-frame: under the cover it dims harder than the house third.
  col *= mix(0.2, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ ev, state, flash }) {
    const ring = eventRing(ev);
    let at = 0;
    let cam = 0;
    let lastPitch = 0.5;
    let runHead = 0;
    let runK = 0;
    let orbit = 0;
    let pitchNow = 0.5;
    const note = (s, m, pitch) => {
      // Climb with the melody: up for a higher note, down for a lower one, a
      // bigger interval a bigger step. With no melody to read, it climbs.
      const d = pitch - lastPitch;
      const by = Math.abs(d) < 0.015 ? (m.melodic > 0.35 ? 0 : 1) : Math.sign(d) * (Math.abs(d) > 0.08 ? 2 : 1);
      lastPitch = pitch;
      at += by;
      ring.push(s, 0.7 + 0.5 * Math.min(1, m.note + 0.3), at, Math.min(1, Math.max(0, 0.15 + pitch * 0.85)));
    };
    const onNote = onStamp((m) => m.stamp.note, (s, m) => note(s, m, pitchNow));
    // When the music has no melody to follow, the kick climbs instead.
    const onKick = onStamp((m) => m.stamp.main, (s, m) => {
      if (m.melodic < 0.3 || m.note < 0.05) note(s, m, pitchNow + 0.05);
    });
    const onDrop = onStamp((m) => m.stamp.drop, () => {
      runHead = at;
      runK = 1;
      flash(0.8);
    });
    return {
      step(dt, m, clocks) {
        pitchNow = clocks?.pitch ?? 0.5;
        onNote(m);
        onKick(m);
        onDrop(m);
        cam = m.ease(cam, at, 1.5, dt);
        // A slow orbit on top of the follow, so a held note is not a still.
        orbit += (dt / m.beat) * (0.01 + 0.02 * m.drive);
        state[0] = cam;
        state[1] = orbit;
        runHead += (dt / m.beat) * 8;
        runK = Math.max(0, runK - dt / m.overBeats(4));
        state[4] = runHead;
        state[5] = runK;
      },
    };
  },
};
