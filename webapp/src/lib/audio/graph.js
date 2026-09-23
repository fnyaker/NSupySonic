// The player's Web Audio graph: the analyser taps the visualizer engine reads,
// and an optional DSP chain (10-band EQ, bass enhancement, volume
// normalization, safety limiter) plus the per-source gains a CROSSFADE needs.
// Streams are same-origin (/api/stream), so the element isn't CORS-tainted and
// the analysers can read its samples.
//
// createMediaElementSource can only run ONCE per element and re-routes its
// output through the AudioContext, so once wired an element's audio flows
// through the graph. That's why we wire LAZILY and only when something actually
// needs it — a visualizer view is open, OR the user enabled an effect, OR
// crossfade is on. When nothing needs it we keep a PURE audio path: an
// AudioContext gets suspended while a tab is backgrounded, which would silently
// cut background playback, so the default (nothing enabled) never touches Web
// Audio at all.
//
// The chain is:
//
//   elA → srcA → normA → fadeA ─┐
//   elB → srcB → normB → fadeB ─┼→ input → eq[0..9] → bass → bassComp
//   preview → normP → fadeP ────┘                              ↓
//                                                          limiter → output
//                                   analyserLo ← output ────────┘   ↓
//                                   analyserHi ← output          lookahead
//                                                                   ↓
//                                                              destination
//
// Two things about that shape are load-bearing:
//
//  - the normalization gain is PER SOURCE, not shared. A crossfade has two
//    tracks audible at once and each carries its own ReplayGain, so one shared
//    node could only ever be right for one of them — the overlap would step the
//    other track's level. The fade gain is a second, separate node on purpose:
//    normalization and the fade envelope are scheduled independently (a level
//    change ramps over 50 ms; a fade runs for seconds), and multiplying them
//    into one node means every level change would have to re-derive the
//    fade's whole scheduled curve.
//  - the analysers tap BEFORE the look-ahead delay. That delay is what lets
//    the animation engine see the audio slightly before the listener hears it,
//    which is the whole point of it (see setLookahead).

import {
  eqEnabled,
  eqBands,
  bassBoost,
  normalization,
  crossfadeEnabled,
  vizLookahead,
} from "../stores.js";

let ctx = null;
let analyserLo = null; // fine frequency resolution — the low end
let analyserHi = null; // fine TIME resolution — transients and the high end

// The DSP nodes, built once with the context.
let inputNode = null; // every source sums here
let outputNode = null;
let lookaheadNode = null; // DelayNode, 0 s unless the user asks for compensation
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

// createMediaElementSource may only run ONCE per element, so each wired element
// keeps its strip of the graph here: { source, norm, fade, gainDb }. The player
// keeps two <audio> elements (for gapless quality switching and crossfades) and
// the share sheet adds a preview one, so this Map holds three entries at most —
// and an entry is dropped explicitly (releasePreview) rather than by GC, since
// a source node must be disconnected when its element is discarded.
const strips = new Map();

// Whichever <audio> element is currently active, and whether any visualizer
// view actually needs the analysers yet.
let currentEl = null;
let analyserWanted = false;

// Fixed graphic-EQ centre frequencies (Hz), low→high. 10 bands.
const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
// Per-band gain range (dB).
const EQ_MIN_DB = -16;
const EQ_MAX_DB = 16;

// Analyser sizes. The old graph had ONE 512-point analyser: at 48 kHz that is a
// 93 Hz bin, so every log-spaced bar below ~400 Hz landed on the same two or
// three bins and the low end rendered as flat groups of identical bars. The fix
// is two analysers rather than one compromise:
//  - LO: 8192 points → 5.9 Hz bins (a semitone at 100 Hz is 6 Hz), 170 ms
//    window. Bass is slow, so the window length costs nothing there.
//  - HI: 2048 points → 23 Hz bins, 43 ms window. Fast enough for transients,
//    which is what the mids/highs and the onset detector need.
const FFT_LO = 8192;
const FFT_HI = 2048;
// Where the readers stop trusting LO and start trusting HI. Below it LO's
// resolution is what matters; above it HI's speed is.
export const SPLIT_HZ = 420;

// Current effect settings, mirrored from the stores (see the subscriptions at
// the bottom of this file). Defaults are neutral / off.
const fx = {
  eq: false,
  bands: new Array(10).fill(0),
  bass: 0,
  norm: "off",
  crossfade: false,
  lookahead: 0,
};

// IMPORTANT: Deezer's GAIN is the track's *loudness*, NOT the gain to apply.
// The ReplayGain adjustment that normalizes it to Deezer's reference is
// -(GAIN + 18.4) — the exact transform deemix uses for its ReplayGain tags.
// null when unknown → that track isn't normalized (we never invent a gain).
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

// The linear gain to apply for a track's ReplayGain at the current level. 1.0
// (0 dB, no change) when normalization is off or the track's gain is unknown.
function normLinearFor(gainDb) {
  if (fx.norm === "off" || gainDb == null) return 1;
  const replayGain = -(gainDb + RG_REFERENCE); // Deezer loudness → RG adjust
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
    fx.bass > 0.01 ||
    fx.crossfade
  );
}

// The furthest the analysis can run ahead of the speakers (ms).
export const LOOKAHEAD_MAX = 300;

// The interval of the setValueCurveAtTime we last scheduled on a param.
//
// This exists because of a spec rule with teeth: setValueCurveAtTime(T, D)
// THROWS NotSupportedError when any automation method is called at a time
// inside [T, T+D). And cancelScheduledValues(t) only drops events whose time is
// at or after `t` — a curve that started BEFORE `t` has an event time before
// `t`, so it survives the cancel with its interval still straddling `t`.
// Scheduling the next fade at `t` then lands inside the live curve and throws.
// Remembering where the curve starts is what lets us cancel it for real.
const runningCurves = new WeakMap();

// Cancel whatever automation is scheduled on a param and hold it where it
// audibly IS. cancelScheduledValues alone is not enough: per spec it misses a
// setValueCurveAtTime already running (a crossfade in flight), which would keep
// running to its end. cancelAndHoldAtTime is the call that stops it; older
// engines lack it, and there the curve has to be cancelled from its own start.
function holdParam(param, t) {
  if (typeof param.cancelAndHoldAtTime === "function") {
    try {
      param.cancelAndHoldAtTime(t);
      runningCurves.delete(param);
      return;
    } catch {
      /* fall through */
    }
  }
  const v = param.value;
  const curve = runningCurves.get(param);
  // Cancel from the curve's start, not from `t`: only a cancel time at or
  // before the curve's event time actually removes it. This is the whole reason
  // interrupting a fade used to throw instead of re-arming.
  const from = curve && curve.start <= t && t < curve.end ? curve.start : t;
  param.cancelScheduledValues(from);
  param.setValueAtTime(v, t);
  runningCurves.delete(param);
}

// Schedule the equal-power ramp on a gain param and remember its interval.
function scheduleFadeCurve(param, from, to, t, seconds) {
  try {
    param.setValueCurveAtTime(equalPowerCurve(from, to), t, seconds);
    runningCurves.set(param, { start: t, end: t + seconds });
  } catch {
    // A scheduling quirk must never cost the fade — or the track. Land the end
    // value instead and forget the curve; the gain is still correct, just not
    // curved.
    param.setValueAtTime(to, t);
    runningCurves.delete(param);
  }
}

// Re-arm one gain param: hold where it is, then ramp to `to`. Exported so the
// interruption path can be driven from Node with a spec-faithful mock param.
export function fadeParam(param, from, to, t, seconds) {
  holdParam(param, t);
  if (seconds <= 0.01) {
    param.setValueAtTime(to, t);
    return;
  }
  param.setValueAtTime(from, t);
  scheduleFadeCurve(param, from, to, t, seconds);
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

    // Smoothing stays at 0 on BOTH analysers: the readers run their own
    // attack/release envelopes per band, and the onset detector needs raw,
    // unsmoothed frames — the analyser's own IIR would smear exactly the
    // transients it is looking for.
    analyserLo = ctx.createAnalyser();
    analyserLo.fftSize = FFT_LO;
    analyserLo.smoothingTimeConstant = 0;
    analyserLo.minDecibels = -100;
    analyserLo.maxDecibels = -10;
    analyserHi = ctx.createAnalyser();
    analyserHi.fftSize = FFT_HI;
    analyserHi.smoothingTimeConstant = 0;
    analyserHi.minDecibels = -100;
    analyserHi.maxDecibels = -10;

    // The look-ahead delay. maxDelayTime is fixed at construction, so reserve
    // the whole adjustable range up front; the live value is set in applyEffects.
    lookaheadNode = ctx.createDelay(LOOKAHEAD_MAX / 1000);
    lookaheadNode.delayTime.value = 0;

    // Wire the fixed chain (sources attach to inputNode in wireAudio).
    let node = inputNode;
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
    outputNode.connect(lookaheadNode);
    lookaheadNode.connect(ctx.destination);
    outputNode.connect(analyserLo);
    outputNode.connect(analyserHi);

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

  // Changing the delay time on a running DelayNode resamples its buffer, which
  // is audible as a pitch slide — so ramp it over a long enough window that the
  // slide reads as nothing at all, and only when it actually changed.
  const want = Math.max(0, Math.min(LOOKAHEAD_MAX, +fx.lookahead || 0)) / 1000;
  if (Math.abs(lookaheadNode.delayTime.value - want) > 0.0005)
    lookaheadNode.delayTime.setTargetAtTime(want, t, 0.25);

  // Static normalization gain on every wired source. Ramp here: this path runs
  // on a LEVEL change (or an EQ/bass tweak) that happens mid-track, where an
  // instant jump would click. A track HANDOVER snaps instead — see setTrackGain.
  for (const el of strips.keys()) applyNorm(el, false);
}

// Push a source's normalization gain onto its live node. `snap` sets it
// instantly; a ramp smooths it over ~0.2 s.
//
//  - HANDOVER (snap=true): the incoming source is still buffering — silent — so
//    the value is in place before its first audible sample. This is the whole
//    fix for the "normalization bleeds onto the seam" bug: a ramp would carry the
//    PREVIOUS track's gain into the first ~200 ms of the new one (very audible
//    when the next track plays instantly from the prefetch cache).
//  - MID-TRACK (snap=false): a level change or a late gain backfill on the
//    track that's already audible — ramp so it doesn't click.
function applyNorm(el, snap) {
  const strip = strips.get(el);
  if (!ctx || !strip) return;
  const t = ctx.currentTime;
  const g = normLinearFor(strip.gainDb);
  strip.norm.gain.cancelScheduledValues(t);
  if (snap) strip.norm.gain.setValueAtTime(g, t);
  else strip.norm.gain.setTargetAtTime(g, t, 0.05);
}

// Remember a source's ReplayGain even when it isn't wired yet, so the value is
// already right the moment the graph is built under it.
const pendingGain = new WeakMap();

// Set a specific element's ReplayGain (dB, or null/undefined when unknown).
export function setElementGain(el, db, snap = true) {
  if (!el) return;
  const n = typeof db === "number" ? db : parseFloat(db);
  const v = Number.isFinite(n) ? n : null;
  const strip = strips.get(el);
  if (strip) {
    strip.gainDb = v;
    applyNorm(el, snap);
  } else {
    pendingGain.set(el, v);
  }
}

// Called by the player with the ACTIVE track's ReplayGain. `snap` defaults to
// true: the normal caller is a track HANDOVER, where the value must land
// instantly on the still-silent incoming source. The player passes snap=false
// only for a late gain backfill on the currently audible track, where a ramp
// avoids a click.
export function setTrackGain(db, snap = true) {
  setElementGain(currentEl, db, snap);
}

// -- crossfade -------------------------------------------------------------
// The fade gain is a plain 0..1 envelope multiplied onto a source AFTER its
// normalization, so a fade is the same shape whatever the two tracks' levels
// are. Equal-power (cos/sin) rather than linear: two uncorrelated signals sum
// in POWER, so a linear pair dips ~3 dB in the middle — audible as a hole right
// where the two tracks meet.
const FADE_STEPS = 48;
function equalPowerCurve(from, to) {
  const c = new Float32Array(FADE_STEPS);
  for (let i = 0; i < FADE_STEPS; i++) {
    const x = i / (FADE_STEPS - 1);
    // Interpolate the ANGLE, so any (from → to) pair rides the same quarter
    // circle and a fade interrupted half way still resumes on the curve.
    const a = (Math.asin(Math.min(1, Math.max(0, from))) * (1 - x)
      + Math.asin(Math.min(1, Math.max(0, to))) * x);
    c[i] = Math.sin(a);
  }
  return c;
}

// Ramp an element's fade gain to `to` over `seconds`. Returns false when the
// element isn't wired (no graph → no crossfade; the caller falls back).
export function fadeElement(el, to, seconds) {
  const strip = strips.get(el);
  if (!ctx || !strip) return false;
  const g = strip.fade.gain;
  // Read where the envelope actually IS before cancelling, so interrupting a
  // fade continues from the audible value instead of jumping to the last value
  // that was *scheduled*.
  const from = g.value;
  fadeParam(g, from, to, ctx.currentTime, seconds);
  return true;
}

// Put an element's fade gain back to a known value with no ramp — used to arm
// an incoming source at 0 before it starts, and to reset one after a fade was
// cancelled.
export function setFade(el, v) {
  const strip = strips.get(el);
  if (!ctx || !strip) return false;
  const t = ctx.currentTime;
  holdParam(strip.fade.gain, t);
  strip.fade.gain.setValueAtTime(Math.max(0, Math.min(1, v)), t);
  return true;
}

// Whether an element plays THROUGH the graph — and so through its delays (the
// two compressors' lookahead, the analysis lookahead, the context's own output
// latency), which its currentTime knows nothing about. The listen party needs
// this to publish where the host is HEARD, not where its element is.
export function isWired(el) {
  return !!(ctx && el && strips.has(el));
}

// True when a crossfade is actually possible right now: the graph exists and
// both elements are wired through it.
export function canCrossfade(a, b) {
  return !!(ctx && strips.has(a) && strips.has(b));
}

// -- share-sheet preview ----------------------------------------------------
// The preview joins the SAME processing chain (EQ, bass, limiter, analysers) as
// the player through its own strip, so it carries its own ReplayGain — the
// previewed track is usually NOT the one the player has loaded. The preview and
// the player never sound at the same time (opening the preview pauses the
// player), so the two paths never sum.
let previewEl = null;
let previewGainDb = null;

// Route the share-sheet preview element through the shared graph. Volume/mute
// stay on the element itself, mirroring the player. Unlike registerSource this
// ALWAYS wires: the preview must follow the pipeline even when the player is on
// its pure (effects-off) path, and it is a short, deliberate foreground action,
// so forcing the AudioContext is fine. A no-op if Web Audio is unavailable —
// the element then plays raw, still audible.
export function wirePreview(el) {
  if (!el) return;
  if (previewEl === el) {
    resumeAudio();
    return;
  }
  if (!ensureGraph()) return;
  releasePreview(); // drop any earlier preview element's source first
  wireAudio(el);
  if (strips.has(el)) {
    previewEl = el;
    // The share sheet learns the previewed track's gain while it is still
    // building the element, so the value is usually already in hand here —
    // snap it on before the preview's first audible sample.
    setElementGain(el, previewGainDb, true);
  }
  resumeAudio();
}

// Detach the current preview element from the graph (its source node can only be
// created once, so it must be disconnected when the element is discarded).
export function releasePreview() {
  if (previewEl) disconnectSource(previewEl);
  previewEl = null;
  previewGainDb = null;
}

export function setPreviewGain(db, snap = true) {
  const n = typeof db === "number" ? db : parseFloat(db);
  previewGainDb = Number.isFinite(n) ? n : null;
  if (previewEl) setElementGain(previewEl, previewGainDb, snap);
}

function disconnectSource(el) {
  const strip = strips.get(el);
  if (!strip) return;
  for (const n of [strip.source, strip.norm, strip.fade]) {
    try {
      n.disconnect();
    } catch {
      /* ignore */
    }
  }
  strips.delete(el);
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
// We only wire it into the graph when the analysers or an effect actually need
// it — otherwise the pure audio path is preserved (see the file header).
export function registerSource(el) {
  currentEl = el;
  if (el && (analyserWanted || effectsOn())) wireAudio(el);
}

// Called by a visualizer view when it mounts: from now on we need the analysers,
// so wire the current element (and future ones) and make sure the context runs.
export function requestAnalyser() {
  analyserWanted = true;
  if (currentEl) wireAudio(currentEl);
  resumeAudio();
}

// A crossfade has to arm the element that ISN'T active yet, so wiring can't wait
// for registerSource. Wiring an idle, silent element costs nothing.
export function wireAudio(el) {
  if (!el || strips.has(el)) return;
  if (!ensureGraph()) return;
  try {
    // The chain (input→…→destination) is already connected, so the audible path
    // exists the moment the source joins inputNode — a failure here can't mute.
    const source = ctx.createMediaElementSource(el);
    const norm = ctx.createGain();
    const fade = ctx.createGain();
    norm.gain.value = 1;
    fade.gain.value = 1;
    source.connect(norm);
    norm.connect(fade);
    fade.connect(inputNode);
    const gainDb = pendingGain.has(el) ? pendingGain.get(el) : null;
    strips.set(el, { source, norm, fade, gainDb });
    pendingGain.delete(el);
    // Land the gain on the node NOW, snapped: the strip may have been created
    // under an already-playing element (the user just switched an effect on).
    applyNorm(el, true);
  } catch {
    /* keep any graph we already have */
  }
}

// AudioContexts start suspended until a user gesture; call this on play.
export function resumeAudio() {
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
}

export function getAnalysers() {
  return analyserLo && analyserHi ? { lo: analyserLo, hi: analyserHi } : null;
}

export function getContext() {
  return ctx;
}

// --- the stereo scope tap ---------------------------------------------------
//
// The two analysers above are USELESS for an oscilloscope, and not by a little:
// an AnalyserNode downmixes whatever it is fed to mono before it measures
// anything. The entire point of two traces is that the two channels are NOT the
// same signal — a wide pad, a hard-panned stab, a mono bass under a stereo lead
// — and a summed reading cannot say any of that. So the scope gets its own tap:
// a ChannelSplitter after the output and one analyser per channel, read with
// getFloatTimeDomainData rather than getFloatFrequencyData.
//
// It taps `outputNode`, BEFORE the look-ahead delay, exactly like the spectrum
// analysers: the scope has to be drawing the same instant of audio the rest of
// the engine is reading, or a scene showing both would show them a third of a
// second apart.
//
// REFCOUNTED and built on demand, like everything else in this file. Two more
// analysers copy every render quantum into their ring buffers whether or not
// anybody reads them, and a session that never opens the scope should never pay
// for that. `requestScope` / `releaseScope` are the pair; the engine holds the
// only reference.
let scopeSplitter = null;
let scopeAnL = null;
let scopeAnR = null;
let scopeRefs = 0;
let scopeWant = 4096; // the fftSize asked for, before the graph exists
// The buffers live here rather than in the caller: they have to match the
// analysers' fftSize, which this file owns, and there is exactly one reader.
const scopeOut = { left: null, right: null, size: 0, sampleRate: 48000 };

// An AnalyserNode's time-domain buffer is exactly `fftSize` samples long, and
// fftSize is a power of two in [32, 32768].
const SCOPE_MIN = 1024;
const SCOPE_MAX = 32768;
function scopePow2(n) {
  let v = SCOPE_MIN;
  while (v < n && v < SCOPE_MAX) v *= 2;
  return v;
}

function buildScope() {
  if (scopeAnL || !ensureGraph()) return;
  try {
    // A ChannelSplitter's channelCount is fixed at its output count and its
    // mode at "explicit", so a MONO source is up-mixed rather than leaving
    // output 1 dead: a mono track shows two identical traces, which is what a
    // real scope with both probes on one signal shows — not one trace and a
    // flat line.
    scopeSplitter = ctx.createChannelSplitter(2);
    scopeAnL = ctx.createAnalyser();
    scopeAnR = ctx.createAnalyser();
    for (const a of [scopeAnL, scopeAnR]) {
      a.fftSize = scopeWant;
      // Smoothing is an IIR over successive FFT frames; it does not touch
      // getFloatTimeDomainData at all. Kept at 0 for the same reason as the
      // others: nothing here wants the analyser's own opinion.
      a.smoothingTimeConstant = 0;
    }
    outputNode.connect(scopeSplitter);
    scopeSplitter.connect(scopeAnL, 0);
    scopeSplitter.connect(scopeAnR, 1);
    allocScope();
  } catch {
    teardownScope();
  }
}

function allocScope() {
  const n = scopeAnL ? scopeAnL.fftSize : 0;
  if (!n) return;
  if (!scopeOut.left || scopeOut.left.length !== n) {
    scopeOut.left = new Float32Array(n);
    scopeOut.right = new Float32Array(n);
  }
  scopeOut.sampleRate = ctx ? ctx.sampleRate : 48000;
}

function teardownScope() {
  // The connection INTO the splitter belongs to `outputNode`, so the splitter
  // disconnecting itself only drops its own outputs and leaves the output node
  // still feeding it. Opening and closing the scope a few times would then
  // leave a chain of splitters hanging off it, each one still being rendered
  // into. Drop it from the source side first.
  try {
    if (scopeSplitter) outputNode?.disconnect(scopeSplitter);
  } catch {
    /* already gone */
  }
  for (const n of [scopeSplitter, scopeAnL, scopeAnR]) {
    try {
      n?.disconnect();
    } catch {
      /* ignore */
    }
  }
  scopeSplitter = scopeAnL = scopeAnR = null;
  scopeOut.left = scopeOut.right = null;
  scopeOut.size = 0;
}

/**
 * Turn the per-channel time-domain tap on and ask for at least `samples` of
 * history (rounded up to a power of two). Refcounted — pair every call with
 * `releaseScope`. Raising the window while it is already running is free: an
 * analyser's fftSize can be reassigned in place.
 */
export function requestScope(samples = 4096) {
  scopeRefs++;
  setScopeWindow(samples);
  if (!scopeAnL) buildScope();
  requestAnalyser();
}

export function releaseScope() {
  scopeRefs = Math.max(0, scopeRefs - 1);
  if (!scopeRefs) teardownScope();
}

/** Grow (or shrink) the tap's window. No-op when nothing is tapping. */
export function setScopeWindow(samples) {
  const want = scopePow2(Math.max(SCOPE_MIN, +samples || 0));
  if (want === scopeWant) return;
  scopeWant = want;
  if (!scopeAnL) return;
  try {
    scopeAnL.fftSize = want;
    scopeAnR.fftSize = want;
    allocScope();
  } catch {
    /* an engine that refused the size keeps the one it had */
  }
}

/**
 * The most recent `fftSize` samples of each channel, oldest first.
 *
 * Returns a SHARED object whose arrays are overwritten on every call — read it
 * inside the frame, exactly like the engine's own frame object. Null when
 * nothing is tapping yet (no graph, or the scene is not on screen).
 */
export function readScope() {
  if (!scopeAnL || !scopeAnR || !scopeOut.left) return null;
  scopeAnL.getFloatTimeDomainData(scopeOut.left);
  scopeAnR.getFloatTimeDomainData(scopeOut.right);
  scopeOut.size = scopeOut.left.length;
  return scopeOut;
}

// How far (seconds) the analysers currently run ahead of the speakers.
export function lookaheadSeconds() {
  return lookaheadNode ? lookaheadNode.delayTime.value : 0;
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
crossfadeEnabled.subscribe((v) => {
  fx.crossfade = !!v;
  onFxChange();
});
vizLookahead.subscribe((v) => {
  fx.lookahead = Math.max(0, Math.min(LOOKAHEAD_MAX, +v || 0));
  applyEffects();
});

// Exposed for the settings UI: the fixed EQ centre frequencies, so the sliders
// can label themselves without hard-coding the list twice.
export { EQ_FREQS, EQ_MIN_DB, EQ_MAX_DB, FFT_LO, FFT_HI };
