// Thin wrapper around the Deezer-native /api backend.
// Session-cookie auth, so every request includes credentials.

import { get } from "svelte/store";
import { user } from "./stores.js";
import { online, reportOnline, reportOffline } from "./net.js";
import { isCacheable, cacheGet, cachePut } from "./apicache.js";

const BASE = "/api";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Exponential backoff with jitter, capped — enough to ride out a brief blip
// (lift, tunnel, wifi/cellular handover) without hammering the server.
const backoff = (attempt) =>
  Math.min(400 * 2 ** attempt, 6000) + Math.floor(Math.random() * 250);

// Transient server states worth retrying a GET on (a restart, a cold worker).
const TRANSIENT = new Set([502, 503, 504]);

// Notified when the server itself fails a call (5xx). The Deezer health watcher
// hooks in here to find out that the account credential died at the moment it
// breaks something, rather than at the next scheduled poll. Registered from the
// outside so this module keeps no dependency on it.
let serverErrorHook = null;
export function onServerError(fn) {
  serverErrorHook = fn;
}
function reportServerError(status, path) {
  if (!serverErrorHook) return;
  try {
    serverErrorHook(status, path);
  } catch {
    /* a diagnostic hook must never break the request that triggered it */
  }
}

// Refresh a cached GET in the background (stale-while-revalidate): if it
// succeeds we're back online and the cache gets the fresh copy for next time.
function refreshInBackground(path) {
  fetch(BASE + path, { credentials: "include" })
    .then(async (res) => {
      reportOnline(); // any response at all proves the server is reachable
      if (!res.ok) return;
      const data = await res.json();
      cachePut(path, data).catch(() => {});
    })
    .catch(() => {});
}

// `wasOnline` records whether we believed the network was up when the FIRST
// attempt started, and is threaded through the retries: a blip that began
// online gets the full backoff budget, but a request started while already
// known-offline fails fast (retrying into a dead network just burned ~12s per
// call — one per track change for lyrics, for instance).
async function req(path, opts = {}, attempt = 0, wasOnline = null) {
  if (wasOnline === null) wasOnline = get(online);
  const method = (opts.method || "GET").toUpperCase();
  // Only GETs are safe to auto-retry: replaying a POST/PUT/DELETE could double
  // a mutation. Mutations fail fast and let the optimistic UI roll back.
  const retriable = method === "GET";
  // Content GETs are mirrored to an offline cache so playlists/albums/etc. stay
  // browsable without a network.
  const cacheable = method === "GET" && isCacheable(path);

  // Known offline: serve the cached copy INSTANTLY (no fetch, no retries — the
  // old path burned ~12s of backoff before even looking at the cache), and
  // revalidate in the background so recovery is picked up without blocking.
  if (cacheable && !get(online)) {
    const cached = await cacheGet(path);
    if (cached != null) {
      refreshInBackground(path);
      return cached;
    }
  }

  let res;
  try {
    res = await fetch(BASE + path, {
      credentials: "include",
      ...opts,
      // Spread opts FIRST so its own `headers` (if any) can't clobber the merged
      // header object — then merge, letting a caller override individual headers.
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    });
  } catch (e) {
    // Network-level failure: offline, DNS, reset, CORS-less abort.
    reportOffline();
    // Serve the last cached copy right away rather than retrying into the void;
    // the next online request refreshes it.
    if (cacheable) {
      const cached = await cacheGet(path);
      if (cached != null) return cached;
    }
    // navigator.onLine === false is definitive (airplane mode): retries are
    // pointless, fail fast so the UI can settle into its offline state.
    const hardOffline = typeof navigator !== "undefined" && navigator.onLine === false;
    if (retriable && !hardOffline && wasOnline && attempt < 3) {
      await sleep(backoff(attempt));
      return req(path, opts, attempt + 1, wasOnline);
    }
    throw { status: 0, message: "network", offline: true };
  }

  // We reached the server — we're online (a 401/4xx still proves reachability).
  reportOnline();

  if (res.status === 401) {
    user.set(null);
    throw { status: 401, message: "unauthorized" };
  }
  if (!res.ok) {
    if (retriable && TRANSIENT.has(res.status) && attempt < 3) {
      await sleep(backoff(attempt));
      return req(path, opts, attempt + 1, true); // the server IS reachable
    }
    if (res.status >= 500) reportServerError(res.status, path);
    let message = res.statusText;
    try {
      message = (await res.json()).error || message;
    } catch {
      /* ignore */
    }
    throw { status: res.status, message };
  }
  if (res.status === 204) return null;
  const data = await res.json();
  // Refresh the offline cache with the fresh copy (fire-and-forget).
  if (cacheable) cachePut(path, data).catch(() => {});
  return data;
}

const body = (b) => (b === undefined ? undefined : JSON.stringify(b));

// The last cached copy of a content GET, read straight from disk with no
// network at all. Returns null when there's nothing cached (or the path isn't
// cacheable).
function peek(path) {
  if (!isCacheable(path)) return Promise.resolve(null);
  return cacheGet(path).catch(() => null);
}

// Stale-while-revalidate: paint the last-seen copy the instant it comes off
// disk, then again with the fresh one. This is what turns "the favorites show
// up in four seconds on a slow link" into "the favorites are already there and
// quietly correct themselves" — /me/favorites in particular costs the server
// two live Deezer round-trips, which no amount of client tuning can shorten.
//
// `onData(data, stale)` is called at most twice: once with the cached copy (only
// if it lands BEFORE the network does, and only if there is one), then once with
// the network copy. Returns the network promise, so callers still handle errors.
function swr(path, onData) {
  let fresh = false;
  peek(path).then((cached) => {
    if (cached != null && !fresh) onData(cached, true);
  });
  const p = req(path);
  p.then(
    (data) => {
      fresh = true;
      onData(data, false);
    },
    () => {
      fresh = true; // a late cache read must not overwrite an error state
    }
  );
  return p;
}

export const api = {
  peek,
  swr,
  // Raw cached GET, for callers that build their own path (the offline warmer).
  get: (path) => req(path),

  // auth
  login: (username, password) =>
    req("/login", { method: "POST", body: body({ username, password }) }),
  logout: () => req("/logout", { method: "POST" }),
  me: () => req("/me"),

  // discovery
  home: () => req("/home"),
  smartTracklist: (id) => req("/smarttracklist/" + id),
  flow: () => req("/flow"),
  flowClusters: () => req("/flow/clusters"),
  setFlowClusters: (clusters) =>
    req("/flow/clusters", { method: "POST", body: body({ clusters }) }),
  recommendations: () => req("/recommendations"),
  search: (q) => req("/search?q=" + encodeURIComponent(q)),

  // entities
  artist: (id) => req("/artist/" + id),
  artistTracks: (id) => req("/artist/" + id + "/tracks"),
  discography: (id) => req("/artist/" + id + "/discography"),
  album: (id) => req("/album/" + id),
  playlist: (id) => req("/playlist/" + id),
  lyrics: (id) => req("/lyrics/" + id),
  // ReplayGain for volume normalization; backfilled + cached server-side.
  trackGain: (id) => req("/gain/" + id),

  // radios
  trackRadio: (id) => req("/radio/track/" + id),
  artistRadio: (id) => req("/radio/artist/" + id),

  // podcasts
  podcasts: () => req("/podcasts"),
  podcast: (id) => req("/podcast/" + id),
  searchPodcasts: (q) => req("/search/podcasts?q=" + encodeURIComponent(q)),
  subscribePodcast: (url) =>
    req("/podcasts", { method: "POST", body: body({ url }) }),
  unsubscribePodcast: (id) => req("/podcast/" + id, { method: "DELETE" }),

  // podcasts — per-user progress & markers (server-side, follow you anywhere).
  // Saves are fire-and-forget (keepalive survives a page unload) — losing one
  // position tick must never surface as an error.
  podcastProgress: () => req("/podcast/progress"),
  savePodcastProgress: (episode_id, position, duration, finished = false) =>
    req("/podcast/progress", {
      method: "POST",
      keepalive: true,
      body: body({ episode_id, position, duration, finished }),
    }),
  showMarkers: (channelId) => req("/podcast/" + channelId + "/markers"),
  episodeMarkers: (episodeId) => req("/podcast/episode/" + episodeId + "/markers"),
  addMarker: (episodeId, position, label = null) =>
    req("/podcast/episode/" + episodeId + "/markers", {
      method: "POST",
      body: body({ position, label }),
    }),
  deleteMarker: (markerId) => req("/podcast/marker/" + markerId, { method: "DELETE" }),

  // sharing — waveform peaks + downloadable file/clip URLs (the server sets
  // Content-Disposition, so navigating to them downloads with a nice name).
  waveform: (id) => req("/share/waveform/" + id),
  shareFileUrl: (id, fmt = null) =>
    BASE + "/share/file/" + id + (fmt ? "?fmt=" + fmt : ""),
  shareClipUrl: (id, start, end, fmt = "mp3") =>
    BASE +
    "/share/clip/" +
    id +
    `?start=${(+start).toFixed(3)}&end=${(+end).toFixed(3)}&fmt=${fmt}`,

  // bulk export (whole playlist / album / favorites as one ZIP). The URL is
  // handed to the browser's download manager rather than fetched, so a
  // multi-gigabyte archive streams to disk instead of into memory.
  exportFormats: () => req("/export/formats"),
  exportUrl: (kind, id, fmt) =>
    BASE + "/export/" + kind + "/" + encodeURIComponent(id) + "?fmt=" + encodeURIComponent(fmt),

  // library
  myPlaylists: () => req("/me/playlists"),
  myFavorites: () => req("/me/favorites"),
  myLocal: () => req("/me/local"),
  favoriteIds: () => req("/me/favorite-ids"),

  // mutations
  favorite: (deezer_id, on) =>
    req("/favorite", { method: "POST", body: body({ deezer_id, on }) }),
  favoriteEntity: (kind, deezer_id, on) =>
    req("/favorite/" + kind, { method: "POST", body: body({ deezer_id, on }) }),
  createPlaylist: (title, tracks) =>
    req("/playlists", { method: "POST", body: body({ title, tracks }) }),
  editPlaylist: (id, fields) =>
    req("/playlist/" + id, { method: "PATCH", body: body(fields) }),
  deletePlaylist: (id) => req("/playlist/" + id, { method: "DELETE" }),
  addToPlaylist: (id, tracks) =>
    req("/playlist/" + id + "/tracks", { method: "POST", body: body({ tracks }) }),
  removeFromPlaylist: (id, tracks) =>
    req("/playlist/" + id + "/tracks", { method: "DELETE", body: body({ tracks }) }),
  removePlaylistIndexes: (id, indexes) =>
    req("/playlist/" + id + "/tracks", { method: "DELETE", body: body({ indexes }) }),
  reorderPlaylist: (id, tracks) =>
    req("/playlist/" + id + "/order", { method: "PUT", body: body({ tracks }) }),
  download: (ids) => req("/download", { method: "POST", body: body({ ids }) }),

  // manual Deezer refresh (admin) — kicks off a background sync, then poll status
  sync: () => req("/sync", { method: "POST" }),
  syncStatus: () => req("/sync/status"),

  // upload local audio files into the archive (multipart; let the browser set
  // the Content-Type/boundary, so this bypasses the JSON `req` helper).
  upload: async (files) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    const res = await fetch(BASE + "/upload", {
      method: "POST",
      credentials: "include",
      body: fd,
    });
    if (!res.ok)
      throw {
        status: res.status,
        message:
          res.status === 413
            ? "Fichiers trop volumineux (limite du serveur)"
            : "upload failed",
      };
    return res.json();
  },
  // Current user's upload usage + cap (bytes; quota 0 / unlimited => no limit).
  uploadUsage: () => req("/upload/usage"),

  // Admin-only server settings (upload quota, Deezer ARL).
  getSettings: () => req("/settings"),
  setSettings: (fields) => req("/settings", { method: "POST", body: body(fields) }),

  // Deezer account health — is the ARL still valid? `force` re-tests the login
  // instead of reading the cached verdict (admin only, server-side).
  deezerStatus: (force = false) => req("/deezer/status" + (force ? "?force=1" : "")),

  // Archive everything of mine that isn't on disk yet (favorites, playlists,
  // podcasts). Adds only — it can never delete an archived file.
  archiveBackfill: (scope = "all") =>
    req("/archive/backfill", { method: "POST", body: body({ scope }) }),
  archiveStatus: () => req("/archive/status"),
  // Admin: which events archive, how much of an artist to take, and the
  // cleanup policy (the only thing that can delete archived audio).
  archiveRules: () => req("/archive/rules"),
  setArchiveRules: (fields) =>
    req("/archive/rules", { method: "POST", body: body(fields) }),
  // What a cleanup would delete right now. Deletes nothing.
  cleanupPreview: () => req("/archive/cleanup/preview"),
  runCleanup: () => req("/archive/cleanup", { method: "POST" }),
  // Admin: what the archive costs and what's left of the disk.
  storage: () => req("/storage"),
  flushCache: () => req("/cache/flush", { method: "POST" }),

  // Availability & replacement. `probe` answers the question the <audio>
  // element can't: is this track dead, or was that just a bad moment?
  probeTrack: (id) => req("/track/" + id + "/probe"),
  unavailableTracks: () => req("/unavailable"),
  replacementCandidates: (id) => req("/replace/candidates/" + id),
  replaceTrack: (from, to) =>
    req("/replace", { method: "POST", body: body({ from, to }) }),
  replaceStatus: (job) => req("/replace/status/" + job),
  // Drop a track that exists neither on Deezer nor on disk. The server
  // re-checks both before it removes anything, and answers 409 if either one
  // still has it — "gone from Deezer" is not "gone".
  deleteTrack: (id) => req("/track/" + id, { method: "DELETE" }),

  // Build identity of the served app (+ the Android release it expects).
  version: () => req("/version"),

  // telemetry — fire-and-forget; never let it break playback. A no-op server
  // side unless report_listens is enabled in the config. Skipped entirely while
  // offline (a doomed POST per track change is just noise).
  reportListen: (payload) => {
    if (!get(online)) return Promise.resolve();
    return req("/listen", { method: "POST", keepalive: true, body: body(payload) }).catch(
      () => {}
    );
  },

  // playback (returned as a URL for the <audio> element)
  streamUrl: (id, quality) =>
    BASE + "/stream/" + id + (quality && quality !== "FLAC" ? "?q=" + quality : ""),

  // archived cover art (same-origin) for any track id — used to cache pochettes
  // for offline playback.
  coverUrl: (id) => BASE + "/cover/" + id,
};
