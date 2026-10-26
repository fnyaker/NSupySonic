// Offline metadata cache for GET responses (playlists, their tracks, albums,
// artists, mixes…). It is a pure fallback: online, requests always hit the
// network and refresh the cache; only when the network fails do we serve the
// last-seen response, so a playlist and its tracklist stay browsable offline
// (and whatever was downloaded from it plays). Stored in IndexedDB (larger,
// quota-safe) rather than localStorage — track lists can be big.

import { REMOTE } from "./remote/mode.js";

const DB_NAME = "nsupy-apicache";
const DB_VERSION = 1;
const MAX_ENTRIES = 400; // prune oldest beyond this
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("responses"))
        db.createObjectStore("responses", { keyPath: "path" });
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

// GET-response paths worth keeping for offline browsing (matched on the path,
// query stripped). Deliberately excludes dynamic/large/streaming endpoints.
const CACHE_PREFIXES = [
  "/me/playlists",
  "/me/favorites",
  "/me/favorite-ids",
  "/me/local",
  "/playlist/",
  "/album/",
  "/artist/",
  "/home/mix/",
  "/home",
  // Lyrics are fetched on every track change — caching them makes the Paroles
  // panel work offline and skips the doomed refetch for known tracks.
  "/lyrics/",
  // A person's credits page (who wrote, composed, produced what).
  "/credits/person",
];

// A track's credits (the full-screen player's panel, the track menu's sheet):
// small, asked again on every visit, and worth having on the device offline.
const CREDITS = /^\/track\/[^/]+\/credits$/;

export function isCacheable(path) {
  // A remote control reads somebody else's library: never into this device's
  // offline copy of its own.
  if (REMOTE) return false;
  const p = String(path).split("?")[0];
  return CREDITS.test(p) || CACHE_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

// A record holds the response's JSON TEXT (`text`), or — written by an older
// build — the parsed object (`data`). See cachePut for why text.
export function decode(rec) {
  if (!rec) return null;
  if (typeof rec.text === "string") {
    try {
      return JSON.parse(rec.text);
    } catch {
      return null;
    }
  }
  return rec.data ?? null;
}

export async function cacheGet(path) {
  try {
    const db = await openDB();
    const rec = await reqp(
      db.transaction("responses", "readonly").objectStore("responses").get(path)
    );
    return decode(rec);
  } catch {
    return null;
  }
}

// Age in ms of a cached entry, or Infinity when there isn't one. Used by the
// background warmer to skip what it refreshed recently.
export async function cacheAge(path) {
  try {
    const db = await openDB();
    const rec = await reqp(
      db.transaction("responses", "readonly").objectStore("responses").get(path)
    );
    return rec && rec.ts ? Date.now() - rec.ts : Infinity;
  } catch {
    return Infinity;
  }
}

// `text` is the response body as it came off the wire. Storing it, rather than
// the parsed object, is what keeps this off the main thread's bill: IndexedDB
// structured-clones what it is given, SYNCHRONOUSLY, and a 4000-track list is
// 4000 nested objects — 17-24 ms of cloning on every visit to the favourites
// or a big playlist, measured, against a single string copy. Reading pays one
// JSON.parse instead of the clone it replaces.
//
// A page of the library read under a provider id (`/album/2000000`: an older
// build's link, a catalogue card) is also kept under its row's own id, which is
// what every link opens it by now — so what was browsed before still opens
// offline.
const BY_PROVIDER_ID = /^\/(album|artist)\/[0-9]+$/;
export function aliasPath(path, body) {
  const m = BY_PROVIDER_ID.exec(String(path).split("?")[0]);
  if (!m) return null;
  let data = body;
  if (typeof body === "string") {
    try {
      data = JSON.parse(body);
    } catch {
      return null;
    }
  }
  const id = data && data[m[1]] && data[m[1]].id;
  return id ? `/${m[1]}/${id}` : null;
}

export async function cachePut(path, data, text = null) {
  try {
    const db = await openDB();
    const t = db.transaction("responses", "readwrite");
    const body = typeof text === "string" ? text : JSON.stringify(data ?? null);
    const ts = Date.now();
    t.objectStore("responses").put({ path, text: body, ts });
    const alias = aliasPath(path, body);
    if (alias) t.objectStore("responses").put({ path: alias, text: body, ts });
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
    prune().catch(() => {});
  } catch {
    /* best effort */
  }
}

// Keep the cache bounded: drop the oldest entries past MAX_ENTRIES. Guarded by
// a cheap count() so the (heavy) getAll only runs when actually over the cap —
// this runs after every cached GET, so it must cost ~nothing in the usual case.
async function prune() {
  const db = await openDB();
  const count = await reqp(
    db.transaction("responses", "readonly").objectStore("responses").count()
  );
  if (count <= MAX_ENTRIES) return;
  const all = await reqp(
    db.transaction("responses", "readonly").objectStore("responses").getAll()
  );
  const doomed = all
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .slice(0, all.length - MAX_ENTRIES);
  const t = db.transaction("responses", "readwrite");
  const store = t.objectStore("responses");
  for (const r of doomed) store.delete(r.path);
}
