// Hosting a listen party: publish where THIS player is, on the shared clock, so
// every guest can play the same instant.
//
// The host's player is left exactly as it is — its two <audio> elements, its
// crossfade, its trimming, its effects. This module only WATCHES it: four times
// a second it reads the active element's position against the party clock
// (clock.js), fits the readings to a line (anchor.js), and publishes that line
// whenever it stops describing the player — a new track, a pause, a seek, a
// stall, or the element's own audio clock drifting a couple of milliseconds off
// it. Between those, nothing is sent but a heartbeat: guests extrapolate.
//
// It also publishes what comes NEXT and where — the point in this track the
// player will hand over, the next track's trimmed start, the crossfade length
// and how late this player usually is to actually start it — which is what
// lets guests start the next track on the beat instead of a poll after the
// host did.

import { get } from "svelte/store";
import { api } from "../api.js";
import { current, normalization } from "../stores.js";
import { getContext, isWired, lookaheadSeconds } from "../audio/graph.js";
import { gainFor } from "../gaincache.js";
import { artistLine } from "../format.js";
import { startClock } from "./clock.js";
import { AnchorFit } from "./anchor.js";
import { positionAt, serverTimeAt } from "./timeline.js";
import { compressorDelay } from "./latency.js";
import { HOST_KEY, onPartyPoke, partyHost, partySource } from "./hostbridge.js";

export { partyHost };

const MEASURE_MS = 250;
const HEARTBEAT_MS = 10_000;
const DRIFT_S = 0.0025; // republish when the player is this far off its line
const JUMP_S = 0.25; // ...and at once when it is this far (a seek, a stall)
const STALL_MS = 400; // buffering this long counts as a pause
const MIN_GAP_MS = 150; // between two publishes of the same track
const STORE_KEY = HOST_KEY;

let session = null;

// Something just happened on the player (a seek, a pause): look now rather
// than at the next tick.
onPartyPoke(() => {
  if (session && !session.elsewhere) setTimeout(measure, 0);
});

// -- lifecycle ---------------------------------------------------------------

export async function startParty() {
  if (session) return get(partyHost);
  const view = await api.partyStart();
  await begin(view);
  return get(partyHost);
}

// On launch: pick up the party this user was hosting (a reload, or the server
// restarting under it), so its guests are not stranded on a dead link.
// `mine` is what the server says (hostbridge.js asked), `saved` what this
// browser remembers hosting.
export async function resumeHosting(mine, saved) {
  if (session) return;
  if (mine) return begin(mine);
  if (!saved) return;
  try {
    const view = await api.partyStart({ resume: saved.id });
    if (view.id === saved.id) await begin(view);
    else {
      // Somebody else holds that id now; this user did not ask for a new party.
      await api.partyEnd(view.id).catch(() => {});
      clearSaved();
    }
  } catch {
    /* offline: try again next launch */
  }
}

export async function endParty() {
  const s = session;
  if (!s) return;
  stop();
  clearSaved();
  partyHost.set(null);
  try {
    await api.partyEnd(s.id);
  } catch {
    /* it expires on its own */
  }
}

export function partyLink(id) {
  // Relative to where the app is served, so a deployment under a path prefix
  // still hands out a working link.
  return new URL(`../party/${id}`, window.location.origin + window.location.pathname).href;
}

async function begin(view) {
  const comp = await compressorDelay();
  const s = {
    id: view.id,
    fit: new AnchorFit(),
    fitId: null,
    pub: null, // what guests currently believe
    inflight: false,
    dirty: false,
    lastSent: 0,
    stallSince: 0,
    comp,
    gaps: { cut: null, fade: null },
    gapProbe: null,
    xfade: { id: null, v: 0 },
    elsewhere: false,
  };
  session = s;
  partyHost.set({
    id: view.id,
    link: partyLink(view.id),
    listeners: view.listeners || [],
    clock: null,
    elsewhere: false,
    lost: false,
  });
  // One tab publishes. A second tab of the same account (or the same tab
  // reloaded while the old one lingers) would otherwise fight it for the
  // timeline — and an idle one publishes "nothing playing" over a party.
  if (!(await takeLock())) {
    s.elsewhere = true;
    partyHost.update((h) => h && { ...h, elsewhere: true });
    return;
  }
  save(s.id);
  s.clock = startClock(`/api/party/${s.id}/clock`, (e) => {
    partyHost.update((h) => h && { ...h, clock: e ? { spread: e.spread, rtt: e.rtt } : null });
    measure();
  });
  s.timer = setInterval(measure, MEASURE_MS);
  s.hb = setInterval(heartbeat, HEARTBEAT_MS);
  window.addEventListener("pagehide", onPageHide);
  // Where this player is on the shared clock: the fitted line it publishes,
  // and the raw reading behind it. Read-only, for the console and the
  // end-to-end check.
  (window.__nsParty = window.__nsParty || {}).host = () => {
    const est = s.clock && s.clock.now();
    const src = partySource();
    const el = src && src.element && src.element();
    if (!est || !el) return null;
    const now = performance.now();
    return {
      S: now + est.offset,
      id: s.fitId,
      pos: s.fit.positionAt(now),
      raw: el.currentTime - latencyOf(el),
      latency: latencyOf(el),
      published: s.pub && { t: s.pub.t, p: s.pub.p, playing: s.pub.playing },
      clock: est,
    };
  };
}

function stop() {
  const s = session;
  if (!s) return;
  session = null;
  if (s.clock) s.clock.stop();
  clearInterval(s.timer);
  clearInterval(s.hb);
  window.removeEventListener("pagehide", onPageHide);
  if (window.__nsParty) delete window.__nsParty.host;
  if (releaseLock) releaseLock();
  releaseLock = null;
}

let releaseLock = null;
function takeLock() {
  if (!navigator.locks || !navigator.locks.request) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks
      .request("nsupysonic-party-host", { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return new Promise((release) => (releaseLock = release));
      })
      .catch(() => resolve(true));
  });
}

function save(id) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ id, at: Date.now() }));
  } catch {
    /* private mode */
  }
}
function clearSaved() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
}

// -- measuring -----------------------------------------------------------------

// How far behind its own currentTime this element is HEARD. An element played
// directly carries its output latency in currentTime already; one routed
// through the Web Audio graph (effects, crossfade, visualizer) is heard after
// the graph: the analysis lookahead, the two compressors' lookahead and the
// context's own output latency.
function latencyOf(el) {
  if (!isWired(el)) return 0;
  const ctx = getContext();
  const out = ctx ? (ctx.baseLatency || 0) + (ctx.outputLatency || 0) : 0;
  return lookaheadSeconds() + 2 * (session ? session.comp : 0) + out;
}

function trackInfo(t) {
  return {
    id: String(t.deezer_id),
    title: t.title || "",
    artist: artistLine(t) || "",
    album: (t.album && t.album.title) || "",
    duration: t.duration || 0,
    podcast: !!t.podcast,
    gain: gainFor(t),
  };
}

function measure() {
  const s = session;
  if (!s || s.elsewhere || !s.clock) return;
  const est = s.clock.now();
  if (!est) return; // no clock yet: an anchor would be meaningless
  const track = get(current);
  const source = partySource();
  const el = source && source.element && source.element();
  const tNow = performance.now();
  if (!track || !el) {
    if (!s.retry && s.pub && s.pub.id === null) return;
    return send(s, { id: null });
  }
  const a = performance.now();
  const raw = el.currentTime;
  const b = performance.now();
  const at = (a + b) / 2;
  const heard = Math.max(0, raw - latencyOf(el));
  const id = String(track.deezer_id);
  if (id !== s.fitId) {
    s.fit.reset();
    s.fitId = id;
  }

  // Playing, paused, or buffering — and buffering long enough is a pause:
  // guests should hold rather than run ahead of a player that stopped.
  const running = !el.paused && !el.ended && el.readyState >= 3;
  let playing = running;
  if (!el.paused && !el.ended && !running) {
    if (!s.stallSince) s.stallSince = tNow;
    playing = tNow - s.stallSince < STALL_MS && !!(s.pub && s.pub.playing);
  } else s.stallSince = 0;

  let broke = false;
  if (running) broke = !s.fit.add(at, heard);
  else s.fit.reset();
  const p = running ? s.fit.positionAt(tNow) : heard;
  const t = (running ? tNow : at) + est.offset;

  // The crossfade that brought this track in, if one did.
  if (s.xfade.id !== id) s.xfade = { id, v: (source.xfading && source.xfading()) || 0 };

  // A handover we announced has happened: learn how late this player was to
  // start the next track, so the next prediction lands where it will be.
  if (s.gapProbe && s.gapProbe.id === id && running && s.fit.n >= 6) {
    const startedAt = t + (s.gapProbe.start - p) * 1000;
    const g = (startedAt - s.gapProbe.predicted) / 1000;
    if (g > -0.05 && g < 2.5) {
      const k = s.gapProbe.fade ? "fade" : "cut";
      const old = s.gaps[k];
      s.gaps[k] = old == null ? Math.max(0, g) : Math.max(0, old * 0.5 + g * 0.5);
    }
    s.gapProbe = null;
  }

  const plan = playing ? planNext(s) : null;
  const nextKey = plan
    ? [plan.track.id, plan.at.toFixed(3), plan.start.toFixed(3), plan.fade, plan.gap.toFixed(3)].join("|")
    : "";
  const norm = get(normalization) || "off";

  const pub = s.pub;
  let need =
    s.retry ||
    !pub ||
    pub.id !== id ||
    pub.playing !== playing ||
    pub.nextKey !== nextKey ||
    pub.norm !== norm;
  if (!need && playing) {
    const drift = Math.abs(positionAt({ t: pub.t, p: pub.p, playing: true }, t) - p);
    if (broke || drift > JUMP_S) need = true;
    else if (s.fit.n >= 8 && drift > DRIFT_S && tNow - s.lastSent > MIN_GAP_MS) need = true;
  } else if (!need && !playing && Math.abs(pub.p - p) > 0.05) {
    need = true; // seeked while paused
  }
  if (!need) return;

  // Remember what we predicted, to measure the real gap once it happens.
  if (pub && pub.id !== id && pub.next && pub.next.track.id === id && pub.playing) {
    s.gapProbe = {
      id,
      fade: pub.next.fade > 0,
      start: pub.next.start,
      predicted: serverTimeAt({ t: pub.t, p: pub.p }, pub.next.at),
    };
  }

  send(s, {
    id,
    track: trackInfo(track),
    playing,
    t,
    p,
    xfade: s.xfade.v,
    next: plan,
    nextKey,
    norm,
  });
}

function planNext(s) {
  const source = partySource();
  const plan = source && source.plan && source.plan();
  if (!plan || !plan.track) return null;
  const fade = plan.fade > 0 ? plan.fade : 0;
  const learnt = s.gaps[fade ? "fade" : "cut"];
  return {
    track: trackInfo(plan.track),
    at: Math.max(0, plan.at),
    start: Math.max(0, plan.start || 0),
    fade,
    gap: learnt == null ? (fade ? 0.02 : 0.15) : learnt,
  };
}

// -- publishing ------------------------------------------------------------------

function send(s, st) {
  s.pub = st; // guests will believe this from now on
  s.retry = false;
  if (s.inflight) {
    s.dirty = true;
    return;
  }
  flush(s);
}

async function flush(s) {
  const st = s.pub;
  s.inflight = true;
  s.dirty = false;
  s.lastSent = performance.now();
  const body =
    st.id === null
      ? { track: null, playing: false }
      : {
          track: st.track,
          playing: st.playing,
          t: st.t,
          p: st.p,
          xfade: st.xfade,
          next: st.next,
          norm: st.norm,
        };
  try {
    const view = await api.partyPublish(s.id, body);
    if (session === s) listeners(view);
  } catch (e) {
    if (session === s && e && e.status === 404) await recover(s);
    // It never arrived: guests still hold the previous line. The heartbeat
    // carries no state, so say it again at the next look.
    else if (session === s) s.retry = true;
  } finally {
    s.inflight = false;
    if (session === s && s.dirty) flush(s);
  }
}

async function heartbeat() {
  const s = session;
  if (!s || s.elsewhere) return;
  if (performance.now() - s.lastSent < HEARTBEAT_MS * 0.8) return;
  s.lastSent = performance.now();
  try {
    listeners(await api.partyPublish(s.id, { hb: 1 }));
    save(s.id);
  } catch (e) {
    if (e && e.status === 404) await recover(s);
  }
}

function listeners(view) {
  if (!view) return;
  partyHost.update((h) => h && { ...h, listeners: view.listeners || [], lost: false });
}

// The server forgot the party (it restarted): take the same id back, so the
// guests' link keeps working, and republish everything.
async function recover(s) {
  try {
    const view = await api.partyStart({ resume: s.id });
    if (view.id !== s.id) {
      stop();
      await begin(view);
      partyHost.update((h) => h && { ...h, lost: true });
      return;
    }
    s.pub = null;
    measure();
  } catch {
    partyHost.update((h) => h && { ...h, lost: true });
  }
}

// Closing the tab stops the music here; say so, so guests stop with it rather
// than playing on to the end of the track.
function onPageHide(e) {
  const s = session;
  if (!s || !s.pub || !s.pub.id || e.persisted) return;
  const est = s.clock && s.clock.now();
  if (!est) return;
  const p = s.pub.playing ? positionAt({ t: s.pub.t, p: s.pub.p, playing: true }, performance.now() + est.offset) : s.pub.p;
  try {
    fetch(`/api/party/${s.id}/state`, {
      method: "POST",
      keepalive: true,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ track: s.pub.track, playing: false, t: performance.now() + est.offset, p }),
    });
  } catch {
    /* best effort */
  }
}
