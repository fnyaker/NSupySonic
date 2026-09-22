// FRENCHCORE — the hammer and the anthem.
//
// What the music is: a straight 4/4 at 190-220 BPM built on one enormous
// distorted kick, and — the part that separates it from every other hard genre
// — an anthemic, frankly euphoric melody over the top. It is violent and it is
// singing at the same time, and any picture that only shows the violence has
// got half of it.
//
// So the scene is two things that do not blend:
//
//   THE HAMMER. Every kick drives a hard bar down through the middle of the
//   frame and throws a shock front out along its edges. Between kicks the
//   picture is nearly empty — at 200 BPM that is three tenths of a second of
//   near-black, and the emptiness is what makes the next hit land. A scene that
//   is always busy cannot hit.
//
//   THE ANTHEM. A bright catenary across the upper frame that is DRAWN IN over
//   the phrase: it completes as the sixteen bars complete, brightest at the
//   turnaround, and it is the only soft thing in here. It follows the melodic
//   attacks, so a track with no lead draws almost none of it and a track with a
//   supersaw riff draws the whole span.
//
// Nothing in here is timed in seconds. The bar is `m.bar`, the shock lives four
// beats, the anthem is keyed to `m.phrasePhase`, and the hammer's recoil decays
// over a fraction of a beat — so the same code is right at 190 and at 220.

import { clamp, hsl, lerp } from "../util.js";
import { pool, shock, traceLine, arc01 } from "./kit.js";

export const meta = { label: "Frenchcore", trail: 0.46 };

export function create(preset, opts) {
  // One shock per kick, and at 210 BPM a four-beat life means four alive.
  const shocks = pool(6, () => ({ age: -1, power: 0, hue: 0 }));
  const SHOCK_LIFE = 4; // beats
  // The anthem is sampled once per sixteenth of the phrase and held, so it
  // draws as a line being written rather than as a curve being animated.
  const SPAN = 48;
  const anthem = new Float32Array(SPAN);
  let written = 0;
  let recoil = 0; // the bar's downward travel, in fractions of the frame
  let lastPhrase = 0;
  let glare = 0;

  return {
    update(frame, dt, geom, m) {
      // The hammer. `m.hit` is the frame a kick was accepted, so this fires on
      // the kick itself rather than on the grid — frenchcore is played, and a
      // roll or a triplet fill has to be seen.
      if (m.hit || (m.onBeat && m.kick > 0.3)) {
        const s = shocks.take();
        s.age = 0;
        s.power = clamp(0.45 + m.kick * 0.8, 0, 1.3);
        // Each hit leans the hue a little further round, so a bar of four does
        // not draw four identical rings.
        s.hue = (m.beatPhase + m.barPhase) * 40;
        recoil = lerp(0.1, 0.3, m.punch) * s.power;
        glare = clamp(glare + s.power * 0.5, 0, 1);
      }
      // Recoil back up over a fifth of a beat: fast enough that the bar is
      // already rising before the next kick at 220 BPM, slow enough to read.
      recoil = m.ease(recoil, 0, 0.2, dt);
      glare = m.ease(glare, 0, 0.35, dt);
      shocks.age(dt, m.beat, SHOCK_LIFE);

      // The anthem writes itself across the phrase. `written` is a position,
      // not a timer: it tracks where in the sixteen bars we are, so a tempo
      // change moves the pen rather than stretching what is already drawn.
      const want = Math.floor(m.phrasePhase * SPAN);
      if (m.phrasePhase < lastPhrase) anthem.fill(0); // a new phrase, a new line
      lastPhrase = m.phrasePhase;
      for (let i = written; i <= want && i < SPAN; i++) {
        // Height is the melody's own pitch, brightness its attack. A track
        // with no lead leaves the line flat and dim, which is correct.
        anthem[i] = clamp(
          (frame.features?.melodyPitch ?? 0.5) * 0.7 + m.note * 12 + m.melodic * 0.25,
          0,
          1
        );
      }
      written = want < written ? 0 : want;
    },

    draw(g, geom, pal, w, m) {
      const W = geom.w;
      const H = geom.h;
      g.globalCompositeOperation = "lighter";

      // --- the shocks, first: they are behind everything ---------------------
      for (const s of shocks.items) {
        if (s.age < 0) continue;
        const t = s.age / SHOCK_LIFE;
        // Constant speed, and a stroke wider than the per-frame step, so the
        // trail copies merge into one shell instead of stacking into countable
        // rings (the 8-bit quantisation trap this project already paid for).
        const a = (1 - t) * (1 - t) * s.power * 0.5 * w.energy * preset.glow;
        shock(
          g,
          geom,
          0.08 + t * 1.25,
          geom.rMin * (0.02 + t * 0.05),
          pal.low + s.hue,
          pal.sat,
          lerp(0.72, 0.5, t),
          a
        );
      }

      // --- the hammer bar ----------------------------------------------------
      // A single hard horizontal slab that the kick drives down. It is the only
      // straight edge in the scene and it is what the eye locks onto.
      const y = H * (0.5 + recoil);
      const thick = H * (0.012 + m.punch * 0.02 + recoil * 0.5);
      const hg = g.createLinearGradient(0, y - thick, 0, y + thick);
      const heat = clamp(0.35 + glare * 0.65, 0, 1);
      hg.addColorStop(0, hsl(pal.high, pal.sat, 0.6, 0));
      hg.addColorStop(0.5, hsl(pal.high, pal.sat * 0.8, lerp(0.6, 0.92, heat), (0.25 + glare * 0.5) * w.energy * preset.glow));
      hg.addColorStop(1, hsl(pal.low, pal.sat, 0.55, 0));
      g.fillStyle = hg;
      g.fillRect(0, y - thick, W, thick * 2);

      // The impact itself: a short, very bright wedge under the bar, only for
      // the instant after a hit. This is the distortion, drawn.
      if (glare > 0.04) {
        const spread = W * (0.1 + glare * 0.5);
        const ig = g.createRadialGradient(W / 2, y, 0, W / 2, y, spread);
        ig.addColorStop(0, hsl(pal.high, pal.sat * 0.5, 0.95, glare * 0.5 * w.energy * preset.glow));
        ig.addColorStop(1, hsl(pal.mid, pal.sat, 0.6, 0));
        g.fillStyle = ig;
        g.fillRect(0, y - spread, W, spread * 2);
      }

      // --- the anthem --------------------------------------------------------
      // Drawn last and thin. It sits in the upper third, clear of the bar, and
      // it brightens toward the end of the phrase — the turnaround is the
      // moment the melody is supposed to arrive.
      if (written > 2) {
        const lift = 0.35 + arc01(m.phrasePhase) * 0.25;
        g.strokeStyle = hsl(
          pal.high + 12,
          pal.sat,
          0.85,
          (0.1 + m.melodic * 0.25) * lift * w.energy * preset.glow
        );
        g.lineWidth = Math.max(1.5, H * 0.004 * (1 + m.note * 20));
        g.lineCap = "round";
        traceLine(g, written, (t) => {
          const i = Math.min(SPAN - 1, Math.round(t * written));
          return [t * (written / SPAN) * W, H * (0.34 - anthem[i] * 0.22)];
        });
        g.stroke();
      }
      g.globalCompositeOperation = "source-over";
      void opts;
    },
  };
}
