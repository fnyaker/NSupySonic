// On-device downloads for offline playback.
//
// These are PERMANENT, user-chosen downloads — not an evictable cache. Audio is
// stored as Blobs in IndexedDB (seekable, survives reloads) split across stores:
// `meta` (light — listed/sorted for the UI), `audio` (the heavy blob, read only
// on playback) and `covers` (art). A download is only ever removed by the user
// (per-track or "clear all"). The set of downloaded ids and total size are
// mirrored into Svelte stores at startup so the UI has instant state.
//
// In the Android app (bridge 5) the AUDIO lives in the app's storage instead
// (nativeoffline.js): `meta` and `covers` stay here, a record carries
// `native: true`, and the blobs downloaded before are moved there once.

import { get } from "svelte/store";
import { api } from "./api.js";
import { coverKey } from "./format.js";
import { blobDecodes } from "./imagebytes.js";
import { logInfo } from "./log.js";
import { online } from "./net.js";
import { primeGain } from "./gaincache.js";
import { migrateKey, trackKey, trackRef } from "./trackkey.js";
import { isYielding, trickle, whenClear } from "./netyield.js";
import {
  nativeAdopt,
  nativeClear,
  nativeDownload,
  nativeFree,
  nativeHas,
  nativeList,
  nativeOfflineAvailable,
  nativeOfflineUrl,
  nativeRemove,
} from "./nativeoffline.js";
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

// Downloads made before the app keyed on UUIDs sit in IndexedDB under their
// Deezer id. The index below answers to the UUID from the first moment (so an
// offline launch finds its music) and remembers where such a record really is
// until `migrateStoredKeys` has renamed it, which it does in the background.
const storedAs = new Map(); // key (uuid) -> the id on disk, while it differs
const diskId = (id) => storedAs.get(String(id)) ?? String(id);

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
    id: trackKey(t),
    deezer_id: t.deezer_id ? String(t.deezer_id) : null,
    title: t.title,
    duration: t.duration || 0,
    explicit: !!t.explicit,
    local: !!t.local,
    // Keep the ReplayGain so volume normalization still works offline.
    gain: typeof t.gain === "number" ? t.gain : null,
    artist: t.artist ? { id: t.artist.id, deezer_id: t.artist.deezer_id, name: t.artist.name } : null,
    // The full credit list, so a downloaded track still reads "A feat. B" in
    // airplane mode. Trimmed to the three fields the UI renders; records saved
    // before this existed simply fall back to `artist` (see format.js/credits).
    artists: Array.isArray(t.artists)
      ? t.artists.map((a) => ({ id: a.id, deezer_id: a.deezer_id, name: a.name, role: a.role }))
      : null,
    display_artist: t.display_artist || null,
    album: t.album
      ? { id: t.album.id, deezer_id: t.album.deezer_id, title: t.album.title, cover: t.album.cover }
      : null,
  };
}

// Populate the in-memory stores from IndexedDB. Call once at startup.
export async function loadOfflineIndex() {
  try {
    const db = await openDB();
    let metas = await reqp(tx(db, "meta", "readonly").objectStore("meta").getAll());
    if (nativeOfflineAvailable()) metas = await reconcileNative(db, metas);
    const ids = new Set();
    let size = 0;
    for (const m of metas) {
      const key = migrateKey(m.id);
      if (key !== m.id) storedAs.set(key, m.id);
      ids.add(key);
      size += m.size || 0;
    }
    downloads.set(ids);
    downloadsSize.set(size);
  } catch {
    /* IndexedDB unavailable (private mode?) — offline cache just stays empty */
  }
}

// The app's files against this index: a file nobody lists (its record was
// never written: the page went away mid-download) is dropped, and so is a
// record whose file is gone — it would claim a download that cannot play.
async function reconcileNative(db, metas) {
  const files = nativeList();
  const listed = new Set(metas.map((m) => String(m.id)));
  for (const f of files) if (!listed.has(String(f.id))) nativeRemove(f.id);
  const lost = metas.filter((m) => m.native && !nativeHas(m.id));
  if (!lost.length) return metas;
  const t = tx(db, "meta", "readwrite");
  for (const m of lost) t.objectStore("meta").delete(m.id);
  await done(t);
  logInfo("download", `${lost.length} download(s) whose file the app no longer has were forgotten`,
          null, { important: true });
  return metas.filter((m) => !lost.includes(m));
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
async function cacheCover(coverUrl, ref, background = false) {
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
    const res = await fetch(api.coverUrl(ref), {
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
    const id = m && ((m.track && (m.track.id || m.track.deezer_id)) || m.id);
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
  return reqp(tx(db, "meta", "readonly").objectStore("meta").get(diskId(id)));
}

export async function listDownloads() {
  const db = await openDB();
  const metas = await reqp(tx(db, "meta", "readonly").objectStore("meta").getAll());
  // Most recently played first.
  return metas.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
}

// Read the stored blob and hand back an object URL (caller revokes it).
export async function getObjectURL(id) {
  // Kept by the app: a URL it answers from the file (nothing to revoke).
  if (nativeHas(id)) return nativeOfflineUrl(id);
  const db = await openDB();
  const rec = await reqp(tx(db, "audio", "readonly").objectStore("audio").get(diskId(id)));
  if (!rec || !rec.blob) return null;
  return URL.createObjectURL(rec.blob);
}

// Bump last-played so LRU eviction keeps what you actually listen to.
export async function touch(id) {
  try {
    const db = await openDB();
    const t = tx(db, "meta", "readwrite");
    const store = t.objectStore("meta");
    const m = await reqp(store.get(diskId(id)));
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

// The body of a download, read so that it gives the link back while the player
// needs it (lib/netyield.js). A file the server can resume (an archived track:
// its length known, byte ranges served) steps aside ENTIRELY — the request
// aborted, nothing left in flight to compete with the track — and is picked up
// at the same byte once the link is free. A body that cannot be resumed (a live
// transcode) is read at a trickle instead. A connection that drops under a
// download (a phone changing networks) resumes too, rather than failing it.
async function fetchYielding(url, onProgress) {
  const chunks = [];
  let received = 0;
  let total = 0;
  let type = "audio/flac";
  let failures = 0;
  for (;;) {
    const headers = received ? { Range: `bytes=${received}-` } : {};
    const ctl = new AbortController();
    let res;
    try {
      res = await fetch(url, { credentials: "include", headers, signal: ctl.signal });
    } catch (e) {
      if (!received || ++failures > RESUMES) throw e;
      await whenClear();
      continue;
    }
    if (received) {
      const m = /^bytes (\d+)-/.exec(res.headers.get("Content-Range") || "");
      if (res.status !== 206 || !m || +m[1] !== received) {
        chunks.length = 0; // not a resume: the file starts again
        received = 0;
      }
    }
    if (!res.ok) throw new Error("stream " + res.status);
    if (!received) {
      total = +res.headers.get("Content-Length") || 0;
      type = res.headers.get("Content-Type") || type;
    }
    const resumable = total > 0 && /bytes/i.test(res.headers.get("Accept-Ranges") || "");
    if (!res.body || !res.body.getReader) {
      const b = await res.blob();
      return { blob: new Blob([...chunks, b], { type }) };
    }
    const reader = res.body.getReader();
    try {
      for (;;) {
        if (resumable && isYielding()) {
          ctl.abort();
          break;
        }
        const { done: rdone, value } = await reader.read();
        if (rdone) return { blob: new Blob(chunks, { type }) };
        chunks.push(value);
        received += value.length;
        if (onProgress) onProgress(total ? received / total : null);
        if (isYielding() && !resumable) await trickle(value.length);
      }
    } catch (e) {
      if (!received || ++failures > RESUMES) throw e;
    }
    await whenClear();
  }
}
const RESUMES = 3;

// Download `track` to the device at `quality` (e.g. "FLAC", "OPUS_320").
// Returns true on success. Idempotent: a track already stored is skipped.
export async function downloadTrack(track, quality, onProgress = null) {
  const id = trackKey(track);
  if (isDownloaded(id) || get(downloading).has(id)) return true;
  setDownloading(id, true);
  const t0 = Date.now();
  logInfo("download", `start ${id} "${track.title || ""}" q=${quality || "default"}`);
  try {
    // What is playing has the link: a download starts once it is free
    // (lib/netyield.js). The app's own downloads also wait on their side.
    await whenClear();
    if (nativeOfflineAvailable()) {
      const { size } = await nativeDownload(id, api.streamUrl(trackRef(track), quality), onProgress);
      await primeGain(track).catch(() => {});
      const db = await openDB();
      const t = tx(db, "meta", "readwrite");
      t.objectStore("meta").put({
        id,
        quality,
        size,
        native: true,
        track: slimTrack(track),
        addedAt: Date.now(),
        lastPlayedAt: Date.now(),
      });
      await done(t);
      downloads.update((s) => new Set(s).add(id));
      downloadsSize.update((n) => n + size);
      await cacheCover(track.album?.cover, trackRef(track));
      logInfo("download", `ok ${id} ${(size / 1048576).toFixed(1)} MB in ${Date.now() - t0}ms (app storage)`);
      return true;
    }
    const { blob } = await fetchYielding(api.streamUrl(trackRef(track), quality), onProgress);
    // An empty body is not a download: it would be listed, and never play.
    if (!blob.size) throw new Error("empty body");

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
    await cacheCover(track.album?.cover, trackRef(track));
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

export async function removeTrack(key) {
  const id = String(key);
  const at = diskId(id);
  try {
    const db = await openDB();
    const meta = await reqp(tx(db, "meta", "readonly").objectStore("meta").get(at));
    const t = tx(db, ["meta", "audio"], "readwrite");
    t.objectStore("meta").delete(at);
    t.objectStore("audio").delete(at);
    await done(t);
    nativeRemove(id);
    storedAs.delete(id);
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
    nativeClear();
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


// Rename, once, the records the app wrote when it still keyed on Deezer ids.
// Background work after the first screen: until a record is renamed the index
// above already finds it, so nothing waits on this. A key that already exists
// (the track was downloaded again since) wins, and the old record is dropped.
export async function migrateStoredKeys() {
  if (!storedAs.size) return 0;
  const db = await openDB();
  let moved = 0;
  for (const [key, old] of [...storedAs]) {
    const t = tx(db, ["meta", "audio"], "readwrite");
    const meta = t.objectStore("meta");
    const audio = t.objectStore("audio");
    const [m, a, mNew] = await Promise.all([
      reqp(meta.get(old)),
      reqp(audio.get(old)),
      reqp(meta.get(key)),
    ]);
    if (!mNew && m && a) {
      meta.put({ ...m, id: key, track: m.track ? { ...m.track, id: key } : m.track });
      audio.put({ ...a, id: key });
    }
    meta.delete(old);
    audio.delete(old);
    await done(t);
    storedAs.delete(key);
    moved++;
    // Between records: this is a courtesy to the frame, not a rate limit.
    await new Promise((r) => setTimeout(r, 0));
  }
  return moved;
}

// Move the downloads this page still holds as Blobs into the app's storage,
// once, in the background (after the key migration: the app's files are keyed
// on track UUIDs only). One at a time, a piece at a time; a record is switched
// to the app's copy only once the whole file is there, and its Blob dropped
// only then, so an interruption costs nothing but starting that file again.
// Stops, untouched, when the device lacks room for the next one.
let adopting = null;
export function moveDownloadsToApp() {
  if (!nativeOfflineAvailable()) return Promise.resolve(0);
  if (!adopting) adopting = adoptAll().finally(() => (adopting = null));
  return adopting;
}

async function adoptAll() {
  const db = await openDB();
  const metas = await reqp(tx(db, "meta", "readonly").objectStore("meta").getAll());
  let moved = 0;
  for (const m of metas) {
    if (m.native || storedAs.has(migrateKey(m.id)) || migrateKey(m.id) !== m.id) continue;
    const rec = await reqp(tx(db, "audio", "readonly").objectStore("audio").get(m.id));
    if (!rec || !rec.blob) continue;
    const free = nativeFree();
    if (free && free < rec.blob.size + 64 * 1048576) {
      logInfo("download", `moving downloads to the app paused: ${(free / 1048576).toFixed(0)} MB free`,
              null, { important: true });
      break;
    }
    try {
      await nativeAdopt(m.id, rec.blob);
    } catch (e) {
      logInfo("download", `could not move ${m.id} to the app: ${e && e.message}`, null, { important: true });
      break;
    }
    const t = tx(db, ["meta", "audio"], "readwrite");
    t.objectStore("meta").put({ ...m, native: true, size: rec.blob.size });
    t.objectStore("audio").delete(m.id);
    await done(t);
    moved++;
  }
  if (moved) logInfo("download", `${moved} download(s) moved to the app's storage`, null, { important: true });
  return moved;
}
