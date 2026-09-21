// The style-aware engine.
//
// It does NOT switch between visualizers. Switching would mean a hard cut every
// time the classifier changed its mind, and a classifier running on a few
// seconds of audio changes its mind often — at a breakdown, at a vocal entry,
// at the bar where the guitars drop out. So the looks are LAYERS, each drawn at
// the weight it currently holds, and a change of opinion is a crossfade that
// takes a couple of seconds. A track that is half sung and half instrumental
// looks like both at once, which is also the honest answer.
//
// NINE LAYERS, NOT FIVE. The first five are the visual archetypes the
// classifier pools its fifty-odd families into (sustain / voice / groove /
// hard / rock). Those five are what can be BLENDED, and they are the reason a
// vocal house track and a vocal metal track do not look alike — but they are
// also why, for a long time, every fast genre looked the same: psytrance,
// frenchcore, drum & bass and speedcore all pool into `hard`, and `hard` drew
// one thing. The other four are keyed to the LOOK vector instead (style.js:
// motion, density, punch, smooth, warm, melodic, chaos), which is exactly the
// axis on which those genres differ:
//
//   sustain  bowed strings. Long strokes sweeping across, over resonating
//            string lines. Nothing snaps, because nothing in the music snaps.
//   voice    a bloom that breathes at the syllable rate, with light lifting off
//            it on the consonants.
//   groove   machine rhythm: a polygon that snaps one vertex per beat, a grid
//            that pumps on the bass, a flash on every kick.
//   hard     kick-driven shockwaves, sized by how hard the kick hit and
//            coloured by what KIND of kick it was, going jagged as the genre
//            gets more chaotic.
//   rock     played rhythm: a guitar wall that moves with the mids and a slash
//            thrown on every snare.
//   warp     SPEED. Streaks rushing outward from the middle to the corners, one
//            volley per beat. Weighted by `motion`, so psytrance and uptempo
//            get it and techno barely does.
//   lattice  CHAOS. A grid that snaps on the beat and tears into offset slabs.
//            Industrial, krach, dubstep, speedcore.
//   orbit    MELODY. Twelve arcs around the frame, one per pitch class, lit by
//            the chroma. Trance, synthwave, strings — anything with a line in
//            it rather than only a rhythm.
//   haze     CALM. Slow drifting blooms, for ambient, lofi and downtempo.
//
// Every layer is written on lib/viz/geometry.js rather than on `w/2, h/2,
// min(w,h)`, so all of them fill a 16:9 screen and all of them keep clear of
// the artwork when there is artwork in front of the canvas.

import { approach, clamp, envelope, hsl, lerp } from "../util.js";

const TAU = Math.PI * 2;

// An expanding ring in the frame's own shape: an ellipse that reaches the
// sides and the top at the same moment, going jagged with `jag`.
function ringPath(g, geom, t, jag, seed) {
  const rx = Math.max(1, geom.ringRx(t));
  const ry = Math.max(1, geom.ringRy(t));
  if (jag < 0.05) {
    g.beginPath();
    g.ellipse(geom.cx, geom.cy, rx, ry, 0, 0, TAU);
    return;
  }
  const n = 44;
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU;
    const k = 1 + jag * 0.2 * Math.sin(a * 5 + seed) * Math.sin(a * 2 - seed * 1.7);
    const x = geom.cx + Math.cos(a) * rx * k;
    const y = geom.cy + Math.sin(a) * ry * k;
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.closePath();
}

// --- layer: bowed strings ---------------------------------------------------
function bowLayer(preset) {
  const strokes = [];
  const MAX = 3;
  for (let i = 0; i < MAX; i++)
    strokes.push({ on: false, x: 0, dir: 1, y: 0, len: 0, v: 0, age: 0 });
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
      // A stroke is a NOTE, so a note attack starts one — `melodyFlux` is the
      // onset function with the drums taken out of it (features.js). The timer
      // is the fallback for music that sustains without ever re-attacking; a
      // bow does change direction eventually.
      const attack = (f.melodyFlux || 0) > 0.012 && lull > 0.22;
      if (active < MAX && f.level > 0.18 && (attack || lull > lerp(2.6, 0.9, f.level))) {
        lull = 0;
        const s = strokes.find((x) => !x.on);
        if (s) {
          s.on = true;
          s.dir = Math.random() < 0.5 ? 1 : -1;
          s.x = s.dir > 0 ? -0.15 : 1.15;
          // High notes ride high on the screen. `melodyPitch` is where the
          // SUSTAINED energy sits, so this follows the line being played rather
          // than the loudest thing in the mix.
          const pitch = f.melodyPitch ?? 0.5;
          s.y = clamp(0.82 - pitch * 0.62 + (Math.random() - 0.5) * 0.16, 0.08, 0.92);
          s.len = 0.35 + Math.random() * 0.45;
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
    draw(g, geom, pal, weight) {
      const w = geom.w;
      const h = geom.h;
      g.globalCompositeOperation = "lighter";
      // Resonating strings behind the strokes, over the WHOLE height — they are
      // the layer's texture and a letterboxed band of them reads as a mistake.
      const lines = preset.layers + 2;
      for (let i = 0; i < lines; i++) {
        const t = (i + 0.5) / lines;
        const y = h * (0.08 + t * 0.84);
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
        gr.addColorStop(0.5, hsl(hue, pal.sat, 0.68, 0.7 * weight * edge * preset.glow));
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
  const p = new Float32Array(N * 6); // x, y, vy, life, seed, node
  let next = 0;
  let bloom = 0;
  let prevMod = 0;

  return {
    update(frame, dt, geom) {
      const f = frame.features;
      bloom = envelope(bloom, f.vocalMod, dt, 0.06, 0.4);
      // A syllable is a RISE in the modulation, not its level — that is what
      // separates "singing now" from "a sustained note".
      const rise = Math.max(0, f.vocalMod - prevMod);
      prevMod = f.vocalMod;
      const emit = rise > 0.04 || frame.beat.onset > 0.5;
      const nodes = geom.nodes.length || 1;
      if (emit) {
        const n = Math.min(5, 1 + Math.floor(rise * 40));
        for (let k = 0; k < n; k++) {
          const i = (next = (next + 1) % N) * 6;
          const node = Math.floor(Math.random() * nodes);
          p[i] = (Math.random() - 0.5) * 0.3; // offset from the node, in frames
          p[i + 1] = (Math.random() - 0.5) * 0.12;
          p[i + 2] = 0.06 + Math.random() * 0.16;
          p[i + 3] = 1;
          p[i + 4] = Math.random();
          p[i + 5] = node;
        }
      }
      for (let k = 0; k < N; k++) {
        const i = k * 6;
        if (p[i + 3] <= 0) continue;
        p[i + 1] -= p[i + 2] * dt;
        p[i] += Math.sin(p[i + 4] * 12 + p[i + 1] * 9) * 0.03 * dt;
        p[i + 3] -= dt * 0.55;
      }
    },
    draw(g, geom, pal, weight) {
      g.globalCompositeOperation = "lighter";
      // One bloom per emission point: a single one in the middle of a beamer is
      // a small circle in a large black rectangle, and behind artwork it is
      // nothing at all.
      const nodes = geom.nodes;
      for (const nd of nodes) {
        const R = geom.rMin * (0.3 + bloom * 0.55) * (0.6 + nd.w * 0.4);
        const gr = g.createRadialGradient(nd.x, nd.y, 0, nd.x, nd.y, Math.max(1, R));
        gr.addColorStop(0, hsl(pal.mid, pal.sat, 0.68, 0.45 * weight * nd.w * preset.glow));
        gr.addColorStop(0.5, hsl(pal.high, pal.sat, 0.55, 0.16 * weight * nd.w * preset.glow));
        gr.addColorStop(1, hsl(pal.high, pal.sat, 0.5, 0));
        g.fillStyle = gr;
        g.beginPath();
        g.arc(nd.x, nd.y, R, 0, TAU);
        g.fill();
      }
      for (let k = 0; k < N; k++) {
        const i = k * 6;
        const life = p[i + 3];
        if (life <= 0) continue;
        const nd = nodes[Math.min(nodes.length - 1, p[i + 5] | 0)] || nodes[0];
        if (!nd) continue;
        const r = Math.max(0.6, (1 + p[i + 4] * 2) * (geom.h / 420));
        g.fillStyle = hsl(pal.high + p[i + 4] * 30, pal.sat, 0.8, life * 0.5 * weight);
        g.beginPath();
        g.arc(nd.x + p[i] * geom.w * 0.5, nd.y + p[i + 1] * geom.h, r, 0, TAU);
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
  let density = 0.5;

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
      // The magnitude-domain kick, not the whitened bass flux: same evidence the
      // beat tracker now folds, and the same reason it is better here — it is
      // scaled to the track rather than to whatever the loudest moment of it was.
      kick = envelope(kick, clamp((frame.features.kick || 0) * 1.15, 0, 1), dt, 0.006, 0.16);
      bassPump = envelope(
        bassPump,
        clamp((frame.bands[3] + frame.bands[8]) * 0.6, 0, 1),
        dt,
        0.03,
        0.24
      );
      density = approach(density, frame.style?.look?.density ?? 0.5, 1.2, dt);
    },
    draw(g, geom, pal, weight) {
      const cx = geom.cx;
      const cy = geom.cy;
      g.globalCompositeOperation = "lighter";

      // Kick flash, across the whole frame. This is the layer's whole reason to
      // exist, and a hit that only tints the middle sixth is a hit nobody sees.
      if (kick > 0.01) {
        const inner = geom.hole ? Math.min(geom.hw, geom.hh) * 0.8 : 0;
        const gr = g.createRadialGradient(
          cx,
          cy,
          inner,
          cx,
          cy,
          Math.max(inner + 1, geom.rMax * (0.7 + kick * 0.5))
        );
        gr.addColorStop(0, hsl(pal.low, pal.sat, 0.62, 0.8 * kick * weight * preset.glow));
        gr.addColorStop(0.5, hsl(pal.low + 15, pal.sat, 0.55, 0.28 * kick * weight * preset.glow));
        gr.addColorStop(1, hsl(pal.low, pal.sat, 0.5, 0));
        g.fillStyle = gr;
        g.fillRect(0, 0, geom.w, geom.h);
      }

      // Dot grid, pumping on the bass, over the whole canvas. Its pitch follows
      // the genre's density, so techno is a fine mesh and hip-hop is sparse.
      if (preset.layers >= 3) {
        // Pitched off the SHORT side, not the width: on a phone a grid sized by
        // the width is forty rows deep and becomes the loudest thing on screen,
        // and on a beamer it is a mesh fine enough to shimmer.
        const step = Math.max(26, Math.min(96, geom.rMin * 2 / lerp(8, 16, density)));
        const r = 1 + bassPump * 2.2;
        g.fillStyle = hsl(pal.mid, pal.sat * 0.6, 0.6, (0.09 + bassPump * 0.22) * weight);
        // Skip the dots the artwork sits on: they are drawn additively under an
        // opaque cover, so they are a third of this loop's work for nothing.
        const hx = geom.hole ? geom.hw : 0;
        const hy = geom.hole ? geom.hh : 0;
        for (let x = step / 2; x < geom.w; x += step) {
          const overX = hx && Math.abs(x - geom.cx) < hx;
          for (let y = step / 2; y < geom.h; y += step) {
            if (overX && Math.abs(y - geom.cy) < hy) continue;
            g.beginPath();
            g.arc(x, y, r, 0, TAU);
            g.fill();
          }
        }
      }

      // The polygon: one vertex per beat of the bar, sitting in the frame's own
      // polar mapping so it is an ellipse on a wide screen and a ring around
      // the artwork in the player.
      const n = 3 + (preset.layers >= 3 ? 1 : 0) + 2;
      const reach = 0.52 + bassPump * 0.22;
      g.strokeStyle = hsl(pal.high, pal.sat, 0.68, (0.34 + snap * 0.55) * weight);
      g.lineWidth = 1.5 + snap * 2.5;
      g.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = rot + (i / n) * TAU;
        // Not the frame's full shape (see geometry.place): a polygon that traces
        // the screen is a border, not a polygon.
        const p = geom.place(a, reach, 0.45);
        i === 0 ? g.moveTo(p[0], p[1]) : g.lineTo(p[0], p[1]);
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
  for (let i = 0; i < MAX; i++)
    waves.push({ age: -1, life: 0.42, p: 0, tint: "soft", seed: 0 });
  const SPARKS = Math.max(10, Math.floor(preset.particles * 0.5));
  const sp = new Float32Array(SPARKS * 4); // x, y, life, seed
  let sparkNext = 0;
  let strobe = 0;
  let saw = 0;
  let style = "";
  let chaos = 0.3;
  let lastKick = 0;
  let lastWaveAt = -1;
  let clock = 0;

  return {
    update(frame, dt) {
      const k = frame.style?.kick;
      style = frame.style?.dominant || "";
      chaos = approach(chaos, frame.style?.look?.chaos ?? 0.3, 1.2, dt);
      const beat = frame.beat;
      // Three sources, in descending order of how much they know. The style
      // classifier's kick carries its CHARACTER (soft vs industrial) and drives
      // the tint. A locked beat grid gives a hit on every predicted beat even if
      // the classifier is quiet. The raw detector covers the third case — a
      // track with neither a classified kick nor a lock yet, which used to mean
      // this entire layer sat still for the first bars of a rap track.
      const det = frame.features.kick || 0;
      const detHit = det > 0.42 && det > lastKick + 0.15;
      lastKick = det;
      clock += dt;
      // All three can fire on the same kick, and three shockwaves a beat apart
      // by two frames is one thick ring, not three hits. A tenth of a second
      // refuses nothing musical — 300 BPM sixteenths are 50 ms — and refuses
      // every double-report.
      if ((k?.hit || (beat.beat && beat.locked) || detHit) && clock - lastWaveAt > 0.1) {
        lastWaveAt = clock;
        let slot = waves.find((x) => x.age < 0) || waves.reduce((a, b) => (a.age > b.age ? a : b));
        slot.age = 0;
        // A shockwave should be finished before the next one starts. At 250 BPM
        // a fixed half-second life means two and a half shells on screen at
        // once, adding up to a white ring — the layer looking BRIGHTER the
        // faster the track is, which is exactly backwards from how it reads.
        const room = beat.locked ? beat.period * 0.85 : 0.5;
        slot.life = Math.min(0.32 + (k?.decay || 0.1), Math.max(0.16, room));
        slot.p = k?.hit
          ? clamp(0.45 + (k?.strength || 0.4) * 0.8, 0, 1.4)
          : clamp(0.4 + det * 0.8, 0, 1.4);
        slot.tint = k?.hit ? k.type || "hard" : "hard";
        slot.seed = Math.random() * TAU;
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
    draw(g, geom, pal, weight) {
      g.globalCompositeOperation = "lighter";

      if (strobe > 0.004) {
        g.fillStyle = hsl(pal.high, 0.15, 0.9, strobe * 0.3 * weight);
        g.fillRect(0, 0, geom.w, geom.h);
      }

      // Saw streaks — the "zaag" read: a gliding, harmonically dense lead gets
      // diagonal strokes that lean the way the energy is moving. They belong to
      // the styles whose LEAD is a saw — zaag is literally the word for it —
      // not to every fast genre: frenchcore and uptempo are about the kick, and
      // they already have the shockwaves and the strobe to say so.
      if (saw > 0.02 && (style === "zaag" || style === "hardtekk")) {
        const n = 3 + Math.floor(saw * preset.layers);
        g.lineCap = "round";
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          // Spread across the whole width, anchored low, and never longer than
          // a third of the height: a stroke that crosses the whole canvas stops
          // reading as a burst of energy and starts reading as a scratch.
          const x = geom.w * (0.06 + t * 0.88);
          const len = geom.h * (0.12 + saw * 0.26);
          const y0 = geom.h * (0.62 + ((i * 0.37) % 0.3));
          const lean = len * 0.55;
          const gr = g.createLinearGradient(x - lean, y0, x + lean, y0 - len);
          const hue = pal.high + i * 7;
          gr.addColorStop(0, hsl(hue, pal.sat, 0.6, 0));
          gr.addColorStop(0.45, hsl(hue, pal.sat, 0.7, saw * 0.5 * weight * preset.glow));
          gr.addColorStop(1, hsl(hue + 12, pal.sat, 0.75, 0));
          g.strokeStyle = gr;
          g.lineWidth = Math.max(1.5, geom.h * 0.006 * (0.5 + saw));
          g.beginPath();
          g.moveTo(x - lean, y0);
          g.lineTo(x + lean, y0 - len);
          g.stroke();
        }
      }

      // The shockwaves. Elliptical, so they leave through the corners of a wide
      // screen instead of expiring in a circle in the middle of it, and born at
      // the artwork's rim where there is artwork — which turns the cover into
      // the thing the hit comes out of. How jagged they are is the genre's own
      // `chaos`: hardstyle is a clean ring, speedcore is a torn one.
      // Jagged, not shredded: past about half the ring stops reading as a ring
      // and the trail interferes with itself into a flower.
      const jag = clamp((chaos - 0.35) * 0.9, 0, 0.5);
      // The punch. A shell says "something is travelling"; this says "something
      // just hit", and they are not the same statement. It lives a fifth as
      // long as the shell and it is what makes the kick land — a layer whose
      // whole subject is the kick and which only ever draws an expanding
      // outline is a layer that never hits anything.
      for (const wv of waves) {
        if (wv.age < 0) continue;
        const core = 1 - wv.age / (wv.life * 0.28);
        if (core <= 0.02) continue;
        const tint0 = KICK_TINT[wv.tint] || KICK_TINT.hard;
        const r0 = geom.hole ? Math.min(geom.hw, geom.hh) * 0.85 : 0;
        const cr = r0 + geom.rMin * (0.45 + wv.p * 0.5) * (0.55 + (1 - core) * 1.2);
        const cg = g.createRadialGradient(geom.cx, geom.cy, r0, geom.cx, geom.cy, cr);
        const ca = core * core * wv.p * 0.72 * weight * preset.glow;
        cg.addColorStop(0, hsl(pal.low + tint0.dh + 10, clamp(pal.sat + tint0.ds, 0, 1), 0.78, ca));
        cg.addColorStop(1, hsl(pal.low + tint0.dh, pal.sat, 0.55, 0));
        g.fillStyle = cg;
        g.beginPath();
        g.arc(geom.cx, geom.cy, cr, 0, TAU);
        g.fill();
      }

      for (const wv of waves) {
        if (wv.age < 0) continue;
        const t = wv.age / wv.life;
        const tint = KICK_TINT[wv.tint] || KICK_TINT.hard;
        // A gentler fade than the square: a shell that is meant to CROSS the
        // frame has to still be visible when it gets there, and (1-t)² put all
        // of it in the first third of the trip — which is how a shockwave ends
        // up looking like a blob parked in the middle.
        const a = Math.pow(1 - t, 1.3) * wv.p * 0.34 * weight * preset.glow;
        if (a < 0.004) continue;
        g.strokeStyle = hsl(
          pal.low + tint.dh,
          clamp(pal.sat + tint.ds, 0, 1),
          clamp(0.62 + tint.dl, 0, 0.98),
          a
        );
        // Wide and soft rather than thin and bright, for the reason spelled out
        // in pulse.js: a thin ring crossing the frame in a third of a second
        // leaves its motion trail as a set of concentric circles, and a set of
        // concentric circles is a tunnel. A stroke wider than the per-frame
        // step merges its own trail into one shell travelling outwards — and a
        // second, wider, dimmer pass gives that shell a soft edge, so where two
        // frames of it overlap there is a gradient rather than a step.
        const lw = Math.max(5, geom.rMin * 0.15 * (1 - t * 0.5) * (0.5 + wv.p * 0.7));
        const radial = 0.04 + t * 0.9;
        g.globalAlpha = 0.4;
        g.lineWidth = lw * 2.1;
        ringPath(g, geom, radial, jag, wv.seed);
        g.stroke();
        g.globalAlpha = 1;
        g.lineWidth = lw;
        ringPath(g, geom, radial, jag, wv.seed);
        g.stroke();
      }

      for (let k = 0; k < SPARKS; k++) {
        const i = k * 4;
        const life = sp[i + 2];
        if (life <= 0) continue;
        g.fillStyle = hsl(pal.high + sp[i + 3] * 60, 0.9, 0.85, life * 0.7 * weight);
        const r = Math.max(0.8, (geom.h / 500) * (1 + sp[i + 3]));
        g.fillRect(sp[i] * geom.w, sp[i + 1] * geom.h, r, r * 5);
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
          s.x = 0.1 + Math.random() * 0.8;
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
    draw(g, geom, pal, weight) {
      const w = geom.w;
      const h = geom.h;
      g.globalCompositeOperation = "lighter";
      // The wall's horizon sits below the artwork when there is artwork, and in
      // the middle otherwise — a band of guitars drawn behind an album cover is
      // a band of guitars nobody sees.
      const mid = geom.hole ? Math.min(h * 0.86, geom.cy + geom.hh + h * 0.08) : h * 0.55;
      const span = geom.hole ? Math.min(h * 0.28, h - mid) : h * 0.4;
      g.beginPath();
      for (let i = 0; i < WALL; i++) {
        const x = (i / (WALL - 1)) * w;
        g.lineTo(x, mid - wall[i] * span);
        if (i === 0) g.moveTo(x, mid - wall[i] * span);
      }
      for (let i = WALL - 1; i >= 0; i--) {
        const x = (i / (WALL - 1)) * w;
        g.lineTo(x, mid + wall[i] * span * 0.6);
      }
      g.closePath();
      const gr = g.createLinearGradient(0, mid - span, 0, mid + span);
      gr.addColorStop(0, hsl(pal.high, pal.sat, 0.6, 0.06 * weight));
      gr.addColorStop(0.5, hsl(pal.mid, pal.sat, 0.55, 0.26 * weight * preset.glow));
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
        const len = span * 1.5 * (0.6 + s.p);
        g.beginPath();
        g.moveTo(x - (len / 2) * s.dir, mid - len / 2);
        g.lineTo(x + (len / 2) * s.dir, mid + len / 2);
        g.stroke();
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}

// --- layer: warp ------------------------------------------------------------
// Speed, as such. One volley of streaks per beat, rushing from the middle (or
// from the artwork's rim) out through the corners. This is what separates
// psytrance and uptempo from techno inside the same `hard`/`groove` archetype:
// they are not harder, they are FASTER, and nothing in the first five layers
// says so.
function warpLayer(preset) {
  const MAX = Math.max(14, Math.floor(preset.particles * 0.6));
  const st = new Float32Array(MAX * 4); // angle, progress, speed, power
  let next = 0;
  let motion = 0.5;
  let sinceVolley = 0;

  function fire(n, power) {
    for (let k = 0; k < n; k++) {
      const i = (next = (next + 1) % MAX) * 4;
      st[i] = Math.random() * TAU;
      st[i + 1] = 0.02 + Math.random() * 0.1;
      st[i + 2] = 0.7 + Math.random() * 1.1;
      st[i + 3] = power * (0.6 + Math.random() * 0.6);
    }
  }

  return {
    update(frame, dt) {
      motion = approach(motion, frame.style?.look?.motion ?? 0.5, 1.2, dt);
      const beat = frame.beat;
      sinceVolley += dt;
      const dense = 2 + Math.round(motion * preset.layers * 1.6);
      if (beat.beat) {
        fire(dense, 0.6 + (frame.features.kick || 0) * 0.5);
        sinceVolley = 0;
      } else if (!beat.locked && beat.onset > 0.5 && sinceVolley > 0.12) {
        fire(Math.max(1, dense >> 1), beat.onset);
        sinceVolley = 0;
      }
      const v = dt * lerp(0.7, 2.6, motion);
      for (let k = 0; k < MAX; k++) {
        const i = k * 4;
        if (st[i + 3] <= 0) continue;
        st[i + 1] += v * st[i + 2];
        if (st[i + 1] > 1.25) st[i + 3] = 0;
      }
    },
    draw(g, geom, pal, weight) {
      g.globalCompositeOperation = "lighter";
      g.lineCap = "round";
      const lw = Math.max(1, geom.rMin * 0.006);
      for (let k = 0; k < MAX; k++) {
        const i = k * 4;
        const power = st[i + 3];
        if (power <= 0) continue;
        const a = st[i];
        const r = st[i + 1];
        // Longer as it goes, like a light trail: the tail stays where the head
        // was a moment ago, which is what makes the streak read as speed rather
        // than as a spoke. It also never starts at the very middle — a dozen
        // streaks all touching one point is a starburst, and a starburst is a
        // decoration rather than a thing the music did.
        const len = 0.09 + r * 0.22;
        const p0 = geom.place(a, Math.max(0.14, r - len));
        const x0 = p0[0];
        const y0 = p0[1];
        const p1 = geom.place(a, r);
        const fade = clamp(1 - Math.max(0, r - 0.85) / 0.4, 0, 1);
        const gr = g.createLinearGradient(x0, y0, p1[0], p1[1]);
        gr.addColorStop(0, hsl(pal.mid, pal.sat, 0.6, 0));
        gr.addColorStop(1, hsl(pal.high, pal.sat, 0.72, power * 0.5 * weight * fade * preset.glow));
        g.strokeStyle = gr;
        g.lineWidth = lw * (0.6 + power * 1.6);
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(p1[0], p1[1]);
        g.stroke();
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}

// --- layer: lattice ---------------------------------------------------------
// Chaos, as a structure being broken rather than as randomness: a grid that
// snaps taut on the beat and tears into offset slabs the more chaotic the genre
// is. Industrial, krach, dubstep, speedcore — the genres whose whole aesthetic
// is a machine coming apart.
function latticeLayer(preset, opts) {
  const SLABS = 6;
  const slabs = [];
  for (let i = 0; i < SLABS; i++) slabs.push({ age: -1, y: 0, hgt: 0, dx: 0 });
  let pulse = 0;
  let chaos = 0.3;
  let density = 0.5;
  let since = 0;

  return {
    update(frame, dt) {
      chaos = approach(chaos, frame.style?.look?.chaos ?? 0.3, 1.2, dt);
      density = approach(density, frame.style?.look?.density ?? 0.5, 1.2, dt);
      if (frame.beat.beat) pulse = 1;
      pulse = approach(pulse, 0, 0.16, dt);
      since += dt;
      // A tear is an EVENT, not a per-frame dice roll: they arrive on onsets,
      // at a rate the genre's chaos sets, and never faster than the eye can
      // separate them.
      const wants = chaos * (0.35 + frame.beat.onset * 1.4);
      if (!opts.reducedMotion && since > lerp(0.5, 0.09, chaos) && wants > 0.45) {
        since = 0;
        const s = slabs.find((x) => x.age < 0) || slabs[0];
        s.age = 0;
        s.y = Math.random();
        s.hgt = 0.008 + Math.random() * 0.05 * (0.4 + chaos);
        s.dx = (Math.random() - 0.5) * 0.14 * (0.3 + chaos);
      }
      for (const s of slabs) {
        if (s.age < 0) continue;
        s.age += dt;
        if (s.age > 0.14) s.age = -1;
      }
    },
    draw(g, geom, pal, weight) {
      const w = geom.w;
      const h = geom.h;
      g.globalCompositeOperation = "lighter";
      // The grid. Lines across the whole frame, spaced by the genre's density,
      // brightening on the beat.
      const cells = Math.round(lerp(6, 18, density));
      const a = (0.03 + pulse * 0.12) * weight;
      g.strokeStyle = hsl(pal.mid, pal.sat * 0.5, 0.72, a);
      g.lineWidth = Math.max(0.75, geom.rMin * 0.0035);
      g.beginPath();
      for (let i = 1; i < cells; i++) {
        const x = (i / cells) * w;
        g.moveTo(x, 0);
        g.lineTo(x, h);
      }
      const rows = Math.max(3, Math.round((cells * h) / Math.max(1, w)));
      for (let i = 1; i < rows; i++) {
        const y = (i / rows) * h;
        g.moveTo(0, y);
        g.lineTo(w, y);
      }
      g.stroke();

      // The tears: bright horizontal slabs, shifted sideways. Cheap, and it is
      // the single most legible way to draw "this is falling apart".
      for (const s of slabs) {
        if (s.age < 0) continue;
        const t = s.age / 0.14;
        const al = (1 - t) * 0.26 * weight * preset.glow;
        if (al < 0.004) continue;
        g.fillStyle = hsl(pal.high, pal.sat * 0.8, 0.8, al);
        g.fillRect(s.dx * w, s.y * h, w, Math.max(1, s.hgt * h));
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}

// --- layer: orbit -----------------------------------------------------------
// The melody, drawn as such: twelve arcs around the frame, one per pitch class,
// each lit by how strongly that pitch is sounding (features.js `chroma`). A
// chord is three arcs; a line moving through a scale walks around the frame.
// It is the only layer that draws PITCH, which is why trance, synthwave and
// strings have it and a drum track does not.
function orbitLayer(preset) {
  const N = 12;
  const lit = new Float32Array(N);
  let spin = 0;
  let melody = 0;

  return {
    update(frame, dt) {
      const c = frame.features.chroma;
      for (let i = 0; i < N; i++) {
        const v = c ? c[i] || 0 : 0;
        lit[i] = envelope(lit[i], v, dt, 0.05, 0.5);
      }
      melody = approach(melody, frame.features.melody || 0, 0.4, dt);
      const beat = frame.beat;
      const barLen = beat.locked ? beat.period * beat.beatsPerBar : 3;
      spin += (dt / (barLen * 12)) * TAU;
    },
    draw(g, geom, pal, weight) {
      g.globalCompositeOperation = "lighter";
      // Butt caps, not round: a seventeen-pixel round-capped arc hugging the
      // frame reads as a UI chrome pill, which is the one thing an animation
      // must never look like.
      g.lineCap = "butt";
      const step = TAU / N;
      const lw = Math.max(2, geom.rMin * 0.016);
      for (let i = 0; i < N; i++) {
        const v = lit[i];
        // Only the pitch classes that are actually sounding. The chroma is
        // normalised to the strongest, so the other nine sit at a tenth of it —
        // and twelve arcs at a tenth trace a polygon around the frame, which
        // says nothing about the music and looks like a wireframe.
        if (v < 0.22) continue;
        const a0 = spin + i * step + step * 0.12;
        const a1 = a0 + step * 0.76;
        // Each arc sits at the radius ITS OWN pitch class earns, so a chord is
        // a ragged ring of three arcs pushed out at different distances. At a
        // fixed radius they join up into a rounded rectangle tracing the frame,
        // which reads as a HUD border rather than as music — the one thing an
        // animation must never look like.
        const rad = 0.4 + v * 0.45;
        const steps = 7;
        g.beginPath();
        for (let k = 0; k <= steps; k++) {
          const a = a0 + ((a1 - a0) * k) / steps;
          const p = geom.place(a, rad, 0.6);
          k === 0 ? g.moveTo(p[0], p[1]) : g.lineTo(p[0], p[1]);
        }
        const hue = pal.low + ((pal.high - pal.low) * i) / (N - 1);
        g.strokeStyle = hsl(hue, pal.sat, 0.72, v * (0.16 + melody * 0.34) * weight * preset.glow);
        g.lineWidth = lw * (0.4 + v);
        g.stroke();
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}

// --- layer: haze ------------------------------------------------------------
// Calm. Slow blooms drifting over the whole frame, for the music that has no
// events to draw — ambient, lofi, downtempo, a long intro. Without it the
// quiet genres fell back on the same shockwaves as everything else, just
// dimmer, which is not what quiet looks like.
function hazeLayer(preset) {
  const N = 4;
  const blob = [];
  for (let i = 0; i < N; i++)
    blob.push({ a: Math.random() * TAU, r: 0.3 + Math.random() * 0.6, v: 0.04 + Math.random() * 0.07, k: Math.random() });
  let level = 0;

  return {
    update(frame, dt) {
      level = approach(level, frame.features.level || 0, 0.9, dt);
      for (const b of blob) {
        b.a += dt * b.v * (b.k < 0.5 ? 1 : -1);
        b.r += dt * 0.05 * Math.sin(b.a * 1.7 + b.k * 6);
        if (b.r < 0.18) b.r = 0.18;
        if (b.r > 1.05) b.r = 1.05;
      }
    },
    draw(g, geom, pal, weight) {
      g.globalCompositeOperation = "lighter";
      for (let i = 0; i < N; i++) {
        const b = blob[i];
        const p = geom.place(b.a, b.r);
        const rad = geom.rMin * (0.35 + b.k * 0.4) * (0.65 + level * 0.6);
        const hue = pal.low + (pal.high - pal.low) * b.k;
        const gr = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], Math.max(1, rad));
        gr.addColorStop(0, hsl(hue, pal.sat * 0.8, 0.6, (0.075 + level * 0.12) * weight * preset.glow));
        gr.addColorStop(1, hsl(hue, pal.sat * 0.7, 0.45, 0));
        g.fillStyle = gr;
        g.beginPath();
        g.arc(p[0], p[1], rad, 0, TAU);
        g.fill();
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}

// --- the registry -----------------------------------------------------------
// Order is BACK TO FRONT: the atmospheric layers first, the sharp event-driven
// ones on top, so a kick is never buried under a ribbon.
//
// `want` is how much of this layer the music is asking for, and it is the whole
// mechanism behind "the animation is adapted to the genre". The first five read
// the archetype mix, which is a distribution; the other four read the `look`
// vector, which is not — two genres can both be fast AND chaotic, and both
// layers should be on.
const LAYERS = [
  { id: "haze", gamma: 1.1, make: hazeLayer, want: (c) => c.look.smooth * (1 - c.look.motion) * 1.1 },
  { id: "bow", gamma: 1.35, make: bowLayer, want: (c) => c.arche.sustain },
  { id: "orbit", gamma: 1.1, make: orbitLayer, want: (c) => c.look.melodic * (0.3 + 0.7 * c.tonal) },
  { id: "rock", gamma: 1.35, make: rockLayer, want: (c) => c.arche.rock },
  { id: "groove", gamma: 1.35, make: grooveLayer, want: (c) => c.arche.groove },
  { id: "warp", gamma: 1.1, make: warpLayer, want: (c) => c.look.motion * c.look.motion * (1 - c.look.smooth * 0.8) },
  { id: "lattice", gamma: 1.1, make: latticeLayer, want: (c) => c.look.chaos * (1 - c.look.smooth * 0.7) * 1.1 },
  { id: "voice", gamma: 1.35, make: voiceLayer, want: (c) => c.arche.voice },
  { id: "hard", gamma: 1.35, make: hardLayer, want: (c) => c.arche.hard },
];

// What the classifier says before it has said anything: a plain machine groove,
// which is the least wrong guess for a player pointed at this catalogue.
const DEFAULT_ARCHE = { sustain: 0, voice: 0, groove: 0.35, hard: 0, rock: 0 };
const DEFAULT_LOOK = {
  motion: 0.56, density: 0.58, punch: 0.58, smooth: 0.5, warm: 0.5, melodic: 0.45, chaos: 0.16,
};

export function createSmartScene(opts = {}) {
  const preset = opts.preset;
  const o = { intensity: opts.intensity ?? 0.7, reducedMotion: !!opts.reducedMotion };
  const layers = LAYERS.map((L, i) => ({ def: L, i, impl: L.make(preset, o), weight: 0 }));
  // Smoothed weights: the classifier is already smoothed, but its output still
  // steps whenever the family ranking shifts, and a step in a layer's alpha is
  // visible as a flicker on a dark scene.
  layers.find((l) => l.def.id === "groove").weight = 0.4;
  // How many layers may be drawn at once. Every one of them is cheap, but
  // nine at once is soup as well as work: the strongest few are the ones
  // saying something about this track.
  const budget = Math.max(3, preset.layers + 1);
  const order = [];

  let level = 0;
  // The subgenre's own character (style.js LOOK_KEYS) and how loud this moment
  // is against the track's own loud reference (features.js `dynamics`). The
  // layers say WHAT is drawn; these two say how hard, how fast and how smeared.
  let density = DEFAULT_LOOK.density;
  let smooth = DEFAULT_LOOK.smooth;
  let dyn = 1;
  const ctx = { arche: DEFAULT_ARCHE, look: DEFAULT_LOOK, tonal: 0 };

  function resize() {}

  function update(frame, dt, geom) {
    ctx.arche = frame.style?.archetypes || DEFAULT_ARCHE;
    ctx.look = frame.style?.look || DEFAULT_LOOK;
    ctx.tonal = frame.features?.tonal ?? 0;
    for (const l of layers) {
      const target = clamp(l.def.want(ctx), 0, 1.2);
      l.weight = approach(l.weight, target, 1.4, dt);
    }
    density = approach(density, ctx.look.density, 1.2, dt);
    smooth = approach(smooth, ctx.look.smooth, 1.2, dt);
    // Already smoothed upstream, and asymmetric there: this only keeps a frame
    // of jitter out of a full-screen alpha.
    dyn = approach(dyn, frame.features?.dynamics ?? 1, 0.12, dt);
    level = approach(level, frame.features?.level || 0, 0.14, dt);

    // Pick the budget's worth of strongest layers, then keep them in the
    // registry's back-to-front order for drawing.
    order.length = 0;
    for (const l of layers) if (l.weight > 0.035) order.push(l);
    if (order.length > budget) {
      order.sort((a, b) => b.weight - a.weight);
      order.length = budget;
      order.sort((a, b) => a.i - b.i);
    }
    for (const l of order) l.impl.update(frame, dt, geom);
  }

  function draw(g, w, h, pal, geom) {
    // Trail wash rather than a clear: motion trails for free, and it means a
    // layer fading out leaves the scene gracefully instead of vanishing.
    g.globalCompositeOperation = "source-over";
    // A smeary genre keeps more of the previous frame; a snappy one clears
    // harder. The trail wash IS the clear, so this is the one knob that decides
    // whether ambient reads as a long exposure and speedcore as a strobe.
    // ...and a quiet passage washes harder still. Without this, anything that
    // stops MOVING when the drums drop out keeps being drawn in the same place
    // with `lighter` compositing and saturates to white — a breakdown ended up
    // brighter than the drop, which is measurably what it used to do.
    // The wash is also the CLEAR, and it has a FLOOR — a big one. What it has
    // to clear now covers the whole frame rather than a disc in the middle of
    // it, and a canvas is eight bits per channel: a trail that takes twenty
    // frames to fade leaves twenty quantisation steps, and twenty steps of a
    // ring expanding across a dark frame is a set of concentric circles you can
    // count. Three or four frames of trail merge into one soft shell; a dozen
    // draw a tunnel. This was measured, not guessed.
    const trail = preset.trail * lerp(2.2, 0.9, smooth) * lerp(1.6, 1, dyn) +
      lerp(0.34, 0.1, smooth);
    g.fillStyle = hsl(pal.hue, 0.45, 0.045, clamp(trail, 0.04, 0.95));
    g.fillRect(0, 0, w, h);

    // A floor of ambient colour so the scene is never black between events,
    // reaching the corners of whatever frame this is — dimmed with the music,
    // so a breakdown is genuinely darker rather than a full-brightness scene
    // with less happening in it.
    const inner = geom.hole ? Math.min(geom.hw, geom.hh) * 0.85 : 0;
    const bg = g.createRadialGradient(
      geom.cx,
      geom.cy,
      inner,
      geom.cx,
      geom.cy,
      Math.max(inner + 1, geom.rMax)
    );
    bg.addColorStop(
      0,
      hsl(pal.hue, pal.sat * 0.7, 0.2, (0.08 + level * 0.11) * (0.35 + 0.65 * dyn))
    );
    bg.addColorStop(1, hsl(pal.hue + 30, pal.sat * 0.5, 0.06, 0));
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    for (const l of order) {
      // Weight^gamma rather than the weight itself: the archetype mix is a
      // distribution, and drawing it linearly means the also-rans are nearly as
      // present as the winner. The exponent keeps the secondary layers as
      // texture under the dominant one instead of competing with it. The
      // look-driven layers use a gentler one — they are not competing for a
      // share of anything, they are saying what this genre is like.
      // `density` is the subgenre saying how much should be on screen at once,
      // and `dyn` is the music saying how much of it is earned right now. A
      // quiet passage keeps the scene — it just stops shouting.
      const wgt =
        Math.pow(l.weight, l.def.gamma) *
        (0.6 + o.intensity * 0.95) *
        lerp(0.72, 1.18, density) *
        (0.1 + 0.9 * dyn);
      l.impl.draw(g, geom, pal, Math.min(1, wgt));
    }
  }

  // Intensity and the reduced-motion flag are read live from `o`, so the
  // settings preview can move them without the scene being rebuilt under it.
  function setOptions(next) {
    if (next.intensity != null) o.intensity = next.intensity;
    if (next.reducedMotion != null) o.reducedMotion = !!next.reducedMotion;
  }

  return { resize, update, draw, setOptions, layers };
}
