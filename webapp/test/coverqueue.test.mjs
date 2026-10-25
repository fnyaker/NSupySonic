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
  // Seven covers, six slots: the seventh waits for one of the others to settle.
  const first = ask([
    ["a", tile(0)],
    ["b", tile(10)],
    ["c", tile(20)],
    ["d", tile(30)],
    ["d2", tile(31)],
    ["d3", tile(32)],
  ]);
  flush();
  assert.equal(first.order.length, 6);
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
    ["w2", tile(31)],
    ["w3", tile(32)],
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
    ["d2", tile(4)],
    ["d3", tile(5)],
  ]);
  flush();
  const { order, handles } = ask([["ghost", ghost]]);
  flush();
  assert.deepEqual(order, [], "a row that left the page never gets a turn");
  handles.forEach((h) => h.cancel());
  busy.handles.forEach((h) => h.done());
});

// --- time, held in the test's hand ---------------------------------------
// The loader's two timers (a stalled turn, a far cover's re-check) are read off
// globalThis at the moment they are set, so a test can stand in for the clock.
function fakeClock() {
  const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout, now: Date.now };
  const origin = real.now();
  let now = 0;
  Date.now = () => origin + now;
  let timers = [];
  globalThis.setTimeout = (fn, ms) => {
    const t = { fn, at: now + ms, dead: false };
    timers.push(t);
    return t;
  };
  globalThis.clearTimeout = (t) => {
    if (t && typeof t === "object" && "dead" in t) t.dead = true;
    else real.clear(t);
  };
  return {
    advance(ms) {
      now += ms;
      const due = timers.filter((t) => !t.dead && t.at <= now);
      timers = timers.filter((t) => !due.includes(t));
      for (const t of due) t.fn();
    },
    restore() {
      globalThis.setTimeout = real.set;
      globalThis.clearTimeout = real.clear;
      Date.now = real.now;
    },
  };
}

function sideTile(left, top = 100) {
  return {
    isConnected: true,
    getBoundingClientRect: () => ({ top, bottom: top + 150, left, right: left + 150 }),
  };
}

test("a long wait never lets the whole page through at once", () => {
  // The releases page: six cards on screen, three hundred below. The loader
  // used to admit anything that had waited 8 s, which put every one of them in
  // flight at once (314 requests measured in Chromium) and left the covers the
  // person scrolled to behind all of them.
  const clock = fakeClock();
  try {
    const page = [];
    for (let i = 0; i < 300; i++) page.push(["c" + i, tile(100 + Math.floor(i / 2) * 250)]);
    const { order, handles } = ask(page);
    flush();
    // Everything within two screens of the viewport (800 px tall here) may go
    // ahead, six at a time; settle each as it starts, then wait a minute.
    for (let round = 0; round < 100; round++) {
      for (const name of order.slice()) handles[+name.slice(1)].done();
      clock.advance(1000);
      flush();
    }
    const furthest = Math.max(...order.map((n) => +n.slice(1)));
    assert.ok(order.length < 30, `only what is near the screen is fetched (${order.length})`);
    assert.ok(furthest < 30, `nothing two screens away is fetched (${furthest})`);
    handles.forEach((h) => h.cancel());
  } finally {
    clock.restore();
  }
});

test("a turn that hangs gives its slot back after a few seconds", () => {
  const clock = fakeClock();
  try {
    const hung = ask(["h1", "h2", "h3", "h4", "h5", "h6"].map((n, i) => [n, tile(i)]));
    flush();
    assert.equal(hung.order.length, 6);
    const next = ask([["next", tile(10)]]);
    flush();
    assert.deepEqual(next.order, [], "all six slots held");
    clock.advance(3900);
    flush();
    assert.deepEqual(next.order, [], "not before the stall delay (4 s)");
    clock.advance(200);
    flush();
    assert.deepEqual(next.order, ["next"], "a hung request no longer holds the queue");
    // Its late settling must not hand out a slot it already gave back.
    hung.handles.forEach((h) => h.done());
    const after = ask(["a1", "a2", "a3", "a4", "a5", "a6", "a7"].map((n, i) => [n, tile(i)]));
    flush();
    assert.equal(after.order.length, 5, "one slot still held by 'next', five free");
    [...next.handles, ...after.handles].forEach((h) => h.cancel());
  } finally {
    clock.restore();
  }
});

test("a far cover waits for the scroll that brings it near", () => {
  const clock = fakeClock();
  try {
    let top = 5000;
    const el = { isConnected: true, getBoundingClientRect: () => ({ top, bottom: top + 100 }) };
    const { order, handles } = ask([["far", el]]);
    flush();
    clock.advance(60000);
    flush();
    assert.deepEqual(order, [], "never fetched while it is three screens away");
    top = 1200; // scrolled to within half a screen
    scrollTo(scroller.scrollTop + 3800);
    flush();
    assert.deepEqual(order, ["far"]);
    handles.forEach((h) => h.done());
  } finally {
    clock.restore();
  }
});

test("covers fetched ahead never take the slots of the ones on screen", () => {
  const clock = fakeClock();
  try {
    // Three below the fold go first (nothing is on screen yet), and hang.
    const ahead = ask([["b1", tile(900)], ["b2", tile(950)], ["b3", tile(1000)], ["b4", tile(1050)]]);
    flush();
    assert.deepEqual(ahead.order, ["b1", "b2", "b3"], "three slots at most for what is not on screen");
    // The person lands on a screen of six: three slots are still theirs at once.
    const seen = ask(["v1", "v2", "v3", "v4", "v5", "v6"].map((n, i) => [n, tile(i * 100)]));
    flush();
    assert.deepEqual(seen.order, ["v1", "v2", "v3"]);
    [...ahead.handles, ...seen.handles].forEach((h) => h.cancel());
  } finally {
    clock.restore();
  }
});

test("a shelf's cards beyond the right edge come after the ones in view", () => {
  window.innerWidth = 390;
  try {
    const { order, handles } = ask([
      ["right-3", sideTile(950)],
      ["right-1", sideTile(450)],
      ["visible", sideTile(200)],
      ["right-2", sideTile(600)],
      ["below", tile(830)],
    ]);
    flush();
    assert.deepEqual(order.slice(0, 2), ["visible", "below"]);
    const names = ["right-3", "right-1", "visible", "right-2", "below"];
    for (let i = 0; i < 3; i++) {
      for (const n of order) handles[names.indexOf(n)].done(); // settle what started
      flush();
    }
    assert.deepEqual(order.slice(2), ["right-1", "right-2", "right-3"]);
    handles.forEach((h) => h.done());
  } finally {
    delete window.innerWidth;
  }
});
