// Per-episode playback position for podcasts, so an episode resumes exactly
// where you left it — even days later, on another device. localStorage is the
// instant, offline-first copy (keyed by the episode UUID, which is the track's
// deezer_id); the server keeps the authoritative per-user copy and the two are
// merged newest-wins at login. A tiny writable mirror lets the podcast views
// paint resume bars reactively.

import { writable } from "svelte/store";
import { api } from "./api.js";

const KEY = "podcast.progress";
// Cap the number of remembered episodes so the store can't grow unbounded;
// the oldest-touched entries are dropped first.
const MAX = 400;
// Don't bother remembering the first few seconds (an accidental tap) …
const MIN_SAVE = 8;
// … and treat "almost at the end" as finished, so a completed episode doesn't
// offer to resume 20 s from the credits (it shows as "Terminé" instead).
const DONE_TAIL = 15;
// Push to the server at most this often per episode during playback; pauses
// and page-hides push immediately (force).
const SYNC_MIN_MS = 15000;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

// { [episodeId]: { t: seconds, d: duration, at: epoch-ms, done: bool } }
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

// -- server sync -------------------------------------------------------------

const lastSync = {}; // episodeId -> epoch-ms of last successful-ish push

function pushToServer(id, entry, force = false) {
  const nowMs = Date.now();
  if (!force && nowMs - (lastSync[id] || 0) < SYNC_MIN_MS) return;
  lastSync[id] = nowMs;
  api
    .savePodcastProgress(id, Math.round(entry.t || 0), Math.round(entry.d || 0), !!entry.done)
    .catch(() => {
      // Let the next tick retry sooner than a full throttle window.
      lastSync[id] = nowMs - SYNC_MIN_MS + 3000;
    });
}

// Pull the server-side map and merge it (newest write wins on both sides),
// then push back any local entries the server hasn't seen. Called at login.
let synced = false;
export async function initPodcastProgress() {
  if (synced) return;
  synced = true;
  let remote;
  try {
    remote = (await api.podcastProgress()).progress || {};
  } catch {
    synced = false; // offline boot: retry on the next call
    return;
  }
  const merged = { ...map };
  const toPush = [];
  for (const [id, r] of Object.entries(remote)) {
    const at = (r.updated || 0) * 1000;
    const local = merged[id];
    if (!local || at >= (local.at || 0)) {
      merged[id] = { t: r.position || 0, d: r.duration || 0, at, done: !!r.finished };
    }
  }
  for (const [id, local] of Object.entries(map)) {
    const r = remote[id];
    if (!r || (local.at || 0) > (r.updated || 0) * 1000 + 2000) toPush.push(id);
  }
  map = merged;
  persist();
  // Backfill the server with local-only positions (bounded — this is a
  // one-time catch-up, not a bulk import).
  for (const id of toPush.slice(0, 25)) pushToServer(id, map[id], true);
}

// -- writes ------------------------------------------------------------------

// Store the current position for an episode. Near the end it flips to
// "finished" (no resume offered); below MIN_SAVE it's ignored as noise.
// `force` pushes to the server immediately (pause / page-hide / track change).
export function saveEpisodeProgress(id, t, d, force = false) {
  id = String(id);
  if (!id || !Number.isFinite(t)) return;
  const dur = Number.isFinite(d) && d > 0 ? d : 0;
  if (dur && t >= dur - DONE_TAIL) {
    markEpisodeFinished(id, dur);
    return;
  }
  if (t < MIN_SAVE) return;
  map = { ...map, [id]: { t, d: dur, at: Date.now(), done: false } };
  persist();
  pushToServer(id, map[id], force);
}

// An explicit resume point (a marker jump, a "reprendre ici"): bypasses the
// MIN_SAVE noise filter so the player's next load starts exactly there.
export function setResumePoint(id, t, d = 0) {
  id = String(id);
  if (!id || !Number.isFinite(t)) return;
  map = { ...map, [id]: { t: Math.max(0, t), d: d || map[id]?.d || 0, at: Date.now(), done: false } };
  persist();
}

// The episode played to the end: keep it, flagged done, so the show page can
// say "Terminé" — and never offer a resume into the credits.
export function markEpisodeFinished(id, d = 0) {
  id = String(id);
  const dur = d || map[id]?.d || 0;
  map = { ...map, [id]: { t: dur, d: dur, at: Date.now(), done: true } };
  persist();
  pushToServer(id, map[id], true);
}

export function clearEpisodeProgress(id) {
  id = String(id);
  if (!(id in map)) return;
  map = { ...map };
  delete map[id];
  persist();
}
