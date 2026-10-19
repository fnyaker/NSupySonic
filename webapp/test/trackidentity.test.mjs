// Lot G: the app keys a track on its UUID, and what an older build left on the
// device still finds its track.
//
//   - a queue persisted by the previous version (tracks with a Deezer id, a
//     position tick naming the track by that id) reloads on the SAME track at
//     the same position;
//   - the small caches (verdicts, silence bounds, gains) kept under a Deezer id
//     answer to the UUID the same track has now;
//   - catalogue results, which have no row, keep a request id (trackRef) and
//     take the key their row will have.
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

const { migrateKey, trackKey, trackRef } = await import("../src/lib/trackkey.js");

// What the previous build wrote: no `id`, the Deezer id is the identity.
const old = (id) => ({ deezer_id: String(id), title: `T${id}`, duration: 200 });
const queue = [11, 22, 33, 44].map(old);
const now = Date.now();
mem.set("player.session", JSON.stringify({ queue, index: 0, currentTime: 5, at: now - 5000 }));
mem.set("player.pos", JSON.stringify({ i: 2, id: "33", t: 71.5, at: now }));
// Verdicts and silence bounds, keyed by Deezer id by the previous build.
mem.set("audio.analysis", JSON.stringify({ g: 3, v: { 33: { bpm: 174, style: "dnb" } }, t: { 33: now } }));
mem.set("audio.edges.v3", JSON.stringify({ db: -50, e: { 33: { start: 0.4, end: 200, duration: 201 } } }));

const { player } = await import("../src/lib/stores.js?lotg");
const { get } = await import("svelte/store");

test("a queue persisted by the previous version reloads on the same track", () => {
  const s = get(player);
  assert.equal(s.index, 2, "the tick named track 33 by its Deezer id");
  assert.equal(s.currentTime, 71.5);
  assert.equal(trackKey(s.queue[s.index]), migrateKey("33"));
  assert.equal(s.queue[s.index].deezer_id, "33");
});

test("the tick still finds its track when the queue was shifted", () => {
  mem.set("player.pos", JSON.stringify({ i: 0, id: "44", t: 9, at: Date.now() + 10 }));
  // (read afresh: a new instance of the module)
  return import("../src/lib/stores.js?lotg2").then(({ player: p }) => {
    const s = get(p);
    assert.equal(trackKey(s.queue[s.index]), migrateKey("44"));
    assert.equal(s.currentTime, 9);
  });
});

test("a tick written with the UUID (this version) restores too", async () => {
  mem.set("player.pos", JSON.stringify({ i: 1, id: migrateKey("22"), t: 3, at: Date.now() + 20 }));
  const { player: p } = await import("../src/lib/stores.js?lotg3");
  const s = get(p);
  assert.equal(s.index, 1);
  assert.equal(trackKey(s.queue[1]), migrateKey("22"));
});

test("verdicts and silence bounds kept under a Deezer id answer to the UUID", async () => {
  const { knownAnalysis } = await import("../src/lib/analysis.js");
  const { knownEdges } = await import("../src/lib/edges.js");
  const u = migrateKey("33");
  assert.equal(knownAnalysis(u)?.bpm, 174);
  assert.equal(knownAnalysis("33")?.bpm, 174, "a caller still holding the Deezer id");
  assert.equal(knownEdges(u, -50)?.start, 0.4);
  assert.equal(knownEdges("33", -50)?.start, 0.4);
});

test("a catalogue result is requested by its Deezer id and keyed by its row's UUID", () => {
  const hit = { deezer_id: "3135556", title: "x" };
  assert.equal(trackRef(hit), "3135556");
  assert.equal(trackKey(hit), "07e9d96b-af2c-5213-96bf-e9d8ea203276");
  const row = { ...hit, id: trackKey(hit) };
  assert.equal(trackRef(row), row.id, "once it is a row, requests name the row");
  assert.equal(trackKey(row), trackKey(hit), "same track before and after");
});
