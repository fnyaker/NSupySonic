// On-device downloads for offline playback.
//
// These are PERMANENT, user-chosen downloads — not an evictable cache. Audio is
// stored as Blobs in IndexedDB (seekable, survives reloads) split across stores:
// `meta` (light — listed/sorted for the UI), `audio` (the heavy blob, read only
// on playback) and `covers` (art). A download is only ever removed by the user
// (per-track or "clear all"). The set of downloaded ids and total size are
// mirrored into Svelte stores at startup so the UI has instant state.

import { get } from "svelte/store";
import { api } from "./api.js";
import {
  downloads,
  downloadsSize,
  downloading,
  offlineCovers,
} from "./stores.js";

const DB_NAME = "nsupy-offline";
const DB_VERSION = 2;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
      if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio", { keyPath: "id" });
      // v2: cover art blobs, keyed by the remote cover URL the UI renders.
      if (!db.objectStoreNames.contains("covers")) db.createObjectStore("covers", { keyPath: "url" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, stores, mode) {
  return db.transaction(stores, mode);
}
function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
function reqp(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// A compact, offline-displayable copy of the track metadata.
function slimTrack(t) {
  return {
    deezer_id: String(t.deezer_id),
    title: t.title,
    duration: t.duration || 0,
    explicit: !!t.explicit,
    local: !!t.local,
    artist: t.artist ? { deezer_id: t.artist.deezer_id, name: t.artist.name } : null,
    album: t.album
      ? { deezer_id: t.album.deezer_id, title: t.album.title, cover: t.album.cover }
      : null,
  };
}

// Populate the in-memory stores from IndexedDB. Call once at startup.
export async function loadOfflineIndex() {
  try {
    const db = await openDB();
    const metas = await reqp(tx(db, "meta", "readonly").objectStore("meta").getAll());
    const ids = new Set();
    let size = 0;
    for (const m of metas) {
      ids.add(m.id);
      size += m.size || 0;
    }
    downloads.set(ids);
    downloadsSize.set(size);
  } catch {
    /* IndexedDB unavailable (private mode?) — offline cache just stays empty */
  }
}

export function isDownloaded(id) {
  return get(downloads).has(String(id));
}

// -- offline cover art ------------------------------------------------------
// Covers are archived on the server (embedded in the audio file). When a track
// is downloaded we also fetch its archived cover (same-origin /api/cover/<id>,
// no CDN/CORS) and store the blob keyed by the remote URL the UI renders, so
// pochettes show in airplane mode. The URL->objectURL map is mirrored into a
// store at startup for synchronous, no-flicker rendering in Cover.svelte.

// Build object URLs for every cached cover and publish them. Call once at start.
export async function loadCoverCache() {
  try {
    const db = await openDB();
    const rows = await reqp(tx(db, "covers", "readonly").objectStore("covers").getAll());
    const map = {};
    for (const r of rows) {
      if (r && r.url && r.blob) map[r.url] = URL.createObjectURL(r.blob);
    }
    // Merge (don't clobber) — the playback cache also feeds this map.
    offlineCovers.update((m) => ({ ...map, ...m }));
  } catch {
    /* IndexedDB unavailable — covers just fall back to the network URL */
  }
}

// Download + store the archived cover for a track (best-effort, idempotent).
async function cacheCover(coverUrl, deezerId) {
  if (!coverUrl) return;
  if (get(offlineCovers)[coverUrl]) return; // already cached this session
  try {
    const db = await openDB();
    const existing = await reqp(
      tx(db, "covers", "readonly").objectStore("covers").get(coverUrl)
    );
    if (existing && existing.blob) {
      offlineCovers.update((m) => ({ ...m, [coverUrl]: URL.createObjectURL(existing.blob) }));
      return;
    }
    const res = await fetch(api.coverUrl(deezerId), { credentials: "include" });
    if (!res.ok) return;
    const blob = await res.blob();
    if (!blob || !blob.size) return;
    const t = tx(db, "covers", "readwrite");
    t.objectStore("covers").put({ url: coverUrl, blob });
    await done(t);
    offlineCovers.update((m) => ({ ...m, [coverUrl]: URL.createObjectURL(blob) }));
  } catch {
    /* best effort — a missing cover never fails the download */
  }
}

// Drop a cover blob + its object URL if no remaining download still uses it.
async function gcCover(coverUrl) {
  if (!coverUrl) return;
  try {
    const db = await openDB();
    const metas = await reqp(tx(db, "meta", "readonly").objectStore("meta").getAll());
    if (metas.some((m) => m.track?.album?.cover === coverUrl)) return; // still used
    const t = tx(db, "covers", "readwrite");
    t.objectStore("covers").delete(coverUrl);
    await done(t);
    offlineCovers.update((m) => {
      const n = { ...m };
      if (n[coverUrl]) {
        try {
          URL.revokeObjectURL(n[coverUrl]);
        } catch {
          /* ignore */
        }
        delete n[coverUrl];
      }
      return n;
    });
  } catch {
    /* best effort */
  }
}

export async function getMeta(id) {
  const db = await openDB();
  return reqp(tx(db, "meta", "readonly").objectStore("meta").get(String(id)));
}

export async function listDownloads() {
  const db = await openDB();
  const metas = await reqp(tx(db, "meta", "readonly").objectStore("meta").getAll());
  // Most recently played first.
  return metas.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
}

// Read the stored blob and hand back an object URL (caller revokes it).
export async function getObjectURL(id) {
  const db = await openDB();
  const rec = await reqp(tx(db, "audio", "readonly").objectStore("audio").get(String(id)));
  if (!rec || !rec.blob) return null;
  return URL.createObjectURL(rec.blob);
}

// Bump last-played so LRU eviction keeps what you actually listen to.
export async function touch(id) {
  try {
    const db = await openDB();
    const t = tx(db, "meta", "readwrite");
    const store = t.objectStore("meta");
    const m = await reqp(store.get(String(id)));
    if (m) {
      m.lastPlayedAt = Date.now();
      store.put(m);
    }
    await done(t);
  } catch {
    /* best effort */
  }
}

function setDownloading(id, on) {
  downloading.update((s) => {
    const n = new Set(s);
    if (on) n.add(String(id));
    else n.delete(String(id));
    return n;
  });
}

// Download `track` to the device at `quality` (e.g. "FLAC", "OPUS_320").
// Returns true on success. Idempotent: a track already stored is skipped.
export async function downloadTrack(track, quality, onProgress = null) {
  const id = String(track.deezer_id);
  if (isDownloaded(id) || get(downloading).has(id)) return true;
  setDownloading(id, true);
  try {
    const res = await fetch(api.streamUrl(id, quality), { credentials: "include" });
    if (!res.ok) throw new Error("stream " + res.status);

    // Stream the body so we can report progress (live transcodes have no
    // Content-Length, so progress is indeterminate then).
    const total = +res.headers.get("Content-Length") || 0;
    const type = res.headers.get("Content-Type") || "audio/flac";
    let blob;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done: rdone, value } = await reader.read();
        if (rdone) break;
        chunks.push(value);
        received += value.length;
        if (onProgress) onProgress(total ? received / total : null);
      }
      blob = new Blob(chunks, { type });
    } else {
      blob = await res.blob();
    }

    const db = await openDB();
    const t = tx(db, ["meta", "audio"], "readwrite");
    t.objectStore("audio").put({ id, blob });
    t.objectStore("meta").put({
      id,
      quality,
      size: blob.size,
      track: slimTrack(track),
      addedAt: Date.now(),
      lastPlayedAt: Date.now(),
    });
    await done(t);

    downloads.update((s) => new Set(s).add(id));
    downloadsSize.update((n) => n + blob.size);
    // Also cache the archived cover so the pochette shows offline.
    await cacheCover(track.album?.cover, id);
    return true;
  } catch (e) {
    return false;
  } finally {
    setDownloading(id, false);
  }
}

export async function removeTrack(id) {
  id = String(id);
  try {
    const db = await openDB();
    const meta = await reqp(tx(db, "meta", "readonly").objectStore("meta").get(id));
    const t = tx(db, ["meta", "audio"], "readwrite");
    t.objectStore("meta").delete(id);
    t.objectStore("audio").delete(id);
    await done(t);
    downloads.update((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    if (meta) downloadsSize.update((n) => Math.max(0, n - (meta.size || 0)));
    await gcCover(meta?.track?.album?.cover); // drop the cover if now unused
    return true;
  } catch {
    return false;
  }
}

export async function clearAll() {
  try {
    const db = await openDB();
    // Grab our cover URLs first so we only revoke OUR entries in the shared map
    // (the playback cache owns its own covers there).
    const coverRows = await reqp(tx(db, "covers", "readonly").objectStore("covers").getAll());
    const urls = coverRows.map((r) => r.url).filter(Boolean);
    const t = tx(db, ["meta", "audio", "covers"], "readwrite");
    t.objectStore("meta").clear();
    t.objectStore("audio").clear();
    t.objectStore("covers").clear();
    await done(t);
    downloads.set(new Set());
    downloadsSize.set(0);
    offlineCovers.update((m) => {
      const n = { ...m };
      for (const url of urls) {
        if (n[url]) {
          try {
            URL.revokeObjectURL(n[url]);
          } catch {
            /* ignore */
          }
          delete n[url];
        }
      }
      return n;
    });
    return true;
  } catch {
    return false;
  }
}

