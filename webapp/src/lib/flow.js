// The Flow, one title at a time.
//
// The server used to answer the Flow with forty titles, and what the person
// then did reached only the next forty. Now (design and sources:
// /mnt/project-files/algos/flow-personnalise.md, supysonic/discover.py
// #flow_next) the queue holds the playing title and AT MOST the next one, and
// that next one is chosen about PICK_AHEAD seconds before the end of the
// playing title — after everything the session said: what was heard and for
// how long, "plus / moins comme ça", the energy notch. Then it is preloaded
// like any next track.
//
// Three cases keep the music going without waiting on the network:
//  - a "suivant" before the choice: a RESERVE title, asked a few seconds into
//    each track and held off the queue, plays at once (stores.js
//    #setQueueEndHook);
//  - a hidden page (locked phone): its timers are throttled to once a minute,
//    so the next title is chosen as soon as the track starts — the app's own
//    player needs it named to go on (docs/agents/android.md);
//  - the choice fails: the reserve is queued instead.
//
// One request per title (two with the reserve), a few hundred bytes each.

import { derived, get, writable } from "svelte/store";
import { api } from "./api.js";
import { player, setQueueEndHook, toasts } from "./stores.js";
import { trackKey, trackRef } from "./trackkey.js";
import { discoveryLevel } from "./discovery.js";

// Seconds before the end of the playing title the next one is chosen.
export const PICK_AHEAD = 20;
// The reserve is asked this long into a track (its own buffering first).
const RESERVE_DELAY = 6000;
const KEY = "flow.session";
const HEARD_MAX = 40;
const PRESSES_MAX = 20;

// The energy notches, as the server names them (energy.py STEPS).
export const ENERGY_STEPS = [
  { name: "Libre", value: null, hint: "Le Flow suit votre écoute" },
  { name: "Très calme", value: 0.1, hint: "Doux, posé" },
  { name: "Calme", value: 0.3, hint: "Tranquille" },
  { name: "Modéré", value: 0.5, hint: "Entre les deux" },
  { name: "Énergique", value: 0.7, hint: "Ça bouge" },
  { name: "Intense", value: 0.9, hint: "À fond" },
];
const NOTCHES = ENERGY_STEPS.slice(1).map((s) => s.value);

export function energyName(v) {
  if (v == null) return ENERGY_STEPS[0].name;
  let best = ENERGY_STEPS[1];
  for (const s of ENERGY_STEPS.slice(1)) if (Math.abs(s.value - v) < Math.abs(best.value - v)) best = s;
  return best.name;
}

// The notch the person starts from (kept by the server, a copy on the device
// paints it at once).
function readNotch() {
  try {
    const raw = localStorage.getItem("flow.energy");
    if (raw === null || raw === "null") return null;
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
export const startEnergy = writable(readNotch());

export function setStartEnergy(v) {
  startEnergy.set(v);
  try {
    localStorage.setItem("flow.energy", String(v));
  } catch {
    /* a convenience */
  }
  api.setFlowEnergy(v).catch(() => {});
}

export function adoptPrefs(prefs) {
  if (!prefs || !("energy" in prefs)) return;
  startEnergy.set(prefs.energy ?? null);
  try {
    localStorage.setItem("flow.energy", String(prefs.energy ?? null));
  } catch {
    /* a convenience */
  }
}

// -- the session --------------------------------------------------------------

function newSid() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && typeof s.sid === "string" && Array.isArray(s.heard)) return s;
  } catch {
    /* none */
  }
  return null;
}

// { sid, energy, heard: [{id, s}], more: [id], less: [id] } | null
export const flowSession = writable(load());
flowSession.subscribe((s) => {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* a convenience */
  }
});

// True while the playing queue is this device's Flow session: the steering
// row is shown (FlowControls.svelte) and the full-screen player makes room.
export const flowLive = derived(
  [player, flowSession],
  ([$p, $s]) => !!($p.context && $p.context.kind === "flow" && $s && $p.context.id === $s.sid)
);

let reserve = null; // a title held off the queue, for an instant "suivant"
let reserveTimer = null;
let picking = null; // the choice in flight (a promise)
let gen = 0; // bumped by every feedback: an answer from before is stale

function isFlow(s = get(player)) {
  return !!(s.context && s.context.kind === "flow");
}

function session() {
  const s = get(flowSession);
  const ctx = get(player).context;
  if (s && ctx && ctx.id === s.sid) return s;
  // A Flow queue saved by an older app (forty titles, no session): it goes on
  // one title at a time, in a session of its own, once that queue runs out.
  if (ctx && ctx.kind === "flow" && !ctx.id) {
    const sess = { sid: newSid(), energy: get(startEnergy), heard: [], more: [], less: [] };
    flowSession.set(sess);
    player.setContext({ kind: "flow", id: sess.sid });
    return sess;
  }
  return null;
}

function body(sess, n) {
  const s = get(player);
  return {
    sid: sess.sid,
    d: Number(get(discoveryLevel).toFixed(2)),
    energy: sess.energy,
    heard: sess.heard,
    more: sess.more,
    less: sess.less,
    exclude: s.queue.slice(-400).map((t) => trackRef(t)),
    n,
  };
}

async function ask(n) {
  const sess = session();
  if (!sess) return [];
  const r = await api.flowPick(body(sess, n));
  return (r && r.tracks) || [];
}

// Start a Flow: one request, the first title plays, the second is the reserve.
export async function startFlow(energy = get(startEnergy)) {
  const sess = { sid: newSid(), energy: energy ?? null, heard: [], more: [], less: [] };
  flowSession.set(sess);
  reserve = null;
  gen++;
  const r = await api.flowPick({ ...body(sess, 2), exclude: [] });
  const tracks = (r && r.tracks) || [];
  if (!tracks.length) {
    toasts.push("Rien à proposer pour l'instant", "info");
    return false;
  }
  player.playQueue(tracks.slice(0, 1), 0, { kind: "flow", id: sess.sid });
  reserve = tracks[1] || null;
  return true;
}

// What the player reports at each track change (Player.svelte#flushListen).
export function noteHeard(id, seconds) {
  const sess = session();
  if (!sess || !id) return;
  flowSession.set({ ...sess, heard: [...sess.heard, { id: String(id), s: Math.round(seconds) }].slice(-HEARD_MAX) });
}

// Choose the next title now and queue it (replacing a stale one).
async function pickNext({ replace = false } = {}) {
  if (picking) return picking;
  const s0 = get(player);
  const cur = s0.queue[s0.index];
  const myGen = gen;
  picking = (async () => {
    try {
      const got = await ask(1);
      if (myGen !== gen || !isFlow()) return false;
      const t = got[0];
      if (!t) throw new Error("empty");
      const s = get(player);
      if (trackKey(s.queue[s.index]) !== trackKey(cur)) return false; // moved on meanwhile
      if (replace) player.replaceUpcoming([t]);
      else if (s.index === s.queue.length - 1) player.extend([t]);
      return true;
    } catch {
      // The choice failed: the reserve keeps the music going.
      const s = get(player);
      if (reserve && s.index === s.queue.length - 1 && trackKey(s.queue[s.index]) === trackKey(cur)) {
        player.extend([reserve]);
        reserve = null;
      }
      return false;
    } finally {
      picking = null;
    }
  })();
  return picking;
}

function askReserve() {
  clearTimeout(reserveTimer);
  reserveTimer = setTimeout(async () => {
    if (!isFlow() || !session()) return;
    const myGen = gen;
    try {
      const got = await ask(1);
      if (myGen === gen) reserve = got[0] || null;
    } catch {
      /* the next choice asks again */
    }
  }, RESERVE_DELAY);
}

// Called by the player on every position update and track change:
// `remaining` is the seconds left before the transition (the crossfade
// counted), `background` true when the page cannot be trusted to wake in time.
let lastKey = null;
export function tick(s, { remaining, background }) {
  if (!isFlow(s) || s.index < 0 || !session()) return;
  const cur = s.queue[s.index];
  const key = trackKey(cur);
  if (key !== lastKey) {
    lastKey = key;
    if (!reserve || s.queue.some((t) => trackKey(t) === trackKey(reserve))) {
      reserve = null;
      askReserve();
    }
  }
  if (s.index < s.queue.length - 1 || picking) return;
  if (background || (Number.isFinite(remaining) && remaining <= PICK_AHEAD)) pickNext();
}

// "Suivant" with nothing chosen yet: the reserve, at once (stores.js calls
// this from player.next()).
setQueueEndHook((s) => {
  if (!isFlow(s)) return null;
  const t = reserve;
  reserve = null;
  if (t) {
    askReserve();
    return t;
  }
  // No reserve yet: choose now, and play it as soon as it is here.
  ask(1)
    .then((got) => {
      if (got[0] && isFlow()) player.autoExtend([got[0]]);
    })
    .catch(() => toasts.push("Le Flow ne répond pas, réessayez", "error"));
  return null;
});

// The track the controls act on, and its energy as the server measured it.
function current() {
  const s = get(player);
  return s.index >= 0 ? s.queue[s.index] : null;
}

function feedbackChanged() {
  gen++;
  reserve = null;
  picking = null;
  const s = get(player);
  // A next already chosen was chosen before this: choose again.
  if (s.index < s.queue.length - 1) pickNext({ replace: true });
  askReserve();
}

export function moreLikeThis() {
  const sess = session();
  const t = current();
  if (!sess || !t) return;
  flowSession.set({ ...sess, more: [...sess.more, String(trackRef(t))].slice(-PRESSES_MAX) });
  toasts.push("Plus de titres comme celui-ci");
  feedbackChanged();
}

// "Moins comme ça": noted, and this one makes way for a fresh choice.
export async function lessLikeThis() {
  const sess = session();
  const t = current();
  if (!sess || !t) return;
  flowSession.set({ ...sess, less: [...sess.less, String(trackRef(t))].slice(-PRESSES_MAX) });
  gen++;
  reserve = null;
  picking = null;
  const before = trackKey(t);
  let got = [];
  try {
    got = await ask(1);
  } catch {
    /* below: the plain next */
  }
  const s = get(player);
  if (trackKey(s.queue[s.index]) !== before) return;
  if (got[0]) {
    player.replaceUpcoming([got[0]]);
    player.next();
  } else if (s.index < s.queue.length - 1) player.next();
  toasts.push("Moins de titres comme celui-ci");
  askReserve();
}

// One notch up or down. From "Libre", the step is taken from the playing
// title's own energy.
export function nudgeEnergy(dir) {
  const sess = session();
  if (!sess) return;
  const t = current();
  const from = sess.energy ?? (Number.isFinite(t?.energy) ? t.energy : 0.5);
  let i = 0;
  for (let k = 0; k < NOTCHES.length; k++) if (Math.abs(NOTCHES[k] - from) < Math.abs(NOTCHES[i] - from)) i = k;
  if (sess.energy != null || NOTCHES[i] === from) i += dir;
  else if ((NOTCHES[i] - from) * dir <= 0) i += dir;
  i = Math.max(0, Math.min(NOTCHES.length - 1, i));
  const v = NOTCHES[i];
  flowSession.set({ ...sess, energy: v });
  toasts.push(`Énergie : ${energyName(v)}`);
  feedbackChanged();
}

export function setSessionEnergy(v) {
  const sess = session();
  if (!sess) return;
  flowSession.set({ ...sess, energy: v });
  feedbackChanged();
}

// The discovery slider moved while the Flow plays: the next title is chosen
// again at the new level (the playing one is never cut).
export function retune() {
  if (isFlow() && session()) feedbackChanged();
}

// The end-of-queue fallback (Player.svelte#onEnded, when the choice failed).
export async function nextNow() {
  if (reserve) {
    const t = reserve;
    reserve = null;
    return [t];
  }
  return ask(1);
}

// For tests.
export function _state() {
  return { reserve, picking, gen };
}
