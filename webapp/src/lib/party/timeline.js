// The party timeline, as pure arithmetic. Everything here is in the SERVER's
// clock (milliseconds) and track positions (seconds) — see clock.js for how a
// device maps its own clock onto it.
//
// A timeline is { id, t, p, playing }: track `id` was at position `p` at server
// time `t`, and advances in real time while `playing`. The host publishes one
// (the anchor); guests schedule their audio against it.

export function positionAt(tl, serverMs) {
  if (!tl) return 0;
  return tl.playing ? tl.p + (serverMs - tl.t) / 1000 : tl.p;
}

// When a playing timeline reaches `pos` (server ms).
export function serverTimeAt(tl, pos) {
  return tl.t + (pos - tl.p) * 1000;
}

// Where the host will hand over to the next track, in server ms: the point in
// the current track it takes over (`at`), plus how late the host's own player
// usually is to actually start it (`gap`, seconds).
export function handoverTime(tl, next) {
  return serverTimeAt(tl, next.at) + (next.gap || 0) * 1000;
}

// The predicted timeline of the next track, so guests can start it on time
// instead of a poll after the host did.
export function nextTimeline(tl, next) {
  return { id: next.track.id, t: handoverTime(tl, next), p: next.start || 0, playing: true };
}

// -- corrections ---------------------------------------------------------------
//
// A device already playing is told the timeline moved (a re-anchor, a
// correction of the predicted handover, its own clock estimate improving). How
// it follows depends on how far off it is, `err` = where it IS minus where it
// SHOULD be, in ms:
//
//  - within KEEP_MS: noise. Nothing audible to gain, so nothing is touched.
//  - within SEAM_MS: the next chunk seam absorbs it. Each chunk is scheduled
//    from the timeline in force when it is scheduled, and the two sides of a
//    seam are crossfaded over the chunks' overlap — so a small step lands
//    there, inaudibly, instead of cutting the audio now.
//  - behind by more: jump forward now (a short crossfade), losing what the
//    others already heard — there is no way to catch up without skipping.
//  - AHEAD by more: stop now and resume the same audio when the timeline gets
//    there. Never replay what was just played: a moment of silence is far less
//    noticeable than a stutter that repeats a beat.
export const KEEP_MS = 3;
export const SEAM_MS = 30;

export function correctionFor(errMs) {
  const a = Math.abs(errMs);
  if (a <= KEEP_MS) return "keep";
  if (a <= SEAM_MS) return "seam";
  return errMs < 0 ? "jump" : "wait";
}

// -- chunks ----------------------------------------------------------------------

// The chunk that holds position `pos` (chunk k covers [k·L, k·L + L + ov)).
export function chunkIndex(pos, len) {
  return Math.max(0, Math.floor(pos / len + 1e-9));
}

// The last chunk index of a track of `duration` seconds (unknown -> Infinity).
// A catalogue duration is whole seconds and may be short of the file by up to
// one, so the bound allows for that second; a chunk asked for past the real end
// simply comes back empty, which the scheduler reads as "the track ends here".
export function lastChunk(duration, len) {
  if (!(duration > 0)) return Infinity;
  return Math.max(0, Math.ceil((duration + 1) / len) - 1);
}
