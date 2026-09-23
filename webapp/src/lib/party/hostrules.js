// What the host publishes while its player is BETWEEN two states — loading the
// next track, rebuffering, handing over — as a pure decision, so it can be
// tested without a browser (host.js does the reading and the sending).
//
// The player is watched, never driven, so there are moments when what it is
// doing and what guests should hear differ:
//
//  - The store names the new track the instant the user skips, while the
//    element is still playing the old one (the new source is resolved, and on
//    a softened skip faded, before it is attached). A reading taken then is
//    the OLD track's position under the NEW track's name — which is exactly
//    what used to go out: guests started the new track two minutes in, and
//    then sat in silence "waiting" for the host to catch up with a position it
//    never had. host.js only reads a position off an element that carries the
//    track (`onTrack`); until then the track is announced as loading.
//  - A track the host is loading is silent at the host, so it is announced as
//    NOT playing (`buf`: guests stop the old track at once and say "loading"
//    rather than "paused"), and its line goes out the moment the element
//    really plays it.
//  - Except the handover guests were TOLD about: they have already started the
//    next track on their own prediction, and a "loading" in between would stop
//    the very thing that lets them start on the beat. That one is held — for
//    as long as a slow start could take — and confirmed by its real line.
//  - A hiccup in a track guests are playing is held too: a few hundred
//    milliseconds of rebuffering is not worth stopping a room for. Held means
//    NOTHING is published, rather than a line frozen on a position the element
//    is not moving from.

import { serverTimeAt } from "./timeline.js";

export const STALL_MS = 400; // a stall longer than this is announced
export const HANDOVER_HOLD_MS = 3000; // the longest start a predicted handover waits for
export const HANDOVER_EARLY_MS = 1500; // a move this close before the planned point IS the handover

export const HOLD = "hold";

// Did the player reach `id` by the handover guests were told to expect: the
// next track that was announced, at about the point it was announced for?
// A skip to that same track minutes earlier is a skip.
export function announcedHandover(pub, id, t) {
  if (!pub || !pub.playing || pub.id === id) return false;
  const n = pub.next;
  if (!n || !n.track || n.track.id !== id) return false;
  return t >= serverTimeAt(pub, n.at) - HANDOVER_EARLY_MS;
}

// `pub`: what guests currently believe ({ id, t, p, playing, next }).
// `running`: the element is audibly playing THIS track. `wants`: the player
// means to be playing it. `waited`: ms it has wanted to without running.
// `t`: now, on the party clock. Returns HOLD (publish nothing) or
// { playing, buf }.
export function hostPhase({ pub, id, running, wants, waited, t }) {
  if (running) return { playing: true, buf: false };
  if (!wants) return { playing: false, buf: false };
  if (pub && pub.id === id && pub.playing && waited < STALL_MS) return HOLD;
  if (announcedHandover(pub, id, t) && waited < HANDOVER_HOLD_MS) return HOLD;
  return { playing: false, buf: true };
}

// What the element's state says, for a track the store names. `onTrack`: the
// element carries that track (not the previous one it still holds between a
// skip and the new source being attached). An element that just ENDED is still
// on its way somewhere while the player means to play: the queue is a task away
// from moving on.
export function elementState({ onTrack, paused, ended, readyState, intent }) {
  const running = onTrack && !paused && !ended && readyState >= 3;
  const wants = onTrack ? (!paused && !ended) || (ended && !!intent) : !!intent;
  return { running, wants };
}

// The state to publish: HOLD, or { playing, buf, p, handover }. The position is
// read off an element that carries the track (`fitPos`, its fitted line, while
// it runs; `heard` while it does not) — and while it does not carry it yet, it
// is the start guests were told about, never the previous track's position.
export function hostState({ pub, id, onTrack, running, wants, waited, t, heard, fitPos }) {
  const phase = hostPhase({ pub, id, running, wants, waited, t });
  if (phase === HOLD) return HOLD;
  const handover = announcedHandover(pub, id, t);
  const p = running ? fitPos : onTrack ? heard : handover ? pub.next.start || 0 : 0;
  return { playing: phase.playing, buf: phase.buf, p, handover };
}
