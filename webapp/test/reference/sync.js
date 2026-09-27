// THE ORACLE. The time-sync estimators as they were in JavaScript, before
// they moved to Rust (webapp/appcore/src/sync.rs): lib/party/clock.js's
// ClockEstimator, lib/party/anchor.js's AnchorFit, lib/party/engine.js's
// makeClockBridge and lib/audio/latency.js's output clock — unchanged but for
// their imports, the medians' names and the output clock wrapped in a factory
// so a test can run several. test/appcore.test.mjs holds the Rust to the same
// numbers. Not imported by the app.

function reportedLag(ctx) {
  if (!ctx) return 0;
  return (+ctx.outputLatency || 0) + (+ctx.baseLatency || 0) / 2;
}

// --- lib/party/clock.js ---------------------------------------------------------------

export function probeSample(t0, t1, t2, t3) {
  return {
    at: t3,
    rtt: t3 - t0 - (t2 - t1),
    offset: (t1 - t0 + (t2 - t3)) / 2,
  };
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Skew beyond this is not a clock, it is a bug (or a device that slept).
const MAX_SKEW = 200e-6;
const RECENT_MS = 45_000;

export class ClockEstimator {
  constructor({ max = 64, windowMs = 180_000, fitSpanMs = 20_000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.fitSpanMs = fitSpanMs;
    this.samples = [];
  }

  reset() {
    this.samples = [];
  }

  add(s) {
    if (!s || !Number.isFinite(s.rtt) || !Number.isFinite(s.offset) || s.rtt < 0) return;
    // A device that slept (or had its clock stepped) makes every older sample
    // wrong at once. One fast probe that disagrees with the estimate by far
    // more than any network could explain is that, not noise.
    const est = this.estimate(s.at);
    if (est && s.rtt <= est.rtt * 2 + 2 && Math.abs(s.offset - est.offset) > 50 + s.rtt) {
      this.samples = [];
    }
    this.samples.push(s);
    if (this.samples.length > this.max) this.samples.shift();
  }

  // The probes worth believing: within the window, and close to the fastest.
  good(now) {
    const recent = this.samples.filter((s) => now - s.at <= this.windowMs);
    if (!recent.length) return [];
    const best = Math.min(...recent.map((s) => s.rtt));
    const cut = best * 1.5 + 1;
    return recent.filter((s) => s.rtt <= cut);
  }

  // { offset (server - local, ms), rtt (best, ms), spread (ms), n } or null.
  estimate(now) {
    const g = this.good(now);
    if (!g.length) return null;
    const rtt = Math.min(...g.map((s) => s.rtt));
    // Without a line, only RECENT probes: under skew an old one is stale by
    // its age times the drift, however fast its round trip was.
    const recent = g.filter((s) => now - s.at <= RECENT_MS);
    let offsetAt = () => median((recent.length ? recent : g).map((s) => s.offset));
    const span = g.length > 1 ? Math.max(...g.map((s) => s.at)) - Math.min(...g.map((s) => s.at)) : 0;
    if (g.length >= 6 && span >= this.fitSpanMs) {
      // Least squares of offset against time, centred for precision.
      const mx = g.reduce((a, s) => a + s.at, 0) / g.length;
      const my = g.reduce((a, s) => a + s.offset, 0) / g.length;
      let sxx = 0;
      let sxy = 0;
      for (const s of g) {
        sxx += (s.at - mx) ** 2;
        sxy += (s.at - mx) * (s.offset - my);
      }
      const slope = Math.max(-MAX_SKEW, Math.min(MAX_SKEW, sxx ? sxy / sxx : 0));
      // Anchor the line on the MEDIAN residual, not the mean: one probe that
      // got lucky in only one direction must not drag it.
      const base = median(g.map((s) => s.offset - slope * (s.at - mx)));
      offsetAt = (t) => base + slope * (t - mx);
    }
    const offset = offsetAt(now);
    const spread = median(g.map((s) => Math.abs(s.offset - offsetAt(s.at))));
    return { offset, rtt, spread, n: g.length };
  }
}

// --- lib/party/anchor.js --------------------------------------------------------------

const medianA = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export class AnchorFit {
  constructor({ max = 24, breakS = 0.25 } = {}) {
    this.max = max;
    this.breakS = breakS;
    this.cs = [];
  }

  reset() {
    this.cs = [];
  }

  get n() {
    return this.cs.length;
  }

  // A reading taken at local time `perfMs` of an element at position `pos`
  // (seconds), while playing. Returns false when it broke the line.
  add(perfMs, pos) {
    const c = pos - perfMs / 1000;
    let continued = true;
    if (this.cs.length && Math.abs(c - medianA(this.cs)) > this.breakS) {
      this.cs = [];
      continued = false;
    }
    this.cs.push(c);
    if (this.cs.length > this.max) this.cs.shift();
    return continued;
  }

  // Where the line puts the playhead at local time `perfMs`.
  positionAt(perfMs) {
    if (!this.cs.length) return null;
    return medianA(this.cs) + perfMs / 1000;
  }
}

// --- lib/party/engine.js#makeClockBridge ----------------------------------------------

const medianE = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const MAP_KEEP = 15;
const MAP_READY = 3;
const MAP_OUTLIER = 0.004; // s
// A move is believed once two readings in a row agree on it. The readings
// hold to ±0.1 ms, so two that land within a millisecond of each other and
// four or more from the mapping are not noise — and every reading spent
// doubting a real move is audio placed on the wrong mapping. Measured end to
// end: the guest's context stepped by 20-30 ms mid-track, and waiting for five
// readings plus the next tick left the next click 20-40 ms late.
const MAP_AGREE = 0.001; // s

const LAG_KEEP = 30;

export function makeClockBridge(ctx, clockOffset, latencyMs, graphDelay = 0) {
  const ds = [];
  const lags = [];
  let lastCtx = -1;
  let rejected = null; // the last reading refused, while it may be a move
  // Readings needed before anything is placed: a few at the start (the first
  // readings of a new context are garbage), two after a confirmed move — they
  // agree to the millisecond, and with fewer than MAP_READY the re-place that
  // move calls for would find no clock and do nothing at all.
  let need = MAP_READY;
  // True when this reading moved the mapping: the caller re-places at once.
  function sample() {
    if (ctx.state !== "running") return false;
    let d = null;
    const hasTs = typeof ctx.getOutputTimestamp === "function";
    try {
      const ts = hasTs && ctx.getOutputTimestamp();
      if (ts && ts.performanceTime > 0 && ts.contextTime > 0 && ts.contextTime !== lastCtx) {
        lastCtx = ts.contextTime;
        d = ts.contextTime - ts.performanceTime / 1000;
      }
    } catch {
      /* not supported */
    }
    if (d == null && !hasTs && ctx.currentTime > 0 && ctx.currentTime !== lastCtx) {
      lastCtx = ctx.currentTime;
      // The context runs between outputLatency and outputLatency + baseLatency
      // ahead of the listener (a render burst at a time): half a burst is the
      // middle, measured (lib/audio/latency.js#reportedLag).
      d = ctx.currentTime - reportedLag(ctx) - performance.now() / 1000;
    }
    if (d == null) return false;
    let moved = false;
    // Checked against the mapping as soon as it is believed — right after a
    // move that is two readings, and the next one must not get in unexamined.
    if (ds.length >= need && Math.abs(d - medianE(ds)) > MAP_OUTLIER) {
      if (rejected == null || Math.abs(d - rejected) > MAP_AGREE) {
        rejected = d;
        return false;
      }
      ds.length = 0; // it really moved: learn it again
      lags.length = 0;
      ds.push(rejected); // ...from the two readings that showed it
      need = 2;
      moved = true;
    }
    rejected = null;
    ds.push(d);
    if (ds.length > MAP_KEEP) ds.shift();
    // How far this context runs ahead of the listener — the output latency the
    // OS reports, for the listener to read. sample() runs on the guest's own
    // timers, which the audio thread's rhythm has nothing to do with.
    lags.push(ctx.currentTime - (performance.now() / 1000 + medianE(ds)));
    if (lags.length > LAG_KEEP) lags.shift();
    return moved;
  }
  return {
    sample,
    get ready() {
      return ds.length >= need;
    },
    // null until BOTH clocks are known: the scheduler places nothing before.
    serverNow() {
      const off = clockOffset();
      return off == null || ds.length < need ? null : performance.now() + off;
    },
    toCtx(serverMs) {
      const off = clockOffset();
      if (off == null || !ds.length) return ctx.currentTime;
      return medianE(ds) + (serverMs - off - latencyMs()) / 1000 - graphDelay;
    },
    // Seconds: how far the context runs ahead of the listener, the median of
    // the recent readings. Null until there are enough of them.
    outputLag() {
      return lags.length >= MAP_READY * 3 ? Math.max(0, medianE(lags)) : null;
    },
  };
}

// --- lib/audio/latency.js: the output clock -------------------------------------------

export function createOutputClock() {
  let trimS = 0;
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
function sampleOutputClock(ctx) {
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
function contextLagNow(ctx, nowMs, ctxTime = ctx ? ctx.currentTime : 0) {
  if (!ctx || ctx !== clockCtx || dMedian == null) return null;
  return ctxTime - (nowMs / 1000 + dMedian);
}

/**
 * Record how far the context runs ahead of the listener, for `outputLag`.
 * Call it at moments unrelated to the audio thread's own rhythm (an animation
 * frame, a timer): read right after a render callback — when a worklet message
 * arrives — it would always catch the same end of the burst.
 */
function noteContextLag(ctx) {
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
function outputClockGeneration() {
  return generation;
}

/** Whether the output clock has enough readings to be believed. */
function outputClockReady() {
  return dMedian != null && ds.length >= need;
}

/**
 * The context time the listener hears at performance time `nowMs` — output
 * path only (1. above); callers add the graph's delays and the trim. Null
 * until a reading exists.
 */
function heardContextTime(nowMs) {
  return dMedian == null ? null : nowMs / 1000 + dMedian;
}

/**
 * The output latency, as measured: how far `currentTime` runs ahead of what is
 * heard, the median over recent readings (see noteContextLag), in seconds. The
 * attributes' estimate until there are readings.
 */
function outputLag(ctx) {
  if (ctx && ctx === clockCtx && lagMedian != null && lags.length >= 8) return Math.max(0, lagMedian);
  return reportedLag(ctx);
}


  return { sampleOutputClock, contextLagNow, noteContextLag, outputClockGeneration, outputClockReady, heardContextTime, outputLag };
}
