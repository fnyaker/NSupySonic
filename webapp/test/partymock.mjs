// A recording AudioContext for the listen party's scheduler, and an evaluator
// that answers the only question that matters: at a given instant, WHAT CONTENT
// is this device playing, and how loud?
//
// The scheduler never makes sound itself — it creates buffer sources, starts
// them at context times with offsets, and automates gains. So a faithful record
// of those calls, replayed through the same maths the audio thread applies
// (Web Audio's automation rules, simplified to the event types the engine
// uses), is an exact picture of what would come out of the speaker. That is
// what lets the tests assert things like "the content heard at server time S is
// the timeline's position at S, to the microsecond, across every seam".

export class Param {
  constructor(ctx, v) {
    this.ctx = ctx;
    this.v0 = v;
    this.events = [];
  }
  get value() {
    return this.valueAt(this.ctx.currentTime);
  }
  // Per spec: assigning `value` is setValueAtTime(v, currentTime).
  set value(v) {
    this.events.push({ type: "set", v, t: this.ctx.currentTime });
  }
  setValueAtTime(v, t) {
    this.events.push({ type: "set", v, t });
  }
  linearRampToValueAtTime(v, t) {
    this.events.push({ type: "lin", v, t });
  }
  setValueCurveAtTime(curve, t, d) {
    // Per spec, a curve may not overlap another automation event.
    for (const e of this.events) {
      if (e.type === "curve" ? e.t < t + d && t < e.t + e.d : e.t > t && e.t < t + d)
        throw new Error("NotSupportedError: overlapping curve");
    }
    this.events.push({ type: "curve", curve: Array.from(curve), t, d });
  }
  setTargetAtTime(v, t, tc) {
    this.events.push({ type: "target", v, t, tc });
  }
  cancelScheduledValues(t) {
    this.events = this.events.filter((e) => e.t < t);
  }
  // Per spec: everything after t goes, and whatever was in progress at t is
  // cut there, holding the value it had reached. A ramp that straddled t is
  // replaced by one that ENDS at t with that value — the same straight line.
  cancelAndHoldAtTime(t) {
    const v = this.valueAt(t);
    this.events = this.events
      .filter((e) => e.t < t)
      .map((e) => (e.type === "curve" && e.t + e.d > t ? { ...e, d: t - e.t, truncated: v } : e));
    this.events.push({ type: "lin", v, t });
  }
  valueAt(t) {
    const evs = [...this.events].sort((a, b) => a.t - b.t);
    let v = this.v0;
    let pt = 0;
    for (const e of evs) {
      if (e.type === "set") {
        if (e.t > t) break;
        v = e.v;
        pt = e.t;
      } else if (e.type === "lin") {
        if (e.t <= t) {
          v = e.v;
          pt = e.t;
        } else {
          if (t <= pt) return v;
          return v + ((e.v - v) * (t - pt)) / (e.t - pt);
        }
      } else if (e.type === "curve") {
        if (e.t > t) break;
        const end = e.t + e.d;
        if (e.truncated !== undefined && t >= end) {
          v = e.truncated;
          pt = end;
          continue;
        }
        if (t >= end) {
          v = e.curve[e.curve.length - 1];
          pt = end;
        } else {
          const x = ((t - e.t) / e.d) * (e.curve.length - 1);
          const i = Math.floor(x);
          const f = x - i;
          return e.curve[i] + (e.curve[Math.min(i + 1, e.curve.length - 1)] - e.curve[i]) * f;
        }
      } else if (e.type === "target") {
        if (e.t > t) break;
        v = e.v + (v - e.v) * Math.exp(-(t - e.t) / e.tc);
        pt = t;
      }
    }
    return v;
  }
}

class Node {
  constructor(ctx) {
    this.ctx = ctx;
    this.outputs = new Set();
  }
  connect(n) {
    this.outputs.add(n);
    return n;
  }
  disconnect() {
    this.outputs.clear();
  }
}

class Gain extends Node {
  constructor(ctx) {
    super(ctx);
    this.gain = new Param(ctx, 1);
  }
}

class Source extends Node {
  constructor(ctx) {
    super(ctx);
    this.buffer = null;
    this.when = null;
    this.stopWhen = Infinity;
  }
  start(when = 0, offset = 0, duration = Infinity) {
    if (this.when !== null) throw new Error("InvalidStateError: start twice");
    this.when = Math.max(when, this.ctx.currentTime);
    // A start in the past plays from `now`, having skipped what it missed —
    // exactly as the audio thread does.
    const skipped = this.when - when;
    this.offset = offset + skipped;
    this.duration = Math.min(duration - skipped, this.buffer.duration - this.offset);
    this.ctx.sources.push(this);
  }
  stop(when = 0) {
    this.stopWhen = Math.max(when, this.ctx.currentTime);
  }
  // Content position (seconds into the chunk's buffer) at context time c, or
  // null when silent.
  contentAt(c) {
    if (this.when === null || c < this.when || c >= this.stopWhen) return null;
    const x = this.offset + (c - this.when);
    if (x >= this.offset + this.duration) return null;
    return x;
  }
}

export class MockContext {
  constructor({ sampleRate = 48000 } = {}) {
    this.currentTime = 0;
    this.sampleRate = sampleRate;
    this.destination = new Node(this);
    this.sources = [];
  }
  createGain() {
    return new Gain(this);
  }
  createBufferSource() {
    return new Source(this);
  }
}

// Product of every gain between `node` and the destination (0 if the chain is
// broken — a disconnected node is silent).
function pathGain(ctx, node, c) {
  let g = 1;
  let n = node;
  for (let hops = 0; hops < 10; hops++) {
    if (n === ctx.destination) return g;
    if (n.gain) g *= n.gain.valueAt(c);
    const outs = [...n.outputs];
    if (!outs.length) return 0;
    n = outs[0];
  }
  return 0;
}

// What is audible at context time `c`: [{ id, k, pos (content seconds), g }].
export function audibleAt(ctx, c, chunkLen) {
  const out = [];
  for (const s of ctx.sources) {
    const x = s.contentAt(c);
    if (x === null) continue;
    const g = pathGain(ctx, s, c);
    if (g <= 1e-6) continue;
    out.push({ id: s.buffer.id, k: s.buffer.k, pos: s.buffer.k * chunkLen + x, g });
  }
  return out;
}

// A decoded chunk: content [k·L, k·L + L + ov) clipped to the track.
export function chunkBuffer(id, k, len, ov, duration) {
  const d = Math.min(len + ov, duration - k * len);
  if (d <= 0) return null;
  return { id, k, duration: d, length: Math.round(d * 48000), sampleRate: 48000 };
}
