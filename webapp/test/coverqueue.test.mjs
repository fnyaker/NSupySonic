// The cover loader decides which artwork gets the link first. Everything it
// can get wrong is invisible until a picture is simply missing, so the parts
// pinned here are the ones that would lose one: an element that does not exist
// yet, a slot that is never given back, a cover nobody ever scrolls to.

import test from "node:test";
import assert from "node:assert/strict";

// --- a DOM just large enough ------------------------------------------------
const listeners = [];
let rafQueue = [];

globalThis.window = {
  innerHeight: 800,
  addEventListener: (type, fn, opts) => listeners.push({ type, fn, opts }),
};
globalThis.document = {};
globalThis.requestAnimationFrame = (fn) => {
  rafQueue.push(fn);
  return rafQueue.length;
};

/** Run every frame the module has asked for, repeatedly, until it settles. */
function flush(rounds = 12) {
  for (let i = 0; i < rounds && rafQueue.length; i++) {
    const due = rafQueue;
    rafQueue = [];
    for (const fn of due) fn();
  }
}

function tile(top) {
  return {
    isConnected: true,
    getBoundingClientRect: () => ({ top, bottom: top + 100 }),
  };
}

// ONE scroller, reused: the module reads the direction from how far a given
// element has moved since last time, so a fresh object every call would look
// like a fresh scroller that has never moved.
const scroller = { scrollTop: 0, scrollLeft: 0 };
function scrollTo(scrollTop) {
  scroller.scrollTop = scrollTop;
  for (const l of listeners) if (l.type === "scroll") l.fn({ target: scroller });
}

const { requestCover } = await import("../src/lib/coverqueue.js");

/** Ask for `n` turns and record the order they are granted in. */
function ask(entries) {
  const order = [];
  const handles = entries.map(([name, el]) =>
    requestCover(
      () => el,
      () => order.push(name)
    )
  );
  return { order, handles };
}

test("a cover whose element does not exist yet is still loaded", () => {
  // Svelte asks for a turn while it is still building the component, so the
  // tile is undefined at that moment. Treating that as "not on screen, forever"
  // is how a cover would never load at all.
  const { order, handles } = ask([["pending", undefined]]);
  flush();
  assert.deepEqual(order, ["pending"]);
  handles.forEach((h) => h.done());
});

test("what is on screen goes before what is not", () => {
  const { order, handles } = ask([
    ["far-below", tile(5000)],
    ["visible", tile(100)],
    ["just-below", tile(900)],
  ]);
  flush();
  assert.equal(order[0], "visible");
  assert.equal(order[1], "just-below");
  handles.forEach((h) => h.done());
});

test("scrolling down favours what is below, not what was left behind", () => {
  scrollTo(0);
  scrollTo(400); // moving down
  const { order, handles } = ask([
    ["behind", tile(-1200)], // 1200px above the viewport
    ["ahead", tile(1600)], // 800px below it: further away, but where we are going
  ]);
  flush();
  assert.deepEqual(order, ["ahead", "behind"]);
  handles.forEach((h) => h.done());
  // ...and the same list scrolled the other way prefers the other one.
  scrollTo(100); // moving up
  const back = ask([
    ["behind", tile(-1200)],
    ["ahead", tile(1600)],
  ]);
  flush();
  assert.deepEqual(back.order, ["behind", "ahead"]);
  back.handles.forEach((h) => h.done());
});

test("a slot is given back, and only once", () => {
  // Five covers, four slots: the fifth waits for one of the others to settle.
  const first = ask([
    ["a", tile(0)],
    ["b", tile(10)],
    ["c", tile(20)],
    ["d", tile(30)],
  ]);
  flush();
  assert.equal(first.order.length, 4);
  const late = ask([["e", tile(40)]]);
  flush();
  assert.deepEqual(late.order, [], "no slot free yet");
  first.handles[0].done();
  first.handles[0].done(); // idempotent: a double release must not invent a slot
  flush();
  assert.deepEqual(late.order, ["e"]);
  [...first.handles.slice(1), ...late.handles].forEach((h) => h.done());
  // A cancel frees the queue too, so a scrolled-away row does not hold a place.
  const held = ask([
    ["x", tile(0)],
    ["y", tile(10)],
    ["z", tile(20)],
    ["w", tile(30)],
  ]);
  flush();
  held.handles.forEach((h) => h.cancel());
  const after = ask([["next", tile(0)]]);
  flush();
  assert.deepEqual(after.order, ["next"]);
  after.handles.forEach((h) => h.done());
});

test("an unmounted cover is dropped instead of holding the queue", () => {
  const ghost = { isConnected: false, getBoundingClientRect: () => ({ top: 0, bottom: 1 }) };
  const busy = ask([
    ["a", tile(0)],
    ["b", tile(1)],
    ["c", tile(2)],
    ["d", tile(3)],
  ]);
  flush();
  const { order, handles } = ask([["ghost", ghost]]);
  flush();
  assert.deepEqual(order, [], "a row that left the page never gets a turn");
  handles.forEach((h) => h.cancel());
  busy.handles.forEach((h) => h.done());
});
