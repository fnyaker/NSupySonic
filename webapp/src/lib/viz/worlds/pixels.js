// CHIPTUNE / 8-BIT / HYPERPOP / BREAKCORE / IDM / GLITCH / DJENT / GRIME —
// a screen made of cells.
//
// The common thread is that the sound is DIGITAL and proud of it: quantised,
// chopped, deliberately low-resolution, or coming apart. So the world is a
// coarse pixel grid whose cells are lit by the spectrum, with sprites walking
// across it and the whole picture tearing into offset rows on the glitches.
//
// It is the only world with no curve anywhere in it, which is what makes it
// unmistakable next to the others.
//
// skin.p — cell (how coarse; bigger is chunkier), glitch (how often it tears),
//          sprites (how much runs across it)

import { approach, clamp, envelope, hsl, lerp, rng } from "../util.js";

// `steps` is the grid's BIT DEPTH: quantise a cell's level to two values and
// the picture is a hard on/off matrix — which is what a chiptune's hardware
// could do and nothing more — while leaving it smooth gives IDM its gradients.
// `scroll` walks the whole grid sideways, cell by cell, so the pattern reads as
// a tracker playing rather than as a meter.
export function createPixelsWorld(preset, opts, skin = {}) {
  const p = skin.p || {};
  const rand = rng(8086);
  const STEPS = Math.max(0, Math.round(p.steps ?? 0));
  const SCROLL = p.scroll ?? 0;
  const SPRITES = Math.max(2, Math.round(6 * (p.sprites ?? 1)));
  const sprite = [];
  for (let i = 0; i < SPRITES; i++)
    sprite.push({ x: rand(), y: rand(), vx: (rand() < 0.5 ? -1 : 1) * (0.1 + rand() * 0.3), k: rand() });
  const TEARS = 5;
  const tear = [];
  for (let i = 0; i < TEARS; i++) tear.push({ age: -1, row: 0, rows: 1, dx: 0 });
  let tearNext = 0;
  let cells = null;
  let cols = 0;
  let rows = 0;
  let clock = 0;
  let lastTear = -1;
  let kick = 0;
  let march = 0;

  function fit(geom) {
    // Cell size off the SHORT side, so a phone gets a chunky grid and a beamer
    // a fine one rather than the same count stretched.
    const size = Math.max(10, (geom.rMin * 2) / lerp(26, 9, clamp(p.cell ?? 1, 0, 2) / 2));
    const c = Math.max(4, Math.ceil(geom.w / size));
    const r = Math.max(3, Math.ceil(geom.h / size));
    if (c !== cols || r !== rows) {
      cols = c;
      rows = r;
      cells = new Float32Array(c * r);
    }
    return size;
  }

  return {
    update(frame, dt, geom) {
      clock += dt;
      fit(geom);
      const b = frame.bands;
      const f = frame.features;
      kick = envelope(kick, clamp((f.kick || 0) * 1.2, 0, 1), dt, 0.006, 0.14);
      // Column = frequency, row = how far that band reaches up the screen. A
      // spectrum drawn as a lit grid rather than as bars, which is what a
      // tracker's level meters have always looked like.
      for (let x = 0; x < cols; x++) {
        const bi = Math.min(b.length - 1, Math.floor((x / cols) * b.length));
        const v = b[bi];
        for (let y = 0; y < rows; y++) {
          const height = 1 - y / rows;
          const want = v > height ? 1 : v > height - 0.12 ? 0.45 : 0;
          const i = y * cols + x;
          cells[i] = approach(cells[i], want, want > cells[i] ? 0.02 : 0.18, dt);
        }
      }
      if (SCROLL) march += dt * SCROLL * 4;
      for (const s of sprite) {
        s.x += s.vx * dt * (0.5 + kick);
        if (s.x > 1.1) s.x = -0.1;
        if (s.x < -0.1) s.x = 1.1;
      }
      // Tears: whole bands of rows shoved sideways, at the rate the genre's
      // glitchiness asks for, and only on an onset — a tear on a timer is
      // wallpaper.
      const g2 = p.glitch ?? 0.6;
      if (!opts.reducedMotion && frame.beat.onset > 0.4 && clock - lastTear > lerp(0.9, 0.08, g2)) {
        lastTear = clock;
        const t = tear[(tearNext = (tearNext + 1) % TEARS)];
        t.age = 0;
        t.row = (rand() * rows) | 0;
        t.rows = 1 + ((rand() * 3 * g2) | 0);
        t.dx = Math.round((rand() - 0.5) * 6 * g2);
      }
      for (const t of tear) {
        if (t.age < 0) continue;
        t.age += dt;
        if (t.age > 0.16) t.age = -1;
      }
    },

    draw(g, geom, pal, w) {
      if (!cells) return;
      const size = fit(geom);
      g.globalCompositeOperation = "lighter";
      const gap = Math.max(1, size * 0.14);
      const body = size - gap;

      for (let y = 0; y < rows; y++) {
        // A torn band is drawn shifted by whole CELLS, never by pixels: this
        // world has no sub-pixel anything in it.
        let shift = 0;
        for (const t of tear)
          if (t.age >= 0 && y >= t.row && y < t.row + t.rows) shift = t.dx;
        const walk = SCROLL ? Math.floor(march) : 0;
        for (let x = 0; x < cols; x++) {
          let v = cells[y * cols + x];
          if (v < 0.04) continue;
          // Snapped to the levels the skin allows. Two is a lamp that is on or
          // off; leaving STEPS at 0 keeps the continuous value.
          if (STEPS >= 2) v = Math.round(v * (STEPS - 1)) / (STEPS - 1);
          if (v < 0.04) continue;
          const hue = pal.low + ((pal.high - pal.low) * x) / (cols - 1 || 1);
          g.fillStyle = hsl(hue, pal.sat, lerp(0.45, 0.72, v), (0.02 + v * 0.11) * w.energy * preset.glow);
          g.fillRect((((x + shift + walk) % cols) + cols) % cols * size, y * size, body, body);
        }
      }

      // Sprites: a two-by-two block walking across, because a grid with nothing
      // moving on it is a chart.
      for (const s of sprite) {
        const x = Math.floor(s.x * cols) * size;
        const y = Math.floor(s.y * rows) * size;
        const hue = pal.high - s.k * 40;
        g.fillStyle = hsl(hue, pal.sat, 0.8, (0.07 + kick * 0.18) * w.energy * preset.glow);
        g.fillRect(x, y, body, body);
        g.fillRect(x + size, y, body, body);
        g.fillRect(x, y + size, body, body);
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}
