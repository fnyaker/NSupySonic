// The server's verdict on a track: its tempo and its style.
//
// Both are properties of the whole piece (see supysonic/deezer/analysis.py), so
// they are measured once on the server and simply read here. What that buys is
// not a marginal accuracy gain — it is that the animation is RIGHT FROM THE
// FIRST BAR. A live detector has to hear several seconds before it can say
// anything, and those seconds are the intro, which is the least representative
// part of the track. With a served BPM the beat tracker starts locked and only
// has to find the phase.
//
// Sometimes the answer does not exist YET. When the server has a way to reach
// one — a trained genre head, or the extractor plus a head on top of it — it
// measures the track in the background and tells us which ids to come back for
// (`pending`). Those ids are polled here for a while, and the moment a verdict
// lands it is written to the same cache as any other, so the player swaps to
// the served genre mid-track instead of carrying its live guess to the end.
// This is what makes the tag button pay off immediately: labelling a track
// gives it a verdict with no measurement at all.
//
// The FIRST play is the one a measurement cannot help: the verdict is measured
// from the archived file, and that play is what archives it. So the server
// answers with Deezer's published tempo in the meantime, flagged `provisional`
// (supysonic/deezer/analysis.py#tempo_hints). It is used at once — the tracker
// starts on it — and it is not the last word: the measured verdict follows the
// archive, usually inside the first minute. A provisional id therefore stays
// on the poll until the real one lands or the polls run out, and a later play
// asks again, at most every REASK_MS.
//
// Everything here is best-effort. A track nobody has measured, and nobody can
// measure, simply has no entry, and the live detector carries it exactly as it
// did before — so this is an accelerator, never a dependency.

import { api } from "./api.js";

const KEY = "audio.analysis";
const MAX = 500; // a few tens of KB; the LRU drops the oldest half
const mem = new Map(); // id -> verdict | null (null = asked, nothing there)
const pending = new Set();
let dirty = false;
let flushTimer = null;

// A track the server has put on ITS queue is worth a few more questions: the
// measurement is one ffmpeg pass plus one model run, so seconds, not minutes.
// Polled on a widening interval and then given up on — a server that is busy,
// or that died mid-job, must not keep a player asking forever.
const POLL_DELAYS = [1500, 3000, 6000, 12000, 25000];
const awaiting = new Map(); // id -> attempt count
const REASK_MS = 10 * 60 * 1000;
const reasked = new Map(); // id -> when a provisional verdict was last re-asked
let pollTimer = null;
const listeners = new Set();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && typeof raw === "object")
      for (const [id, v] of Object.entries(raw)) mem.set(id, v);
  } catch {
    /* a corrupt cache is just an empty one */
  }
}
load();

function flush() {
  flushTimer = null;
  if (!dirty) return;
  dirty = false;
  try {
    if (mem.size > MAX) {
      const drop = mem.size - Math.floor(MAX / 2);
      let i = 0;
      for (const k of mem.keys()) {
        if (i++ >= drop) break;
        mem.delete(k);
      }
    }
    const out = {};
    for (const [k, v] of mem) if (v) out[k] = v;
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    /* quota or private mode: the in-memory cache still works this session */
  }
}
function schedule() {
  dirty = true;
  if (flushTimer === null) flushTimer = setTimeout(flush, 5000);
}

/** The verdict for a track, or null when we do not have one. */
export function knownAnalysis(id) {
  return (id && mem.get(String(id))) || null;
}

/**
 * Subscribe to verdicts that arrive LATE. Returns an unsubscribe function.
 *
 * The engine seeds a verdict once, at the track change. A verdict that lands
 * afterwards — because the server had to measure it first — would otherwise be
 * missed until the NEXT play, which is exactly the case the tag button and the
 * background analysis create. Listeners are what let the player adopt it now.
 */
export function onAnalysis(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce(id, verdict) {
  for (const fn of listeners) {
    try {
      fn(id, verdict);
    } catch {
      /* a broken listener must not stop the others */
    }
  }
}

function store(id, verdict) {
  const had = mem.get(id) || null;
  mem.set(id, verdict || null);
  // The re-ask clock runs from the last time the server could only offer the
  // published tempo: asking again sooner would get the same answer.
  if (provisional(verdict)) reasked.set(id, Date.now());
  schedule();
  // A miss is not an event: it is the absence of one, and it is remembered so
  // the same track is not re-asked on every play.
  if (verdict && JSON.stringify(had) !== JSON.stringify(verdict))
    announce(id, verdict);
}

const provisional = (v) => !!(v && v.provisional);

/** Come back for these in a moment; the server has them on its queue. */
function watch(ids) {
  let grew = false;
  for (const id of ids || []) {
    const key = String(id);
    const have = mem.get(key);
    if (have && !provisional(have)) continue;
    if (!awaiting.has(key)) {
      awaiting.set(key, 0);
      grew = true;
    }
  }
  if (grew) armPoll();
}

function armPoll() {
  if (pollTimer !== null || !awaiting.size) return;
  pollTimer = setTimeout(pollDue, POLL_DELAYS[0]);
}

function pollDue() {
  pollTimer = null;
  const ids = [...awaiting.keys()];
  if (!ids.length) return;
  api
    .trackAnalyses(ids)
    .then((r) => {
      const got = (r && r.analyses) || {};
      // Back into `awaiting` only if the server still says it is working on it.
      const still = new Set((r && r.pending) || []);
      for (const id of ids) {
        const v = got[id];
        if (v && !provisional(v)) {
          store(id, v);
          awaiting.delete(id);
          continue;
        }
        // A provisional answer is used NOW and the real one still waited for:
        // it follows the archive, which the server cannot name as pending
        // until the file is on disk.
        if (v) store(id, v);
        const n = (awaiting.get(id) || 0) + 1;
        const interim = provisional(mem.get(id));
        if (n > POLL_DELAYS.length || (!interim && still.size && !still.has(id))) {
          // Either we have asked enough, or the server has stopped working on
          // it — an unmeasurable track, or a job that died. Leave the miss (or
          // the published tempo) in the cache and stop asking; the live
          // detector carries the rest.
          awaiting.delete(id);
          if (!interim) mem.set(id, null);
        } else {
          awaiting.set(id, n);
        }
      }
    })
    .catch(() => {
      /* an outage is not a reason to hammer: keep the queue, try again later */
    })
    .finally(() => {
      schedule();
      if (awaiting.size) {
        let max = 0;
        for (const n of awaiting.values()) if (n > max) max = n;
        pollTimer = setTimeout(pollDue, POLL_DELAYS[Math.min(max, POLL_DELAYS.length - 1)]);
      }
    });
}

function reaskDue(id) {
  const now = Date.now();
  if (now - (reasked.get(id) || 0) < REASK_MS) return false;
  reasked.set(id, now);
  return true;
}

/**
 * Ask for a run of tracks in one call, skipping the ones already answered.
 * Fire-and-forget: answers land in the cache for `knownAnalysis` to find.
 */
export function primeAnalyses(ids) {
  const want = [];
  for (const raw of ids || []) {
    if (!raw) continue;
    const id = String(raw);
    // Only Deezer's numeric ids: a local upload has no verdict to serve, and
    // asking for one per play would be a request that can only ever answer no.
    if (!/^\d+$/.test(id)) continue;
    if (pending.has(id)) continue;
    if (mem.has(id) && !(provisional(mem.get(id)) && reaskDue(id))) continue;
    want.push(id);
  }
  if (!want.length) return;
  for (const id of want) pending.add(id);
  api
    .trackAnalyses(want)
    .then((r) => {
      const got = (r && r.analyses) || {};
      for (const id of want) {
        // Remember a miss as well as a hit: a track that has not been measured
        // must not be re-asked on every play. A reload picks it up once the
        // server has caught up, which is the right cadence for something that
        // only changes when the archive does. A published tempo already in
        // hand is kept rather than forgotten when a re-ask comes back empty.
        store(id, got[id] || mem.get(id) || null);
      }
      // ...unless the server has just started measuring it, in which case the
      // answer is a moment away and we should be there to catch it — and a
      // provisional answer is always followed by the measured one.
      watch([...((r && r.pending) || []), ...want.filter((id) => provisional(got[id]))]);
    })
    .catch(() => {
      for (const id of want) pending.delete(id);
    })
    .finally(() => {
      for (const id of want) pending.delete(id);
    });
}

/**
 * Record a verdict a caller obtained itself (the tag picker writes one), so the
 * player uses it at once instead of waiting for the next play to notice.
 */
export function putAnalysis(id, verdict) {
  if (!id) return;
  pending.delete(String(id));
  awaiting.delete(String(id));
  store(String(id), verdict || null);
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flush);
