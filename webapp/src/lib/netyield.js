// What a person is listening to has the link; downloads take what is left.
//
// Downloading a playlist on a phone used to run four FLACs at full speed
// alongside the track somebody had just pressed, and on a mobile link the four
// won: the track barely loaded. The rule is the user's: the action they take
// NOW — the track they launched, then the preload of the next one — goes before
// any download, which is a background job and can wait.
//
// The mechanism is the one players and browsers use for the same problem —
// Media3's PriorityTaskManager (a download proceeds only while no playback task
// is registered) and Chromium's ResourceScheduler (delayable requests wait
// while important ones are in flight) — applied at the one place this app
// controls, its own reads:
//
//   - the PLAYER says, for each audio element, whether it needs the network
//     (playing, its source on the network, less than WANT_S buffered ahead of
//     the playhead; it lets go again at ENOUGH_S or when the file is in);
//   - the PREFETCH holds the link while it loads the next track;
//   - while anything holds it, a download does not start, and one in progress
//     is read at a trickle (TRICKLE bytes a second): the TCP receive window then
//     holds the server to that rate, while the connection never sits idle long
//     enough for a proxy to time it out. The app's own downloads
//     (OfflineStore) are told the same through NSNative.offYield, as a lease
//     renewed while it lasts, so a page that died cannot stop them for good.
//
// Pure state plus a few listeners: nothing runs while nothing is downloading.

export const WANT_S = 15; // under this many seconds ahead, the player needs the link
export const ENOUGH_S = 30; // ...and at this many it lets it go again
export const TRICKLE = 4096; // bytes a second a yielding download may read
const LEASE_MS = 45000; // what the app is told; renewed well before it ends
const RENEW_MS = 15000;
const MAX_PAUSE_MS = 20000; // the longest a trickled web read sleeps

const elements = new Map(); // element -> wants the link
const holds = new Set(); // tokens (prefetch)
let waiters = [];
let yielding = false;
let renewedAt = 0;
let renewTimer = null;

function nativeYield(ms) {
  try {
    const n = typeof window !== "undefined" ? window.NSNative : null;
    if (n && typeof n.offYield === "function") n.offYield(ms);
  } catch {
    /* an older app: its downloads simply do not yield */
  }
}

function recompute() {
  let want = holds.size > 0;
  if (!want) for (const w of elements.values()) if (w) { want = true; break; }
  const now = Date.now();
  if (want !== yielding) {
    yielding = want;
    if (want) {
      renewedAt = now;
      nativeYield(LEASE_MS);
      clearInterval(renewTimer);
      // Element events renew it too (they keep coming in a hidden page,
      // where this timer may be throttled to once a minute).
      renewTimer = setInterval(renew, RENEW_MS);
    } else {
      clearInterval(renewTimer);
      renewTimer = null;
      nativeYield(0);
      const w = waiters;
      waiters = [];
      for (const fn of w) fn();
    }
  } else if (want) {
    renew();
  }
}

function renew() {
  if (!yielding) return;
  const now = Date.now();
  if (now - renewedAt < RENEW_MS) return;
  renewedAt = now;
  nativeYield(LEASE_MS);
}

/** Whether downloads should give the link back right now. */
export function isYielding() {
  return yielding;
}

/** Resolves once nothing holds the link (at once when nothing does). */
export function whenClear() {
  if (!yielding) return Promise.resolve();
  return new Promise((r) => waiters.push(r));
}

/** Holds the link (the next track's preload); returns its release. */
export function hold() {
  const token = {};
  holds.add(token);
  recompute();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    holds.delete(token);
    recompute();
  };
}

/** Runs `fn` holding the link. */
export async function holding(fn) {
  const release = hold();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Is this source played off the device (no network to share)? */
export function isLocalSource(src) {
  const s = String(src || "");
  return !s || s.startsWith("blob:") || s.startsWith("data:") || s.includes("/__nsoffline/");
}

/** Seconds buffered ahead of the playhead, and whether the file is all in. */
export function aheadOf(el) {
  const t = +el.currentTime || 0;
  let end = t;
  try {
    const b = el.buffered;
    for (let i = 0; b && i < b.length; i++) {
      if (b.start(i) <= t + 0.5 && b.end(i) > end) end = b.end(i);
    }
  } catch {
    /* no ranges yet */
  }
  const d = +el.duration;
  const full = Number.isFinite(d) && d > 0 && end >= d - 0.5;
  return { ahead: end - t, full };
}

/**
 * Whether `el` needs the link: it is playing (or loading to play) a source on
 * the network with too little in hand. `was` is its previous answer — the two
 * thresholds keep it from flapping at the edge.
 */
export function elementWants(el, was = false) {
  if (!el || el.paused || el.ended || isLocalSource(el.currentSrc || el.src)) return false;
  const { ahead, full } = aheadOf(el);
  if (full) return false;
  return ahead < (was ? ENOUGH_S : WANT_S);
}

const EVENTS = ["play", "playing", "pause", "waiting", "stalled", "progress", "timeupdate",
  "canplaythrough", "ended", "emptied", "loadstart", "error"];

/** Follows an audio element for the life of the page; returns the detach. */
export function watchElement(el) {
  if (!el) return () => {};
  let attached = true;
  const check = () => {
    if (!attached) return;
    const was = elements.get(el) || false;
    const now = elementWants(el, was);
    // An element set aside (no source, paused) is forgotten until it is used
    // again: the listeners stay, the index holds no element the player let go.
    if (!now && el.paused && !(el.currentSrc || el.src)) {
      if (elements.delete(el) && was) recompute();
      return;
    }
    elements.set(el, now);
    if (now !== was) recompute();
    else if (now) renew();
  };
  for (const e of EVENTS) el.addEventListener(e, check);
  check();
  return () => {
    attached = false;
    for (const e of EVENTS) el.removeEventListener(e, check);
    if (elements.delete(el)) recompute();
  };
}

/**
 * How long a download that just read `n` bytes while yielding should pause, so
 * its average stays at the trickle (never longer than a proxy tolerates).
 */
export function tricklePause(n) {
  return Math.min(MAX_PAUSE_MS, Math.round((n / TRICKLE) * 1000));
}

/** Sleeps for the trickle after `n` bytes, waking as soon as the link is free. */
export function trickle(n) {
  if (!yielding) return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(done, tricklePause(n));
    function done() {
      clearTimeout(t);
      waiters = waiters.filter((w) => w !== done);
      r();
    }
    waiters.push(done);
  });
}

/** For tests: forget every element and hold. */
export function resetNetYield() {
  elements.clear();
  holds.clear();
  clearInterval(renewTimer);
  renewTimer = null;
  const w = waiters;
  waiters = [];
  yielding = false;
  for (const fn of w) fn();
}
