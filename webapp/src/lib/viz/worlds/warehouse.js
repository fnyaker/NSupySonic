// HANGAR — concrete, fog and strobes.
//
// Hard techno, schranz, industrial: music made for a warehouse at four in the
// morning, and the warehouse is the picture. A hall of concrete pillars
// receding into haze, sodium lamps hanging from the roof, and — on the kick —
// strobes that light the fog from inside. It is the one world in the set that
// is properly raymarched, because what makes that room is light in a volume:
// the beams of the lamps are only visible where the haze scatters them, the
// pillars only exist as silhouettes against lit fog.
//
//   THE ROOM. Rows of square pillars on a wet floor, a roof of beams, marched
//   with a distance field; the camera dollies forward one bay every four
//   beats and sways a little on the bar.
//   THE LIGHT. Every pillar row has a lamp over the aisle; the scattering
//   integral is gathered along the ray through a fog that thickens toward the
//   floor, so each lamp throws a cone you can see.
//   THE MOVING HEADS. A pair on the truss every other bay: hard-edged beams
//   that exist only where the haze catches them, sweeping on the bar, their
//   figure changing every phrase, white and the palette's colour alternating.
//   They carry the drop; the breakdown switches them off.
//   THE STROBES. Main kicks fire white strobes from the ceiling. Their full-
//   frame part is the engine's rate-limited flash; what the kick itself owns is
//   the light IN THE FOG around each strobe, which is local and cannot blind.
//   THE ARRANGEMENT. A breakdown kills the strobes and lets the sodium light
//   hang; a build pulses the lamps faster; the drop fires everything.
//
// Parameters:
//   fog     haze density         lamps   lamp brightness
//   strobe  kick strobe strength  steps   march budget (x the tier's)
//   warm    sodium vs the palette  heads   moving-head strength

export default {
  id: "warehouse",
  uses: ["noise3"],
  params: { fog: 1, lamps: 1, strobe: 1, steps: 72, warm: 1, heads: 1 },
  look: { exposure: 1.1, bloom: 1.15, threshold: 0.8, saturation: 1.05 },

  fragment: `
const float BAY = 2.2;   // distance between pillar rows
const float AISLE = 1.6; // half-width of the aisle

float sdBoxL(vec3 p, vec3 b) { vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0); }

float scene(vec3 p) {
  // Pillars: a row either side of the aisle, and a second row further out.
  vec3 q = p;
  q.z = mod(q.z, BAY) - BAY * 0.5;
  q.x = abs(q.x) - AISLE;
  q.x = mod(q.x + 1.6, 3.2) - 1.6;
  float pillar = sdBoxL(q, vec3(0.16, 3.0, 0.16));
  // Roof beams across the hall at every row.
  vec3 b = p;
  b.z = mod(b.z, BAY) - BAY * 0.5;
  float beam = sdBoxL(b - vec3(0.0, 2.25, 0.0), vec3(8.0, 0.12, 0.08));
  float floorD = p.y + 1.0;
  float roof = 2.6 - p.y;
  return min(min(pillar, beam), min(floorD, roof));
}

// Moving head \`side\` (-1 / 1) of the pair on truss row \`row\`: where it
// hangs, and where it points. One function, so the beam in the haze and the
// pool it throws on the floor can never disagree.
vec3 headAt(float row, float side) { return vec3(side * AISLE * 0.75, 2.15, (row + 0.5) * 2.0 * BAY); }
vec3 headDir(float row, float side, float bars, float cue) {
  float ph = bars * PI * 0.5 + row * 1.3 + side * cue;
  return normalize(vec3(-side * 0.3 + 0.55 * sin(ph), -1.0, 0.55 * sin(bars * PI * 0.25 + row * 0.9) - 0.15));
}

vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.003, 0.0);
  return normalize(vec3(scene(p + e.xyy) - scene(p - e.xyy), scene(p + e.yxy) - scene(p - e.yxy), scene(p + e.yyx) - scene(p - e.yyx)));
}

void main() {
  vec2 p = fragP();
  float beats = uClock.x * uSpeed;
  float bars = uClock.y * uSpeed;
  float amp = 0.6 + 0.4 * uCtl.x;
  // The camera: dollying forward a bay every four beats, swaying on the bar.
  float travel = uS0.x;
  vec3 ro = vec3(0.25 * sin(bars * PI * 0.5) * amp, -0.15 + 0.05 * sin(bars * PI), travel);
  vec3 rd = normalize(vec3(p.x, p.y + 0.05, 1.35));
  rd.xy *= rot(0.03 * sin(bars * PI * 0.5) * amp);

  int steps = int(clamp(P_STEPS * uQual.x, 24.0, 96.0));
  // Jitter the START of the ray only, so the fog integral is dithered without
  // the surface test ever overshooting into a pillar (a jittered step size is
  // what made the silhouettes ragged).
  // Interleaved gradient noise rather than white noise: the same dither with
  // its energy pushed to the highest frequencies, which the eye (and the
  // bloom) average away — white noise read as grit inside every beam.
  vec2 jq = gl_FragCoord.xy + floor(fract(beats * 4.0) * 16.0) * vec2(5.588238, 5.588238);
  float jit = fract(52.9829189 * fract(dot(jq, vec2(0.06711056, 0.00583715))));
  float t = 0.05 + jit * 0.12;
  float hit = 0.0;
  // Fog, gathered along the ray: the sodium lamps over the aisle, the kick's
  // strobes, and the back light at the far end of the hall.
  vec3 scatter = vec3(0.0);
  float trans = 1.0;
  vec3 sodium = mix(vec3(1.0, 0.42, 0.1), uPalMid.rgb * 3.0, 0.35 * (1.0 - P_WARM));
  vec3 strobeC = mix(vec3(0.75, 0.88, 1.0), uPalHigh.rgb, 0.25);
  vec3 backC = mix(uPalMid.rgb, uPalHigh.rgb, 0.4) * 3.0;
  // A strobe is a FLASH, a sixth of a beat, not an envelope: lit by the
  // ordinary kick envelope the fog never went dark between kicks, and the whole
  // hall sat in a grey wash from the first drop to the end of the track.
  float strobeK = (exp(-max(uSince.y, 0.0) * 6.0) * amp * P_STROBE * (1.0 - uArc.z) + uHit2.w * 0.6);
  float lampK = P_LAMPS * (0.75 + 0.25 * sin(beats * PI) * uArc.y);
  // The back light: a wall of colour at the far end, the thing the pillars
  // stand in front of. It swells with the music and flares on the kick.
  float backK = (0.25 + 0.5 * uFlow.x + 0.6 * uHit.x * amp) * (1.0 - 0.5 * uArc.z);
  // The moving heads run with the track: off in the breakdown, full in the
  // drop, punched on the main kick; their figure changes every phrase.
  float headK = P_HEADS * (0.15 + 0.85 * uFlow.x) * (1.0 - 0.85 * uArc.z) * (0.8 + 0.5 * uHit.y * amp);
  float cue = mod(floor(uClock.z), 3.0) - 1.0;
  vec3 headC = mix(uPalHigh.rgb, uPalAcc.rgb, 0.35) * 1.4;
  float farZ = ro.z + 24.0;
  for (int i = 0; i < 96; i++) {
    if (i >= steps) break;
    vec3 pos = ro + rd * t;
    float d = scene(pos);
    if (d < 0.0015 * t) { hit = 1.0; break; }
    float dt = min(d, 0.3);
    // The haze: denser near the floor, drifting, and thin — fog you only see
    // where light crosses it.
    float dens = (0.016 + 0.014 * exp(-(pos.y + 1.0) * 2.0)) * P_FOG;
    dens *= 0.5 + 1.0 * noise3(pos * 0.8 + vec3(bars * 0.2, 0.0, bars * 0.05));
    // The nearest lamp over the aisle: a tight cone pointing down.
    float lz = floor(pos.z / BAY + 0.5) * BAY;
    vec3 dl = pos - vec3(0.0, 2.05, lz);
    float cone = smoothstep(-0.8, -0.95, dl.y / max(length(dl), 1e-3));
    float li = (cone * 4.5 + 0.003) / (0.05 + dot(dl, dl) * 1.1) * lampK;
    // The strobes hang between the lamps, over each row of pillars.
    vec3 ds = pos - vec3(sign(pos.x + 1e-4) * AISLE * 0.8, 2.2, lz + BAY * 0.5);
    float si = strobeK / (0.06 + dot(ds, ds) * 1.2) * 2.2;
    // The back light falls off with distance from the far wall.
    float bk = backK * exp(-(farZ - pos.z) * 0.22) * (0.6 + 0.4 * exp(-abs(pos.y - 0.6))) * 0.6;
    // The moving heads on the truss, a pair every other bay: hard-edged
    // beams that only exist where the haze catches them, sweeping on the bar
    // and changing their figure every phrase.
    vec3 mh = vec3(0.0);
    if (headK > 0.01) {
      float row0 = floor(pos.z / (2.0 * BAY));
      for (int r = 0; r < 2; r++) {
        float row = row0 - float(r);
        for (int k = 0; k < 2; k++) {
          float side = k == 0 ? -1.0 : 1.0;
          vec3 O = headAt(row, side);
          vec3 D = headDir(row, side, bars, cue);
          vec3 v = pos - O;
          float along = dot(v, D);
          if (along > 0.0) {
            float w = 0.03 + along * 0.032;
            float rr = length(v - D * along);
            vec3 hc = mod(row + (side > 0.0 ? 1.0 : 0.0), 2.0) < 0.5 ? strobeC : headC;
            mh += hc * exp(-rr * rr / (w * w)) / (1.0 + along * 0.35);
          }
        }
      }
    }
    scatter += trans * dens * dt * (sodium * li + strobeC * si + backC * bk + mh * headK * 34.0);
    trans *= exp(-dens * dt * 1.4);
    t += dt;
    if (t > 34.0 || trans < 0.02) break;
  }
  // Rays that escape end on the far wall's glow.
  vec3 col = backC * backK * 0.02 * trans * (1.0 - hit);
  if (hit > 0.5) {
    vec3 pos = ro + rd * t;
    vec3 n = normalAt(pos);
    float lz = floor(pos.z / BAY + 0.5) * BAY;
    vec3 L = vec3(0.0, 2.05, lz) - pos;
    float dL = length(L);
    float diff = max(dot(n, L / dL), 0.0) / (1.0 + dL * dL * 0.5);
    vec3 S = vec3(sign(pos.x + 1e-4) * AISLE * 0.8, 2.2, lz + BAY * 0.5) - pos;
    float dS = length(S);
    float sdiff = max(dot(n, S / dS), 0.0) / (1.0 + dS * dS * 0.5);
    // The back light rakes along the hall: the faces the camera sees are in
    // its shadow, and only the grazing edges pick it up — a rim, which is
    // what outlines a pillar against lit fog.
    float rimB = pow(1.0 - max(dot(n, -rd), 0.0), 3.0) * exp(-(farZ - pos.z) * 0.12);
    // Concrete: rough, a little stained.
    float grime = 0.6 + 0.4 * noise3(pos * vec3(3.0, 1.5, 3.0));
    vec3 conc = vec3(0.06) * grime;
    vec3 surf = conc * (sodium * diff * lampK * 1.6 + strobeC * sdiff * strobeK * 2.0) + backC * rimB * backK * 0.05;
    // The wet floor: a sheen that catches the lamps and the far wall.
    if (pos.y < -0.99) {
      vec3 rr = reflect(rd, n);
      rr.xz += (noise3(pos * 6.0) - 0.5) * 0.04;
      surf += sodium * pow(max(dot(rr, normalize(L)), 0.0), 40.0) * lampK * 0.4;
      surf += strobeC * pow(max(dot(rr, normalize(S)), 0.0), 40.0) * strobeK * 0.4;
      surf += backC * backK * 0.03 * smoothstep(0.0, 0.3, rr.z) * exp(-(farZ - pos.z) * 0.1);
      // Where the moving heads' beams land: a hard pool of light on the wet
      // concrete, sliding as the head sweeps.
      if (headK > 0.01) {
        float row0 = floor(pos.z / (2.0 * BAY));
        for (int r = 0; r < 3; r++) {
          float row = row0 + float(r) - 1.0;
          for (int k = 0; k < 2; k++) {
            float side = k == 0 ? -1.0 : 1.0;
            vec3 O = headAt(row, side);
            vec3 D = headDir(row, side, bars, cue);
            float along = (-1.0 - O.y) / D.y;
            vec3 P = O + D * along;
            float w = 0.03 + along * 0.032;
            vec2 dq = (pos.xz - P.xz) / w;
            vec3 hc = mod(row + (side > 0.0 ? 1.0 : 0.0), 2.0) < 0.5 ? strobeC : headC;
            surf += hc * exp(-dot(dq, dq)) * headK * 0.9 / (1.0 + along * 0.35);
          }
        }
      }
    }
    col = surf * trans;
    // Every lamp down the hall, mirrored in the wet floor as a streak that
    // runs toward the camera: what makes concrete read as wet at a glance.
    if (pos.y < -0.99) {
      float b0 = floor(ro.z / BAY) + 1.0;
      for (int k = 0; k < 7; k++) {
        vec3 M = vec3(0.0, -4.05, (b0 + float(k)) * BAY) - ro;
        if (M.z < 0.4) continue;
        vec2 sp = M.xy / M.z * 1.35 - vec2(0.0, 0.05);
        float dx = abs(p.x - sp.x);
        // Rough, so each lamp is a soft elongated smear rather than a line,
        // shorter and tighter the further down the hall it is.
        float wx = 0.012 + 0.06 / M.z;
        float streak = exp(-dx * dx / (wx * wx)) * exp(-max(sp.y - p.y, 0.0) * (3.0 + 1.5 * M.z) - max(p.y - sp.y, 0.0) * 40.0);
        col += sodium * streak * lampK * 0.3 * exp(-M.z * 0.12) * trans;
      }
    }
  }
  col += scatter;
  col *= mix(0.35, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.5));
}
`,

  create({ state }) {
    let travel = 0;
    return {
      step(dt, m) {
        // One bay (2.2 units) every four beats, a little faster as it drives.
        travel += (dt / m.beat) * (2.2 / 4) * (0.7 + 0.5 * m.drive + 0.6 * m.build) * (1 - 0.5 * m.breakdown);
        state[0] = travel;
      },
    };
  },
};
