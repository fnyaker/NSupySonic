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
import { current, offlineCovers, playing } from "../stores.js";
import { resolveCover } from "../format.js";
import { dominantColor } from "../color.js";
import { api } from "../api.js";
import { createPublisher } from "./bridge.js";

let pub = null;
let unsub = null;
// The level the projector asked for. The engine's own `recomputeLevel` then
// takes the maximum of this and whatever this tab's own visualizer wants, so
// "the most demanding of the two decides" needs no arbitration here — one
// subscription per consumer, and the engine already maxes them.
let wantLevel = LEVEL.SMART;
// ...and the same for the raw samples, which are orthogonal to the level: a
// projector showing the oscilloscope wants the waveform and none of the ladder,
// so it asks for the two separately.
let wantWave = 0;
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

// The engine runs for the projector only while somebody is watching AND
// something is actually playing. A paused player keeps sending its heartbeat,
// so the projector still knows it is there — it just has nothing to draw, and
// analysing silence to tell it so would be pure battery.
function syncEngine() {
  const want = !!pub && pub.viewers > 0 && get(playing);
  if (want && !unsub) {
    unsub = subscribeFrames((f) => pub.send(f), wantLevel, { wave: wantWave });
    sendMeta();
  } else if (!want && unsub) {
    unsub();
    unsub = null;
  }
}

/** The projector changed what it needs: re-subscribe at the new level/window. */
function setNeeds(lv, wv) {
  const next = Number.isFinite(lv) ? lv : LEVEL.SMART;
  const wave = Math.max(0, wv | 0);
  if (next === wantLevel && wave === wantWave) return;
  wantLevel = next;
  wantWave = wave;
  if (unsub) {
    unsub();
    unsub = null;
    syncEngine();
  }
}

function detach() {
  unsub?.();
  unsub = null;
}

export function initVizHost() {
  if (pub) return;
  pub = createPublisher({
    onViewers(count, level, wave) {
      setNeeds(level, wave);
      syncEngine();
      void count;
    },
  });
  stopStores = [
    current.subscribe((t) => {
      pub?.state(get(playing), !!t);
      sendMeta();
    }),
    offlineCovers.subscribe(sendMeta),
    playing.subscribe((p) => {
      pub?.state(p, !!get(current));
      syncEngine();
    }),
  ];
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
