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
// Everything here degrades to "just load it": a browser without the timing
// APIs, a cover already on the device. A scheduler that can lose a picture is
// worse than no scheduler.
//
// What it must NEVER do is let go of everything at once. It used to admit any
// cover that had waited 8 s "whatever the queue thinks": on the releases page
// (300 cards, six on screen) that put ~600 requests in flight eight seconds
// after opening it (a cover and its blurred placeholder each), and every cover
// scrolled to afterwards queued behind all of them on a phone's link — the
// "covers take ten minutes" report. Measured in headless Chromium on that page:
// 314 requests in flight at once before, never more than the slots after.
// Starvation is answered differently: a cover that has not settled after
// STALL_MS stops holding its slot (it keeps loading), so a hung request can
// delay the queue by seconds, never stop it; and a cover nobody brings near
// the screen is simply never asked for — a picture never seen costs nothing.

const MAX_INFLIGHT = 6;
//: Of those, how many may go to covers NOT on screen yet. The rest are kept
//: for what is on screen: after a long scroll, the covers you land on used to
//: wait for the ones fetched ahead of the place you left.
const AHEAD_SLOTS = 3;
//: A turn that has not settled by then frees its slot (the image keeps loading:
//: it just stops counting). A CDN that hangs on one picture must not hold the
//: queue for good.
const STALL_MS = 4000;
//: How far from the viewport a cover may be, in viewports, and still be
//: fetched ahead of being seen. Beyond it, it waits for a scroll to bring it in.
const HORIZON = 2;
//: Pending covers outside the horizon are re-measured this often even without a
//: scroll, for a layout that moved under them (content above loading in).
const RECHECK_MS = 1000;
//: How much cheaper a cover is for being in the direction of travel.
const AHEAD_BONUS = 4;

const pending = new Set();
let inflight = 0;
let frame = null;
let recheck = null;

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

if (typeof window !== "undefined") {
  // Capture, because scroll does not bubble.
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.addEventListener("resize", () => schedule(), { passive: true });
}

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
  const vw = window.innerWidth || 0;
  // Sideways too: a shelf scrolls horizontally inside a row that is on screen,
  // and its twentieth card is as far from being seen as a row two screens down.
  let side = 0;
  if (vw && typeof r.left === "number" && typeof r.right === "number")
    side = r.left > vw ? r.left - vw : r.right < 0 ? -r.right : 0;
  let along = 0;
  let ahead = true;
  if (!(r.bottom >= 0 && r.top <= vh)) {
    const below = r.top > vh;
    along = below ? r.top - vh : -r.bottom;
    ahead = below ? direction > 0 : direction < 0;
  }
  const distance = Math.max(along, side);
  if (distance === 0) return 0; // on screen: nothing beats this
  if (along > HORIZON * vh || (vw && side > HORIZON * vw)) return FAR;
  return ahead ? distance : distance * AHEAD_BONUS;
}

// Beyond the horizon: kept, not fetched, until a scroll brings it closer.
const FAR = Number.MAX_SAFE_INTEGER;

function schedule() {
  if (frame !== null || !pending.size) return;
  frame =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(pump)
      : setTimeout(pump, 16);
}

function later(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === "function") t.unref();
  return t;
}

function pump() {
  frame = null;
  if (!pending.size) return;
  const ranked = [];
  let unmeasured = false;
  for (const entry of pending) {
    const s = score(entry);
    if (s === Infinity) {
      pending.delete(entry); // gone from the page while it waited
      continue;
    }
    if (s === FAR) continue;
    if (!entry.getEl()) unmeasured = true;
    ranked.push([s, entry]);
  }
  ranked.sort((a, b) => a[0] - b[0]);
  for (const [s, entry] of ranked) {
    if (inflight >= (s === 0 ? MAX_INFLIGHT : AHEAD_SLOTS)) break;
    admit(entry);
  }
  // Nothing here runs per frame for its own sake: a full queue waits for a
  // slot (a load, an error, a stall), a far one for a scroll. Two exceptions:
  // a tile not built yet is measured again next frame, and what still waits is
  // looked at again now and then in case the page moved without scrolling.
  if (unmeasured && inflight < MAX_INFLIGHT) schedule();
  else if (pending.size && inflight < MAX_INFLIGHT && recheck === null)
    recheck = later(() => {
      recheck = null;
      schedule();
    }, RECHECK_MS);
}

function admit(entry) {
  pending.delete(entry);
  inflight++;
  entry.started = true;
  entry.counted = true;
  entry.stall = later(() => {
    entry.stall = null;
    free(entry);
  }, STALL_MS);
  try {
    entry.start();
  } catch {
    release(entry);
  }
}

// The slot goes back to the queue; the entry may still be loading.
function free(entry) {
  if (!entry.counted) return;
  entry.counted = false;
  inflight = Math.max(0, inflight - 1);
  schedule();
}

function release(entry) {
  if (entry.released) return;
  entry.released = true;
  if (entry.stall) clearTimeout(entry.stall);
  entry.stall = null;
  if (entry.started) free(entry);
  else {
    pending.delete(entry);
    schedule();
  }
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
  const entry = { getEl, start, started: false, counted: false, released: false, stall: null };
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
