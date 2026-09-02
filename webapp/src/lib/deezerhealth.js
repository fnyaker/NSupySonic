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
const OFFLINE_ID = "deezer-offline";
// Re-check periodically, and when a call fails in a way that smells like the
// credential died. Not more often than this, whatever asks.
const MIN_GAP = 60 * 1000;
const INTERVAL = 15 * 60 * 1000;
// While Deezer is unreachable the server tells us when it will try again; look
// again shortly after that instead of waiting out the full interval, so the app
// notices the recovery rather than the user noticing it first.
const RECHECK_FLOOR = 30 * 1000;
const RECHECK_CEILING = 5 * 60 * 1000;

let last = 0;
let inFlight = null;
let timer = null;
let recheck = null;

export async function checkDeezer({ force = false } = {}) {
  if (!get(user) || !get(online)) return null;
  if (inFlight) return inFlight;
  if (!force && Date.now() - last < MIN_GAP) return null;
  last = Date.now();
  inFlight = api
    .deezerStatus(force)
    .then((status) => {
      if (!status) return null;
      if (status.ok) {
        notices.dismiss(NOTICE_ID);
        notices.dismiss(OFFLINE_ID);
        clearTimeout(recheck);
        return status;
      }
      if (status.reason === "network") {
        // Deezer is not answering. That is NOT a broken account, so it must not
        // point the admin at Réglages — but it is worth saying plainly, because
        // otherwise the catalogue simply goes quiet with no explanation while
        // everything already downloaded keeps playing.
        notices.dismiss(NOTICE_ID);
        notices.push({
          id: OFFLINE_ID,
          kind: "warn",
          message:
            "Deezer est injoignable. Votre bibliothèque téléchargée reste disponible.",
        });
        scheduleRecheck(status.retry_in);
        return status;
      }
      notices.dismiss(OFFLINE_ID);
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

// Re-poll once the server says it will retry, clamped so a long back-off can't
// silence us for good and a short one can't turn this into a polling loop.
function scheduleRecheck(retryIn) {
  const delay = Math.min(
    Math.max((Number(retryIn) || 0) * 1000 + 2000, RECHECK_FLOOR),
    RECHECK_CEILING,
  );
  clearTimeout(recheck);
  recheck = setTimeout(() => {
    last = 0; // this one is expected, not a burst: let it through
    checkDeezer();
  }, delay);
}

export function initDeezerHealth() {
  // A 5xx on any call is the earliest hint the credential died — check then,
  // rather than waiting out the poll interval with a visibly broken app.
  // MIN_GAP keeps a burst of failures to a single status call.
  onServerError(() => checkDeezer());
  checkDeezer({ force: false });
  clearInterval(timer);
  clearTimeout(recheck);
  timer = setInterval(() => checkDeezer(), INTERVAL);
}

export function clearDeezerNotice() {
  notices.dismiss(NOTICE_ID);
  notices.dismiss(OFFLINE_ID);
  clearTimeout(recheck);
  last = 0;
}
