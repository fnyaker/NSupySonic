// The sleep timer: stop the music after a while, or at the end of the track.
//
// Two shapes, one store:
//   { kind: "minutes", minutes, endsAt }  — a wall-clock deadline
//   { kind: "track" }                     — when the playing track ends
//
// The deadline is compared with Date.now(), never counted down in ticks: a
// page that is throttled, frozen or asleep for a while (which is what a phone
// on a bedside table is) still ends up where the clock says it should. The
// last SLEEP_FADE_MS bring the volume down instead of cutting it — through
// `sleepFade`, a multiplier the audio owner applies on top of the volume, so
// the user's own level is never touched and never has to be put back.
//
// When it fires the player is PAUSED, not stopped: the queue and the position
// are where they were, and one tap on play resumes.
import { writable, get } from "svelte/store";
import { player } from "./stores.js";

export const SLEEP_CHOICES = [5, 10, 15, 30, 45, 60, 90]; // minutes
export const SLEEP_FADE_MS = 15000;

/** null, or the timer that is running. */
export const sleepTimer = writable(null);
/** 0..1, what the audio owner multiplies the volume by. */
export const sleepFade = writable(1);

let tick = null;

function halt() {
  if (tick !== null) clearInterval(tick);
  tick = null;
}

/** The gain for `left` ms still to go: 1 before the fade, 0 at the end. */
export function fadeAt(left) {
  if (left >= SLEEP_FADE_MS) return 1;
  if (left <= 0) return 0;
  // Amplitude squared: what the ear hears as an even ramp down.
  const x = left / SLEEP_FADE_MS;
  return x * x;
}

function fire() {
  halt();
  sleepTimer.set(null);
  player.pause();
  // Put the level back only once the element is really paused, or the last
  // instant of the track comes back at full volume.
  setTimeout(() => sleepFade.set(1), 400);
}

function step(now = Date.now()) {
  const t = get(sleepTimer);
  if (!t || t.kind !== "minutes") return halt();
  const left = t.endsAt - now;
  if (left <= 0) return fire();
  const g = fadeAt(left);
  if (g !== get(sleepFade)) sleepFade.set(g);
}

export function cancelSleep() {
  halt();
  sleepTimer.set(null);
  sleepFade.set(1);
}

/** Stop in `minutes` minutes. */
export function sleepIn(minutes, now = Date.now()) {
  halt();
  sleepFade.set(1);
  sleepTimer.set({ kind: "minutes", minutes, endsAt: now + minutes * 60000 });
  tick = setInterval(step, 250);
}

/** Stop when the playing track ends (and line up the next one). */
export function sleepAtTrackEnd() {
  halt();
  sleepFade.set(1);
  sleepTimer.set({ kind: "track" });
}

/** Is the player going to stop where the current track ends? Read by what
 *  would otherwise hand over early (the crossfade, the silence trim). */
export function sleepStopsAtTrackEnd() {
  const t = get(sleepTimer);
  return !!t && t.kind === "track";
}

/**
 * The current track has ended: if that is what the timer was waiting for,
 * spend it — line the next track up, paused — and say so.
 */
export function finishSleepAtTrackEnd() {
  if (!sleepStopsAtTrackEnd()) return false;
  cancelSleep();
  player.advancePaused();
  return true;
}

/** "12 min", "45 s": what is left, for the button. */
export function leftLabel(t, now = Date.now()) {
  if (!t) return "";
  if (t.kind === "track") return "fin du titre";
  // Never more than was asked for: a reading taken a moment before the timer
  // was set (a stale `now`) must not say "6 min" for a 5 minute timer.
  const ms = Math.min(t.minutes * 60000, Math.max(0, t.endsAt - now));
  if (ms >= 60000) return Math.ceil(ms / 60000) + " min";
  return Math.max(1, Math.ceil(ms / 1000)) + " s";
}
