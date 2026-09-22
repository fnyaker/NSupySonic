// The guest's player: turns the party timeline into sound, on the AudioContext
// clock, to the sample.
//
// Why not an <audio> element? Because it starts when it is ready, not when it
// is told — tens of milliseconds late, differently on every device — and all
// anyone can do afterwards is nudge its rate and hope. Beatsync's answer, and
// this one: decode the audio yourself and schedule it with
// `AudioBufferSourceNode.start(when, offset)`, which the audio thread honours
// to the sample.
//
// Beatsync decodes whole files. This decodes CHUNKS (supysonic/webui/party.py
// cuts them): joining mid-track costs one chunk, memory stays flat whatever the
// length, and — the part that matters for sync — every chunk is scheduled from
// the clock estimate in force at the time, so each seam is a point where this
// device re-aligns to the shared timeline. Two devices' audio clocks drift
// apart by tens of ppm; here that error is reset every CHUNK_SECONDS instead of
// accumulating over a track.
//
// Each chunk carries a little overlap at its tail, and the two sides of every
// seam are crossfaded across it IN TIME (both ramps over the same interval), so
// a seam where the timeline moved by a few milliseconds is a brief blend, not
// a click.
//
// The structure:
//   voice — one continuous run of one track on one timeline, with its own gain
//           (loudness normalisation × its start/stop envelope) so a crossfade
//           between two tracks is two voices ramping in opposite directions.
//   node  — one scheduled chunk of a voice: a buffer source + its seam envelope.
//
// Everything that depends on the browser (fetching, decoding, the clocks) is
// injected, so the node test suite drives this whole file against a recording
// AudioContext and checks where the sound actually lands.

import {
  KEEP_MS,
  chunkIndex,
  correctionFor,
  lastChunk,
  nextTimeline,
  positionAt,
  serverTimeAt,
} from "./timeline.js";

const LEAD = 0.1; // s: slack given to a fresh start (render quantum + main-thread jitter)
const SCHED_AHEAD = 3; // s: sources are created this far ahead of the audible point
const FETCH_AHEAD = 20; // s: audio fetched + decoded this far ahead
const NEXT_PRELOAD = 25; // s before a handover: start fetching the next track
const MAX_INFLIGHT = 2;
const MAX_BUFFERS = 12;
const EDGE = 0.012; // s: the fade on a cut — inaudible as a fade, kills the click
const SKIP_FADE = 0.06; // s: matches the host player's ramp on a manual skip
const MIN_SEAM = 0.008; // s: shortest crossfade still worth calling a seam
const LATE = 0.02; // s: a start closer than this to "now" is treated as late
// The audio-clock mapping moved by more than this under the chunk playing:
// re-place it now instead of at the next seam. A real move (the device's
// reported delay settling, measured at 20 ms) is worth a 12 ms fade; the clock
// estimate's own refinements stay far below it and never cut anything.
const MAP_NOW_MS = 8;

// Normalisation, exactly as the host's graph computes it (lib/audio/graph.js),
// so a track sits at the same relative level on every device in the room.
const RG_REFERENCE = 18.4;
const NORM_OFFSET = { off: 0, low: 2, medium: 5, high: 8 };
export function normGain(gainDb, level) {
  if (!level || level === "off" || typeof gainDb !== "number") return 1;
  const db = Math.max(-24, Math.min(12, -(gainDb + RG_REFERENCE) + (NORM_OFFSET[level] || 0)));
  return Math.pow(10, db / 20);
}

// Equal-power quarter circle, same shape as the host's crossfade.
function powerCurve(from, to, steps = 32) {
  const c = new Float32Array(steps);
  const a0 = Math.asin(Math.max(0, Math.min(1, from)));
  const a1 = Math.asin(Math.max(0, Math.min(1, to)));
  for (let i = 0; i < steps; i++) c[i] = Math.sin(a0 + (a1 - a0) * (i / (steps - 1)));
  return c;
}

function hold(param, t) {
  if (typeof param.cancelAndHoldAtTime === "function") {
    try {
      param.cancelAndHoldAtTime(t);
      return;
    } catch {
      /* fall through */
    }
  }
  const v = param.value;
  param.cancelScheduledValues(t);
  param.setValueAtTime(v, t);
}

// A ramp of `param` from its level at `t` to `to` over `dur` (equal-power for a
// musical fade, linear for the tiny edge ramps).
function ramp(param, from, to, t, dur, power = false) {
  if (dur <= 0.001) {
    param.setValueAtTime(to, t);
    return;
  }
  if (power) {
    try {
      param.setValueCurveAtTime(powerCurve(from, to), t, dur);
      return;
    } catch {
      /* an overlapping automation — fall back to a straight ramp */
    }
  }
  param.setValueAtTime(from, t);
  param.linearRampToValueAtTime(to, t + dur);
}

function stopNode(src, when) {
  try {
    src.stop(when);
  } catch {
    /* already stopped */
  }
}

export const EMPTY = Symbol("empty-chunk");

export class PartyEngine {
  constructor({ ctx, load, serverNow, toCtx, destination = null, onChange = () => {} }) {
    this.ctx = ctx;
    this.load = load; // async (id, k) -> AudioBuffer | null (past the end); throws { retry } when not ready
    this.serverNow = serverNow; // () -> server ms, or null while the clock is unknown
    this.toCtx = toCtx; // (server ms) -> ctx time to schedule for it to be HEARD then
    this.onChange = onChange;
    this.master = ctx.createGain();
    this.master.connect(destination || ctx.destination);
    this.voices = new Set();
    this.cur = null;
    this.pending = null;
    this.stopped = null; // { id, pos }: where we fell silent on a pause
    this.state = null;
    this.buffers = new Map();
    this.inflight = 0;
    this.len = 6;
    this.ov = 0.05;
    this.status = "idle";
    this.volume = 1;
  }

  // -- public -----------------------------------------------------------------

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.volume * this.volume, t, 0.03);
  }

  // The playhead the UI shows: the shared timeline, not this device's.
  position() {
    const s = this.state;
    if (!s || !s.track || !s.anchor) return 0;
    const S = this.serverNow();
    if (S == null) return s.anchor.p;
    const tl = { t: s.anchor.t, p: s.anchor.p, playing: s.playing };
    return Math.max(0, Math.min(s.track.duration || Infinity, positionAt(tl, S)));
  }

  // A fresh poll. Everything the host did reaches us here.
  apply(state) {
    this.state = state;
    if (state && state.chunk) {
      this.len = state.chunk.len || this.len;
      this.ov = state.chunk.ov || this.ov;
    }
    const S = this.serverNow();
    if (S == null) return; // no clock yet: nothing can be placed in time
    const now = this.ctx.currentTime;

    if (!state || !state.track || !state.anchor) {
      this.stopAll(now, SKIP_FADE);
      this.setStatus("idle");
      return;
    }
    const tl = { id: state.track.id, t: state.anchor.t, p: state.anchor.p, playing: !!state.playing };
    const sref = S + LEAD * 1000;

    // The handover we predicted has now been confirmed by the host. Decided on
    // position, not on id alone: with repeat-one the next track IS this one.
    if (this.pending && this.pending.id === tl.id) {
      const target = positionAt(tl, sref);
      const ep = Math.abs(positionAt(this.pending.tl, sref) - target);
      const ec =
        this.cur && this.cur.id === tl.id ? Math.abs(positionAt(this.cur.tl, sref) - target) : Infinity;
      if (ep < ec) {
        const old = this.cur;
        if (old && !old.stopAt && old.plannedEnd) {
          // It is already fading out on the schedule planNext gave it.
          old.stopAt = old.plannedEnd.at;
          old.ends = old.plannedEnd.ends;
        }
        this.cur = this.pending;
        this.pending = null;
      }
    }

    if (!tl.playing) {
      if (this.cur && !this.cur.stopAt) {
        const at = S + LEAD * 1000;
        this.stopped = { id: this.cur.id, pos: positionAt(this.cur.tl, at) };
        this.stopVoice(this.cur, now + LEAD, EDGE * 2);
      }
      if (this.pending) this.stopVoice(this.pending, now + LEAD, EDGE * 2);
      this.cur = null;
      this.pending = null;
      this.setStatus("pause");
      return;
    }

    const v = this.cur;
    if (v && v.id === tl.id && !v.stopAt) {
      const err = (positionAt(v.tl, sref) - positionAt(tl, sref)) * 1000;
      const c = correctionFor(err);
      if (c === "keep") {
        v.tl = tl;
      } else if (c === "seam") {
        v.tl = tl;
        this.unscheduleFuture(v, now);
      } else if (c === "jump") {
        this.stopVoice(v, now + LEAD, EDGE);
        this.cur = this.startVoice(tl, state.track, positionAt(tl, sref), EDGE);
      } else {
        // Ahead: fall silent and pick the SAME audio up when the timeline
        // reaches it — never repeat what the room just heard.
        const q = positionAt(v.tl, sref);
        this.stopVoice(v, now + LEAD, EDGE);
        this.cur = this.startVoice(tl, state.track, q, EDGE);
      }
    } else {
      // Another track: a skip, a join, or a handover we did not see coming.
      if (v) {
        const fade = state.xfade > 0.1 ? Math.min(state.xfade, 4) : SKIP_FADE;
        this.stopVoice(v, now + LEAD, fade, fade > SKIP_FADE);
      }
      let from = positionAt(tl, sref);
      const st = this.stopped;
      // Resuming after a pause we overshot: carry on from where WE stopped.
      if (st && st.id === tl.id && st.pos > from && st.pos - from < 8) from = st.pos;
      this.cur = this.startVoice(tl, state.track, from, v && state.xfade > 0.1 ? Math.min(state.xfade, 4) : EDGE);
    }
    this.stopped = null;
    this.planNext(state, tl, S, now);
    this.tick();
  }

  isStarted(v, now) {
    return this.toCtx(serverTimeAt(v.tl, v.from)) <= now + LATE;
  }

  // Called on a timer (and whenever a chunk lands).
  tick() {
    const S = this.serverNow();
    if (S == null) return;
    const now = this.ctx.currentTime;
    const wants = [];
    // Every live voice, not just the current one: a track crossfading out
    // still needs its audio for the rest of the fade.
    this.checkMapping(now);
    for (const v of this.voices) this.schedule(v, S, now, wants);
    this.prefetch(S, wants);
    this.cleanup(now);
    if (this.cur && !this.cur.stopAt) {
      this.setStatus(this.covered(this.cur, S) ? "sync" : "load");
    }
  }

  // The listener moved this device's latency setting: re-place the audio NOW,
  // not at the next seam six seconds away — tuning by ear needs the change to
  // be heard when it is made.
  realign() {
    this.checkMapping(this.ctx.currentTime, 0.5);
    this.tick();
  }

  // The audio-clock mapping moved under audio already placed on it: the clock
  // estimate improved, the listener changed the latency setting, or the device
  // reported a new output delay. A chunk not yet started is simply placed
  // again; the one playing is re-placed at once when it is further off than a
  // seam can absorb (or than `threshold` ms, for an explicit realign) — with
  // the usual rule: behind skips forward, ahead waits and resumes the same
  // audio, never repeating it.
  checkMapping(now, threshold = MAP_NOW_MS) {
    for (const v of [...this.voices]) {
      if (v.stopAt) continue;
      let worst = 0;
      for (const n of [...v.nodes.values()]) {
        const drift = (n.T - this.toCtx(n.S)) * 1000;
        if (Math.abs(drift) <= Math.min(KEEP_MS, threshold)) continue;
        if (n.start > now + LATE) {
          this.dropNode(v, n);
          const prev = v.nodes.get(n.k - 1);
          if (prev) this.defaultTail(prev);
        } else if (n.end > now && Math.abs(drift) > Math.abs(worst)) worst = drift;
      }
      if (Math.abs(worst) > threshold) {
        if (v === this.cur) this.replaceCur(-worst);
        else if (v === this.pending) this.replan();
      }
    }
  }

  // Re-place the current voice now. `errMs` is where it IS minus where it
  // should be.
  replaceCur(errMs) {
    const v = this.cur;
    const S = this.serverNow();
    if (!v || v.stopAt || S == null) return;
    const now = this.ctx.currentTime;
    const sref = S + LEAD * 1000;
    const target = positionAt(v.tl, sref);
    const tl = { id: v.id, ...v.tl };
    this.stopVoice(v, now + LEAD, EDGE);
    this.cur = this.startVoice(tl, v.track, errMs > 0 ? target + errMs / 1000 : target, EDGE);
    this.replan();
  }

  // Throw the next-track plan away and make it again on the current mapping.
  replan() {
    const S = this.serverNow();
    const cur = this.cur;
    if (!this.state || S == null) return;
    const now = this.ctx.currentTime;
    if (this.pending) {
      if (this.isStarted(this.pending, now)) return; // audible: the next poll owns it
      this.stopVoice(this.pending, now, 0);
      this.pending = null;
    }
    if (cur && cur.planned) this.restoreEnd(cur, now);
    if (cur) this.planNext(this.state, { id: cur.id, ...cur.tl }, S, now);
  }

  // Diagnostics: the content this device plays at server time S, as
  // scheduled — { id, pos } or null when it is silent then.
  heardAt(S) {
    const v = this.cur;
    if (!v || S == null) return null;
    const c = this.toCtx(S);
    for (const n of v.nodes.values()) if (n.start <= c && c < n.end) return { id: v.id, pos: n.cs + (c - n.start) };
    return null;
  }

  stop() {
    this.stopAll(this.ctx.currentTime, EDGE * 2);
    this.state = null;
    this.buffers.clear();
    this.setStatus("idle");
  }

  // -- voices -------------------------------------------------------------------

  startVoice(tl, track, from, fadeIn, power = fadeIn > SKIP_FADE) {
    const out = this.ctx.createGain();
    out.connect(this.master);
    const level = normGain(track.gain, this.state && this.state.norm);
    const v = {
      id: tl.id,
      tl: { t: tl.t, p: tl.p, playing: true },
      track,
      from: Math.max(0, from),
      to: Infinity,
      out,
      level,
      nodes: new Map(),
      end: Infinity, // last chunk index that exists
      stopAt: 0,
      ends: 0, // ctx time after which it is silent for good
    };
    const startS = serverTimeAt(v.tl, v.from);
    const at = Math.max(this.ctx.currentTime, this.toCtx(startS));
    out.gain.value = 0;
    ramp(out.gain, 0, level, at, Math.max(EDGE, fadeIn), power);
    v.fadeInEnd = at + Math.max(EDGE, fadeIn);
    this.voices.add(v);
    return v;
  }

  // Fade a voice out from ctx time `at`, and never schedule anything past it.
  stopVoice(v, at, fade, power = false) {
    if (v.stopAt && v.stopAt <= at) return;
    const t = Math.max(this.ctx.currentTime, at);
    hold(v.out.gain, t);
    ramp(v.out.gain, v.out.gain.value, 0, t, fade, power);
    v.stopAt = t;
    v.ends = t + fade + 0.01;
    // Nothing past the end of the fade is ever scheduled or fetched.
    const S = this.serverNow();
    if (S != null) v.to = Math.min(v.to, positionAt(v.tl, S) + (v.ends - this.ctx.currentTime) + 0.05);
    for (const n of v.nodes.values()) {
      if (n.start >= v.ends) this.dropNode(v, n);
      else stopNode(n.src, v.ends);
    }
  }

  stopAll(now, fade) {
    for (const v of this.voices) if (!v.stopAt) this.stopVoice(v, now + 0.005, fade);
    this.cur = null;
    this.pending = null;
  }

  // Take back every chunk of `v` that has not started yet; the next tick
  // schedules them again from the voice's (new) timeline.
  unscheduleFuture(v, now) {
    let prev = null;
    for (const k of [...v.nodes.keys()].sort((a, b) => a - b)) {
      const n = v.nodes.get(k);
      if (n.start > now + LATE) {
        this.dropNode(v, n);
        if (prev) this.defaultTail(prev);
        prev = null;
      } else prev = n;
    }
  }

  dropNode(v, n) {
    stopNode(n.src, 0);
    try {
      n.src.disconnect();
      n.env.disconnect();
    } catch {
      /* ignore */
    }
    v.nodes.delete(n.k);
  }

  // The next track, started where the host is predicted to start it — not a
  // poll after it did.
  planNext(state, tl, S, now) {
    const n = state.next;
    const cur = this.cur;
    const ok = n && n.track && state.live !== false && cur && !cur.stopAt && cur.id === tl.id;
    const key = ok
      ? [n.track.id, Math.round(nextTimeline(tl, n).t), n.start, n.fade, n.at].join("|")
      : null;
    if (this.pending && this.pending.planKey === key) return;

    // A plan changed (or was withdrawn) before its handover: undo it.
    if (this.pending) {
      const p = this.pending;
      if (this.isStarted(p, now)) {
        // Already what the room is hearing. If the host still names it as
        // next, the timing merely moved: the next poll (which will name it
        // current) corrects that. If not, the host went somewhere else — stop.
        if (ok && n.track.id === p.id) return;
        this.stopVoice(p, now + 0.005, SKIP_FADE);
      } else {
        this.stopVoice(p, now, 0);
      }
      this.pending = null;
      if (cur && cur.planned) this.restoreEnd(cur, now);
    }
    if (!ok) return;

    const ntl = nextTimeline(tl, n);
    const handover = this.toCtx(ntl.t);
    if (handover <= now + LATE) return; // already past: the next poll carries it
    const fade = n.fade > 0.1 ? Math.min(n.fade, 12) : 0;
    const p = this.startVoice(ntl, n.track, n.start || 0, fade || EDGE, fade > 0);
    p.planKey = key;
    this.pending = p;
    // The current track ends where the HOST's does: at `at`, on its own line.
    // The next one comes in `gap` later — the host player's own start-up time,
    // which is silence on a cut and the head of the ramp on a crossfade (the
    // host starts fading the old track out the moment it asks the new one to
    // play, not when that one is actually audible).
    const endAt = Math.max(this.toCtx(serverTimeAt(tl, n.at)), cur.fadeInEnd);
    cur.planned = true;
    if (fade) {
      cur.plannedEnd = { at: endAt, ends: endAt + fade + 0.02 };
      cur.to = n.at + fade + 0.02;
      ramp(cur.out.gain, cur.level, 0, endAt, fade, true);
    } else {
      cur.plannedEnd = { at: endAt - EDGE, ends: endAt + 0.01 };
      cur.to = n.at;
      cur.out.gain.setValueAtTime(cur.level, Math.max(endAt - EDGE, cur.fadeInEnd));
      cur.out.gain.linearRampToValueAtTime(0, endAt);
    }
  }

  restoreEnd(v, now) {
    v.planned = false;
    v.plannedEnd = null;
    v.to = Infinity;
    const t = Math.max(now + 0.005, v.fadeInEnd);
    hold(v.out.gain, t);
    // Ramped: if the withdrawn handover had already begun to fade it, a snap
    // back to full would be an audible step.
    v.out.gain.linearRampToValueAtTime(v.level, t + EDGE * 2);
  }

  // -- chunks -------------------------------------------------------------------

  bufferKey(id, k) {
    return id + "|" + k;
  }

  // Create the sources for the part of `v` due within SCHED_AHEAD; note the
  // chunks it needs in `wants` (with when they are needed) for the fetcher.
  schedule(v, S, now, wants) {
    if (v.stopAt && v.ends <= now) return;
    const L = this.len;
    const last = Math.min(v.end, lastChunk(v.track.duration, L));
    const posNow = Math.max(v.from, positionAt(v.tl, S));
    const posSched = Math.min(v.to, positionAt(v.tl, S + SCHED_AHEAD * 1000));
    const posFetch = Math.min(v.to, positionAt(v.tl, S + FETCH_AHEAD * 1000));
    if (v === this.pending && serverTimeAt(v.tl, v.from) - S > NEXT_PRELOAD * 1000) return;
    const k0 = chunkIndex(posNow, L);
    const kF = Math.min(last, chunkIndex(Math.max(posNow, posFetch), L));
    for (let k = k0; k <= kF; k++) {
      const needAt = serverTimeAt(v.tl, Math.max(k * L, v.from));
      const entry = this.buffers.get(this.bufferKey(v.id, k));
      if (!entry || entry.buf === undefined) {
        wants.push({ id: v.id, k, needAt });
        continue;
      }
      if (entry.buf === EMPTY) {
        v.end = Math.min(v.end, k - 1);
        break;
      }
      entry.used = now;
      if (Math.max(k * L, v.from) <= posSched && !v.nodes.has(k)) this.scheduleChunk(v, k, entry.buf, now);
    }
  }

  scheduleChunk(v, k, buf, now) {
    const L = this.len;
    const kL = k * L;
    let cs = Math.max(kL, v.from);
    const ce = Math.min(kL + buf.duration, v.to);
    if (ce - cs < 0.002) return;
    // When the content at kL is HEARD, on this device's audio clock.
    const T = this.toCtx(serverTimeAt(v.tl, kL));
    let start = T + (cs - kL);
    let fresh = false;
    if (start < now + LATE) {
      // Arrived late (or a fresh start that took long to decode): start with
      // what is due at `now + LATE`, not with what the room heard a moment ago.
      const shift = now + LATE - start;
      cs += shift;
      start += shift;
      fresh = true;
      if (ce - cs < 0.01) return;
    }
    const end = start + (ce - cs);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const env = this.ctx.createGain();
    src.connect(env);
    env.connect(v.out);
    // S: the server instant `T` was computed for — what lets checkMapping tell
    // a chunk placed on a mapping that has since moved.
    const node = { k, src, env, start, end, T, S: serverTimeAt(v.tl, kL), cs, tailFrom: 0 };

    // The seam with the chunk before, crossfaded in time.
    const prev = v.nodes.get(k - 1);
    let seam = false;
    if (prev && !fresh && cs === kL && prev.end > start + MIN_SEAM && prev.start < start) {
      const F = Math.min(this.ov, prev.end - start) - 0.001;
      if (F >= MIN_SEAM) {
        this.setTail(prev, start, F);
        env.gain.setValueAtTime(0, start);
        env.gain.linearRampToValueAtTime(1, start + F);
        seam = true;
      }
    }
    if (!seam) {
      if (prev && prev.end > start) this.setTail(prev, start, EDGE);
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(1, start + EDGE);
    }
    // Until a successor arrives, this chunk fades out at its own end: an
    // underrun is then a moment of silence, not a click.
    this.defaultTail(node);
    src.start(start, cs - kL, ce - cs);
    v.nodes.set(k, node);
  }

  setTail(n, at, dur) {
    const g = n.env.gain;
    g.cancelScheduledValues(Math.min(at, n.tailFrom || at));
    g.setValueAtTime(1, at);
    g.linearRampToValueAtTime(0, at + dur);
    n.tailFrom = at;
  }

  defaultTail(n) {
    const at = Math.max(n.start + EDGE, n.end - EDGE);
    this.setTail(n, at, n.end - at);
  }

  // Is the audible moment covered by a scheduled chunk?
  covered(v, S) {
    const pos = positionAt(v.tl, S);
    if (pos < v.from) return true; // not due yet: waiting is the plan
    const now = this.ctx.currentTime;
    for (const n of v.nodes.values()) if (n.start <= now + 0.05 && n.end > now) return true;
    const last = Math.min(v.end, lastChunk(v.track.duration, this.len));
    return chunkIndex(pos, this.len) > last; // the track is over, not starved
  }

  prefetch(S, wants) {
    wants.sort((a, b) => a.needAt - b.needAt);
    const now = this.ctx.currentTime;
    for (const w of wants) {
      if (this.inflight >= MAX_INFLIGHT) break;
      const key = this.bufferKey(w.id, w.k);
      let e = this.buffers.get(key);
      if (e && (e.loading || (e.retryAt && e.retryAt > S))) continue;
      if (!e) {
        e = { buf: undefined, used: now };
        this.buffers.set(key, e);
      }
      e.loading = true;
      this.inflight++;
      Promise.resolve()
        .then(() => this.load(w.id, w.k))
        .then(
          (buf) => {
            e.buf = buf || EMPTY;
            e.retryAt = 0;
          },
          (err) => {
            const retry = (err && err.retry) || 2;
            const S2 = this.serverNow();
            e.retryAt = (S2 == null ? 0 : S2) + retry * 1000;
          }
        )
        .finally(() => {
          e.loading = false;
          this.inflight--;
          this.tick();
        });
    }
  }

  cleanup(now) {
    for (const v of this.voices) {
      if (v !== this.cur && v !== this.pending && !v.stopAt) {
        // Orphaned (its handover was confirmed by a path that did not know
        // about it): it ends where it was planned to, or now.
        const e = v.plannedEnd;
        if (e) {
          v.stopAt = e.at;
          v.ends = e.ends;
        } else this.stopVoice(v, now, EDGE);
      }
      for (const n of v.nodes.values()) {
        if (n.end < now - 0.25) {
          try {
            n.src.disconnect();
            n.env.disconnect();
          } catch {
            /* ignore */
          }
          v.nodes.delete(n.k);
        }
      }
      if (v.stopAt && v.ends < now - 0.25) {
        for (const n of v.nodes.values()) this.dropNode(v, n);
        try {
          v.out.disconnect();
        } catch {
          /* ignore */
        }
        this.voices.delete(v);
      }
    }
    if (this.buffers.size > MAX_BUFFERS) {
      const keep = new Set();
      for (const v of [this.cur, this.pending]) {
        if (!v) continue;
        for (const k of v.nodes.keys()) keep.add(this.bufferKey(v.id, k));
      }
      const old = [...this.buffers.entries()]
        .filter(([k, e]) => !keep.has(k) && !e.loading)
        .sort((a, b) => a[1].used - b[1].used);
      for (const [k] of old.slice(0, this.buffers.size - MAX_BUFFERS)) this.buffers.delete(k);
    }
  }

  setStatus(s) {
    if (s === this.status) return;
    this.status = s;
    this.onChange(s);
  }
}

// -- the clock bridge (browser) -------------------------------------------------

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Map server time onto this AudioContext's clock: audio scheduled at the
// returned context time is HEARD at the given server time. getOutputTimestamp
// relates the two clocks where the sound actually leaves the device (it carries
// the output latency the browser knows about).
//
// Only a context that is RUNNING gives readings worth anything. Measured in
// Chromium: the very first reading after creation is ~140 ms off, and while the
// context is still starting, currentTime stands still as performance.now()
// runs on, so anything derived from it slides by the full startup time. So a
// reading is taken only once the context clock is moving, the mapping is the
// median of the recent ones, one that disagrees with it by more than a render
// quantum or two is dropped — and a run of them means the mapping really
// moved, and is re-learnt. It does move: measured again, a context whose
// mapping had held to ±0.2 ms stepped by exactly 20 ms three seconds in, and
// stayed there (the device's reported delay settling). The scheduler re-places
// whatever it placed on the old mapping (PartyEngine.checkMapping). Nothing is
// scheduled at all until a few agreeing readings exist (`ready`).
//
// `latencyMs()` is what the browser cannot know — a Bluetooth link, a speaker's
// own DSP — as set by the listener; `graphDelay` is this page's own processing
// (the limiter's lookahead), measured, not assumed.
const MAP_KEEP = 15;
const MAP_READY = 3;
const MAP_OUTLIER = 0.004; // s
const MAP_RELEARN = 5;

export function makeClockBridge(ctx, clockOffset, latencyMs, graphDelay = 0) {
  const ds = [];
  let lastCtx = -1;
  let rejected = 0;
  function sample() {
    if (ctx.state !== "running") return;
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
      d = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) - performance.now() / 1000;
    }
    if (d == null) return;
    if (ds.length >= MAP_READY && Math.abs(d - median(ds)) > MAP_OUTLIER) {
      if (++rejected < MAP_RELEARN) return;
      ds.length = 0; // it really moved: learn it again
    }
    rejected = 0;
    ds.push(d);
    if (ds.length > MAP_KEEP) ds.shift();
  }
  return {
    sample,
    get ready() {
      return ds.length >= MAP_READY;
    },
    // null until BOTH clocks are known: the scheduler places nothing before.
    serverNow() {
      const off = clockOffset();
      return off == null || ds.length < MAP_READY ? null : performance.now() + off;
    },
    toCtx(serverMs) {
      const off = clockOffset();
      if (off == null || !ds.length) return ctx.currentTime;
      return median(ds) + (serverMs - off - latencyMs()) / 1000 - graphDelay;
    },
  };
}
