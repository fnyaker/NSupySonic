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
//    the beat rather than after it. A separate, much brighter shockwave fires
//    on the KICK itself — detected rather than predicted, so it also shows up
//    on a track with no lock, and it is what makes the kick read as a hit
//    instead of as one more thing happening on the beat.
//
// Everything is drawn additively over a translucent wash rather than a clear,
// which gives motion trails for free — far cheaper than any blur.

import { approach, clamp, envelope, hsl } from "../util.js";

const BANDS = ["sub", "bass", "lowMid", "mid", "high", "air"];
const MAX_RINGS = 12;
// A kick shockwave lives here, separately from the beat rings: its colours and
// widths belong to the kick, not to the beat grid, and in "spectrum" mode the
// palette has already spent the beat rings' hues.
const MAX_WAVES = 6;

export function createPulseScene(opts = {}) {
  const preset = opts.preset;
  const band = new Float32Array(BANDS.length);
  const rings = [];
  for (let i = 0; i < MAX_RINGS; i++) rings.push({ age: -1, life: 1, power: 0, down: false });
  const waves = [];
  for (let i = 0; i < MAX_WAVES; i++) waves.push({ age: -1, life: 1, power: 0 });
  let level = 0;
  let kick = 0;
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

  // A detected kick. Unlike the beat rings this fires whenever the transient is
  // there, locked or not, and it is deliberately scarce — MAX_WAVES means a
  // dense passage keeps only the strongest few rather than turning the screen
  // into soup.
  function spawnWave(power) {
    let slot = waves.find((r) => r.age < 0);
    if (!slot) {
      slot = waves.reduce((a, b) => (a.power > b.power ? b : a));
    }
    if (slot.age >= 0 && slot.power > power) return; // don't displace a bigger hit
    slot.age = 0;
    slot.life = 0.38;
    slot.power = power;
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
    // The kick, from the magnitude-domain detector. `lowFlux` was the old
    // source here and it is still mixed into the ODF the beat tracker folds,
    // but as a DRAWING signal it is noise-sensitive and its scale depends on the
    // master, which is why the field used to pulse hard on some tracks and not
    // at all on others.
    const kickIn = f ? f.kick : 0;
    // Rising edge, with the floor high enough that the detector's own wobble on
    // a sustained bass does not spawn a wave every frame.
    if (kickIn > 0.38 && kickIn > kick + 0.12) spawnWave(kickIn);
    kick = envelope(kick, kickIn, dt, 0.006, 0.13);

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
    for (const wv of waves) {
      if (wv.age < 0) continue;
      wv.age += dt;
      if (wv.age > wv.life) wv.age = -1;
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
    const fieldR = R * (0.5 + level * 0.5 + kick * 0.3);
    const field = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, fieldR));
    field.addColorStop(0, hsl(pal.hue, pal.sat, 0.5, 0.22 * preset.glow * (0.4 + level + kick * 0.5)));
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

    // The kick shockwaves, drawn over the rings. A ring says "a beat happened";
    // this says "something hit", which is not the same statement and does not
    // read the same. It travels faster, dies sooner, and is bright enough to be
    // unmistakable at a glance — plus a filled disc that collapses inward, so
    // the hit has a body and not only an expanding edge.
    for (const wv of waves) {
      if (wv.age < 0) continue;
      const t = wv.age / wv.life;
      const p = wv.power;
      const rad = R * (0.05 + t * 1.05);
      const alpha = (1 - t) * (1 - t) * p * 0.75 * preset.glow;
      if (alpha < 0.005) continue;
      g.strokeStyle = hsl(pal.low, pal.sat * 0.9, 0.8, alpha);
      g.lineWidth = Math.max(1, (7 - t * 5) * (0.6 + p));
      g.beginPath();
      g.arc(cx, cy, rad, 0, Math.PI * 2);
      g.stroke();

      // The core flash: bright on the hit, gone within a fifth of the wave's
      // life, so it reads as an impact rather than a glow.
      const core = Math.max(0, 1 - t * 5);
      if (core > 0.01) {
        const cr = R * 0.34 * (0.5 + p * 0.8) * (0.7 + t * 1.4);
        const cg = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, cr));
        cg.addColorStop(0, hsl(pal.low + 12, pal.sat, 0.92, core * 0.42 * p * preset.glow));
        cg.addColorStop(1, hsl(pal.low, pal.sat, 0.6, 0));
        g.fillStyle = cg;
        g.beginPath();
        g.arc(cx, cy, cr, 0, Math.PI * 2);
        g.fill();
      }
    }

    g.globalCompositeOperation = "source-over";
  }

  return { resize, update, draw };
}
