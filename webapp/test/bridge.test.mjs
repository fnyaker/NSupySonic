// The line between analysis and rendering (lib/viz/bridge.js).
//
// The sound is analysed ONCE, in the tab that has the audio, and what crosses
// this channel is that analysis. Both screens therefore agree about the genre,
// the tempo and the grid by construction — there is only one of each. What each
// side does with it afterwards is its own business.
//
// What this file pins is the part that was silently wrong: the engine runs at
// ~94 Hz and the channel at 45, so a beat — true on exactly ONE analysis frame —
// had a better than even chance of falling in a frame the throttle dropped. The
// projector was missing about half of every track's beats, kicks and downbeats,
// which is what "they are not in sync" actually was. Not a clock problem, a
// sampling one: continuous values can be sampled, events have to be latched.

import test from "node:test";
import assert from "node:assert/strict";
import { createPublisher } from "../src/lib/viz/bridge.js";

function fakeChannel() {
  const sent = [];
  return {
    sent,
    postMessage(m) {
      // Structured clone would copy the typed arrays; the parts this test reads
      // are plain numbers, so keeping the reference is enough and cheaper.
      sent.push({ ...m, b: m.b ? [...m.b] : null, f: m.f ? [...m.f] : null });
    },
    close() {},
    set onmessage(fn) {
      this._on = fn;
    },
    get onmessage() {
      return this._on;
    },
  };
}

function frameOf({ beat = false, downbeat = false, kickHit = false, onset = 0 } = {}) {
  return {
    bands: new Float32Array(120),
    energy: { sub: 0.1, bass: 0.1, lowMid: 0.1, mid: 0.1, high: 0.1, air: 0.1 },
    features: {
      level: 0.5, flux: 0, lowFlux: 0, midFlux: 0, highFlux: 0, centroidN: 0.4,
      flatness: 0.3, percussivity: 0.5, vocalMod: 0, crest: 3, silent: false,
      kick: kickHit ? 0.9 : 0.1, dynamics: 1, tonal: 0.3, melody: 0.3,
      melodyPitch: 0.5, melodyFlux: 0, chordChange: 0, kickHit, chroma: null,
    },
    beat: {
      bpm: 180, confidence: 0.9, phase: 0.2, beat, beatIndex: 1, barPos: 1,
      beatsPerBar: 4, downbeat, onset, kickPulse: 0.5, period: 60 / 180, locked: true,
    },
    style: {
      dominant: "frenchcore", dominantLabel: "Frenchcore", confidence: 0.9,
      archetypes: { hard: 0.9 }, look: null,
      kick: { type: "hard", strength: 0.9, decay: 0.12, hit: kickHit },
    },
  };
}

function withViewer(ch, lv = 2) {
  ch.onmessage({ data: { t: "hello", id: "v1", lv } });
}

// A publisher with a viewer starts a heartbeat interval, which keeps the Node
// event loop alive for ever if it is never closed — the first version of this
// file simply hung. Every test closes what it opens.
const open = [];
function publisher(opts) {
  const pub = createPublisher(opts);
  open.push(pub);
  return pub;
}
test.after(() => {
  for (const p of open) p.close();
});

test("no event is lost to the publish throttle", () => {
  // Drive it the way the engine does: many frames between publishes, with the
  // events on single frames. Every one of them has to come out the other side.
  const ch = fakeChannel();
  const pub = publisher({ channel: ch });
  withViewer(ch);
  const BEATS = 12;
  for (let i = 0; i < BEATS; i++) {
    // One "beat" frame, then a run of ordinary ones — the throttle will drop
    // most of the batch, and which one it keeps is a matter of timing.
    pub.send(frameOf({ beat: true, downbeat: i % 4 === 0, kickHit: true, onset: 0.8 }));
    for (let k = 0; k < 6; k++) pub.send(frameOf());
    // Move the clock past the throttle window so the batch is flushed.
    const until = performance.now() + 25;
    while (performance.now() < until) { /* spin: the throttle reads a real clock */ }
    pub.send(frameOf());
  }
  const frames = ch.sent.filter((m) => m.t === "f");
  assert.ok(frames.length > 0, "nothing was published at all");
  const beats = frames.filter((m) => m.b[3] === 1).length;
  const downs = frames.filter((m) => m.b[7] === 1).length;
  const kicks = frames.filter((m) => m.f[18] === 1).length;
  assert.equal(beats, BEATS, `${beats} of ${BEATS} beats survived the throttle`);
  assert.equal(downs, 3, `${downs} of 3 downbeats survived`);
  assert.equal(kicks, BEATS, `${kicks} of ${BEATS} kicks survived`);
  // The peak onset is carried too, not whichever frame happened to get through.
  assert.ok(frames.some((m) => m.b[8] >= 0.8), "the onset peak was sampled away");
});

test("a latched event is cleared once it has been sent", () => {
  // The other half: a beat must not be reported twice because the flag was
  // never reset. A picture that fires on every publish is as wrong as one that
  // fires on half of them.
  const ch = fakeChannel();
  const pub = publisher({ channel: ch });
  withViewer(ch);
  pub.send(frameOf({ beat: true, kickHit: true }));
  const until = performance.now() + 25;
  while (performance.now() < until) { /* spin */ }
  pub.send(frameOf());
  const until2 = performance.now() + 25;
  while (performance.now() < until2) { /* spin */ }
  pub.send(frameOf());
  const frames = ch.sent.filter((m) => m.t === "f");
  assert.equal(frames.filter((m) => m.b[3] === 1).length, 1, "the beat was repeated");
  assert.equal(frames.filter((m) => m.f[18] === 1).length, 1, "the kick was repeated");
});

test("the analysis runs at the most demanding viewer's level", () => {
  // The rule the projector work is built on: one analysis, at the level of
  // whichever consumer needs most. The publisher only reports what its viewers
  // ask for — the engine maxes that with this tab's own subscription itself.
  const levels = [];
  const ch = fakeChannel();
  publisher({ channel: ch, onViewers: (n, lv) => levels.push([n, lv]) });
  ch.onmessage({ data: { t: "hello", id: "a", lv: 0 } });
  ch.onmessage({ data: { t: "hello", id: "b", lv: 2 } });
  ch.onmessage({ data: { t: "bye", id: "b" } });
  assert.deepEqual(levels, [[1, 0], [2, 2], [1, 0]], JSON.stringify(levels));
});

test("a viewer that does not say what it needs is assumed to need everything", () => {
  // An older projector sends no `lv`. Under-analysing degrades its picture
  // silently; over-analysing only costs the playing tab a little work.
  const levels = [];
  const ch = fakeChannel();
  publisher({ channel: ch, onViewers: (n, lv) => levels.push(lv) });
  ch.onmessage({ data: { t: "hello", id: "old" } });
  assert.deepEqual(levels, [2]);
});
