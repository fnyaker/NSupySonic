// The sleep timer (lib/sleep.js) and the podcast speed (lib/speed.js).
//
// The timer runs on a mocked clock: what matters is what the listener hears at
// each moment — full volume, then a fade, then a pause with the queue where it
// was — and that a clock that jumps (a phone that slept) still ends it.
import test, { mock } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.window = { addEventListener() {}, location: { href: "http://x/app/", hash: "" } };
globalThis.document = { addEventListener() {}, visibilityState: "visible" };
globalThis.location = globalThis.window.location;

const { get } = await import("svelte/store");
const S = await import("../src/lib/stores.js");
const Z = await import("../src/lib/sleep.js");
const V = await import("../src/lib/speed.js");

const track = (id, extra = {}) => ({ deezer_id: String(id), title: `T${id}`, duration: 200, ...extra });
function playing(n = 4, index = 1) {
  S.player.set({
    ...get(S.player),
    queue: Array.from({ length: n }, (_, i) => track(i + 1)),
    index,
    playing: true,
    currentTime: 30,
    seq: 5,
    repeat: "off",
    shuffle: false,
    _orig: null,
  });
}
const clock = () => mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 1_000_000 });

test("the fade is 1 before the last 15 s, 0 at the end, and falls smoothly between", () => {
  assert.equal(Z.fadeAt(60_000), 1);
  assert.equal(Z.fadeAt(15_000), 1);
  assert.equal(Z.fadeAt(0), 0);
  assert.equal(Z.fadeAt(-5), 0);
  assert.equal(Z.fadeAt(7_500), 0.25, "amplitude squared: what the ear hears as an even ramp");
  let prev = 1;
  for (let ms = 15_000; ms >= 0; ms -= 250) {
    const g = Z.fadeAt(ms);
    assert.ok(g <= prev + 1e-12, `monotonic at ${ms}`);
    prev = g;
  }
});

test("a timer holds the volume, fades over the last seconds, then pauses where it was", () => {
  clock();
  try {
    playing();
    Z.sleepIn(1);
    assert.equal(get(Z.sleepTimer).kind, "minutes");
    mock.timers.tick(44_000);
    assert.equal(get(Z.sleepFade), 1, "16 s to go: untouched");
    mock.timers.tick(6_000); // 10 s to go
    assert.ok(Math.abs(get(Z.sleepFade) - (10 / 15) ** 2) < 1e-9, `${get(Z.sleepFade)}`);
    assert.equal(get(S.player).playing, true);
    mock.timers.tick(10_000);
    assert.equal(get(S.player).playing, false, "paused, not stopped");
    assert.equal(get(S.current).deezer_id, "2", "the queue and the track are where they were");
    assert.equal(get(Z.sleepTimer), null);
    mock.timers.tick(500);
    assert.equal(get(Z.sleepFade), 1, "the level is back for the next play");
  } finally {
    Z.cancelSleep();
    mock.timers.reset();
  }
});

test("a clock that jumped while the page slept still ends the timer", () => {
  clock();
  try {
    playing();
    Z.sleepIn(30);
    // One tick of the interval, ten minutes of wall clock later: a throttled
    // page does not fire every 250 ms.
    mock.timers.setTime(1_000_000 + 40 * 60_000);
    mock.timers.tick(250);
    assert.equal(get(S.player).playing, false);
    assert.equal(get(Z.sleepTimer), null);
  } finally {
    Z.cancelSleep();
    mock.timers.reset();
  }
});

test("a new timer replaces the old one, and cancelling puts the level back at once", () => {
  clock();
  try {
    playing();
    Z.sleepIn(1);
    mock.timers.tick(55_000); // deep in the fade
    assert.ok(get(Z.sleepFade) < 1);
    Z.sleepIn(60);
    assert.equal(get(Z.sleepFade), 1);
    mock.timers.tick(120_000);
    assert.equal(get(S.player).playing, true, "the first timer did not fire");
    Z.sleepIn(1);
    mock.timers.tick(55_000);
    Z.cancelSleep();
    assert.equal(get(Z.sleepFade), 1);
    assert.equal(get(Z.sleepTimer), null);
    mock.timers.tick(600_000);
    assert.equal(get(S.player).playing, true, "and nothing is left running");
  } finally {
    Z.cancelSleep();
    mock.timers.reset();
  }
});

test("'end of the track' waits for the track, then lines up the next one paused", () => {
  playing();
  Z.sleepAtTrackEnd();
  assert.equal(Z.sleepStopsAtTrackEnd(), true, "the crossfade and the silence trim read this to leave the ending alone");
  assert.equal(get(S.player).playing, true, "nothing happens before the track ends");
  assert.equal(Z.finishSleepAtTrackEnd(), true);
  assert.equal(get(S.current).deezer_id, "3");
  assert.equal(get(S.player).playing, false);
  assert.equal(get(Z.sleepTimer), null);
  assert.equal(Z.finishSleepAtTrackEnd(), false, "spent: the next track end is an ordinary one");
});

test("a minutes timer is not an end-of-track timer", () => {
  clock();
  try {
    playing();
    Z.sleepIn(10);
    assert.equal(Z.sleepStopsAtTrackEnd(), false);
    assert.equal(Z.finishSleepAtTrackEnd(), false);
    assert.equal(get(S.player).playing, true);
  } finally {
    Z.cancelSleep();
    mock.timers.reset();
  }
});

test("what is left is said the way a person reads a clock", () => {
  const t = (s) => ({ kind: "minutes", minutes: 60, endsAt: 1000 + s * 1000 });
  assert.equal(Z.leftLabel(null), "");
  assert.equal(Z.leftLabel({ kind: "track" }), "fin du titre");
  assert.equal(Z.leftLabel(t(1800), 1000), "30 min");
  assert.equal(Z.leftLabel(t(61), 1000), "2 min", "rounded up: never claims less than is left");
  assert.equal(Z.leftLabel(t(45), 1000), "45 s");
  assert.equal(Z.leftLabel(t(0), 1000), "1 s");
  // A reading taken a moment BEFORE the timer was set must not round up past what was asked.
  assert.equal(Z.leftLabel({ kind: "minutes", minutes: 5, endsAt: 1000 + 300_000 }, 500), "5 min");
});

test("a podcast's speed is kept per show, and music is never touched", () => {
  const ep = track("e1", { podcast: true, channel_id: "c9" });
  const song = track("s1");
  assert.equal(V.speedFor(ep, {}), 1);
  assert.equal(V.speedFor(ep, { c9: 1.5 }), 1.5);
  assert.equal(V.speedFor(song, { c9: 1.5, s1: 2 }), 1);
  // A queue restored from before episodes carried channel_id names the show by its album.
  assert.equal(V.speedFor(track("e2", { podcast: true, album: { deezer_id: 77 } }), { 77: 2 }), 2);
  assert.equal(V.speedFor(track("e3", { podcast: true }), { undefined: 2 }), 1);
});

test("a stored rate the element cannot play is not believed", () => {
  for (const bad of ["fast", null, NaN, 0, -1, 0.1, 9, Infinity]) assert.equal(V.sane(bad), 1, String(bad));
  assert.equal(V.sane(0.75), 0.75);
  assert.equal(V.sane("1.5"), 1.5);
});

test("choosing a speed follows the current episode, and 1x forgets the show", () => {
  const ep = track("e1", { podcast: true, channel_id: "c9" });
  S.podcastSpeeds.set({});
  S.player.set({ ...get(S.player), queue: [ep], index: 0 });
  assert.equal(get(V.currentSpeed), 1);
  V.setSpeed(ep, 1.75);
  assert.deepEqual(get(S.podcastSpeeds), { c9: 1.75 });
  assert.equal(get(V.currentSpeed), 1.75);
  V.setSpeed(track("s1"), 2);
  assert.deepEqual(get(S.podcastSpeeds), { c9: 1.75 }, "a song has no speed to set");
  V.setSpeed(ep, 1);
  assert.deepEqual(get(S.podcastSpeeds), {});
  assert.equal(get(V.currentSpeed), 1);
});

test("the speeds are offered as 1,25× and the like", () => {
  assert.equal(V.speedLabel(1), "1×");
  assert.equal(V.speedLabel(1.25), "1,25×");
  assert.equal(V.speedLabel(2.5), "2,5×");
  assert.ok(V.SPEEDS.includes(1) && V.SPEEDS.every((r) => r === V.sane(r)));
});
