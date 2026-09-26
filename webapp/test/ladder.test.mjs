// The load ladder decides what the app is allowed to want, and in what order.
// Getting it wrong is silent: a rung that never runs is a cover that never
// appears, and a rung that runs too early is the audio waiting behind it again.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { get } from "svelte/store";

const { TIER, audioReady, beginTrack, playable, whenReady } = await import(
  "../src/lib/ladder.js"
);

const tick = () => new Promise((r) => setTimeout(r, 0));

// A track left un-ready (the skip test's t4) keeps a real 6 s fallback timer
// armed, and node waits for it before the file can end: six idle seconds per
// run. Clearing the current track disarms it. (The mocked-clock tests disarm
// on the real clock first, for the same reason: a mocked clearTimeout cannot
// clear a real timer.)
after(() => beginTrack(null));

test("nothing runs until the audio can play, and then in tier order", async () => {
  const ran = [];
  beginTrack("t1");
  whenReady(TIER.EXTRA, () => ran.push("extra"));
  whenReady(TIER.VERDICT, () => ran.push("verdict"));
  whenReady(TIER.ART, () => ran.push("art"));
  await tick();
  assert.deepEqual(ran, [], "the audio has not started: nothing else may ask for the link");
  assert.equal(get(playable), null);

  audioReady("t1");
  await tick();
  assert.deepEqual(ran, ["art", "verdict", "extra"]);
  assert.equal(get(playable), "t1");
});

test("a rung waits for the one before it to finish, not just to start", async () => {
  const ran = [];
  let release;
  const slow = new Promise((r) => (release = r));
  beginTrack("t2");
  whenReady(TIER.ART, async () => {
    ran.push("art:start");
    await slow;
    ran.push("art:done");
  });
  whenReady(TIER.VERDICT, () => ran.push("verdict"));
  audioReady("t2");
  await tick();
  assert.deepEqual(ran, ["art:start"], "four in parallel finish no sooner, and the first much later");
  release();
  await tick();
  await tick();
  assert.deepEqual(ran, ["art:start", "art:done", "verdict"]);
});

test("a skip abandons the rest: it is about a track nobody is hearing", async () => {
  const ran = [];
  let release;
  const slow = new Promise((r) => (release = r));
  beginTrack("t3");
  whenReady(TIER.ART, async () => {
    ran.push("art");
    await slow;
  });
  whenReady(TIER.EXTRA, () => ran.push("extra"));
  audioReady("t3");
  await tick();
  beginTrack("t4"); // the user skipped mid-rung
  release();
  await tick();
  await tick();
  assert.deepEqual(ran, ["art"]);
  assert.equal(get(playable), null);
});

test("a track that never reports ready still gets everything, late", async (t) => {
  // A session restored paused has preload="none", so its element genuinely will
  // not say anything until somebody presses play. No artwork and no lyrics for
  // ever is not an acceptable answer to that.
  //
  // On a mocked clock: this used to sleep a real 6.1 s, and could not tell a
  // fallback firing on time from one firing after 100 ms. Now both edges are
  // pinned — nothing at 5999 ms, everything at 6000.
  beginTrack(null); // disarm, on the REAL clock, whatever an earlier test left
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const ran = [];
  beginTrack("t5");
  whenReady(TIER.ART, () => ran.push("art"));
  t.mock.timers.tick(5999);
  await flush();
  assert.deepEqual(ran, [], "the fallback is for a track that never loads, not a slow one");
  assert.equal(get(playable), null);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(ran, ["art"]);
  assert.equal(get(playable), "t5");
});

test("a skip before the fallback cancels it", async (t) => {
  beginTrack(null);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ran = [];
  beginTrack("t5b");
  whenReady(TIER.ART, () => ran.push("stale"));
  t.mock.timers.tick(3000);
  beginTrack("t5c"); // skipped: the old fallback must not fire for t5c's queue
  whenReady(TIER.ART, () => ran.push("fresh"));
  t.mock.timers.tick(3000); // 6 s after t5b, 3 s after t5c
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(ran, []);
  assert.equal(get(playable), null);
  t.mock.timers.tick(3000); // t5c's own 6 s
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(ran, ["fresh"]);
  assert.equal(get(playable), "t5c");
});

test("a rung registered after the audio started simply runs", async () => {
  const ran = [];
  beginTrack("t6");
  audioReady("t6");
  whenReady(TIER.ART, () => ran.push("late"));
  await tick();
  assert.deepEqual(ran, ["late"]);
});

test("one rung throwing does not strand the next", async () => {
  const ran = [];
  beginTrack("t7");
  whenReady(TIER.ART, () => {
    ran.push("art");
    throw new Error("no artwork today");
  });
  whenReady(TIER.EXTRA, () => ran.push("extra"));
  audioReady("t7");
  await tick();
  await tick();
  assert.deepEqual(ran, ["art", "extra"]);
});
