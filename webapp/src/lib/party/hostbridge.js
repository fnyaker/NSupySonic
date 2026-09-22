// The only part of hosting a listen party that every visitor downloads.
//
// The player has to hand its element over and say when something happened,
// and the player button has to know whether a party is on — that is all this
// is. The machinery behind it (the clock, the anchor fit, publishing:
// host.js) is loaded when somebody actually hosts, or when there is a party
// to pick back up after a reload.

import { writable } from "svelte/store";
import { api } from "../api.js";

// null, or { id, link, listeners, clock: { spread, rtt } | null, elsewhere, lost }
export const partyHost = writable(null);

let source = null;
let poke = null;

// What the player gives us (Player.svelte): the element that is audible, the
// track that element carries (null while a new one is being attached), the
// crossfade in progress, and its plan for the next track.
export function bindPartySource(s) {
  source = s;
}
export function partySource() {
  return source;
}

// Something just happened on the player (a seek, a pause): look now.
export function partyPoke() {
  if (poke) poke();
}
export function onPartyPoke(fn) {
  poke = fn;
}

export const HOST_KEY = "party.host";
export const RESUME_WINDOW = 25 * 60 * 1000; // < the server's PARTY_TTL

export function loadHost() {
  return import("./host.js");
}

// On launch: is there a party this user was hosting? One cheap request, and
// the host module only when the answer is yes.
export async function maybeResumeHosting() {
  let saved = null;
  try {
    const v = JSON.parse(localStorage.getItem(HOST_KEY) || "null");
    saved = v && v.id && Date.now() - v.at < RESUME_WINDOW ? v : null;
  } catch {
    /* private mode */
  }
  let mine = null;
  try {
    mine = (await api.partyMine()).party;
  } catch {
    return;
  }
  if (!mine && !saved) return;
  const host = await loadHost();
  await host.resumeHosting(mine, saved);
}
