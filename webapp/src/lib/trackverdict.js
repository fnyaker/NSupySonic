// The server's verdict about the track PLAYING, as a store.
//
// The genre chip in the full-screen player used to read the live classifier
// only, which meant it appeared when three conditions happened to line up: the
// analysis engine running (so not in eco mode, and not with the visualizer
// off), the "smart" scene selected, and the classifier past its confidence
// floor several seconds into the track. Miss any one and there was no label at
// all — which is why it showed up about half the time.
//
// The server already knows. It measured the track once, and if an admin tagged
// it the answer is not even a guess. That answer is available the moment the
// track starts, does not depend on a canvas being on screen, and never changes
// its mind mid-song. So it leads, and the live reading is what covers a track
// nobody has measured yet.

import { derived, writable } from "svelte/store";
import { current } from "./stores.js";
import { knownAnalysis, onAnalysis } from "./analysis.js";

const verdict = writable(null);
let watching = null;

function refresh(id) {
  verdict.set(id ? knownAnalysis(id) : null);
}

current.subscribe(($c) => {
  const id = $c?.deezer_id ? String($c.deezer_id) : null;
  if (id === watching) return;
  watching = id;
  refresh(id);
});

// A verdict that lands late — the server had to measure the track first, or the
// admin has just tagged it from the sheet — belongs to the track on screen now.
onAnalysis((id, v) => {
  if (String(id) === watching) verdict.set(v || null);
});

/** `{ bpm, style, styleLabel, styleConfidence, styleSource, … }` or null. */
export const trackVerdict = { subscribe: verdict.subscribe };

/** The served genre name for the current track, or "" when there is none. */
export const servedStyleLabel = derived(verdict, ($v) =>
  $v && ($v.styleLabel || $v.style) ? $v.styleLabel || $v.style : ""
);

/** True when that name came from somebody tagging the track by hand. */
export const styleIsTagged = derived(verdict, ($v) => $v?.styleSource === "tag");
