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
// Told when a remote-control session ends under a request (lib/remote/controller.js).
let remoteEndedHook = null;
export function onRemoteEnded(fn) {
  remoteEndedHook = fn;
}
export function remoteEnded(restored) {
  if (remoteEndedHook) remoteEndedHook(restored || null);
}
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
      const text = await res.text();
      cachePut(path, null, text).catch(() => {});
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
    // A remote-control grant that just ended (the owner cut it, it expired) is
    // not a logged-out user: the controller says so and offers the account
    // this browser had before, if the server gave it back.
    let info = null;
    try {
      info = await res.json();
    } catch {
      /* not JSON: an ordinary 401 */
    }
    if (info && info.error === "remote ended" && remoteEndedHook) {
      remoteEndedHook(info.restored || null);
      throw { status: 401, message: "remote ended", remoteEnded: true };
    }
    user.set(null);
    throw { status: 401, message: "unauthorized" };
  }
  if (!res.ok) {
    // A failure the server has already classified as Deezer's (unreachable,
    // or the proxy switched off) is FINAL here. Reaching Deezer again is the
    // server's job — its calls retry within their own budget and its breaker
    // probes Deezer once the cooldown is over — so re-asking would only fetch
    // the same instant refusal three more times, ~3 s of backoff later.
    const code = res.headers.get("X-NS-Error");
    if (code) {
      // The Deezer health watcher still hears of it: it is what raises the
      // "Deezer est injoignable" notice and re-checks when the server says.
      if (res.status >= 500) reportServerError(res.status, path);
      let info = {};
      try {
        info = (await res.json()) || {};
      } catch {
        /* the header says enough */
      }
      throw {
        status: res.status,
        code,
        message: info.error || res.statusText,
        retryIn: info.retry_in || 0,
      };
    }
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
  // The offline cache stores the response's TEXT (apicache.js#cachePut): a
  // string copy where the parsed object cost a deep clone. Read from a clone
  // of the response, and after the caller has had its data — the parsed copy
  // comes from res.json(), which parses straight from the bytes (measured,
  // text() + JSON.parse on the critical path cost more than it saved).
  const copy = cacheable ? res.clone() : null;
  const data = await res.json();
  if (copy)
    setTimeout(() => {
      copy
        .text()
        .then((text) => cachePut(path, null, text))
        .catch(() => {});
    }, 0);
  return data;
}

const body = (b) => (b === undefined ? undefined : JSON.stringify(b));

// A page only Deezer has, asked while Deezer is out (see `X-NS-Error` above):
// a screen says "Deezer est injoignable" instead of "introuvable".
export const DEEZER_UNREACHABLE = "deezer-unreachable";
export function isDeezerUnreachable(err) {
  return !!err && err.code === DEEZER_UNREACHABLE;
}

// A page only Deezer has, for somebody the server's Deezer account is not lent
// to (plan multi-provider §15): a refusal, not an outage — nothing to retry.
export const DEEZER_DENIED = "deezer-denied";
export function isDeezerDenied(err) {
  return !!err && err.code === DEEZER_DENIED;
}

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

  // who may use which provider (plan multi-provider §15)
  access: () => req("/access"),
  setGrants: (provider, account, feature, subjects) =>
    req("/access/grants", { method: "PUT", body: body({ provider, account, feature, subjects }) }),
  createGroup: (name, members) => req("/groups", { method: "POST", body: body({ name, members }) }),
  updateGroup: (id, changes) =>
    req("/groups/" + encodeURIComponent(id), { method: "PUT", body: body(changes) }),
  deleteGroup: (id) => req("/groups/" + encodeURIComponent(id), { method: "DELETE" }),
  // Each person's own accounts and what they bring into the library (lot P2).
  myAccounts: () => req("/me/accounts"),
  linkDeezer: (arl, mode) => req("/me/accounts/deezer", { method: "POST", body: body({ arl, mode }) }),
  unlinkAccount: (id) => req("/me/accounts/" + encodeURIComponent(id), { method: "DELETE" }),
  setAccountAuto: (id, auto) =>
    req("/me/accounts/" + encodeURIComponent(id), { method: "PUT", body: body({ auto }) }),
  setDefaultAccount: (id) => req("/me/accounts/default", { method: "PUT", body: body({ account: id }) }),
  importAccount: (id, kinds) =>
    req("/me/accounts/" + encodeURIComponent(id) + "/import", { method: "POST", body: body(kinds ? { kinds } : {}) }),
  accountLibrary: (id, kind, fresh) =>
    req("/me/accounts/" + encodeURIComponent(id) + "/library/" + kind + (fresh ? "?fresh=1" : "")),
  setAccountItems: (id, kind, refs, on) =>
    req("/me/accounts/" + encodeURIComponent(id) + "/library/" + kind, { method: "PUT", body: body({ refs, on }) }),

  // discovery
  home: () => req("/home"),
  homeMix: (id) => req("/home/mix/" + encodeURIComponent(id)),
  // The Flow at a discovery level (0 = what you know, 1 = far from it); a new
  // seed is a new draw.
  flow: (level, seed) => {
    const q = [];
    if (level != null) q.push("d=" + encodeURIComponent(Number(level).toFixed(2)));
    if (seed) q.push("seed=" + encodeURIComponent(seed));
    return req("/flow" + (q.length ? "?" + q.join("&") : ""));
  },
  // A Flow refill: what the queue holds and what this session skipped go with
  // it, so nothing comes back twice and the skips steer the rest.
  flowNext: (level, { exclude = [], skipped = [] } = {}) =>
    req("/flow", {
      method: "POST",
      body: body({ d: level, exclude: exclude.map(String), skipped: skipped.map(String) }),
    }),
  recommend: (level, seed) =>
    req(
      "/recommend?d=" + encodeURIComponent(Number(level).toFixed(2)) +
        (seed ? "&seed=" + encodeURIComponent(seed) : "")
    ),
  discoverPrefs: () => req("/discover/prefs"),
  setDiscoverLevel: (level) =>
    req("/discover/prefs", { method: "PUT", body: body({ level }) }),
  muteArtist: (provider, id) =>
    req("/discover/mute", { method: "POST", body: body({ provider, id }) }),
  releases: () => req("/releases"),
  releasesSeen: () => req("/releases/seen", { method: "POST" }),
  releasesSettings: () => req("/releases/settings"),
  saveReleasesSettings: (values) =>
    req("/releases/settings", { method: "PUT", body: body(values) }),
  releasesCheck: () => req("/releases/check", { method: "POST" }),
  search: (q) => req("/search?q=" + encodeURIComponent(q)),

  // entities
  artist: (id) => req("/artist/" + id),
  artistTracks: (id) => req("/artist/" + id + "/tracks"),
  discography: (id) => req("/artist/" + id + "/discography"),
  // The part of a library page that only Deezer has, asked once the page is shown.
  artistOnDeezer: (id) => req("/artist/" + id + "/on-deezer"),
  albumOnDeezer: (id) => req("/album/" + id + "/on-deezer"),
  album: (id) => req("/album/" + id),
  playlist: (id) => req("/playlist/" + id),
  lyrics: (id) => req("/lyrics/" + id),
  // ReplayGain for volume normalization; backfilled + cached server-side.
  trackGain: (id) => req("/gain/" + id),
  // A whole run of tracks in one call — see lib/gaincache.js.
  trackGains: (ids) =>
    req("/gains", { method: "POST", body: body({ ids: (ids || []).map(String) }) }),

  // Tempo + style for a whole run of tracks, measured server-side once per
  // file — see supysonic/deezer/analysis.py and lib/analysis.js.
  trackAnalyses: (ids) =>
    req("/analyses", { method: "POST", body: body({ ids: (ids || []).map(String) }) }),
  // The same verdict for ONE track, plus `pending` when the server has just put
  // it on its own background queue. Used after a tag, to pick the new verdict up
  // without waiting for the next play.
  trackAnalysis: (id) => req("/analysis/" + encodeURIComponent(id)),

  // (Re)measure the whole library server-side — tempo, style, embeddings — with
  // a chosen parallelism. Admin-only; the studio polls the job.
  analysisBackfill: (force, workers) =>
    req("/analysis/backfill", { method: "POST", body: body({ force, workers }) }),
  analysisBackfillStatus: () => req("/analysis/backfill"),

  // Where the audio actually starts and stops inside the archived file, for
  // the crossfade's silence trimming. Answers {ready:false} rather than an
  // error when the file isn't archived — see supysonic/webui/edges.py.
  audioEdges: (id, db) => req("/audio/edges/" + id + "?db=" + encodeURIComponent(db)),

  // -- the genre studio (admin) ----------------------------------------------
  // Your own genre vocabulary, your labels, and the small head trained from
  // them in the browser. See supysonic/webui/genre.py.
  genreStatus: () => req("/genre/status"),
  genreTagCreate: (name, color, archetype) =>
    req("/genre/tags", { method: "POST", body: body({ name, color, archetype }) }),
  genreTagEdit: (id, patch) =>
    req("/genre/tags/" + id, { method: "PATCH", body: body(patch) }),
  genreTagDelete: (id) => req("/genre/tags/" + id, { method: "DELETE" }),
  // (Re)add the engine's own genres as tags — only ever adds what is missing.
  genreDefaults: () => req("/genre/tags/defaults", { method: "POST" }),
  genreLabel: (track, tag) =>
    req("/genre/label", { method: "POST", body: body({ track, tag }) }),
  genreCandidates: (limit = 40, sort = null, last = null) =>
    req(
      "/genre/candidates?limit=" + limit + (sort ? "&sort=" + sort : "") +
        (last ? "&last=" + encodeURIComponent(last) : ""),
    ),
  genreLabelled: () => req("/genre/labelled"),
  // The genre hierarchy (nodes, links, version) and its edits (admin).
  genreTree: () => req("/genre/tree"),
  genreTreeEdge: (child, parent, weight = 1, method = "POST") =>
    req("/genre/tree/edge", { method, body: body({ child, parent, weight }) }),
  genreTreeCut: (child, parent) =>
    req("/genre/tree/edge", { method: "DELETE", body: body({ child, parent }) }),
  genreTreeMove: (child, parent, oldParent = null, weight = 1) =>
    req("/genre/tree/move", { method: "POST", body: body({ child, parent, old_parent: oldParent, weight }) }),
  genreTreeUndo: () => req("/genre/tree/undo", { method: "POST" }),
  genreTreeReset: () => req("/genre/tree/reset", { method: "POST" }),
  // Untagged tracks with a vector, for self-training (lib/genre/core.js `pseudo`).
  genrePool: (limit = 600) => req("/genre/pool?limit=" + limit),
  // One track's tag and the vocabulary ranked for it (the tag sheet).
  genreTrack: (id) => req("/genre/track/" + encodeURIComponent(id)),
  genreEmbeddings: (ids) =>
    req("/genre/embeddings", { method: "POST", body: body({ ids: (ids || []).map(String) }) }),
  genreModel: () => req("/genre/model"),
  genreModelPut: (payload) =>
    req("/genre/model", { method: "PUT", body: body(payload) }),
  genreModelDelete: () => req("/genre/model", { method: "DELETE" }),
  // A model as a file (supysonic/webui/genreshare.py): what it would do, then do it.
  genreSharePreview: (file) => req("/genre/share/preview", { method: "POST", body: body(file) }),
  genreShareImport: (file, opts) =>
    req("/genre/share/import", { method: "POST", body: body({ file, ...opts }) }),
  genreShareStatus: () => req("/genre/share/import"),
  // Re-deciding the stored verdicts under the active head (no re-measure).
  genreRelabel: () => req("/genre/relabel"),
  // How a track is built, as the analyser heard it (lib/genre/construction.js).
  analysisLive: (id, summary) =>
    req(`/analysis/${encodeURIComponent(id)}/live`, { method: "POST", body: body(summary), keepalive: true }),
  genreRelabelStart: () => req("/genre/relabel", { method: "POST" }),
  genreConstruction: () => req("/genre/construction"),
  // Well-known recordings per genre, looked up on Deezer (deezer/references.py).
  genreReferenceGenres: () => req("/genre/references"),
  genreReferences: (genre) => req("/genre/references?genre=" + encodeURIComponent(genre)),
  genreReferenceImport: (deezerId, tag) =>
    req("/genre/references/import", { method: "POST", body: body({ deezer_id: deezerId, tag }) }),
  // A whole album / playlist / artist: what tagging it would do, then do it.
  genreBulkPreview: (scope, tag) =>
    req("/genre/bulk/preview", { method: "POST", body: body({ ...scope, tag }) }),
  genreBulk: (tracks, tag) => req("/genre/bulk", { method: "POST", body: body({ tracks, tag }) }),

  // The frozen ONNX extractor: install the operator's own copy of the model
  // from the browser, remove it, or run the built-in sanity check on real
  // tracks. The upload is multipart, so it bypasses the JSON `req` helper.
  genreExtractorUpload: async (file) => {
    const fd = new FormData();
    fd.append("files", file);
    const res = await fetch(BASE + "/genre/extractor", {
      method: "POST",
      credentials: "include",
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      throw {
        status: res.status,
        message:
          data.error ||
          (res.status === 413
            ? "Fichier trop volumineux (limite du serveur)"
            : "envoi impossible"),
      };
    return data;
  },
  genreExtractorDelete: () => req("/genre/extractor", { method: "DELETE" }),
  genreExtractorTest: () => req("/genre/extractor/test", { method: "POST" }),
  genreExtractorTestStatus: () => req("/genre/extractor/test"),

  // The slow one: measure every archived track that has no embedding yet, in a
  // server-side worker the studio polls. Admin-only.
  genreEmbed: (force = false) =>
    req("/genre/embed" + (force ? "?force=1" : ""), { method: "POST" }),
  genreEmbedStatus: () => req("/genre/embed"),
  // The tracks that sound alike (what the radio, the flow and the home read).
  similarRebuild: (force = false) =>
    req("/similar/rebuild" + (force ? "?force=1" : ""), { method: "POST" }),
  similarStatus: () => req("/similar/rebuild"),
  // Facts from MusicBrainz for the archived library (admin, worker + poll).
  enrichBackfill: (force = false) =>
    req("/enrich/backfill" + (force ? "?force=1" : ""), { method: "POST" }),
  enrichStatus: () => req("/enrich/backfill"),

  // radios
  trackRadio: (id) => req("/radio/track/" + id),
  trackCredits: (id) => req("/track/" + id + "/credits"),
  // Every track of the library a person is credited on (not as performer).
  personCreditsPath: (name) => "/credits/person?name=" + encodeURIComponent(name),
  // The credits of the library completed in the background (admin, worker + poll).
  creditsBackfill: (force = false) =>
    req("/credits/backfill" + (force ? "?force=1" : ""), { method: "POST" }),
  creditsBackfillStatus: () => req("/credits/backfill"),
  artistRadio: (id) => req("/radio/artist/" + id),
  // The next titles of a radio already playing: its ORIGINAL seed and the
  // session (heard through, skipped, queued) — never the queue's last title,
  // which made the radio drift a neighbour of a neighbour at a time.
  radioNext: (seed, { recent = [], skipped = [], exclude = [] } = {}) =>
    req("/radio/next", {
      method: "POST",
      body: body({
        seed,
        recent: recent.map(String),
        skipped: skipped.map(String),
        exclude: exclude.map(String),
      }),
    }),

  // podcasts
  podcasts: () => req("/podcasts"),
  podcast: (id) => req("/podcast/" + id),
  searchPodcasts: (q) => req("/search/podcasts?q=" + encodeURIComponent(q)),
  // The YouTube fallback: opt-in per search (lib/youtube.js). Its hits are
  // ordinary tracks whose id is the row they become once played or kept.
  youtubeSearch: (q) => req("/youtube/search?q=" + encodeURIComponent(q)),

  // A playlist somebody shared (Deezer, Spotify, YouTube, Apple Music): read
  // and matched on the server as a job — see supysonic/webui/playlist_import.py.
  importPlaylist: (url) => req("/import/playlist", { method: "POST", body: body({ url }) }),
  importStatus: (id) => req("/import/playlist/" + encodeURIComponent(id)),
  importSave: (id, title, keep) =>
    req("/import/playlist/" + encodeURIComponent(id) + "/save", {
      method: "POST",
      body: body({ title, keep }),
    }),
  youtubeStatus: () => req("/youtube/status"),
  setYoutubeEnabled: (enabled) =>
    req("/youtube/settings", { method: "PUT", body: body({ enabled }) }),
  subscribePodcast: (url) =>
    req("/podcasts", { method: "POST", body: body({ url }) }),
  unsubscribePodcast: (id) => req("/podcast/" + id, { method: "DELETE" }),
  setPodcastAutoArchive: (id, on) =>
    req("/podcast/" + id + "/auto_archive", { method: "POST", body: body({ on }) }),

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

  // remote control — the OWNER's side (links onto one of their players). The
  // live traffic (the player's publish/poll, the controller's state/commands)
  // runs on its own loops in lib/remote/, with its own timeouts and backoff.
  remoteLinks: (device) =>
    req("/remote/links" + (device ? "?device=" + encodeURIComponent(device) : "")),
  remoteCreate: (opts) => req("/remote/links", { method: "POST", body: body(opts) }),
  remoteRevoke: (id) => req("/remote/links/" + encodeURIComponent(id), { method: "DELETE" }),
  remoteRevokeDevice: (device) =>
    req("/remote/links?device=" + encodeURIComponent(device), { method: "DELETE" }),
  remoteClaim: (token) => req("/remote/claim", { method: "POST", body: body({ token }) }),
  remoteLeave: () => req("/remote/leave", { method: "POST" }),

  // listen party — the HOST's side (guests have no session and talk to the
  // public /api/party/<id>/... endpoints directly, see routes/Party.svelte).
  partyStart: (opts) => req("/party", { method: "POST", body: body(opts || {}) }),
  partyMine: () => req("/party/mine"),
  partyEnd: (id) => req("/party/" + id, { method: "DELETE" }),
  partyPublish: (id, state) => req("/party/" + id + "/state", { method: "POST", body: body(state) }),

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

  // export to another streaming service (supysonic/webui/services.py): the
  // user's own linked accounts, the job that matches and creates, and the
  // list file for every service there is no door to (Apple Music…).
  services: () => req("/services"),
  setSpotifyApp: (clientId) =>
    req("/services/spotify/app", { method: "PUT", body: body({ client_id: clientId }) }),
  spotifyAuthorize: () => req("/services/spotify/authorize"),
  connectYoutube: (headers) =>
    req("/services/youtube/connect", { method: "POST", body: body({ headers }) }),
  disconnectService: (id) => req("/services/" + id, { method: "DELETE" }),
  exportToService: (service, kind, id, name, isPublic) =>
    req("/services/" + service + "/export", {
      method: "POST",
      body: body({ kind, id: String(id), name, public: !!isPublic }),
    }),
  serviceExportJob: (job) => req("/services/export/" + encodeURIComponent(job)),
  listFileUrl: (kind, id, fmt) =>
    BASE + "/services/list/" + kind + "/" + encodeURIComponent(id) + "?fmt=" + encodeURIComponent(fmt),

  // library
  myPlaylists: () => req("/me/playlists"),
  myFavorites: () => req("/me/favorites"),
  myArtists: () => req("/me/artists"),
  myAlbums: () => req("/me/albums"),
  myLocal: () => req("/me/local"),
  favoriteIds: () => req("/me/favorite-ids"),
  // "Je n'aime pas": the title leaves the Flow, the radios and the mixes, with
  // what sounds almost the same; `on` false brings it back.
  dislike: (ref, on) => req("/dislike", { method: "POST", body: body({ id: ref, on }) }),
  myDislikes: () => req("/me/dislikes"),

  // mutations
  // `ref` names the track the way the server resolves it (trackkey.js#trackRef).
  favorite: (ref, on) =>
    req("/favorite", { method: "POST", body: body({ id: ref, on }) }),
  // `meta` ({ title, artist, artist_id }) names the entity for the server when
  // it has never imported it (a star is local, the row is made from this).
  // `ref` is the entity's id, or the provider id of a catalogue result the
  // library does not hold yet (digits): the server accepts both, by the key
  // that says which.
  favoriteEntity: (kind, ref, on, meta = {}) =>
    req("/favorite/" + kind, {
      method: "POST",
      body: body({ ...meta, [/^[0-9]+$/.test(String(ref)) ? "deezer_id" : "id"]: ref, on }),
    }),
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
  // `why` says what this archive request IS, so the server can order its queue:
  // "prefetch" is the track about to play, "bulk" (the default) is "archive
  // this playlist/artist, whenever". Never a number — every caller would claim
  // to be the urgent one.
  // Not itself marked background: queueing is instant, and refusing it would
  // silently lose a playlist the user asked to download. It is what it QUEUES
  // that is background.
  download: (ids, why = "bulk") =>
    req("/download", { method: "POST", body: body({ ids, why }) }),

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
  // Admin: bring the files already archived to the current format (job + poll).
  archiveMigrate: (force = false) =>
    req("/archive/migrate", { method: "POST", body: body({ force }) }),
  archiveMigrateStatus: () => req("/archive/migrate"),
  // Admin: what the archive costs and what's left of the disk.
  storage: () => req("/storage"),
  flushCache: () => req("/cache/flush", { method: "POST" }),

  // Availability & replacement. `probe` answers the question the <audio>
  // element can't: is this track dead, or was that just a bad moment?
  probeTrack: (id) => req("/track/" + id + "/probe"),
  unavailableTracks: () => req("/unavailable"),
  // `youtube`: also ask YouTube (the sheet's opt-in button) — one request
  // there, cached a day by the server.
  // `q`: the sheet's search box replaces the query. YouTube is also asked,
  // unprompted, when Deezer finds nothing (`youtube_auto` in the answer).
  replacementCandidates: (id, { youtube = false, q = "" } = {}) => {
    const qs = new URLSearchParams();
    if (youtube) qs.set("youtube", "1");
    if (q) qs.set("q", q);
    const s = qs.toString();
    return req("/replace/candidates/" + id + (s ? "?" + s : ""));
  },
  // Only the matches safe enough to apply in one click (same song, artist,
  // version and length), best first — what the library list shows inline.
  bestReplacements: (id, n = 2) => req("/replace/candidates/" + id + "?best=" + n),
  replaceTrack: (from, to) =>
    req("/replace", { method: "POST", body: body({ from, to }) }),
  replaceStatus: (job) => req("/replace/status/" + job),
  // The audio auto-match (admin): its switch, the library-wide run, the report.
  automatch: () => req("/automatch"),
  automatchSettings: (enabled) =>
    req("/automatch/settings", { method: "PUT", body: body({ enabled }) }),
  automatchRun: () => req("/automatch/run", { method: "POST" }),
  automatchCancel: () => req("/automatch/cancel", { method: "POST" }),
  // Drop a track that exists neither on Deezer nor on disk. The server
  // re-checks both before it removes anything, and answers 409 if either one
  // still has it — "gone from Deezer" is not "gone".
  deleteTrack: (id) => req("/track/" + id, { method: "DELETE" }),
  // The same, for a selection (≤ 200): one job, each track re-checked in turn;
  // the job reports `deleted` ids and `kept` [{id, reason}].
  deleteTracks: (ids) => req("/tracks/delete", { method: "POST", body: body({ ids }) }),

  // Build identity of the served app (+ the Android release it expects).
  version: () => req("/version"),

  // telemetry — fire-and-forget; never let it break playback. It only counts the
  // play on this server; nothing goes to Deezer. Skipped entirely while
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
