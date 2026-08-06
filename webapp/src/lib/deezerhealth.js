// Deezer account health, surfaced as a notice.
//
// The whole catalogue hangs off ONE credential (the ARL), and it expires. When
// it does, every discovery call starts failing and the app looks broken for no
// visible reason — the server knows exactly what happened, so it should say so:
// the admin gets an actionable notice pointing at Réglages, everyone else gets
// an explanation instead of a mystery.

import { get } from "svelte/store";
import { push } from "svelte-spa-router";
import { api, onServerError } from "./api.js";
import { online } from "./net.js";
import { notices, user } from "./stores.js";

const NOTICE_ID = "deezer-arl";
// Re-check periodically, and when a call fails in a way that smells like the
// credential died. Not more often than this, whatever asks.
const MIN_GAP = 60 * 1000;
const INTERVAL = 15 * 60 * 1000;

let last = 0;
let inFlight = null;
let timer = null;

export async function checkDeezer({ force = false } = {}) {
  if (!get(user) || !get(online)) return null;
  if (inFlight) return inFlight;
  if (!force && Date.now() - last < MIN_GAP) return null;
  last = Date.now();
  inFlight = api
    .deezerStatus(force)
    .then((status) => {
      if (!status) return null;
      if (status.ok || status.reason === "network") {
        // A network blip is not a broken account — the offline indicator
        // already covers that, so don't cry wolf about the credential.
        notices.dismiss(NOTICE_ID);
        return status;
      }
      notices.push({
        id: NOTICE_ID,
        kind: "error",
        message: status.message || "Le compte Deezer n'est plus accessible.",
        actionLabel: status.admin ? "Réglages" : undefined,
        action: status.admin ? () => push("/settings") : undefined,
      });
      return status;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function initDeezerHealth() {
  // A 5xx on any call is the earliest hint the credential died — check then,
  // rather than waiting out the poll interval with a visibly broken app.
  // MIN_GAP keeps a burst of failures to a single status call.
  onServerError(() => checkDeezer());
  checkDeezer({ force: false });
  clearInterval(timer);
  timer = setInterval(() => checkDeezer(), INTERVAL);
}

export function clearDeezerNotice() {
  notices.dismiss(NOTICE_ID);
  last = 0;
}
