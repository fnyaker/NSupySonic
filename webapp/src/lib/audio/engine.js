// The single analysis engine: one analyser, one frame object every subscriber
// reads. Everything visual in the app — the bars in the player, the smart
// scenes, the projector page — hangs off this.
//
// It is refcounted. Nothing here runs until a view asks for frames, and it all
// stops again when the last one goes away, so the default app (no visualizer
// open) pays nothing at all.
//
// THE ANALYSIS RUNS ON THE AUDIO THREAD, IN RUST. webapp/rhythm is compiled to
// rhythm.wasm and hosted by an AudioWorklet (rhythm.worklet.js) fed straight
// from the graph: every sample is analysed exactly once, in order, whatever
// the main thread is doing. The JavaScript chain it replaces ran on the main
// thread off AnalyserNode snapshots, so a long task — a route change, a big
// list, a GC — delayed or skipped a frame, and a skipped frame was a missed
// kick; that is where the "small slowdowns" came from. What is left here is
// delivery and bookkeeping:
//
// 1. EACH FRAME IS DELIVERED WHEN ITS AUDIO IS HEARD. The worklet stamps every
//    frame with the context time its audio passed the tap; the output
//    timestamp (getOutputTimestamp, median of recent readings) says when that
//    context time reaches the speakers, and the look-ahead delay — the tap is
//    BEFORE it — is added on top. A frame that arrives early waits in a queue
//    for its moment; one that arrives late (the analysis needs ~45 ms of audio
//    past an event to be sure of it, more than a desktop's output latency) is
//    delivered at once, and the beat grid is PROJECTED to the instant being
//    heard, so predicted beats stay on time either way. With a look-ahead of
//    50 ms or more every event lands exactly on time.
//
// 2. ONE PASS, SHARED. The frame is decoded once and handed out by reference,
//    so a second view on screen costs a function call.
//
// 3. THE TRACK IS THE UNIT. A track change resets the analyser (a generation
//    counter drops whatever frames of the old track were still in flight), and
//    the server's whole-track verdict is adopted the moment it is in hand: its
//    tempo range and its BPM go to the analyser, which starts the grid on them.
//
// If the worklet or the WebAssembly cannot start (a browser without either, a
// module that failed to load offline), the engine falls back to the spectrum
// alone, read from the graph's AnalyserNodes: the bars keep drawing, and the
// rhythm-driven scenes see an unlocked grid, exactly as they did before the
// first beat of any track.

import { get, writable } from "svelte/store";
import { current, player } from "../stores.js";
import { knownAnalysis, onAnalysis, primeAnalyses } from "../analysis.js";
import {
  getAnalysers,
  getContext,
  requestAnalyser,
  requestScope,
  releaseScope,
  setScopeWindow,
  readScope,
  resumeAudio,
  lookaheadSeconds,
  tapRhythm,
  untapRhythm,
  FFT_LO,
  FFT_HI,
} from "./graph.js";
import { buildBandPlan, buildEnergyPlan, readBands, readEnergy, ENERGY_BANDS } from "./spectrum.js";
import {
  familyAt,
  familyLook,
  familyTable,
  tempoRangeFor,
  ARCHETYPES,
  KICK_TYPES,
  LOOK_KEYS,
} from "./style.js";
import { parseLayout } from "./rhythm-core.js";

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
// THE RAW WAVEFORM IS NOT A LEVEL, it is orthogonal to all three. An
// oscilloscope wants the samples and nothing else — no beat grid, no
// classifier — while a smart scene wants the whole ladder and no samples, so
// folding the two into one number would have made the scope pay for a beat
// tracker it never reads. It is asked for per subscriber instead
// (`subscribeFrames(fn, level, { wave: samples })`), and the engine takes the
// largest window anyone wants, exactly as it takes the deepest level.
let waveWant = 0;
let subs = [];
let running = false;
let backgroundOk = false; // a projector page is listening: keep going when hidden
let lastTrackId;
// The server's whole-track verdict for whatever is playing, once it arrives.
// See lib/analysis.js: it is an accelerator, never a dependency.
let verdict = null;
let verdictSeeded = false;
// The tempo last handed to the tracker for this track. A later verdict with the
// same figure is not sent again: the first may have been a published tempo the
// kicks have since doubled (a hardcore track Deezer lists at half), and seeding
// the same number a second time would put the grid back at half speed.
let seededBpm = 0;
// How many tracks ahead to ask for. The queue moves one at a time and the
// answers are tiny, so a short window keeps every upcoming track's verdict in
// hand well before it starts.
const ANALYSIS_WINDOW = 6;

// --- the frame ----------------------------------------------------------------

const energyLin = { sub: 0, bass: 0, lowMid: 0, mid: 0, high: 0, air: 0 };
const energyDb = new Float32Array(ENERGY_BANDS.length);

const features = {
  level: 0,
  levelDb: FLOOR_DB,
  peak: 0,
  crest: 0,
  dynamics: 0,
  loudRefDb: FLOOR_DB,
  flux: 0,
  lowFlux: 0,
  midFlux: 0,
  highFlux: 0,
  kick: 0,
  kickHit: false,
  kickStrength: 0,
  snareHit: false,
  centroid: 0,
  centroidN: 0,
  flatness: 0,
  rolloff: 0,
  rolloffN: 0,
  percussivity: 0,
  vocalMod: 0,
  chroma: new Float32Array(12),
  tonal: 0,
  melody: 0,
  melodyPitch: 0,
  melodyFlux: 0,
  chordChange: 0,
  silent: true,
};

// The grid as the analyser reported it at the frame's own instant...
const rawBeat = {
  bpm: 0,
  confidence: 0,
  phase: 0,
  beatIndex: 0,
  barPos: 0,
  beatsPerBar: 4,
  onset: 0,
  kickPulse: 0,
  period: 0.5,
  locked: false,
  phraseBar: 0,
  clarity: 0,
  offbeat: 0,
};
// ...and as the listener hears it (see `projectBeat`).
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
  phraseBar: 0,
  clarity: 0,
  offbeat: 0,
};

// The MUSICAL reading: main kick vs roll note, drop, build, breakdown.
const patternOut = {
  mainKick: false,
  mainPower: 0,
  bigKick: false,
  rollKick: false,
  roll: 0,
  rollDiv: 0,
  rollNotes: 0,
  drop: false,
  sinceDrop: 999,
  dropped: 0,
  breakdown: 0,
  build: 0,
  energy: 1,
  pause: false,
  // 0 unknown, 1 full, 2 breakdown, 3 build, 4 pause (rhythm/src/pattern.rs)
  section: 0,
  // Beats until the phrase a build is heading for turns over, or -1.
  dropIn: -1,
};

const styleLook = {};
for (const k of LOOK_KEYS) styleLook[k] = 0.5;
const styleArch = {};
for (const k of ARCHETYPES) styleArch[k] = 0.2;
const styleFamilies = [
  { id: "", label: "", weight: 0 },
  { id: "", label: "", weight: 0 },
  { id: "", label: "", weight: 0 },
];
const styleOut = {
  kick: {
    type: "soft",
    strength: 0,
    attack: 0,
    decay: 0,
    click: 0,
    grit: 0,
    hit: false,
    soft: 1 / 3,
    hard: 1 / 3,
    industrial: 1 / 3,
  },
  families: styleFamilies,
  archetypes: styleArch,
  look: styleLook,
  dominant: "",
  dominantLabel: "",
  archetype: "groove",
  confidence: 0,
};

// What the GENRE-SPECIFIC layer hears (rhythm/src/genre.rs): the things one
// hard subgenre is made of and its neighbour is not, as 0..1 channels a scene
// can read directly — a zaag buzz and a Deutscher Krach kick are not the same
// picture, and neither is techno's.
export const GENRE_KEYS = ["lead", "buzz", "screech", "sub", "offbeat", "density", "tail", "grit"];
const genreOut = {};
for (const k of GENRE_KEYS) genreOut[k] = 0;

export const frame = {
  t: 0,
  dt: 1 / 94,
  bands: new Float32Array(BAND_COUNT),
  bandsDb: new Float32Array(BAND_COUNT).fill(FLOOR_DB),
  centers: new Float32Array(BAND_COUNT),
  energy: energyLin,
  energyDb,
  features: null,
  beat: shownBeat,
  // Null until the engine is running at rhythm level.
  pattern: null,
  // The raw samples, PER CHANNEL: { left, right, size, sampleRate }, oldest
  // first. Null unless a subscriber asked for them — see `waveWant`. The arrays
  // are reused between frames like everything else here.
  wave: null,
  style: null,
  genre: null,
  level: LEVEL.SPECTRUM,
  silent: true,
  trackId: null,
  // Diagnostics (the browser bench reads them): the context time this frame's
  // audio passed the analyser's tap, and how late it was handed out relative
  // to the moment that audio reached the listener (0 when it was held until
  // then).
  ctxT: 0,
  lateBy: 0,
};

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
  // Where the tempo came from: "server", "deezer" (published, not yet checked
  // against the file) or "" (the tracker's own).
  served: "",
});
let lastReadout = 0;
const readoutState = {
  bpm: 0, locked: false, confidence: 0, style: "", styleLabel: "",
  styleConfidence: 0, kick: "", archetype: "", served: "",
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
    servedFrom() === readoutState.served &&
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
  readoutState.served = servedFrom();
  readout.set({ ...readoutState });
}

// --- the served verdict ---------------------------------------------------------

// Where the tempo on screen came from, for the settings readout: "server" once
// the track has been measured, "deezer" while only its published figure is in
// hand, "" when the tracker found it alone.
function servedFrom() {
  if (!verdict?.bpm) return "";
  return verdict.provisional ? "deezer" : "server";
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
// part that matters: the analyser starts its grid on a figure measured over the
// whole piece, so the first bar is already on the beat instead of the fourth.
//
// `id` is explicit rather than read from the store because a late listener runs
// after the fact: it adopts the verdict for the track it was told about, and
// only while that track is still the one playing — a verdict arriving after a
// skip is a verdict for a track nobody is hearing.
function adoptVerdict(id, late = false) {
  if (!id) return;
  if (!late && verdictSeeded) return;
  if (late && get(current)?.deezer_id !== id) return;
  const v = knownAnalysis(id);
  if (!v) return;
  verdict = v;
  verdictSeeded = true;
  // THE TEMPO RANGE FIRST, because it changes what the tracker finds plausible
  // and the seed is read against it. The genre is the one piece of information
  // that settles the octave question, which no amount of signal processing can:
  // 250 BPM uptempo and 125 BPM house produce the same autocorrelation. A
  // served genre also retires the live classifier's say in it.
  const range = tempoRangeFor(v.style || v.styleLabel || "");
  if (range) send({ t: "range", lo: range[0], hi: range[1] });
  send({ t: "liveRange", on: !range });
  // ...and the figure itself, WHETHER OR NOT the grid has already locked: the
  // verdict comes over the network, behind the audio in the request ladder,
  // and a late seed moves the grid's LEVEL while keeping its phase, so it
  // cannot make the animation jump (rhythm/src/tempo.rs#seed).
  if (v.bpm && Math.abs(+v.bpm / (seededBpm || 1) - 1) > 0.01) {
    send({ t: "seed", bpm: +v.bpm, conf: v.bpmConfidence ?? 0.9 });
    seededBpm = +v.bpm;
  }
}

// A verdict that lands late — the server had to measure the track first, or an
// admin just tagged it — is applied to the running track instead of waiting for
// the next play. This is the whole point of the `pending` handshake.
onAnalysis((id, v) => {
  if (v) adoptVerdict(id, true);
});

// --- the analyser ----------------------------------------------------------------

// The rhythm node and what its "ready" message said about the frames.
let rh = null; // { node, ready, I (offsets), hop, lookahead, sampleRate }
let rhStarting = false;
let rhFailed = false;
let gen = 0;
// Frames waiting for their audio to reach the listener: { buf, ctxT }.
const pending = [];
let lastCtxT = 0;

let assets = null;
function loadAssets() {
  if (!assets)
    assets = import("./rhythm-assets.js")
      .then(async ({ rhythmWasmUrl, workletUrl }) => {
        const res = await fetch(rhythmWasmUrl());
        if (!res.ok) throw new Error(`rhythm.wasm: HTTP ${res.status}`);
        const bytes = await res.arrayBuffer();
        const module = await WebAssembly.compile(bytes);
        return { bytes, module, workletUrl };
      })
      .catch((err) => {
        assets = null; // offline and not cached yet: try again next time
        throw err;
      });
  return assets;
}

const addedTo = new WeakMap(); // AudioContext -> addModule promise

async function startRhythm() {
  if (rh || rhStarting || rhFailed) return;
  const ctx = getContext();
  if (!ctx || !ctx.audioWorklet || typeof WebAssembly === "undefined") {
    if (ctx) rhFailed = true;
    return;
  }
  rhStarting = true;
  try {
    const a = await loadAssets();
    let added = addedTo.get(ctx);
    if (!added) {
      added = ctx.audioWorklet.addModule(a.workletUrl);
      addedTo.set(ctx, added);
    }
    await added;
    if (!running || rh) return;
    const options = {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: {
        module: a.module,
        level: analysisLevel,
        families: familyTable(),
        gen,
        liveRange: true,
      },
    };
    let node;
    try {
      node = new AudioWorkletNode(ctx, "ns-rhythm", options);
    } catch {
      // A browser that cannot clone a compiled module into the worklet: send
      // the bytes, and let the worklet compile them off the main thread.
      const { module, ...rest } = options.processorOptions;
      void module;
      options.processorOptions = { ...rest, bytes: a.bytes.slice(0) };
      node = new AudioWorkletNode(ctx, "ns-rhythm", options);
    }
    const r = { node, ready: false, I: null, hop: 512, lookahead: 4, sampleRate: ctx.sampleRate };
    node.port.onmessage = (e) => onRhythmMessage(r, e.data);
    node.onprocessorerror = () => failRhythm(r);
    if (!tapRhythm(node)) throw new Error("the graph has no output to tap");
    rh = r;
    if (!running) sleepRhythm(true);
  } catch (err) {
    console.warn("rhythm analyser unavailable, spectrum only:", err);
    rhFailed = true;
  } finally {
    rhStarting = false;
  }
}

function failRhythm(r) {
  if (rh !== r) return;
  untapRhythm();
  rh = null;
  rhFailed = true;
  pending.length = 0; // their buffers belonged to the node that just died
  if (running) startFallback();
}

// A node that has not started yet needs none of this: it is created with the
// current level and generation, and the verdict is re-applied the moment it
// says it is ready.
function send(m) {
  if (rh) rh.node.port.postMessage(m);
}

function sleepRhythm(on) {
  if (rh) rh.node.port.postMessage({ t: "sleep", on });
}

function recycle(buf) {
  if (rh && buf) rh.node.port.postMessage({ t: "recycle", buf }, [buf.buffer]);
}

function onRhythmMessage(r, m) {
  if (!m || rh !== r) return;
  if (m.t === "f") {
    if (!r.ready || m.gen !== gen) {
      recycle(m.buf);
      return;
    }
    const j = m.buf[r.I.frame];
    // The frame's audio passed the tap `pushed - j·hop` samples before the end
    // of the quantum that produced it.
    const ctxT = m.end - (m.pushed - j * r.hop) / r.sampleRate;
    pending.push({ buf: m.buf, ctxT });
    sampleClock();
    pump();
  } else if (m.t === "ready") {
    const layout = parseLayout(m.layout);
    const I = {};
    for (const k in layout.fields) I[k] = layout.fields[k][0];
    r.I = I;
    r.hop = m.hop;
    r.lookahead = m.lookahead;
    r.sampleRate = m.sampleRate;
    r.ready = true;
    verdictSeeded = false;
    stopFallback();
  } else if (m.t === "error") {
    console.warn("rhythm analyser failed to start:", m.message);
    failRhythm(r);
  }
}

// --- when is a frame heard? ---------------------------------------------------------
//
// getOutputTimestamp() says which context time is reaching the speakers at
// which performance time, output latency included. A single reading is noisy
// (the first ones after a start are ~140 ms off, lib/party measured it), so the
// offset is the median of recent readings, outliers refused until they
// persist.
const offsets = [];
let lastStampCtx = -1;
let offsetMedian = null;
let sinceMedian = 0;

function sampleClock() {
  const ctx = getContext();
  if (!ctx || ctx.state !== "running") return;
  let d = null;
  try {
    const ts = typeof ctx.getOutputTimestamp === "function" ? ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0 && ts.contextTime > 0 && ts.contextTime !== lastStampCtx) {
      lastStampCtx = ts.contextTime;
      d = ts.contextTime - ts.performanceTime / 1000;
    }
  } catch {
    /* not supported */
  }
  if (d == null) {
    // No output timestamp: the context clock, less what the context says its
    // own output latency is.
    d = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) - performance.now() / 1000;
  }
  if (offsetMedian != null && Math.abs(d - offsetMedian) > 0.05 && offsets.length >= 9) {
    // One wild reading is noise; a run of them means the mapping really moved.
    if (++sinceMedian < 12) return;
    offsets.length = 0;
  }
  sinceMedian = 0;
  offsets.push(d);
  if (offsets.length > 25) offsets.shift();
  if (offsets.length % 3 === 0 || offsetMedian == null) {
    const s = offsets.slice().sort((a, b) => a - b);
    offsetMedian = s[s.length >> 1];
  }
}

// The analysis-side context time the listener is hearing right now.
function heardCtxNow(nowMs) {
  if (offsetMedian == null) return null;
  return nowMs / 1000 + offsetMedian - lookaheadSeconds();
}

// Release every frame whose audio has reached the listener. Driven by the
// worklet's own messages (which a hidden tab does not throttle) and, while the
// page is visible, by rAF — so a frame held for a long look-ahead is not up to
// one message late.
function pump() {
  if (!pending.length) return;
  const nowMs = performance.now();
  const heard = heardCtxNow(nowMs);
  while (pending.length) {
    const q = pending[0];
    // Never hold a frame more than 0.8 s: past that the mapping is wrong (a
    // context that just resumed, a timestamp not valid yet), not the latency.
    if (heard != null && q.ctxT > heard + 0.001 && q.ctxT - heard < 0.8) break;
    pending.shift();
    deliver(q, nowMs, heard);
  }
}

let rafId = 0;
function rafPump() {
  rafId = 0;
  if (!running) return;
  if (rh && rh.ready) pump();
  else fallbackTick();
  if (typeof document === "undefined" || !document.hidden) rafId = requestAnimationFrame(rafPump);
}

// --- decoding -----------------------------------------------------------------------

function deliver(q, nowMs, heard) {
  const buf = q.buf;
  const I = rh.I;
  // A track change must not let the previous track's tempo, whitening state or
  // style verdict bleed into the new one — they would fight the new evidence
  // for several seconds, which is most of what a listener would notice.
  const id = get(current)?.deezer_id ?? null;
  if (id !== lastTrackId) {
    newTrack(id);
    recycle(buf);
    return;
  }
  if (!verdictSeeded) adoptVerdict(id);

  const dt = lastCtxT ? Math.min(0.25, Math.max(0.001, q.ctxT - lastCtxT)) : rh.hop / rh.sampleRate;
  lastCtxT = q.ctxT;

  frame.bands.set(buf.subarray(I.bands, I.bands + BAND_COUNT));
  const span = CEIL_DB - FLOOR_DB;
  for (let i = 0; i < BAND_COUNT; i++) frame.bandsDb[i] = FLOOR_DB + frame.bands[i] * span;
  for (let i = 0; i < ENERGY_BANDS.length; i++) {
    energyDb[i] = buf[I.energyDb + i];
    energyLin[ENERGY_BANDS[i][0]] = buf[I.energy + i];
  }

  const f = features;
  f.level = buf[I.level];
  f.levelDb = buf[I.levelDb];
  f.peak = buf[I.peak];
  f.crest = buf[I.crest];
  f.dynamics = buf[I.dynamics];
  f.loudRefDb = buf[I.loudRefDb];
  f.flux = buf[I.flux];
  f.lowFlux = buf[I.lowFlux];
  f.midFlux = buf[I.midFlux];
  f.highFlux = buf[I.highFlux];
  f.kick = buf[I.kick];
  f.kickHit = buf[I.kickHit] > 0;
  f.kickStrength = buf[I.kickStrength];
  f.snareHit = buf[I.snareHit] > 0;
  f.centroid = buf[I.centroid];
  f.centroidN = buf[I.centroidN];
  f.flatness = buf[I.flatness];
  f.rolloff = buf[I.rolloff];
  f.rolloffN = buf[I.rolloffN];
  f.percussivity = buf[I.percussivity];
  f.vocalMod = buf[I.vocalMod];
  f.chroma.set(buf.subarray(I.chroma, I.chroma + 12));
  f.tonal = buf[I.tonal];
  f.melody = buf[I.melody];
  f.melodyPitch = buf[I.melodyPitch];
  f.melodyFlux = buf[I.melodyFlux];
  f.chordChange = buf[I.chordChange];
  f.silent = buf[I.silent] > 0;
  frame.features = f;
  frame.silent = f.silent;
  frame.t = nowMs / 1000;
  frame.dt = dt;
  frame.level = analysisLevel;
  frame.trackId = id;
  frame.ctxT = q.ctxT;
  frame.lateBy = heard == null ? 0 : Math.max(0, heard - q.ctxT);
  // Two more memcpys out of the scope's ring buffers, and only when a scope is
  // on screen. Null the rest of the time so a scene can tell "nobody is
  // tapping" from "the tap read silence".
  frame.wave = waveWant ? readScope() : null;

  if (analysisLevel >= LEVEL.RHYTHM) {
    const b = rawBeat;
    b.bpm = buf[I.bpm];
    b.confidence = buf[I.confidence];
    b.phase = buf[I.phase];
    b.beatIndex = buf[I.beatIndex];
    b.barPos = buf[I.barPos];
    b.beatsPerBar = buf[I.beatsPerBar] || 4;
    b.onset = buf[I.onset];
    b.kickPulse = buf[I.kickPulse];
    b.period = buf[I.period];
    b.locked = buf[I.locked] > 0;
    b.phraseBar = buf[I.phraseBar];
    b.clarity = buf[I.clarity];
    b.offbeat = buf[I.offbeat];
    // How far the listener already is past this frame's instant (0 when it
    // was held until its moment).
    projectBeat(heard == null ? 0 : Math.max(0, heard - q.ctxT));

    const p = patternOut;
    p.mainKick = buf[I.mainKick] > 0;
    p.mainPower = buf[I.mainPower];
    p.bigKick = buf[I.bigKick] > 0;
    p.rollKick = buf[I.rollKick] > 0;
    p.roll = buf[I.roll];
    p.rollDiv = buf[I.rollDiv];
    p.rollNotes = buf[I.rollNotes];
    p.drop = buf[I.drop] > 0;
    p.sinceDrop = buf[I.sinceDrop];
    p.dropped = buf[I.dropped];
    p.breakdown = buf[I.breakdown];
    p.build = buf[I.build];
    p.energy = buf[I.energyRel];
    p.pause = buf[I.pause] > 0;
    p.section = buf[I.section];
    p.dropIn = buf[I.dropIn];
    frame.pattern = p;

    if (analysisLevel >= LEVEL.SMART) {
      decodeStyle(buf, I);
      // Where the server has measured the track, ITS verdict is the authority:
      // it heard the whole piece, this one has heard a few seconds of it. The
      // kick stays the live reading either way — that is a per-event property
      // and no whole-file average can stand in for it.
      // A verdict that is only a published tempo names no style: the live
      // reading stands until the measured one arrives.
      frame.style = verdict?.style ? merged(styleOut, verdict) : styleOut;
      for (let i = 0; i < GENRE_KEYS.length; i++) genreOut[GENRE_KEYS[i]] = buf[I.genre + i];
      frame.genre = genreOut;
    } else {
      frame.style = null;
      frame.genre = null;
    }
  } else {
    parkBeat();
    frame.pattern = null;
    frame.style = null;
    frame.genre = null;
  }
  recycle(buf);

  if (analysisLevel >= LEVEL.RHYTHM) publishReadout(frame.t);
  emit();
}

function decodeStyle(buf, I) {
  const s = styleOut;
  const dom = familyAt(Math.round(buf[I.styleDominant]));
  s.dominant = dom ? dom.id : "";
  s.dominantLabel = dom ? dom.label : "";
  s.confidence = buf[I.styleConfidence];
  let best = 0;
  for (let i = 0; i < ARCHETYPES.length; i++) {
    const v = buf[I.archetypes + i];
    styleArch[ARCHETYPES[i]] = v;
    if (v > buf[I.archetypes + best]) best = i;
  }
  s.archetype = ARCHETYPES[best];
  for (let i = 0; i < LOOK_KEYS.length; i++) styleLook[LOOK_KEYS[i]] = buf[I.look + i];
  for (let i = 0; i < 3; i++) {
    const fam = familyAt(Math.round(buf[I.styleTop + i * 2]));
    styleFamilies[i].id = fam ? fam.id : "";
    styleFamilies[i].label = fam ? fam.label : "";
    styleFamilies[i].weight = fam ? buf[I.styleTop + i * 2 + 1] : 0;
  }
  const k = s.kick;
  k.type = KICK_TYPES[Math.round(buf[I.kickType])] || "soft";
  k.strength = buf[I.kickShapeStrength];
  k.attack = buf[I.kickAttack];
  k.decay = buf[I.kickDecay];
  k.click = buf[I.kickClick];
  k.grit = buf[I.kickGrit];
  k.hit = buf[I.kickShapeHit] > 0;
  k.soft = buf[I.kickSoft];
  k.hard = buf[I.kickHard];
  k.industrial = buf[I.kickIndus];
}

// Re-express the beat grid at the instant the listener is hearing, `ahead`
// seconds past the frame's own. The grid is a prediction, so a frame that
// arrives late still puts its beats exactly on time.
function projectBeat(ahead) {
  const b = rawBeat;
  const period = Math.max(0.05, b.period);
  // A continuous beat position, so a shift longer than one beat (possible
  // above 200 BPM) still maps correctly instead of wrapping into the wrong bar.
  const pos = b.beatIndex + b.phase + ahead / period;
  const idx = Math.floor(pos);
  const phase = pos - idx;
  const bpb = Math.max(2, b.beatsPerBar);
  // b.barPos is the bar position of b.beatIndex; carry it to `idx`.
  const barPos = (((idx - (b.beatIndex - b.barPos)) % bpb) + bpb) % bpb;
  const isBeat = b.locked && prevShownIndex >= 0 && idx > prevShownIndex;
  prevShownIndex = idx;
  shownBeat.bpm = b.bpm;
  shownBeat.confidence = b.confidence;
  shownBeat.phase = phase;
  shownBeat.beat = isBeat;
  shownBeat.beatIndex = idx;
  shownBeat.barPos = barPos;
  shownBeat.beatsPerBar = bpb;
  shownBeat.downbeat = isBeat && barPos === 0;
  shownBeat.onset = b.onset;
  shownBeat.kickPulse = b.kickPulse;
  shownBeat.sinceBeat = phase * period;
  shownBeat.period = period;
  shownBeat.locked = b.locked;
  shownBeat.phraseBar = b.phraseBar;
  shownBeat.clarity = b.clarity;
  shownBeat.offbeat = b.offbeat;
}

// Dropped out of rhythm analysis: park the grid rather than leave a stale one
// advancing on its own.
function parkBeat() {
  shownBeat.locked = false;
  shownBeat.beat = false;
  shownBeat.downbeat = false;
  shownBeat.onset = 0;
  shownBeat.bpm = 0;
}

// The served verdict, wearing the shape the scenes already read.
const mergedLook = {};
for (const k of LOOK_KEYS) mergedLook[k] = 0;
const mergedArch = {};
for (const k of ARCHETYPES) mergedArch[k] = 0;
const mergedStyle = {
  kick: null,
  families: [],
  archetypes: mergedArch,
  look: mergedLook,
  dominant: "",
  dominantLabel: "",
  archetype: "groove",
  confidence: 0,
  served: true,
};

function merged(live, v) {
  mergedStyle.kick = live.kick;
  mergedStyle.families = live.families;
  // The served verdict names a family; the renderer needs the seven numbers
  // that family implies (style.js LOOK_KEYS). Where the server has no opinion
  // the live vector stands, exactly as for everything else here.
  const served = familyLook(v.style);
  const src = served || live.look;
  if (src) for (const k of LOOK_KEYS) mergedLook[k] = src[k];
  mergedStyle.dominant = v.style || live.dominant;
  mergedStyle.dominantLabel = v.styleLabel || live.dominantLabel;
  mergedStyle.archetype = v.archetype || live.archetype;
  mergedStyle.confidence = v.styleConfidence ?? live.confidence;
  const a = v.archetypes;
  if (a && typeof a === "object") {
    let sum = 0;
    for (const k of ARCHETYPES) sum += +a[k] || 0;
    for (const k of ARCHETYPES) mergedArch[k] = sum > 1e-6 ? (+a[k] || 0) / sum : live.archetypes[k];
  } else {
    for (const k of ARCHETYPES) mergedArch[k] = live.archetypes[k];
  }
  return mergedStyle;
}

function emit() {
  for (let i = 0; i < subs.length; i++) {
    try {
      subs[i].fn(frame);
    } catch {
      /* a broken subscriber must not stop the others */
    }
  }
}

function newTrack(id) {
  lastTrackId = id;
  frame.trackId = id;
  gen++;
  // Frames of the old track still in the queue are the old track's.
  for (const q of pending) recycle(q.buf);
  pending.length = 0;
  lastCtxT = 0;
  prevShownIndex = -1;
  parkBeat();
  frame.pattern = null;
  verdict = null;
  verdictSeeded = false;
  seededBpm = 0;
  send({ t: "reset", gen });
  // No verdict yet: the tempo range back to the default, and the live
  // classifier's say in it back on.
  send({ t: "range", lo: 0, hi: 0 });
  send({ t: "liveRange", on: true });
  primeAround(id);
  adoptVerdict(id);
}

// --- the fallback: the spectrum alone, from the AnalyserNodes -------------------------
//
// It also carries the first frames while the analyser loads, so the bars are
// never blank for the second it takes to compile.
let fb = null; // { plans, lo, hi }
let fbLastT = 0;
let fbOn = false;

function startFallback() {
  fbOn = true;
  if (!rafId && typeof requestAnimationFrame === "function") rafId = requestAnimationFrame(rafPump);
}

function stopFallback() {
  fbOn = false;
  fbLastT = 0;
}

function fallbackTick() {
  // The graph appears when something wires the player's element — the moment
  // an AudioWorklet can be created too. Take it.
  if (!rh && !rhStarting && !rhFailed && getContext()) startRhythm();
  if (!fbOn) return;
  const ctx = getContext();
  const an = getAnalysers();
  if (!ctx || !an) return;
  if (!fb || fb.plans.sampleRate !== ctx.sampleRate) {
    const sampleRate = ctx.sampleRate;
    fb = {
      plans: {
        sampleRate,
        band: buildBandPlan({ bands: BAND_COUNT, sampleRate, fftLo: FFT_LO, fftHi: FFT_HI }),
        energy: buildEnergyPlan({ sampleRate, fftLo: FFT_LO, fftHi: FFT_HI }),
      },
      lo: new Float32Array(an.lo.frequencyBinCount),
      hi: new Float32Array(an.hi.frequencyBinCount),
    };
  }
  const now = performance.now() / 1000;
  const dt = fbLastT ? Math.min(0.25, Math.max(0.001, now - fbLastT)) : 1 / 60;
  fbLastT = now;
  const id = get(current)?.deezer_id ?? null;
  if (id !== lastTrackId) {
    lastTrackId = id;
    frame.trackId = id;
    verdict = null;
    verdictSeeded = false;
    seededBpm = 0;
    primeAround(id);
  }
  an.lo.getFloatFrequencyData(fb.lo);
  an.hi.getFloatFrequencyData(fb.hi);
  readBands(fb.plans.band, fb.lo, fb.hi, frame.bandsDb, frame.bands, FLOOR_DB, CEIL_DB);
  readEnergy(fb.plans.energy, fb.lo, fb.hi, energyDb, FLOOR_DB);
  for (let i = 0; i < ENERGY_BANDS.length; i++)
    energyLin[ENERGY_BANDS[i][0]] = Math.pow(10, energyDb[i] / 10);
  let peak = FLOOR_DB;
  for (let i = 0; i < BAND_COUNT; i++) if (frame.bandsDb[i] > peak) peak = frame.bandsDb[i];
  frame.silent = peak < FLOOR_DB + 12;
  frame.features = null;
  frame.t = now;
  frame.dt = dt;
  frame.level = LEVEL.SPECTRUM;
  frame.wave = waveWant ? readScope() : null;
  parkBeat();
  frame.pattern = null;
  frame.style = null;
  frame.genre = null;
  emit();
}

// --- lifecycle ----------------------------------------------------------------------

// The graph appears when something wires the player's element, which can be
// after the views subscribed — and in a hidden tab (the projector's player)
// there is no rAF to notice. A slow timer covers it: a second's delay once.
let retryTimer = 0;
function retryStart() {
  if (!running || rh || rhFailed) {
    clearInterval(retryTimer);
    retryTimer = 0;
    return;
  }
  if (!rhStarting && getContext()) startRhythm();
}

function start() {
  if (running) return;
  running = true;
  if (!retryTimer && typeof setInterval === "function") retryTimer = setInterval(retryStart, 1000);
  requestAnalyser();
  resumeAudio();
  lastCtxT = 0;
  if (rh) {
    sleepRhythm(false);
    if (!rh.ready) startFallback();
  } else {
    startFallback();
    startRhythm();
  }
  if (!rafId && typeof requestAnimationFrame === "function") rafId = requestAnimationFrame(rafPump);
}

function stop() {
  running = false;
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = 0;
  // The analyser SLEEPS rather than being torn down: it keeps the tempo, the
  // grid and the style it has learnt, so pausing the music (which is what
  // stops the views) and playing on resumes locked instead of from nothing.
  sleepRhythm(true);
  for (const q of pending) recycle(q.buf);
  pending.length = 0;
  stopFallback();
  if (rafId && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
  rafId = 0;
}

function refresh() {
  const visible = typeof document === "undefined" || !document.hidden;
  const want = subs.length > 0 && (backgroundOk || visible);
  if (want && !running) start();
  else if (!want && running) stop();
  else if (running && visible && !rafId && typeof requestAnimationFrame === "function")
    rafId = requestAnimationFrame(rafPump);
}

if (typeof document !== "undefined") document.addEventListener("visibilitychange", refresh);

// The band centres never change: log-spaced over the same range as the plan.
{
  const plan = buildBandPlan({ bands: BAND_COUNT, sampleRate: 48000, fftLo: FFT_LO, fftHi: FFT_HI });
  frame.centers.set(plan.centers);
}

/**
 * Receive an analysis frame. The frame object is REUSED between calls — read
 * what you need inside the callback, never keep a reference to it.
 * @param {(f: typeof frame) => void} fn
 * @param {number} level one of LEVEL.*
 * @param {{wave?: number}} [opts] `wave` is how many samples per channel this
 *   subscriber wants on `frame.wave`; 0 (the default) means it wants none and
 *   the stereo tap is never built for it.
 */
export function subscribeFrames(fn, level = LEVEL.SPECTRUM, opts = {}) {
  const entry = { fn, level, wave: Math.max(0, +opts.wave || 0) };
  subs = subs.concat(entry);
  recomputeLevel();
  recomputeWave();
  refresh();
  return () => {
    subs = subs.filter((s) => s !== entry);
    recomputeLevel();
    recomputeWave();
    refresh();
  };
}

function recomputeLevel() {
  let lv = LEVEL.SPECTRUM;
  for (const s of subs) if (s.level > lv) lv = s.level;
  if (lv !== analysisLevel) {
    analysisLevel = lv;
    // Going deeper resets the analyser (a stale internal state would produce a
    // confident but wrong verdict for a few seconds); the served verdict is
    // then re-applied on the next frame.
    send({ t: "level", level: lv });
    if (lv > LEVEL.SPECTRUM) {
      verdictSeeded = false;
      seededBpm = 0;
    }
  }
}

// The largest window anybody wants. The tap is held by the ENGINE, not by the
// subscriber, so two scopes on screen (the player and the settings preview)
// share one splitter and one pair of analysers — the same rule as the frame
// itself.
function recomputeWave() {
  let want = 0;
  for (const s of subs) if (s.wave > want) want = s.wave;
  if (want === waveWant) return;
  const had = waveWant > 0;
  waveWant = want;
  if (want && !had) requestScope(want);
  else if (want) setScopeWindow(want);
  else {
    releaseScope();
    frame.wave = null;
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
