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
// Everything here is best-effort. A track nobody has measured yet simply has no
// entry, and the live detector carries it exactly as it did before — so this is
// an accelerator, never a dependency.

import { api } from "./api.js";

const KEY = "audio.analysis";
const MAX = 500; // a few tens of KB; the LRU drops the oldest half
const mem = new Map(); // id -> verdict | null (null = asked, nothing there)
const pending = new Set();
let dirty = false;
let flushTimer = null;

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
    if (mem.has(id) || pending.has(id)) continue;
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
        // only changes when the archive does.
        mem.set(id, got[id] || null);
      }
      schedule();
    })
    .catch(() => {
      for (const id of want) pending.delete(id);
    })
    .finally(() => {
      for (const id of want) pending.delete(id);
    });
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flush);
