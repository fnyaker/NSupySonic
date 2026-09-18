// Where each track's audio really starts and stops, cached on the device.
//
// The server measures it once per (file, threshold) with ffmpeg and caches the
// answer (supysonic/webui/edges.py); this keeps a copy here so a track played
// twice never asks again, and so a relaunch starts with what it already knew.
//
// Everything about this is best-effort. A track with no answer plays whole,
// which is exactly what the app did before this existed — nothing here may ever
// be on the path between pressing play and hearing audio.

import { api } from "./api.js";

const KEY = "audio.edges";
const MAX = 400; // ~40 KB of localStorage; the LRU drops the oldest half
const mem = new Map(); // id -> { start, end, duration, db } | null (known-absent)
const pending = new Map();
let threshold = null;
let dirty = false;
let flushTimer = null;

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!raw || typeof raw !== "object") return;
    threshold = typeof raw.db === "number" ? raw.db : null;
    for (const [id, v] of Object.entries(raw.e || {})) mem.set(id, v);
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
    // Keep the newest half when over the cap: Map preserves insertion order, so
    // the oldest entries are simply the first ones out of the iterator.
    if (mem.size > MAX) {
      const drop = mem.size - Math.floor(MAX / 2);
      let i = 0;
      for (const k of mem.keys()) {
        if (i++ >= drop) break;
        mem.delete(k);
      }
    }
    const e = {};
    for (const [k, v] of mem) if (v) e[k] = v;
    localStorage.setItem(KEY, JSON.stringify({ db: threshold, e }));
  } catch {
    /* quota or private mode: the in-memory cache still works this session */
  }
}
function schedule() {
  dirty = true;
  if (flushTimer === null) flushTimer = setTimeout(flush, 4000);
}

// The threshold is part of the measurement, so changing it invalidates every
// answer we hold. Cheaper and far clearer than keying the cache by threshold
// and accumulating one set of bounds per value the user ever tried.
function ensureThreshold(db) {
  if (threshold === db) return;
  threshold = db;
  mem.clear();
  pending.clear();
  schedule();
}

/**
 * The bounds for a track, or null if they are not known (yet, or at all).
 * `db` is the threshold they must have been measured at: the threshold is part
 * of the measurement, so bounds from an older one describe a different
 * question and are no answer to this one.
 */
export function knownEdges(id, db) {
  if (db != null && threshold !== db) return null;
  return mem.get(String(id)) || null;
}

/**
 * Ask the server for a track's bounds, once. Fire-and-forget: the answer lands
 * in the cache for `knownEdges` to find. Returns the entry when it is already
 * known, so the caller can skip a round trip.
 */
export function primeEdges(id, db) {
  if (!id) return null;
  ensureThreshold(db);
  const key = String(id);
  if (mem.has(key)) return mem.get(key);
  if (pending.has(key)) return null;
  const p = api
    .audioEdges(key, db)
    .then((r) => {
      // `ready:false` means the file is not archived yet. Remember that as a
      // MISS rather than as "no trimming ever": the next play, once the archive
      // exists, should ask again.
      if (r && r.ready && r.end > r.start) {
        mem.set(key, {
          start: +r.start || 0,
          end: +r.end || 0,
          duration: +r.duration || 0,
        });
        schedule();
      }
    })
    .catch(() => {})
    .finally(() => pending.delete(key));
  pending.set(key, p);
  return null;
}

// Flush before the tab goes away — the 4 s debounce is otherwise lost on a
// track that was measured right at the end of a session.
if (typeof window !== "undefined") window.addEventListener("pagehide", flush);
