// Shared lyrics state for the current track: fetched once per track and reused
// by the Paroles panel and the "current line" overlay above the cover, so we
// don't fetch or track the active line twice.

import { writable, derived, readable } from "svelte/store";
import { current, player } from "./stores.js";
import { api } from "./api.js";
import { playable } from "./ladder.js";
import { activeSource, getContext, isWired, lookaheadSeconds } from "./audio/graph.js";
import { outputLag, trimSeconds } from "./audio/latency.js";

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

// How far behind the element's own position the words are HEARD, in seconds:
// the trim alone for an element played directly (its clock already carries its
// output path), the whole graph for one routed through it — the look-ahead and
// the output latency, which with a Bluetooth headset is a fifth of a second.
// lib/audio/latency.js is the model; a line has no use for the sub-millisecond
// version of it that the listen party needs.
function heardLag(el) {
  if (!el || !isWired(el)) return trimSeconds();
  return lookaheadSeconds() + outputLag(getContext()) + trimSeconds();
}

// The position being heard, in ms: read off the playing element itself — the
// store is only written on `timeupdate`, four times a second — or the store's
// figure while nothing plays.
function heardNow(p) {
  const el = activeSource();
  const flowing = !!(el && !el.paused && el.readyState >= 3 && Number.isFinite(el.currentTime));
  const t = flowing ? el.currentTime : p?.currentTime || 0;
  return { ms: (t - heardLag(flowing ? el : null)) * 1000, flowing, rate: (flowing && el.playbackRate) || 1 };
}

// Index of the active synced line for the position being HEARD, or -1.
//
// It used to be derived from the player store, which moves on `timeupdate`:
// every line changed 0-250 ms late (125 on average), and early again by the
// whole output latency whenever the audio went through the graph. Now each
// change is recomputed from the element at the instant it is due, by a timer
// set for the next line — one timer per line, nothing ticking in between.
export const activeLyricIndex = readable(-1, (set) => {
  let lyr = null;
  let p = null;
  let timer = 0;
  let shown = -1;
  const run = () => {
    clearTimeout(timer);
    timer = 0;
    const lines = lyr?.synced;
    if (!lines?.length || !p) {
      if (shown !== -1) set((shown = -1));
      return;
    }
    const { ms, flowing, rate } = heardNow(p);
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= ms) idx = i;
      else break;
    }
    if (idx !== shown) set((shown = idx));
    const next = lines[idx + 1];
    // Capped so a stalled element is looked at again rather than trusted for
    // minutes; a store update (every timeupdate, every seek) re-arms it anyway.
    if (flowing && next) timer = setTimeout(run, Math.max(15, Math.min(5000, (next.time - ms) / rate + 1)));
  };
  const offLyrics = trackLyrics.subscribe((v) => {
    lyr = v;
    run();
  });
  const offPlayer = player.subscribe((v) => {
    p = v;
    run();
  });
  return () => {
    offLyrics();
    offPlayer();
    clearTimeout(timer);
  };
});

// The active synced line's text ("" when none / not synced).
export const currentLyricLine = derived(
  [trackLyrics, activeLyricIndex],
  ([$l, $i]) => ($i >= 0 && $l?.synced ? $l.synced[$i].text || "" : "")
);
