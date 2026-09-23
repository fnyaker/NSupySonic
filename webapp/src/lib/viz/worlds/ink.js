// ENCRE — ink blooming in water, a volute per note.
//
// Jazz, blues, folk, neo-classical piano, anything played by hands: the
// picture is the macro shot every ink-in-water film is made of. Drops of
// luminous ink falling into dark water, blooming, curling into volutes and
// thinning into smoke as they sink.
//
//   THE BLOOM. Every note attack drops ink somewhere in the frame, in that
//   note's colour: for a beat the water pushes outward from the drop — the
//   plume opening — and then the ink is left to the current.
//   THE CURRENT is the curl of a slow noise field (so the ink folds without
//   ever piling up or thinning out — the property real water has), plus a
//   gentle sink: ink is heavier than water and every plume falls a little as
//   it curls.
//   THE MEMORY is the previous frame, carried back along the current, faded
//   over several bars, and softly limited — everything scaled by the frame's
//   own duration, so it flows the same at 30 fps and at 144.
//   THE MUSIC. The notes are the drops; the kick, when there is one, adds a
//   small drop low in the frame; the drop fills the water with three at once.
//   Nothing else moves it: this is a world for music you listen to.
//
// Parameters:
//   ink     how much each drop pours    curl   current strength
//   fade    memory (bars)

import { eventRing, onStamp, hashN } from "./kit.js";

export default {
  id: "ink",
  uses: ["noise"],
  feedback: true,
  params: { ink: 1, curl: 1, fade: 1 },
  look: { exposure: 1.0, bloom: 1.1, threshold: 0.75, saturation: 1.2 },

  fragment: `
vec2 curl(vec2 q, float t) {
  float e = 0.02;
  float a = gnoise(q + vec2(0.0, e) + t);
  float b = gnoise(q - vec2(0.0, e) + t);
  float c = gnoise(q + vec2(e, 0.0) - t);
  float d = gnoise(q - vec2(e, 0.0) - t);
  return vec2(a - b, -(c - d)) / (2.0 * e);
}

void main() {
  vec2 p = fragP();
  vec2 uv = gl_FragCoord.xy / uRes;
  float A = uFrame.z;
  float dtB = uS0.x;
  float tt = uS0.y;
  // The current: fine curls and a slow sink.
  vec2 v = (curl(p * 2.2, tt) + 0.5 * curl(p * 5.0 + 3.0, tt * 1.4)) * 0.07 * P_CURL;
  v += vec2(0.0, -0.05);
  // Each fresh drop pushes the water outward from it for a beat: the plume.
  for (int i = 0; i < 8; i++) {
    vec4 ev = uEv[i];
    float age = uClock.x - ev.x;
    if (ev.y <= 0.0 || age < 0.0 || age > 1.5) continue;
    vec2 at = vec2(ev.z, fract(ev.w) * 2.0 - 1.0);
    vec2 d = p - at;
    float r2 = dot(d, d);
    v += d / (r2 + 0.01) * exp(-r2 / 0.08) * exp(-age * 2.5) * 0.06 * ev.y;
  }
  vec2 dp = v * dtB;
  vec2 back = uv - vec2(dp.x / (2.0 * A), dp.y * 0.5);
  vec3 col = prev(back);
  vec2 px1 = 1.0 / uRes;
  vec3 avg = (prev(back + vec2(px1.x, 0.0)) + prev(back - vec2(px1.x, 0.0)) + prev(back + vec2(0.0, px1.y)) + prev(back - vec2(0.0, px1.y))) * 0.25;
  col = max(col + (col - avg) * 0.07, vec3(0.0));
  float tau = (14.0 + 10.0 * uArc.z) * P_FADE;
  col *= exp(-dtB / tau);
  // Ink that drifts behind the artwork dissolves there within a beat: nobody
  // can see it, and the tank it came from should not drain into a hole.
  col *= exp(-dtB * 5.0 * (1.0 - clearOfHole(p, 0.08)));
  // The drops themselves: ink poured in over their first half beat.
  for (int i = 0; i < 8; i++) {
    vec4 ev = uEv[i];
    float age = uClock.x - ev.x;
    if (ev.y <= 0.0 || age < 0.0 || age > 0.6) continue;
    vec2 at = vec2(ev.z, fract(ev.w) * 2.0 - 1.0) + vec2(0.0, -age * 0.08);
    float r = 0.018 + age * 0.05;
    float blob = exp(-dot(p - at, p - at) / (r * r));
    vec3 c = pal(floor(ev.w) / 16.0);
    col += c * blob * dtB * 5.0 * ev.y * P_INK;
  }
  col /= 1.0 + 0.25 * dtB * max(col.r, max(col.g, col.b));
  // The water itself, lit faintly from the surface above. A FLOOR rather than
  // an addition: this image feeds back, and a constant added every frame
  // would build up into fog.
  // It brightens with the track: a breakdown is a dim tank, a drop a lit one.
  vec3 water = mix(uPalLow.rgb * 0.012, mix(uPalLow.rgb, uPalMid.rgb, 0.3) * 0.07, smoothstep(-1.0, 1.0, p.y)) * (0.75 + 0.5 * uMood.y);
  col = max(col, water * mix(0.35, 1.0, clearOfHole(p, 0.05)));
  emit(col);
}
`,

  create({ ev, state, flash }) {
    const ring = eventRing(ev);
    let t = 0;
    let n = 0;
    let clocksNow = null;
    let lastNoteAt = -1e9;
    // A drop: x across the frame, y and colour packed as (colour index) +
    // y01, the colour index being the pitch walked along the palette.
    const drop = (s, power, low = false) => {
      const A = clocksNow?.aspect || 16 / 9;
      const [hx = 0, hy = 0, hw = 0, hh = 0] = clocksNow?.hole || [];
      let x;
      let y01;
      if (hw > 0 && A - (Math.abs(hx) + hw) < 0.25) {
        // A phone: the cover spans the width, and a drop pushed out beside it
        // landed off the screen — the tank looked empty. So the ink pours
        // above and below the cover instead, mostly below, since it sinks.
        x = (hashN(n * 5 + 1) * 2 - 1) * (A - 0.12);
        const below = [-0.92, hy - hh - 0.1];
        const above = [hy + hh + 0.1, 0.9];
        const roomB = below[1] - below[0];
        const roomA = above[1] - above[0];
        const useBelow = roomB > 0.12 && (low || hashN(n + 11) < 0.65 || roomA < 0.12);
        const band = useBelow || roomA < 0.12 ? below : above;
        const y = band[0] + Math.max(0, band[1] - band[0]) * hashN(n + 9);
        y01 = Math.min(0.999, Math.max(0, (y + 1) / 2));
      } else {
        x = (hashN(n * 5 + 1) * 2 - 1) * (A - 0.25);
        if (hw > 0 && Math.abs(x - hx) < hw + 0.1) x = hx + Math.sign(x - hx || 1) * (hw + 0.1 + 0.25 * hashN(n + 3));
        x = Math.max(-A + 0.1, Math.min(A - 0.1, x));
        y01 = low ? 0.15 + 0.15 * hashN(n + 7) : 0.45 + 0.45 * hashN(n + 9);
      }
      const pitch = clocksNow?.pitch ?? 0.5;
      const colour = Math.max(0, Math.min(15, Math.round(pitch * 15)));
      ring.push(s, power, x, colour + Math.min(0.999, y01));
      n++;
    };
    const note = onStamp((m) => m.stamp.note, (s) => {
      if (s - lastNoteAt < 0.5) return;
      lastNoteAt = s;
      drop(s, 1);
    });
    const kick = onStamp((m) => m.stamp.main, (s, m) => {
      if (m.melodic < 0.3 && n % 2 === 0) drop(s, 0.6, true);
      else if (m.melodic < 0.3) n++;
    });
    const dropS = onStamp((m) => m.stamp.drop, (s) => {
      // The drop pours: four drops, fuller than any note's.
      drop(s, 1.5);
      drop(s + 0.1, 1.5);
      drop(s + 0.2, 1.4);
      drop(s + 0.3, 1.3);
      flash(0.4);
    });
    return {
      step(dt, m, clocks) {
        clocksNow = clocks;
        note(m);
        kick(m);
        dropS(m);
        const dtB = Math.min(dt / m.beat, 0.5);
        t += dtB * 0.02;
        state[0] = dtB;
        state[1] = t;
      },
    };
  },
};
