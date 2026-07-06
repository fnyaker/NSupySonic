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
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
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

// Serialize an optional { offset, limit } paging spec into a query string.
function _page(opts) {
  if (!opts || opts.limit == null) return "";
  const off = opts.offset || 0;
  return `?offset=${off}&limit=${opts.limit}`;
}

export const api = {
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
  discography: (id) => req("/artist/" + id + "/discography"),
  album: (id) => req("/album/" + id),
  // Optional { offset, limit } for progressive loading; omit for the full list
  // (play / download / offline still get every track).
  playlist: (id, opts) => req("/playlist/" + id + _page(opts)),
  lyrics: (id) => req("/lyrics/" + id),

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

  // library
  myPlaylists: () => req("/me/playlists"),
  myFavorites: (opts) => req("/me/favorites" + _page(opts)),
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
