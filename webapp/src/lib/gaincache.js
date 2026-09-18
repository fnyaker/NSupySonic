// Per-track ReplayGain, cached on the device.
//
// Volume normalization is STATIC: the player picks a track's gain at the
// instant its source is swapped in and holds it for the whole track (see
// lib/audio/graph.js). A gain that arrives one request LATER is therefore not a
// late refinement — it is the volume changing in the middle of a song, which is
// exactly the artefact this module exists to remove.
//
// So the gain is treated like the audio and the artwork: fetched ahead, kept on
// the device, and looked up synchronously on the play path. A track played once
// never needs the network for its gain again, and the prefetch window is primed
// in ONE request (`POST /api/gains`) long before any of it starts playing.
//
// Values are tiny (a float per track), so the whole cache is mirrored in memory
// at startup and IndexedDB is only ever written to.

import { api } from "./api.js";
import { online } from "./net.js";
import { get } from "svelte/store";

const DB_NAME = "nsupy-gains";
const DB_VERSION = 1;
const STORE = "gains";
// A track that genuinely has no gain is remembered too — otherwise every replay
// re-asks — but not forever: Deezer fills these in over time, and re-testing a
// handful of tracks a week costs nothing.
const NULL_TTL = 7 * 24 * 60 * 60 * 1000;
// Bound one batch (the server caps it too). The player asks for its prefetch
// window plus what it is about to play, which is far below this.
const BATCH_MAX = 100;

let dbPromise = null;
// id -> { g: number|null, ts: number }. `undefined` from .get() means we have
// never asked about that track.
const mem = new Map();
let loaded = false;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqp(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const numericId = (x) => {
  const id = x == null ? "" : String(x);
  return /^\d+$/.test(id) ? id : null; // Deezer ids only (locals have no gain)
};

export async function initGainCache() {
  if (loaded) return;
  loaded = true;
  try {
    const db = await openDB();
    const all = await reqp(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
    const now = Date.now();
    for (const r of all) {
      if (!r || !r.id) continue;
      // Drop expired negatives on the way in, so they are re-asked once.
      if (r.g == null && now - (r.ts || 0) > NULL_TTL) continue;
      mem.set(String(r.id), { g: typeof r.g === "number" ? r.g : null, ts: r.ts || 0 });
    }
  } catch {
    /* IndexedDB unavailable — the cache just lives for this session */
  }
}

// Writes are batched: priming a ten-track window is one transaction, not ten.
let pending = new Map();
let flushTimer = null;
function persist(id, g) {
  pending.set(id, { id, g, ts: Date.now() });
  if (flushTimer !== null) return;
  flushTimer = setTimeout(flush, 250);
}
async function flush() {
  flushTimer = null;
  const batch = pending;
  pending = new Map();
  if (!batch.size) return;
  try {
    const db = await openDB();
    const t = db.transaction(STORE, "readwrite");
    const store = t.objectStore(STORE);
    for (const rec of batch.values()) store.put(rec);
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  } catch {
    /* best effort: the value stays in memory for this session */
  }
}

// What we know about a track's gain WITHOUT touching the network:
// a number, null (asked, genuinely none) or undefined (never asked).
export function knownGain(id) {
  const key = numericId(id);
  if (!key) return undefined;
  const rec = mem.get(key);
  if (!rec) return undefined;
  if (rec.g == null && Date.now() - rec.ts > NULL_TTL) return undefined;
  return rec.g;
}

export function rememberGain(id, gain) {
  const key = numericId(id);
  if (!key) return;
  const g = typeof gain === "number" && isFinite(gain) ? gain : null;
  const prev = mem.get(key);
  // Don't overwrite a real value with a null just because one answer missed it.
  if (prev && prev.g != null && g == null) return;
  // Already stored, unchanged: no write. The play path re-offers the values it
  // reads on every window move, and those must not each cost a disk write.
  // (A null always writes: its timestamp is what schedules the re-test.)
  if (prev && prev.g === g && g != null) return;
  mem.set(key, { g, ts: Date.now() });
  persist(key, g);
}

// The gain to apply for a track, synchronously: the value the API sent with the
// track when it had one, else whatever the cache learned. `undefined`/null both
// mean "not normalized", which is what the player does with an unknown gain.
export function gainFor(track) {
  if (!track) return null;
  if (typeof track.gain === "number") return track.gain;
  const g = knownGain(track.deezer_id);
  return typeof g === "number" ? g : null;
}

// Ids whose gain is in flight, so two overlapping primes don't ask twice.
const inFlight = new Set();

// Make sure we know the gain of every one of these tracks — one request for the
// lot. Caches onto the track objects themselves as well (the queue holds them,
// so the play path finds the value with no lookup at all).
export async function primeGains(tracks) {
  const list = (tracks || []).filter(Boolean);
  if (!list.length) return;
  const wanted = [];
  for (const t of list) {
    const id = numericId(t.deezer_id);
    if (!id) continue;
    if (typeof t.gain === "number") {
      rememberGain(id, t.gain); // the list already knew: keep it for next time
      continue;
    }
    const known = knownGain(id);
    if (known !== undefined) {
      if (typeof known === "number") t.gain = known;
      continue;
    }
    if (inFlight.has(id) || wanted.includes(id)) continue;
    wanted.push(id);
    if (wanted.length >= BATCH_MAX) break;
  }
  if (!wanted.length || !get(online)) return;
  wanted.forEach((id) => inFlight.add(id));
  try {
    const r = await api.trackGains(wanted);
    const gains = (r && r.gains) || {};
    for (const id of wanted) {
      const g = gains[id];
      // A null answer is cached too: "this track has no gain" is an answer, and
      // re-asking on every play is what made this a per-track request.
      rememberGain(id, typeof g === "number" ? g : null);
    }
    for (const t of list) {
      const id = numericId(t.deezer_id);
      if (!id || typeof t.gain === "number") continue;
      const g = knownGain(id);
      if (typeof g === "number") t.gain = g;
    }
  } catch {
    /* offline or server hiccup: the tracks simply aren't normalized this time */
  } finally {
    wanted.forEach((id) => inFlight.delete(id));
  }
}

// One track, on the paths that only have one (a fresh play, an archive/download
// that should carry its gain with the audio file).
export function primeGain(track) {
  return primeGains([track]);
}
