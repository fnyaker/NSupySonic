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
} from "./stores.js";
import { downloadTrack, removeTrack, isDownloaded } from "./offline.js";

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
  } catch {
    playlistCache = [];
  }
  return playlistCache;
}

export function invalidatePlaylists() {
  playlistCache = null;
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
  return refreshFavTracks();
}
function refreshFavTracks() {
  if (favTracksInFlight) return favTracksInFlight;
  favTracksInFlight = api
    .myFavorites()
    .then((r) => {
      favTracks.set(r.tracks || []);
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

export async function addTrackToPlaylist(playlistId, trackId, playlistTitle) {
  try {
    await api.addToPlaylist(playlistId, [String(trackId)]);
    // The sidebar/menu cache shows track counts — refresh on the next read.
    invalidatePlaylists();
    toasts.push(`Ajouté à « ${playlistTitle} »`);
  } catch {
    toasts.push("Échec de l'ajout à la playlist", "error");
  }
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

// Build the context-menu item list for a track. `nav` is svelte-spa-router push.
export function buildTrackMenu(track, nav) {
  const fav = get(favorites).has(String(track.deezer_id));
  const admin = get(isAdmin);
  const items = [
    { label: "Lire ensuite", icon: "next", action: () => player.playNext([track]) },
    { label: "Ajouter à la file", icon: "queue", action: () => player.addToQueue([track]) },
  ];
  // Adding to a playlist edits the owner's Deezer playlists — admin-only.
  if (admin) {
    // `track.deezer_id` is the universal track id — a numeric Deezer id, or the
    // row UUID for local files — so this works for local tracks too.
    const playlistSub = (playlistCache || []).map((p) => ({
      label: p.title,
      icon: "music",
      action: () => addTrackToPlaylist(p.id, track.deezer_id, p.title),
    }));
    items.push({ label: "Ajouter à une playlist", icon: "plus", sub: playlistSub });
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
    { label: "Lancer la radio", icon: "radio", action: () => startTrackRadio(track) },
    {
      label: fav ? "Retirer des favoris" : "Ajouter aux favoris",
      icon: fav ? "heartFilled" : "heart",
      action: () => toggleFavorite(track),
    },
    "divider"
  );
  if (track.artist?.deezer_id)
    items.push({
      label: "Aller à l'artiste",
      icon: "user",
      action: () => nav("/artist/" + track.artist.deezer_id),
    });
  if (track.album?.deezer_id)
    items.push({
      label: "Aller à l'album",
      icon: "disc",
      action: () => nav("/album/" + track.album.deezer_id),
    });
  return items;
}
