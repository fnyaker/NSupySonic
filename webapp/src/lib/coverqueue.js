// Which artwork to fetch first: the one you are looking at.
//
// A list hands the browser every cover it has mounted at once. `loading="lazy"`
// helps, but its margin is generous and it knows nothing about WHERE you are
// going — so scrolling down a playlist spent the link on the rows you had just
// left as readily as on the ones arriving, and a long list could put dozens of
// requests in flight against a server that answers them from a small pool of
// threads. The row under your thumb then waited behind a row three screens
// away that nobody will ever see.
//
// So the covers ask this module for a turn instead of taking one. It keeps a
// few in flight, and each time a slot frees it gives it to whichever waiting
// cover is closest to the viewport — with the direction you are scrolling
// counted as closer, because that is where you are about to be.
//
// Everything here degrades to "just load it": an entry that has waited too
// long, a browser without the timing APIs, a cover already on the device. A
// scheduler that can lose a picture is worse than no scheduler.

const MAX_INFLIGHT = 4;
//: Past this, a waiting cover is admitted whatever the queue thinks. Nothing
//: may be starved out of existence by a scroll that never settles.
const MAX_WAIT = 8000;
//: How much cheaper a cover is for being in the direction of travel.
const AHEAD_BONUS = 4;

const pending = new Set();
let inflight = 0;
let frame = null;

// --- which way are we going ------------------------------------------------
// Captured from ANY scroller, not just the window: the app's lists scroll
// inside their own elements, and a page-level listener never hears them.
let direction = 1; // 1 = down/forward, -1 = up/back
const lastTop = new WeakMap();

function onScroll(e) {
  const el = e.target;
  const top =
    el === document || el === window
      ? window.scrollY || 0
      : (el.scrollTop ?? 0) + (el.scrollLeft ?? 0);
  const was = lastTop.get(el);
  lastTop.set(el, top);
  if (was === undefined || top === was) return;
  direction = top > was ? 1 : -1;
  schedule();
}

if (typeof window !== "undefined")
  // Capture, because scroll does not bubble.
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });

// --- scoring ---------------------------------------------------------------

function score(entry) {
  // Read LAZILY. The caller asks for a turn while Svelte is still building the
  // component, so its tile does not exist yet — and an entry scored Infinity
  // there would be dropped and its cover would never load at all. Unmeasurable
  // means "not known to be on screen", which is a middling score, never a
  // death sentence; by the next frame the element is there and it scores for
  // real.
  const el = entry.getEl();
  if (!el) return 1;
  if (!el.isConnected) return Infinity; // gone from the page: never worth a slot
  let r;
  try {
    r = el.getBoundingClientRect();
  } catch {
    return 0;
  }
  const vh = window.innerHeight || 800;
  if (r.bottom >= 0 && r.top <= vh) return 0; // on screen: nothing beats this
  const below = r.top > vh;
  const distance = below ? r.top - vh : -r.bottom;
  const ahead = below ? direction > 0 : direction < 0;
  return ahead ? distance : distance * AHEAD_BONUS;
}

function schedule() {
  if (frame !== null || !pending.size) return;
  frame =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(pump)
      : setTimeout(pump, 16);
}

function pump() {
  frame = null;
  if (!pending.size) return;
  const now = Date.now();
  const ranked = [];
  for (const entry of pending) {
    // Waited long enough that the ordering has stopped being an optimisation
    // and started being a bug. Let it through.
    if (now - entry.at > MAX_WAIT) {
      admit(entry);
      continue;
    }
    const s = score(entry);
    if (s === Infinity) {
      pending.delete(entry); // gone from the page while it waited
      continue;
    }
    ranked.push([s, entry]);
  }
  ranked.sort((a, b) => a[0] - b[0]);
  for (const [, entry] of ranked) {
    if (inflight >= MAX_INFLIGHT) break;
    admit(entry);
  }
  if (pending.size) schedule();
}

function admit(entry) {
  pending.delete(entry);
  inflight++;
  entry.started = true;
  try {
    entry.start();
  } catch {
    release(entry);
  }
}

function release(entry) {
  if (entry.released) return;
  entry.released = true;
  if (entry.started) inflight = Math.max(0, inflight - 1);
  else pending.delete(entry);
  schedule();
}

/**
 * Ask for a turn to load one cover.
 *
 * `getEl` returns what gets measured (the tile, which exists before the image
 * does — and before the component has finished mounting, which is why this is
 * a function and not an element). `start` is called when the turn comes. The
 * returned handle must be `done()` when the image settles — either way — and
 * `cancel()`ed if the component goes away or its source changes first. A slot
 * never released is a slot lost for the session, so both paths are idempotent.
 */
export function requestCover(getEl, start) {
  const entry = { getEl, start, at: Date.now(), started: false, released: false };
  if (inflight < MAX_INFLIGHT && score(entry) === 0) {
    // Already on screen and there is room: skip the queue entirely, so a short
    // list behaves exactly as if this module did not exist.
    admit(entry);
  } else {
    pending.add(entry);
    schedule();
  }
  return {
    done: () => release(entry),
    cancel: () => release(entry),
  };
}
