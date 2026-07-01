// Registers the queue filter used when starting playback. Kept out of the store
// so the store doesn't depend on connectivity / download state.
//
// Default behaviour: when OFFLINE, starting playback queues only the tracks that
// can actually play on the device (downloaded, cached or local files), instead
// of trying — and skipping/stalling through — ones that need the network. Users
// can turn this off in Settings to queue everything regardless.

import { get } from "svelte/store";
import { online } from "./net.js";
import { isDownloaded } from "./offline.js";
import { isCached } from "./playcache.js";
import { offlineOnlyDownloaded, setQueueFilter, toasts } from "./stores.js";

function available(t) {
  return !!(t && (t.local || isDownloaded(t.deezer_id) || isCached(t.deezer_id)));
}

export function initQueueFilter() {
  setQueueFilter((tracks) => {
    if (!Array.isArray(tracks)) return tracks;
    if (!get(offlineOnlyDownloaded)) return tracks; // toggle off — play everything
    if (get(online)) return tracks; // online — streaming works, no filtering

    const avail = tracks.filter(available);
    if (!avail.length) {
      toasts.push("Aucun titre disponible hors-ligne", "error");
      return [];
    }
    if (avail.length < tracks.length) {
      toasts.push(`Hors-ligne : lecture des ${avail.length} titre(s) disponibles`);
    }
    return avail;
  });
}
