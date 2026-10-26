// Downloads give the link back to what is playing (lib/netyield.js). What is
// pinned here is the decision — when the player holds the link and when it lets
// it go — on elements that behave like the browser's: the playhead moving, the
// buffer filling in ranges, a source that is a blob, a live transcode with no
// duration. The bandwidth itself is measured in the browser bench
// (test/download/run.mjs).

import test from "node:test";
import assert from "node:assert/strict";

const calls = [];
globalThis.window = { NSNative: { offYield: (ms) => calls.push(ms) } };

const ny = await import("../src/lib/netyield.js");

class FakeEl extends EventTarget {
  constructor(src = "https://srv/api/stream/1") {
    super();
    this.src = src;
    this.currentSrc = src;
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = 240;
    this.ranges = [];
  }
  get buffered() {
    const r = this.ranges;
    return { length: r.length, start: (i) => r[i][0], end: (i) => r[i][1] };
  }
  fire(t) {
    this.dispatchEvent(new Event(t));
  }
}

function fresh() {
  ny.resetNetYield();
  calls.length = 0;
}

test("a track launched from the network holds the link until it has 30 s in hand", () => {
  fresh();
  const el = new FakeEl();
  ny.watchElement(el);
  assert.equal(ny.isYielding(), false, "a paused element needs nothing");
  el.paused = false;
  el.fire("play");
  assert.equal(ny.isYielding(), true, "pressed play, nothing buffered: downloads yield");
  assert.equal(calls.at(-1), 45000, "the app is given a lease, not a switch");
  el.ranges = [[0, 20]];
  el.fire("progress");
  assert.equal(ny.isYielding(), true, "20 s is under the 30 s it lets go at");
  el.ranges = [[0, 31]];
  el.fire("progress");
  assert.equal(ny.isYielding(), false, "31 s in hand: the downloads may go");
  assert.equal(calls.at(-1), 0);
  // Played on: 18 s left ahead is still above the 15 s it asks again at.
  el.currentTime = 13;
  el.fire("timeupdate");
  assert.equal(ny.isYielding(), false);
  el.currentTime = 17;
  el.fire("timeupdate");
  assert.equal(ny.isYielding(), true, "14 s ahead: it asks for the link again");
});

test("a file entirely in hand, a pause or a local source need nothing", () => {
  fresh();
  const el = new FakeEl();
  ny.watchElement(el);
  el.paused = false;
  el.ranges = [[0, 239.8]];
  el.fire("progress");
  assert.equal(ny.isYielding(), false, "the whole file is buffered");
  el.ranges = [[0, 5]];
  el.fire("progress");
  assert.equal(ny.isYielding(), true);
  el.paused = true;
  el.fire("pause");
  assert.equal(ny.isYielding(), false, "paused by the person: the downloads go on");
  for (const src of ["blob:https://srv/abc", "https://srv/__nsoffline/42"]) {
    const local = new FakeEl(src);
    ny.watchElement(local);
    local.paused = false;
    local.fire("play");
    assert.equal(ny.isYielding(), false, `${src} costs no network`);
  }
});

test("a live transcode with no duration holds on what is ahead", () => {
  fresh();
  const el = new FakeEl();
  el.duration = Infinity;
  ny.watchElement(el);
  el.paused = false;
  el.ranges = [[0, 40]];
  el.fire("progress");
  assert.equal(ny.isYielding(), false);
  el.currentTime = 30;
  el.fire("timeupdate");
  assert.equal(ny.isYielding(), true);
});

test("an element let go of is forgotten, and holds nothing", () => {
  fresh();
  const el = new FakeEl();
  ny.watchElement(el);
  el.paused = false;
  el.fire("play");
  assert.equal(ny.isYielding(), true);
  el.paused = true;
  el.src = el.currentSrc = "";
  el.fire("emptied");
  assert.equal(ny.isYielding(), false);
  // ...and is followed again once it is used again.
  el.src = el.currentSrc = "https://srv/api/stream/2";
  el.paused = false;
  el.fire("play");
  assert.equal(ny.isYielding(), true);
});

test("the next track's preload holds the link while it runs", async () => {
  fresh();
  let during = null;
  await ny.holding(async () => {
    during = ny.isYielding();
  });
  assert.equal(during, true);
  assert.equal(ny.isYielding(), false);
  // A preload that fails still lets go.
  await assert.rejects(ny.holding(async () => { throw new Error("x"); }));
  assert.equal(ny.isYielding(), false);
});

test("a waiting download starts the moment the link is free", async () => {
  fresh();
  const release = ny.hold();
  let started = false;
  const p = ny.whenClear().then(() => (started = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started, false);
  release();
  await p;
  assert.equal(started, true);
});

test("a trickled read averages 4 KB a second, and wakes when the link is free", async () => {
  fresh();
  assert.equal(ny.tricklePause(4096), 1000);
  assert.equal(ny.tricklePause(65536), 16000);
  assert.equal(ny.tricklePause(1 << 20), 20000, "never past what a proxy tolerates");
  const release = ny.hold();
  const t0 = Date.now();
  setTimeout(release, 60);
  await ny.trickle(1 << 20);
  assert.ok(Date.now() - t0 < 1000, "woken by the release, not the 20 s timer");
  const t1 = Date.now();
  await ny.trickle(1 << 20);
  assert.ok(Date.now() - t1 < 20, "nothing holds: no pause at all");
});
