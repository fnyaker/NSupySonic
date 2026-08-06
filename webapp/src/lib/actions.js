// Higher-level actions wiring the API to the stores (favorites, radio, toasts).
// Kept separate from api.js to avoid an import cycle (api.js imports stores).

import { get } from "svelte/store";
import { api } from "./api.js";
import {
  favorites,
  favTracks,
  player,
  toasts,
  isAdmin,
  syncing,
  downloadQuality,
  lastPlaylist,
  openPlaylistPicker,
  openShare,
} from "./stores.js";
import { downloadTrack, removeTrack, isDownloaded } from "./offline.js";
import { addMarkerAt } from "./markers.js";
import { credits } from "./format.js";
import { reconcileList } from "./reconcile.js";
import { cacheAge } from "./apicache.js";
import { online } from "./net.js";

// Quality choices offered in the "download as…" submenu.
export const DL_QUALITIES = [
  { id: "FLAC", label: "FLAC" },
  { id: "OPUS_320", label: "Opus 320" },
  { id: "OPUS_256", label: "Opus 256" },
  { id: "OPUS_192", label: "Opus 192" },
  { id: "OPUS_128", label: "Opus 128" },
  { id: "OPUS_64", label: "Opus 64" },
];

let playlistCache = null;

// Run a manual Deezer sync end-to-end: kick off the background job, poll until
// it finishes, then refresh the playlist/favorite caches the UI reads. Shared by
// the sidebar (desktop) and the library page (mobile); guarded against overlap
// via the `syncing` store. Returns true on success.
export async function runDeezerSync() {
  if (get(syncing)) return false;
  syncing.set(true);
  toasts.push("Synchronisation Deezer lancée…");
  try {
    await api.sync();
    await new Promise((resolve) => {
      const tick = async () => {
        try {
          const s = await api.syncStatus();
          if (!s.running) return resolve();
        } catch {
          return resolve();
        }
        setTimeout(tick, 3000);
      };
      setTimeout(tick, 3000);
    });
    invalidatePlaylists();
    await loadFavorites(true);
    toasts.push("Bibliothèque à jour");
    return true;
  } catch (e) {
    toasts.push(e?.message || "Échec de la synchronisation", "error");
    return false;
  } finally {
    syncing.set(false);
  }
}

export async function userPlaylists(force = false) {
  if (playlistCache && !force) return playlistCache;
  try {
    const r = await api.myPlaylists();
    playlistCache = r.playlists || [];
    warmPlaylists(playlistCache);
    return playlistCache;
  } catch {
    // Don't memoize a failure: caching [] here left the sidebar / picker / the
    // library tab permanently empty after a single failed load (offline boot,
    // server not up yet) until an unrelated edit invalidated the cache. Return
    // an empty list WITHOUT setting the cache, so the next call refetches.
    return playlistCache || [];
  }
}

export function invalidatePlaylists() {
  playlistCache = null;
}

// -- offline warming ---------------------------------------------------------
// Knowing your playlists exist is useless offline if their track lists aren't
// on the device. So once the list is loaded, quietly pull each playlist's
// tracks into the offline cache — ONE at a time, spaced out, skipping anything
// refreshed recently: this must never compete with what the user is actually
// doing (or with the audio stream sharing the link).

const WARM_MAX_AGE = 24 * 60 * 60 * 1000; // don't re-warm a fresh entry
const WARM_GAP = 1500; // ms between two warms
// Each of these costs the server live Deezer calls, so a session warms a
// bounded number of lists; the rest are picked up on later runs (and any list
// you actually open refreshes itself anyway).
const WARM_MAX = 25;
// Let the screens the user is actually looking at load first.
const WARM_START_DELAY = 10000;
let warming = false;

export async function warmPlaylists(playlists) {
  if (warming || !Array.isArray(playlists) || !playlists.length) return;
  if (!get(online)) return;
  warming = true;
  try {
    await new Promise((r) => setTimeout(r, WARM_START_DELAY));
    // Favourites first: it's the list people open offline most.
    const paths = [
      "/me/favorites",
      ...playlists.slice(0, WARM_MAX).map((p) => "/playlist/" + p.id),
    ];
    for (const path of paths) {
      if (!get(online)) break;
      if ((await cacheAge(path)) < WARM_MAX_AGE) continue;
      try {
        await api.get(path); // caches on success (see api.js)
      } catch {
        /* one unreachable playlist must not stop the rest */
      }
      await new Promise((r) => setTimeout(r, WARM_GAP));
    }
  } finally {
    warming = false;
  }
}

let favoritesLoaded = false;

export async function loadFavorites(force = false) {
  if (favoritesLoaded && !force) return;
  try {
    const r = await api.favoriteIds();
    favorites.set(new Set((r.ids || []).map(String)));
    favoritesLoaded = true;
  } catch {
    /* ignore */
  }
}

export function isFavorite(id) {
  return get(favorites).has(String(id));
}

// Full favorite tracks, cached. First call fetches; later calls return the
// cache immediately and refresh in the background (the server response is cheap
// when the favorites haven't changed, thanks to its checksum cache).
let favTracksInFlight = null;
export async function loadMyFavorites(force = false) {
  const cached = get(favTracks);
  if (cached && !force) {
    refreshFavTracks();
    return cached;
  }
  // Nothing in memory (first library open of the session): paint the last-seen
  // list off disk while the network call runs. /me/favorites costs the server
  // two live Deezer round-trips, so on a slow link that's the difference
  // between an instant list and several seconds of skeleton.
  primeFavTracksFromCache();
  return refreshFavTracks();
}

async function primeFavTracksFromCache() {
  if (get(favTracks) !== null) return;
  const cached = await api.peek("/me/favorites");
  // Only fill the gap — never clobber a fresh response that landed meanwhile.
  if (cached && get(favTracks) === null) favTracks.set(cached.tracks || []);
}
function refreshFavTracks() {
  if (favTracksInFlight) return favTracksInFlight;
  favTracksInFlight = api
    .myFavorites()
    .then((r) => {
      // Reconcile rather than replace: the favourites are shown from the cached
      // copy first, and the fresh one is usually the same list plus or minus a
      // track. Merging in place means the browser re-renders those few rows
      // instead of all four thousand — no flash, no lost scroll, no re-decoded
      // artwork.
      favTracks.set(reconcileList(get(favTracks), r.tracks || []));
      return get(favTracks);
    })
    .catch(() => {
      if (get(favTracks) === null) favTracks.set([]);
      return get(favTracks) || [];
    })
    .finally(() => {
      favTracksInFlight = null;
    });
  return favTracksInFlight;
}

export async function toggleFavorite(track) {
  const id = String(track.deezer_id);
  const on = !get(favorites).has(id);
  // optimistic
  if (on) favorites.add(id);
  else favorites.remove(id);
  updateFavTracksCache(track, on);
  try {
    await api.favorite(id, on);
    toasts.push(on ? "Ajouté aux favoris" : "Retiré des favoris");
  } catch {
    // rollback
    if (on) favorites.remove(id);
    else favorites.add(id);
    updateFavTracksCache(track, !on);
    toasts.push("Échec de la mise à jour du favori", "error");
  }
}

// Keep the cached favorites list consistent with a toggle, so the library view
// updates instantly without a refetch.
function updateFavTracksCache(track, on) {
  const list = get(favTracks);
  if (list === null) return; // not loaded yet — nothing to keep in sync
  const id = String(track.deezer_id);
  if (on) {
    if (!list.some((t) => String(t.deezer_id) === id)) {
      favTracks.set([{ ...track, added: Math.floor(Date.now() / 1000) }, ...list]);
    }
  } else {
    favTracks.set(list.filter((t) => String(t.deezer_id) !== id));
  }
}

export async function toggleEntityFavorite(kind, id, on) {
  try {
    await api.favoriteEntity(kind, id, on);
    toasts.push(on ? "Ajouté à vos favoris" : "Retiré de vos favoris");
    return true;
  } catch {
    toasts.push("Échec de la mise à jour", "error");
    return false;
  }
}

// Subscribe to a podcast from a search result (its Deezer show id): imports the
// show + episodes on the server (archived on first play) and returns the local
// channel, so the caller can open it.
export async function subscribeToPodcast(showDeezerId) {
  try {
    const c = await api.subscribePodcast(
      "https://www.deezer.com/show/" + showDeezerId
    );
    toasts.push("Podcast ajouté");
    return c;
  } catch (e) {
    toasts.push(e?.message || "Échec de l'ajout du podcast", "error");
    return null;
  }
}

export async function startTrackRadio(track) {
  try {
    const r = await api.trackRadio(track.deezer_id);
    if (r.tracks && r.tracks.length) {
      player.playQueue(r.tracks, 0, { kind: "radio", id: track.deezer_id });
      toasts.push("Radio lancée");
    }
  } catch {
    toasts.push("Impossible de lancer la radio", "error");
  }
}

// Optimistic: the toast and the "last playlist" shortcut update INSTANTLY —
// the server call (which may include a Deezer round-trip) runs in the
// background, and only a failure surfaces afterwards.
export function addTrackToPlaylist(playlistId, trackId, playlistTitle) {
  lastPlaylist.set({ id: String(playlistId), title: playlistTitle });
  toasts.push(`Ajouté à « ${playlistTitle} »`);
  return api
    .addToPlaylist(playlistId, [String(trackId)])
    .then(() => {
      // The sidebar/menu cache shows track counts — refresh on the next read.
      invalidatePlaylists();
      return true;
    })
    .catch(() => {
      toasts.push(`Échec de l'ajout à « ${playlistTitle} »`, "error");
      return false;
    });
}

// -- offline downloads (device-local; available to every user) --------------

export async function downloadTrackTo(track, quality = null) {
  const q = quality || get(downloadQuality);
  if (isDownloaded(track.deezer_id)) return;
  toasts.push(`Téléchargement de « ${track.title} »…`);
  const ok = await downloadTrack(track, q);
  toasts.push(
    ok ? `« ${track.title} » disponible hors-ligne` : "Échec du téléchargement",
    ok ? "info" : "error"
  );
}

export async function undownloadTrack(track) {
  await removeTrack(track.deezer_id);
  toasts.push("Téléchargement retiré");
}

// How many track downloads to run in parallel for a whole album/playlist. The
// server archives each in its own worker (see download_workers), so a few
// concurrent requests cut the wait dramatically without swamping the device.
const DL_CONCURRENCY = 4;

// Download a set of tracks (fail-soft), a few at a time. Local-only and already
// cached tracks are skipped. Used for whole albums / playlists.
export async function downloadTracks(tracks, quality = null) {
  const q = quality || get(downloadQuality);
  const list = (tracks || []).filter(
    (t) => t && t.deezer_id && !isDownloaded(t.deezer_id)
  );
  if (!list.length) {
    toasts.push("Déjà disponible hors-ligne");
    return;
  }
  toasts.push(`Téléchargement de ${list.length} titre(s)…`);
  // Bounded worker pool: DL_CONCURRENCY consumers pull from a shared cursor so
  // several tracks archive + download at once instead of strictly one by one.
  let ok = 0;
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      if (await downloadTrack(list[i], q)) ok++;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(DL_CONCURRENCY, list.length) }, worker)
  );
  toasts.push(
    ok === list.length ? `${ok} titre(s) téléchargé(s)` : `${ok}/${list.length} téléchargé(s)`,
    ok ? "info" : "error"
  );
}

// Fetch an album/playlist's tracks, then download them all.
export async function downloadEntity(kind, id, quality = null) {
  try {
    let tracks = [];
    if (kind === "album") tracks = (await api.album(id)).tracks;
    else if (kind === "playlist") tracks = (await api.playlist(id)).tracks;
    await downloadTracks(tracks, quality);
  } catch {
    toasts.push("Téléchargement impossible", "error");
  }
}

// Load and play an album/playlist/artist/mix as a queue.
export async function playEntity(kind, id, context = null) {
  try {
    let tracks = [];
    if (kind === "album") tracks = (await api.album(id)).tracks;
    else if (kind === "playlist") tracks = (await api.playlist(id)).tracks;
    else if (kind === "mix") tracks = (await api.smartTracklist(id)).tracks;
    else if (kind === "artist") tracks = (await api.artistRadio(id)).tracks;
    if (tracks && tracks.length) {
      player.playQueue(tracks, 0, context || { kind, id });
    } else {
      toasts.push("Rien à lire ici", "error");
    }
  } catch {
    toasts.push("Lecture impossible", "error");
  }
}

// Context menu for an album/artist/playlist/mix card.
export function buildEntityMenu(kind, item, nav) {
  const route = kind === "mix" ? "/mix/" : "/" + kind + "/";
  const routeId = item.id || item.deezer_id;
  const items = [
    { label: "Lire", icon: "play", action: () => playEntity(kind, routeId) },
    { label: "Ouvrir", icon: "open", action: () => nav(route + routeId) },
  ];
  if (kind === "album" || kind === "playlist")
    items.push({
      label: "Télécharger",
      icon: "download",
      action: () => downloadEntity(kind, routeId),
    });
  // Favoriting an album/artist/playlist writes to the shared Deezer account, so
  // it's admin-only (guests don't mutate the owner's account).
  if (get(isAdmin)) {
    // Only Deezer-backed entities can be favorited on the account (a user's own
    // playlist has no Deezer favorite to add).
    if ((kind === "album" || kind === "playlist") && item.deezer_id)
      items.push({
        label: "Ajouter aux favoris",
        icon: "heart",
        action: () => toggleEntityFavorite(kind, item.deezer_id, true),
      });
    if (kind === "artist")
      items.push({
        label: "Suivre",
        icon: "heart",
        action: () => toggleEntityFavorite("artist", item.deezer_id, true),
      });
  }
  return items;
}

// A podcast episode is shaped like a track (so the queue/player play it), but
// its id is a UUID and its "artist"/"album" are the channel — so the normal
// track menu's favorite / radio / playlist / go-to-artist actions all hit
// endpoints that reject a UUID (400) or 404. Give episodes their own minimal,
// working menu instead.
function buildEpisodeMenu(ep, nav) {
  const dl = isDownloaded(ep.deezer_id);
  const items = [
    { label: "Lire ensuite", icon: "next", action: () => player.playNext([ep]) },
    { label: "Ajouter à la file", icon: "queue", action: () => player.addToQueue([ep]) },
  ];
  // Playing this very episode: offer a one-tap marker at the current position.
  const s = get(player);
  if (s.queue[s.index]?.deezer_id === ep.deezer_id) {
    items.push({
      label: "Marquer cette position",
      icon: "bookmarkPlus",
      action: () => addMarkerAt(ep, get(player).currentTime),
    });
  }
  items.push(
    { label: "Partager…", icon: "share", action: () => openShare(ep) },
    "divider",
    dl
      ? {
          label: "Retirer le téléchargement",
          icon: "downloaded",
          action: () => undownloadTrack(ep),
        }
      : { label: "Télécharger", icon: "download", action: () => downloadTrackTo(ep) }
  );
  if (ep.channel_id)
    items.push("divider", {
      label: "Ouvrir le podcast",
      icon: "mic",
      action: () => nav("/podcast/" + ep.channel_id),
    });
  return items;
}

// Build the context-menu item list for a track. `nav` is svelte-spa-router push.
export function buildTrackMenu(track, nav) {
  if (track.podcast) return buildEpisodeMenu(track, nav);
  const fav = get(favorites).has(String(track.deezer_id));
  const admin = get(isAdmin);
  const items = [
    { label: "Lire ensuite", icon: "next", action: () => player.playNext([track]) },
    { label: "Ajouter à la file", icon: "queue", action: () => player.addToQueue([track]) },
  ];
  // Adding to a playlist edits the owner's Deezer playlists — admin-only.
  // `track.deezer_id` is the universal track id — a numeric Deezer id, or the
  // row UUID for local files — so this works for local tracks too.
  if (admin) {
    const last = get(lastPlaylist);
    if (last && last.id)
      items.push({
        label: `Ajouter à « ${last.title} »`,
        icon: "plus",
        action: () => addTrackToPlaylist(last.id, track.deezer_id, last.title),
      });
    // Opens the searchable playlist picker (scrolling a giant submenu to find
    // the right playlist was the old, painful way).
    items.push({
      label: "Ajouter à une playlist…",
      icon: "music",
      action: () => openPlaylistPicker(track),
    });
  }
  // Offline download — device-local, so available to everyone. A plain
  // "Télécharger" at the default quality, plus a submenu to pick another.
  const dl = isDownloaded(track.deezer_id);
  items.push(
    "divider",
    dl
      ? {
          label: "Retirer le téléchargement",
          icon: "downloaded",
          action: () => undownloadTrack(track),
        }
      : { label: "Télécharger", icon: "download", action: () => downloadTrackTo(track) }
  );
  if (!dl)
    items.push({
      label: "Télécharger en…",
      icon: "download",
      sub: DL_QUALITIES.map((q) => ({
        label: q.label,
        icon: "download",
        action: () => downloadTrackTo(track, q.id),
      })),
    });

  items.push(
    "divider",
    { label: "Partager…", icon: "share", action: () => openShare(track) },
    { label: "Lancer la radio", icon: "radio", action: () => startTrackRadio(track) },
    {
      label: fav ? "Retirer des favoris" : "Ajouter aux favoris",
      icon: fav ? "heartFilled" : "heart",
      action: () => toggleFavorite(track),
    },
    "divider"
  );
  // One entry per credited artist. A single credit stays a plain item (the
  // common case shouldn't grow a submenu for nothing); a feat. track opens a
  // submenu so the guest is reachable too.
  const people = credits(track).filter((a) => a.deezer_id);
  if (people.length === 1)
    items.push({
      label: "Aller à l'artiste",
      icon: "user",
      action: () => nav("/artist/" + people[0].deezer_id),
    });
  else if (people.length > 1)
    items.push({
      label: "Aller à l'artiste",
      icon: "user",
      sub: people.map((a) => ({
        label: a.name,
        icon: "user",
        action: () => nav("/artist/" + a.deezer_id),
      })),
    });
  if (track.album?.deezer_id)
    items.push({
      label: "Aller à l'album",
      icon: "disc",
      action: () => nav("/album/" + track.album.deezer_id),
    });
  return items;
}
