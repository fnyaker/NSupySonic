// How fast a podcast plays. Remembered per show, never applied to music.
import { derived, get } from "svelte/store";
import { current, podcastSpeeds } from "./stores.js";

export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** The key a show's speed is kept under (an old queue may lack channel_id). */
export function speedKey(track) {
  if (!track || !track.podcast) return null;
  const k = track.channel_id ?? track.album?.deezer_id ?? null;
  return k == null ? null : String(k);
}

/** A stored value is only believed if it is a rate the element can play. */
export function sane(v) {
  const r = +v;
  return Number.isFinite(r) && r >= 0.5 && r <= 4 ? r : 1;
}

/** The rate for `track` given the stored map: 1 for anything but an episode. */
export function speedFor(track, map) {
  const k = speedKey(track);
  return k === null ? 1 : sane(map && map[k] !== undefined ? map[k] : 1);
}

/** The rate of what is playing now. */
export const currentSpeed = derived([current, podcastSpeeds], ([$c, $m]) => speedFor($c, $m));

/** Remember `rate` for the show `track` belongs to (1 forgets it). */
export function setSpeed(track, rate) {
  const k = speedKey(track);
  if (k === null) return;
  const r = sane(rate);
  podcastSpeeds.update((m) => {
    const next = { ...m };
    if (r === 1) delete next[k];
    else next[k] = r;
    return next;
  });
}

/** "1,25×", "1×" — French decimal comma. */
export function speedLabel(r) {
  return String(+r.toFixed(2)).replace(".", ",") + "×";
}

export const speedOf = (track) => speedFor(track, get(podcastSpeeds));
