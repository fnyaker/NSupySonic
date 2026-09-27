// The output clock every animation frame, lyric line and listen-party guest is
// timed on (src/lib/audio/latency.js), and the automatic look-ahead that puts
// the animations on the beat (src/lib/audio/graph.js).
//
// The contexts here are modelled on what headless Chromium measured, not on
// what would be convenient: the context renders in BURSTS of baseLatency, so
// currentTime runs between outputLatency and outputLatency + baseLatency
// ahead of what is heard (70.7..91.1 ms, for 72.0 + 23.2); getOutputTimestamp
// moves once per burst; and the engine asks right after a render, several
// times per burst. Every rule below was broken once by one of those facts.

import test from "node:test";
import assert from "node:assert/strict";
import { Param } from "./partymock.mjs";
import { readFileSync } from "node:fs";
import { appCoreFromBytes } from "../src/lib/appcore/core.js";

// The estimators are the app core's (Rust): loaded from the committed binary,
// as the page loads it before a party starts or the output clock is read.
appCoreFromBytes(readFileSync(new URL("../src/lib/appcore/appcore.wasm", import.meta.url)));

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
mem.set("viz.lookahead.learned", "30");

let now = 1000; // performance.now(), ms
performance.now = () => now;

const L = await import("../src/lib/audio/latency.js");
const { outputTrim, vizLookaheadMode, vizLookahead, eqBands } = await import("../src/lib/stores.js");

const OUT = 0.072;
const BASE = 0.0232;

// A context whose listener hears context time `now/1000 + d`, rendering one
// burst at a time: currentTime jumps by BASE at each render and otherwise
// stands still, and the output timestamp moves with it.
function burstyCtx(d, { timestamps = true } = {}) {
  const heard = () => now / 1000 + ctx.d;
  const burst = () => Math.floor((heard() + OUT) / BASE);
  const ctx = {
    d, // the true mapping; a test may move it, as a device does
    state: "running",
    outputLatency: OUT,
    baseLatency: BASE,
    get currentTime() {
      return (burst() + 1) * BASE;
    },
  };
  if (timestamps)
    ctx.getOutputTimestamp = () => {
      // The sample at the start of the current burst, and when it is heard.
      const contextTime = burst() * BASE - OUT;
      return { contextTime, performanceTime: (contextTime - ctx.d) * 1000 };
    };
  return ctx;
}

// The engine's rhythm: three readings per burst, all just after a render (a
// worklet message arrives right after the quantum that produced it) — so the
// first of them sees a new timestamp and the other two see it repeated.
function readBursts(ctx, n, sample = L.sampleOutputClock) {
  for (let i = 0; i < n; i++) {
    // The next render: where (heard + OUT) crosses a whole burst.
    const k = Math.floor((now / 1000 + ctx.d + OUT) / BASE) + 1;
    const render = (k * BASE - OUT - ctx.d) * 1000;
    for (const f of [0.01, 0.1, 0.2]) {
      now = render + f * BASE * 1000;
      sample(ctx);
    }
  }
}

const mapping = () => L.heardContextTime(now) - now / 1000;

test("a repeated output timestamp adds nothing to the clock", () => {
  const d = -0.5;
  const ctx = burstyCtx(d);
  readBursts(ctx, 20);
  // Two readings in three repeat the one before. Filling them in from the
  // attributes instead — what the engine did — pulls the median by more than
  // 5 ms at this phase, against a mapping the timestamps give to the bit.
  assert.ok(Math.abs(mapping() - d) < 1e-9, `mapping ${mapping()} against ${d}`);
});

test("the clock follows a mapping that steps once its buffer is full", () => {
  const ctx = burstyCtx(-0.3);
  readBursts(ctx, 40); // well past the 25 readings the median keeps
  assert.ok(Math.abs(mapping() + 0.3) < 1e-9);
  // The SAME context's mapping steps by one render burst, as headless Chromium's
  // did a few seconds into a track: a median keyed on `length % 3` froze the
  // moment the buffer filled, and every frame after that was handed out 23 ms
  // early for the rest of the session.
  ctx.d = -0.3 + BASE;
  readBursts(ctx, 20);
  assert.ok(Math.abs(mapping() - (-0.3 + BASE)) < 1e-9, `mapping stuck at ${mapping()}`);
  // And a DRIFT, which is what a sound card's clock does against the system's
  // (tens of ppm — here 0.1 ms per burst, far under the bound a move needs):
  // every reading is let in, so only the median can follow it. One keyed on
  // `length % 3` stayed where the buffer filled, 3 ms behind and growing.
  for (let i = 0; i < 30; i++) {
    ctx.d += 0.0001;
    readBursts(ctx, 1);
  }
  assert.ok(Math.abs(mapping() - ctx.d) < 0.0015, `mapping ${((mapping() - ctx.d) * 1000).toFixed(2)} ms behind the drift`);
});

test("with no output timestamp, the context is half a burst past its output latency", () => {
  assert.equal(L.reportedLag({ outputLatency: 0.072, baseLatency: 0.0232 }), 0.0836);
  assert.equal(L.reportedLag({ baseLatency: 0.0232 }), 0.0116);
  assert.equal(L.reportedLag(null), 0);
  // A context that is NOT bursty, sitting exactly in the middle of the swing:
  // the attributes must land on the true mapping. `outputLatency ||
  // baseLatency` is half a burst (11.6 ms) off it.
  const d = 0.25;
  const ctx = {
    state: "running",
    outputLatency: OUT,
    baseLatency: BASE,
    get currentTime() {
      return now / 1000 + d + OUT + BASE / 2;
    },
  };
  for (let i = 0; i < 30; i++) {
    now += 7;
    L.sampleOutputClock(ctx);
  }
  assert.ok(Math.abs(mapping() - d) < 1e-9, `mapping ${mapping()} against ${d}`);
});

test("the lag behind the listener is read at the instant, and its median over time", () => {
  const d = 0.1;
  const ctx = burstyCtx(d);
  readBursts(ctx, 20);
  // At any instant: currentTime minus the context time being heard.
  const ct = ctx.currentTime;
  assert.ok(Math.abs(L.contextLagNow(ctx, now, ct) - (ct - (now / 1000 + d))) < 1e-9);
  // Read at random moments, the median sits inside the burst's swing — the
  // output latency the settings page shows.
  for (let i = 0; i < 80; i++) {
    now += 13.7;
    L.noteContextLag(ctx);
  }
  const lag = L.outputLag(ctx);
  assert.ok(lag >= OUT && lag <= OUT + BASE, `lag ${lag}`);
  // A context the clock has never seen: the attributes.
  assert.equal(L.outputLag({ outputLatency: 0.05, baseLatency: 0.01 }), 0.055);
});

test("an element is heard after the whole graph, a direct one after the trim alone", () => {
  const d = 0.1;
  const ctx = burstyCtx(d);
  outputTrim.set(40);
  // Before the clock is believed: the attributes, whatever the instant.
  L.sampleOutputClock(ctx);
  const early = L.elementLag({}, { wired: true, ctx, lookahead: 0.03, graphDelay: 0.012, nowMs: now, ctxTime: 0 });
  assert.ok(Math.abs(early - (OUT + BASE / 2 + 0.03 + 0.012 + 0.04)) < 1e-9, `early ${early}`);
  readBursts(ctx, 20);
  // Then: the context's lag behind the listener AT THE INSTANT the element was
  // read, which cancels the render burst the element moves in. Nothing is
  // added for the element itself — measured end to end (test/party/run.mjs),
  // a line published this way is where the host is heard to 0.2-0.5 ms; the
  // 12 ms a probe once put down to the element was the two compressors'.
  const ct = ctx.currentTime;
  const lag = ct - (now / 1000 + d);
  const got = L.elementLag({}, { wired: true, ctx, lookahead: 0.03, graphDelay: 0.012, nowMs: now, ctxTime: ct });
  assert.ok(Math.abs(got - (lag + 0.03 + 0.012 + 0.04)) < 1e-9, `got ${got}`);
  // Played directly, the element's own clock already knows its output path.
  assert.equal(L.elementLag({}, { wired: false, ctx }), 0.04);
  outputTrim.set(5000); // out of range: held to the maximum
  assert.equal(L.trimSeconds(), 1);
  outputTrim.set(-900);
  assert.equal(L.trimSeconds(), -0.5);
  outputTrim.set("nonsense");
  assert.equal(L.trimSeconds(), 0);
  outputTrim.set(0);
});

test("one wild reading is refused; two that agree are a move, taken at once", () => {
  const ctx = burstyCtx(0.2);
  readBursts(ctx, 20);
  const gen = L.outputClockGeneration();
  // A single reading 30 ms off, then the old mapping again: noise.
  const saved = ctx.getOutputTimestamp;
  let firstCt = null;
  ctx.getOutputTimestamp = () => {
    const ts = saved();
    if (firstCt == null) firstCt = ts.contextTime;
    if (ts.contextTime === firstCt) return { contextTime: ts.contextTime, performanceTime: ts.performanceTime + 30 };
    return ts;
  };
  readBursts(ctx, 4);
  ctx.getOutputTimestamp = saved;
  assert.ok(Math.abs(mapping() - 0.2) < 1e-9, "a single reading must not move the clock");
  assert.equal(L.outputClockGeneration(), gen);
  // Two NEW readings that disagree with the mapping AND with each other: still
  // not a move. (Offsets per render burst — a repeated timestamp is not a new
  // reading — and not symmetric: a median of +30 and -30 lands on the mapping
  // by accident.)
  const offsets = [30, 15];
  let lastCt = null;
  let off = 0;
  ctx.getOutputTimestamp = () => {
    const ts = saved();
    if (ts.contextTime !== lastCt) {
      lastCt = ts.contextTime;
      off = offsets.length ? offsets.shift() : 0;
    }
    return { contextTime: ts.contextTime, performanceTime: ts.performanceTime + off };
  };
  readBursts(ctx, 4);
  ctx.getOutputTimestamp = saved;
  assert.ok(Math.abs(mapping() - 0.2) < 1e-9);
  // The mapping really steps: learnt from the second NEW reading that shows
  // it (a burst each here; three bursts is at most three), not the twelfth,
  // and anything fitted against the old one is told so.
  ctx.d = 0.2 - 0.0213;
  readBursts(ctx, 3);
  assert.ok(Math.abs(mapping() - (0.2 - 0.0213)) < 1e-9, `mapping ${mapping()}`);
  assert.equal(L.outputClockGeneration(), gen + 1);
  // ...and believed at once: a clock that went back to "not ready" would hand
  // the party host the attributes' estimate for the next second.
  assert.ok(L.outputClockReady());
});

test("the automatic look-ahead makes up exactly what is missing, and no more", () => {
  const W = L.LEAD_WANT;
  // Frames 30 ms late at the 5th percentile: that, plus the timer's slack.
  assert.ok(Math.abs(L.lookaheadStep(0, -0.03) - 0.034) < 1e-12);
  assert.ok(Math.abs(L.lookaheadStep(0.02, -0.01) - 0.034) < 1e-12);
  // On time, or early by a little: nothing moves — every move is a pitch glide.
  for (const p05 of [W - 0.0015, W, W + 0.01, W + 0.024]) assert.equal(L.lookaheadStep(0.02, p05), 0.02);
  // A clear surplus is given back, down to nothing at all.
  assert.ok(Math.abs(L.lookaheadStep(0.04, 0.035) - 0.0215) < 1e-12);
  assert.equal(L.lookaheadStep(0.04, 0.2), 0);
  assert.equal(L.lookaheadStep(0, 0.2), 0);
  assert.equal(L.lookaheadStep(0.02, NaN), 0.02);
});

// --- the delay itself, on a recording AudioContext -------------------------------

class MockNode {
  constructor(ctx) {
    this.ctx = ctx;
  }
  connect(n) {
    return n;
  }
  disconnect() {}
}
class MockAC {
  constructor() {
    this.currentTime = 0;
    this.state = "running";
    this.sampleRate = 48000;
    this.destination = new MockNode(this);
    this.delays = [];
    MockAC.last = this;
  }
  resume() {
    return Promise.resolve();
  }
  node(params) {
    const n = new MockNode(this);
    for (const [k, v] of Object.entries(params)) n[k] = new Param(this, v);
    return n;
  }
  createGain() {
    return this.node({ gain: 1 });
  }
  createBiquadFilter() {
    return this.node({ frequency: 350, Q: 1, gain: 0 });
  }
  createDynamicsCompressor() {
    return this.node({ threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 });
  }
  createAnalyser() {
    return new MockNode(this);
  }
  createDelay() {
    const n = this.node({ delayTime: 0 });
    this.delays.push(n);
    return n;
  }
  createMediaElementSource() {
    return new MockNode(this);
  }
}
globalThis.window = { AudioContext: MockAC };

function delayParam() {
  return MockAC.last.delays[0].delayTime;
}

test("a graph built before anything plays starts on the learned look-ahead, with no glide", async () => {
  vizLookaheadMode.set("auto");
  const G = await import("../src/lib/audio/graph.js?idle");
  G.registerSource({ paused: true });
  G.requestAnalyser();
  const p = delayParam();
  assert.equal(p.valueAt(0), 0.03);
  assert.ok(!p.events.some((e) => e.type === "lin"), "nothing to ramp: no audio has flowed yet");

  // The engine asks for 20 ms more: a straight line at 0.3% of speed, five
  // cents, landing 6.7 s later.
  MockAC.last.currentTime = 10;
  G.setAutoLookahead(0.05);
  const ramp = p.events.filter((e) => e.type === "lin").at(-1);
  assert.equal(ramp.v, 0.05);
  assert.ok(Math.abs(ramp.t - (10 + 0.02 / 0.003)) < 1e-9, `lands at ${ramp.t}`);
  const slope = (p.valueAt(12) - p.valueAt(11)) / 1;
  assert.ok(Math.abs(slope - 0.003) < 1e-9, `slope ${slope}`);
  assert.equal(mem.get("viz.lookahead.learned"), "50", "remembered for this device's next graph");
  assert.ok(!G.lookaheadSettled());

  // An EQ tweak runs applyEffects: the delay must not be touched again.
  const before = p.events.length;
  eqBands.set([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(p.events.length, before);

  // Capped: the engine cannot ask for a delay nobody would accept.
  G.setAutoLookahead(0.5);
  assert.equal(p.events.at(-1).v, 0.15);

  // By hand, the listener's own value, in a quarter of a second: they asked.
  vizLookahead.set(100);
  vizLookaheadMode.set("manual");
  const target = p.events.at(-1);
  assert.equal(target.type, "target");
  assert.equal(target.v, 0.1);
  assert.equal(target.tc, 0.25);
  vizLookaheadMode.set("auto");
});

test("a graph built under a playing track starts at zero and glides to the learned look-ahead", async () => {
  mem.set("viz.lookahead.learned", "30");
  const G = await import("../src/lib/audio/graph.js?playing");
  G.registerSource({ paused: false });
  G.requestAnalyser();
  const p = delayParam();
  // Switched in full, the delay line would be 30 ms of silence in the middle
  // of the song.
  assert.equal(p.valueAt(0), 0);
  const ramp = p.events.filter((e) => e.type === "lin").at(-1);
  assert.equal(ramp.v, 0.03);
  assert.ok(Math.abs(ramp.t - 0.03 / 0.003) < 1e-9);
});
