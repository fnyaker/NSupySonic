// On-device download cache for offline playback.
//
// Audio is stored as Blobs in IndexedDB (seekable, size-accountable, survives
// reloads) split across two stores: `meta` (light — listed/sorted for the UI and
// LRU eviction) and `audio` (the heavy blob, read only on playback). The set of
// downloaded ids and the total size are mirrored into Svelte stores at startup
// so the UI has instant state without touching IndexedDB on every render.

import { get } from "svelte/store";
import { api } from "./api.js";
import {
  cacheLimit,
  downloads,
  downloadsSize,
  downloading,
} from "./stores.js";

const DB_NAME = "nsupy-offline";
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
      if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio", { keyPath: "id" });
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
    await enforceQuota(get(cacheLimit));
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
    return true;
  } catch {
    return false;
  }
}

export async function clearAll() {
  try {
    const db = await openDB();
    const t = tx(db, ["meta", "audio"], "readwrite");
    t.objectStore("meta").clear();
    t.objectStore("audio").clear();
    await done(t);
    downloads.set(new Set());
    downloadsSize.set(0);
    return true;
  } catch {
    return false;
  }
}

// Evict least-recently-played downloads until we're under `limit` bytes. Never
// removes a track that's currently downloading (it isn't stored yet anyway).
export async function enforceQuota(limit) {
  if (!limit || limit <= 0) return;
  try {
    let metas = await listDownloads(); // newest first
    let size = metas.reduce((n, m) => n + (m.size || 0), 0);
    if (size <= limit) return;
    // Oldest first for eviction.
    metas = metas.reverse();
    for (const m of metas) {
      if (size <= limit) break;
      await removeTrack(m.id);
      size -= m.size || 0;
    }
  } catch {
    /* best effort */
  }
}
