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
      // The waveform pair IS reused between messages by design (the real
      // channel structured-clones it on the way out), so a test that keeps the
      // reference would read the last frame's samples in every message. Copy
      // them here, which is what the browser does for free.
      sent.push({
        ...m,
        b: m.b ? [...m.b] : null,
        f: m.f ? [...m.f] : null,
        w: m.w ? Int16Array.from(m.w) : null,
        w2: m.w2 ? Int16Array.from(m.w2) : null,
      });
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

function frameOf({ beat = false, downbeat = false, kickHit = false, onset = 0, wave = null } = {}) {
  return {
    wave,
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

function withViewer(ch, lv = 2, wv) {
  ch.onmessage({ data: { t: "hello", id: "v1", lv, ...(wv === undefined ? {} : { wv }) } });
}

// A stereo window the way the engine hands one over: two channels that are
// genuinely different, since "one trace per channel" is the claim.
function waveOf(n = 512) {
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = Math.sin((i / n) * Math.PI * 8) * 0.5;
    right[i] = Math.sin((i / n) * Math.PI * 8 + 1.2) * 0.9;
  }
  return { left, right, size: n, sampleRate: 44100 };
}

// Move the publisher's clock past its throttle window.
function tick(ms = 25) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* spin: the throttle reads a real clock */
  }
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

test("the raw waveform crosses only when a viewer asks for it", () => {
  // The oscilloscope is the one scene that needs the SAMPLES, and no summary of
  // them will do — a waveform reduced before it crosses cannot be triggered on
  // the other side, and an untriggered trace slides until it is unreadable. So
  // the window crosses whole, as Int16, and ONLY for a viewer that asked: every
  // other projector keeps costing the ~800 bytes a frame it always did.
  const wave = waveOf(512);

  // A viewer showing anything else asks for nothing and is sent nothing.
  const quiet = fakeChannel();
  const qpub = publisher({ channel: quiet });
  withViewer(quiet, 2);
  qpub.send(frameOf({ wave }));
  const qf = quiet.sent.filter((m) => m.t === "f");
  assert.ok(qf.length > 0, "nothing was published at all");
  assert.ok(qf.every((m) => !m.w), "samples were sent to a viewer that never asked");

  // A viewer on the scope asks, and gets them.
  const ch = fakeChannel();
  const pub = publisher({ channel: ch });
  withViewer(ch, 0, 512);
  pub.send(frameOf({ wave }));
  const f = ch.sent.filter((m) => m.t === "f").at(-1);
  assert.ok(f.w && f.w2, "the viewer asked for samples and got none");
  assert.equal(f.w.length, 512);
  assert.equal(f.wsr, 44100, "the sample rate has to travel with the window");

  // Int16 over ±1.0 is ~3e-5 per step; the round trip must be lossless to the
  // eye and the two channels must stay distinct.
  let worst = 0;
  let apart = 0;
  for (let i = 0; i < 512; i++) {
    worst = Math.max(worst, Math.abs(f.w[i] / 32767 - wave.left[i]));
    apart = Math.max(apart, Math.abs(f.w[i] - f.w2[i]) / 32767);
  }
  assert.ok(worst < 1e-3, `the round trip lost ${worst.toExponential(1)} of amplitude`);
  assert.ok(apart > 0.3, "the two channels arrived identical");
});

test("a waveform request is clamped, and a signal past full scale does not wrap", () => {
  const ch = fakeChannel();
  const pub = publisher({ channel: ch });
  // Far more than the wire will carry: the cap is what keeps a projector from
  // asking for a megabyte a second.
  withViewer(ch, 0, 1 << 20);
  const n = 64;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  // Audio does step past ±1 between the limiter and here. A wrapped sample is
  // a full-scale spike in the opposite direction that nobody played.
  for (let i = 0; i < n; i++) {
    left[i] = i % 2 ? 1.8 : -1.8;
    right[i] = 0;
  }
  pub.send(frameOf({ wave: { left, right, size: n, sampleRate: 48000 } }));
  const f = ch.sent.filter((m) => m.t === "f").at(-1);
  assert.equal(f.w.length, n, "a short window must not be padded up to the request");
  for (let i = 0; i < n; i++)
    assert.equal(
      f.w[i],
      i % 2 ? 32767 : -32767,
      `sample ${i} wrapped instead of clamping (${f.w[i]})`
    );
});

test("a publisher with no tap running simply sends no samples", () => {
  // This tab's own scenes may want no waveform at all, in which case the engine
  // never builds the stereo tap and `frame.wave` is null. The projector's scope
  // then draws its face and a flat line — which is the truth, not a broken
  // picture — rather than the publisher inventing a window.
  const ch = fakeChannel();
  const pub = publisher({ channel: ch });
  withViewer(ch, 0, 2048);
  pub.send(frameOf({ wave: null }));
  const f = ch.sent.filter((m) => m.t === "f").at(-1);
  assert.equal(f.w, null);
  assert.equal(f.wsr, 0);
});

test("the waveform window a viewer needs reaches the host, like its level", () => {
  // The projector announces what its OWN scene needs; this tab runs the engine
  // at the most demanding of the two. A window is the same kind of demand as a
  // level, so it travels the same way — and a change of it has to re-announce,
  // or a projector switched to the scope would wait out a ping interval showing
  // a flat line.
  const ch = fakeChannel();
  const seen = [];
  const pub = publisher({ channel: ch, onViewers: (n, lv, wv) => seen.push([n, lv, wv]) });
  ch.onmessage({ data: { t: "hello", id: "v1", lv: 0, wv: 0 } });
  ch.onmessage({ data: { t: "ping", id: "v1", lv: 0, wv: 4096 } });
  assert.deepEqual(seen.at(-1), [1, 0, 4096], `host was told ${JSON.stringify(seen)}`);
  // The most demanding of several viewers decides, exactly as for the level.
  ch.onmessage({ data: { t: "hello", id: "v2", lv: 2, wv: 8192 } });
  assert.deepEqual(seen.at(-1), [2, 2, 8192]);
  // An older viewer, with no idea what a waveform is, must not be read as
  // wanting one — that would put 32 kB a frame on the wire for nobody.
  ch.onmessage({ data: { t: "bye", id: "v1" } });
  ch.onmessage({ data: { t: "bye", id: "v2" } });
  ch.onmessage({ data: { t: "hello", id: "v3", lv: 2 } });
  assert.equal(seen.at(-1)[2], 0, "a viewer that said nothing was sent samples anyway");
  void pub;
});
