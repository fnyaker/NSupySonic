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
  chunkIndex,
  correctionFor,
  lastChunk,
  nextTimeline,
  positionAt,
  serverTimeAt,
} from "../src/lib/party/timeline.js";
import { PartyEngine, makeClockBridge, normGain } from "../src/lib/party/engine.js";
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
