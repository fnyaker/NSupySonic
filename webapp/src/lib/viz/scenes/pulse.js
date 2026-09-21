// "Colours on the beat": a colour field driven by tempo and by the level of
// each frequency band.
//
// Four things are happening at once, and they are deliberately separable so
// none of them ever reads as noise:
//
//  - the FIELD. A wash whose colour comes from the palette (in "spectrum" mode
//    that means the bass/treble balance picks the hue) and whose reach breathes
//    with the overall level. It covers the WHOLE frame — on a 16:9 screen a
//    radial gradient sized on `min(w, h)` leaves a third of the picture black.
//  - the PETALS. Six lobes, one per energy band, each one's reach being that
//    band's level. This is the readable part: you can see the bass and the air
//    move independently. They are placed through the frame's own polar
//    mapping, so they spread across a beamer and sit AROUND the artwork in the
//    player rather than behind it.
//  - the RINGS. One expanding ellipse per beat, a wider and brighter one on the
//    downbeat. With the beat grid locked these are PREDICTED, so they land on
//    the beat rather than after it. Elliptical because the frame is: a ring
//    reaches the sides and the top at the same moment instead of touching the
//    top and then spending the rest of its life invisible off the sides.
//  - the KICK, as a much brighter shockwave — detected rather than predicted,
//    so it also shows up on a track with no lock, and it is what makes the kick
//    read as a hit instead of as one more thing happening on the beat. With an
//    artwork in the way it is born at the artwork's rim, which turns the cover
//    into the thing the hit comes OUT of.
//
// Everything is drawn additively over a translucent wash rather than a clear,
// which gives motion trails for free — far cheaper than any blur.

import { approach, clamp, envelope, hsl } from "../util.js";

const TAU = Math.PI * 2;
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
    slot.life = 0.3;
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
    spin += (dt / (barLen * 8)) * TAU;

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

  function draw(g, w, h, pal, geom) {
    const cx = geom.cx;
    const cy = geom.cy;

    // Trail wash. Slightly tinted rather than pure black so the scene keeps a
    // colour cast instead of going muddy.
    g.globalCompositeOperation = "source-over";
    // The wash has to hold against what is drawn over it, and what is drawn
    // over it now covers the WHOLE frame rather than a disc in the middle of
    // it. Additive compositing accumulates to `alpha / wash`, so a scene that
    // tripled its coverage and kept its wash is a scene that goes white.
    g.fillStyle = hsl(pal.hue, 0.5, 0.04, preset.trail * 1.4 + 0.3);
    g.fillRect(0, 0, w, h);

    g.globalCompositeOperation = "lighter";

    // The field, sized to reach the corners. With artwork in the way it is an
    // ANNULUS: a blob centred on something opaque is a blob nobody sees, and
    // the light belongs on the frame around it either way.
    const fieldR = geom.rMax * (0.55 + level * 0.35 + kick * 0.2);
    const inner = geom.hole ? Math.min(geom.hw, geom.hh) * 0.9 : 0;
    const field = g.createRadialGradient(cx, cy, inner, cx, cy, Math.max(inner + 1, fieldR));
    const fa = 0.055 * preset.glow * (0.35 + level * 0.7 + kick * 0.45);
    field.addColorStop(0, hsl(pal.hue, pal.sat, 0.5, fa));
    field.addColorStop(0.55, hsl(pal.hue + 22, pal.sat, 0.4, 0.045 * preset.glow));
    field.addColorStop(1, hsl(pal.hue + 40, pal.sat, 0.3, 0));
    g.fillStyle = field;
    g.fillRect(0, 0, w, h);

    // The petals, one per band, laid out on the frame's own polar mapping: at
    // radial 0.62 they sit two thirds of the way from the artwork's rim to the
    // edge, which on a phone is the strip above and below the cover and on a
    // beamer is most of the width.
    const n = BANDS.length;
    for (let i = 0; i < n; i++) {
      const a = spin + (i / n) * TAU;
      const v = band[i];
      const p = geom.place(a, 0.3 + v * 0.55);
      // The blob's size follows how much room there is along that angle, so it
      // is generous across a wide screen and tidy on a phone.
      const room = geom.edgeAt(a) - geom.innerAt(a);
      const rad = Math.max(3, room * (0.22 + v * 0.4));
      const hue = pal.low + (pal.high - pal.low) * (i / (n - 1));
      const gr = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], rad);
      gr.addColorStop(0, hsl(hue, pal.sat, 0.62, (0.035 + v * 0.13) * preset.glow));
      gr.addColorStop(1, hsl(hue, pal.sat, 0.5, 0));
      g.fillStyle = gr;
      g.beginPath();
      g.arc(p[0], p[1], rad, 0, TAU);
      g.fill();
    }

    // The rings. TWO RULES, and both of them exist because a thin ring with
    // motion trails draws a tunnel rather than a shockwave:
    //  - it travels at a CONSTANT speed, so its trail is evenly spaced;
    //  - it is wider than that spacing, so the copies merge into one soft band
    //    moving outwards instead of into a set of concentric circles.
    // A ring that slows down as it fades breaks the second rule at exactly the
    // radius where there are the most copies, which is what the moiré was.
    const lineBase = geom.rMin;
    for (const r of rings) {
      if (r.age < 0) continue;
      const t = r.age / r.life;
      const grow = t * (r.down ? 1 : 0.85);
      const alpha = (1 - t) * (1 - t) * r.power * (r.down ? 0.2 : 0.12) * preset.glow;
      if (alpha < 0.004) continue;
      g.strokeStyle = hsl(r.down ? pal.high : pal.mid, pal.sat, r.down ? 0.72 : 0.62, alpha);
      g.lineWidth = Math.max(3, lineBase * (r.down ? 0.075 : 0.05) * (1 - t * 0.5) * (0.7 + level * 0.6));
      g.beginPath();
      g.ellipse(cx, cy, Math.max(1, geom.ringRx(grow)), Math.max(1, geom.ringRy(grow)), 0, 0, TAU);
      g.stroke();
    }

    // The kick shockwaves, drawn over the rings. A ring says "a beat happened";
    // this says "something hit", which is not the same statement and does not
    // read the same. It travels faster, dies sooner, and is bright enough to be
    // unmistakable at a glance — plus a flash with a body, not only an
    // expanding edge.
    for (const wv of waves) {
      if (wv.age < 0) continue;
      const t = wv.age / wv.life;
      const p = wv.power;
      const alpha = (1 - t) * (1 - t) * p * 0.3 * preset.glow;
      if (alpha < 0.004) continue;
      // A WIDE, dim shell rather than a thin bright line. A ring crossing a
      // 1600-pixel frame in a third of a second moves about fifty pixels per
      // frame, so a thin stroke leaves fifty-pixel gaps between its trails and
      // the whole thing reads as a set of concentric circles — a tunnel, not a
      // shockwave. A stroke wider than the gap merges its own trail into one
      // soft band travelling outwards, which is what a shockwave looks like.
      g.strokeStyle = hsl(pal.low, pal.sat * 0.9, 0.8, alpha);
      g.lineWidth = Math.max(4, geom.rMin * 0.11 * (1 - t * 0.5) * (0.5 + p * 0.7));
      g.beginPath();
      g.ellipse(cx, cy, Math.max(1, geom.ringRx(t)), Math.max(1, geom.ringRy(t)), 0, 0, TAU);
      g.stroke();

      // The core flash: bright on the hit, gone within a fifth of the wave's
      // life, so it reads as an impact rather than a glow. Over artwork it
      // becomes a halo on its rim — same event, drawn where it can be seen.
      const core = Math.max(0, 1 - t * 5);
      if (core > 0.01) {
        const r0 = geom.hole ? Math.min(geom.hw, geom.hh) * 0.85 : 0;
        const cr = r0 + geom.rMin * 0.5 * (0.5 + p * 0.8) * (0.7 + t * 1.4);
        const cg = g.createRadialGradient(cx, cy, r0, cx, cy, Math.max(r0 + 1, cr));
        cg.addColorStop(0, hsl(pal.low + 12, pal.sat, 0.92, core * 0.42 * p * preset.glow));
        cg.addColorStop(1, hsl(pal.low, pal.sat, 0.6, 0));
        g.fillStyle = cg;
        g.beginPath();
        g.arc(cx, cy, cr, 0, TAU);
        g.fill();
      }
    }

    g.globalCompositeOperation = "source-over";
  }

  return { resize, update, draw };
}
