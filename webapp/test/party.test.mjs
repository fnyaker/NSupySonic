// The listen party's sync machinery (lib/party/).
//
// "Synchronised" is a claim about what comes out of the speaker, so that is
// what these tests measure. The guest's scheduler runs against a recording
// AudioContext (test/partymock.mjs) in virtual time — polls a poll late, chunks
// arriving after a network delay, 503s, a host that re-anchors, pauses, skips
// and crossfades — and after every step the record is replayed to answer: at
// this server instant, what content was audible, and how loud? That is then
// compared with the timeline the host published.
//
// The clock and the host's anchor fit are measured the same way: fed the kind
// of input they get in the field (asymmetric, heavy-tailed network queueing;
// a currentTime that steps and a timer that jitters), and held to a number.

import test from "node:test";
import assert from "node:assert/strict";
import { ClockEstimator, probeSample } from "../src/lib/party/clock.js";
import { AnchorFit } from "../src/lib/party/anchor.js";
import {
  SEAM_MS,
  chunkIndex,
  correctionFor,
  lastChunk,
  nextTimeline,
  positionAt,
  serverTimeAt,
} from "../src/lib/party/timeline.js";
import { PartyEngine, makeClockBridge, normGain } from "../src/lib/party/engine.js";
import {
  HANDOVER_HOLD_MS,
  HOLD,
  STALL_MS,
  elementState,
  hostPhase,
  hostState,
} from "../src/lib/party/hostrules.js";
import { MockContext, audibleAt, chunkBuffer } from "./partymock.mjs";

// -- a deterministic random source ------------------------------------------------

function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// -- the clock ------------------------------------------------------------------------

// Probes through a simulated network: a 4 ms base round trip split unevenly
// (1.5 out, 2.5 back — half that difference, 0.5 ms, is the error NO method can
// see), plus queueing that is exponential with a long tail and hits each leg
// independently, which is the shape wifi and a busy thread pool produce.
function clockErrors({ skew = 0, queueMs, seeds = 12, probes = 150 }) {
  const errs = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const r = rng(seed);
    const exp = (m) => -Math.log(1 - r()) * m;
    const est = new ClockEstimator();
    let local = 0;
    for (let i = 0; i < probes; i++) {
      local += 2000; // the steady probing interval
      const out = 1.5 + exp(queueMs);
      const back = 2.5 + exp(queueMs);
      const trueOff = 5000 + skew * local;
      const t0 = local;
      const t1 = t0 + out + trueOff;
      const t3 = t0 + out + back;
      est.add(probeSample(t0, t1, t1, t3));
      if (i >= 15) errs.push(Math.abs(est.estimate(t3).offset - (5000 + skew * t3)));
    }
  }
  errs.sort((a, b) => a - b);
  return { median: errs[errs.length >> 1], p95: errs[Math.floor(errs.length * 0.95)] };
}

test("clock: min-RTT selection holds under asymmetric, heavy-tailed queueing", () => {
  // Measured: light queueing (2 ms/leg) 0.48 / 1.00 ms median / p95, heavy
  // (6 ms/leg) 0.55 / 1.60 — against the 0.5 ms the route itself hides.
  const light = clockErrors({ queueMs: 2 });
  assert.ok(light.median < 0.6 && light.p95 < 1.2, JSON.stringify(light));
  const heavy = clockErrors({ queueMs: 6 });
  assert.ok(heavy.median < 0.7 && heavy.p95 < 1.9, JSON.stringify(heavy));
});

test("clock: a drifting pair of clocks is followed, not averaged into staleness", () => {
  // 60 ppm is a bad-but-real crystal pair: 3.6 ms a minute. Treated as a
  // constant over the three-minute window, it would be ~5 ms stale. Measured
  // with the line fit: 0.48 / 1.00 ms (light queueing), 0.64 / 2.46 (heavy).
  const light = clockErrors({ skew: 60e-6, queueMs: 2 });
  assert.ok(light.median < 0.6 && light.p95 < 1.2, JSON.stringify(light));
  const heavy = clockErrors({ skew: 60e-6, queueMs: 6 });
  assert.ok(heavy.median < 0.8 && heavy.p95 < 2.9, JSON.stringify(heavy));
});

test("clock: a device that slept (clock stepped) is re-learnt, not averaged in", () => {
  const est = new ClockEstimator();
  let local = 0;
  for (let i = 0; i < 20; i++) {
    local += 2000;
    est.add(probeSample(local, local + 2 + 100, local + 2 + 100, local + 4));
  }
  // performance.now() did not advance through a sleep: the offset jumped 30 s.
  for (let i = 0; i < 3; i++) {
    local += 2000;
    est.add(probeSample(local, local + 2 + 30100, local + 2 + 30100, local + 4));
  }
  assert.ok(Math.abs(est.estimate(local + 4).offset - 30100) < 1);
});

// -- the host's anchor --------------------------------------------------------------------

test("anchor: a stepping currentTime read from a jittery timer fits to well under a millisecond", () => {
  // currentTime refreshed per 10 ms audio callback (so it lags by 0..10 ms),
  // read from a 250 ms interval that fires up to 12 ms late.
  const r = rng(11);
  const fit = new AnchorFit();
  const START = 5000; // ms, local
  const P0 = 42; // position at START
  const trueAt = (ms) => P0 + (ms - START) / 1000;
  let worst = 0;
  for (let i = 0; i < 60; i++) {
    const at = START + i * 250 + r() * 12;
    const reported = Math.floor(trueAt(at) * 100) / 100; // 10 ms steps
    assert.ok(fit.add(at, reported), "continuous playback must never break the line");
    if (i >= 8) worst = Math.max(worst, Math.abs(fit.positionAt(at) - trueAt(at)));
  }
  // The steps bias every reading LATE by 5 ms on average; that bias is a
  // property of the engine (identical for every reading) and is what a
  // listener's latency setting absorbs. What matters is that the line is
  // STEADY: the spread around it is a fraction of a millisecond.
  const bias = fit.positionAt(START + 20000) - trueAt(START + 20000);
  assert.ok(bias < 0 && bias > -0.011, `bias ${bias}`);
  assert.ok(worst < 0.011, `worst ${worst}`);
  const a = fit.positionAt(START + 30000) - trueAt(START + 30000);
  const b = fit.positionAt(START + 60000) - trueAt(START + 60000);
  assert.ok(Math.abs(a - b) < 1e-9, "a fitted line has no drift of its own");
});

test("anchor: a seek breaks the line at once", () => {
  const fit = new AnchorFit();
  for (let i = 0; i < 10; i++) fit.add(1000 + i * 250, 10 + i * 0.25);
  assert.equal(fit.add(3500, 60), false);
  assert.equal(fit.n, 1);
  assert.ok(Math.abs(fit.positionAt(3500) - 60) < 1e-9);
});

// -- the timeline -----------------------------------------------------------------------------

test("timeline: arithmetic and the correction policy", () => {
  const tl = { t: 10_000, p: 30, playing: true };
  assert.equal(positionAt(tl, 12_500), 32.5);
  assert.equal(serverTimeAt(tl, 32.5), 12_500);
  assert.equal(positionAt({ ...tl, playing: false }, 99_999), 30);
  const nxt = nextTimeline(tl, { track: { id: "b" }, at: 200, start: 0.4, gap: 0.15 });
  assert.deepEqual(nxt, { id: "b", t: 10_000 + 170_000 + 150, p: 0.4, playing: true });
  assert.equal(correctionFor(2), "keep");
  assert.equal(correctionFor(-20), "seam");
  assert.equal(correctionFor(-200), "jump");
  assert.equal(correctionFor(200), "wait");
  // Further ahead than any stall: the host went back, and so does the guest.
  assert.equal(correctionFor(2400), "wait");
  assert.equal(correctionFor(30_000), "jump");
  assert.equal(chunkIndex(11.999, 6), 1);
  assert.equal(chunkIndex(12, 6), 2);
  // A catalogue duration is whole seconds; the last chunk allows for one more
  // (a "216 s" file may run to 216.9: chunk 36 is [216, 222.05)).
  assert.equal(lastChunk(215, 6), 35);
  assert.equal(lastChunk(216, 6), 36);
  assert.equal(lastChunk(0, 6), Infinity);
});

test("normalisation matches the host's graph", () => {
  assert.equal(normGain(-8, "off"), 1);
  assert.equal(normGain(null, "high"), 1);
  // -(−8 + 18.4) + 5 = −5.4 dB
  assert.ok(Math.abs(normGain(-8, "medium") - Math.pow(10, -5.4 / 20)) < 1e-12);
});

// -- the guest scheduler, in virtual time ---------------------------------------------------------

const L = 6;
const OV = 0.05;
const S0 = 1_700_000_000_000;
const DT = 0.01; // s per simulation step

function makeSim({ tracks = { a: 240, b: 200 }, clockErrMs = 0, loadMs = () => 80, fail = () => null } = {}) {
  const ctx = new MockContext();
  const trueServer = () => S0 + ctx.currentTime * 1000;
  const sim = {
    ctx,
    errMs: clockErrMs,
    // The TRUE relation between the audio clock and the room: audio at context
    // time c is heard at server time S0 + c·1000 + truthMs. A device whose
    // output delay changes moves it — and the engine's measured mapping with it.
    truthMs: 0,
    host: null, // what the host has published (guests see it a poll late)
    loads: [],
    records: [],
    requested: [],
  };
  const engine = new PartyEngine({
    ctx,
    serverNow: () => trueServer() + sim.errMs,
    // The engine's belief about when server time S happens on its audio clock.
    toCtx: (S) => (S - sim.errMs - sim.truthMs - S0) / 1000,
    load: (id, k) =>
      new Promise((resolve, reject) => {
        sim.requested.push(`${id}|${k}`);
        const f = fail(id, k);
        sim.loads.push({ readyAt: ctx.currentTime + loadMs(id, k) / 1000, id, k, resolve, reject, f });
      }),
  });
  sim.engine = engine;

  const flush = () => new Promise((r) => setImmediate(r));
  sim.run = async (seconds, { pollEvery = 1, tickEvery = 0.2 } = {}) => {
    const until = ctx.currentTime + seconds;
    let nextPoll = sim.nextPoll ?? ctx.currentTime;
    let nextTick = sim.nextTick ?? ctx.currentTime;
    while (ctx.currentTime < until - 1e-9) {
      const prev = ctx.currentTime;
      ctx.currentTime = Math.round((prev + DT) * 1e6) / 1e6;
      // What was audible over the interval that just went by is final now.
      for (let c = prev + 0.0025; c <= ctx.currentTime + 1e-9; c += 0.0025) {
        sim.records.push({ S: S0 + c * 1000 + sim.truthMs, items: audibleAt(ctx, c, L) });
      }
      for (const l of sim.loads.filter((l) => l.readyAt <= ctx.currentTime)) {
        sim.loads.splice(sim.loads.indexOf(l), 1);
        if (l.f) l.reject(l.f);
        else l.resolve(chunkBuffer(l.id, l.k, L, OV, tracks[l.id]));
      }
      await flush();
      if (sim.hook) sim.hook();
      if (ctx.currentTime >= nextPoll - 1e-9) {
        if (sim.host) engine.apply(structuredClone(sim.host));
        nextPoll += pollEvery;
      }
      if (ctx.currentTime >= nextTick - 1e-9) {
        engine.tick();
        nextTick += tickEvery;
      }
      await flush();
    }
    sim.nextPoll = nextPoll;
    sim.nextTick = nextTick;
  };
  sim.now = trueServer;
  sim.publish = (st) => {
    sim.host = {
      live: true,
      xfade: 0,
      norm: "off",
      next: null,
      chunk: { len: L, ov: OV },
      ...st,
      track: st.track && { duration: tracks[st.track.id], gain: null, ...st.track },
    };
  };
  // Records in [fromS, toS) as { S, items }.
  sim.window = (fromS, toS) => sim.records.filter((r) => r.S >= fromS && r.S < toS);
  return sim;
}

// Weighted content position and total gain of one track in a record.
function heard(rec, id) {
  const its = rec.items.filter((i) => i.id === id);
  const g = its.reduce((a, i) => a + i.g, 0);
  if (!g) return { g: 0, pos: null };
  return { g, pos: its.reduce((a, i) => a + i.pos * i.g, 0) / g };
}

function assertFollows(sim, id, tl, fromS, toS, { tolMs = 0.05, level = 1, errMs = 0 } = {}) {
  const recs = sim.window(fromS, toS);
  assert.ok(recs.length > 10, "nothing to check");
  let worst = 0;
  for (const r of recs) {
    const h = heard(r, id);
    assert.ok(
      Math.abs(h.g - level) < 2e-3,
      `level ${h.g.toFixed(4)} at +${((r.S - fromS) / 1000).toFixed(3)} s (want ${level})`
    );
    const want = positionAt(tl, r.S + errMs);
    worst = Math.max(worst, Math.abs(h.pos - want) * 1000);
  }
  assert.ok(worst <= tolMs, `off the timeline by up to ${worst.toFixed(3)} ms`);
}

test("engine: joins mid-track and plays exactly on the timeline, seams included", async () => {
  const sim = makeSim();
  // The host has been playing track a for 100 s.
  const tl = { t: sim.now() - 100_000, p: 20, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: { t: tl.t, p: tl.p } });
  await sim.run(40);
  // From one second in (first poll + one chunk fetch) to the end: every
  // instant, six seams included, is the right content at full level.
  const t0 = S0 + 1000;
  assertFollows(sim, "a", tl, t0, sim.now() - 50);
  // ...and nothing before the first chunk arrived was played late: the audio
  // starts on the timeline, not from wherever the chunk begins.
  const first = sim.records.find((r) => heard(r, "a").g > 0);
  assert.ok(Math.abs(heard(first, "a").pos - positionAt(tl, first.S)) < 0.001);
});

test("engine: a clock estimate error shifts the sound by exactly that error, nothing else", async () => {
  // The only thing a guest cannot measure is its own error; everything else
  // must be exact on top of it.
  const sim = makeSim({ clockErrMs: 7 });
  const tl = { t: sim.now() - 50_000, p: 0, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: { t: tl.t, p: tl.p } });
  await sim.run(20);
  assertFollows(sim, "a", tl, S0 + 1500, sim.now() - 50, { errMs: 7 });
});

test("engine: an improving clock estimate is absorbed at a seam, without a gap or a click", async () => {
  // Past the first burst the estimate moves by a few milliseconds at most when
  // a better probe lands (the E2E run measured ±0.1–0.4 ms spreads). A step
  // beyond MAP_NOW_MS is a different event and is re-placed at once (below).
  const sim = makeSim({ clockErrMs: 6 });
  const tl = { t: sim.now(), p: 0, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: { t: tl.t, p: tl.p } });
  await sim.run(8);
  const fixedAt = sim.now();
  sim.errMs = 0; // better probes arrived: the estimate moved by 6 ms
  await sim.run(20);
  // Everything after the first seam that follows the change is exact.
  const seam = S0 + (Math.ceil((fixedAt - S0) / 1000 / L) + 1) * L * 1000;
  assertFollows(sim, "a", tl, seam + 100, sim.now() - 50);
  // And the audio never dropped out in between.
  for (const r of sim.window(S0 + 1500, sim.now() - 50)) assert.ok(heard(r, "a").g > 0.99, "a dropout");
});

test("engine: the device's output delay steps mid-chunk — re-placed at once, in both directions", async () => {
  // Measured in Chromium: getOutputTimestamp held to ±0.2 ms, then stepped by
  // exactly 20 ms three seconds in. Before this was handled, the chunks already
  // placed stayed 20 ms off until the next seam, which then could not absorb it.
  for (const step of [20, -91]) {
    const sim = makeSim();
    const tl = { t: sim.now(), p: 0, playing: true };
    sim.publish({ track: { id: "a" }, playing: true, anchor: tl });
    await sim.run(8.3);
    const at = sim.now() + sim.truthMs;
    sim.truthMs += step;
    await sim.run(12);
    // Within a tick, a lead and a fade, every instant is exact again.
    assertFollows(sim, "a", tl, at + 400, sim.now() + sim.truthMs - 50);
    // And nothing the room already heard is played twice.
    let last = -1;
    for (const r of sim.window(S0 + 1500, sim.now() + sim.truthMs - 50)) {
      const h = heard(r, "a");
      if (h.g < 0.5) continue;
      assert.ok(h.pos >= last - 0.013, `step ${step}: content went back from ${last} to ${h.pos}`);
      last = h.pos;
    }
  }
});

test("engine: a small re-anchor from the host lands at the next seam", async () => {
  const sim = makeSim();
  const tl = { t: sim.now(), p: 0, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl });
  await sim.run(7);
  // The host's audio clock drifted 20 ms behind the line it published.
  const tl2 = { t: sim.now(), p: positionAt(tl, sim.now()) - 0.02, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl2 });
  await sim.run(15);
  assertFollows(sim, "a", tl2, S0 + 13_500, sim.now() - 50);
  for (const r of sim.window(S0 + 1500, sim.now() - 50)) assert.ok(heard(r, "a").g > 0.99, "a dropout");
});

test("engine: host jumped ahead — the guest jumps too, at once", async () => {
  const sim = makeSim();
  const tl = { t: sim.now(), p: 0, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl });
  await sim.run(5);
  const tl2 = { t: sim.now(), p: positionAt(tl, sim.now()) + 30, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl2 });
  await sim.run(6);
  // Within a poll, a chunk fetch and the lead, it is on the new line.
  assertFollows(sim, "a", tl2, tl2.t + 1400, sim.now() - 50);
});

test("engine: guest ahead — it falls silent and resumes the SAME audio, never repeating it", async () => {
  const sim = makeSim();
  const tl = { t: sim.now(), p: 0, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl });
  await sim.run(5);
  // The host stalled for 700 ms: its line is now 0.7 s behind ours.
  const tl2 = { t: sim.now(), p: positionAt(tl, sim.now()) - 0.7, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl2 });
  await sim.run(6);
  const recs = sim.window(S0 + 1500, sim.now() - 50);
  let last = -1;
  let silent = 0;
  for (const r of recs) {
    const h = heard(r, "a");
    if (h.g < 0.5) {
      silent++;
      continue;
    }
    assert.ok(h.pos >= last - 0.013, `content went BACK from ${last} to ${h.pos}`);
    last = h.pos;
  }
  // About as long a silence as the stall (records are 2.5 ms apart).
  assert.ok(silent * 2.5 > 600 && silent * 2.5 < 800, `silent ${silent * 2.5} ms`);
  assertFollows(sim, "a", tl2, sim.now() - 3000, sim.now() - 50);
});

test("engine: pause then resume — the overshoot is not replayed", async () => {
  const sim = makeSim();
  const tl = { t: sim.now(), p: 0, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl });
  await sim.run(4.3);
  // The host pauses; guests only learn at their next poll.
  const pausedAt = positionAt(tl, sim.now());
  sim.publish({ track: { id: "a" }, playing: false, anchor: { t: sim.now(), p: pausedAt } });
  await sim.run(3);
  const stopRec = [...sim.records].reverse().find((r) => heard(r, "a").g > 0.5);
  const stoppedAt = heard(stopRec, "a").pos;
  assert.ok(stoppedAt > pausedAt, "the guest did overshoot (it heard of the pause late)");
  // Resume.
  const tl2 = { t: sim.now(), p: pausedAt, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl2 });
  await sim.run(6);
  const after = sim.window(tl2.t, sim.now()).filter((r) => heard(r, "a").g > 0.5);
  // The first thing heard after the resume continues where THIS device
  // stopped — and it is heard exactly when the shared timeline gets there.
  const first = heard(after[0], "a").pos;
  assert.ok(first >= stoppedAt - 0.013, `replayed from ${first}, stopped at ${stoppedAt}`);
  assertFollows(sim, "a", tl2, after[0].S + 50, sim.now() - 50);
});

test("engine: the next track starts on the predicted beat, before the host says so", async () => {
  const sim = makeSim();
  const tl = { t: sim.now() - 225_000, p: 0, playing: true }; // a is 240 s long
  const next = { track: { id: "b" }, at: 234.5, start: 0.35, fade: 0, gap: 0.12 };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl, next });
  await sim.run(12);
  const ntl = nextTimeline(tl, next);
  const handover = ntl.t;
  // The host confirms B only 900 ms after it started it.
  await sim.run((handover - sim.now()) / 1000 + 0.9);
  sim.publish({ track: { id: "b" }, playing: true, anchor: { t: ntl.t, p: ntl.p } });
  await sim.run(8);
  // A plays up to where the host cuts it (`at`), silence for the host's own
  // start-up gap, then B from exactly its trimmed start.
  const cut = serverTimeAt(tl, next.at);
  assertFollows(sim, "a", tl, S0 + 1500, cut - 20);
  for (const r of sim.window(cut + 1, handover - 1)) assert.equal(heard(r, "a").g + heard(r, "b").g, 0);
  assertFollows(sim, "b", ntl, handover + 20, sim.now() - 50);
});

test("engine: a crossfade is two equal-power ramps on the right content", async () => {
  const sim = makeSim();
  const tl = { t: sim.now() - 225_000, p: 0, playing: true };
  const next = { track: { id: "b" }, at: 233, start: 0, fade: 6, gap: 0 };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl, next, xfade: 0 });
  await sim.run(10);
  const ntl = nextTimeline(tl, next);
  await sim.run((ntl.t - sim.now()) / 1000 + 1);
  sim.publish({ track: { id: "b" }, playing: true, anchor: { t: ntl.t, p: 0 }, xfade: 6 });
  await sim.run(10);
  for (const r of sim.window(ntl.t + 50, ntl.t + 5950)) {
    const a = heard(r, "a");
    const b = heard(r, "b");
    // Each track is on its own timeline...
    assert.ok(Math.abs(a.pos - positionAt(tl, r.S)) < 1e-4);
    assert.ok(Math.abs(b.pos - positionAt(ntl, r.S)) < 1e-4);
    // ...and the power sums to one all the way across (uncorrelated signals
    // add in power; a linear pair would dip 3 dB in the middle).
    assert.ok(Math.abs(a.g * a.g + b.g * b.g - 1) < 0.01, `power ${a.g ** 2 + b.g ** 2}`);
  }
  assertFollows(sim, "b", ntl, ntl.t + 6100, sim.now() - 50);
});

test("engine: the host's real gap was longer — silence, then B in time, never a repeat", async () => {
  const sim = makeSim();
  const tl = { t: sim.now() - 225_000, p: 0, playing: true };
  const next = { track: { id: "b" }, at: 234, start: 0, fade: 0, gap: 0.05 };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl, next });
  await sim.run(12);
  const predicted = nextTimeline(tl, next);
  // The host actually needed 400 ms more to start B.
  const actual = { t: predicted.t + 400, p: 0, playing: true };
  await sim.run((actual.t - sim.now()) / 1000 + 0.7);
  sim.publish({ track: { id: "b" }, playing: true, anchor: actual });
  await sim.run(6);
  let last = -1;
  for (const r of sim.window(predicted.t, sim.now() - 50)) {
    const h = heard(r, "b");
    if (h.g < 0.5) continue;
    assert.ok(h.pos >= last - 0.013, "B went back");
    last = h.pos;
  }
  assertFollows(sim, "b", actual, sim.now() - 4000, sim.now() - 50);
});

test("engine: a skip fades the old track out fast and starts the new one on its timeline", async () => {
  const sim = makeSim();
  const tl = { t: sim.now(), p: 0, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl });
  await sim.run(5);
  const tl2 = { t: sim.now(), p: 0, playing: true };
  sim.publish({ track: { id: "b" }, playing: true, anchor: tl2 });
  await sim.run(6);
  // A is gone within a poll plus the ramp; B follows its line after a fetch.
  for (const r of sim.window(tl2.t + 1200, sim.now())) assert.equal(heard(r, "a").g, 0);
  assertFollows(sim, "b", tl2, tl2.t + 1400, sim.now() - 50);
});

test("engine: a chunk that arrives late costs silence, then lands exactly on time", async () => {
  // Chunk 3 ([18, 24) s) takes 25 s to arrive — long after it was due.
  const sim = makeSim({ loadMs: (id, k) => (k === 3 ? 25_000 : 80) });
  const tl = { t: sim.now(), p: 0, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl });
  await sim.run(40);
  const gap = sim.window(S0 + 1500, sim.now()).filter((r) => heard(r, "a").g < 0.5);
  // A hole where chunk 3 should have been, and nowhere else.
  assert.ok(gap.length * 2.5 > 5900 && gap.length * 2.5 < 6100, `hole of ${gap.length * 2.5} ms`);
  // Before and after it, every instant is exact.
  assertFollows(sim, "a", tl, S0 + 1000, S0 + 17_990);
  assertFollows(sim, "a", tl, S0 + 24_020, sim.now() - 50);
  // No click: the level never jumps from full to nothing in one step.
  const recs = sim.window(S0 + 1000, sim.now());
  for (let i = 1; i < recs.length; i++) {
    const d = Math.abs(heard(recs[i], "a").g - heard(recs[i - 1], "a").g);
    assert.ok(d < 0.25, `a step of ${d.toFixed(2)} in 2.5 ms`);
  }
});

test("engine: 'not ready yet' is retried after Retry-After, not dropped", async () => {
  let refusals = 0;
  const sim = makeSim({
    fail: (id, k) => (k === 0 && refusals++ < 2 ? { retry: 1 } : null),
  });
  const tl = { t: sim.now(), p: 0, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl });
  await sim.run(10);
  assert.equal(refusals, 3);
  assertFollows(sim, "a", tl, S0 + 4000, sim.now() - 50);
});

test("engine: repeat-one — the 'next' track is this one, from the top", async () => {
  const sim = makeSim({ tracks: { a: 60 } });
  const tl = { t: sim.now() - 45_000, p: 0, playing: true };
  const next = { track: { id: "a" }, at: 60, start: 0, fade: 0, gap: 0.03 };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl, next });
  await sim.run(12);
  const ntl = nextTimeline(tl, next);
  await sim.run((ntl.t - sim.now()) / 1000 + 0.8);
  sim.publish({ track: { id: "a" }, playing: true, anchor: { t: ntl.t, p: 0 } });
  await sim.run(8);
  assertFollows(sim, "a", ntl, ntl.t + 30, sim.now() - 50);
});

test("engine: memory stays flat over a long track", async () => {
  const sim = makeSim({ tracks: { a: 900 } });
  const tl = { t: sim.now(), p: 0, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl });
  let most = 0;
  for (let i = 0; i < 12; i++) {
    await sim.run(10);
    most = Math.max(most, sim.engine.buffers.size);
    const live = [...sim.engine.voices].reduce((a, v) => a + v.nodes.size, 0);
    assert.ok(live <= 3, `${live} live chunk sources`);
  }
  assert.ok(most <= 12, `${most} decoded chunks held`);
  // Everything asked for was asked for once.
  assert.equal(new Set(sim.requested).size, sim.requested.length);
});

test("engine: nothing is fetched past the end of a track", async () => {
  const sim = makeSim({ tracks: { a: 20 } });
  const tl = { t: sim.now() - 5000, p: 0, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl });
  await sim.run(25);
  const ks = sim.requested.map((x) => +x.split("|")[1]);
  assert.ok(Math.max(...ks) <= lastChunk(20, L), `asked for chunk ${Math.max(...ks)}`);
  assert.equal(sim.engine.status, "sync");
  // Silent after the end, not stuck on a sound.
  for (const r of sim.window(tl.t + 20_100, sim.now())) assert.equal(heard(r, "a").g, 0);
});

test("clock bridge: startup readings never place audio, and a real move is re-learnt", () => {
  // What Chromium does (measured): the first reading after creation is ~140 ms
  // off, and until the context runs its clock stands still. A bridge that
  // believed those scheduled its first chunks tens of milliseconds off.
  const TRUE = -4.75; // contextTime - performanceTime/1000, seconds (the page is older than the context)
  let perf = 1000;
  let ctxTime = 0;
  let state = "suspended";
  let calls = 0;
  const ctx = {
    get state() {
      return state;
    },
    get currentTime() {
      return ctxTime;
    },
    getOutputTimestamp() {
      calls++;
      if (calls === 1) return { contextTime: ctxTime + 0.001, performanceTime: perf - 140 };
      return { contextTime: ctxTime, performanceTime: (ctxTime - TRUE) * 1000 };
    },
  };
  const saved = globalThis.performance.now;
  globalThis.performance.now = () => perf;
  try {
    const b = makeClockBridge(ctx, () => 0, () => 0, 0);
    b.sample();
    assert.equal(b.serverNow(), null, "nothing is placed before the context runs");
    state = "running";
    for (let i = 0; i < 6; i++) {
      ctxTime += 0.05;
      perf += 50;
      b.sample();
    }
    assert.ok(b.ready);
    const S = 5000;
    assert.ok(Math.abs(b.toCtx(S) - (TRUE + S / 1000)) < 1e-9, "the garbage first reading is outvoted");
    // The output moved for real (headphones plugged in: 30 ms more latency).
    for (let i = 0; i < 12; i++) {
      ctxTime += 0.05;
      perf += 50;
      calls = 99;
      const o = ctx.getOutputTimestamp;
      ctx.getOutputTimestamp = () => ({ contextTime: ctxTime, performanceTime: (ctxTime - TRUE + 0.03) * 1000 });
      b.sample();
      ctx.getOutputTimestamp = o;
    }
    assert.ok(Math.abs(b.toCtx(S) - (TRUE - 0.03 + S / 1000)) < 1e-9, "a real change is re-learnt");
  } finally {
    globalThis.performance.now = saved;
  }
});

// -- the host moves on ----------------------------------------------------------------
//
// What a listener reported: skipping to the next track on the host, the guest
// did not always follow, and the OLD track carried on underneath the new one —
// through pauses, to its natural end. Everything below drives the host's moves
// at the guest the way they reach it (a poll late, sometimes two states folded
// into one poll) and asks the only question that matters: once the guest has
// had time to hear about it, is the one track the host plays the ONLY thing
// audible, and is it on the host's line?

const SKIP_TRACKS = { a: 240, b: 200, c: 180, d: 220 };

function assertSilent(sim, id, fromS, toS, what) {
  for (const r of sim.window(fromS, toS)) {
    const g = heard(r, id).g;
    assert.equal(g, 0, `${what}: ${id} audible (${g.toFixed(3)}) at +${((r.S - fromS) / 1000).toFixed(3)} s`);
  }
}

test("engine: a skip to the ANNOUNCED next track stops the old one — it does not play on to its end", async () => {
  // The case of the report. The host announces b (a's natural end is two
  // minutes away), so the guest has b planned; then the host skips to it NOW.
  // The planned end of a is two minutes out, and that is where it used to stop.
  for (const fade of [0, 6]) {
    const sim = makeSim({ tracks: SKIP_TRACKS });
    const tl = { t: sim.now() - 60_000, p: 0, playing: true };
    const next = { track: { id: "b" }, at: 234 - fade, start: 0, fade, gap: 0.1 };
    sim.publish({ track: { id: "a" }, playing: true, anchor: tl, next });
    await sim.run(5.4);
    const tl2 = { t: sim.now(), p: 0, playing: true };
    const next2 = { track: { id: "c" }, at: 190, start: 0, fade, gap: 0.1 };
    sim.publish({ track: { id: "b" }, playing: true, anchor: tl2, next: next2 });
    await sim.run(10);
    // A is gone within a poll plus the ramp — and stays gone.
    assertSilent(sim, "a", tl2.t + 1200, sim.now(), `fade ${fade}`);
    assertFollows(sim, "b", tl2, tl2.t + 1400, sim.now() - 50);
    // Nothing is left behind: the voices are b and its planned successor.
    assert.ok(sim.engine.voices.size <= 2, `${sim.engine.voices.size} voices alive`);
  }
});

test("engine: a skip in the last seconds before the handover stops the old track too", async () => {
  // Close enough to the predicted handover to be mistaken for it: the old
  // track must still end where the HOST ended it, not at its planned cut.
  const sim = makeSim({ tracks: SKIP_TRACKS });
  const tl = { t: sim.now() - 228_000, p: 0, playing: true };
  const next = { track: { id: "b" }, at: 234, start: 0, fade: 0, gap: 0.1 };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl, next });
  await sim.run(2.3); // a at ~230.3 s
  const tl2 = { t: sim.now(), p: 0, playing: true };
  sim.publish({ track: { id: "b" }, playing: true, anchor: tl2 });
  await sim.run(8);
  assertSilent(sim, "a", tl2.t + 1200, sim.now(), "late skip");
  assertFollows(sim, "b", tl2, tl2.t + 1400, sim.now() - 50);
});

test("engine: the host loading the new track — the old one stops at once, the new one lands on its line", async () => {
  // What the host publishes on a skip now: the new track, not playing yet
  // (`buf`), then its line once the element really plays it.
  const sim = makeSim({ tracks: SKIP_TRACKS });
  const tl = { t: sim.now() - 30_000, p: 0, playing: true };
  const next = { track: { id: "b" }, at: 234, start: 0, fade: 0, gap: 0.1 };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl, next });
  await sim.run(4.5);
  const skipAt = sim.now();
  sim.publish({ track: { id: "b" }, playing: false, buf: true, anchor: { t: skipAt, p: 0 } });
  await sim.run(1.7);
  const tl2 = { t: sim.now(), p: 0, playing: true };
  sim.publish({ track: { id: "b" }, playing: true, anchor: tl2 });
  await sim.run(8);
  assertSilent(sim, "a", skipAt + 1200, sim.now(), "loading");
  assertSilent(sim, "b", skipAt + 1200, tl2.t, "loading");
  assertFollows(sim, "b", tl2, tl2.t + 1400, sim.now() - 50);
});

test("engine: a pause mid-crossfade silences BOTH tracks", async () => {
  const sim = makeSim({ tracks: SKIP_TRACKS });
  const tl = { t: sim.now() - 225_000, p: 0, playing: true };
  const next = { track: { id: "b" }, at: 230, start: 0, fade: 8, gap: 0 };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl, next });
  await sim.run(6);
  const ntl = nextTimeline(tl, next);
  await sim.run((ntl.t - sim.now()) / 1000 + 1.2);
  sim.publish({ track: { id: "b" }, playing: true, anchor: { t: ntl.t, p: 0 }, xfade: 8 });
  await sim.run(1.5);
  // Two and a half seconds into an eight-second fade, the host pauses.
  const pausedAt = sim.now();
  sim.publish({ track: { id: "b" }, playing: false, anchor: { t: pausedAt, p: positionAt(ntl, pausedAt) } });
  await sim.run(6);
  assertSilent(sim, "a", pausedAt + 1200, sim.now(), "paused");
  assertSilent(sim, "b", pausedAt + 1200, sim.now(), "paused");
});

test("engine: a skip mid-crossfade silences both sides of the fade", async () => {
  const sim = makeSim({ tracks: SKIP_TRACKS });
  const tl = { t: sim.now() - 225_000, p: 0, playing: true };
  const next = { track: { id: "b" }, at: 230, start: 0, fade: 8, gap: 0 };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl, next });
  await sim.run(6);
  const ntl = nextTimeline(tl, next);
  await sim.run((ntl.t - sim.now()) / 1000 + 1.2);
  sim.publish({ track: { id: "b" }, playing: true, anchor: { t: ntl.t, p: 0 }, xfade: 8 });
  await sim.run(1.5);
  const tl3 = { t: sim.now(), p: 0, playing: true };
  sim.publish({ track: { id: "c" }, playing: true, anchor: tl3 });
  await sim.run(8);
  assertSilent(sim, "a", tl3.t + 1200, sim.now(), "skip");
  assertSilent(sim, "b", tl3.t + 1200, sim.now(), "skip");
  assertFollows(sim, "c", tl3, tl3.t + 1400, sim.now() - 50);
});

test("engine: the host seeks BACK — the guest follows at once instead of sitting out the difference", async () => {
  // "Ahead: wait for the timeline" is right for a stall of a few hundred
  // milliseconds. Applied to a thirty-second rewind it was thirty seconds of
  // silence.
  const sim = makeSim({ tracks: SKIP_TRACKS });
  const tl = { t: sim.now() - 60_000, p: 0, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl });
  await sim.run(5);
  const tl2 = { t: sim.now(), p: positionAt(tl, sim.now()) - 30, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl2 });
  await sim.run(6);
  assertFollows(sim, "a", tl2, tl2.t + 1400, sim.now() - 50);
});

test("engine: the host paused, seeked back, resumed — the guest resumes where the HOST did", async () => {
  const sim = makeSim({ tracks: SKIP_TRACKS });
  const tl = { t: sim.now() - 60_000, p: 0, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl });
  await sim.run(4.4);
  const pausedAt = positionAt(tl, sim.now());
  sim.publish({ track: { id: "a" }, playing: false, anchor: { t: sim.now(), p: pausedAt } });
  await sim.run(2);
  sim.publish({ track: { id: "a" }, playing: false, anchor: { t: sim.now(), p: pausedAt - 1.5 } });
  await sim.run(2);
  const tl2 = { t: sim.now(), p: pausedAt - 1.5, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl2 });
  await sim.run(6);
  assertFollows(sim, "a", tl2, tl2.t + 1400, sim.now() - 50);
});

test("engine: a wrong first line for the new track, corrected a moment later, ends on the right one", async () => {
  // The host's race this was built from: the store named the new track while
  // the element still held the old one, so its first anchor carried the OLD
  // track's position. The host no longer does that; the guest must still
  // survive it (an older host tab, a future bug).
  const sim = makeSim({ tracks: SKIP_TRACKS });
  const tl = { t: sim.now() - 120_000, p: 0, playing: true };
  sim.publish({ track: { id: "a" }, playing: true, anchor: tl, next: { track: { id: "b" }, at: 234, start: 0, fade: 0, gap: 0.1 } });
  await sim.run(4.5);
  sim.publish({ track: { id: "b" }, playing: true, anchor: { t: sim.now(), p: 124.5 } });
  await sim.run(1.2);
  const tl2 = { t: sim.now() + 300, p: 0, playing: true };
  sim.publish({ track: { id: "b" }, playing: true, anchor: tl2 });
  await sim.run(8);
  assertSilent(sim, "a", tl2.t, sim.now(), "bogus line");
  assertFollows(sim, "b", tl2, tl2.t + 1400, sim.now() - 50);
});

test("engine: whatever the host does, once the guest has heard of it only the host's track is audible", async () => {
  // A seeded walk through everything a host does — skips (to the announced
  // next or anywhere), skips that go through a loading state, seeks both ways,
  // pauses, seeks while paused, resumes, plans with and without a crossfade,
  // and tracks running into their planned handover with the host a little
  // late or early on its own prediction — each followed by a few seconds of
  // listening. Checked after every move: the host's track on its line and
  // nothing else, or silence while paused.
  const ids = Object.keys(SKIP_TRACKS);
  for (const seed of [3, 11, 29, 47, 83]) {
    const R = rng(seed);
    const pick = (xs) => xs[Math.floor(R() * xs.length)];
    const sim = makeSim({ tracks: SKIP_TRACKS });
    const H = { id: "a", tl: { t: sim.now() - 20_000, p: 0, playing: true }, next: null };
    const pos = () => positionAt(H.tl, sim.now());
    const send = (extra = {}) =>
      sim.publish({ track: { id: H.id }, playing: H.tl.playing, anchor: { t: H.tl.t, p: H.tl.p }, next: H.next, ...extra });
    const plan = () => {
      const other = pick(ids.filter((x) => x !== H.id));
      const fade = R() < 0.5 ? 0 : 5;
      return { track: { id: other }, at: SKIP_TRACKS[H.id] - 5 - fade, start: 0, fade, gap: 0.1 };
    };
    send();
    await sim.run(3);
    const log = [];
    for (let step = 0; step < 36; step++) {
      const moves = H.tl.playing
        ? ["skipNext", "skipNext", "skipAny", "skipLoading", "seekBack", "seekFwd", "pause", "plan", "handover", "handover"]
        : ["resume", "resume", "seekPaused", "skipAny"];
      let move = pick(moves);
      if (H.tl.playing && pos() > SKIP_TRACKS[H.id] - 30) move = "skipAny";
      if (move === "handover" && !H.next) move = "plan";
      log.push(move);
      const now = sim.now();
      let settleFrom = 0;
      if (move === "handover") {
        // Seek to a few seconds before the planned handover, let it come, and
        // confirm the next track the way the host does: once its element
        // plays, on the line it actually started on — its load time is never
        // exactly the one it predicted.
        const n = H.next;
        H.tl = { t: now, p: n.at - 3.5, playing: true };
        send();
        await sim.run(3.5 + 0.1);
        const real = { ...nextTimeline(H.tl, n) };
        real.t += (R() * 0.5 - 0.08) * 1000;
        await sim.run(Math.max(0, (real.t - sim.now()) / 1000) + 0.1 + R() * 0.3);
        H.id = n.track.id;
        H.tl = { t: real.t, p: real.p, playing: true };
        H.next = R() < 0.6 ? plan() : null;
        settleFrom = real.t + n.fade * 1000 + 300;
        send({ xfade: n.fade });
        await sim.run(n.fade);
      } else if (move === "skipNext" || move === "skipAny" || move === "skipLoading") {
        const to = move === "skipNext" && H.next ? H.next.track.id : pick(ids.filter((x) => x !== H.id));
        if (move === "skipLoading") {
          sim.publish({ track: { id: to }, playing: false, buf: true, anchor: { t: now, p: 0 } });
          await sim.run(0.3 + R());
        }
        H.id = to;
        H.tl = { t: sim.now(), p: 0, playing: true };
        H.next = R() < 0.7 ? plan() : null;
      } else if (move === "seekBack" || move === "seekFwd") {
        const d = (move === "seekBack" ? -1 : 1) * (2 + R() * 40);
        H.tl = { t: now, p: Math.max(0, Math.min(SKIP_TRACKS[H.id] - 35, pos() + d)), playing: true };
      } else if (move === "pause") {
        H.tl = { t: now, p: pos(), playing: false };
      } else if (move === "seekPaused") {
        H.tl = { t: now, p: Math.max(0, H.tl.p + (R() < 0.5 ? -1 : 1) * (0.5 + R() * 20)), playing: false };
      } else if (move === "resume") {
        H.tl = { t: now, p: H.tl.p, playing: true };
      } else if (move === "plan") {
        H.next = plan();
      }
      if (move !== "handover") send();
      const movedAt = sim.now();
      await sim.run(3.5);
      const from = Math.max(movedAt + 2000, settleFrom);
      const to = sim.now() - 50;
      const where = `seed ${seed}, step ${step} (${log.slice(-4).join(" > ")})`;
      for (const id of ids) {
        if (id === H.id && H.tl.playing) continue;
        assertSilent(sim, id, from, to, where);
      }
      if (H.tl.playing) {
        try {
          // To within what the correction policy lets stand until the next
          // seam (a handover the host made a few ms off its own prediction);
          // exactness itself is pinned by the tests above.
          assertFollows(sim, H.id, H.tl, from, to, { tolMs: SEAM_MS });
        } catch (e) {
          throw new Error(`${where}: ${e.message}`);
        }
      }
      assert.ok(sim.engine.voices.size <= 3, `${where}: ${sim.engine.voices.size} voices alive`);
    }
  }
});

// -- the host's side of a track change -------------------------------------------------
//
// The same moves, from the other end: what host.js PUBLISHES while the player
// goes through them, decided by the real rules (lib/party/hostrules.js) from a
// model of what Player.svelte's element and store actually do, and fed to the
// guest above.

test("host rules: what goes out while the player is between two states", () => {
  const pub = { id: "a", t: 1000, p: 100, playing: true, next: { track: { id: "b" }, at: 200, start: 0.3 } };
  const handoverT = 1000 + 100_000; // where a reaches 200 s
  const at = (o) => hostPhase({ pub, id: "a", running: false, wants: true, waited: 0, t: 5000, ...o });
  assert.deepEqual(at({ running: true }), { playing: true, buf: false });
  assert.deepEqual(at({ wants: false }), { playing: false, buf: false });
  // A hiccup in the track guests play: held, then announced.
  assert.equal(at({ waited: STALL_MS - 1 }), HOLD);
  assert.deepEqual(at({ waited: STALL_MS }), { playing: false, buf: true });
  // The announced next track, reached at its planned point: held for a slow start...
  assert.equal(at({ id: "b", t: handoverT }), HOLD);
  assert.equal(at({ id: "b", t: handoverT - 1000 }), HOLD);
  assert.deepEqual(at({ id: "b", t: handoverT, waited: HANDOVER_HOLD_MS }), { playing: false, buf: true });
  // ...but the same track reached by a skip a minute early is a skip.
  assert.deepEqual(at({ id: "b", t: handoverT - 60_000 }), { playing: false, buf: true });
  // Any other track: loading, at once.
  assert.deepEqual(at({ id: "c", t: handoverT }), { playing: false, buf: true });

  // The element: a source not attached yet never runs, whatever it is doing.
  const el = { paused: false, ended: false, readyState: 4, intent: true };
  assert.deepEqual(elementState({ ...el, onTrack: false }), { running: false, wants: true });
  assert.deepEqual(elementState({ ...el, onTrack: true }), { running: true, wants: true });
  assert.deepEqual(elementState({ ...el, onTrack: true, ended: true }), { running: false, wants: true });
  assert.deepEqual(elementState({ ...el, onTrack: true, ended: true, intent: false }), { running: false, wants: false });
  // And its position is never published under another track's name.
  const st = hostState({ pub, id: "c", onTrack: false, running: false, wants: true, waited: 0, t: 5000, heard: 123.4, fitPos: 123.4 });
  assert.equal(st.p, 0);
  const hv = hostState({ pub, id: "b", onTrack: false, running: false, wants: true, waited: HANDOVER_HOLD_MS, t: handoverT, heard: 199.9, fitPos: 0 });
  assert.equal(hv.p, 0.3, "the start guests were told about");
});

// host.js's loop over a model of the player: `player(S)` says what the store
// and the active element hold at server time S. Measured every 250 ms at an
// arbitrary phase, and at once on the player's pokes, as host.js is.
function driveHost(sim, player, { pokes = [], phase = 0.137 } = {}) {
  const H = { pub: null, stallSince: 0, fitId: null, sent: [] };
  const measure = () => {
    const S = sim.now();
    const e = player(S);
    if (e.id !== H.fitId) {
      H.fitId = e.id;
      H.stallSince = 0;
    }
    const onTrack = e.loaded === e.id;
    const { running, wants } = elementState({ onTrack, ...e });
    if (wants && !running) {
      if (!H.stallSince) H.stallSince = S;
    } else H.stallSince = 0;
    const waited = H.stallSince ? S - H.stallSince : 0;
    const st = hostState({ pub: H.pub, id: e.id, onTrack, running, wants, waited, t: S, heard: e.pos, fitPos: e.pos });
    if (st === HOLD) return;
    const pub = H.pub;
    const next = st.playing ? e.next || null : null;
    let need =
      !pub || pub.id !== e.id || pub.playing !== st.playing || pub.buf !== st.buf || JSON.stringify(pub.next) !== JSON.stringify(next);
    if (!need && st.playing) need = Math.abs(positionAt({ ...pub, playing: true }, S) - st.p) > 0.0025;
    else if (!need) need = Math.abs(pub.p - st.p) > 0.05;
    if (!need) return;
    H.pub = { id: e.id, t: S, p: st.p, playing: st.playing, buf: st.buf, next };
    H.sent.push({ ...H.pub, loaded: e.loaded });
    sim.publish({ track: { id: e.id }, playing: st.playing, buf: st.buf, anchor: { t: S, p: st.p }, next });
  };
  let nextMeasure = sim.now() + phase * 250;
  const queue = [...pokes].sort((a, b) => a - b);
  sim.hook = () => {
    const S = sim.now();
    while (queue.length && queue[0] <= S) {
      queue.shift();
      measure();
    }
    if (S >= nextMeasure) {
      measure();
      nextMeasure += 250;
    }
  };
  return H;
}

test("host → guest: a skip as the player really makes it — the old track stops, the new one is never published at the old position", async () => {
  for (const phase of [0.05, 0.37, 0.71, 0.93]) {
    const sim = makeSim({ tracks: SKIP_TRACKS });
    const t0 = sim.now() - 100_000;
    const nextB = { track: { id: "b" }, at: 234, start: 0, fade: 0, gap: 0.15 };
    const nextC = { track: { id: "c" }, at: 175, start: 0, fade: 0, gap: 0.15 };
    const skip = sim.now() + 4300;
    const attach = skip + 90; // the cached source resolved (and a softened skip faded)
    const startB = attach + 350; // then it buffered
    const player = (S) => {
      if (S < skip) return { id: "a", loaded: "a", paused: false, ended: false, readyState: 4, intent: true, pos: (S - t0) / 1000, next: nextB };
      // The store names b; the element still plays a, at a's position.
      if (S < attach) return { id: "b", loaded: null, paused: false, ended: false, readyState: 4, intent: true, pos: (S - t0) / 1000 };
      if (S < startB) return { id: "b", loaded: "b", paused: false, ended: false, readyState: 1, intent: true, pos: 0 };
      return { id: "b", loaded: "b", paused: false, ended: false, readyState: 4, intent: true, pos: (S - startB) / 1000, next: nextC };
    };
    // loadTrack pokes; so does the element's `play` once the new source is on.
    const H = driveHost(sim, player, { pokes: [skip + 1, attach + 1], phase });
    await sim.run(18);
    for (const x of H.sent.filter((x) => x.id === "b")) {
      assert.ok(x.p < 1, `phase ${phase}: b published at ${x.p.toFixed(1)} s — a's position`);
      if (x.playing) assert.ok(x.t >= startB, `phase ${phase}: b published playing before it played`);
    }
    // The host said "loading" at the skip (the poke), not at its next look —
    // within one step of the simulation (10 ms).
    const loading = H.sent.find((x) => x.id === "b");
    assert.ok(loading.buf && loading.t - skip <= DT * 1000 + 1, `phase ${phase}: first word of b was ${JSON.stringify(loading)}`);
    assertSilent(sim, "a", skip + 1200, sim.now(), `phase ${phase}`);
    assertFollows(sim, "b", { t: startB, p: 0, playing: true }, startB + 1400, sim.now() - 50);
  }
});

test("host → guest: the planned handover is HELD through the host's load, and confirmed by its real line", async () => {
  // A cut at a's trimmed end; b takes 250 ms to start where 150 were predicted.
  for (const lateMs of [250, 60]) {
    const sim = makeSim({ tracks: SKIP_TRACKS });
    const t0 = sim.now() - 226_000;
    const nextB = { track: { id: "b" }, at: 234, start: 0.3, fade: 0, gap: 0.15 };
    const cut = t0 + 234_000;
    const startB = cut + lateMs;
    const player = (S) => {
      if (S < cut) return { id: "a", loaded: "a", paused: false, ended: false, readyState: 4, intent: true, pos: (S - t0) / 1000, next: nextB };
      if (S < cut + 30) return { id: "b", loaded: null, paused: false, ended: false, readyState: 4, intent: true, pos: (S - t0) / 1000 };
      if (S < startB) return { id: "b", loaded: "b", paused: false, ended: false, readyState: 1, intent: true, pos: 0 };
      return { id: "b", loaded: "b", paused: false, ended: false, readyState: 4, intent: true, pos: 0.3 + (S - startB) / 1000 };
    };
    const H = driveHost(sim, player, { pokes: [cut + 1, cut + 31] });
    await sim.run(18);
    // Nothing but lines went out: no "loading" to stop what guests started on time.
    assert.ok(H.sent.every((x) => x.playing), `published ${JSON.stringify(H.sent.filter((x) => !x.playing))}`);
    const predicted = serverTimeAt({ t: t0, p: 0 }, 234) + 150;
    // b is heard from its predicted start, never goes back, and ends on its real line.
    let last = -1;
    let silent = 0;
    for (const r of sim.window(predicted + 20, sim.now() - 50)) {
      const h = heard(r, "b");
      if (h.g < 0.5) {
        silent++;
        continue;
      }
      assert.ok(h.pos >= last - 0.013, `b went back from ${last} to ${h.pos}`);
      last = h.pos;
    }
    // Silent for about as long as the host was late on its prediction, no more.
    assert.ok(silent * 2.5 <= Math.max(0, lateMs - 150) + 40, `${silent * 2.5} ms of silence`);
    assertFollows(sim, "b", { t: startB, p: 0.3, playing: true }, startB + 1400, sim.now() - 50, { tolMs: SEAM_MS });
    assertSilent(sim, "a", cut + 20, sim.now(), "after the cut");
  }
});

test("host → guest: a handover the host takes too long to start is announced, and the guest waits for it", async () => {
  const sim = makeSim({ tracks: SKIP_TRACKS });
  const t0 = sim.now() - 226_000;
  const nextB = { track: { id: "b" }, at: 234, start: 0, fade: 0, gap: 0.15 };
  const cut = t0 + 234_000;
  const startB = cut + 5000; // a cold track: five seconds to buffer
  const player = (S) => {
    if (S < cut) return { id: "a", loaded: "a", paused: false, ended: false, readyState: 4, intent: true, pos: (S - t0) / 1000, next: nextB };
    if (S < startB) return { id: "b", loaded: "b", paused: false, ended: false, readyState: 1, intent: true, pos: 0 };
    return { id: "b", loaded: "b", paused: false, ended: false, readyState: 4, intent: true, pos: (S - startB) / 1000 };
  };
  const H = driveHost(sim, player, { pokes: [cut + 1] });
  await sim.run(22);
  const buf = H.sent.find((x) => x.buf);
  assert.ok(buf && buf.t - cut >= HANDOVER_HOLD_MS && buf.t - cut < HANDOVER_HOLD_MS + 300, "loading announced once the hold ran out");
  // Whatever the guest started on its prediction stops within a poll of that...
  assertSilent(sim, "b", buf.t + 1200, startB, "while the host loads");
  // ...and b lands on the host's real line once it plays.
  assertFollows(sim, "b", { t: startB, p: 0, playing: true }, startB + 1400, sim.now() - 50);
});
