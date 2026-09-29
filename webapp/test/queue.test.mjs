// The queue's editing verbs (stores.js): move, clearUpcoming, advancePaused.
//
// What matters is that the track that is PLAYING keeps playing whatever is done
// around it — its index follows it through a move, and nothing here bumps `seq`
// (a bump is a deliberate navigation: the audio owner would restart the track).
import test from "node:test";
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
const { player, current } = await import("../src/lib/stores.js");

const track = (id) => ({ deezer_id: String(id), title: `T${id}`, duration: 200 });
const ids = () => get(player).queue.map((t) => t.deezer_id).join("");

function fresh(n = 6, index = 2, extra = {}) {
  player.set({
    ...get(player),
    queue: Array.from({ length: n }, (_, i) => track(i + 1)),
    index,
    playing: true,
    currentTime: 42,
    seq: 10,
    shuffle: false,
    repeat: "off",
    autoplay: true,
    _orig: null,
    ...extra,
  });
}

test("moving a track past the playing one keeps the same track playing", () => {
  fresh(); // 1 2 [3] 4 5 6
  const playingId = get(current).deezer_id;
  player.move(4, 0); // 5 jumps in front of the playing track
  assert.equal(ids(), "512346");
  assert.equal(get(current).deezer_id, playingId);
  player.move(0, 5); // ...and out again, past everything
  assert.equal(ids(), "123465");
  assert.equal(get(current).deezer_id, playingId);
  player.move(0, 3); // a played track moved after the playing one
  assert.equal(ids(), "234165");
  assert.equal(get(current).deezer_id, playingId);
  player.move(3, 0); // and back
  assert.equal(get(current).deezer_id, playingId);
});

test("moving the playing track itself carries the index with it", () => {
  fresh();
  player.move(2, 5);
  assert.equal(ids(), "124563");
  assert.equal(get(player).index, 5);
  assert.equal(get(current).deezer_id, "3");
});

test("a move is not a navigation: the seq is left alone", () => {
  fresh();
  const before = get(player);
  player.move(4, 3);
  assert.equal(get(player).seq, before.seq, "a bump would restart the playing track");
  assert.equal(get(player).currentTime, 42);
  assert.equal(get(player).playing, true);
});

test("a move that changes nothing does not even notify", () => {
  fresh();
  let n = 0;
  const off = player.subscribe(() => n++);
  n = 0;
  player.move(3, 3); // same place
  player.move(-1, 2); // no such row
  player.move(99, 2);
  player.move(1.5, 2);
  player.move(2, NaN);
  assert.equal(n, 0, "the queue top-up listens to this store");
  off();
});

test("a destination past either end is clamped, not an error", () => {
  fresh();
  player.move(3, 999);
  assert.equal(ids(), "123564");
  player.move(3, -5);
  assert.equal(ids(), "512364");
});

test("under shuffle, un-shuffling still goes back to the original order", () => {
  fresh(6, 0);
  const orig = get(player).queue;
  player.toggleShuffle(); // -> shuffled, `_orig` = the order it was in
  player.move(3, 1);
  assert.equal(get(player)._orig, orig, "the reorder is not part of the original order");
  const playingId = get(current).deezer_id;
  player.toggleShuffle();
  assert.equal(ids(), "123456");
  assert.equal(get(current).deezer_id, playingId);
});

test("clearing drops what is after the playing track, and the endless continuation with it", () => {
  fresh(); // 1 2 [3] 4 5 6
  player.clearUpcoming();
  assert.equal(ids(), "123", "what was already played stays, so 'previous' still works");
  assert.equal(get(current).deezer_id, "3");
  assert.equal(get(player).autoplay, false, "a radio refilling it five seconds later is the opposite of clearing");
  assert.equal(get(player).playing, true);
  assert.equal(get(player)._orig, null);
});

test("a new queue turns the continuation back on", () => {
  fresh();
  player.clearUpcoming();
  player.playQueue([track(7), track(8)], 0);
  assert.equal(get(player).autoplay, true);
  fresh();
  player.clearUpcoming();
  player.shufflePlay([track(7), track(8)]);
  assert.equal(get(player).autoplay, true);
});

test("clearing with nothing playing leaves an empty queue", () => {
  fresh(3, -1);
  player.clearUpcoming();
  assert.equal(get(player).queue.length, 0);
});

test("advancePaused lines the next track up without playing it", () => {
  fresh(); // 1 2 [3] 4 5 6
  const seq = get(player).seq;
  player.advancePaused();
  assert.equal(get(current).deezer_id, "4");
  assert.equal(get(player).playing, false);
  assert.equal(get(player).seq, seq + 1, "the audio owner loads the new source on a seq bump");
  assert.equal(get(player).currentTime, 0);
});

test("advancePaused at the end, or on repeat-one, just stops", () => {
  fresh(3, 2); // on the last one
  const seq = get(player).seq;
  player.advancePaused();
  assert.equal(get(current).deezer_id, "3");
  assert.equal(get(player).playing, false);
  assert.equal(get(player).seq, seq);
  fresh(6, 2, { repeat: "one" });
  player.advancePaused();
  assert.equal(get(current).deezer_id, "3", "repeat-one keeps its track");
  assert.equal(get(player).playing, false);
});
