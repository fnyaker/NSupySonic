// The order the app is allowed to want things in.
//
// A track change used to put seven requests on the wire in the same instant:
// the audio, the artwork (twice), the lyrics, the loudness, the play count and
// the silence bounds of the NEXT track. They share one connection to one server
// with a small pool of threads, so every one of them is something the audio has
// to queue behind — and the audio is the only one somebody pressed a button
// for. On a good link it cost a few hundred milliseconds; on a busy server it
// was the difference between music and a spinner.
//
// So there is an order, and it is not negotiable:
//
//   1. the audio of the track that is playing
//   2. its artwork — on screen, and on the lock screen
//   3. its genre and tempo — the animation wants them, a second late is fine
//   4. everything else about it: lyrics, silence bounds, the play count
//   5. the tracks AFTER it (prefetch, caches, pre-archiving — elsewhere)
//
// Tiers 2 and below wait for the audio to be playable, and then run ONE AT A
// TIME rather than all at once, because four requests in parallel finish no
// sooner than four in a row and the first of them finishes much later.

import { writable } from "svelte/store";

export const TIER = { ART: 0, VERDICT: 1, EXTRA: 2 };

// How long to wait for "this track can play" before running the rest anyway. A
// track that never loads must not also mean no artwork and no lyrics for ever —
// and a session restored paused has `preload="none"`, so its element genuinely
// will not report anything until somebody presses play.
const AUDIO_TIMEOUT = 6000;

/** The id of the track whose audio is ready to play, or null. */
export const playable = writable(null);

let activeId = null;
let settled = false;
let queue = [];
let timer = null;

function key(id) {
  return id === null || id === undefined ? null : String(id);
}

/** A new current track: whatever the previous one was still waiting for, drop it. */
export function beginTrack(id) {
  activeId = key(id);
  settled = false;
  queue = [];
  playable.set(null);
  clearTimeout(timer);
  timer = activeId
    ? setTimeout(() => audioReady(activeId), AUDIO_TIMEOUT)
    : null;
}

/** The element can play this track — release everything waiting on it. */
export function audioReady(id) {
  id = key(id);
  if (!id || id !== activeId || settled) return;
  settled = true;
  clearTimeout(timer);
  timer = null;
  playable.set(id);
  const due = queue.sort((a, b) => a.tier - b.tier);
  queue = [];
  drain(id, due);
}

async function drain(id, due) {
  for (const item of due) {
    // A skip while the ladder was walking it: the rest is about a track nobody
    // is listening to any more.
    if (id !== activeId) return;
    try {
      await item.fn();
    } catch {
      /* every rung is best-effort; one failure must not strand the next */
    }
  }
}

/**
 * Run `fn` once the current track is playable, after everything in a lower
 * tier. Registered after the fact (a view that mounts mid-track), it simply
 * runs now.
 */
export function whenReady(tier, fn) {
  if (settled) {
    Promise.resolve()
      .then(fn)
      .catch(() => {});
    return;
  }
  queue.push({ tier, fn });
}

/**
 * Attach the readiness signal to an <audio> element. Returns a detach function.
 *
 * Two events, because neither alone is enough: `loadeddata` is the earliest
 * honest "there is audio here", and `canplay` is what a source that reports no
 * duration (a live transcode) gets to first.
 */
export function watchAudio(el, id) {
  if (!el) return () => {};
  const fire = () => audioReady(id);
  el.addEventListener("loadeddata", fire);
  el.addEventListener("canplay", fire);
  el.addEventListener("playing", fire);
  return () => {
    el.removeEventListener("loadeddata", fire);
    el.removeEventListener("canplay", fire);
    el.removeEventListener("playing", fire);
  };
}
