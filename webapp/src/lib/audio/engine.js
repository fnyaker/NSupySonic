// The single analysis engine: one clock, one pass over the analysers, one frame
// object every subscriber reads. Everything visual in the app — the bars in the
// player, the smart scenes, the projector page — hangs off this.
//
// It is refcounted. Nothing here runs until a view asks for frames, and it all
// stops again when the last one goes away, so the default app (no visualizer
// open) pays nothing at all.
//
// THREE THINGS ARE LOAD-BEARING:
//
// 1. ONE PASS, SHARED. Two views on screen (the player's bars and a lyric
//    backdrop, say) used to mean two rAF loops each pulling the analyser and
//    each running its own smoothing. Here the frame is computed once and handed
//    out by reference, so a second view costs a function call.
//
// 2. THE CLOCK IS THE AUDIO THREAD, not rAF. rAF stops in a hidden tab, and a
//    hidden tab is exactly the normal case for the projector page: the player
//    is behind the window showing the animation. A tiny AudioWorklet that posts
//    a message every 4 render quanta (~94 Hz at 48 kHz) is never throttled, so
//    the feed survives. rAF is the fallback where AudioWorklet is missing.
//
//    The upgrade to that clock is RETRIED rather than attempted once. An
//    AudioWorklet needs an AudioContext, and the context only exists once
//    something wired the player's element into the graph — which normally
//    happens when playback starts, i.e. AFTER a projector window has already
//    subscribed. Giving up on the first look left the engine on rAF for the
//    rest of the session, and the projector then froze the moment the player
//    tab went behind it. `ensureState` calls back here the instant the context
//    appears, so the upgrade happens exactly once, as soon as it is possible.
//
// 3. LOOK-AHEAD IS APPLIED TO THE OUTPUT, NOT ASSUMED AWAY. The analysers tap
//    the graph BEFORE its delay node, so with a look-ahead configured they see
//    audio the listener has not heard yet. That is what lets an unpredicted hit
//    be drawn exactly on time instead of a detector's latency late — but it
//    also means a PREDICTED beat would fire early by the same amount if nothing
//    corrected for it. So the engine re-expresses the beat grid on the
//    LISTENER's timeline (see `shift` below) and holds raw onsets back until
//    the moment their audio actually reaches the speakers. With look-ahead at
//    zero both are no-ops.

import { get, writable } from "svelte/store";
import { current, player } from "../stores.js";
import { knownAnalysis, primeAnalyses } from "../analysis.js";
import {
  getAnalysers,
  getContext,
  requestAnalyser,
  resumeAudio,
  lookaheadSeconds,
  FFT_LO,
  FFT_HI,
} from "./graph.js";
import { buildBandPlan, buildEnergyPlan, readBands, readEnergy, ENERGY_BANDS } from "./spectrum.js";
import { createFeatureExtractor } from "./features.js";
import { createBeatTracker } from "./tempo.js";
import { createStyleClassifier } from "./style.js";

// 120 log-spaced bands over 22 Hz..18 kHz — about 20 per octave, so roughly
// half a semitone. Fixed rather than per-view: scenes that want fewer bars
// group these (120 divides by 2, 3, 4, 5, 6 and 8), which is both cheaper and
// steadier than each view running its own band plan.
export const BAND_COUNT = 120;
const FLOOR_DB = -96;
const CEIL_DB = -14;

// How deep the analysis goes. Each level is a superset of the one before, and
// the engine runs the shallowest level every live subscriber can live with.
export const LEVEL = { SPECTRUM: 0, RHYTHM: 1, SMART: 2 };

let analysisLevel = LEVEL.SPECTRUM;
let subs = [];
let running = false;
let clock = null; // { stop() }
let clockKind = "none"; // "raf" until the audio-thread clock can be installed
let upgrading = false;
let plans = null;
let features = null;
let beatTracker = null;
let classifier = null;
let loData = null;
let hiData = null;
let lastT = 0;
let lastTrackId = null;
let backgroundOk = false; // a projector page is listening: keep going when hidden
// The server's whole-track verdict for whatever is playing, once it arrives.
// See lib/analysis.js: it is an accelerator, never a dependency.
let verdict = null;
let verdictSeeded = false;
// How many tracks ahead to ask for. The queue moves one at a time and the
// answers are tiny, so a short window keeps every upcoming track's verdict in
// hand well before it starts.
const ANALYSIS_WINDOW = 6;

const energyLin = { sub: 0, bass: 0, lowMid: 0, mid: 0, high: 0, air: 0 };
const energyDb = new Float32Array(ENERGY_BANDS.length);

// Beat grid on the listener's timeline (see the header).
let prevShownIndex = -1;
const shownBeat = {
  bpm: 0,
  confidence: 0,
  phase: 0,
  beat: false,
  beatIndex: 0,
  barPos: 0,
  beatsPerBar: 4,
  downbeat: false,
  onset: 0,
  kickPulse: 0,
  sinceBeat: 0,
  period: 0.5,
  locked: false,
};

// Raw onsets wait here until their audio reaches the speakers.
const onsetQueue = [];

// A slow mirror of what the engine currently believes, for the UI.
//
// The analysis runs at ~94 Hz and the frame object is reused, so no Svelte
// component can subscribe to it directly without re-rendering ninety times a
// second for a label that changes every few bars. This store is written four
// times a second, and only when something actually changed.
export const readout = writable({
  bpm: 0,
  locked: false,
  confidence: 0,
  style: "",
  styleLabel: "",
  styleConfidence: 0,
  kick: "",
  archetype: "",
  served: false,
});
let lastReadout = 0;
const readoutState = {
  bpm: 0, locked: false, confidence: 0, style: "", styleLabel: "",
  styleConfidence: 0, kick: "", archetype: "", served: false,
};

function publishReadout(now) {
  if (now - lastReadout < 0.25) return;
  lastReadout = now;
  const b = shownBeat;
  const st = frame.style;
  // Round the tempo before comparing: an unrounded BPM wanders by hundredths
  // every estimate, so every single publish would count as a change.
  const bpm = b.locked ? Math.round(b.bpm) : 0;
  const style = st?.dominant || "";
  const kick = st?.kick?.type || "";
  if (
    bpm === readoutState.bpm &&
    b.locked === readoutState.locked &&
    style === readoutState.style &&
    kick === readoutState.kick &&
    !!verdict === readoutState.served &&
    Math.abs(b.confidence - readoutState.confidence) < 0.05 &&
    Math.abs((st?.confidence || 0) - readoutState.styleConfidence) < 0.05
  )
    return;
  readoutState.bpm = bpm;
  readoutState.locked = b.locked;
  readoutState.confidence = b.confidence;
  readoutState.style = style;
  readoutState.styleLabel = st?.dominantLabel || "";
  readoutState.styleConfidence = st?.confidence || 0;
  readoutState.kick = kick;
  readoutState.archetype = st?.archetype || "";
  readoutState.served = !!verdict;
  readout.set({ ...readoutState });
}

export const frame = {
  t: 0,
  dt: 1 / 60,
  bands: new Float32Array(BAND_COUNT),
  bandsDb: new Float32Array(BAND_COUNT),
  centers: new Float32Array(BAND_COUNT),
  energy: energyLin,
  energyDb,
  features: null,
  beat: shownBeat,
  style: null,
  level: LEVEL.SPECTRUM,
  silent: true,
  trackId: null,
};

function ensureState() {
  const ctx = getContext();
  const an = getAnalysers();
  if (!ctx || !an) return false;
  if (plans && plans.sampleRate === ctx.sampleRate) return true;
  // The graph has just appeared, which is the first moment an AudioWorklet can
  // be created. Take it: this is what gets the engine off rAF.
  upgradeClock();
  const sampleRate = ctx.sampleRate;
  plans = {
    sampleRate,
    band: buildBandPlan({ bands: BAND_COUNT, sampleRate, fftLo: FFT_LO, fftHi: FFT_HI }),
    energy: buildEnergyPlan({ sampleRate, fftLo: FFT_LO, fftHi: FFT_HI }),
  };
  frame.centers.set(plans.band.centers);
  loData = new Float32Array(an.lo.frequencyBinCount);
  hiData = new Float32Array(an.hi.frequencyBinCount);
  features = createFeatureExtractor({ sampleRate, fftHi: FFT_HI, floorDb: FLOOR_DB });
  beatTracker = createBeatTracker();
  classifier = createStyleClassifier();
  return true;
}

function resetAnalysis() {
  features?.reset();
  beatTracker?.reset();
  classifier?.reset();
  onsetQueue.length = 0;
  prevShownIndex = -1;
  verdict = null;
  verdictSeeded = false;
}

// Ask for this track and the next few in one call. Done from here rather than
// from the player because the engine is the only thing that wants them: a
// session that never opens a visualizer never makes the request.
function primeAround(id) {
  const s = get(player);
  const ids = [];
  if (id) ids.push(id);
  if (s && s.index >= 0)
    for (let i = 1; i <= ANALYSIS_WINDOW; i++) {
      const t = s.queue[s.index + i];
      if (t?.deezer_id) ids.push(t.deezer_id);
    }
  primeAnalyses(ids);
}

// Adopt the served verdict as soon as it is in hand — which may be at the track
// change, or a moment later when the request lands. Seeding the tempo is the
// part that matters: the tracker starts locked on a figure measured over the
// whole piece, so the first bar is already on the beat instead of the fourth.
function adoptVerdict(id) {
  if (verdictSeeded || !id) return;
  const v = knownAnalysis(id);
  if (!v) return;
  verdict = v;
  verdictSeeded = true;
  if (v.bpm && beatTracker) beatTracker.seed(v.bpm, v.bpmConfidence ?? 0.9);
}

function tick(now) {
  const an = getAnalysers();
  if (!an || !ensureState()) return;
  const dt = lastT ? Math.min(0.25, Math.max(0.001, now - lastT)) : 1 / 60;
  lastT = now;

  // A track change must not let the previous track's tempo, whitening state or
  // style verdict bleed into the new one — they would fight the new evidence
  // for several seconds, which is most of what a listener would notice.
  const id = get(current)?.deezer_id ?? null;
  if (id !== lastTrackId) {
    lastTrackId = id;
    frame.trackId = id;
    resetAnalysis();
    primeAround(id);
  }
  // The request may land after the track started; a Map lookup a frame is
  // nothing, and it stops once the verdict is adopted.
  if (!verdictSeeded) adoptVerdict(id);

  an.lo.getFloatFrequencyData(loData);
  an.hi.getFloatFrequencyData(hiData);

  readBands(plans.band, loData, hiData, frame.bandsDb, frame.bands, FLOOR_DB, CEIL_DB);
  readEnergy(plans.energy, loData, hiData, energyDb, FLOOR_DB);
  for (let i = 0; i < ENERGY_BANDS.length; i++)
    energyLin[ENERGY_BANDS[i][0]] = Math.pow(10, energyDb[i] / 10);

  const f = features.process(hiData, dt);
  frame.features = f;
  frame.silent = f.silent;
  frame.t = now;
  frame.dt = dt;
  frame.level = analysisLevel;

  if (analysisLevel >= LEVEL.RHYTHM) {
    const b = beatTracker.process(f.flux, f.lowFlux, dt);
    projectBeat(b, now);
    if (analysisLevel >= LEVEL.SMART) {
      const live = classifier.process(f, b, energyLin, now, dt);
      // Where the server has measured the track, ITS verdict is the authority:
      // it heard the whole piece, this one has heard a few seconds of it. The
      // kick stays the live reading either way — that is a per-event property
      // and no whole-file average can stand in for it.
      frame.style = verdict ? merged(live, verdict) : live;
    }
  } else if (shownBeat.locked || frame.style) {
    // Dropped out of rhythm analysis: park the grid rather than leave a stale
    // one advancing on its own, and drop a style verdict nothing is refreshing.
    shownBeat.locked = false;
    shownBeat.beat = false;
    shownBeat.downbeat = false;
    shownBeat.onset = 0;
    frame.style = null;
  }

  if (analysisLevel >= LEVEL.RHYTHM) publishReadout(now);

  for (let i = 0; i < subs.length; i++) {
    try {
      subs[i].fn(frame);
    } catch {
      /* a broken subscriber must not stop the others */
    }
  }
}

// The served verdict, wearing the shape the scenes already read.
const mergedStyle = {
  kick: null,
  families: [],
  archetypes: { sustain: 0, voice: 0, groove: 0, hard: 0, rock: 0 },
  dominant: "",
  dominantLabel: "",
  archetype: "groove",
  confidence: 0,
  served: true,
};

function merged(live, v) {
  mergedStyle.kick = live.kick;
  mergedStyle.families = live.families;
  mergedStyle.dominant = v.style || live.dominant;
  mergedStyle.dominantLabel = v.styleLabel || live.dominantLabel;
  mergedStyle.archetype = v.archetype || live.archetype;
  mergedStyle.confidence = v.styleConfidence ?? live.confidence;
  const a = v.archetypes;
  if (a && typeof a === "object") {
    let sum = 0;
    for (const k in mergedStyle.archetypes) sum += +a[k] || 0;
    for (const k in mergedStyle.archetypes)
      mergedStyle.archetypes[k] = sum > 1e-6 ? (+a[k] || 0) / sum : live.archetypes[k];
  } else {
    for (const k in mergedStyle.archetypes) mergedStyle.archetypes[k] = live.archetypes[k];
  }
  return mergedStyle;
}

// Re-express the beat grid on the listener's timeline and release held onsets.
function projectBeat(b, now) {
  const delay = lookaheadSeconds();
  const period = Math.max(0.05, b.period);
  // A continuous beat position, so a look-ahead longer than one beat (possible
  // above 200 BPM) still maps correctly instead of wrapping into the wrong bar.
  const pos = b.beatIndex + b.phase - delay / period;
  const idx = Math.floor(pos);
  const phase = pos - idx;
  const beatsPerBar = b.beatsPerBar;
  // b.barPos is the bar position of b.beatIndex; carry it back to `idx`.
  const barPos = (((idx - (b.beatIndex - b.barPos)) % beatsPerBar) + beatsPerBar) % beatsPerBar;

  const isBeat = prevShownIndex >= 0 && idx > prevShownIndex && b.locked;
  prevShownIndex = idx;

  shownBeat.bpm = b.bpm;
  shownBeat.confidence = b.confidence;
  shownBeat.phase = phase;
  shownBeat.beat = isBeat;
  shownBeat.beatIndex = idx;
  shownBeat.barPos = barPos;
  shownBeat.beatsPerBar = beatsPerBar;
  shownBeat.downbeat = isBeat && barPos === 0;
  shownBeat.kickPulse = b.kickPulse;
  shownBeat.sinceBeat = phase * period;
  shownBeat.period = period;
  shownBeat.locked = b.locked;

  // Onsets are detected on the analyser's timeline, so with a look-ahead they
  // are in hand before the sound is out. Hold each one until its moment.
  if (b.onset > 0) onsetQueue.push({ at: now + delay, v: b.onset });
  let onset = 0;
  while (onsetQueue.length && onsetQueue[0].at <= now) {
    const o = onsetQueue.shift();
    if (o.v > onset) onset = o.v;
  }
  shownBeat.onset = onset;
}

// --- the clock --------------------------------------------------------------
// A processor that outputs nothing and exists only to post a message from the
// audio thread. Shipped as a Blob so no bundler configuration can break it.
const TICK_SOURCE = `
class NsTick extends AudioWorkletProcessor {
  constructor() { super(); this.n = 0; }
  process() {
    // One render quantum is 128 frames (~2.7 ms at 48 kHz). Every 4th quantum
    // is ~94 Hz, which lines up with the 100 Hz onset grid in tempo.js closely
    // enough that its resampler has almost nothing to do.
    if (++this.n >= 4) { this.n = 0; this.port.postMessage(currentTime); }
    return true;
  }
}
registerProcessor('ns-tick', NsTick);
`;

let workletUrl = null;
let workletReady = null;

function startRafClock() {
  let id = 0;
  const loop = () => {
    id = requestAnimationFrame(loop);
    tick(performance.now() / 1000);
  };
  id = requestAnimationFrame(loop);
  return {
    stop() {
      cancelAnimationFrame(id);
    },
  };
}

async function startWorkletClock(ctx) {
  if (!ctx.audioWorklet) return null;
  if (!workletReady) {
    workletUrl = URL.createObjectURL(new Blob([TICK_SOURCE], { type: "text/javascript" }));
    workletReady = ctx.audioWorklet
      .addModule(workletUrl)
      .then(() => true)
      .catch(() => false);
  }
  if (!(await workletReady)) return null;
  try {
    const node = new AudioWorkletNode(ctx, "ns-tick", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    // A node nothing listens to may never be pulled, so give it a silent path
    // to the destination. This also keeps the context from idling out, which is
    // the other half of "the feed survives a hidden tab".
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);
    node.port.onmessage = (e) => tick(e.data);
    return {
      stop() {
        node.port.onmessage = null;
        try {
          node.disconnect();
          mute.disconnect();
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return null;
  }
}

function start() {
  if (running) return;
  running = true;
  requestAnalyser();
  resumeAudio();
  lastT = 0;
  // rAF carries the first frames while the worklet module compiles — and, when
  // there is no graph yet, until there is one.
  clock = startRafClock();
  clockKind = "raf";
  upgradeClock();
}

// Move off rAF as soon as an AudioContext exists. Idempotent and safe to call
// from anywhere; it no-ops once the audio-thread clock is running.
async function upgradeClock() {
  if (!running || clockKind === "worklet" || upgrading) return;
  const ctx = getContext();
  if (!ctx) return; // ensureState calls back the moment one exists
  upgrading = true;
  try {
    const w = await startWorkletClock(ctx);
    if (!w) return;
    if (!running || clockKind === "worklet") {
      w.stop();
      return;
    }
    clock?.stop();
    clock = w;
    clockKind = "worklet";
  } finally {
    upgrading = false;
  }
}

function stop() {
  running = false;
  clock?.stop();
  clock = null;
  clockKind = "none";
  lastT = 0;
}

function refresh() {
  const want = subs.length > 0 && (backgroundOk || !document.hidden);
  if (want && !running) start();
  else if (!want && running) stop();
}

if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", refresh);

/**
 * Receive an analysis frame. The frame object is REUSED between calls — read
 * what you need inside the callback, never keep a reference to it.
 * @param {(f: typeof frame) => void} fn
 * @param {number} level one of LEVEL.*
 */
export function subscribeFrames(fn, level = LEVEL.SPECTRUM) {
  const entry = { fn, level };
  subs = subs.concat(entry);
  recomputeLevel();
  refresh();
  return () => {
    subs = subs.filter((s) => s !== entry);
    recomputeLevel();
    refresh();
  };
}

function recomputeLevel() {
  let lv = LEVEL.SPECTRUM;
  for (const s of subs) if (s.level > lv) lv = s.level;
  if (lv !== analysisLevel) {
    analysisLevel = lv;
    // Coming back up to rhythm/smart with stale internal state would produce a
    // confident but wrong verdict for a few seconds.
    if (lv > LEVEL.SPECTRUM) resetAnalysis();
  }
}

// A projector page is listening: keep analysing even while this tab is hidden.
export function setBackgroundAnalysis(on) {
  backgroundOk = !!on;
  refresh();
}

export function currentLevel() {
  return analysisLevel;
}
