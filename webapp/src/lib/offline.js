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
import { coverKey } from "./format.js";
import { blobDecodes } from "./imagebytes.js";
import { logInfo } from "./log.js";
import { online } from "./net.js";
import { primeGain } from "./gaincache.js";
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
    // Keep the ReplayGain so volume normalization still works offline.
    gain: typeof t.gain === "number" ? t.gain : null,
    artist: t.artist ? { deezer_id: t.artist.deezer_id, name: t.artist.name } : null,
    // The full credit list, so a downloaded track still reads "A feat. B" in
    // airplane mode. Trimmed to the three fields the UI renders; records saved
    // before this existed simply fall back to `artist` (see format.js/credits).
    artists: Array.isArray(t.artists)
      ? t.artists.map((a) => ({ deezer_id: a.deezer_id, name: a.name, role: a.role }))
      : null,
    display_artist: t.display_artist || null,
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
    // Merge (don't clobber) — the playback cache also feeds this map, and it
    // loads first. Skip the keys it already owns instead of minting object URLs
    // the merge would then discard: those were never revoked, so every cover
    // present in BOTH stores leaked its blob for the whole session.
    const have = get(offlineCovers);
    const map = {};
    for (const r of rows) {
      if (!r || !r.url || !r.blob) continue;
      const key = coverKey(r.url);
      if (have[key] || map[key]) continue;
      map[key] = URL.createObjectURL(r.blob);
    }
    if (Object.keys(map).length) offlineCovers.update((m) => ({ ...map, ...m }));
    scheduleCoverRepair(rows);
  } catch {
    /* IndexedDB unavailable — covers just fall back to the network URL */
  }
}

// Download + store the archived cover for a track (best-effort, idempotent).
// Resolves true when this store holds the art afterwards.
//
// A download keeps its OWN copy, whoever else has one: the play cache's copy
// of the same art is evictable, and a download's pochette is the one that has
// to still be there in airplane mode a month later. (This used to return as
// soon as ANY copy was on screen, so a track downloaded after being played
// never stored its art at all.)
async function cacheCover(coverUrl, deezerId, background = false) {
  if (!coverUrl) return false;
  const key = coverKey(coverUrl);
  // Publish only when nothing shows this art yet: swapping a live object URL
  // for another of the same picture re-renders every Cover showing it.
  const publish = (blob) => {
    if (!get(offlineCovers)[key])
      offlineCovers.update((m) => ({ ...m, [key]: URL.createObjectURL(blob) }));
  };
  try {
    const db = await openDB();
    const existing = await reqp(
      tx(db, "covers", "readonly").objectStore("covers").get(coverUrl)
    );
    if (existing && existing.blob) {
      publish(existing.blob);
      return true;
    }
    const res = await fetch(api.coverUrl(deezerId), {
      credentials: "include",
      headers: background ? { "X-NS-Background": "1" } : {},
    });
    if (!res.ok) return false;
    const blob = await res.blob();
    if (!blob || !blob.size) return false;
    const t = tx(db, "covers", "readwrite");
    t.objectStore("covers").put({ url: coverUrl, blob });
    await done(t);
    publish(blob);
    return true;
  } catch {
    /* best effort — a missing cover never fails the download */
    return false;
  }
}

// Put back the pochette of every download that has lost it.
//
// Until the server's policy allowed blob: images, every downloaded cover the
// app tried to show was refused, read as corrupt, and DELETED — so a library
// downloaded for the plane lost its art one screen at a time, and nothing ever
// fetched it again (a cover is only stored at download time). This finds each
// download whose art has no row here and fetches it once, in the background.
// It costs nothing when nothing is missing: one read of the metadata, which the
// launch has just done anyway.
//
// Sequential, marked as background (the server holds those to a share of its
// threads) and started a while after launch, so it never competes with the
// first screen; it stops the moment the device goes offline.
const REPAIR_DELAY_MS = 20000;
let repairScheduled = false;
function scheduleCoverRepair(rows) {
  if (repairScheduled || typeof setTimeout !== "function") return;
  repairScheduled = true;
  const have = new Set();
  for (const r of rows) if (r && r.url && r.blob) have.add(coverKey(r.url));
  setTimeout(() => {
    // Offline at the time: wait for the network instead of trying past it.
    if (get(online)) repairMissingCovers(have).catch(() => {});
    else {
      const stop = online.subscribe((up) => {
        if (!up) return;
        queueMicrotask(() => stop());
        repairMissingCovers(have).catch(() => {});
      });
    }
  }, REPAIR_DELAY_MS);
}

export async function repairMissingCovers(have) {
  const db = await openDB();
  const metas = await reqp(tx(db, "meta", "readonly").objectStore("meta").getAll());
  const todo = new Map(); // key -> [cover url, id]; one fetch per distinct art
  for (const m of metas) {
    const url = m && m.track && m.track.album && m.track.album.cover;
    const id = m && ((m.track && m.track.deezer_id) || m.id);
    if (!url || !id) continue;
    const key = coverKey(url);
    if (!have.has(key) && !todo.has(key)) todo.set(key, [url, id]);
  }
  if (!todo.size) return { missing: 0, repaired: 0 };
  logInfo("download", `${todo.size} downloaded cover(s) missing — fetching them back`, null,
          { important: true });
  let repaired = 0;
  for (const [key, [url, id]] of todo) {
    if (!get(online)) break;
    if (await cacheCover(url, id, true)) {
      repaired++;
      have.add(key);
    }
  }
  logInfo("download", `covers repaired: ${repaired} of ${todo.size}`, null, { important: true });
  return { missing: todo.size, repaired };
}

// Drop a DOCUMENT-cover blob that turned out not to decode (see the sibling in
// playcache.js): a stored blob that won't decode must not be re-offered forever.
// A download's cover is the one copy that works in airplane mode, so it goes
// only if its bytes really do not decode — never because a page refused it.
export async function forgetDownloadedCover(coverUrl) {
  if (!coverUrl) return false;
  const key = coverKey(coverUrl);
  try {
    const db = await openDB();
    // Canonical key again: the row is stored under the 500px URL while a caller
    // may hold the 1000px one.
    const rows = (
      await reqp(tx(db, "covers", "readonly").objectStore("covers").getAll())
    ).filter((row) => coverKey(row.url) === key);
    let kept = false;
    const bad = [];
    for (const row of rows) {
      if (await blobDecodes(row.blob)) kept = true;
      else bad.push(row.url);
    }
    if (bad.length) {
      const t = tx(db, "covers", "readwrite");
      for (const url of bad) t.objectStore("covers").delete(url);
      await done(t);
    }
    if (kept) return false;
  } catch {
    /* best effort */
  }
  let had = false;
  offlineCovers.update((m) => {
    const n = { ...m };
    if (n[key]) {
      had = true;
      try {
        URL.revokeObjectURL(n[key]);
      } catch {
        /* ignore */
      }
      delete n[key];
    }
    return n;
  });
  return had;
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
    const key = coverKey(coverUrl);
    offlineCovers.update((m) => {
      const n = { ...m };
      if (n[key]) {
        try {
          URL.revokeObjectURL(n[key]);
        } catch {
          /* ignore */
        }
        delete n[key];
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
  const t0 = Date.now();
  logInfo("download", `start ${id} "${track.title || ""}" q=${quality || "default"}`);
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

    // Learn the ReplayGain now, so it is stored WITH the file: a downloaded
    // track must never ask the network how loud it is when it starts — offline
    // it couldn't, and online it would be a volume change mid-song. A no-op
    // when the gain is already known or cached (the usual case).
    await primeGain(track).catch(() => {});

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
    logInfo("download", `ok ${id} ${(blob.size / 1048576).toFixed(1)} MB in ${Date.now() - t0}ms`);
    return true;
  } catch (e) {
    // This is the line that was missing: a download that fails only ever
    // surfaced as a toast, so nothing about WHY reached the log.
    logInfo("download", `FAILED ${id} after ${Date.now() - t0}ms: ${e && e.name === "QuotaExceededError" ? "device storage full" : String(e && e.message || e)}`,
            null, { important: true });
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
    const keys = coverRows.map((r) => coverKey(r.url)).filter(Boolean);
    const t = tx(db, ["meta", "audio", "covers"], "readwrite");
    t.objectStore("meta").clear();
    t.objectStore("audio").clear();
    t.objectStore("covers").clear();
    await done(t);
    downloads.set(new Set());
    downloadsSize.set(0);
    offlineCovers.update((m) => {
      const n = { ...m };
      for (const key of keys) {
        if (n[key]) {
          try {
            URL.revokeObjectURL(n[key]);
          } catch {
            /* ignore */
          }
          delete n[key];
        }
      }
      return n;
    });
    return true;
  } catch {
    return false;
  }
}

