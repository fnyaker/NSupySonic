// The player's Web Audio graph: an analyser tap for the immersive visualizer
// AND an optional DSP chain (10-band EQ, bass enhancement, volume
// normalization, safety limiter). Streams are same-origin (/api/stream), so the
// element isn't CORS-tainted and the analyser can read its samples.
//
// createMediaElementSource can only run ONCE per element and re-routes its
// output through the AudioContext, so once wired an element's audio flows
// through the graph. That's why we wire LAZILY and only when something actually
// needs it — a visualizer view is open, OR the user enabled an effect. When
// nothing needs it we keep a PURE audio path: an AudioContext gets suspended
// while a tab is backgrounded, which would silently cut background playback, so
// the default (effects off, no visualizer) never touches Web Audio at all.

import { eqEnabled, eqBands, bassBoost, normalization } from "./stores.js";

let ctx = null;
let analyser = null;

// The DSP nodes, built once with the context. The chain is:
//   sources → inputNode → eq[0..9] → bassNode → compNode → makeupNode
//           → limiterNode → outputNode → (destination + analyser)
let inputNode = null;
let outputNode = null;
let eqFilters = [];
let bassNode = null;
let compNode = null; // normalization compressor
let makeupNode = null; // post-compressor make-up gain
let limiterNode = null; // brick-wall safety limiter (always on when wired)

// createMediaElementSource may only run ONCE per element, so track which
// elements are already wired. The player keeps two <audio> elements (for
// gapless quality switching); both feed the same graph, so effects + the
// visualizer keep working whichever one is currently playing.
const wiredEls = new WeakSet();

// Whichever <audio> element is currently active, and whether any visualizer
// view actually needs the analyser yet.
let currentEl = null;
let analyserWanted = false;

// Fixed graphic-EQ centre frequencies (Hz), low→high. 10 bands.
const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// Current effect settings, mirrored from the stores (see the subscriptions at
// the bottom of this file). Defaults are neutral / off.
const fx = { eq: false, bands: new Array(10).fill(0), bass: 0, norm: "off" };

// Normalization presets: a compressor that pulls loud material down, plus a
// make-up gain (dB) to bring the perceived level back up. The limiter after it
// catches any peaks the make-up gain would otherwise clip.
const NORM = {
  off: { thr: 0, ratio: 1, makeup: 0 },
  low: { thr: -18, ratio: 3, makeup: 3 },
  medium: { thr: -24, ratio: 6, makeup: 6 },
  high: { thr: -30, ratio: 12, makeup: 9 },
};

const dbToGain = (db) => Math.pow(10, db / 20);

function effectsOn() {
  return (
    (fx.norm && fx.norm !== "off") ||
    (fx.eq && fx.bands.some((g) => Math.abs(g) > 0.01)) ||
    fx.bass > 0.01
  );
}

// Build the shared graph once. Returns false if Web Audio is unavailable.
function ensureGraph() {
  if (ctx) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  try {
    ctx = new AC();
    inputNode = ctx.createGain();
    outputNode = ctx.createGain();

    eqFilters = EQ_FREQS.map((f) => {
      const b = ctx.createBiquadFilter();
      b.type = "peaking";
      b.frequency.value = f;
      b.Q.value = 1.1;
      b.gain.value = 0;
      return b;
    });

    bassNode = ctx.createBiquadFilter();
    bassNode.type = "lowshelf";
    bassNode.frequency.value = 120;
    bassNode.gain.value = 0;

    compNode = ctx.createDynamicsCompressor();
    compNode.threshold.value = 0;
    compNode.knee.value = 30;
    compNode.ratio.value = 1;
    compNode.attack.value = 0.01;
    compNode.release.value = 0.25;

    makeupNode = ctx.createGain();
    makeupNode.gain.value = 1;

    // Brick-wall limiter: high ratio, fast attack, threshold just below 0 dBFS.
    // Left on whenever the graph is wired so the bass lift / make-up gain can
    // never push the output into hard clipping ("le limiteur auto").
    limiterNode = ctx.createDynamicsCompressor();
    limiterNode.threshold.value = -1;
    limiterNode.knee.value = 0;
    limiterNode.ratio.value = 20;
    limiterNode.attack.value = 0.003;
    limiterNode.release.value = 0.1;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 512; // 256 bins — finer resolution for the log-spaced bars
    analyser.smoothingTimeConstant = 0.82;

    // Wire the fixed chain (sources attach to inputNode in wireAudio).
    let node = inputNode;
    for (const b of eqFilters) {
      node.connect(b);
      node = b;
    }
    node.connect(bassNode);
    node = bassNode;
    node.connect(compNode);
    node = compNode;
    node.connect(makeupNode);
    node = makeupNode;
    node.connect(limiterNode);
    node = limiterNode;
    node.connect(outputNode);
    outputNode.connect(ctx.destination);
    outputNode.connect(analyser);

    applyEffects();
    return true;
  } catch {
    ctx = null;
    return false;
  }
}

// Push the current fx settings onto the live nodes (ramped so changes don't
// click). Safe to call before the graph exists (it no-ops).
function applyEffects() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const bands = fx.eq ? fx.bands : new Array(10).fill(0);
  eqFilters.forEach((b, i) => {
    const g = Math.max(-12, Math.min(12, +bands[i] || 0));
    b.gain.setTargetAtTime(g, t, 0.02);
  });
  const bassDb = Math.max(0, Math.min(1, +fx.bass || 0)) * 12; // 0..+12 dB
  bassNode.gain.setTargetAtTime(bassDb, t, 0.02);
  const n = NORM[fx.norm] || NORM.off;
  compNode.threshold.setTargetAtTime(n.thr, t, 0.05);
  compNode.ratio.setTargetAtTime(n.ratio, t, 0.05);
  makeupNode.gain.setTargetAtTime(dbToGain(n.makeup), t, 0.05);
}

// Called by the store subscriptions whenever an effect setting changes. Applies
// the new params and, if effects just became active while a track is playing,
// wires the current element so they take effect immediately.
function onFxChange() {
  applyEffects();
  if (effectsOn() && currentEl) {
    wireAudio(currentEl);
    resumeAudio();
  }
}

// The player registers the active element here on every play / quality switch.
// We only wire it into the graph when the analyser or an effect actually needs
// it — otherwise the pure audio path is preserved (see the file header).
export function registerSource(el) {
  currentEl = el;
  if (el && (analyserWanted || effectsOn())) wireAudio(el);
}

// Called by a visualizer view when it mounts: from now on we need the analyser,
// so wire the current element (and future ones) and make sure the context runs.
export function requestAnalyser() {
  analyserWanted = true;
  if (currentEl) wireAudio(currentEl);
  resumeAudio();
}

export function wireAudio(el) {
  if (!el || wiredEls.has(el)) return;
  if (!ensureGraph()) return;
  try {
    // The chain (input→…→destination) is already connected, so the audible path
    // exists the moment the source joins inputNode — a failure here can't mute.
    const source = ctx.createMediaElementSource(el);
    source.connect(inputNode);
    wiredEls.add(el);
  } catch {
    /* keep any graph we already have */
  }
}

// AudioContexts start suspended until a user gesture; call this on play.
export function resumeAudio() {
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
}

export function getAnalyser() {
  return analyser;
}

// Drive the graph from the effect stores. Each subscribe fires immediately with
// the current (persisted) value, so `fx` is seeded on load; later changes ramp
// the live nodes and wire audio in if an effect was just switched on.
eqEnabled.subscribe((v) => {
  fx.eq = !!v;
  onFxChange();
});
eqBands.subscribe((v) => {
  fx.bands = Array.isArray(v) && v.length === 10 ? v.map((x) => +x || 0) : new Array(10).fill(0);
  onFxChange();
});
bassBoost.subscribe((v) => {
  fx.bass = Math.max(0, Math.min(1, +v || 0));
  onFxChange();
});
normalization.subscribe((v) => {
  fx.norm = NORM[v] ? v : "off";
  onFxChange();
});

// A self-contained bar renderer. Each consumer (desktop / mobile now-playing)
// calls createVisualizer() once and then draw(canvas) per animation frame, so
// the per-bar smoothing and auto-gain state stay isolated per view.
//
// Tuned for punch over a flat readout. Instead of one global auto-gain (which
// lets loud mids/highs crush the gain and bury the bass), the spectrum is split
// into THREE zones — bass / mid / high — each levelled by its own slow auto-gain
// envelope, so every band keeps its own life. The per-bar gain is interpolated
// across the zone centres so there's no visible seam where zones meet. A gamma
// curve keeps the quiet/loud contrast; a fast-attack / slow-release envelope
// keeps the bars lively instead of parked in the middle.
export function createVisualizer() {
  let freq = null;
  let smoothed = null;
  let agc = [0.15, 0.15, 0.15]; // bass, mid, high

  // Zone gains sit at the centre of each third of the strip; blend linearly
  // between them (and hold flat past the outer centres) for a seamless curve.
  const CENTRES = [1 / 6, 0.5, 5 / 6];
  function gainAt(gain, t) {
    if (t <= CENTRES[0]) return gain[0];
    if (t >= CENTRES[2]) return gain[2];
    const z = t < CENTRES[1] ? 0 : 1;
    const f = (t - CENTRES[z]) / (CENTRES[z + 1] - CENTRES[z]);
    return gain[z] * (1 - f) + gain[z + 1] * f;
  }

  return function draw(canvas) {
    const an = getAnalyser();
    if (!an || !canvas) return;
    const bins = an.frequencyBinCount;
    if (!freq || freq.length !== bins) freq = new Uint8Array(bins);
    an.getByteFrequencyData(freq);

    const cw = canvas.clientWidth,
      ch = canvas.clientHeight;
    if (!cw || !ch) return;
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const g = canvas.getContext("2d");
    g.clearRect(0, 0, cw, ch);

    const bars = Math.max(24, Math.min(72, Math.floor(cw / 8)));
    if (!smoothed || smoothed.length !== bars) smoothed = new Float32Array(bars);
    const minBin = 2; // skip DC/rumble (kept low so the bass still registers)
    const maxBin = Math.floor(bins * 0.78);

    // Log-spaced band energies (NO perceptual tilt — each zone is levelled by
    // its own AGC below, which is what keeps the low end on screen).
    const raw = new Float32Array(bars);
    const zoneSum = [0, 0, 0];
    const zoneN = [0, 0, 0];
    for (let i = 0; i < bars; i++) {
      const t = i / bars;
      const lo = Math.floor(minBin * Math.pow(maxBin / minBin, t));
      const hi = Math.max(
        lo + 1,
        Math.floor(minBin * Math.pow(maxBin / minBin, (i + 1) / bars))
      );
      let sum = 0,
        n = 0;
      for (let b = lo; b < hi && b < bins; b++) {
        sum += freq[b];
        n++;
      }
      const r = (n ? sum / n : 0) / 255;
      raw[i] = r;
      const z = t < 1 / 3 ? 0 : t < 2 / 3 ? 1 : 2;
      zoneSum[z] += r;
      zoneN[z] += 1;
    }

    // Each zone tracks its own slow level and derives its own gain.
    const gain = [0, 0, 0];
    for (let z = 0; z < 3; z++) {
      const mean = zoneN[z] ? zoneSum[z] / zoneN[z] : 0;
      agc[z] = agc[z] * 0.9 + mean * 0.1;
      gain[z] = 0.62 / Math.max(0.1, agc[z]);
    }

    const bw = cw / bars;
    for (let i = 0; i < bars; i++) {
      const t = i / bars;
      let v = Math.min(1, raw[i] * gainAt(gain, t));
      v = Math.pow(v, 1.7); // gamma -> quiet/loud contrast
      const prev = smoothed[i];
      v = v > prev ? v * 0.7 + prev * 0.3 : v * 0.35 + prev * 0.65; // fast up, slow down
      smoothed[i] = v;
      const bh = Math.max(2, v * ch);
      g.fillStyle = `rgba(255,255,255,${0.1 + 0.75 * v})`;
      g.fillRect(i * bw + bw * 0.18, (ch - bh) / 2, bw * 0.64, bh);
    }
  };
}

// Exposed for the settings UI: the fixed EQ centre frequencies, so the sliders
// can label themselves without hard-coding the list twice.
export { EQ_FREQS };
