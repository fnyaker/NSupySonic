// Thin wrapper around the Deezer-native /api backend.
// Session-cookie auth, so every request includes credentials.

import { user } from "./stores.js";
import { reportOnline, reportOffline } from "./net.js";

const BASE = "/api";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Exponential backoff with jitter, capped — enough to ride out a brief blip
// (lift, tunnel, wifi/cellular handover) without hammering the server.
const backoff = (attempt) =>
  Math.min(400 * 2 ** attempt, 6000) + Math.floor(Math.random() * 250);

// Transient server states worth retrying a GET on (a restart, a cold worker).
const TRANSIENT = new Set([502, 503, 504]);

async function req(path, opts = {}, attempt = 0) {
  const method = (opts.method || "GET").toUpperCase();
  // Only GETs are safe to auto-retry: replaying a POST/PUT/DELETE could double
  // a mutation. Mutations fail fast and let the optimistic UI roll back.
  const retriable = method === "GET";

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
    if (retriable && attempt < 5) {
      await sleep(backoff(attempt));
      return req(path, opts, attempt + 1);
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
      return req(path, opts, attempt + 1);
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
  return res.json();
}

const body = (b) => (b === undefined ? undefined : JSON.stringify(b));

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
  playlist: (id) => req("/playlist/" + id),
  lyrics: (id) => req("/lyrics/" + id),

  // radios
  trackRadio: (id) => req("/radio/track/" + id),
  artistRadio: (id) => req("/radio/artist/" + id),

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
    if (!res.ok) throw { status: res.status, message: "upload failed" };
    return res.json();
  },

  // telemetry — fire-and-forget; never let it break playback. A no-op server
  // side unless report_listens is enabled in the config.
  reportListen: (payload) =>
    req("/listen", { method: "POST", keepalive: true, body: body(payload) }).catch(
      () => {}
    ),

  // playback (returned as a URL for the <audio> element)
  streamUrl: (id, quality) =>
    BASE + "/stream/" + id + (quality && quality !== "FLAC" ? "?q=" + quality : ""),
};
