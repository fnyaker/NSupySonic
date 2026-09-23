// The render bench, browser side. Driven by run.mjs through Playwright.
//
// It builds the REAL pipeline — the renderer, the GL scene, the palette, the
// geometry — on a real WebGL2 context (SwiftShader in CI-like headless runs,
// the GPU in a desktop browser), drives it with a synthetic arrangement on a
// simulated clock, and photographs named instants of it. Every number it
// reports is measured on the pixels that came out, which is the only honest
// place to measure a shader: the GLSL can say anything it likes, the picture
// is what a person sees.

import { createRenderer } from "../../src/lib/viz/gl/renderer.js";
import { createGLScene } from "../../src/lib/viz/scenes/gl.js";
import { createGeometry } from "../../src/lib/viz/geometry.js";
import { createPalette } from "../../src/lib/viz/palette.js";
import { tierPreset } from "../../src/lib/viz/quality.js";
import { loadWorld } from "../../src/lib/viz/worlds/index.js";
import { createTrack } from "./music.mjs";

const ANALYSIS_HZ = 94;
const METRIC_W = 192;

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

// Luminance of every pixel of a downsampled copy, in display units 0..1.
function sample(canvas) {
  const mw = METRIC_W;
  const mh = Math.max(1, Math.round((METRIC_W * canvas.height) / canvas.width));
  const c = document.createElement("canvas");
  c.width = mw;
  c.height = mh;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#000";
  g.fillRect(0, 0, mw, mh);
  g.drawImage(canvas, 0, 0, mw, mh);
  const d = g.getImageData(0, 0, mw, mh).data;
  const lum = new Float32Array(mw * mh);
  const rgb = new Float32Array(mw * mh * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const r = d[i] / 255;
    const gg = d[i + 1] / 255;
    const b = d[i + 2] / 255;
    lum[j] = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    rgb[j * 3] = r;
    rgb[j * 3 + 1] = gg;
    rgb[j * 3 + 2] = b;
  }
  return { lum, rgb, mw, mh };
}

function metrics(s, holeBox, W, H) {
  const { lum, mw, mh } = s;
  let sum = 0;
  let clip = 0;
  let grad = 0;
  const hist = new Float32Array(64);
  const sorted = Array.from(lum).sort((a, b) => a - b);
  for (let y = 0; y < mh; y++)
    for (let x = 0; x < mw; x++) {
      const v = lum[y * mw + x];
      sum += v;
      if (v > 0.97) clip++;
      if (x + 1 < mw) grad += Math.abs(v - lum[y * mw + x + 1]);
      if (y + 1 < mh) grad += Math.abs(v - lum[(y + 1) * mw + x]);
      const cx = Math.min(7, Math.floor((x / mw) * 8));
      const cy = Math.min(7, Math.floor((y / mh) * 8));
      hist[cy * 8 + cx] += v;
    }
  const n = mw * mh;
  // The four borders: the outer 8% of each side. "Does it fill the frame" is
  // "is there light in every one of them".
  const band = (x0, y0, x1, y1) => {
    let a = 0;
    let k = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        a += lum[y * mw + x];
        k++;
      }
    return k ? a / k : 0;
  };
  const bx = Math.max(1, Math.round(mw * 0.08));
  const by = Math.max(1, Math.round(mh * 0.08));
  const edges = {
    left: band(0, 0, bx, mh),
    right: band(mw - bx, 0, mw, mh),
    top: band(0, 0, mw, by),
    bottom: band(0, mh - by, mw, mh),
  };
  let holeShare = 0;
  if (holeBox) {
    const x0 = Math.floor((holeBox.x / W) * mw);
    const x1 = Math.ceil(((holeBox.x + holeBox.w) / W) * mw);
    const y0 = Math.floor((holeBox.y / H) * mh);
    const y1 = Math.ceil(((holeBox.y + holeBox.h) / H) * mh);
    let inside = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) inside += lum[y * mw + x];
    holeShare = sum > 0 ? inside / sum : 0;
  }
  const tot = hist.reduce((a, b) => a + b, 0) || 1;
  for (let i = 0; i < 64; i++) hist[i] /= tot;
  return {
    mean: sum / n,
    median: sorted[n >> 1],
    p99: sorted[Math.floor(n * 0.99)],
    clipped: clip / n,
    detail: grad / n,
    edges,
    holeShare,
    hist: Array.from(hist),
  };
}

function diff(a, b) {
  let s = 0;
  for (let i = 0; i < a.lum.length; i++) s += Math.abs(a.lum[i] - b.lum[i]);
  return s / a.lum.length;
}

function label(g, text, x, y) {
  g.font = "600 13px ui-sans-serif, system-ui, sans-serif";
  g.textBaseline = "top";
  const w = g.measureText(text).width + 12;
  g.fillStyle = "rgba(0,0,0,0.6)";
  g.fillRect(x + 6, y + 6, w, 20);
  g.fillStyle = "#fff";
  g.fillText(text, x + 12, y + 9);
}

/**
 * Run one world through the track and photograph it.
 *
 * opts: { world, genre, bpm, w, h, hole: {x,y,w,h}|null, tier, shots: [names],
 *         palette, fps, warm, loud, cols }
 */
async function run(opts) {
  const {
    world,
    genre = "techno",
    bpm = 128,
    w = 640,
    h = 360,
    hole = null,
    tier = "high",
    shots = ["breakdown", "build", "drop", "dropOff"],
    palette = "neon",
    fps = 30,
    warm = 1.6,
    loud = 1,
    cols = 2,
    motionGap = 1 / 30,
  } = opts;
  await loadWorld(world);
  const canvas = document.createElement("canvas");
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  document.body.appendChild(canvas);
  const errors = [];
  const origError = console.error;
  console.error = (...a) => {
    errors.push(a.join(" "));
    origError(...a);
  };
  const renderer = createRenderer(canvas);
  if (!renderer) throw new Error("no WebGL2");
  let simT = 0;
  const preset = { ...tierPreset(tier), tier };
  const scene = createGLScene({
    preset,
    fixed: world,
    intensity: 0.8,
    now: () => simT,
    fps: 60,
    flash: "full",
  });
  scene.attach(renderer);
  const geometry = createGeometry();
  geometry.set(w, h, hole);
  scene.resize(w, h, preset, geometry.out, 1);
  const pal = createPalette(palette);
  const track = createTrack({ bpm, genre, loud });
  const times = shots.map((name) => [name, track.moments[name]]).sort((a, b) => a[1] - b[1]);
  const dt = 1 / ANALYSIS_HZ;
  let t = 0;
  let nextDraw = 0;
  const frames = [];

  // Let the world's module resolve and its program link before the clock runs.
  {
    const f = track.frameAt(0);
    pal.update(f, dt);
    scene.update(f, dt, geometry.out);
    for (let i = 0; i < 50 && scene.world !== world; i++) {
      await tick();
      scene.draw(null, w, h, pal.out, geometry.out);
    }
    for (let i = 0; i < 50 && scene.pendingWorld; i++) {
      await tick();
      scene.draw(null, w, h, pal.out, geometry.out);
    }
  }

  const drawAt = (at) => {
    simT = at;
    const t0 = performance.now();
    scene.draw(null, w, h, pal.out, geometry.out);
    return performance.now() - t0;
  };
  const advance = (until, drawFrom) => {
    while (t < until) {
      const f = track.frameAt(t);
      simT = t;
      pal.update(f, dt);
      scene.update(f, dt, geometry.out);
      t += dt;
      if (t >= drawFrom && t >= nextDraw && t < until) {
        drawAt(t);
        nextDraw = t + 1 / fps;
      }
    }
  };

  let cost = 0;
  let costN = 0;
  for (const [name, at] of times) {
    advance(at, at - warm);
    // Timed through gl.finish(), so the cost is the frame's and not merely the
    // time it took to queue it.
    const t0 = performance.now();
    drawAt(at);
    renderer.gl.finish();
    cost += performance.now() - t0;
    costN++;
    const a = sample(canvas);
    const shot = document.createElement("canvas");
    shot.width = w;
    shot.height = h;
    shot.getContext("2d").drawImage(canvas, 0, 0);
    // The motion measurement: the same scene a frame later.
    advance(at + motionGap, at);
    drawAt(at + motionGap);
    const b = sample(canvas);
    const m = metrics(a, hole, w, h);
    m.motion = diff(a, b);
    frames.push({ name, shot, m });
  }

  // The contact sheet.
  const rows = Math.ceil(frames.length / cols);
  const sheet = document.createElement("canvas");
  sheet.width = w * Math.min(cols, frames.length);
  sheet.height = h * rows;
  const sg = sheet.getContext("2d");
  frames.forEach((fr, i) => {
    const x = (i % cols) * w;
    const y = Math.floor(i / cols) * h;
    sg.drawImage(fr.shot, x, y);
    if (hole) {
      // Where the artwork sits in the player: drawn as a dim plate so the
      // composition around it can be judged.
      sg.fillStyle = "rgba(90,90,100,0.55)";
      sg.fillRect(x + hole.x, y + hole.y, hole.w, hole.h);
      sg.strokeStyle = "rgba(255,255,255,0.35)";
      sg.strokeRect(x + hole.x + 0.5, y + hole.y + 0.5, hole.w - 1, hole.h - 1);
    }
    label(sg, `${world} · ${fr.name}`, x, y);
  });

  console.error = origError;
  try {
    renderer.dispose();
    renderer.gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    /* ignore */
  }
  canvas.remove();
  return {
    world,
    sheet: sheet.toDataURL("image/png"),
    frames: frames.map((f) => ({ name: f.name, m: f.m })),
    errors,
    costMs: costN ? cost / costN : 0,
    hdr: true,
  };
}

window.bench = { run, ready: true };
