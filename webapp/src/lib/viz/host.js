// Keeps the projector window fed, from the tab that is actually playing.
//
// Lives for the life of the app (started from App.svelte) but costs nothing
// until a projector window announces itself: the BroadcastChannel listener is
// idle, and only when a viewer appears does this subscribe to the analysis
// engine — which is also what starts the engine at all. Close the projector and
// the subscription goes away again, so a phone that never opens one never runs
// a beat tracker.

import { get } from "svelte/store";
import { subscribeFrames, LEVEL } from "../audio/engine.js";
import { current, offlineCovers } from "../stores.js";
import { resolveCover } from "../format.js";
import { dominantColor } from "../color.js";
import { api } from "../api.js";
import { createPublisher } from "./bridge.js";

let pub = null;
let unsub = null;
let stopStores = [];
let pruneTimer = null;

function sendMeta() {
  if (!pub || !pub.viewers) return;
  const t = get(current);
  if (!t) {
    pub.meta({ title: "", artist: "", cover: "", rgb: null });
    return;
  }
  const cover = resolveCover(get(offlineCovers), t.album?.cover) ||
    (t.deezer_id ? api.coverUrl(t.deezer_id) : "");
  pub.meta({
    title: t.title || "",
    artist: t.artist?.name || "",
    album: t.album?.title || "",
    cover,
  });
  // The dominant colour is resolved HERE rather than in the projector window:
  // it is already cached in this tab for the gradient header, and the projector
  // would otherwise re-download and re-decode every cover on its own.
  dominantColor(cover)
    .then((rgb) => pub?.viewers && pub.meta({
      title: t.title || "",
      artist: t.artist?.name || "",
      album: t.album?.title || "",
      cover,
      rgb,
    }))
    .catch(() => {});
}

function attach() {
  if (unsub) return;
  // SMART: the projector is the one place where the full engine is always worth
  // running — it is a dedicated screen, and the window that owns it is normally
  // the only thing the machine is doing.
  unsub = subscribeFrames((f) => pub.send(f), LEVEL.SMART);
  sendMeta();
}

function detach() {
  unsub?.();
  unsub = null;
}

export function initVizHost() {
  if (pub) return;
  pub = createPublisher({
    onViewers(n) {
      n > 0 ? attach() : detach();
    },
  });
  stopStores = [current.subscribe(sendMeta), offlineCovers.subscribe(sendMeta)];
  // Viewers announce themselves with a ping; a window closed without a chance
  // to say goodbye (a crash, a killed tab) is only noticed by its pings drying
  // up, so sweep on a timer as well as on each message.
  pruneTimer = setInterval(() => pub?.prune?.(), 3000);
}

export function stopVizHost() {
  detach();
  clearInterval(pruneTimer);
  pruneTimer = null;
  for (const s of stopStores) s();
  stopStores = [];
  pub?.close();
  pub = null;
}

// Opens (or re-focuses) the projector window. A plain window.open on the SPA's
// own hash route: same origin, so the BroadcastChannel reaches it, and the user
// can drag it to the second screen and press F11 like any other page.
export function openProjector() {
  const url = new URL(window.location.href);
  url.hash = "#/viz";
  const w = window.open(url.toString(), "nsupysonic-viz");
  w?.focus();
  return !!w;
}
