// On-device playback cache — ephemeral, LRU, size-capped.
//
// This is NOT the permanent downloads store (see offline.js). Its job is
// resilience: while a track plays, the NEXT track's audio (and cover) is
// prefetched here, so playback rides out a network drop and re-buffers are
// served locally. Everything is auto-managed — once the total goes over the
// cap, the least-recently-used entries are evicted. Audio and covers live in
// one IndexedDB database, keyed and byte-accounted separately.

import { get } from "svelte/store";
import { api } from "./api.js";
import {
  cachedIds,
  offlineCovers,
  playCacheLimit,
  playCacheSize,
} from "./stores.js";
import { isDownloaded } from "./offline.js";

const DB_NAME = "nsupy-playcache";
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio", { keyPath: "id" });
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
function done(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
function reqp(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Cover URLs we own in the shared `offlineCovers` map, so eviction only revokes
// ours (permanent-download covers are owned by offline.js).
const ownedCovers = new Set();
// Track ids whose prefetch is in flight, to dedupe concurrent triggers.
const inFlight = new Set();

// Load the index at startup: total size, cached-id set, and merge cover object
// URLs into the shared map (without clobbering permanent-download covers).
export async function initPlayCache() {
  try {
    const db = await openDB();
    const audio = await reqp(tx(db, "audio", "readonly").objectStore("audio").getAll());
    const covers = await reqp(tx(db, "covers", "readonly").objectStore("covers").getAll());
    let size = 0;
    const ids = new Set();
    for (const a of audio) {
      ids.add(a.id);
      size += a.size || 0;
    }
    const add = {};
    for (const c of covers) {
      size += c.size || 0;
      if (c.url && c.blob && !get(offlineCovers)[c.url]) {
        add[c.url] = URL.createObjectURL(c.blob);
        ownedCovers.add(c.url);
      }
    }
    cachedIds.set(ids);
    playCacheSize.set(size);
    if (Object.keys(add).length) offlineCovers.update((m) => ({ ...m, ...add }));
  } catch {
    /* IndexedDB unavailable — the cache just stays empty */
  }
}

export function isCached(id) {
  return get(cachedIds).has(String(id));
}

// Read a cached audio blob → object URL (caller revokes). Bumps LRU recency.
export async function getCachedAudioURL(id) {
  id = String(id);
  try {
    const db = await openDB();
    const rec = await reqp(tx(db, "audio", "readonly").objectStore("audio").get(id));
    if (!rec || !rec.blob) return null;
    // Best-effort recency bump (don't block playback on it).
    touchAudio(id).catch(() => {});
    return URL.createObjectURL(rec.blob);
  } catch {
    return null;
  }
}

async function touchAudio(id) {
  const db = await openDB();
  const t = tx(db, "audio", "readwrite");
  const store = t.objectStore("audio");
  const rec = await reqp(store.get(id));
  if (rec) {
    rec.ts = Date.now();
    store.put(rec);
  }
  await done(t);
}

// Prefetch a track's audio (+ cover) into the cache. Skips a track that's
// downloaded, already cached, or in flight. Best-effort and quiet.
export async function prefetchTrack(track, quality) {
  const id = track && track.deezer_id ? String(track.deezer_id) : null;
  if (!id || !/^\d+$/.test(id)) return; // Deezer ids only (local files are on disk)
  if (isDownloaded(id) || isCached(id) || inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const res = await fetch(api.streamUrl(id, quality), { credentials: "include" });
    if (!res.ok) return;
    const type = res.headers.get("Content-Type") || "audio/ogg";
    const blob = await res.blob();
    if (!blob || !blob.size) return;
    await putAudio(id, blob, quality, type);
    await cacheCover(track.album && track.album.cover, id);
    await enforce(get(playCacheLimit));
  } catch {
    /* network/decoding hiccup — a missed prefetch is harmless */
  } finally {
    inFlight.delete(id);
  }
}

async function putAudio(id, blob, quality, type) {
  const db = await openDB();
  const t = tx(db, "audio", "readwrite");
  t.objectStore("audio").put({ id, blob, size: blob.size, quality, type, ts: Date.now() });
  await done(t);
  cachedIds.update((s) => new Set(s).add(id));
  playCacheSize.update((n) => n + blob.size);
}

// Cache a cover (from the same-origin archived-cover route), unless a permanent
// download already provides it. Keyed by the remote URL the UI renders.
async function cacheCover(coverUrl, deezerId) {
  if (!coverUrl || get(offlineCovers)[coverUrl]) return;
  try {
    const res = await fetch(api.coverUrl(deezerId), { credentials: "include" });
    if (!res.ok) return;
    const blob = await res.blob();
    if (!blob || !blob.size) return;
    const db = await openDB();
    const t = tx(db, "covers", "readwrite");
    t.objectStore("covers").put({ url: coverUrl, blob, size: blob.size, ts: Date.now() });
    await done(t);
    playCacheSize.update((n) => n + blob.size);
    ownedCovers.add(coverUrl);
    offlineCovers.update((m) => ({ ...m, [coverUrl]: URL.createObjectURL(blob) }));
  } catch {
    /* best effort */
  }
}

// Evict least-recently-used entries (audio + covers) until under `limit` bytes.
export async function enforce(limit) {
  if (!limit || limit <= 0) return;
  try {
    const db = await openDB();
    const audio = await reqp(tx(db, "audio", "readonly").objectStore("audio").getAll());
    const covers = await reqp(tx(db, "covers", "readonly").objectStore("covers").getAll());
    let size =
      audio.reduce((n, a) => n + (a.size || 0), 0) +
      covers.reduce((n, c) => n + (c.size || 0), 0);
    if (size <= limit) return;
    // Oldest first, across both stores.
    const entries = [
      ...audio.map((a) => ({ kind: "audio", key: a.id, size: a.size || 0, ts: a.ts || 0 })),
      ...covers.map((c) => ({ kind: "cover", key: c.url, size: c.size || 0, ts: c.ts || 0 })),
    ].sort((a, b) => a.ts - b.ts);
    for (const e of entries) {
      if (size <= limit) break;
      await evictEntry(e);
      size -= e.size;
    }
  } catch {
    /* best effort */
  }
}

async function evictEntry(e) {
  const db = await openDB();
  if (e.kind === "audio") {
    const t = tx(db, "audio", "readwrite");
    t.objectStore("audio").delete(e.key);
    await done(t);
    cachedIds.update((s) => {
      const n = new Set(s);
      n.delete(e.key);
      return n;
    });
  } else {
    const t = tx(db, "covers", "readwrite");
    t.objectStore("covers").delete(e.key);
    await done(t);
    if (ownedCovers.has(e.key)) {
      ownedCovers.delete(e.key);
      offlineCovers.update((m) => {
        const n = { ...m };
        if (n[e.key]) {
          try {
            URL.revokeObjectURL(n[e.key]);
          } catch {
            /* ignore */
          }
          delete n[e.key];
        }
        return n;
      });
    }
  }
  playCacheSize.update((n) => Math.max(0, n - e.size));
}

// Wipe the whole playback cache (Settings action).
export async function clearPlayCache() {
  try {
    const db = await openDB();
    const t = tx(db, ["audio", "covers"], "readwrite");
    t.objectStore("audio").clear();
    t.objectStore("covers").clear();
    await done(t);
    cachedIds.set(new Set());
    playCacheSize.set(0);
    offlineCovers.update((m) => {
      const n = { ...m };
      for (const url of ownedCovers) {
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
    ownedCovers.clear();
    return true;
  } catch {
    return false;
  }
}
