// Manual podcast markers (bookmarked positions inside an episode), backed by
// the server so they follow the user across devices. A small writable cache
// keyed by episode id keeps the views reactive; every mutation is optimistic
// against it and reconciled with the server response.

import { get, writable } from "svelte/store";
import { api } from "./api.js";
import { toasts } from "./stores.js";
import { duration as fmtDuration } from "./format.js";

// { [episodeId]: [ { id, episode_id, position, label } ] } — sorted by position.
export const episodeMarkers = writable({});

function setFor(episodeId, list) {
  list = (list || []).slice().sort((a, b) => a.position - b.position);
  episodeMarkers.update((m) => ({ ...m, [String(episodeId)]: list }));
}

// All of the current user's markers across a show, in one call (used by the
// show page — one request instead of one per episode).
export async function loadShowMarkers(channelId) {
  try {
    const grouped = (await api.showMarkers(channelId)).markers || {};
    episodeMarkers.update((m) => {
      const next = { ...m };
      for (const [eid, list] of Object.entries(grouped)) {
        next[eid] = (list || []).slice().sort((a, b) => a.position - b.position);
      }
      return next;
    });
  } catch {
    /* markers are a nicety — the page works without them */
  }
}

export async function loadEpisodeMarkers(episodeId) {
  try {
    setFor(episodeId, (await api.episodeMarkers(episodeId)).markers || []);
  } catch {
    /* ignore */
  }
}

// Drop a marker at `position` (seconds) in an episode. The episode is a
// track-shaped object whose deezer_id is the episode UUID.
export async function addMarkerAt(episode, position, label = null) {
  const eid = String(episode.deezer_id);
  position = Math.max(0, Math.floor(position));
  try {
    const r = await api.addMarker(eid, position, label);
    const list = (get(episodeMarkers)[eid] || []).concat([r.marker]);
    setFor(eid, list);
    toasts.push(`Marqueur ajouté à ${fmtDuration(position)}`);
    return r.marker;
  } catch (e) {
    toasts.push(e?.message || "Échec de l'ajout du marqueur", "error");
    return null;
  }
}

export async function removeMarker(marker) {
  const eid = String(marker.episode_id);
  const before = get(episodeMarkers)[eid] || [];
  setFor(eid, before.filter((m) => m.id !== marker.id)); // optimistic
  try {
    await api.deleteMarker(marker.id);
    toasts.push("Marqueur supprimé");
  } catch {
    setFor(eid, before); // rollback
    toasts.push("Échec de la suppression", "error");
  }
}
