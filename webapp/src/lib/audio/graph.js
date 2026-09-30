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
//
// THE DIRECT PATH (lib/audio/output.js decides when): no element is routed at
// all. The browser's media pipeline plays it, and what the graph would have
// done is done without touching the sound on its way out:
//
//   elA ──────────────────────────────→ the system's media output
//    └ captureStream() → capA ─┐
//   elB ─→ … the same ─ capB ──┼→ analysisBus → analysers, scope, rhythm tap
//                   outputNode ┘               (nothing reaches destination)
//
//  - the normalization and the fade envelope ride on element.volume (the
//    `vols` strips below): the same equal-power curve, driven from a timer, and
//    a gain that can only go DOWN, since volume stops at 1;
//  - the analysis reads a COPY of the sound (a MediaStream the element tees
//    off its own renderer), so an animation that stutters costs a picture,
//    never a piece of the music;
//  - the context is suspended whenever nothing is analysing, so a phone in a
//    car with its screen off has exactly one audio stream open: the element's.
// Elements routed before the path went direct keep playing through the graph
// until the player hands them over to fresh ones (Player.svelte#renewElements):
// a routed element cannot be taken back out.

import {
  eqEnabled,
  eqBands,
  bassBoost,
  normalization,
  crossfadeEnabled,
  vizLookahead,
  vizLookaheadMode,
} from "../stores.js";
import { directOutput } from "./output.js";

let ctx = null;
let analyserLo = null; // fine frequency resolution — the low end
let analyserHi = null; // fine TIME resolution — transients and the high end

// The DSP nodes, built once with the context.
let inputNode = null; // every source sums here
let outputNode = null;
// What every reader of the sound taps: the processed output, and on the direct
// path the captured copies of the elements.
let analysisBus = null;
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
// view actually needs the analysers yet. `analyserWanted` is sticky (once a
// view has asked, every later element is routed, so re-opening the player never
// re-routes a playing element); `analysisActive` is whether the engine is
// running right now, which is what the direct path's capture follows.
let currentEl = null;
let analyserWanted = false;
let analysisActive = false;
// The direct path is in force (lib/audio/output.js#directOutput).
let direct = false;

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
  lookaheadAuto: true,
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

// THE AUTOMATIC LOOK-AHEAD (vizLookaheadMode "auto", the default). The
// analysis needs ~45 ms of audio past an event before it is sure of it, and
// what it has is the output latency: a frame reaches the page that much before
// its audio reaches the listener. Bluetooth gives it hundreds of milliseconds;
// a desktop's short output path can give it less than it needs, and then a
// kick is drawn a picture or two after it is heard. The engine measures how
// early its frames really arrive and asks for exactly the delay that makes up
// the difference (engine.js#tuneLookahead) — using the latency the OS reports,
// so nobody has to guess a number.
//
// Moving a DelayNode's delay resamples what is in it: a pitch glide. So an
// automatic change is a slow linear ramp, AUTO_RATE seconds of delay per
// second — 0.3% of speed, five cents, where a trained ear starts to hear a
// pitch change at five to ten. A 30 ms correction takes ten seconds and is
// heard as nothing. A change the listener makes by hand still takes a quarter
// of a second: they asked for it. The last automatic value is remembered per
// device, and a new graph starts on it before any audio flows through it.
const AUTO_RATE = 0.003;
export const AUTO_LOOKAHEAD_MAX = 150; // ms
const LEARNED_KEY = "viz.lookahead.learned";
let autoLead = (() => {
  try {
    const v = parseFloat(localStorage.getItem(LEARNED_KEY));
    return Number.isFinite(v) ? Math.max(0, Math.min(AUTO_LOOKAHEAD_MAX, v)) / 1000 : 0;
  } catch {
    return 0;
  }
})();
let scheduledLead = null; // seconds: what the delay is on its way to
let leadSettlesAt = 0; // performance.now() when that ramp lands

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
  setAt(param, v, t);
  runningCurves.delete(param);
}

// setValueAtTime that cannot throw. After the hold above, nothing should be
// left over `t` — but engines disagree on what cancelAndHoldAtTime leaves
// behind a curve it interrupts, and one of them (the Android WebView, Chrome
// 154) left the REST of the curve, restarted at the cancel time: a 60 ms skip
// ramp interrupted 9 ms in became a 50.7 ms curve starting exactly at `t`, and
// the next setValueAtTime(1, t) threw NotSupportedError. That throw landed
// inside the player's track load, which then never finished — no gain snap, no
// "done loading", the seek bar ignoring the new track. So whatever an engine
// leaves, the timeline is cleared and the value set: cancelScheduledValues(0)
// removes every event, a curve in flight included, and the param is then at
// `v` from `t`, which is what the caller asked for.
function setAt(param, v, t) {
  try {
    param.setValueAtTime(v, t);
  } catch {
    clearParam(param);
    param.setValueAtTime(v, t);
  }
}

function clearParam(param) {
  param.cancelScheduledValues(0);
  runningCurves.delete(param);
}

// Schedule the equal-power ramp on a gain param and remember its interval.
function scheduleFadeCurve(param, from, to, t, seconds) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      param.setValueCurveAtTime(equalPowerCurve(from, to), t, seconds);
      runningCurves.set(param, { start: t, end: t + seconds });
      return;
    } catch {
      // Something an engine left on the timeline is in the way. Clear it and
      // try once more from where the fade starts: a curve lost is a cut, and a
      // cut mid-waveform is the click this fade exists to avoid.
      if (attempt === 0) {
        clearParam(param);
        setAt(param, from, t);
      }
    }
  }
  // A scheduling quirk must never cost the fade — or the track. Land the end
  // value instead and forget the curve; the gain is still correct, just not
  // curved.
  setAt(param, to, t);
  runningCurves.delete(param);
}

// Re-arm one gain param: hold where it is, then ramp to `to`. Exported so the
// interruption path can be driven from Node with a spec-faithful mock param.
export function fadeParam(param, from, to, t, seconds) {
  holdParam(param, t);
  if (seconds <= 0.01) {
    setAt(param, to, t);
    return;
  }
  setAt(param, from, t);
  scheduleFadeCurve(param, from, to, t, seconds);
}

// Hold a param at `v` from `t`, whatever is scheduled on it. Exported for the
// same reason as fadeParam.
export function setParam(param, v, t) {
  holdParam(param, t);
  setAt(param, v, t);
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
    // the whole adjustable range up front. It starts where it should be, at
    // once, when nothing is playing yet — nothing has flowed through it, so
    // there is nothing to glide. Built under a track that is already playing
    // (a visualizer opened mid-song), it starts at zero and ramps: a delay line
    // switched in full would be that many milliseconds of silence.
    lookaheadNode = ctx.createDelay(LOOKAHEAD_MAX / 1000);
    scheduledLead = currentEl && !currentEl.paused ? 0 : wantedLead();
    lookaheadNode.delayTime.value = scheduledLead;
    leadSettlesAt = 0;

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
    analysisBus = ctx.createGain();
    outputNode.connect(analysisBus);
    analysisBus.connect(analyserLo);
    analysisBus.connect(analyserHi);

    applyEffects();
    return true;
  } catch {
    ctx = null;
    analysisBus = null;
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

  applyLookahead();

  // Static normalization gain on every wired source. Ramp here: this path runs
  // on a LEVEL change (or an EQ/bass tweak) that happens mid-track, where an
  // instant jump would click. A track HANDOVER snaps instead — see setTrackGain.
  for (const el of strips.keys()) applyNorm(el, false);
  applyDirectVolumes();
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
    // Played direct: the gain is part of the element's volume.
    if (vols.has(el)) applyVol(el);
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
// element isn't wired (no graph → no crossfade; the caller falls back). On the
// direct path the envelope is the element's volume (see `vols`).
export function fadeElement(el, to, seconds) {
  if (!el) return false;
  const strip = strips.get(el);
  if (!strip && (direct || vols.has(el))) return fadeVol(el, to, seconds);
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
  if (!el) return false;
  const strip = strips.get(el);
  if (!strip && (direct || vols.has(el))) return setVolFade(el, v);
  if (!ctx || !strip) return false;
  setParam(strip.fade.gain, Math.max(0, Math.min(1, v)), ctx.currentTime);
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
// both elements are wired through it — or, on the direct path, neither is and
// their volumes carry the fade. One of each (the moment between the path going
// direct and the player handing its routed element over) cannot blend: one
// envelope would run on the audio clock and the other on a timer.
export function canCrossfade(a, b) {
  if (!a || !b) return false;
  if (direct && !strips.has(a) && !strips.has(b)) return true;
  return !!(ctx && strips.has(a) && strips.has(b));
}

/** Whether the player's sound must stay off Web Audio (lib/audio/output.js). */
export function isDirect() {
  return direct;
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
  // The direct path routes nothing, the preview included: it plays as it is.
  if (direct) {
    releasePreview();
    return;
  }
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
  if (direct) {
    applyDirectVolumes(); // a normalization level change moves the volumes
    return;
  }
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
  if (!el) return;
  if (direct) {
    manage(el);
    return;
  }
  if (analyserWanted || effectsOn()) wireAudio(el);
}

// The element the player last registered: the one the listener is hearing.
// Read by what has to follow the sound itself (the lyric line), not the store.
export function activeSource() {
  return currentEl;
}

// Called by a visualizer view when it mounts: from now on we need the analysers,
// so wire the current element (and future ones) and make sure the context runs.
export function requestAnalyser() {
  analyserWanted = true;
  analysisActive = true;
  if (direct) {
    // Read a copy; route nothing.
    if (ensureGraph()) captureAll();
  } else if (currentEl) wireAudio(currentEl);
  resumeAudio();
}

/**
 * The engine stopped (no view left, or the page hidden). On the processed path
 * this changes nothing — later elements are still routed, so re-opening the
 * player never re-routes one mid-song. On the direct path the copies are let
 * go and the context is suspended: nothing else is reading it.
 */
export function releaseAnalyser() {
  analysisActive = false;
  if (!direct) return;
  dropCaptures();
  maybeSuspend();
}

// A crossfade has to arm the element that ISN'T active yet, so wiring can't wait
// for registerSource. Wiring an idle, silent element costs nothing.
export function wireAudio(el) {
  if (!el || strips.has(el)) return;
  if (direct) {
    // Nothing is routed on the direct path. The caller (a crossfade arming its
    // incoming element) gets the element's volume as its envelope instead.
    manage(el);
    return;
  }
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
    // An element that was played direct hands its envelope over to the nodes:
    // from here the volume is only the player's.
    const was = vols.get(el);
    if (was) {
      fade.gain.value = currentFade(was, performance.now());
      vols.delete(el);
      el.volume = clamp01(baseVolume);
      if (!vols.size) stopRampTimer();
    }
    strips.set(el, { source, norm, fade, gainDb });
    pendingGain.delete(el);
    // Land the gain on the node NOW, snapped: the strip may have been created
    // under an already-playing element (the user just switched an effect on).
    applyNorm(el, true);
  } catch {
    /* keep any graph we already have */
  }
}

// AudioContexts start suspended until a user gesture; call this on play. On the
// direct path a context nobody is reading stays suspended: the player calls this
// on every progress tick, and it must not wake a context just to render silence.
export function resumeAudio() {
  if (!ctx || ctx.state !== "suspended") return;
  if (direct && !analysisActive && !strips.size) return;
  ctx.resume().catch(() => {});
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
// It taps the analysis bus, BEFORE the look-ahead delay, exactly like the spectrum
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
    analysisBus.connect(scopeSplitter);
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
  // The connection INTO the splitter belongs to `analysisBus`, so the splitter
  // disconnecting itself only drops its own outputs and leaves the bus still
  // feeding it. Opening and closing the scope a few times would then leave a
  // chain of splitters hanging off it, each one still being rendered into.
  // Drop it from the source side first.
  try {
    if (scopeSplitter) analysisBus?.disconnect(scopeSplitter);
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
// --- the rhythm analyser's tap -----------------------------------------------
//
// lib/audio/engine.js runs the analysis in an AudioWorklet (rhythm.worklet.js)
// and hands its node here to be fed. It taps the analysis bus, BEFORE the
// look-ahead delay, like every other reader of the graph — with a look-ahead
// configured it hears the music before the listener does, which is what lets
// the engine deliver each frame exactly when its audio is heard. A node that
// nothing downstream pulls may never be processed, so it gets a silent path to
// the destination, the same trick the old tick worklet used.
let rhythmTap = null; // { node, mute }

export function tapRhythm(node) {
  if (!ctx || !analysisBus || !node) return false;
  untapRhythm();
  try {
    const mute = ctx.createGain();
    mute.gain.value = 0;
    analysisBus.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    rhythmTap = { node, mute };
    return true;
  } catch {
    return false;
  }
}

export function untapRhythm() {
  if (!rhythmTap) return;
  const { node, mute } = rhythmTap;
  rhythmTap = null;
  try {
    analysisBus?.disconnect(node);
  } catch {
    /* already gone */
  }
  try {
    node.disconnect();
    mute.disconnect();
  } catch {
    /* already gone */
  }
}

export function lookaheadSeconds() {
  // On the direct path nothing audible goes through the delay: what the
  // analysis reads is a copy of what the element is already playing.
  if (direct && !strips.size) return 0;
  return lookaheadNode ? lookaheadNode.delayTime.value : 0;
}

function wantedLead() {
  return fx.lookaheadAuto ? autoLead : Math.max(0, Math.min(LOOKAHEAD_MAX, +fx.lookahead || 0)) / 1000;
}

// Changing the delay time on a running DelayNode resamples its buffer, which is
// audible as a pitch slide: see AUTO_RATE for how slowly an automatic change
// moves. Only a real change is scheduled — applyEffects runs on every EQ tweak.
function applyLookahead() {
  if (!ctx || !lookaheadNode) return;
  const want = wantedLead();
  if (scheduledLead != null && Math.abs(want - scheduledLead) < 0.0005) return;
  scheduledLead = want;
  const p = lookaheadNode.delayTime;
  const t = ctx.currentTime;
  const from = p.value;
  holdParam(p, t);
  if (fx.lookaheadAuto) {
    const seconds = Math.abs(want - from) / AUTO_RATE;
    if (seconds < 0.02) p.setValueAtTime(want, t);
    else p.linearRampToValueAtTime(want, t + seconds);
    leadSettlesAt = performance.now() + seconds * 1000;
  } else {
    p.setTargetAtTime(want, t, 0.25);
    leadSettlesAt = performance.now() + 1500;
  }
}

/**
 * Whether the look-ahead is the engine's to set (the "auto" mode). Never on the
 * direct path: there is no delay in front of the listener to set, and a frame
 * that arrives late there is late whatever the engine asks for.
 */
export function lookaheadIsAuto() {
  return fx.lookaheadAuto && !direct;
}

/** Where the look-ahead is heading (seconds), ramps included. */
export function lookaheadTarget() {
  if (direct && !strips.size) return 0;
  return scheduledLead ?? wantedLead();
}

/** True once the last change of the look-ahead has fully landed. */
export function lookaheadSettled() {
  return performance.now() >= leadSettlesAt;
}

/**
 * The engine's measured need, in seconds. Applied only in "auto" mode, as a
 * slow ramp, and remembered for this device's next graph.
 */
export function setAutoLookahead(seconds) {
  if (direct) return; // measured against a path the listener is not hearing
  const v = Math.max(0, Math.min(AUTO_LOOKAHEAD_MAX / 1000, +seconds || 0));
  autoLead = v;
  try {
    localStorage.setItem(LEARNED_KEY, String(Math.round(v * 10000) / 10));
  } catch {
    /* private mode */
  }
  if (fx.lookaheadAuto) applyLookahead();
}

// --- the direct path ----------------------------------------------------------
//
// See the file header and lib/audio/output.js for why it exists. Everything
// here keeps the player's calls (setElementGain, fadeElement, setFade,
// canCrossfade, registerSource) meaning what they mean on the processed path,
// with the element's volume standing in for the nodes.

// The player's own level (its volume, mute and sleep fade), which every direct
// element's volume is a fraction of.
let baseVolume = 1;
// el -> { fade, ramp }: the fade envelope of an element played direct. `ramp`
// is { from, to, t0, ms } while a fade runs, driven by one shared timer.
const vols = new Map();
let rampTimer = 0;
// A volume ramp is a staircase: 25 ms steps along a 6 s equal-power curve are
// changes of under 1% each, below anything a listener can hear as a step. The
// envelope is computed from the wall clock at each step, so a late step lands
// where the curve IS rather than where it was — and since a backgrounded
// WebView may throttle timers hard, the player also steps it on every
// `timeupdate` (tickVolumes), which the media pipeline fires four times a
// second whatever the page's timers are doing. A fade can come out coarser in
// the background; it can never stall with the incoming track silent.
const RAMP_TICK = 25;

const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0);

function angleOf(v) {
  return Math.asin(clamp01(v));
}

// Where an envelope is at `now` (performance.now() ms): the same quarter
// circle equalPowerCurve samples for the audio clock.
function currentFade(v, now) {
  const r = v.ramp;
  if (!r) return v.fade;
  const x = r.ms > 0 ? (now - r.t0) / r.ms : 1;
  if (x >= 1) return r.to;
  if (x <= 0) return r.from;
  return Math.sin(angleOf(r.from) * (1 - x) + angleOf(r.to) * x);
}

// The normalization a direct element can carry: element.volume stops at 1, so
// a gain can only turn a track DOWN. A quiet master stays as quiet as it is,
// which is the honest failure — the alternative (lowering everything else to
// make room) would make the whole player quieter than the device's own volume.
function directNorm(el) {
  return Math.min(1, normLinearFor(pendingGain.has(el) ? pendingGain.get(el) : null));
}

function applyVol(el, now = performance.now()) {
  const v = vols.get(el);
  if (!v) return;
  const g = clamp01(baseVolume * directNorm(el) * currentFade(v, now));
  // Assigning an unchanged volume still fires `volumechange` and costs a trip
  // to the media thread; skip it.
  if (Math.abs(el.volume - g) > 1e-4) el.volume = g;
}

function applyDirectVolumes() {
  const now = performance.now();
  for (const el of vols.keys()) applyVol(el, now);
}

// Take an element's volume in charge (idempotent). It starts at full fade.
function manage(el) {
  if (!el || strips.has(el)) return;
  if (!vols.has(el)) vols.set(el, { fade: 1, ramp: null });
  applyVol(el);
  if (direct && analysisActive) captureElement(el);
}

function stopRampTimer() {
  if (rampTimer) clearInterval(rampTimer);
  rampTimer = 0;
}

function tickRamps() {
  const now = performance.now();
  let live = 0;
  for (const [el, v] of vols) {
    if (!v.ramp) continue;
    if (now - v.ramp.t0 >= v.ramp.ms) {
      v.fade = v.ramp.to;
      v.ramp = null;
    } else live++;
    applyVol(el, now);
  }
  if (!live) stopRampTimer();
}

/** Step the direct elements' fades now (the player calls it on timeupdate). */
export function tickVolumes() {
  if (rampTimer) tickRamps();
}

function fadeVol(el, to, seconds) {
  manage(el);
  const v = vols.get(el);
  if (!v) return false;
  const now = performance.now();
  // From where the envelope audibly IS, so an interrupted fade continues.
  const from = currentFade(v, now);
  const target = clamp01(to);
  if (!(seconds > 0.01)) {
    v.fade = target;
    v.ramp = null;
  } else {
    v.fade = from;
    v.ramp = { from, to: target, t0: now, ms: seconds * 1000 };
    if (!rampTimer && typeof setInterval === "function") rampTimer = setInterval(tickRamps, RAMP_TICK);
  }
  applyVol(el, now);
  return true;
}

function setVolFade(el, value) {
  manage(el);
  const v = vols.get(el);
  if (!v) return false;
  v.fade = clamp01(value);
  v.ramp = null;
  applyVol(el);
  return true;
}

/**
 * The player's level, for the elements it names (the playing one, and the
 * outgoing one of a crossfade). A routed element takes it as its volume, as it
 * always has; a direct one takes it times its normalization and its fade.
 */
export function setPlayerVolume(v, elements = []) {
  baseVolume = clamp01(+v || 0);
  for (const el of elements) {
    if (!el) continue;
    if (vols.has(el)) applyVol(el);
    else el.volume = baseVolume;
  }
}

// The copies the analysis reads on the direct path: el -> { stream, node,
// trackId, refresh }. HTMLMediaElement.captureStream() tees the element's
// decoded sound into a MediaStream WITHOUT taking it off the speakers (unlike
// createMediaElementSource), and a MediaStreamAudioSourceNode brings it into
// the context — onto the analysis bus only, never toward the destination.
//
// A MediaStreamAudioSourceNode is bound to the track it was built on, and an
// element replaces its tracks whenever its source changes (every track change),
// so the node is rebuilt whenever the live track differs.
const captures = new Map();
// Off for the rest of the session when a copy was measured disturbing the
// playback it copies (timekeeper.js): the animations go quiet, the music stays.
let captureOff = false;

function captureElement(el) {
  if (!el || captureOff || captures.has(el) || !ctx || !analysisBus) return;
  if (typeof el.captureStream !== "function") return; // Firefox reroutes, Safari has none
  let stream;
  try {
    stream = el.captureStream();
  } catch {
    return;
  }
  const cap = { stream, node: null, trackId: null, refresh: null };
  cap.refresh = () => refreshCapture(el, cap);
  try {
    stream.addEventListener("addtrack", cap.refresh);
    stream.addEventListener("removetrack", cap.refresh);
  } catch {
    /* a stream without events: the element's own events below still cover it */
  }
  el.addEventListener("playing", cap.refresh);
  el.addEventListener("loadeddata", cap.refresh);
  captures.set(el, cap);
  cap.refresh();
}

function refreshCapture(el, cap) {
  if (captures.get(el) !== cap || !ctx || !analysisBus) return;
  let track = null;
  try {
    track = cap.stream.getAudioTracks().find((t) => t.readyState === "live") || null;
  } catch {
    track = null;
  }
  const id = track ? track.id : null;
  if (id === cap.trackId && cap.node) return;
  if (cap.node) {
    try {
      cap.node.disconnect();
    } catch {
      /* already gone */
    }
    cap.node = null;
  }
  cap.trackId = id;
  if (!track) return;
  try {
    cap.node = ctx.createMediaStreamSource(new MediaStream([track]));
    cap.node.connect(analysisBus);
  } catch {
    cap.node = null;
  }
}

function dropCapture(el) {
  const cap = captures.get(el);
  if (!cap) return;
  captures.delete(el);
  try {
    cap.stream.removeEventListener("addtrack", cap.refresh);
    cap.stream.removeEventListener("removetrack", cap.refresh);
  } catch {
    /* ignore */
  }
  el.removeEventListener("playing", cap.refresh);
  el.removeEventListener("loadeddata", cap.refresh);
  if (cap.node) {
    try {
      cap.node.disconnect();
    } catch {
      /* ignore */
    }
  }
  // Ending the copy's tracks releases the tee in the element's renderer; the
  // element itself plays on untouched.
  try {
    for (const t of cap.stream.getTracks()) t.stop();
  } catch {
    /* ignore */
  }
}

function dropCaptures() {
  for (const el of [...captures.keys()]) dropCapture(el);
}

function captureAll() {
  if (captureOff) return;
  if (currentEl && !strips.has(currentEl)) manage(currentEl);
  for (const el of vols.keys()) captureElement(el);
}

// Nothing is reading the context and nothing plays through it: let it stop.
function maybeSuspend() {
  if (!ctx || !direct || analysisActive || strips.size) return;
  if (ctx.state === "running") ctx.suspend().catch(() => {});
}

/** Whether the animations are reading a copy of the sound right now. */
export function isCapturing() {
  return captures.size > 0;
}

/**
 * Stop copying the sound for the rest of the session: the timekeeper measured
 * the direct element losing time while a copy was being taken. The animations
 * lose their input; the music is what matters.
 */
export function disableCapture() {
  captureOff = true;
  dropCaptures();
}

/**
 * The player is discarding an element for good (a routed one it replaced to go
 * direct): drop everything the graph holds for it. Once no routed element is
 * left on the direct path, the context is suspended unless the analysis runs.
 */
export function releaseElement(el) {
  if (!el) return;
  disconnectSource(el);
  dropCapture(el);
  vols.delete(el);
  pendingGain.delete(el);
  if (!vols.size) stopRampTimer();
  if (currentEl === el) currentEl = null;
  maybeSuspend();
}

/**
 * What the audio path is doing, for diagnostics (window.__nsAudioPath, the
 * browser tests): whether `el` is routed, how many elements the graph routes or
 * steers by volume, whether the animations read a copy, the context's state and
 * the loudest bin the fast analyser sees (dB; -Infinity on silence).
 */
export function pathState(el) {
  let level = null;
  if (analyserHi && ctx && ctx.state === "running") {
    const a = new Float32Array(analyserHi.frequencyBinCount);
    analyserHi.getFloatFrequencyData(a);
    level = -Infinity;
    for (let i = 0; i < a.length; i++) if (a[i] > level) level = a[i];
  }
  return {
    direct,
    wired: isWired(el),
    routed: strips.size,
    steered: vols.size,
    capturing: captures.size,
    captureOff,
    context: ctx ? ctx.state : null,
    analysis: analysisActive,
    level,
  };
}

function setDirect(v) {
  v = !!v;
  if (v === direct) return;
  direct = v;
  if (direct) {
    // Routed elements keep their strips (they are audible through them) until
    // the player replaces them; the element it registers from now on is taken
    // in charge here. The copies start if the engine is running.
    if (currentEl && !strips.has(currentEl)) manage(currentEl);
    if (analysisActive && ensureGraph()) captureAll();
    maybeSuspend();
  } else {
    // Back to the processed path: the copies go (the engine reads the graph's
    // own output again), and the current element is routed as before whenever
    // something wants it. Direct elements keep their volume envelopes until
    // they are routed, so a fade in flight still lands.
    dropCaptures();
    if (currentEl && (analyserWanted || effectsOn())) wireAudio(currentEl);
    resumeAudio();
  }
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
  applyLookahead();
});
vizLookaheadMode.subscribe((v) => {
  fx.lookaheadAuto = v !== "manual";
  applyLookahead();
});
directOutput.subscribe(setDirect);

// Exposed for the settings UI: the fixed EQ centre frequencies, so the sliders
// can label themselves without hard-coding the list twice.
export { EQ_FREQS, EQ_MIN_DB, EQ_MAX_DB, FFT_LO, FFT_HI };
