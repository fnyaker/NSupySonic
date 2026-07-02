// Offline metadata cache for GET responses (playlists, their tracks, albums,
// artists, mixes…). It is a pure fallback: online, requests always hit the
// network and refresh the cache; only when the network fails do we serve the
// last-seen response, so a playlist and its tracklist stay browsable offline
// (and whatever was downloaded from it plays). Stored in IndexedDB (larger,
// quota-safe) rather than localStorage — track lists can be big.

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
  "/smarttracklist/",
  "/home",
  "/recommendations",
];

export function isCacheable(path) {
  const p = String(path).split("?")[0];
  return CACHE_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

export async function cacheGet(path) {
  try {
    const db = await openDB();
    const rec = await reqp(
      db.transaction("responses", "readonly").objectStore("responses").get(path)
    );
    return rec ? rec.data : null;
  } catch {
    return null;
  }
}

export async function cachePut(path, data) {
  try {
    const db = await openDB();
    const t = db.transaction("responses", "readwrite");
    t.objectStore("responses").put({ path, data, ts: Date.now() });
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
