// IS THE MUSIC KEEPING TIME? A watch on the playing element, measured, because
// the failure it exists for cannot be seen any other way.
//
// When the processed path (lib/audio/graph.js) breaks on an output — the
// Bluetooth case lib/audio/output.js describes — nothing throws and no event
// fires. The context keeps rendering, the element keeps playing, and what the
// listener hears is the music with pieces cut out of it. What DOES move is
// time, and four clocks can be read against the wall clock for it:
//
//  1. the element's own position. A routed element is pulled by the context,
//     so when the context renders more than the device plays (the frames it
//     drops), the track advances faster than real time; when it renders less
//     (the silence it pads with), slower. Healthy, it keeps time to a few
//     hundred ppm (373 ppm measured in headless Chromium); "sounds sped up" is
//     a few PERCENT.
//  2. the context's own clock, for the same reason.
//  3. the context's output timestamp — the mapping from context time to the
//     moment it is heard. Every padded gap and every dropped run moves it; a
//     healthy one steps by a render burst (20-23 ms) once in a while.
//  4. AudioContext.playbackStats (Chrome 2025+), which counts underruns
//     outright where it exists.
//
// A window is WINDOW_MS of uninterrupted playback: a seek, a pause, a stall,
// a track change or a rate change starts a new one, and a tick whose position
// moved implausibly (a reload, a recovery) does too — none of those is a pace.
// The fault it exists for comes and goes (it vanished once when the phone was
// reconnected to the car radio), so the correction is only ever applied while
// it is MEASURED, and it has to be measured fast: a window that is far out
// (SEVERE) is a verdict on its own, eight seconds after it started; a mild one
// needs a second bad window in a row, so one bad moment on a loaded phone is
// not a verdict; a good window clears the count.

import { getContext, isCapturing, isWired } from "./graph.js";
import { logInfo } from "../log.js";

export const WINDOW_MS = 8000;
export const TICK_MS = 1000;
// |pace - 1| past this is music audibly running at the wrong speed (2% is a
// third of a semitone's worth of tempo, and far past any clock drift).
export const PACE_TOL = 0.02;
// How far the output mapping moves, in seconds per second of playback. A
// healthy context steps a burst now and then (21.6 ms once in a window is
// 2.7 ms/s over eight seconds); a padded-and-dropped one moves by its gaps,
// several a second (22 ms/s on the model the tests hold it to).
export const JITTER_MAX = 0.01;
// Share of a window spent in underrun (playbackStats).
export const UNDERRUN_MAX = 0.01;
// Past these a single window is a verdict: nothing healthy comes near them.
export const SEVERE = { pace: 0.04, underrun: 0.03, jitter: 0.025 };
export const STRIKES = 2;

/**
 * One reading of the element and the context. Pure: a test hands in readings
 * and gets windows back.
 */
export class PaceMeter {
  constructor() {
    this.a = null;
    this.strikes = 0;
  }

  reset() {
    this.a = null;
  }

  start(r) {
    this.a = {
      el: r.el,
      src: r.src,
      rate: r.rate,
      wired: r.wired,
      wall0: r.wall,
      media0: r.media,
      ctx0: r.ctxTime,
      under0: r.underrun,
      lastWall: r.wall,
      lastMedia: r.media,
      lastMap: r.mapD,
      jitter: 0,
    };
  }

  /**
   * `r`: { el, src, wired, media (s), wall (ms), rate, ctxTime (s|null),
   * mapD (s|null — contextTime - performanceTime of a NEW output timestamp),
   * underrun (s|null — playbackStats.underrunDuration) }, or null when the
   * element is not in a state a pace can be read from.
   * Returns a finished window, or null.
   */
  offer(r) {
    if (!r) {
      this.a = null;
      return null;
    }
    const a = this.a;
    if (!a || a.el !== r.el || a.src !== r.src || a.rate !== r.rate || a.wired !== r.wired) {
      this.start(r);
      return null;
    }
    const dWall = (r.wall - a.lastWall) / 1000;
    const dMedia = r.media - a.lastMedia;
    // One tick's pace outside [0.5, 1.6]: a seek, a reload, a stall — not the
    // steady drift this is measuring. Start again from here.
    const tickPace = dWall > 0 ? dMedia / (dWall * r.rate) : 0;
    if (!(dWall > 0) || tickPace < 0.5 || tickPace > 1.6) {
      this.start(r);
      return null;
    }
    if (r.mapD != null) {
      if (a.lastMap != null) {
        const j = Math.abs(r.mapD - a.lastMap);
        // Sub-millisecond reading noise is not movement.
        if (j > 0.003) a.jitter += j;
      }
      a.lastMap = r.mapD;
    }
    a.lastWall = r.wall;
    a.lastMedia = r.media;
    const span = (r.wall - a.wall0) / 1000;
    if (span * 1000 < WINDOW_MS) return null;
    const w = {
      span,
      wired: a.wired,
      pace: (r.media - a.media0) / (span * r.rate),
      ctxPace: a.ctx0 != null && r.ctxTime != null ? (r.ctxTime - a.ctx0) / span : null,
      jitter: a.jitter,
      underrun: a.under0 != null && r.underrun != null ? Math.max(0, r.underrun - a.under0) / span : null,
    };
    this.start(r);
    return w;
  }
}

/** What is wrong with a window, or null when it kept time. */
export function judge(w) {
  const f = fault(w);
  return f ? f.why : null;
}

/** { why, severe } for a window that did not keep time, else null. */
export function fault(w) {
  if (!w) return null;
  const pace = Math.abs(w.pace - 1);
  const ctxPace = w.ctxPace != null ? Math.abs(w.ctxPace - 1) : 0;
  const jitterRate = w.span > 0 ? w.jitter / w.span : 0;
  if (pace > PACE_TOL) return { why: `pace ${w.pace.toFixed(3)}`, severe: pace > SEVERE.pace };
  if (ctxPace > PACE_TOL) return { why: `context pace ${w.ctxPace.toFixed(3)}`, severe: ctxPace > SEVERE.pace };
  if (w.underrun != null && w.underrun > UNDERRUN_MAX)
    return { why: `underruns ${(w.underrun * 100).toFixed(1)}%`, severe: w.underrun > SEVERE.underrun };
  if (jitterRate > JITTER_MAX)
    return {
      why: `output clock moved ${Math.round(w.jitter * 1000)} ms in ${w.span.toFixed(0)} s`,
      severe: jitterRate > SEVERE.jitter,
    };
  return null;
}

/**
 * Count strikes over successive windows. Returns the verdict (a reason
 * string) on a SEVERE window, or on the STRIKES-th bad window in a row, else
 * null.
 */
export function strike(meter, w) {
  const f = fault(w);
  if (!f) {
    meter.strikes = 0;
    return null;
  }
  meter.strikes++;
  if (!f.severe && meter.strikes < STRIKES) return null;
  meter.strikes = 0;
  return f.why;
}

// --- the watch -------------------------------------------------------------------

function readContext(ctx, wired) {
  if (!wired || !ctx || ctx.state !== "running") return { ctxTime: null, mapD: null, stamp: null, underrun: null };
  let mapD = null;
  let stamp = null;
  try {
    const ts = typeof ctx.getOutputTimestamp === "function" ? ctx.getOutputTimestamp() : null;
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      mapD = ts.contextTime - ts.performanceTime / 1000;
      stamp = ts.contextTime;
    }
  } catch {
    mapD = null;
  }
  let underrun = null;
  try {
    const st = ctx.playbackStats;
    if (st && Number.isFinite(st.underrunDuration)) underrun = st.underrunDuration;
  } catch {
    underrun = null;
  }
  return { ctxTime: ctx.currentTime, mapD, stamp, underrun };
}

/**
 * Watch the player's element. `element()` is the one playing; `busy()` is true
 * while the player is between states (a load, a switch, a crossfade) and no
 * pace can be read; `onVerdict({ why, wired, capturing, window })` is called on
 * a verdict; `onWindow(window)` on every window (the output policy uses the
 * context it was measured on). Returns a stop function.
 */
export function startTimekeeper({ element, busy = () => false, onVerdict, onWindow, onTick }) {
  const meter = new PaceMeter();
  let lastMapStamp = -1;
  let windows = 0;
  const tick = () => {
    const el = element();
    const ctx = getContext();
    if (onTick) {
      try {
        onTick(ctx);
      } catch {
        /* a policy hook never stops the watch */
      }
    }
    if (!el || busy() || el.paused || el.seeking || el.ended || el.readyState < 3 || !(el.playbackRate > 0)) {
      meter.offer(null);
      return;
    }
    const wired = isWired(el);
    const c = readContext(ctx, wired);
    // Only a NEW output timestamp is a reading (latency.js): it moves once per
    // render callback, and a repeat says nothing about movement.
    let mapD = null;
    if (c.stamp != null && c.stamp !== lastMapStamp) {
      lastMapStamp = c.stamp;
      mapD = c.mapD;
    }
    const w = meter.offer({
      el,
      src: el.currentSrc || el.src || "",
      wired,
      media: el.currentTime,
      wall: performance.now(),
      rate: el.playbackRate,
      ctxTime: c.ctxTime,
      mapD,
      underrun: c.underrun,
    });
    if (!w) return;
    const capturing = !wired && isCapturing();
    const why = strike(meter, w);
    // The windows go to the diagnostic log (off unless switched on): when a
    // listener reports a problem on an output nobody here owns, these lines
    // are the evidence. Every bad one, and one healthy one a minute — the log
    // is a bounded ring, and a long drive must not evict everything else.
    const bad = judge(w);
    if (bad || windows++ % 8 === 0)
      logInfo(
      "pace",
      `${wired ? "processed" : capturing ? "direct+copy" : "direct"} pace=${w.pace.toFixed(4)}` +
        (w.ctxPace != null ? ` ctx=${w.ctxPace.toFixed(4)}` : "") +
        (w.underrun != null ? ` underrun=${(w.underrun * 100).toFixed(2)}%` : "") +
        ` jitter=${Math.round(w.jitter * 1000)}ms` +
        (why ? ` VERDICT: ${why}` : bad ? ` bad: ${bad}` : ""),
      null,
      { important: !!bad }
    );
    if (onWindow) onWindow(w);
    if (why && onVerdict) onVerdict({ why, wired, capturing, window: w });
  };
  const id = setInterval(tick, TICK_MS);
  return () => clearInterval(id);
}
