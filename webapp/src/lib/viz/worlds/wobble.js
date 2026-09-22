// DUBSTEP — one band, wobbling.
//
// The whole genre is a low-frequency oscillator on a bass, so the visual is a
// single thick band across the middle whose shape IS that oscillator: its
// frequency is locked to the beat subdivision, its amplitude to the bass, and
// on the drop it tears open. It is drawn three times with a small horizontal
// offset per copy — the chromatic split every dubstep video has ever used, and
// the cheapest way to make one shape look violent.
//
// Deliberately the only world with a single subject: dubstep is one enormous
// sound at a time, and a busy picture is the wrong answer to it.
//
// `wave` is the LFO's own shape and it is what tells these genres apart, since
// it is what tells them apart in the music: 0 is a sine (the bend melodic
// dubstep is made of), 1 a square — riddim is gated on and off and the band has
// to jump, not travel — and 2 a saw, which is brostep's scream. Anything else
// here is a scaling; this is the sound.

import { approach, clamp, envelope, hsl, lerp } from "../util.js";

export function createWobbleWorld(preset, opts, skin = {}) {
  const p = skin.p || {};
  const RATE = p.rate ?? 1;
  const SPLIT = p.split ?? 1;
  const BAND = p.band ?? 1;
  const TEAR = p.tear ?? 1;
  const WAVE = Math.max(0, Math.min(2, Math.round(p.wave ?? 0)));
  const SPEED = skin.speed ?? 1;
  let phase = 0;
  let amp = 0;
  let wob = 0;
  let tear = 0;
  let chaos = 0.5;
  let sub = 0;

  return {
    update(frame, dt) {
      const f = frame.features;
      const beat = frame.beat;
      const look = frame.style?.look;
      chaos = approach(chaos, look ? look.chaos : 0.5, 1.2, dt);

      const e = frame.energy;
      const total = e.sub + e.bass + e.lowMid + e.mid + e.high + e.air + 1e-12;
      sub = envelope(sub, clamp(((e.sub + e.bass) / total) * 2.4, 0, 1), dt, 0.03, 0.2);
      amp = envelope(amp, clamp((f.level || 0) * 1.1, 0, 1), dt, 0.04, 0.3);
      // The wobble rate: an eighth, a sixteenth or a triplet of the beat,
      // stepped by how hard the bass is pushing — which is what a dubstep
      // producer is doing with their hand on the LFO knob.
      const period = beat.locked ? beat.period : 0.5;
      const rate = (lerp(2, 6, sub) * RATE * SPEED) / Math.max(0.05, period);
      phase += dt * rate;
      wob = envelope(wob, clamp((f.kick || 0) + sub * 0.5, 0, 1), dt, 0.008, 0.18);
      // The tear: level and kick together, which only happens at a drop.
      const drop = clamp((f.level || 0) * (f.kick || 0) * 2.2, 0, 1);
      tear = envelope(tear, drop * TEAR, dt, 0.01, 0.35);
    },

    draw(g, geom, pal, w) {
      const h = geom.h;
      const cy = geom.cy;
      // The oscillator. Square and saw are computed from the same phase as the
      // sine, so changing `wave` changes the SHAPE and never the rate.
      const osc =
        WAVE === 1
          ? (x) => (Math.sin(x) >= 0 ? 1 : -1)
          : WAVE === 2
            ? (x) => 1 - 2 * (((x / (Math.PI * 2)) % 1 + 1) % 1)
            : Math.sin;
      g.globalCompositeOperation = "lighter";
      const steps = Math.max(40, Math.min(160, Math.floor(geom.w / 9)));
      // Thin. A wobble is a line being bent, and a band a third of the screen
      // deep stops being a line and becomes a colour field.
      const band = h * (0.022 + amp * 0.04 + wob * 0.06) * BAND;
      const swing = h * (0.06 + wob * 0.24 + tear * 0.22);
      // Three copies, offset sideways: the chromatic split. The offset grows
      // with the tear, so the picture literally comes apart on the drop.
      const split = geom.w * 0.004 * SPLIT * (1 + tear * 6) * (0.4 + chaos);
      const copies = [
        { dx: -split, hue: pal.low, a: 0.1 },
        { dx: split, hue: pal.high, a: 0.1 },
        { dx: 0, hue: pal.mid, a: 0.16 },
      ];

      for (const c of copies) {
        const alpha = c.a * w.energy * preset.glow;
        if (alpha < 0.005) continue;
        g.fillStyle = hsl(c.hue, pal.sat, 0.6, alpha);
        g.beginPath();
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const x = t * geom.w + c.dx;
          // Two oscillators, one at the wobble rate and one at a third of it:
          // a single sine is a ripple, and dubstep is not a ripple.
          const y =
            cy +
            osc(phase + t * 7.5) * swing +
            osc(phase * 0.34 - t * 2.3) * swing * 0.5;
          i === 0 ? g.moveTo(x, y - band / 2) : g.lineTo(x, y - band / 2);
        }
        for (let i = steps; i >= 0; i--) {
          const t = i / steps;
          const x = t * geom.w + c.dx;
          const y =
            cy +
            osc(phase + t * 7.5) * swing +
            osc(phase * 0.34 - t * 2.3) * swing * 0.5;
          g.lineTo(x, y + band / 2);
        }
        g.closePath();
        g.fill();
      }

      // The sub: a slab along the bottom of the frame that the band sits over.
      const sh = h * 0.1 * sub;
      if (sh > 1) {
        const gr = g.createLinearGradient(0, h - sh, 0, h);
        gr.addColorStop(0, hsl(pal.low, pal.sat, 0.5, 0));
        gr.addColorStop(1, hsl(pal.low, pal.sat, 0.55, 0.12 * sub * w.energy * preset.glow));
        g.fillStyle = gr;
        g.fillRect(0, h - sh, geom.w, sh);
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}
