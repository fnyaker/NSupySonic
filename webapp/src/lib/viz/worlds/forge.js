// FORGE — the hammer and the anthem.
//
// Frenchcore is two things at once and a picture that shows only one of them
// has got half of it: a straight 4/4 at 190-220 BPM built on one enormous
// distorted kick, and — what sets it apart from every other hard genre — a
// frankly euphoric melody over the top. So this world is a forge with a song
// in it.
//
//   THE STRIKE. Every MAIN kick is a hammer on an anvil: a white-hot flash at
//   the point of impact, a shock front running out along the floor, and a
//   fountain of sparks. The sparks are the centrepiece and they are real
//   ballistics, computed per spark from its event's birth time — launched in a
//   fan, dragged by the air, pulled down by gravity, cooling along the
//   blackbody curve from white through yellow to a dull red as they fall. Up
//   to five hundred of them, on the GPU, with no state anywhere.
//   THE METAL. The bar on the anvil glows with the heat of the last blows: a
//   run of kicks keeps it yellow-white, a breakdown lets it cool to a dark red
//   and the scale shows on it. The anvil is IRON, not a sign: bevelled, lit by
//   that bar and nothing else, standing on a stone floor that the bar throws a
//   pool of light across and the shock front runs over. Sparks that reach the
//   floor skitter along it instead of falling through it.
//   THE ANTHEM. Ribbons of gold across the upper frame, drawn only as bright as
//   the melody is present and following its pitch — a track with no lead
//   leaves the sky dark, a supersaw hook fills it.
//   THE AIR. Smoke lit from below by the hot metal, and embers rising through
//   it faster as a build tightens.
//
// Rolls throw small bursts from the same anvil (a frenchcore roll is five hits
// in a beat and must read as a spray, not five explosions); the drop throws
// the biggest fountain of the track and a flash the engine rate-limits.
//
// On a wide screen there are three anvils and the blows move between them, so
// a beamer is struck across its whole width; with the artwork in front, the
// anvils stand in the free band under it.
//
// Parameters:
//   sparks   fountain size         heat    how hot the metal runs
//   anthem   ribbon brightness     smoke   density of the smoke
//   anvils   1 or 3 strike points (3 only on a wide frame)

import { eventRing, onStamp, hashN } from "./kit.js";

const SPARKS_PER_EVENT = 96;

const SHARED = `
// Where anvil k (0..2) stands, and how big it is.
float anvilScale() {
  float room = uHole.z > 0.0 ? max(0.35, uHoleR.z + 1.0) : 1.0;
  return clamp(room * 1.1, 0.45, 1.25) * (uFrame.z < 1.0 ? 0.75 : 1.0);
}
vec2 anvil(float k) {
  float y = uHole.z > 0.0 ? clamp(uHoleR.z - 0.2 * anvilScale(), -0.86, -0.3) : -0.46;
  float wide = uFrame.z > 1.25 && P_ANVILS > 1.5 ? uFrame.z * 0.58 : 0.0;
  return vec2((k - 1.0) * wide, y);
}
// Heat, 0 (dull red) to 1 (white), as emitted light: the blackbody walk a
// cooling spark takes, and the reason it reads as metal and not as confetti.
vec3 heat(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = vec3(1.0, mix(0.1, 0.92, t * t), mix(0.015, 0.8, t * t * t * t));
  return c * (0.25 + 3.2 * t * t);
}
`;

export default {
  id: "forge",
  uses: ["noise", "sdf"],
  params: { sparks: 1, heat: 1, anthem: 1, smoke: 1, anvils: 1 },
  look: { exposure: 1.0, bloom: 1.3, threshold: 0.75, saturation: 1.12 },

  fragment: `${SHARED}
// An anvil in profile, in its own units (the face is y = 0, it is ~0.9 wide):
// the working face, the horn tapering off to the left, the heel, the narrow
// waist and the splayed feet.
float anvilSd(vec2 q) {
  float face = sdRound2(q - vec2(-0.02, -0.045), vec2(0.23, 0.045), 0.008);
  vec2 a = vec2(-0.25, -0.03);
  vec2 b = vec2(-0.47, -0.004);
  vec2 ba = b - a;
  float t = clamp(dot(q - a, ba) / dot(ba, ba), 0.0, 1.0);
  float horn = length(q - a - ba * t) - mix(0.032, 0.005, t);
  float heel = sdRound2(q - vec2(0.235, -0.03), vec2(0.035, 0.03), 0.006);
  float w = 0.085 + 0.03 * smoothstep(-0.1, -0.2, q.y);
  float waist = sdBox2(q - vec2(0.0, -0.15), vec2(w, 0.07));
  float feet = sdRound2(q - vec2(0.0, -0.225), vec2(0.19, 0.03), 0.012);
  return min(min(min(face, horn), heel), min(waist, feet));
}

// The iron, SHADED rather than outlined. The silhouette is given a bevel — the
// surface rolls over in the last 0.03 before the edge, so its normal turns
// outward there — and lit by the one light a forge has: the metal lying on the
// face. So the top edge of the face and the horn catch it hard, the waist
// falls away into the dark and the feet barely show, and a blow lights all of
// it for an instant. An even neon rim around the whole shape is what made this
// read as a sign rather than as a lump of iron.
vec3 ironAt(vec2 q, float sd, vec3 light, float soak) {
  const float e = 0.003;
  vec2 g = vec2(anvilSd(q + vec2(e, 0.0)) - anvilSd(q - vec2(e, 0.0)),
                anvilSd(q + vec2(0.0, e)) - anvilSd(q - vec2(0.0, e)));
  g /= max(length(g), 1e-5);
  float bev = sat(1.0 + sd / 0.03);
  // A used anvil is hammered: its surface is not flat, and the light shows it.
  float hm = gnoise(q * 34.0);
  vec3 n = normalize(vec3(g * bev * bev * 2.2 + vec2(hm, gnoise(q * 34.0 + 7.3)) * 0.1, 1.0));
  vec3 L = vec3(vec2(-0.02, 0.06) - q, 0.16);
  float dl = length(L);
  L /= dl;
  float fall = 1.0 / (1.0 + dl * dl * 22.0);
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 42.0);
  vec3 albedo = mix(vec3(0.05, 0.048, 0.052), uPalBg.rgb * 0.6, 0.35) * (0.85 + 0.3 * hm);
  vec3 c = albedo * (0.12 + light * diff * fall * 2.2) + light * spec * fall * 0.7;
  // The sky behind, a cold rim on the upper edges: what keeps the silhouette
  // apart from the smoke when the metal has cooled.
  c += uPalLow.rgb * 0.06 * bev * bev * bev * max(g.y, 0.0);
  // Heat soaks into the face under a hot bar: a dull red bloom in the steel.
  c += heat(0.2) * 0.35 * soak * exp(-length((q - vec2(-0.02, -0.02)) * vec2(1.0, 3.2)) * 11.0);
  return c;
}

// The anthem as SATIN: a ribbon twisting along its length, so its width
// breathes as it turns and it glints where its face swings through the light —
// a line of constant width is a wire, and a wire does not sing.
vec3 ribbon(vec2 p, float y, float phi, float W, float px) {
  float c = cos(phi);
  float w = W * (0.12 + 0.88 * abs(c)) + px;
  float d = abs(p.y - y);
  float fill = smoothstep(w + px, w - px, d);
  float across = sat(d / w);
  float sheen = pow(0.5 + 0.5 * cos(phi * 2.0 - 0.9), 5.0);
  float face = (0.3 + 1.6 * sheen) * (1.0 - 0.45 * across * across);
  // Edge-on, the two edges fold together into one bright line.
  float edge = (1.0 - abs(c)) * 0.9;
  return vec3(fill * (face + edge), glow(d, W * 5.0), sheen);
}

// Where ribbon k crosses x: three lines across the sky, lifted by the
// melody's pitch and swaying on the beat clock. With the artwork in front they
// fly in the room above it, packed tighter when that room is short; only a
// cover that fills the height sends them behind it.
float anthemY(float x, float fk, float beats) {
  float top = 0.3;
  float g = 1.0;
  if (uHole.z > 0.0) {
    float above = uHole.y + uHole.w + 0.12;
    if (above < 0.8) {
      top = above;
      g = clamp((0.9 - above) / 0.36, 0.4, 1.0);
    }
  }
  float base = top + (0.15 * fk + 0.2 * (uBandB.z - 0.5)) * g;
  return base + (0.09 * sin(x * (1.1 + 0.35 * fk) + beats * 0.25 + fk * 2.1)
              + 0.04 * sin(x * 2.9 - beats * 0.5 + fk)) * g;
}

void main() {
  vec2 p = fragP();
  float px = uFrame.w;
  float beats = uClock.x * uSpeed;
  float bars = uClock.y * uSpeed;
  vec3 col = uPalBg.rgb * 0.55;

  // --- the last blow and the metal's heat ---
  vec4 last = uEv[int(uS0.z)];
  vec2 hit = anvil(last.z);
  float age = uClock.x - last.x;
  float blow = last.y > 0.0 ? envB(age, 0.3) * min(last.y, 1.6) : 0.0;
  float hot = clamp(uS0.x * P_HEAT, 0.0, 1.0);
  float S = anvilScale();
  float fy = anvil(1.0).y - 0.255 * S;
  float barT = clamp(0.3 + 0.5 * hot, 0.0, 1.0);

  // --- smoke, lit from below by the forge and nowhere else ---
  vec2 sp = p * vec2(0.8, 1.2) + vec2(0.0, -bars * 0.3);
  float sm = fbm(sp + vec2(fbm(sp * 0.7 + bars * 0.04, 3), 0.0) * 1.4, 5) + 0.5;
  sm = smoothstep(0.25, 1.0, sm);
  float dForge = length((p - anvil(1.0)) * vec2(0.45, 0.8));
  float lit = glow(dForge, 0.55 * S) * (0.35 + 0.65 * hot);
  vec3 smokeCol = mix(uPalLow.rgb * 0.5, heat(0.45 + 0.35 * hot) * 0.35, 0.65);
  col += smokeCol * sm * (0.025 + 0.32 * lit) * (0.5 + 0.5 * uMood.y) * P_SMOKE;
  float dHit = length((p - hit) * vec2(0.55, 1.0));
  col += heat(0.95) * blow * glow(dHit, 0.2 * S) * (0.25 + 0.75 * sm) * 0.4;

  // --- the floor: dark stone, seen only where the metal throws its light ---
  // Below the feet it comes toward us; just above them it runs away behind the
  // anvils, foreshortened hard, and fades into the smoke.
  float u = fy - p.y;
  float floorA = smoothstep(-0.07 * S, 0.0, u);
  if (floorA > 0.0) {
    float Z = u > 0.0 ? u * 3.2 : u * 9.0;
    float w = 1.0 / (max(u, 0.0) + 0.1);
    float grain = fbm(vec2(p.x * w * 1.4, w * 2.2), 3) + 0.5;
    grain = mix(0.5, grain, smoothstep(0.0, 0.06, u));
    vec3 light = vec3(0.0);
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      if (P_ANVILS < 1.5 && k != 1) continue;
      vec2 a = anvil(fk);
      if (k != 1 && a.x == anvil(1.0).x) continue;
      float struck = step(abs(last.z - fk), 0.5) * blow;
      vec2 fq = vec2(p.x - a.x, Z) / S;
      float r = length(fq);
      // Standing on it: the contact shadow under the feet and the waist.
      float ao = 1.0 - 0.85 * exp(-pow(max(abs(fq.x) - 0.12, 0.0) / 0.1, 2.0) - pow(fq.y / 0.1, 2.0));
      light += (heat(barT) * (0.12 + 0.35 * hot) + heat(0.95) * struck * 0.5) * glow(r, 0.3) * ao;
    }
    // The shock of the blow runs out across the stone and lights it as it goes.
    if (last.y > 0.0 && age < 2.0) {
      float r = length(vec2(p.x - hit.x, Z)) / S;
      float R = age * 1.3;
      float front = exp(-pow((r - R) / (0.03 + age * 0.06), 2.0)) * (1.0 - age / 2.0);
      light += heat(0.75) * front * min(last.y, 1.4) * 0.5;
    }
    col = mix(col, vec3(0.05, 0.045, 0.045) * 0.4 + light * (0.35 + 0.9 * grain), floorA);
  }

  // --- the dust the blow kicks off the floor, rolling outward and settling ---
  // It rides the same ring as the shock front: on the stone, a soft band over
  // the front; above the floor line, the ring's two ends seen side-on, as a
  // low wall of dust that thins as it rises.
  if (last.y > 0.0 && age < 2.5) {
    float R = age * 1.3;
    float wd = 0.05 + age * 0.1;
    float dust;
    if (u < 0.0) {
      dust = exp(-pow((abs(p.x - hit.x) / S - R) / wd, 2.0)) * exp(u / (0.05 * S * (1.0 + age)));
    } else {
      float r = length(vec2(p.x - hit.x, u * 3.2)) / S;
      dust = exp(-pow((r - R) / wd, 2.0)) * 0.45;
    }
    col += smokeCol * dust * (1.0 - age / 2.5) * (0.4 + 0.6 * sm) * min(last.y, 1.4) * 0.9;
  }

  // --- the anvils ---
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    if (P_ANVILS < 1.5 && k != 1) continue;
    vec2 a = anvil(fk);
    if (k != 1 && a.x == anvil(1.0).x) continue;
    vec2 q = (p - a) / S;
    float sd = anvilSd(q);
    float struck = step(abs(last.z - fk), 0.5) * blow;
    if (sd * S < 2.0 * px) {
      vec3 light = heat(barT) * (0.3 + 0.8 * hot) + heat(0.95) * struck * 2.0;
      vec3 iron = ironAt(q, sd, light, hot);
      col = mix(col, iron, smoothstep(px, -px, sd * S));
    }
    // The bar of metal on the face, flattened a little by each blow: hottest
    // in the middle where the hammer works it, cooler at the ends, and as it
    // cools the scale shows on it in dark flakes.
    float squash = 1.0 + 0.25 * struck;
    vec2 bq = q - vec2(-0.02, 0.022 / squash);
    float bar = sdRound2(bq, vec2(0.15 * squash, 0.02 / squash), 0.012);
    float along = abs(bq.x) / (0.15 * squash);
    float tb = clamp(barT + 0.5 * struck - 0.3 * along * along, 0.0, 1.0);
    float flake = smoothstep(0.1, 0.35, gnoise(bq * vec2(46.0, 70.0))) * (1.0 - tb) * 0.85;
    col = mix(col, heat(tb) * 1.3 * (1.0 - flake), smoothstep(px, -px, bar * S));
    col += heat(tb) * glow(max(bar, 0.0) * S, 0.012) * 0.4;
  }

  // --- embers rising through the smoke ---
  for (int L = 0; L < 2; L++) {
    float fl = float(L);
    vec2 ep = p * (6.0 + fl * 5.0) + vec2(fl * 13.0, -beats * (0.3 + 0.4 * uFlow.w) * (1.0 + fl * 0.6));
    vec2 cell = floor(ep);
    vec2 h = hash22(cell + fl * 31.0);
    if (h.x > 0.88) {
      vec2 c = cell + 0.5 + (h - 0.5) * 0.6;
      c.x += 0.2 * sin(beats * 0.5 + h.y * 20.0);
      float d = length(ep - c);
      float tw = 0.5 + 0.5 * sin(beats * 2.0 + h.y * 50.0);
      col += heat(0.5 + 0.35 * h.y) * exp(-d * d * 180.0) * tw * 0.5 * (0.3 + lit);
    }
  }

  // --- the anthem: satin ribbons of gold, as bright as the melody is present ---
  float mel = uBandB.w * P_ANTHEM;
  if (mel > 0.02) {
    vec3 gold = mix(uPalHigh.rgb * 0.6, vec3(1.0, 0.7, 0.28) * 0.5, 0.6);
    vec3 glint = mix(gold, vec3(1.0, 0.92, 0.75), 0.6);
    float W = 0.011 * (1.0 + 0.8 * uHit2.y);
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      float y = anthemY(p.x, fk, beats);
      float phi = p.x * (1.3 + 0.4 * fk) - beats * 0.4 + fk * 1.9;
      vec3 r = ribbon(p, y, phi, W / (1.0 + fk * 0.25), px);
      float amt = mel * (0.5 + 1.1 * uHit2.y) * (0.6 + 0.4 * uLookB.y) / (1.0 + fk * 0.6);
      col += (mix(gold, glint, r.z) * r.x + gold * r.y * 0.1) * amt;
      // A glitter of notes along it: each melodic attack lights a few points,
      // four-rayed like light caught on a thread. Each point is looked up in
      // its own cell AND its neighbours', or its rays end at a cell's edge.
      if (uHit2.y > 0.02) {
        float c0 = floor(p.x * 30.0);
        for (int j = -1; j <= 1; j++) {
          float cx = c0 + float(j);
          if (hash11(cx * 1.7 + fk * 13.0 + floor(beats)) < 0.86) continue;
          float sx = (cx + 0.5) / 30.0;
          vec2 dq = abs(p - vec2(sx, anthemY(sx, fk, beats)));
          float star = exp(-dot(dq, dq) * 2.5e5)
                     + 0.35 * (exp(-dq.y * 900.0 - dq.x * 70.0) + exp(-dq.x * 900.0 - dq.y * 70.0));
          col += glint * star * uHit2.y * amt * 2.0;
        }
      }
    }
  }

  col += heat(1.0) * uHit2.w * 0.12;
  col *= mix(0.3, 1.0, clearOfHole(p, 0.05));
  emit(col * mix(1.0, uEnergy, 0.6));
}
`,

  particles: {
    count: 8 * SPARKS_PER_EVENT,
    vertex: `${SHARED}
void particle(int id, out vec2 pos, out vec2 axis, out float width, out vec4 col, out float kind) {
  int e = id % 8;
  float j = float(id / 8);
  vec4 ev = uEv[e];
  col = vec4(0.0);
  pos = vec2(0.0); axis = vec2(0.0); width = 0.0; kind = 0.0;
  if (ev.y <= 0.0) return;
  float n = ${SPARKS_PER_EVENT}.0;
  // A roll note throws a small spray; a main kick the whole fountain.
  if (j >= n * clamp(ev.y * 0.75 * P_SPARKS, 0.08, 1.0)) return;
  vec3 h = hash31(j * 7.13 + ev.w * 131.0);
  float S = anvilScale();
  float age = (uClock.x - ev.x) * uSpeed;
  float life = 0.9 + 1.8 * h.z;
  if (age < 0.0 || age > life) return;
  // Launched in a fan from the point of impact, faster for a harder blow.
  float ang = 1.5708 + (h.x - 0.5) * 2.7;
  float spd = (0.8 + 2.6 * h.y * h.y) * (0.6 + 0.4 * min(ev.y, 2.0)) * S;
  vec2 v0 = vec2(cos(ang) * 1.25, sin(ang)) * spd;
  // Air drag, then gravity: x(t) = v0 (1 - e^-kt)/k, and y adds -g t^2 / 2.
  float k = 1.3;
  float dr = (1.0 - exp(-k * age)) / k;
  vec2 at = anvil(ev.z) + vec2(0.0, 0.03 * S) + v0 * dr + vec2(0.0, -0.95 * S * age * age);
  vec2 vel = v0 * exp(-k * age) + vec2(0.0, -1.9 * S * age);
  float t = 1.0 - age / life;
  // A spark that reaches the floor skitters along it and dies there, rather
  // than falling through the stone it just lit.
  float fy = anvil(1.0).y - 0.255 * S;
  if (at.y < fy) {
    float under = (fy - at.y) / S;
    at.y = fy + 0.003 * S;
    vel = vec2(vel.x * 0.7, 0.0);
    t *= exp(-under * 14.0);
  }
  pos = at;
  // A streak along the velocity: how far the spark moves in a sliver of a beat,
  // which is what a camera shutter sees.
  axis = vel * 0.045 + normalize(vel + 1e-5) * 0.004;
  width = (0.004 + 0.004 * t) * (0.8 + 0.4 * h.z);
  // Not every spark leaves the anvil white: a hard blow throws some already
  // yellow, which is what keeps a burst from reading as one white flower.
  col = vec4(heat((0.25 + 0.75 * t) * (0.72 + 0.28 * fract(h.x * 7.0))) * (0.7 + 0.7 * h.y), 1.0);
  kind = t;
}
`,
    fragment: `
vec4 sprite(vec2 q, vec4 c, float k) {
  // A hot head at the leading end of the streak, a fading tail behind it.
  float r = 1.0 - smoothstep(0.0, 1.0, length(q * vec2(1.0, 1.0)));
  float head = smoothstep(-0.2, 1.0, q.x);
  return vec4(c.rgb * r * (0.35 + 1.4 * head * head), 1.0);
}
`,
  },

  create({ ev, state, flash, params }) {
    const ring = eventRing(ev);
    let heatNow = 0.3;
    let blow = 0;
    let lastSlot = 0;
    const anvils = params.anvils > 1.5 ? 3 : 1;
    let n = 0;
    const strike = (at, power) => {
      // The blows move between the anvils, a different one each time but never
      // at random: across a bar they walk left-centre-right-centre.
      const walk = [1, 0, 1, 2];
      const k = anvils > 1 ? walk[n % 4] : 1;
      lastSlot = ring.head;
      ring.push(at, power, k, hashN(n++));
    };
    const main = onStamp((m) => m.stamp.main, (s, m) => {
      strike(s, 0.6 + 0.6 * Math.min(1.2, m.mainPower || m.kick || 0.8));
      blow = 1;
    });
    const roll = onStamp((m) => m.stamp.roll, (s) => strike(s, 0.3));
    const drop = onStamp((m) => m.stamp.drop, (s) => {
      strike(s, 2);
      flash(0.9);
    });
    return {
      step(dt, m) {
        main(m);
        roll(m);
        drop(m);
        // The metal heats with every blow and cools over a couple of bars.
        heatNow = m.ease(heatNow, 0.15 + 0.6 * m.drive, 6, dt);
        heatNow = Math.min(1, heatNow + blow * 0.12);
        blow = 0;
        state[0] = heatNow;
        state[2] = lastSlot;
      },
    };
  },
};
