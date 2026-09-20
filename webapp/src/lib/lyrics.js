// Shared lyrics state for the current track: fetched once per track and reused
// by the Paroles panel and the "current line" overlay above the cover, so we
// don't fetch or track the active line twice.

import { writable, derived } from "svelte/store";
import { current, player } from "./stores.js";
import { api } from "./api.js";
import { playable } from "./ladder.js";

// { synced: [{ time, text }], text } | null  (null = none / not loaded yet)
export const trackLyrics = writable(null);

// The panel is emptied the instant the track changes — showing the previous
// song's words over the new one is worse than showing none.
let showingFor = null;
current.subscribe(($c) => {
  const id = $c?.deezer_id || null;
  if (id === showingFor) return;
  showingFor = id;
  trackLyrics.set(null);
});

// ...but they are FETCHED only once the audio is under way. Nobody reads along
// before the song starts, and this request used to race the audio it belongs
// to. See lib/ladder.js.
let loadingFor = null;
playable.subscribe((ready) => {
  const id = ready || null;
  if (!id || id === loadingFor) return;
  loadingFor = id;
  api
    .lyrics(id)
    .then((r) => {
      if (loadingFor === id && showingFor === id) trackLyrics.set(r.lyrics || null);
    })
    .catch(() => {
      if (loadingFor === id && showingFor === id) trackLyrics.set(null);
    });
});

// Index of the active synced line for the current playback position, or -1.
export const activeLyricIndex = derived([trackLyrics, player], ([$l, $p]) => {
  if (!$l?.synced?.length) return -1;
  const ms = ($p.currentTime || 0) * 1000;
  let idx = -1;
  for (let i = 0; i < $l.synced.length; i++) {
    if ($l.synced[i].time <= ms) idx = i;
    else break;
  }
  return idx;
});

// The active synced line's text ("" when none / not synced).
export const currentLyricLine = derived(
  [trackLyrics, activeLyricIndex],
  ([$l, $i]) => ($i >= 0 && $l?.synced ? $l.synced[$i].text || "" : "")
);
