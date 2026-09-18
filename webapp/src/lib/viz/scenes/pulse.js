// "Colours on the beat": the scene the brief actually asked for — a colour
// field driven by tempo and by the level of each frequency band.
//
// Three things are happening at once, and they are deliberately separable so
// none of them ever reads as noise:
//
//  - the FIELD. A big radial gradient whose colour comes from the palette (in
//    "spectrum" mode that means the bass/treble balance picks the hue) and whose
//    radius breathes with the overall level.
//  - the PETALS. Six lobes around the centre, one per energy band, each one's
//    reach being that band's level. This is the readable part: you can see the
//    bass and the air move independently.
//  - the RINGS. One expanding ring per beat, a wider and brighter one on the
//    downbeat. With the beat grid locked these are PREDICTED, so they land on
//    the beat rather than after it.
//
// Everything is drawn additively over a translucent wash rather than a clear,
// which gives motion trails for free — far cheaper than any blur.

import { approach, clamp, envelope, hsl } from "../util.js";

const BANDS = ["sub", "bass", "lowMid", "mid", "high", "air"];
const MAX_RINGS = 12;

export function createPulseScene(opts = {}) {
  const preset = opts.preset;
  const band = new Float32Array(BANDS.length);
  const rings = [];
  for (let i = 0; i < MAX_RINGS; i++) rings.push({ age: -1, life: 1, power: 0, down: false });
  let level = 0;
  let punch = 0;
  let spin = 0;

  function spawn(power, down) {
    let slot = rings.find((r) => r.age < 0);
    if (!slot) {
      // Recycle the oldest rather than dropping the beat: a missing ring on a
      // busy passage is much more visible than one extra fading early.
      slot = rings.reduce((a, b) => (a.age > b.age ? a : b));
    }
    slot.age = 0;
    slot.life = down ? 1.5 : 1.1;
    slot.power = power;
    slot.down = down;
  }

  function resize() {}

  function update(frame, dt) {
    const f = frame.features;
    const e = frame.energy;
    const beat = frame.beat;
    const total = e.sub + e.bass + e.lowMid + e.mid + e.high + e.air + 1e-12;
    for (let i = 0; i < BANDS.length; i++) {
      // Share of the total, re-scaled: absolute band levels vary hugely between
      // masters, but the BALANCE between them is what the eye reads as "the
      // bass is doing something".
      const share = clamp((e[BANDS[i]] / total) * 3.2, 0, 1);
      band[i] = envelope(band[i], Math.pow(share, 0.75), dt, 0.03, 0.22);
    }
    level = approach(level, f ? f.level : 0, 0.12, dt);
    punch = envelope(punch, f ? clamp(f.lowFlux * 9, 0, 1) : 0, dt, 0.012, 0.26);

    // The field turns at the tempo: one full rotation every eight bars.
    const barLen = beat.locked ? beat.period * beat.beatsPerBar : 3;
    spin += (dt / (barLen * 8)) * Math.PI * 2;

    if (beat.beat) spawn(0.55 + level * 0.45, beat.downbeat);
    else if (!beat.locked && beat.onset > 0.45) spawn(beat.onset, false);

    for (const r of rings) {
      if (r.age < 0) continue;
      r.age += dt;
      if (r.age > r.life) r.age = -1;
    }
  }

  function draw(g, w, h, pal) {
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.5;

    // Trail wash. Slightly tinted rather than pure black so the scene keeps a
    // colour cast instead of going muddy.
    g.globalCompositeOperation = "source-over";
    g.fillStyle = hsl(pal.hue, 0.5, 0.04, preset.trail + 0.1);
    g.fillRect(0, 0, w, h);

    g.globalCompositeOperation = "lighter";

    // The field.
    const fieldR = R * (0.5 + level * 0.5 + punch * 0.12);
    const field = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, fieldR));
    field.addColorStop(0, hsl(pal.hue, pal.sat, 0.5, 0.22 * preset.glow * (0.4 + level)));
    field.addColorStop(0.55, hsl(pal.hue + 22, pal.sat, 0.4, 0.14 * preset.glow));
    field.addColorStop(1, hsl(pal.hue + 40, pal.sat, 0.3, 0));
    g.fillStyle = field;
    g.fillRect(0, 0, w, h);

    // The petals.
    const n = BANDS.length;
    for (let i = 0; i < n; i++) {
      const a = spin + (i / n) * Math.PI * 2;
      const v = band[i];
      const reach = R * (0.16 + v * 0.62);
      const px = cx + Math.cos(a) * reach * 0.55;
      const py = cy + Math.sin(a) * reach * 0.55;
      const rad = Math.max(2, R * (0.1 + v * 0.3));
      const hue = pal.low + (pal.high - pal.low) * (i / (n - 1));
      const gr = g.createRadialGradient(px, py, 0, px, py, rad);
      gr.addColorStop(0, hsl(hue, pal.sat, 0.62, (0.08 + v * 0.3) * preset.glow));
      gr.addColorStop(1, hsl(hue, pal.sat, 0.5, 0));
      g.fillStyle = gr;
      g.beginPath();
      g.arc(px, py, rad, 0, Math.PI * 2);
      g.fill();
    }

    // The rings.
    for (const r of rings) {
      if (r.age < 0) continue;
      const t = r.age / r.life;
      const rad = R * (0.08 + t * (r.down ? 1.15 : 0.85));
      const alpha = (1 - t) * (1 - t) * r.power * (r.down ? 0.55 : 0.34) * preset.glow;
      if (alpha < 0.004) continue;
      g.strokeStyle = hsl(
        r.down ? pal.high : pal.mid,
        pal.sat,
        r.down ? 0.72 : 0.62,
        alpha
      );
      g.lineWidth = Math.max(1, (r.down ? 4 : 2.2) * (1 - t) * (1 + level));
      g.beginPath();
      g.arc(cx, cy, rad, 0, Math.PI * 2);
      g.stroke();
    }

    g.globalCompositeOperation = "source-over";
  }

  return { resize, update, draw };
}
