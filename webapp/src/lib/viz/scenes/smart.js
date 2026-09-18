// The style-aware engine.
//
// It does NOT switch between five separate visualizers. Switching would mean a
// hard cut every time the classifier changed its mind, and a classifier running
// on three seconds of audio changes its mind often — at a breakdown, at a
// vocal entry, at the bar where the guitars drop out. So the five looks are
// LAYERS, each drawn at the weight its archetype currently holds, and a change
// of opinion is a crossfade that takes a couple of seconds. A track that is
// half sung and half instrumental looks like both at once, which is also the
// honest answer.
//
// The five layers, and what each is trying to say:
//
//   sustain  bowed strings. Long strokes sweeping across, with the vibrato the
//            tonality suggests, over resonating string lines. Nothing snaps,
//            because nothing in the music snaps.
//   voice    a bloom that breathes at the syllable rate, with light lifting off
//            it on the consonants. Keyed to the vocal modulation, so on an
//            instrumental passage it recedes and the other layers take over —
//            which is exactly the behaviour the brief asked for.
//   groove   machine rhythm: a polygon that snaps one vertex per beat, a grid
//            that pumps on the bass, a flash on every kick.
//   hard     kick-driven. Shockwaves sized by how hard the kick hit, coloured
//            by what KIND of kick it was (soft / hard / industrial), plus the
//            two flourishes that make the fast genres legible: saw streaks when
//            the lead is a saw, high sparks when it is a squeal.
//   rock     played rhythm: a guitar wall that moves with the mids and a slash
//            thrown on every snare.

import { approach, clamp, envelope, hsl, lerp } from "../util.js";

const TAU = Math.PI * 2;

// --- layer: bowed strings ---------------------------------------------------
function bowLayer(preset) {
  const strokes = [];
  const MAX = 3;
  for (let i = 0; i < MAX; i++) strokes.push({ on: false, x: 0, dir: 1, y: 0, len: 0, v: 0, age: 0 });
  let lull = 0;
  let vib = 0;
  let tone = 0;

  return {
    update(frame, dt) {
      const f = frame.features;
      tone = approach(tone, 1 - f.flatness, 0.6, dt);
      vib += dt * 5.4 * TAU; // ~5.4 Hz — the rate a string player actually uses
      lull += dt;
      const active = strokes.filter((s) => s.on).length;
      // A new stroke on a rise out of quiet, or simply every so often while the
      // music keeps going — a bow does change direction.
      if (active < MAX && f.level > 0.18 && lull > lerp(2.6, 0.9, f.level)) {
        lull = 0;
        const s = strokes.find((x) => !x.on);
        if (s) {
          s.on = true;
          s.dir = Math.random() < 0.5 ? 1 : -1;
          s.x = s.dir > 0 ? -0.15 : 1.15;
          s.y = 0.2 + Math.random() * 0.6;
          s.len = 0.3 + Math.random() * 0.35;
          s.v = lerp(0.1, 0.34, f.level) * (0.7 + Math.random() * 0.6);
          s.age = 0;
        }
      }
      for (const s of strokes) {
        if (!s.on) continue;
        s.age += dt;
        s.x += s.dir * s.v * dt;
        if (s.x > 1.3 || s.x < -0.3) s.on = false;
      }
    },
    draw(g, w, h, pal, weight) {
      g.globalCompositeOperation = "lighter";
      // Resonating strings behind the strokes.
      const lines = preset.layers + 2;
      for (let i = 0; i < lines; i++) {
        const t = (i + 0.5) / lines;
        const y = h * (0.16 + t * 0.68);
        const a = 0.05 + 0.09 * tone;
        g.strokeStyle = hsl(pal.low + (pal.high - pal.low) * t, pal.sat * 0.7, 0.6, a * weight);
        g.lineWidth = 1;
        g.beginPath();
        const steps = 28;
        for (let k = 0; k <= steps; k++) {
          const x = (k / steps) * w;
          const amp = Math.sin((k / steps) * Math.PI) * h * 0.012 * tone;
          const yy = y + Math.sin(vib + i * 1.7 + (k / steps) * 6) * amp;
          k === 0 ? g.moveTo(x, yy) : g.lineTo(x, yy);
        }
        g.stroke();
      }
      for (const s of strokes) {
        if (!s.on) continue;
        // Fade in and out at the ends of the sweep, so nothing pops at the edge.
        const edge = clamp(Math.min(s.x + 0.15, 1.15 - s.x) / 0.2, 0, 1);
        const x0 = (s.x - s.len / 2) * w;
        const x1 = (s.x + s.len / 2) * w;
        const y = s.y * h + Math.sin(vib) * h * 0.008 * tone;
        const gr = g.createLinearGradient(x0, 0, x1, 0);
        const hue = pal.mid + s.dir * 18;
        gr.addColorStop(0, hsl(hue, pal.sat, 0.6, 0));
        gr.addColorStop(0.5, hsl(hue, pal.sat, 0.68, 0.5 * weight * edge * preset.glow));
        gr.addColorStop(1, hsl(hue, pal.sat, 0.6, 0));
        g.strokeStyle = gr;
        g.lineCap = "round";
        g.lineWidth = Math.max(1.5, h * 0.012 * (0.6 + tone));
        g.beginPath();
        g.moveTo(x0, y);
        g.quadraticCurveTo((x0 + x1) / 2, y - h * 0.03 * s.dir, x1, y);
        g.stroke();
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}

// --- layer: voice -----------------------------------------------------------
function voiceLayer(preset) {
  const N = Math.max(12, Math.floor(preset.particles * 0.35));
  const p = new Float32Array(N * 5); // x, y, vy, life, seed
  let next = 0;
  let bloom = 0;
  let prevMod = 0;

  return {
    update(frame, dt) {
      const f = frame.features;
      bloom = envelope(bloom, f.vocalMod, dt, 0.06, 0.4);
      // A syllable is a RISE in the modulation, not its level — that is what
      // separates "singing now" from "a sustained note".
      const rise = Math.max(0, f.vocalMod - prevMod);
      prevMod = f.vocalMod;
      const emit = rise > 0.04 || frame.beat.onset > 0.5;
      if (emit) {
        const n = Math.min(5, 1 + Math.floor(rise * 40));
        for (let k = 0; k < n; k++) {
          const i = (next = (next + 1) % N) * 5;
          p[i] = 0.5 + (Math.random() - 0.5) * 0.35;
          p[i + 1] = 0.55 + (Math.random() - 0.5) * 0.12;
          p[i + 2] = 0.06 + Math.random() * 0.16;
          p[i + 3] = 1;
          p[i + 4] = Math.random();
        }
      }
      for (let k = 0; k < N; k++) {
        const i = k * 5;
        if (p[i + 3] <= 0) continue;
        p[i + 1] -= p[i + 2] * dt;
        p[i] += Math.sin(p[i + 4] * 12 + p[i + 1] * 9) * 0.03 * dt;
        p[i + 3] -= dt * 0.55;
      }
    },
    draw(g, w, h, pal, weight) {
      const cx = w / 2;
      const cy = h * 0.55;
      const R = Math.min(w, h) * (0.14 + bloom * 0.26);
      g.globalCompositeOperation = "lighter";
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, R));
      gr.addColorStop(0, hsl(pal.mid, pal.sat, 0.68, 0.34 * weight * preset.glow));
      gr.addColorStop(0.5, hsl(pal.high, pal.sat, 0.55, 0.12 * weight * preset.glow));
      gr.addColorStop(1, hsl(pal.high, pal.sat, 0.5, 0));
      g.fillStyle = gr;
      g.beginPath();
      g.arc(cx, cy, R, 0, TAU);
      g.fill();
      for (let k = 0; k < N; k++) {
        const i = k * 5;
        const life = p[i + 3];
        if (life <= 0) continue;
        const r = Math.max(0.6, (1 + p[i + 4] * 2) * (h / 420));
        g.fillStyle = hsl(pal.high + p[i + 4] * 30, pal.sat, 0.8, life * 0.5 * weight);
        g.beginPath();
        g.arc(p[i] * w, p[i + 1] * h, r, 0, TAU);
        g.fill();
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}

// --- layer: machine groove --------------------------------------------------
function grooveLayer(preset) {
  let rot = 0;
  let snap = 0;
  let kick = 0;
  let bassPump = 0;

  return {
    update(frame, dt) {
      const beat = frame.beat;
      const n = beat.beatsPerBar || 4;
      if (beat.beat) snap = 1;
      snap = approach(snap, 0, 0.12, dt);
      // The polygon rests on a vertex and eases to the next one each beat, so
      // the motion IS the beat rather than a continuous spin that happens to
      // be the right speed.
      rot = (beat.beatIndex % n) * (TAU / n) - snap * (TAU / n);
      kick = envelope(kick, clamp((frame.features.lowFlux || 0) * 8, 0, 1), dt, 0.008, 0.2);
      bassPump = envelope(
        bassPump,
        clamp((frame.bands[3] + frame.bands[8]) * 0.6, 0, 1),
        dt,
        0.03,
        0.24
      );
    },
    draw(g, w, h, pal, weight) {
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.3;
      g.globalCompositeOperation = "lighter";

      // Kick flash.
      if (kick > 0.01) {
        const gr = g.createRadialGradient(cx, cy, 0, cx, cy, R * (1.1 + kick * 0.8));
        gr.addColorStop(0, hsl(pal.low, pal.sat, 0.6, 0.3 * kick * weight * preset.glow));
        gr.addColorStop(1, hsl(pal.low, pal.sat, 0.5, 0));
        g.fillStyle = gr;
        g.fillRect(0, 0, w, h);
      }

      // Dot grid, pumping on the bass.
      if (preset.layers >= 3) {
        const step = Math.max(26, Math.min(70, w / 16));
        const r = 1 + bassPump * 2.2;
        g.fillStyle = hsl(pal.mid, pal.sat * 0.6, 0.6, (0.06 + bassPump * 0.14) * weight);
        for (let x = step / 2; x < w; x += step)
          for (let y = step / 2; y < h; y += step) {
            g.beginPath();
            g.arc(x, y, r, 0, TAU);
            g.fill();
          }
      }

      // The polygon.
      const n = 3 + (preset.layers >= 3 ? 1 : 0) + 2;
      const rad = R * (0.8 + bassPump * 0.25);
      g.strokeStyle = hsl(pal.high, pal.sat, 0.68, (0.25 + snap * 0.4) * weight);
      g.lineWidth = 1.5 + snap * 2.5;
      g.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = rot + (i / n) * TAU;
        const x = cx + Math.cos(a) * rad;
        const y = cy + Math.sin(a) * rad;
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.closePath();
      g.stroke();
      g.globalCompositeOperation = "source-over";
    },
  };
}

// --- layer: hard / kick-driven ---------------------------------------------
// The colour of a shockwave is the kick's character, not the palette's: a soft
// kick keeps the track's colour, a hard one pushes it hot, an industrial one
// bleaches it. That is the whole point of classifying the kick at all.
const KICK_TINT = {
  soft: { dh: 0, ds: 0, dl: 0 },
  hard: { dh: 26, ds: 0.1, dl: 0.06 },
  industrial: { dh: -12, ds: -0.45, dl: 0.2 },
};

function hardLayer(preset, opts) {
  const MAX = 10;
  const waves = [];
  for (let i = 0; i < MAX; i++) waves.push({ age: -1, life: 0.42, p: 0, tint: "soft" });
  const SPARKS = Math.max(10, Math.floor(preset.particles * 0.5));
  const sp = new Float32Array(SPARKS * 4); // x, y, life, seed
  let sparkNext = 0;
  let strobe = 0;
  let saw = 0;
  let style = "";

  return {
    update(frame, dt) {
      const k = frame.style?.kick;
      style = frame.style?.dominant || "";
      const beat = frame.beat;
      if (k?.hit || (beat.beat && beat.locked)) {
        let slot = waves.find((x) => x.age < 0) || waves.reduce((a, b) => (a.age > b.age ? a : b));
        slot.age = 0;
        slot.life = 0.32 + (k?.decay || 0.1);
        slot.p = clamp(0.45 + (k?.strength || 0.4) * 0.8, 0, 1.4);
        slot.tint = k?.type || "hard";
      }
      for (const wv of waves) {
        if (wv.age < 0) continue;
        wv.age += dt;
        if (wv.age > wv.life) wv.age = -1;
      }
      // The strobe is capped by the intensity setting and switched off entirely
      // under prefers-reduced-motion — a full-screen flash on every downbeat is
      // exactly what that setting exists to prevent.
      const flash = opts.reducedMotion ? 0 : 0.5 * opts.intensity;
      if (beat.downbeat) strobe = flash;
      strobe = approach(strobe, 0, 0.07, dt);

      saw = envelope(saw, clamp((frame.features.midFlux || 0) * 14, 0, 1), dt, 0.02, 0.22);

      if (style === "pieep" || style === "uptempo" || style === "krach") {
        const hi = frame.features.highFlux * 16;
        if (hi > 0.5) {
          const i = (sparkNext = (sparkNext + 1) % SPARKS) * 4;
          sp[i] = Math.random();
          sp[i + 1] = Math.random() * 0.4;
          sp[i + 2] = 1;
          sp[i + 3] = Math.random();
        }
      }
      for (let k2 = 0; k2 < SPARKS; k2++) {
        const i = k2 * 4;
        if (sp[i + 2] <= 0) continue;
        sp[i + 2] -= dt * 2.6;
      }
    },
    draw(g, w, h, pal, weight) {
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.5;
      g.globalCompositeOperation = "lighter";

      if (strobe > 0.004) {
        g.fillStyle = hsl(pal.high, 0.15, 0.9, strobe * 0.45 * weight);
        g.fillRect(0, 0, w, h);
      }

      // Saw streaks — the "zaag" read: a gliding, harmonically dense lead gets
      // diagonal strokes that lean the way the energy is moving.
      // Saw strokes belong to the styles whose LEAD is a saw — zaag is
      // literally the word for it — not to every fast genre. Frenchcore and
      // uptempo are about the kick, and they already have the shockwaves and
      // the strobe to say so; adding strokes there just buried them.
      if (saw > 0.02 && (style === "zaag" || style === "hardtekk")) {
        const n = 3 + Math.floor(saw * preset.layers);
        g.lineCap = "round";
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          // Inset, so a stroke never runs off the edge and reads as clipped.
          const x = w * (0.1 + t * 0.8);
          // Short, bounded strokes that lean with the energy. Anchored in the
          // lower third and never longer than a third of the height: a stroke
          // that crosses the whole canvas stops reading as a burst of energy
          // and starts reading as a scratch on the screen.
          const len = h * (0.1 + saw * 0.22);
          const y0 = h * (0.62 + ((i * 0.37) % 0.3));
          const lean = len * 0.55;
          const gr = g.createLinearGradient(x - lean, y0, x + lean, y0 - len);
          const hue = pal.high + i * 7;
          gr.addColorStop(0, hsl(hue, pal.sat, 0.6, 0));
          gr.addColorStop(0.45, hsl(hue, pal.sat, 0.7, saw * 0.5 * weight * preset.glow));
          gr.addColorStop(1, hsl(hue + 12, pal.sat, 0.75, 0));
          g.strokeStyle = gr;
          g.lineWidth = Math.max(1.5, h * 0.006 * (0.5 + saw));
          g.beginPath();
          g.moveTo(x - lean, y0);
          g.lineTo(x + lean, y0 - len);
          g.stroke();
        }
      }

      for (const wv of waves) {
        if (wv.age < 0) continue;
        const t = wv.age / wv.life;
        const tint = KICK_TINT[wv.tint] || KICK_TINT.hard;
        const rad = R * (0.05 + t * 1.25);
        const a = (1 - t) * (1 - t) * wv.p * 0.95 * weight * preset.glow;
        if (a < 0.004) continue;
        g.strokeStyle = hsl(
          pal.low + tint.dh,
          clamp(pal.sat + tint.ds, 0, 1),
          clamp(0.58 + tint.dl, 0, 0.95),
          a
        );
        g.lineWidth = Math.max(2, R * 0.075 * (1 - t) * wv.p);
        g.beginPath();
        g.arc(cx, cy, rad, 0, TAU);
        g.stroke();
      }

      for (let k = 0; k < SPARKS; k++) {
        const i = k * 4;
        const life = sp[i + 2];
        if (life <= 0) continue;
        g.fillStyle = hsl(pal.high + sp[i + 3] * 60, 0.9, 0.85, life * 0.7 * weight);
        const r = Math.max(0.8, (h / 500) * (1 + sp[i + 3]));
        g.fillRect(sp[i] * w, sp[i + 1] * h, r, r * 5);
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}

// --- layer: rock ------------------------------------------------------------
function rockLayer(preset) {
  const WALL = 64;
  const wall = new Float32Array(WALL);
  const slashes = [];
  for (let i = 0; i < 6; i++) slashes.push({ age: -1, x: 0, dir: 1, p: 0 });
  let prevMid = 0;

  return {
    update(frame, dt) {
      const b = frame.bands;
      // The wall is the mid band only: guitars, not the whole spectrum. Drawing
      // everything would just be a second spectrum analyser.
      const from = Math.floor(b.length * 0.25);
      const to = Math.floor(b.length * 0.8);
      const per = (to - from) / WALL;
      for (let i = 0; i < WALL; i++) {
        let m = 0;
        const a = from + Math.floor(i * per);
        const e = from + Math.floor((i + 1) * per);
        for (let j = a; j < e && j < b.length; j++) if (b[j] > m) m = b[j];
        wall[i] = envelope(wall[i], m, dt, 0.02, 0.13);
      }
      const mid = frame.features.midFlux || 0;
      if (mid > prevMid * 1.9 && mid > 0.006) {
        const s = slashes.find((x) => x.age < 0);
        if (s) {
          s.age = 0;
          s.x = 0.15 + Math.random() * 0.7;
          s.dir = Math.random() < 0.5 ? 1 : -1;
          s.p = clamp(mid * 60, 0.3, 1);
        }
      }
      prevMid = approach(prevMid, mid, 0.09, dt);
      for (const s of slashes) {
        if (s.age < 0) continue;
        s.age += dt;
        if (s.age > 0.3) s.age = -1;
      }
    },
    draw(g, w, h, pal, weight) {
      g.globalCompositeOperation = "lighter";
      const mid = h * 0.55;
      const span = h * 0.34;
      g.beginPath();
      for (let i = 0; i < WALL; i++) {
        const x = (i / (WALL - 1)) * w;
        const y = mid - wall[i] * span;
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      for (let i = WALL - 1; i >= 0; i--) {
        const x = (i / (WALL - 1)) * w;
        const y = mid + wall[i] * span * 0.75;
        g.lineTo(x, y);
      }
      g.closePath();
      const gr = g.createLinearGradient(0, mid - span, 0, mid + span);
      gr.addColorStop(0, hsl(pal.high, pal.sat, 0.6, 0.06 * weight));
      gr.addColorStop(0.5, hsl(pal.mid, pal.sat, 0.55, 0.3 * weight * preset.glow));
      gr.addColorStop(1, hsl(pal.low, pal.sat, 0.45, 0.06 * weight));
      g.fillStyle = gr;
      g.fill();

      for (const s of slashes) {
        if (s.age < 0) continue;
        const t = s.age / 0.3;
        const a = (1 - t) * s.p * 0.55 * weight;
        g.strokeStyle = hsl(pal.high, 0.5, 0.88, a);
        g.lineWidth = Math.max(1.5, h * 0.006 * (1 - t) * 2);
        g.lineCap = "round";
        const x = s.x * w;
        const len = h * 0.3 * (0.6 + s.p);
        g.beginPath();
        g.moveTo(x - (len / 2) * s.dir, mid - len / 2);
        g.lineTo(x + (len / 2) * s.dir, mid + len / 2);
        g.stroke();
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}

export function createSmartScene(opts = {}) {
  const preset = opts.preset;
  const o = { intensity: opts.intensity ?? 0.7, reducedMotion: !!opts.reducedMotion };
  const layers = {
    sustain: bowLayer(preset),
    voice: voiceLayer(preset),
    groove: grooveLayer(preset),
    hard: hardLayer(preset, o),
    rock: rockLayer(preset),
  };
  // Smoothed weights: the classifier is already smoothed, but its output still
  // steps whenever the family ranking shifts, and a step in a layer's alpha is
  // visible as a flicker on a dark scene.
  const weight = { sustain: 0, voice: 0, groove: 0.4, hard: 0, rock: 0 };
  const KEYS = Object.keys(weight);
  let level = 0;

  function resize() {}

  function update(frame, dt) {
    const mix = frame.style?.archetypes;
    for (const k of KEYS) {
      const target = mix ? mix[k] || 0 : k === "groove" ? 0.35 : 0;
      weight[k] = approach(weight[k], target, 1.4, dt);
    }
    level = approach(level, frame.features?.level || 0, 0.14, dt);
    for (const k of KEYS) if (weight[k] > 0.035) layers[k].update(frame, dt);
  }

  function draw(g, w, h, pal) {
    // Trail wash rather than a clear: motion trails for free, and it means a
    // layer fading out leaves the scene gracefully instead of vanishing.
    g.globalCompositeOperation = "source-over";
    g.fillStyle = hsl(pal.hue, 0.45, 0.045, preset.trail);
    g.fillRect(0, 0, w, h);

    // A floor of ambient colour so the scene is never black between events.
    const cx = w / 2;
    const cy = h * 0.55;
    const R = Math.max(w, h) * 0.75;
    const bg = g.createRadialGradient(cx, cy, 0, cx, cy, R);
    bg.addColorStop(0, hsl(pal.hue, pal.sat * 0.7, 0.2, 0.22 + level * 0.2));
    bg.addColorStop(1, hsl(pal.hue + 30, pal.sat * 0.5, 0.06, 0));
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    // Drawn back to front: the sustained, atmospheric layers first, the sharp
    // event-driven ones on top, so a kick is never buried under a ribbon.
    for (const k of ["sustain", "rock", "groove", "voice", "hard"]) {
      if (weight[k] <= 0.035) continue;
      // Weight^1.35 rather than the weight itself: the classifier's mix is a
      // distribution, and drawing it linearly means the also-rans are nearly as
      // present as the winner. The exponent keeps the secondary layers as
      // texture under the dominant one instead of competing with it.
      const wgt = Math.pow(weight[k], 1.35) * (0.6 + o.intensity * 0.95);
      layers[k].draw(g, w, h, pal, Math.min(1.25, wgt));
    }
  }

  // Intensity and the reduced-motion flag are read live from `o`, so the
  // settings preview can move them without the scene being rebuilt under it.
  function setOptions(next) {
    if (next.intensity != null) o.intensity = next.intensity;
    if (next.reducedMotion != null) o.reducedMotion = !!next.reducedMotion;
  }

  return { resize, update, draw, setOptions, weights: weight };
}
