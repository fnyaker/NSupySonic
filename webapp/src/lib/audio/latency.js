// How late the listener hears what the page plays — one model, shared by
// everything that has to line up with the sound: the animations
// (lib/audio/engine.js), the lyric line (lib/lyrics.js) and the listen party
// (lib/party/).
//
// Three delays sit between "the graph rendered this sample" and "the listener
// hears it", from what the browser measures to what nobody can:
//
//  1. THE OUTPUT PATH, as the OS reports it. AudioContext.getOutputTimestamp()
//     relates a context time to the performance time it reaches the speakers,
//     and it carries every delay the OS knows about: the device buffer, the
//     mixer, a Bluetooth link on the platforms that account for one (Chromium
//     on Android reads it from AAudio's own timestamps). Measured in headless
//     Chromium, the mapping it gives holds to ±0.1 ms from reading to reading.
//  2. THE GRAPH'S OWN DELAYS: the analysis look-ahead (graph.js) and the two
//     compressors' lookahead (party/latency.js measures it).
//  3. WHAT NO API REPORTS: a Bluetooth speaker that does not tell the OS, a TV
//     or an AV receiver doing its own processing. That is the one number a
//     person sets, once per device: `outputTrim`, in milliseconds.
//
// Two measured facts shape the code below:
//
//  - getOutputTimestamp only MOVES once per render callback (48 times a second
//    measured, the callback being ~21 ms at latencyHint "playback"), while the
//    engine asks two or three times per callback. A repeated reading is not a
//    new one and is skipped. The engine used to fill its median from the
//    attributes instead whenever that happened (73% of its samples measured),
//    an estimate that jitters by ±10 ms against a mapping good to 0.1 ms.
//  - The context renders in bursts, so `currentTime` runs between
//    `outputLatency` and `outputLatency + baseLatency` ahead of what is heard:
//    70.7..91.1 ms measured (p05..p95), median 80.8, for 72.0 + 23.2. Where
//    there is no timestamp at all, half a burst is the constant to use —
//    `outputLatency || baseLatency` was 8.8 ms off that median, and the sum
//    (what the party host assumed) 14.4 ms off the other way.

import { outputTrim } from "../stores.js";

// The range a person may set, in ms. Negative is allowed: a device can
// over-report its latency as well as under-report it.
export const TRIM_MIN = -500;
export const TRIM_MAX = 1000;

let trimS = 0;
outputTrim.subscribe((v) => {
  const ms = Number.isFinite(+v) ? +v : 0;
  trimS = Math.max(TRIM_MIN, Math.min(TRIM_MAX, ms)) / 1000;
});

/** Seconds of output latency no API reports (the person's own setting). */
export function trimSeconds() {
  return trimS;
}

/**
 * The attributes' estimate of how far `currentTime` runs ahead of what is
 * heard, in seconds: the device's output latency plus half a render burst.
 * The fallback where getOutputTimestamp is missing, and the first guess before
 * it has settled.
 */
export function reportedLag(ctx) {
  if (!ctx) return 0;
  return (+ctx.outputLatency || 0) + (+ctx.baseLatency || 0) / 2;
}

// --- the output clock ------------------------------------------------------------------
//
// `d` is contextTime − performanceTime for the sample being heard: the context
// time reaching the listener at performance time p is p/1000 + d. The median of
// recent readings is kept; one far from it is refused until a run of them
// shows the mapping really moved — two in a row that agree with each other —
// and then it is learnt again from those, at once, rather than let the median
// drift across over a dozen readings.
// Chromium does move it: a few seconds after a context starts, its mapping
// steps by a whole render burst (20-23 ms) and stays there. Measured end to
// end, a host that took three seconds to follow that step published a line
// 25 ms off, and a guest that followed the line stayed 25 ms off until its
// next chunk seam. The readings themselves hold to ±0.1 ms, so anything past
// 4 ms is a move, not noise; the party's guest bridge uses the same rule.

const KEEP = 25;
const OUTLIER_S = 0.004;
const AGREE_S = 0.001; // two refused readings this close to each other are a move

let clockCtx = null;
const ds = [];
const lags = [];
let lastStamp = -1;
let dMedian = null;
let lagMedian = null;
let refused = null; // the last reading refused, while it may be a move
let sinceSort = 0;
let lagSinceSort = 0;
let tsBroken = false;
let generation = 0; // moves whenever the mapping is learnt afresh
// Readings needed to believe the clock: nine for a context just seen (its
// first readings can be ~140 ms off), two after a confirmed move — they agree
// to the millisecond, and every reading spent doubting them is a position
// modelled on the attributes' estimate instead, ±10 ms from one to the next.
let need = 9;

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

function forget(ctx) {
  generation++;
  need = 9;
  clockCtx = ctx;
  ds.length = 0;
  lags.length = 0;
  lastStamp = -1;
  dMedian = null;
  lagMedian = null;
  refused = null;
  sinceSort = 0;
  lagSinceSort = 0;
}

/**
 * Take one reading of the output clock, if there is a new one. Cheap: callers
 * run it on every analysis frame and every party measurement.
 */
export function sampleOutputClock(ctx) {
  if (!ctx || ctx.state !== "running") return;
  if (ctx !== clockCtx) forget(ctx);
  const now = performance.now();
  let d = null;
  if (!tsBroken && typeof ctx.getOutputTimestamp === "function") {
    try {
      const ts = ctx.getOutputTimestamp();
      if (ts && ts.performanceTime > 0 && ts.contextTime > 0 && ts.contextTime !== lastStamp) {
        lastStamp = ts.contextTime;
        d = ts.contextTime - ts.performanceTime / 1000;
      }
    } catch {
      tsBroken = true; // an engine that has the method and cannot answer it
    }
    if (!tsBroken && d == null) return; // no NEW reading: nothing to learn
  }
  if (d == null) {
    if (ctx.currentTime === lastStamp || !(ctx.currentTime > 0)) return;
    lastStamp = ctx.currentTime;
    d = ctx.currentTime - reportedLag(ctx) - now / 1000;
  }
  // Checked against the mapping from three readings at first, and from the
  // two that showed a move right after one: the next must not get in unexamined.
  if (dMedian != null && Math.abs(d - dMedian) > OUTLIER_S && ds.length >= Math.min(3, need)) {
    // One reading far off is refused; a second that agrees with it is a move,
    // learnt from the two of them at once.
    if (refused == null || Math.abs(d - refused) > AGREE_S) {
      refused = d;
      return;
    }
    ds.length = 0;
    lags.length = 0;
    ds.push(refused);
    dMedian = null;
    need = 2;
    generation++;
  }
  refused = null;
  ds.push(d);
  if (ds.length > KEEP) ds.shift();
  // Every third reading, counted — NOT `ds.length % 3`: the buffer stops
  // growing at KEEP (25), and the engine's copy of this code, keyed on the
  // length, froze its median for good the moment the buffer filled. A mapping
  // that then stepped by one render burst (23 ms, seen in headless Chromium a
  // few seconds into a track) was never followed: every frame after it was
  // handed out 23 ms early, for the rest of the session.
  if (++sinceSort >= 3 || dMedian == null) {
    sinceSort = 0;
    dMedian = median(ds);
  }
}

/**
 * How far `currentTime` runs ahead of the listener at this very instant, in
 * seconds. The context renders a burst at a time, so this swings by a whole
 * burst (70..91 ms measured) — which is exactly what makes it the right thing
 * to subtract from a position read AT THE SAME INSTANT: an element's
 * currentTime moves in the same bursts (to ±1.5 ms, measured), so the swing
 * cancels. Null until the output clock has a reading for this context.
 */
export function contextLagNow(ctx, nowMs, ctxTime = ctx ? ctx.currentTime : 0) {
  if (!ctx || ctx !== clockCtx || dMedian == null) return null;
  return ctxTime - (nowMs / 1000 + dMedian);
}

/**
 * Record how far the context runs ahead of the listener, for `outputLag`.
 * Call it at moments unrelated to the audio thread's own rhythm (an animation
 * frame, a timer): read right after a render callback — when a worklet message
 * arrives — it would always catch the same end of the burst.
 */
export function noteContextLag(ctx) {
  const lag = contextLagNow(ctx, performance.now());
  if (lag == null) return;
  lags.push(lag);
  if (lags.length > LAG_KEEP) lags.shift();
  if (++lagSinceSort >= 4 || lagMedian == null) {
    lagSinceSort = 0;
    lagMedian = median(lags);
  }
}
const LAG_KEEP = 60;

/**
 * A number that changes whenever the mapping had to be learnt afresh (a new
 * context, or a move confirmed by a run of readings). Anything that fitted
 * positions against the old one — the party host's line — starts again.
 */
export function outputClockGeneration() {
  return generation;
}

/** Whether the output clock has enough readings to be believed. */
export function outputClockReady() {
  return dMedian != null && ds.length >= need;
}

/**
 * The context time the listener hears at performance time `nowMs` — output
 * path only (1. above); callers add the graph's delays and the trim. Null
 * until a reading exists.
 */
export function heardContextTime(nowMs) {
  return dMedian == null ? null : nowMs / 1000 + dMedian;
}

/**
 * The output latency, as measured: how far `currentTime` runs ahead of what is
 * heard, the median over recent readings (see noteContextLag), in seconds. The
 * attributes' estimate until there are readings.
 */
export function outputLag(ctx) {
  if (ctx && ctx === clockCtx && lagMedian != null && lags.length >= 8) return Math.max(0, lagMedian);
  return reportedLag(ctx);
}

/**
 * How far behind its own currentTime an element is HEARD, in seconds, for a
 * currentTime read at `nowMs`. One played directly already carries its output
 * latency in currentTime (the media pipeline's clock accounts for the sink's
 * delay), so only the trim applies. One routed through the graph is heard after
 * all of it: the context's lag behind the listener at that same instant, and
 * the graph's delays. `graphDelay` is the compressors' part, which only the
 * listen party measures (party/latency.js). `ctxTime` is the context's
 * currentTime read TOGETHER with the element's: a render callback landing
 * between two reads a few lines apart would put them a whole burst out of step.
 *
 * Measured end to end (webapp/test/party/run.mjs: a host and a guest in
 * headless Chromium, clicks detected on what each one really plays), a line
 * published on this model is heard where the host hears it to 0.2-0.5 ms. The
 * element itself adds nothing to it for FLAC, MP3 or WAV; resampling a file
 * to another rate adds ~1.8 ms and an Ogg Opus stream reads ~5 ms behind —
 * both measured, neither modelled (nothing tells the page a stream's rate).
 */
export function elementLag(el, { wired, ctx, lookahead = 0, graphDelay = 0, nowMs = performance.now(), ctxTime }) {
  if (!wired || !el) return trimS;
  const lag = outputClockReady() ? contextLagNow(ctx, nowMs, ctxTime ?? (ctx ? ctx.currentTime : 0)) : null;
  return (lag == null ? reportedLag(ctx) : lag) + lookahead + graphDelay + trimS;
}

// --- the automatic look-ahead's rule -------------------------------------------------
//
// `p05` is the 5th percentile of how early recent frames reached the page
// against the instant their audio was heard (seconds; negative = late), and
// `cur` the look-ahead in force. The answer is the look-ahead to move to:
// enough that the latest frames still arrive LEAD_WANT early — the delivery
// timer's own slack — and no more. Giving delay back needs a clear surplus, so
// a device whose arrivals wobble by a few milliseconds does not chase itself.
export const LEAD_WANT = 0.004;
const RAISE_OVER = 0.002;
const LOWER_OVER = 0.025;

export function lookaheadStep(cur, p05) {
  if (!Number.isFinite(p05)) return cur;
  if (p05 < LEAD_WANT - RAISE_OVER) return cur + (LEAD_WANT - p05);
  if (cur > 0 && p05 > LEAD_WANT + LOWER_OVER) return Math.max(0, cur - (p05 - LEAD_WANT - LOWER_OVER / 2));
  return cur;
}
