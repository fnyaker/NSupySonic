// The active lyric line (src/lib/lyrics.js): it changes when the line is HEARD.
//
// It used to follow the player store, which is written on `timeupdate` — four
// times a second — so every line changed 0-250 ms late, and early by the whole
// output latency when the audio went through the graph. Here an element whose
// clock the test drives is registered as the player's, the store is only moved
// the way timeupdate would move it, and the question is when the line changes.

import test, { mock } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

mock.timers.enable({ apis: ["setTimeout"] });

const { trackLyrics, activeLyricIndex } = await import("../src/lib/lyrics.js");
const { registerSource } = await import("../src/lib/audio/graph.js");
const { outputTrim, player } = await import("../src/lib/stores.js");

let clock = 0; // ms of playback the element has done
const el = {
  paused: false,
  readyState: 4,
  playbackRate: 1,
  get currentTime() {
    return clock / 1000;
  },
};
registerSource(el); // nothing wants the graph: the element plays directly

const LINES = [
  { time: 0, text: "un" },
  { time: 10_000, text: "deux" },
  { time: 12_500, text: "trois" },
];

// Advance the element and the timers together, a millisecond at a time, and
// return the element time at which the line index first became `idx`.
function playUntil(idx, maxMs, seen) {
  for (let i = 0; i < maxMs; i++) {
    clock += 1;
    mock.timers.tick(1);
    if (seen.at(-1)?.[1] === idx) return seen.at(-1)[0];
  }
  return null;
}

test("a line changes when it is heard, not at the next timeupdate", () => {
  outputTrim.set(40); // this device sounds 40 ms late: the words wait for it
  clock = 9_800;
  player.update((s) => ({ ...s, currentTime: 9.8, playing: true }));
  const seen = [];
  const off = activeLyricIndex.subscribe((i) => seen.push([clock, i]));
  trackLyrics.set({ synced: LINES });
  assert.equal(seen.at(-1)[1], 0);
  // No timeupdate at all from here: only the element's clock moves.
  const at = playUntil(1, 400, seen);
  assert.ok(at != null, "the line never changed without a store update");
  assert.ok(at >= 10_040 && at <= 10_042, `changed with the element at ${at} ms, heard ${at - 40}`);
  const at2 = playUntil(2, 3000, seen);
  assert.ok(at2 >= 12_540 && at2 <= 12_542, `then at ${at2} ms`);
  off();
  outputTrim.set(0);
});

test("paused, the line is the store's position; a seek moves it at once", () => {
  trackLyrics.set(null);
  el.paused = true;
  clock = 0;
  player.update((s) => ({ ...s, currentTime: 11, playing: false }));
  const seen = [];
  const off = activeLyricIndex.subscribe((i) => seen.push(i));
  trackLyrics.set({ synced: LINES });
  assert.equal(seen.at(-1), 1);
  // Nothing flows, so nothing is scheduled: time passing changes nothing.
  mock.timers.tick(10_000);
  assert.equal(seen.at(-1), 1);
  player.update((s) => ({ ...s, currentTime: 1 }));
  assert.equal(seen.at(-1), 0);
  off();
  el.paused = false;
});
