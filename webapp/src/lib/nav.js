// Screen memory for the back button.
//
// Hash routing gives us real browser history, so "back" — the floating button,
// the phone's gesture, the Android hardware key — always lands on the right
// ROUTE. But a route is not a SCREEN. The text in the search box, the selected
// tab, the scroll offset: all of it lives in component state, which the router
// destroys on the way out and rebuilds EMPTY on the way in. Opening an album
// from halfway down a search for "daft punk" and coming back used to drop you
// at the top of a blank search page, with the query gone.
//
// So every history entry gets an id, stamped into `history.state` (which is
// what survives a traversal), and against that id we keep the scroll offset
// plus a small scratch object the screen itself fills in. Coming BACK into an
// entry — or forward into one — hands that state straight back.
//
// A *fresh* navigation to the same route deliberately gets nothing: tapping
// "Rechercher" in the nav must give you an empty box, not the query from ten
// minutes ago. That distinction is the whole point of keying on the history
// entry rather than on the path.
//
// One ordering trap, learned by watching it fail: the router's own hashchange
// listener is registered when its module is imported, before anything we can
// run, and it builds the new screen SYNCHRONOUSLY inside that listener. A
// component asking what it should restore therefore runs BEFORE any listener of
// ours would. So the current entry is resolved lazily — every entry point calls
// `syncEntry()` first — and nothing here depends on winning a listener race.

const KEY = "nsNav";
// History entries we keep state for. Deep enough that no realistic back-stack
// runs out of it, bounded so a long session can't grow without limit (a search
// screen's scratch holds its result lists).
const KEEP = 50;
// How long a scroll restore may keep chasing its target. The page it is
// restoring paints its rows asynchronously, so the offset we want isn't
// reachable on the first frame — but it must not chase forever either.
const RESTORE_MS = 1500;
// …and it must not stop at the first frame where the offset happens to fit.
// popstate lands one task before hashchange, so the first frames of a restore
// can still be measuring the page we are LEAVING: hitting the target there, and
// stopping, left us back at zero the moment the router swapped the page in. So
// the offset has to hold, on a page whose height has stopped moving, for a few
// frames and at least this long before we call it restored.
const SETTLE_MS = 300;
const SETTLE_FRAMES = 4;

let scroller = () => null;
let seq = 0;
let currentId = -1;
// Was the navigation that put us on the current entry a history traversal
// (back/forward) rather than a fresh push? Only then is remembered state ours
// to hand back.
let traversed = false;
let scrollBound = false;

const scrolls = new Map(); // entry id -> scrollTop
const scratch = new Map(); // entry id -> whatever the screen remembered

// --- history entry identity -------------------------------------------------

function readId() {
  const st = window.history.state;
  return st && typeof st[KEY] === "number" ? st[KEY] : null;
}

// A brand-new entry (a push, or the very first load) carries no id: give it
// one, keeping whatever else already lives in history.state.
function stampId() {
  const id = ++seq;
  try {
    window.history.replaceState({ ...(window.history.state || {}), [KEY]: id }, "");
  } catch {
    /* replaceState can throw on exotic URLs; ids just stop being stable */
  }
  return id;
}

/**
 * Bring `currentId` up to date with the entry the browser is actually on.
 * Idempotent and cheap (one history.state read), so every entry point can call
 * it without caring who got here first.
 */
function syncEntry() {
  const id = readId();
  if (id === currentId) return false;
  if (id === null) {
    // No id on this entry: a push, so it never existed before.
    currentId = stampId();
    traversed = false;
  } else {
    // An id we handed out earlier: a back or forward traversal.
    currentId = id;
    traversed = true;
  }
  prune(scrolls);
  prune(scratch);
  return true;
}

function prune(map) {
  if (map.size <= KEEP) return;
  const ids = [...map.keys()].sort((a, b) => a - b);
  for (let i = 0; i < ids.length - KEEP; i++) map.delete(ids[i]);
}

// --- scroll -----------------------------------------------------------------

let restoring = false;
let raf = 0;
let stopAbort = null;
const ABORT_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"];
const ABORT_OPTS = { passive: true, capture: true };

function cancelRestore() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  restoring = false;
  stopAbort?.();
  stopAbort = null;
}

// Chase `top` across frames: the page we're restoring fills in asynchronously,
// so on the first frames it is still too short for that offset to exist and the
// browser clamps us to the bottom. Give up the moment the user touches the
// scroller themselves — fighting a deliberate scroll would feel broken.
function restoreScroll(top) {
  cancelRestore();
  if (!scroller()) return;
  restoring = true;
  const until = Date.now() + RESTORE_MS;
  const abort = () => cancelRestore();
  for (const ev of ABORT_EVENTS) window.addEventListener(ev, abort, ABORT_OPTS);
  stopAbort = () => {
    for (const ev of ABORT_EVENTS) window.removeEventListener(ev, abort, ABORT_OPTS);
  };

  const settleAt = Date.now() + SETTLE_MS;
  let held = 0;
  let lastHeight = -1;
  const step = () => {
    raf = 0;
    const node = scroller();
    if (!node) return cancelRestore();
    // `instant` twice over: <main> is scroll-behavior:smooth, so a plain
    // assignment would ANIMATE every correction, and an explicit instant scroll
    // also cancels any smooth scroll still in flight.
    node.scrollTo({ top, left: 0, behavior: "instant" });
    const height = node.scrollHeight;
    if (Math.abs(node.scrollTop - top) < 2 && height === lastHeight) held++;
    else held = 0;
    lastHeight = height;
    const settled = held >= SETTLE_FRAMES && Date.now() > settleAt;
    if (settled || Date.now() > until) return cancelRestore();
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}

function resetScroll() {
  cancelRestore();
  scroller()?.scrollTo({ top: 0, left: 0, behavior: "instant" });
}

// --- navigation -------------------------------------------------------------

function onNav() {
  if (!syncEntry()) return; // a replace() of the entry we're already on
  const top = traversed ? scrolls.get(currentId) || 0 : 0;
  if (top > 0) restoreScroll(top);
  else resetScroll();
}

// Registered at import time, and on BOTH events: popstate lands before
// hashchange on a traversal, and either one alone would be enough — syncEntry()
// makes the second a no-op.
window.addEventListener("popstate", onNav);
window.addEventListener("hashchange", onNav);

/**
 * Point the scroll memory at the shell's scrolling element. A getter, because
 * it doesn't exist yet while the login screen is up.
 */
export function initNav(getScroller) {
  scroller = getScroller || (() => null);
  syncEntry();
  if (scrollBound) return;
  scrollBound = true;
  // Scroll events don't bubble, so listen in the capture phase: one listener
  // covers the shell's scroller for the life of the app, whatever the router
  // swaps inside it. Other scrollers (the queue, the lyrics pane) are filtered
  // out by identity. Recording continuously — rather than snapshotting on the
  // way out — is what keeps the saved offset exact no matter when we are told
  // about the navigation.
  window.addEventListener(
    "scroll",
    (e) => {
      if (restoring) return;
      const el = scroller();
      if (el && e.target === el) scrolls.set(currentId, el.scrollTop);
    },
    { passive: true, capture: true }
  );
}

/** Merge `patch` into the state kept for the history entry we're on. */
export function rememberScreen(patch) {
  if (!patch) return;
  syncEntry();
  scratch.set(currentId, { ...(scratch.get(currentId) || {}), ...patch });
}

/**
 * The state this screen left behind — but only when we got here by going back
 * (or forward) to it. A fresh push onto the same route gets null, and starts
 * clean.
 */
export function recallScreen() {
  syncEntry();
  return traversed ? scratch.get(currentId) || null : null;
}
