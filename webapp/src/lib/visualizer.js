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
//   sources → inputNode → normGain → eq[0..9] → bassNode
//           → bassComp → limiterNode → outputNode → (destination + analyser)
let inputNode = null;
let outputNode = null;
let normGain = null; // STATIC per-track normalization gain (set once on load)
let eqFilters = [];
let bassNode = null;
// Two-stage protection for the bass lift:
//  1) bassComp — a gentle, soft-knee compressor whose amount tracks the boost.
//     It does ~90% of the taming, smoothly and (near-)inaudibly, so the low end
//     stays controlled instead of ballooning.
//  2) limiterNode — a true brick-wall AFTER it, as a last-resort safety that
//     only nips the rare peak the compressor let through, so nothing clips.
let bassComp = null;
let limiterNode = null;

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
// Per-band gain range (dB).
const EQ_MIN_DB = -16;
const EQ_MAX_DB = 16;

// Current effect settings, mirrored from the stores (see the subscriptions at
// the bottom of this file). Defaults are neutral / off.
const fx = { eq: false, bands: new Array(10).fill(0), bass: 0, norm: "off" };

// The current track's raw Deezer GAIN, set by the player on every track load.
// IMPORTANT: Deezer's GAIN is the track's *loudness*, NOT the gain to apply.
// The ReplayGain adjustment that normalizes it to Deezer's reference is
// -(GAIN + 18.4) — the exact transform deemix uses for its ReplayGain tags.
// null when unknown → that track isn't normalized (we never invent a gain).
let trackGainDb = null;
const RG_REFERENCE = 18.4; // Deezer's reference loudness offset (dB)

// Volume normalization is STATIC: we take the track's ReplayGain adjustment and
// apply it as a fixed gain for the whole track — no compression, nothing moving
// during playback. The level shifts the overall target loudness; "off" disables
// it entirely.
//
// The offsets are deliberately hot: the ReplayGain adjustment turns LOUD tracks
// DOWN (their adjustment is negative) and quiet tracks up from an already-low
// peak, so raising the target reference does NOT push peaks toward clipping —
// and the brick-wall limiter at the end of the chain catches whatever transient
// slips through. That lets us land noticeably louder without saturation:
//   low ≈ -16 LUFS · medium ≈ -13 LUFS · high ≈ -10 LUFS (Spotify-loud).
const NORM_OFFSET = { off: 0, low: 2, medium: 5, high: 8 }; // dB
const GAIN_MIN_DB = -24;
const GAIN_MAX_DB = 12;

const dbToGain = (db) => Math.pow(10, db / 20);

// The linear gain to apply for the current track at the current level. 1.0
// (0 dB, no change) when normalization is off or the track's gain is unknown.
function normLinear() {
  if (fx.norm === "off" || trackGainDb == null) return 1;
  const replayGain = -(trackGainDb + RG_REFERENCE); // Deezer loudness → RG adjust
  const db = Math.max(
    GAIN_MIN_DB,
    Math.min(GAIN_MAX_DB, replayGain + (NORM_OFFSET[fx.norm] || 0))
  );
  return dbToGain(db);
}

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
    // latencyHint "playback": the context renders with larger internal buffers,
    // which is what makes the graph glitch-proof under CPU load (scrolling, the
    // visualizer canvas, GC). The default "interactive" hint uses the smallest
    // buffers and audibly underruns (sub-100ms dropouts) on busy main threads —
    // and for music playback the extra output latency is imperceptible.
    ctx = new AC({ latencyHint: "playback" });
    inputNode = ctx.createGain();
    outputNode = ctx.createGain();
    normGain = ctx.createGain();
    normGain.gain.value = 1;

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

    // Stage 1 — gentle, soft-knee compressor that carries most of the bass
    // taming. Its params are set from the boost amount in applyEffects; neutral
    // (ratio 1) when there's no boost, so it's inaudible on normal audio.
    bassComp = ctx.createDynamicsCompressor();
    bassComp.threshold.value = 0;
    bassComp.knee.value = 30; // wide, soft knee → smooth, not pumping
    bassComp.ratio.value = 1;
    bassComp.attack.value = 0.012;
    bassComp.release.value = 0.22;

    // Stage 2 — true brick-wall safety limiter AFTER the compressor: threshold
    // just below 0 dBFS, high ratio, fast attack. It only nips the rare peak the
    // compressor let through, so it stays essentially inaudible while still
    // guaranteeing nothing saturates. Transparent below threshold, so it never
    // touches normal, already-normalized audio.
    limiterNode = ctx.createDynamicsCompressor();
    limiterNode.threshold.value = -0.5;
    limiterNode.knee.value = 0;
    limiterNode.ratio.value = 20;
    limiterNode.attack.value = 0.002;
    limiterNode.release.value = 0.06;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 512; // 256 bins — finer resolution for the log-spaced bars
    analyser.smoothingTimeConstant = 0.82;

    // Wire the fixed chain (sources attach to inputNode in wireAudio).
    let node = inputNode;
    node.connect(normGain);
    node = normGain;
    for (const b of eqFilters) {
      node.connect(b);
      node = b;
    }
    node.connect(bassNode);
    node = bassNode;
    node.connect(bassComp);
    node = bassComp;
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
    const g = Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, +bands[i] || 0));
    b.gain.setTargetAtTime(g, t, 0.02);
  });

  const bass = Math.max(0, Math.min(1, +fx.bass || 0));
  const bassDb = bass * 12; // low-shelf lift, 0..+12 dB
  bassNode.gain.setTargetAtTime(bassDb, t, 0.02);
  // Stage-1 compressor scales with the boost: more lift → lower threshold and a
  // higher ratio, so it does most of the taming. At bass 0 it's neutral
  // (threshold 0, ratio 1) and inaudible.
  if (bass > 0.001) {
    bassComp.threshold.setTargetAtTime(-6 - bass * 14, t, 0.05); // 0→-6, 1→-20 dB
    bassComp.ratio.setTargetAtTime(2 + bass * 4, t, 0.05); // 0→2, 1→6
  } else {
    bassComp.threshold.setTargetAtTime(0, t, 0.05);
    bassComp.ratio.setTargetAtTime(1, t, 0.05);
  }

  // Static normalization gain. Ramp here: this path runs on a LEVEL change (or an
  // EQ/bass tweak) that happens mid-track, where an instant jump would click. A
  // track HANDOVER snaps instead — see setTrackGain / applyNorm.
  applyNorm(false);
}

// Push the normalization gain onto the live node. `snap` sets it instantly; a
// ramp smooths it over ~0.2 s.
//
//  - HANDOVER (snap=true): the incoming source is still buffering — silent — so
//    the value is in place before its first audible sample. This is the whole
//    fix for the "normalization bleeds onto the seam" bug: a ramp would carry the
//    PREVIOUS track's gain into the first ~200 ms of the new one (very audible
//    when the next track plays instantly from the prefetch cache).
//  - MID-TRACK (snap=false): a level change or a late gain backfill on the
//    track that's already audible — ramp so it doesn't click.
function applyNorm(snap) {
  if (!ctx || !normGain) return;
  const t = ctx.currentTime;
  const g = normLinear();
  normGain.gain.cancelScheduledValues(t);
  if (snap) normGain.gain.setValueAtTime(g, t);
  else normGain.gain.setTargetAtTime(g, t, 0.05);
}

// Called by the player with a track's ReplayGain (dB, or null/undefined when
// unknown). `snap` defaults to true: the normal caller is a track HANDOVER,
// where the value must land instantly on the still-silent incoming source. The
// player passes snap=false only for a late gain backfill on the CURRENTLY
// audible track, where a ramp avoids a click.
export function setTrackGain(db, snap = true) {
  const n = typeof db === "number" ? db : parseFloat(db);
  trackGainDb = Number.isFinite(n) ? n : null;
  applyNorm(snap);
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
  fx.norm = v in NORM_OFFSET ? v : "off";
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
export { EQ_FREQS, EQ_MIN_DB, EQ_MAX_DB };
