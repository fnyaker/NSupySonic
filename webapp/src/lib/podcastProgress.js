// Per-episode playback position for podcasts, so an episode resumes exactly
// where you left it — even days later, on a different queue. Kept client-side
// in localStorage (keyed by the episode UUID, which is the track's deezer_id),
// mirroring how the player already persists its session position. A tiny
// writable mirror lets the podcast views paint a resume bar reactively.

import { writable } from "svelte/store";

const KEY = "podcast.progress";
// Cap the number of remembered episodes so the store can't grow unbounded;
// the oldest-touched entries are dropped first.
const MAX = 400;
// Don't bother remembering the first few seconds (an accidental tap) …
const MIN_SAVE = 8;
// … and treat "almost at the end" as finished — clear it so a completed
// episode doesn't offer to resume 20 s from the credits.
const DONE_TAIL = 30;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

// { [episodeId]: { t: seconds, d: duration, at: epoch-ms } }
let map = load();
export const podcastProgress = writable(map);

function persist() {
  const entries = Object.entries(map);
  if (entries.length > MAX) {
    entries.sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
    map = Object.fromEntries(entries.slice(0, MAX));
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* ignore quota — the position is a nicety, not critical */
  }
  podcastProgress.set(map);
}

export function getEpisodeProgress(id) {
  return map[String(id)] || null;
}

// Store the current position for an episode. A position past DONE_TAIL of the
// end (or below MIN_SAVE) is not a useful resume point, so it clears instead.
export function saveEpisodeProgress(id, t, d) {
  id = String(id);
  if (!id || !Number.isFinite(t)) return;
  const dur = Number.isFinite(d) && d > 0 ? d : 0;
  if (dur && t >= dur - DONE_TAIL) {
    clearEpisodeProgress(id);
    return;
  }
  if (t < MIN_SAVE) return;
  map = { ...map, [id]: { t, d: dur, at: Date.now() } };
  persist();
}

export function clearEpisodeProgress(id) {
  id = String(id);
  if (!(id in map)) return;
  map = { ...map };
  delete map[id];
  persist();
}
