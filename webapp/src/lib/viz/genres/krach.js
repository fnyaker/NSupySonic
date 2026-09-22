// KRACH — noise, and how much of it there is.
//
// "Krach" is German for din, racket, noise. The Deutscher-Krach kick is the
// German hard scene's most saturated: a short kick driven until the distortion
// IS the sound, with the harmonics it throws off covering the spectrum. What
// separates it from its neighbours is not pattern or tempo, it is texture —
// so the picture is a texture, and the one thing it measures is how noisy the
// track is right now (`flatness`, which is exactly "tonal or destroyed").
//
// The motif is STATIC: bands of interference across the whole frame, torn
// sideways on every kick, with clean lines showing through where the music
// still has a note in it. A track that is merely loud draws a few soft bands;
// one that is genuinely destroyed fills the screen and tears on every beat.
//
// Nothing here is a particle system, because nothing in the sound is an event
// separate from the noise. The tear count and the drift are per bar.

import { clamp, hsl, lerp } from "../util.js";

export const meta = { label: "Krach", trail: 0.52 };

export function create(preset, opts) {
  const BANDS = 26;
  const off = new Float32Array(BANDS);
  // WHERE EACH BAND IS GOING, not how fast it is moving — and the difference is
  // the whole reason this scene passes the stopwatch. A tear modelled as a
  // shove travels `velocity x time`, and the time is a fraction of a beat, so
  // at twice the tempo each tear moves half as far twice as often and the
  // picture moves exactly as much as before: measured, a ratio of 1.20 against
  // the 1.25 the suite asks for. A tear is not a shove, it is a JUMP — the
  // frame is somewhere else on the next field — so every kick adds a fixed
  // DISPLACEMENT and the band chases it. Twice the kicks is then twice the
  // travel, which is what the eye sees at 180 BPM.
  const goal = new Float32Array(BANDS);
  for (let i = 0; i < BANDS; i++) off[i] = goal[i] = ((i * 37) % 100) / 100;
  let tear = 0;
  let noise = 0.3;
  let squeeze = 0;

  return {
    update(frame, dt, geom, m) {
      // The kick tears the picture sideways. Every band gets a different shove,
      // which is what makes it read as interference rather than as a slide.
      if (m.mainKick || m.hit || (m.onBeat && m.kick > 0.28)) {
        tear = clamp(0.5 + (m.mainPower || m.kick) * 0.8, 0, 1.4);
        for (let i = 0; i < BANDS; i++)
          goal[i] += (((i * 61) % 17) / 8 - 1) * tear * lerp(0.04, 0.2, m.chaos);
        squeeze = clamp(0.3 + m.punch * 0.5, 0, 1);
      }
      tear = m.ease(tear, 0, 0.35, dt);
      squeeze = m.ease(squeeze, 0, 0.6, dt);
      // How noisy the sound actually is. This is the whole classifier for this
      // genre in one number, and the picture is mostly a readout of it.
      noise = m.ease(noise, clamp((frame.features?.flatness || 0) * 1.7, 0, 1), 2.5, dt);
      // The slow crawl underneath, per bar, so the static is never quite still.
      const drift = m.perBar(0.35) * dt;
      for (let i = 0; i < BANDS; i++) {
        goal[i] += drift * ((i % 2) * 2 - 1) * (0.3 + noise);
        // Landed within a quarter beat: at 250 BPM that is 60 ms, which is a
        // tear rather than a slide, and at 90 it is long enough to see.
        off[i] = m.ease(off[i], goal[i], 0.25, dt);
      }
    },

    draw(g, geom, pal, w, m) {
      const W = geom.w;
      const H = geom.h;
      g.globalCompositeOperation = "lighter";
      const bh = H / BANDS;

      for (let i = 0; i < BANDS; i++) {
        // Squeezed toward the middle on a kick: the frame compresses, which is
        // what a limiter slamming actually looks like.
        const y = (i + 0.5) * bh;
        const yy = lerp(y, H / 2, squeeze * 0.12);
        const amp = clamp(noise * (0.4 + ((i * 29) % 11) / 11) + tear * 0.4, 0, 1.3);
        const a = (0.02 + amp * 0.24) * w.energy * preset.glow;
        if (a < 0.004) continue;
        const hue = pal.low + (pal.high - pal.low) * (i / BANDS) + tear * 20;
        // Each band is drawn as a run of hard segments with gaps: that is what
        // makes it read as static rather than as a stripe.
        const seg = 5 + Math.round(noise * 16);
        const segW = W / seg;
        g.fillStyle = hsl(hue, pal.sat * (0.4 + noise * 0.6), lerp(0.4, 0.92, clamp(amp, 0, 1)), a);
        for (let s = 0; s < seg; s++) {
          // The band's own offset walks, so the gaps crawl instead of blinking.
          const u = (s / seg + off[i]) % 1;
          if (((s * 13 + i * 7) % 5) < 2) continue; // the holes
          const x = u * W;
          g.fillRect(x, yy - bh * 0.42, segW * (0.4 + noise * 0.5), bh * (0.5 + amp * 0.5));
        }
      }

      // What is LEFT of the music: a clean horizontal line through the middle,
      // brightest when the track is at its most tonal. It is the thing the
      // noise is covering up, and it is what makes the noise mean something.
      const clean = 1 - noise;
      if (clean > 0.08) {
        const cy = geom.hole ? Math.min(H * 0.9, geom.cy + geom.hh + H * 0.1) : H * 0.5;
        const cg = g.createLinearGradient(0, cy - H * 0.02, 0, cy + H * 0.02);
        cg.addColorStop(0, hsl(pal.high, pal.sat, 0.8, 0));
        cg.addColorStop(0.5, hsl(pal.high, pal.sat * 0.5, 0.95, clean * 0.3 * w.energy * preset.glow));
        cg.addColorStop(1, hsl(pal.high, pal.sat, 0.8, 0));
        g.fillStyle = cg;
        g.fillRect(0, cy - H * 0.02, W, H * 0.04);
      }
      g.globalCompositeOperation = "source-over";
      void opts;
    },
  };
}
